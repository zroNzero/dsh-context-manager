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
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const cacheAnchor_1 = require("./cacheAnchor");
const extraction_1 = require("./modules/extraction");
const tool_attention_1 = require("./modules/tool-attention");
const response_cache_1 = require("./modules/response-cache");
const scope_1 = require("./modules/scope");
const osiris_1 = require("./modules/osiris");
const tool_pipe_1 = require("./modules/tool-pipe");
const contracts_1 = require("./contracts");
const history_rewriter_1 = require("./modules/history-rewriter");
const prefix_spill_1 = require("./modules/prefix-spill");
const episode_evict_1 = require("./modules/episode-evict");
const reasoning_drop_1 = require("./modules/reasoning-drop");
const memory_1 = require("./modules/memory");
const host_sim_1 = require("./host-sim");
const savings_ledger_1 = require("./modules/savings-ledger");
const billing_1 = require("./modules/billing");
const effort_policy_1 = require("./modules/effort-policy");
const workspace_1 = require("./modules/workspace");
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
check('extraction.firewall-summary', () => {
    const lines = Array.from({ length: 300 }, (_, index) => `line ${index}: ${'x'.repeat(40)}`);
    lines.push('Error: ENOENT at src\\firewall.ts');
    const text = lines.join('\n');
    const before = (0, contracts_1.estimateTokens)(text);
    const summary = (0, extraction_1.buildFirewallSummary)(text, 250);
    assert(summary.tokensBefore === before, 'firewall tokensBefore mismatch');
    assert(summary.tokens < before, `firewall must shrink tokens (${before} -> ${summary.tokens})`);
    assert(summary.tokens <= 270, `firewall summary too big: ${summary.tokens}`);
    assert(summary.text.includes('[FIREWALL]'), 'firewall marker missing');
    assert(summary.text.includes('Error: ENOENT'), 'error line must be preserved');
});
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
check('history-rewriter.preserves-pairing', () => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: '需求' }] }];
    for (let index = 0; index < 12; index += 1) {
        messages.push({ role: 'assistant', content: [{ type: 'text', text: `<thought>plan ${index}</thought> 决定 ${'a'.repeat(800)}` }] });
        messages.push({
            role: 'tool',
            toolCallId: `call_${index}`,
            content: [{ type: 'text', text: Array.from({ length: 40 }, (_, line) => `line ${line} ${'b'.repeat(60)}`).join('\n') }],
        });
    }
    messages.push({ role: 'user', content: [{ type: 'text', text: '继续' }] });
    const result = (0, history_rewriter_1.rewriteMessages)(messages, { retainRecent: 4 });
    assert(result.saved > 0, `rewrite saved=${result.saved}`);
    assert(result.messages.length === messages.length, 'messages must not be removed');
    assert(result.messages[2].toolCallId === 'call_0', 'tool pairing id must be preserved');
    assert(!JSON.stringify(result.messages[1]).includes('<thought>'), 'CoT must be stripped');
    assert(result.messages[result.messages.length - 1].content[0].text === '继续', 'recent messages must stay raw');
});
check('tool-attention.topk', () => {
    const tools = Array.from({ length: 80 }, (_, index) => ({
        name: `tool_${index}`,
        description: index % 5 === 0 ? `run tests and fix auth module ${index}` : `generic utility ${index}`,
    }));
    const selection = (0, tool_attention_1.selectTools)(tools, 'run the failing test and fix auth', 5);
    assert(selection.selected.length <= 6, `selected=${selection.selected.length}`);
    assert(selection.hidden.length > 0, 'expected hidden tools');
    assert(selection.catalog.length === selection.hidden.length, 'catalog must cover hidden tools');
    assert(selection.selected.some((tool) => tool.name === 'search_tools'), 'search_tools must be present');
});
check('toon.encoded-json-array', () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({
        id: index,
        name: `item-${index}`,
        status: 'ok',
        value: index * 3,
        detail: `row ${index}`,
    }));
    const toon = (0, extraction_1.toonEncode)(JSON.stringify(rows, null, 2));
    assert(toon !== null, 'toon encode failed');
    assert(toon.tokensAfter < toon.tokensBefore * 0.5, `toon rate insufficient: ${toon.tokensBefore}->${toon.tokensAfter}`);
});
check('cache.semantic-hit', () => {
    const cache = new response_cache_1.ResponseCache({ similarityThreshold: 0.85 });
    const text = 'please fix the failing authentication test in the login module today because the build is broken and users cannot sign in';
    cache.set('k', [{ type: 'text', text: 'answer' }], text);
    const probe = text.replace(' test ', ' tests ');
    const hit = cache.findSimilar(probe);
    assert(hit !== undefined && hit.score >= 0.85, `semantic hit score=${hit?.score}`);
});
check('scope.budget-partition', () => {
    const budget = (0, scope_1.planBudget)(20000, 2200);
    assert(budget.toolsBudget <= 2200, `tools budget must respect schema: ${budget.toolsBudget}`);
    assert(budget.memoryBudget > 0 && budget.liveBudget > 0, 'budget partitions missing');
    assert(budget.retainRecent >= 2 && budget.retainRecent <= 12, `retainRecent=${budget.retainRecent}`);
    assert(budget.toolChars >= 200, `toolChars=${budget.toolChars}`);
});
check('osiris.stable-seal', () => {
    const messages = [{ role: 'user', content: 'fix the auth test' }];
    const tools = [{ name: 'read' }, { name: 'bash' }];
    const first = (0, osiris_1.sealState)({ messages, tools, bucket: (0, osiris_1.intentBucket)('fix the auth test'), keepRecent: 4 });
    const second = (0, osiris_1.sealState)({ messages, tools, bucket: (0, osiris_1.intentBucket)('fix the auth test'), keepRecent: 4 });
    assert(first.toolsHash === second.toolsHash && first.historyHash === second.historyHash, 'seal must be deterministic');
    const drifted = (0, osiris_1.sealState)({ messages, tools: [...tools, { name: 'write' }], bucket: first.bucket, keepRecent: 4 });
    assert(drifted.toolsHash !== first.toolsHash, 'tool drift must change toolsHash');
});
check('scout.bm25-selection', () => {
    const tools = Array.from({ length: 60 }, (_, index) => ({
        name: index % 3 === 0 ? `read_file_${index}` : `util_${index}`,
        description: index % 3 === 0 ? 'read a file from disk' : `utility number ${index}`,
    }));
    const selection = (0, tool_attention_1.selectToolsScout)(tools, 'read the config file', 5);
    assert(selection.selected.length <= 6, `selected=${selection.selected.length}`);
    assert(selection.selected.some((tool) => tool.name === 'search_tools'), 'search_tools missing');
    assert(selection.selected.some((tool) => tool.name.startsWith('read_file_')), 'BM25 failed to surface read tool');
});
check('toolpipe.publish-resolve', () => {
    const dir = node_path_1.default.join('.self-test-pipe');
    node_fs_1.default.mkdirSync(dir, { recursive: true });
    const file = node_path_1.default.join(dir, 'payload.txt');
    node_fs_1.default.writeFileSync(file, 'hello pipe', 'utf8');
    const pipe = new tool_pipe_1.ToolPipe(dir);
    const published = pipe.publishFile(file);
    assert(published.ref.startsWith('pipe-'), `ref=${published.ref}`);
    const resolved = pipe.resolve(published.ref);
    assert(resolved.ok && resolved.text === 'hello pipe', 'pipe resolve mismatch');
    node_fs_1.default.rmSync(dir, { recursive: true, force: true });
});
check('savings.restore-across-restart', () => {
    const a = (0, workspace_1.workspaceRef)('D:\\PC\\a');
    const b = (0, workspace_1.workspaceRef)('D:\\PC\\b');
    const first = new savings_ledger_1.SavingsLedger();
    first.record('schema', 900, 'schema', a, 3000);
    first.record('fold', 100, 'fold', b, 400);
    first.recordRequestTokens(a, 5000, 4100);
    const snap = first.snapshot();
    const second = new savings_ledger_1.SavingsLedger();
    assert(second.restore(snap) === true, 'restore must accept current snapshot');
    second.record('schema', 300, 'schema', a, 1000);
    second.recordRequestTokens(a, 3000, 2500);
    const after = second.snapshot();
    assert(Object.keys(after.byWorkspace).length === 2, 'workspaces must survive restart');
    // 真实口径延续：A 原本 (5000−4100)=900，新增 (3000−2500)=500 → 1400
    assert(after.byWorkspace[a.id].totalSavedTokens === 1400, `A real=${after.byWorkspace[a.id].totalSavedTokens}`);
    assert(after.byWorkspace[a.id].causalReductions === 1200, 'A causal after restore');
    assert(after.startedAt === snap.startedAt, 'startedAt must be preserved');
    // 旧口径（accountingVersion < 3）必须拒绝，避免把虚高值带进新账本
    const legacy = { ...snap, accountingVersion: 2 };
    assert(new savings_ledger_1.SavingsLedger().restore(legacy) === false, 'legacy accounting must not be restored');
});
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
    const workspaceA = (0, workspace_1.workspaceRef)('D:\\PC\\dsh\\dsh-context-manager');
    const workspaceB = (0, workspace_1.workspaceRef)('D:\\PC\\other');
    assert(workspaceA.id === (0, workspace_1.workspaceRef)('d:/PC/dsh/dsh-context-manager/').id, 'workspace id must be stable across separators/case');
    const ledger = new savings_ledger_1.SavingsLedger();
    ledger.record('schema', 2704, 'schema', workspaceA, 10800);
    ledger.record('extraction', 100, 'output', workspaceB);
    ledger.recordRequestTokens(workspaceA, 10000, 8000);
    ledger.recordRequestTokens(workspaceB, 5000, 2500);
    const snapshot = ledger.snapshot();
    assert(snapshot.schemaVersion === 5, `schemaVersion=${snapshot.schemaVersion}`);
    assert(snapshot.accountingVersion === 4, `accountingVersion=${snapshot.accountingVersion}`);
    assert(snapshot.ledgerId.length > 0, 'ledgerId required');
    assert(Object.keys(snapshot.byWorkspace).length === 2, 'expected two workspaces');
    // 真实口径：Σ(before − after) = (10000−8000) + (5000−2500)
    assert(snapshot.totalSavedTokens === 4500, `real saved=${snapshot.totalSavedTokens}`);
    // 归因总量独立存放，不与真实量相加
    assert(snapshot.causalReductions === 2804, `causal=${snapshot.causalReductions}`);
    assert(snapshot.byModuleBefore.schema === 10800, `schema before=${snapshot.byModuleBefore.schema}`);
    assert(snapshot.byModuleBefore.extraction === 100, `extraction before=${snapshot.byModuleBefore.extraction}`);
    assert(snapshot.tokensBeforeTotal === 15000 && snapshot.tokensAfterTotal === 10500, 'before/after totals');
    const perWorkspace = snapshot.byWorkspace[workspaceA.id];
    assert(perWorkspace.totalSavedTokens === 2000, `workspace A real saved=${perWorkspace.totalSavedTokens}`);
    assert(perWorkspace.causalReductions === 2704, `workspace A causal=${perWorkspace.causalReductions}`);
    assert(perWorkspace.byModuleBefore.schema === 10800, 'workspace A schema before');
    assert(perWorkspace.tokensBeforeTotal === 10000, 'workspace A before total');
});
// ---------------------------------------------------------------------------
// 8) 工作区解析不能因 cordis 代理访问而抛错（2026-11-10 hook 全挂事故）
// ---------------------------------------------------------------------------
check('workspace.safe-proxy', () => {
    const throwing = new Proxy({}, {
        get() {
            throw new Error('cannot get property "options" without inject');
        },
    });
    const ref = (0, workspace_1.workspaceRefFromSession)(throwing, throwing);
    assert(ref === null, 'proxy access must be caught and return null, not throw');
    const ref2 = (0, workspace_1.workspaceRefFromSession)({ header: { cwd: 'D:\\PC\\dsh\\dsh-context-manager' } });
    assert(ref2 !== null && ref2.path.toLowerCase().includes('dsh-context-manager'), 'header.cwd must resolve');
});
// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 9) 真实账本：只认 provider usage，费率与字符比校准都要能对上
// ---------------------------------------------------------------------------
check('billing.real-usage-only', () => {
    const ledger = new billing_1.BillingLedger();
    // 红线：没有 provider usage 就绝不入账（禁止用估算补齐）
    assert(ledger.record({ model: 'deepseek-flash', usage: undefined, beforeChars: 10, afterChars: 5 }) === null, 'missing usage must not be booked');
    assert(ledger.snapshot().requests === 0, 'no phantom requests without usage');
    // 空闲时段（北京 20:00）：flash hit 0.02 / miss 1 / output 4
    const offpeak = ledger.record({
        at: Date.UTC(2026, 10, 11, 12, 0, 0),
        purpose: 'agent-loop',
        model: 'deepseek-flash',
        usage: { inputTokens: 1000, cacheReadTokens: 9000, outputTokens: 500 },
        beforeChars: 50_000,
        afterChars: 40_000,
    });
    const expectedOffpeak = (1000 * 1 + 9000 * 0.02 + 500 * 4) / 1e6;
    assert(Math.abs(offpeak.actualCost - expectedOffpeak) < 1e-9, `offpeak cost ${offpeak.actualCost} != ${expectedOffpeak}`);
    assert(offpeak.window === 'offpeak' && offpeak.peak === false, `window=${offpeak.window}`);
    // 实测字符比：10000 prompt token / 40000 字符 = 0.25 token/char → 移除 10000 字符 = 2500 token
    assert(offpeak.removedPromptTokens === 2500, `removedPromptTokens=${offpeak.removedPromptTokens}`);
    // 命中比例取本请求实测值 = 9000/10000
    assert(offpeak.savedHitTokens === 2250, `savedHit=${offpeak.savedHitTokens}`);
    assert(offpeak.savedMissTokens === 250, `savedMiss=${offpeak.savedMissTokens}`);
    assert(offpeak.counterfactualCost > offpeak.actualCost, 'counterfactual must exceed actual');
    assert(Math.abs(offpeak.savedCost - (offpeak.counterfactualCost - offpeak.actualCost)) < 1e-12, 'savedCost identity');
    // 高峰时段（北京 10:00）：flash hit 0.04 / miss 2 / output 8
    const peak = ledger.record({
        at: Date.UTC(2026, 10, 11, 2, 0, 0),
        purpose: 'agent-loop',
        model: 'deepseek-flash',
        usage: { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 100 },
        beforeChars: 2000,
        afterChars: 1000,
    });
    assert(peak.window === 'peak', `peak window expected, got ${peak.window}`);
    const expectedPeak = (1000 * 2 + 100 * 8) / 1e6;
    assert(Math.abs(peak.actualCost - expectedPeak) < 1e-9, `peak cost ${peak.actualCost} != ${expectedPeak}`);
    // 无缓存命中：全部按 miss 价补偿
    assert(peak.savedHitTokens === 0 && peak.savedMissTokens === peak.removedPromptTokens, 'miss-only split');
    const snapshot = ledger.snapshot();
    assert(snapshot.requests === 2, `booked=${snapshot.requests}`);
    assert(snapshot.reduction > 0 && snapshot.reduction < 1, `reduction=${snapshot.reduction}`);
    assert(snapshot.cacheHitRate > 0 && snapshot.cacheHitRate < 1, `hitRate=${snapshot.cacheHitRate}`);
    // 未验证的输出截断收益不得混进降幅；而且「没有削减的付费请求」必须稀释降幅
    // （排除它们会把分母做小、系统性放大降幅）。
    const before = snapshot.reduction;
    ledger.record({
        at: Date.UTC(2026, 10, 11, 12, 0, 0),
        model: 'deepseek-flash',
        usage: { inputTokens: 100, outputTokens: 100 },
        beforeChars: 1000,
        afterChars: 1000,
        unverifiedOutputTokens: 5000,
    });
    const after = ledger.snapshot();
    assert(after.unverifiedOutputTokens === 5000, 'unverified output must be tracked separately');
    assert(after.reduction <= before, 'a paid request with no reduction must dilute the reduction, never raise it');
    assert(after.requests === 3 && after.requestsWithoutReduction === 1, 'zero-reduction request must be billed');
});
// ---------------------------------------------------------------------------
// 10) 语义复用必须默认关闭（不降智）：同一句话的第二轮不能重放上一轮回答
// ---------------------------------------------------------------------------
check('cache.semantic-replay-off-by-default', () => {
    const guard = new response_cache_1.ResponseCache({ ttlMs: 60_000, semanticReuse: false });
    const chunks = [{ type: 'text-delta', index: 0, text: '上一轮的回答' }];
    guard.set('k1', chunks, 'deepseek-flash 继续  [tools]');
    assert(guard.findSimilar('deepseek-flash 继续  [tools]') === undefined, 'disabled semantic cache must never match');
    assert(guard.stats().semanticHits === 0, 'no semantic hit may be recorded while disabled');
    // 打开时确实会命中，证明上面的「不命中」不是缓存本身坏了
    const open = new response_cache_1.ResponseCache({ ttlMs: 60_000, similarityThreshold: 0.85 });
    open.set('k1', chunks, 'deepseek-flash 继续  [tools]');
    assert(open.findSimilar('deepseek-flash 继续  [tools]') !== undefined, 'enabled semantic cache should match');
});
// ---------------------------------------------------------------------------
// 11) cacheReadTokens 是「单请求」命中量：不得做差分
// ---------------------------------------------------------------------------
check('billing.cache-read-is-per-request', () => {
    /**
     * 实测序列（会话 794b93ff）：命中量随上下文增长而单调上升，但一次缓存口径重置让
     * 它从 122,624 掉到 89,216 —— **累计值不可能下降**，所以它是单请求值。
     * 早期误按累计值做差分（并且把「重置」当成整段差值），命中被低记 16 倍：
     * 账本 342,912 vs 宿主真值 5,408,384，命中率显示 72% 而真值 98.3%。
     */
    const ledger = new billing_1.BillingLedger();
    const book = ledger.record({
        model: 'deepseek-flash',
        usage: { inputTokens: 100, cacheReadTokens: 5400, outputTokens: 50 },
        beforeChars: 2000,
        afterChars: 1000,
    });
    assert(book.hitTokens === 5400, `hit must be the raw per-request value, got ${book.hitTokens}`);
    assert(book.missTokens === 100, `miss must stay 100, got ${book.missTokens}`);
});
// ---------------------------------------------------------------------------
// 12) 动态 reasoning effort：只在不需要深思的步骤下调，绝不往上加
// ---------------------------------------------------------------------------
check('effort.dynamic-policy', () => {
    const policy = { enabled: true, trivial: 'off', easy: 'low', normal: 'high', hard: 'max', escalateOnError: true };
    assert((0, effort_policy_1.classifyTurn)('把这段 JSON 格式化一下').tier === 'trivial', 'mechanical task must be trivial');
    assert((0, effort_policy_1.classifyTurn)('重构一下鉴权模块').tier === 'hard', 'refactor must be hard');
    assert((0, effort_policy_1.classifyTurn)('TypeError: Cannot read properties of undefined\n    at foo (a.ts:1:2)').tier === 'hard', 'error must be hard');
    assert((0, effort_policy_1.classifyTurn)('继续').tier === 'easy', 'short follow-up must be easy');
    assert((0, effort_policy_1.classifyTurn)('Please read the file src/index.ts and report the exact list of exported symbols in the order they appear, with signatures.')
        .tier === 'normal', 'plain medium request must be normal');
    const easy = [{ role: 'user', content: [{ type: 'text', text: '继续' }] }];
    const lowered = (0, effort_policy_1.decideEffort)({ messages: easy, requested: 'max', baseline: 'max', policy });
    assert(lowered.requested === 'max' && lowered.effort === 'low', `easy step from max must drop to low, got ${lowered.effort}`);
    // 只下调、不上调：用户设置是上限
    const raised = (0, effort_policy_1.decideEffort)({ messages: [{ role: 'user', content: [{ type: 'text', text: '重构整个模块' }] }], requested: 'max', baseline: 'low', policy });
    assert(raised.effort === 'low', `must never exceed the user baseline, got ${raised.effort}`);
    // 棘轮回归：宿主会把我们上一轮写进 config 的 low 当作 requested 回传，
    // 复杂任务的规划步仍然必须回到 max（否则整段会话被永久锁死在 low）。
    const ratchet = (0, effort_policy_1.decideEffort)({ messages: [{ role: 'user', content: [{ type: 'text', text: '重构鉴权模块' }] }], requested: 'low', baseline: 'max', policy });
    assert(ratchet.effort === 'max', `echoed low must not ratchet the policy down, got ${ratchet.effort}`);
    // 轮内工具报错 -> 升级到 hard 档
    const errored = (0, effort_policy_1.decideEffort)({
        messages: [
            { role: 'user', content: [{ type: 'text', text: '继续' }] },
            { role: 'tool', content: [{ type: 'text', text: 'Error: boom\n    at x (a.ts:3:4)' }] },
        ],
        requested: 'max',
        baseline: 'max',
        policy,
    });
    assert(errored.escalated === true && errored.effort === 'max', `tool error must escalate, got ${errored.effort}`);
    // 关闭时完全透传
    const off = (0, effort_policy_1.decideEffort)({ messages: easy, requested: 'max', baseline: 'max', policy: { ...policy, enabled: false } });
    assert(off.effort === 'max' && off.reason === 'policy-disabled', 'disabled policy must not touch the request');
    // 规划步 vs 执行步
    const hardPrompt = [{ role: 'user', content: [{ type: 'text', text: '重构鉴权模块' }] }];
    const planning = (0, effort_policy_1.decideEffort)({ messages: hardPrompt, requested: 'max', baseline: 'max', policy });
    assert(planning.effort === 'max' && planning.reason.endsWith(':plan'), `planning step must keep max, got ${planning.effort}`);
    const executing = (0, effort_policy_1.decideEffort)({
        messages: [
            ...hardPrompt,
            { role: 'assistant', content: [{ type: 'text', text: '开始' }] },
            { role: 'tool', content: [{ type: 'text', text: 'ok' }] },
        ],
        requested: 'max',
        baseline: 'max',
        policy,
    });
    assert(executing.effort === 'high' && executing.reason.endsWith(':execute'), `execution step must drop a notch, got ${executing.effort}`);
    // 执行步兜底：normal/hard 轮次不会掉到 high 以下（校准实测 high→low 省不到钱）
    const floored = (0, effort_policy_1.decideEffort)({
        messages: [
            ...hardPrompt,
            { role: 'tool', content: [{ type: 'text', text: 'ok' }] },
        ],
        requested: 'max',
        baseline: 'max',
        policy: { ...policy, hard: 'low' },
    });
    assert(floored.effort === 'high', `hard execution must not sink below high, got ${floored.effort}`);
    // 机械轮次的执行步可以到 off —— 那里才是真省
    const mechanical = (0, effort_policy_1.decideEffort)({
        messages: [
            { role: 'user', content: [{ type: 'text', text: '把这段 JSON 格式化一下' }] },
            { role: 'tool', content: [{ type: 'text', text: 'ok' }] },
        ],
        requested: 'max',
        baseline: 'max',
        policy,
    });
    assert(mechanical.effort === 'off', `trivial execution should run at off, got ${mechanical.effort}`);
});
// ---------------------------------------------------------------------------
// 13) thinking 模式的硬约束：带 reasoning 的 assistant 消息不能折叠 / 不能重写
//     （实测 2026-11-11 20:32：折叠后整轮 INVALID_REQUEST）
// ---------------------------------------------------------------------------
check('memory.fold-excludes-thinking', () => {
    const entry = (seq, role, text, extra = {}) => ({ seq, role, text, ...extra });
    const entries = [entry(1, 'user', '需求'), entry(2, 'system', 'constraints')];
    // 8 条「带 thinking」的 assistant 消息，足够长、够旧，唯一阻止折叠的理由就是 thinking
    for (let index = 0; index < 8; index += 1) {
        entries.push(entry(10 + index, 'assistant', `思考过程 ${index} ${'x'.repeat(2000)}`, { hasThinking: true }));
    }
    entries.push(entry(99, 'assistant', '最近一条'));
    const plan = (0, memory_1.planMemoryFold)(entries, { retainRecent: 1, minSaveTokens: 1 });
    assert(plan.patch === null, 'thinking messages must never be folded');
    assert(plan.foldedSeqs.length === 0, 'no thinking message may appear in foldedSeqs');
    // 同样的消息，去掉 hasThinking 就会折叠 —— 证明上面的「不折叠」不是别的原因
    const plain = entries.map((item) => ({ ...item, hasThinking: false }));
    const foldable = (0, memory_1.planMemoryFold)(plain, { retainRecent: 1, minSaveTokens: 1 });
    assert(foldable.patch !== null, 'the same history without thinking should fold (control group)');
});
check('rewrite.leaves-thinking-messages-untouched', () => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: '需求' }] }];
    for (let index = 0; index < 6; index += 1) {
        messages.push({
            role: 'assistant',
            content: [
                { type: 'reasoning', text: `推理 ${index} ${'r'.repeat(300)}` },
                { type: 'text', text: `结论 ${index} ${'a'.repeat(600)}` },
            ],
        });
        messages.push({ role: 'user', content: [{ type: 'text', text: `继续 ${index}` }] });
    }
    const result = (0, history_rewriter_1.rewriteMessages)(messages, { retainRecent: 2, assistantChars: 100, toolChars: 300 });
    for (let index = 1; index < messages.length; index += 2) {
        const before = JSON.stringify(messages[index]);
        const after = JSON.stringify(result.messages[index]);
        assert(before === after, `thinking message ${index} must be passed through verbatim`);
    }
});
// ---------------------------------------------------------------------------
// 14) effort 杠杆要进真实账本：按校准比例把「只用了 high」折算成反事实输出成本
// ---------------------------------------------------------------------------
check('billing.effort-counterfactual', () => {
    const ledger = new billing_1.BillingLedger();
    const rec = ledger.record({
        at: Date.UTC(2026, 10, 11, 12, 0, 0),
        model: 'deepseek-flash',
        usage: { inputTokens: 100, cacheReadTokens: 0, outputTokens: 344 },
        beforeChars: 1000,
        afterChars: 1000,
        effort: 'high',
        baselineEffort: 'max',
    });
    // 校准：high 的相对输出量 0.566 -> 反事实输出 344 / 0.566 ≈ 608
    assert(rec.avoidedOutputTokens === 264, `avoided=${rec.avoidedOutputTokens}`);
    const extra = (rec.counterfactualCost - rec.actualCost) * 1e6;
    assert(Math.abs(extra - 264 * 4) < 1e-6, `counterfactual must add the avoided output at the output price, extra=${extra}`);
    // 同档位不产生 effort 收益
    const same = ledger.record({
        at: Date.UTC(2026, 10, 11, 12, 0, 0),
        model: 'deepseek-flash',
        usage: { inputTokens: 100, outputTokens: 344 },
        beforeChars: 1000,
        afterChars: 1000,
        effort: 'max',
        baselineEffort: 'max',
    });
    assert(same.avoidedOutputTokens === 0, 'same effort must not claim a saving');
    // 没有 effort 信息时也不能凭空折算
    const unknown = ledger.record({
        at: Date.UTC(2026, 10, 11, 12, 0, 0),
        model: 'deepseek-flash',
        usage: { inputTokens: 100, outputTokens: 344 },
        beforeChars: 1000,
        afterChars: 1000,
    });
    assert(unknown.avoidedOutputTokens === 0, 'missing effort must not invent a counterfactual');
});
// ---------------------------------------------------------------------------
// 27) 整对逐出：调用与结果必须同时消失（既不留孤儿，也不留模仿模板），且可无损读回
// ---------------------------------------------------------------------------
check('prefix.episode-evict-keeps-pairs-and-loses-nothing', () => {
    const dir = node_fs_1.default.mkdtempSync(node_path_1.default.join(node_os_1.default.tmpdir(), 'ck-evict-'));
    const bigArgs = JSON.stringify({ file_path: 'src/a.ts', content: 'x'.repeat(3000) });
    const messages = [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        {
            role: 'assistant',
            content: [
                { type: 'reasoning', text: 'r' },
                { type: 'tool-call', id: 'call_big', name: 'write', arguments: bigArgs },
            ],
        },
        { role: 'tool', toolCallId: 'call_big', content: [{ type: 'text', text: 'written' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        { role: 'user', content: [{ type: 'text', text: 'r1' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'r2' }] },
    ];
    const first = (0, episode_evict_1.evictOldEpisodes)(messages, { spillDir: dir, retainRecent: 2, minArgChars: 600 });
    const second = (0, episode_evict_1.evictOldEpisodes)(messages, { spillDir: dir, retainRecent: 2, minArgChars: 600 });
    assert(first.stats.episodes === 1, `one episode evicts, got ${first.stats.episodes}`);
    // 配对完整性：tool 结果必须跟着一起消失，否则会留孤儿 tool 消息
    assert(!first.messages.some((message) => message.role === 'tool' && message.toolCallId === 'call_big'), 'orphan tool result left behind');
    // 模仿安全：历史里不能残留这个 tool-call 的任何形状
    assert(!JSON.stringify(first.messages).includes('call_big'), 'tool-call must be gone entirely: leftover shape is what the model copies');
    // 指针是纯文本，且字节确定
    assert(JSON.stringify(first.messages[1]) === JSON.stringify(second.messages[1]), 'eviction pointer must be deterministic or the prefix cache dies');
    const pointer = first.messages[1].content
        .map((block) => String(block?.text ?? ''))
        .find((text) => text.includes('[evicted tool episode'));
    assert(pointer, `pointer block missing, got ${JSON.stringify(first.messages[1].content)}`);
    const file = pointer.match(/episode-[0-9a-f]{12}\.json/);
    assert(file, `pointer must name the spill file, got ${pointer}`);
    // 无损：原文可完整读回
    const stored = JSON.parse(node_fs_1.default.readFileSync(node_path_1.default.join(dir, file[0]), 'utf8'));
    assert(stored.call[0].arguments === bigArgs, 'spilled arguments must be byte-exact');
    assert(stored.result[0][0].text === 'written', 'spilled result must be byte-exact');
});
check('prefix.stale-reasoning-strip', () => {
    const messages = [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        {
            role: 'assistant',
            content: [
                { type: 'reasoning', text: 'r'.repeat(500) },
                { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
            ],
        },
        { role: 'tool', content: [{ type: 'text', text: 'result' }] },
        { role: 'assistant', content: [{ type: 'reasoning', text: 'tail' }, { type: 'text', text: 'done' }] },
        { role: 'user', content: [{ type: 'text', text: 'next' }] },
    ];
    const first = (0, reasoning_drop_1.stripStaleReasoning)(messages, 2);
    const second = (0, reasoning_drop_1.stripStaleReasoning)(messages, 2);
    assert(first.stripped === 1, `only stale messages strip, got ${first.stripped}`);
    assert(first.messages.length === messages.length, 'message count must not change');
    assert(first.messages[1].content.some((block) => block.type === 'tool-call'), 'tool-call must survive: dropping it breaks tool pairing');
    assert(!first.messages[1].content.some((block) => block.type === 'reasoning'), 'stale reasoning must be gone');
    assert(first.messages[3].content.some((block) => block.type === 'reasoning'), 'recent reasoning must stay');
    assert(first.charsSaved === 500, `charsSaved must count the dropped reasoning, got ${first.charsSaved}`);
    assert(JSON.stringify(first.messages) === JSON.stringify(second.messages), 'strip must be deterministic or the prefix cache dies');
});
check('prefix.spill-lossless-and-deterministic', () => {
    const dir = node_fs_1.default.mkdtempSync(node_path_1.default.join(node_os_1.default.tmpdir(), 'ck-prefix-'));
    const big = 'ERROR at line 42\n'.repeat(200);
    const messages = [
        { role: 'user', content: [{ type: 'text', text: 'start' }] },
        { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{}' }] },
        { role: 'tool', content: [{ type: 'text', text: big }] },
        { role: 'user', content: [{ type: 'text', text: 'recent-1' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'recent-2' }] },
    ];
    const options = { spillDir: dir, retainRecent: 2, minChars: 500 };
    const first = (0, prefix_spill_1.foldOldToolResults)(messages, options);
    const second = (0, prefix_spill_1.foldOldToolResults)(messages, options);
    assert(first.stats.folded === 1, `only the old tool result folds, got ${first.stats.folded}`);
    assert(first.messages.length === messages.length, 'message count must not change (tool pairing)');
    assert(first.messages[1].content[0].type === 'tool-call', 'assistant tool-call must stay intact');
    assert(first.messages[2].content[0].text.includes('[SPILL]'), 'receipt missing');
    assert(first.messages[3].content[0].text === 'recent-1', 'recent messages must stay verbatim');
    assert(first.messages[2].content[0].text === second.messages[2].content[0].text, 'receipt must be byte-identical across calls, or the prefix cache dies');
    // 收据里的路径必须真能读回原文（这才是「无损」）
    const file = first.stats.files[0];
    assert(node_fs_1.default.existsSync(file), `spilled file missing: ${file}`);
    assert(node_fs_1.default.readFileSync(file, 'utf8') === big, 'spilled content must equal the original byte for byte');
});
// ---------------------------------------------------------------------------
// 25b) 旧 tool-call 参数折叠：必须仍是合法 JSON，且 id/name 原样保留
// ---------------------------------------------------------------------------
check('prefix.spill-preserves-tool-call-json', () => {
    const dir = node_fs_1.default.mkdtempSync(node_path_1.default.join(node_os_1.default.tmpdir(), 'ck-args-'));
    const longArgs = JSON.stringify({ command: 'Get-ChildItem -Recurse '.repeat(40) });
    const messages = [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        {
            role: 'assistant',
            content: [{ type: 'tool-call', id: 'call_42', name: 'pwsh', arguments: longArgs }],
        },
        { role: 'tool', content: [{ type: 'text', text: 'ok' }] },
        { role: 'user', content: [{ type: 'text', text: 'recent' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ];
    const { messages: out, stats } = (0, prefix_spill_1.foldOldToolResults)(messages, { spillDir: dir, retainRecent: 2 });
    // 真事故：把参数换成收据后，模型会照着历史把自己的调用也写成收据，
    // 于是宿主拿到 {"_spill":...} 当参数 → MALFORMED_RESPONSE。
    // assistant 的工具调用是模型的模仿模板，一个字节都不许动。
    assert(!('foldedArgs' in stats), 'there must be no way to fold arguments at all');
    const block = out[1].content[0];
    assert(block.id === 'call_42', 'tool-call id must survive: it is the pairing key');
    assert(block.name === 'pwsh', 'tool-call name must survive: it is the intent');
    assert(block.arguments === longArgs, 'assistant tool-call arguments must be byte-identical: history is the imitation template');
});
// ---------------------------------------------------------------------------
// 28) 配对校验器：孤儿调用 / 孤儿结果都必须被判否（线上 INVALID_REQUEST 的回归）
// ---------------------------------------------------------------------------
check('prefix.tool-pairing-validator', () => {
    const call = (id) => ({ type: 'tool-call', id, name: 'read', arguments: '{}' });
    const ok = [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', content: [call('a')] },
        { role: 'tool', toolCallId: 'a', content: [{ type: 'text', text: 'r' }] },
    ];
    assert((0, episode_evict_1.assertToolPairing)(ok), 'a matched pair must pass');
    // 线上事故形态：调用还在，结果被删掉了
    const orphanCall = [ok[0], ok[1]];
    assert(!(0, episode_evict_1.assertToolPairing)(orphanCall), 'a call without its result must fail');
    // 反向：结果还在，调用被删掉了
    const orphanResult = [ok[0], ok[2]];
    assert(!(0, episode_evict_1.assertToolPairing)(orphanResult), 'a result without its call must fail');
    // 顺序颠倒
    const reversed = [ok[0], ok[2], ok[1]];
    assert(!(0, episode_evict_1.assertToolPairing)(reversed), 'result before call must fail');
});
// 27) 探针结论必须能跨进程复用：否则重启后第一轮不剥离 → 第二轮剥离 → 两次冷读
// ---------------------------------------------------------------------------
check('reasoning.probe-cache-roundtrip', () => {
    const dir = node_fs_1.default.mkdtempSync(node_path_1.default.join(node_os_1.default.tmpdir(), 'ck-probe-'));
    const file = node_path_1.default.join(dir, 'probe.json');
    const key = (0, reasoning_drop_1.probeCacheKey)('deepseek-account', 'deepseek-flash');
    assert((0, reasoning_drop_1.readProbeCache)(file, key) === null, 'a missing cache must read as null');
    (0, reasoning_drop_1.writeProbeCache)(file, { key, verdict: 'allowed', control: true, stripped: true, at: new Date().toISOString() });
    const hit = (0, reasoning_drop_1.readProbeCache)(file, key);
    assert(hit !== null && hit.verdict === 'allowed', 'a written verdict must read back');
    // 换个模型就必须重新探针，绝不能把别的模型结论套过来
    assert((0, reasoning_drop_1.readProbeCache)(file, (0, reasoning_drop_1.probeCacheKey)('deepseek-account', 'other')) === null, 'key must include the model');
    (0, reasoning_drop_1.writeProbeCache)(file, { key, verdict: 'denied', control: false, stripped: false, at: new Date().toISOString() });
    assert((0, reasoning_drop_1.readProbeCache)(file, key).verdict === 'denied', 'a later verdict must overwrite the earlier one');
});
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
// ---------------------------------------------------------------------------
