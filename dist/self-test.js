"use strict";
/**
 * 本地自测：
 * 1. CacheAnchor 五条公式/门控断言（含真实 [Block] 日志验证）。
 * 2. Extraction 的 AST 结构保留与 Fail-Closed 兜底。
 * 输出同时写入 ./debug.log 与 stdout（不使用 console.log）。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const cacheAnchor_1 = require("./cacheAnchor");
const extraction_1 = require("./modules/extraction");
const memory_1 = require("./modules/memory");
const host_sim_1 = require("./host-sim");
const savings_ledger_1 = require("./modules/savings-ledger");
const log_1 = require("./log");
const outcomes = [];
function check(name, fn) {
    try {
        fn();
        outcomes.push({ name, ok: true, detail: 'ok' });
    }
    catch (error) {
        outcomes.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
}
function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}
function assertEqual(actual, expected, message) {
    if (actual !== expected)
        throw new Error(`${message} (expected=${String(expected)}, actual=${String(actual)})`);
}
function buildCodeFixture(methods) {
    const lines = [
        '// ===== top comment: AuditTarget =====',
        "import { helper } from './helper'",
        'export class AuditTarget {',
        '  private readonly cache = new Map<string, string>()',
        '',
    ];
    for (let index = 0; index < methods; index += 1) {
        lines.push(`  method_${index}(input: string, count: number): Promise<string> {`);
        lines.push(`    const bodyMarker_${index} = input.repeat(${index}) + count`);
        lines.push(`    return Promise.resolve(bodyMarker_${index})`);
        lines.push('  }');
        lines.push('');
    }
    lines.push('}');
    return lines.join('\n');
}
// ---------------------------------------------------------------------------
// 1) CacheAnchor 公式与真实门控
// ---------------------------------------------------------------------------
const anchor = (0, cacheAnchor_1.runCacheAnchorSelfTest)();
for (const line of anchor.lines) {
    process.stdout.write(`  ${line}\n`);
    (0, log_1.logEvent)(line.startsWith('FAIL') ? 'error' : 'info', 'selftest.case', { line });
}
outcomes.push({
    name: 'cacheAnchor.formula+gate',
    ok: anchor.failed === 0,
    detail: `${anchor.passed} passed, ${anchor.failed} failed`,
});
// ---------------------------------------------------------------------------
// 2) Extraction: AST 结构保留
// ---------------------------------------------------------------------------
let extractedMode = '';
check('extraction.ast-keeps-signatures', () => {
    const source = buildCodeFixture(30);
    assert(source.length > 2000, 'fixture should be large enough to trigger extraction');
    const result = (0, extraction_1.runExtraction)({ text: source, maxTokens: 10 });
    extractedMode = result.mode;
    assert(result.safe, 'extraction must stay safe for well-formed code');
    assert(result.mode === 'ast', `expected ast mode, got ${result.mode}`);
    assert(result.text.includes('class AuditTarget'), 'class name must survive');
    assert(result.text.includes('// ===== top comment: AuditTarget ====='), 'top comment must survive');
    assert(result.text.includes("import { helper } from './helper'"), 'import must survive');
    for (let index = 0; index < 30; index += 1) {
        assert(result.text.includes(`method_${index}(`), `method_${index} signature must survive`);
    }
    assert(!result.text.includes('bodyMarker_'), 'method bodies must not leak into the skeleton');
    assert(result.tokensSaved > 0, 'extraction should save tokens');
});
// ---------------------------------------------------------------------------
// 3) Extraction: Fail-Closed（不可解析代码必须原样返回）
// ---------------------------------------------------------------------------
check('extraction.fail-closed-unparseable', () => {
    const broken = `export class Broken {\n  method_0() {\n${'    const x = 1\n'.repeat(400)}`;
    const result = (0, extraction_1.runExtraction)({ text: broken, maxTokens: 10 });
    assert(!result.safe, 'unbalanced code must be flagged unsafe');
    assert(result.mode === 'none', 'unsafe extraction must not report a compression mode');
    assert(result.text === broken, 'unsafe extraction must return the original text unchanged');
    assert(typeof result.reason === 'string' && result.reason.includes('fail-closed'), 'reason must explain fail-closed');
});
// ---------------------------------------------------------------------------
// 4) Memory 折叠安全边界（2026-11-10 事故回归测试）
// ---------------------------------------------------------------------------
check('memory.fold-excludes-toolcall', () => {
    const entries = [];
    for (let index = 0; index < 6; index += 1) {
        entries.push({ seq: index * 4 + 1, role: 'assistant', text: `决定采用方案 ${index}：${'x'.repeat(400)}`, hasToolCall: true });
        entries.push({ seq: index * 4 + 2, role: 'tool', text: `Error: ENOENT ${'y'.repeat(400)}`, isError: true });
        entries.push({ seq: index * 4 + 3, role: 'assistant', text: `思考 ${index}：${'z'.repeat(400)}` });
        entries.push({ seq: index * 4 + 4, role: 'user', text: `需求 ${index}` });
    }
    const plan = (0, memory_1.planMemoryFold)(entries, { retainRecent: 2, minSaveTokens: 1 });
    if (plan.patch) {
        for (const seq of plan.foldedSeqs) {
            const entry = entries.find((item) => item.seq === seq);
            assert(entry !== undefined, 'folded seq must exist');
            assert(entry.role !== 'tool', 'tool results must never be folded');
            assert(entry.hasToolCall !== true, 'tool-call assistant messages must never be folded');
        }
    }
    // 全是 tool-call / tool 结果时，必须完全拒绝折叠。
    const onlyTools = [
        { seq: 1, role: 'assistant', text: `决定 ${'a'.repeat(600)}`, hasToolCall: true },
        { seq: 2, role: 'tool', text: `Error: ${'b'.repeat(600)}`, isError: true },
        { seq: 3, role: 'assistant', text: `决定 ${'c'.repeat(600)}`, hasToolCall: true },
        { seq: 4, role: 'tool', text: `Error: ${'d'.repeat(600)}`, isError: true },
        { seq: 5, role: 'assistant', text: `结论 ${'e'.repeat(600)}` },
    ];
    const blocked = (0, memory_1.planMemoryFold)(onlyTools, { retainRecent: 1, minSaveTokens: 1 });
    assert(blocked.patch === null, 'all-tool history must not be folded');
    assert(blocked.foldedSeqs.length === 0, 'no seqs may be folded');
});
// ---------------------------------------------------------------------------
// 5) 宿主契约回归：2026-11-10 事故片段回放
// ---------------------------------------------------------------------------
check('host-sim.incident-replay', () => {
    const fixturePath = node_path_1.default.resolve(process.cwd(), 'test/fixtures/toolcall-fold.json');
    assert(node_fs_1.default.existsSync(fixturePath), `fixture missing: ${fixturePath}`);
    const fixture = JSON.parse(node_fs_1.default.readFileSync(fixturePath, 'utf8'));
    const healthy = new host_sim_1.HostSimulator(fixture.events).build();
    assertEqual(healthy.validate().length, 0, 'healthy fixture must satisfy host contract');
    const folded = (0, host_sim_1.simulateRangeFold)(healthy.messages(), fixture.range.start, fixture.range.end);
    assertEqual((0, host_sim_1.validateMessages)(folded).length, 0, 'message-level pairing stays valid after range fold (why old tests passed)');
    const foldedSim = new host_sim_1.HostSimulator([
        ...fixture.events,
        { seq: 9999, type: 'user/message', role: 'user', text: '[MEMORY] folded', replace: { ...fixture.range } },
    ]).build();
    const violations = foldedSim.validate();
    assert(violations.some((line) => line.includes('has no surface assistant')), `simulator must detect orphan tool/call, got: ${violations.join('; ') || '(none)'}`);
    const entries = healthy.messages().map((message) => ({
        seq: message.seq,
        role: message.role,
        text: message.text.length > 0 ? message.text : `tool result ${message.toolCallId ?? ''}`.repeat(4),
        hasToolCall: message.toolCalls.length > 0,
    }));
    const plan = (0, memory_1.planMemoryFold)(entries, { retainRecent: 1, minSaveTokens: 1 });
    assert(plan.patch === null, 'incident fixture must not produce a fold patch');
});
// ---------------------------------------------------------------------------
// 6) 折叠记账口径（2026-11-10 面板数字虚高事故）
// ---------------------------------------------------------------------------
check('memory.savings-accounting', () => {
    const entries = [];
    for (let index = 0; index < 20; index += 1) {
        entries.push({ seq: index * 3 + 1, role: 'user', text: '需求'.repeat(2000) });
    }
    entries.push({ seq: 1000, role: 'assistant', text: `决定采用方案：${'x'.repeat(4000)}` });
    entries.push({ seq: 2000, role: 'assistant', text: `结论：${'y'.repeat(200)}` });
    const plan = (0, memory_1.planMemoryFold)(entries, { retainRecent: 1, minSaveTokens: 1 });
    assert(plan.patch !== null, 'expected a fold patch for the text candidate');
    assert(plan.tokensBefore <= 1200, `fold tokensBefore must count candidates only, got ${plan.tokensBefore}`);
    assert(plan.tokensSaved <= 1200, `fold tokensSaved must count candidates only, got ${plan.tokensSaved}`);
    assert((plan.contextTokens ?? 0) > 10000, `contextTokens should reflect the full context, got ${plan.contextTokens}`);
});
// ---------------------------------------------------------------------------
// 7) 节省面板契约：ledgerId / revision / 缓存感知成本
// ---------------------------------------------------------------------------
check('savings.ledger-cost-model', () => {
    const ledger = new savings_ledger_1.SavingsLedger();
    ledger.record('schema', 2704, 'schema');
    ledger.record('extraction', 100, 'output');
    const snapshot = ledger.snapshot();
    assert(snapshot.schemaVersion === 3, `schemaVersion=${snapshot.schemaVersion}`);
    assert(snapshot.ledgerId.length > 0, 'ledgerId required');
    assert(snapshot.revision === 2, `revision=${snapshot.revision}`);
    assert(snapshot.totalSavedTokens === 2804, `prompt tokens removed=${snapshot.totalSavedTokens}`);
    assert(snapshot.estimatedCostTokens === 190, `cost-aware estimate=${snapshot.estimatedCostTokens} (90 + 100)`);
    assert(snapshot.contextReduction === 0, 'fold must stay separate from cost estimate');
});
// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
const failed = outcomes.filter((item) => !item.ok);
for (const item of outcomes) {
    process.stdout.write(`${item.ok ? 'PASS' : 'FAIL'} ${item.name} :: ${item.detail}\n`);
    (0, log_1.logEvent)(item.ok ? 'info' : 'error', 'selftest.outcome', { name: item.name, ok: item.ok, detail: item.detail });
}
(0, log_1.logEvent)(failed.length === 0 ? 'info' : 'error', 'selftest.summary', {
    passed: outcomes.length - failed.length,
    failed: failed.length,
    extractionMode: extractedMode,
});
process.stdout.write(`\nself-test summary: ${outcomes.length - failed.length} passed, ${failed.length} failed\n`);
if (failed.length > 0)
    process.exitCode = 1;
