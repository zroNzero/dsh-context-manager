"use strict";
/**
 * 本地自测：
 * 1. CacheAnchor 五条公式/门控断言（含真实 [Block] 日志验证）。
 * 2. Extraction 的 AST 结构保留与 Fail-Closed 兜底。
 * 输出同时写入 ./debug.log 与 stdout（不使用 console.log）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
const cacheAnchor_1 = require("./cacheAnchor");
const extraction_1 = require("./modules/extraction");
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
