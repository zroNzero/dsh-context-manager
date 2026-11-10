"use strict";
/**
 * 验收脚本：证明插件按预期运行。
 *
 * 不是 demo 的复述，而是带断言的验收：
 * 1. 插件导出契约（name / inject / Config / apply / 无 default）；
 * 2. apply 在宿主形态的 ctx 上完成注册（prompt section、tool、两个钩子）；
 * 3. Schema 压缩真的在 LLM 请求边界生效；
 * 4. 工具输出真的被压缩且原文可回读（ADMISSION 指针）；
 * 5. 去重总线真的命中；
 * 6. 历史折叠真的写入 surface，第二次因 prefixBreak 被 CacheAnchor 拦截；
 * 7. 全工程无 console.log；
 * 8. dispose 可安全卸载。
 *
 * 任一断言失败 → 退出码 1。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const index_1 = require("./index");
const contracts_1 = require("./contracts");
const results = [];
function check(label, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => {
        results.push({ ok: true, label, detail: 'ok' });
    })
        .catch((error) => {
        results.push({ ok: false, label, detail: error instanceof Error ? error.message : String(error) });
    });
}
function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}
class FakeSession {
    id = 'verify-session';
    surface = { nodes: [] };
    appended = [];
    seq = 0;
    events = new Map();
    add(type, message) {
        const seq = ++this.seq;
        this.events.set(seq, { type, seq, data: { message } });
        this.surface.nodes.push(seq);
        return seq;
    }
    eventAt(seq) {
        return this.events.get(seq);
    }
    deriveMessages() {
        return this.surface.nodes.map((seq) => this.events.get(seq)?.data?.message).filter(Boolean);
    }
    deriveEventMessage(event) {
        return event?.data?.message ?? null;
    }
    append(type, data, opts) {
        this.appended.push({ type, data, opts });
        const seq = ++this.seq;
        this.events.set(seq, { type, seq, data: { message: data } });
        const op = opts?.surfaceOp;
        if (op?.op === 'replace') {
            const start = this.surface.nodes.indexOf(op.startSeq);
            const end = this.surface.nodes.indexOf(op.endSeq);
            if (start >= 0 && end >= start)
                this.surface.nodes.splice(start, end - start + 1, seq);
            else
                this.surface.nodes.push(seq);
        }
        else
            this.surface.nodes.push(seq);
        return { seq };
    }
}
function bigCode(methods) {
    const lines = ['// verify fixture', 'export class VerifyService {'];
    for (let index = 0; index < methods; index += 1) {
        lines.push(`  method_${index}(input: string): Promise<string> {`);
        lines.push(`    const body_${index} = input.repeat(${index})`);
        lines.push(`    return Promise.resolve(body_${index})`);
        lines.push('  }');
    }
    lines.push('}');
    return lines.join('\n');
}
const cfg = {
    maxInputTokens: 3000,
    foldAtRatio: 0.4,
    retainRecent: 6,
    minSaveTokens: 100,
    admissionTokens: 1000,
    extractionTokens: 200,
};
async function main() {
    await check('exports contract', () => {
        assert(index_1.name === 'cost-killer-orchestrator', `name=${index_1.name}`);
        assert(Array.isArray(index_1.inject) && index_1.inject.length === 4, 'inject must declare 4 services');
        assert(typeof index_1.apply === 'function', 'apply missing');
        const parsed = index_1.Config.parse({});
        assert(parsed.maxInputTokens === 100000, 'Config default mismatch');
    });
    const hooks = new Map();
    const sections = [];
    const tools = [];
    const captured = [];
    const fakeLlm = {
        stream(request) {
            captured.push(request);
            return (async function* () { })();
        },
    };
    const ctx = {
        llm: fakeLlm,
        systemPrompt: { section: (section) => { sections.push(section); return () => { }; } },
        tools: { register: (definition) => { tools.push(definition); return () => { }; } },
        on: (event, fn) => { hooks.set(event, fn); return () => { }; },
    };
    const disposer = (0, index_1.apply)(ctx, cfg);
    await check('apply registers prompt section/tool/hooks', () => {
        assert(sections.some((section) => section.order === 46), 'section order 46 missing');
        assert(tools.some((tool) => tool.name === 'costkiller_status'), 'status tool missing');
        assert(hooks.has('tools/post-execute'), 'post-execute hook missing');
        assert(hooks.has('agent/pre-step'), 'pre-step hook missing');
        assert(typeof disposer === 'function', 'apply must return disposer');
    });
    await check('schema compression at llm boundary', () => {
        const schemaTools = Array.from({ length: 40 }, (_, index) => ({
            name: `tool_${index}`,
            description: 'long description '.repeat(40),
            parameters: { type: 'object', properties: { p: { type: 'string' } } },
        }));
        const before = (0, contracts_1.estimateTokens)(JSON.stringify(schemaTools));
        fakeLlm.stream({ provider: 'p', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: '分析' }] }], tools: schemaTools });
        const sent = captured[captured.length - 1];
        assert(sent && sent !== undefined, 'request not captured');
        const after = (0, contracts_1.estimateTokens)(JSON.stringify(sent.tools));
        assert(after < before * 0.8, `schema compression ineffective: ${before}->${after}`);
        assert(sent.tools.length === schemaTools.length, 'capability set must stay intact');
    });
    await check('schema install defers until llm service is ready', async () => {
        const ctx2 = {
            systemPrompt: { section: () => () => { } },
            tools: { register: () => () => { } },
            on: () => () => { },
        };
        const dispose2 = (0, index_1.apply)(ctx2, cfg);
        const captured2 = [];
        await new Promise((resolve) => setTimeout(resolve, 50));
        ctx2.llm = {
            stream(request) {
                captured2.push(request);
                return (async function* () { })();
            },
        };
        await new Promise((resolve) => setTimeout(resolve, 700));
        const lateTools = Array.from({ length: 20 }, (_, index) => ({
            name: `late_tool_${index}`,
            description: 'long deferred description '.repeat(30),
            parameters: { type: 'object', properties: {} },
        }));
        ctx2.llm.stream({
            provider: 'p',
            model: 'm',
            messages: [{ role: 'user', content: [{ type: 'text', text: '分析' }] }],
            tools: lateTools,
        });
        assert(captured2.length === 1, 'late llm stream was not captured');
        const description = String(captured2[0].tools[0].description ?? '');
        assert(description.length <= 121, `deferred install did not patch stream (len=${description.length})`);
        dispose2();
    });
    await check('tool output compressed with recoverable pointer', async () => {
        const post = hooks.get('tools/post-execute');
        const payload = bigCode(160);
        const decision = { kind: 'accept', content: [{ type: 'text', text: payload }] };
        const output = await post({ tool: { name: 'read' } }, decision, async () => decision);
        const returned = String(output?.content?.[0]?.text ?? '');
        assert(returned.length < payload.length * 0.6, `output not compressed enough: ${payload.length}->${returned.length}`);
        assert(returned.includes('class VerifyService'), 'class name lost');
        assert(!returned.includes('input.repeat('), 'method bodies leaked into skeleton');
        assert(returned.includes('[ADMISSION]'), 'admission pointer missing');
        const pointer = /saved at: ([^)]+\.txt)/.exec(returned)?.[1] ?? /落盘：([^）]+\.txt)/.exec(returned)?.[1];
        assert(pointer !== undefined && node_fs_1.default.existsSync(pointer), `spill file missing: ${pointer}`);
        const spilled = node_fs_1.default.readFileSync(pointer, 'utf8');
        assert(spilled === payload, 'spilled content mismatch');
    });
    await check('dedup bus hits on identical output', async () => {
        const post = hooks.get('tools/post-execute');
        const payload = `duplicate ${'line '.repeat(300)}`;
        const decision = { kind: 'accept', content: [{ type: 'text', text: payload }] };
        await post({ tool: { name: 'bash' } }, decision, async () => decision);
        const second = await post({ tool: { name: 'bash' } }, decision, async () => decision);
        const returned = String(second?.content?.[0]?.text ?? '');
        assert(returned.includes('[DEDUP]'), 'dedupe pointer missing');
    });
    const session = new FakeSession();
    session.add('user/message', { role: 'user', content: [{ type: 'text', text: '需求：修复 C:\\repo\\app.ts，TODO: 补测试' }] });
    for (let index = 0; index < 10; index += 1) {
        session.add('assistant/message', {
            role: 'assistant',
            content: [{ type: 'text', text: `<thought>${'思考 '.repeat(60)}</thought> 决定采用方案 ${index}：${'x'.repeat(300)}` }],
        });
        session.add('tool/result', { role: 'tool', content: [{ type: 'text', text: `Error: ENOENT at src\\f${index}.ts [exit code: 1] ${'y'.repeat(300)}` }] });
    }
    for (let index = 0; index < 3; index += 1) {
        session.add('assistant/message', { role: 'assistant', content: [{ type: 'text', text: `近期 ${index} ${'r'.repeat(300)}` }] });
        session.add('tool/result', { role: 'tool', content: [{ type: 'text', text: `近期结果 ${index} ${'s'.repeat(300)}` }] });
    }
    session.add('assistant/message', { role: 'assistant', content: [{ type: 'text', text: `结论：完成 ${'z'.repeat(300)}` }] });
    await check('memory fold applied on cold cache', async () => {
        const pre = hooks.get('agent/pre-step');
        const before = session.appended.length;
        await pre({ agent: { session, model: 'm' }, turn: 1, step: 1, messages: [] }, async () => ({ kind: 'enter', messages: [] }));
        assert(session.appended.length === before + 1, 'fold patch was not applied');
        const summary = String(session.appended[session.appended.length - 1]?.data?.content?.[0]?.text ?? '');
        assert(summary.includes('[CONTEXT_INDEX]'), 'context index missing in summary');
        assert(summary.includes('[CoT]'), 'CoT distillation line missing');
    });
    await check('second fold blocked by prefix break', async () => {
        for (let index = 0; index < 5; index += 1) {
            session.add('assistant/message', { role: 'assistant', content: [{ type: 'text', text: `二轮 ${index} ${'a'.repeat(300)}` }] });
            session.add('tool/result', { role: 'tool', content: [{ type: 'text', text: `二轮输出 ${index} ${'b'.repeat(300)}` }] });
        }
        session.add('user/message', { role: 'user', content: [{ type: 'text', text: '继续第二轮' }] });
        session.add('assistant/message', { role: 'assistant', content: [{ type: 'text', text: `二轮结论 ${'c'.repeat(300)}` }] });
        const pre = hooks.get('agent/pre-step');
        const before = session.appended.length;
        await pre({ agent: { session, model: 'm' }, turn: 2, step: 1, messages: [] }, async () => ({ kind: 'enter', messages: [] }));
        assert(session.appended.length === before, 'prefix-breaking patch must be blocked');
    });
    await check('pre-step never folds tool-call history', async () => {
        const session = new FakeSession();
        session.id = 'verify-toolcall';
        session.add('user/message', { role: 'user', content: [{ type: 'text', text: '需求：修复 bug' }] });
        for (let index = 0; index < 10; index += 1) {
            session.add('assistant/message', {
                role: 'assistant',
                content: [
                    { type: 'tool-call', callId: `call_${index}` },
                    { type: 'text', text: 'x'.repeat(300) },
                ],
            });
            session.add('tool/result', {
                role: 'tool',
                toolCallId: `call_${index}`,
                content: [{ type: 'text', text: 'y'.repeat(300) }],
            });
        }
        session.add('assistant/message', { role: 'assistant', content: [{ type: 'text', text: '结论：完成' }] });
        const pre = hooks.get('agent/pre-step');
        const before = session.appended.length;
        await pre({ agent: { session, model: 'm' }, turn: 1, step: 1, messages: [] }, async () => ({ kind: 'enter', messages: [] }));
        assert(session.appended.length === before, 'tool-call history must never be folded end-to-end');
    });
    await check('no console.log in sources', () => {
        const dir = node_path_1.default.resolve('src');
        const offenders = [];
        const walk = (current) => {
            for (const entry of node_fs_1.default.readdirSync(current, { withFileTypes: true })) {
                const full = node_path_1.default.join(current, entry.name);
                if (entry.isDirectory())
                    walk(full);
                else if (entry.name.endsWith('.ts')) {
                    const text = node_fs_1.default.readFileSync(full, 'utf8');
                    for (const line of text.split('\n')) {
                        const needle = `console${'.log('}`;
                        if (line.includes(needle) && !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//')) {
                            offenders.push(`${entry.name}: ${line.trim()}`);
                        }
                    }
                }
            }
        };
        walk(dir);
        assert(offenders.length === 0, `console.log found: ${offenders.join('; ')}`);
    });
    await check('dispose is safe', () => {
        disposer();
        disposer();
    });
    const failed = results.filter((item) => !item.ok);
    for (const item of results)
        process.stdout.write(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label} :: ${item.detail}\n`);
    process.stdout.write(`\nverify summary: ${results.length - failed.length} passed, ${failed.length} failed\n`);
    if (failed.length > 0)
        process.exitCode = 1;
}
void main().catch((error) => {
    process.stdout.write(`verify crashed: ${String(error)}\n`);
    process.exitCode = 1;
});
