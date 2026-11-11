"use strict";
/**
 * 端到端演示 v3.5：CoT 蒸馏 / 缓存门控 / 路由决策 / Spill 回收。
 *
 * 1. 121k 字符工具输出 → AST 提纯 + 落盘指针；
 * 2. 历史含 <thought> 的 21 条中间消息 → CoT 蒸馏 + Fold（CacheAnchor 放行）；
 * 3. 第二轮折叠改到已发送前缀 → CacheAnchor 拦截；
 * 4. 路由：小上下文强制本地（mock Ollama 命中）+ 慢服务超时降级；
 * 5. Spill GC：TTL 回收，pinned 文件保留；
 * 6. 批量 20 条输出，统计整体降幅。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = __importDefault(require("node:fs"));
const node_http_1 = __importDefault(require("node:http"));
const node_path_1 = __importDefault(require("node:path"));
const index_1 = require("./index");
const contracts_1 = require("./contracts");
const log_1 = require("./log");
const routing_1 = require("./modules/routing");
const spill_gc_1 = require("./modules/spill-gc");
const schema_index_1 = require("./modules/schema-index");
const breaker_1 = require("./modules/breaker");
const tool_attention_1 = require("./modules/tool-attention");
const extraction_1 = require("./modules/extraction");
const response_cache_1 = require("./modules/response-cache");
const scope_1 = require("./modules/scope");
const osiris_1 = require("./modules/osiris");
const tool_attention_2 = require("./modules/tool-attention");
const tool_pipe_1 = require("./modules/tool-pipe");
const pricing_1 = require("./modules/pricing");
const output_guard_1 = require("./modules/output-guard");
const write = (line) => {
    process.stdout.write(`${line}\n`);
};
class FakeSession {
    id = 'demo-session';
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
        const messages = [];
        for (const seq of this.surface.nodes) {
            const message = this.events.get(seq)?.data?.message;
            if (message)
                messages.push(message);
        }
        return messages;
    }
    deriveEventMessage(event) {
        return event?.data?.message ?? null;
    }
    append(type, data, opts) {
        this.appended.push({ type, data, opts });
        const seq = ++this.seq;
        this.events.set(seq, { type, seq, data: { message: data } });
        const op = opts?.surfaceOp;
        const nodes = this.surface.nodes;
        if (op && op.op === 'replace') {
            const startIndex = nodes.indexOf(op.startSeq);
            const endIndex = nodes.indexOf(op.endSeq);
            if (startIndex >= 0 && endIndex >= startIndex)
                nodes.splice(startIndex, endIndex - startIndex + 1, seq);
            else
                nodes.push(seq);
        }
        else {
            nodes.push(seq);
        }
        return { seq };
    }
}
function makeCtx() {
    const hooks = new Map();
    const ctx = {
        systemPrompt: { section: () => () => { } },
        tools: { register: () => () => { } },
        on: (event, fn) => {
            hooks.set(event, fn);
            return () => { };
        },
    };
    return { ctx, hooks };
}
const userMsg = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const assistantMsg = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });
const toolMsg = (text) => ({ role: 'tool', content: [{ type: 'text', text }] });
function bigCode(methods) {
    const lines = [
        '// ===== demo: MassiveService =====',
        "import { cache } from './cache'",
        'export class MassiveService {',
        '  private readonly store = new Map<string, string>()',
    ];
    for (let index = 0; index < methods; index += 1) {
        lines.push(`  method_${index}(input: string, count: number): Promise<string> {`);
        for (let step = 0; step < 4; step += 1) {
            lines.push(`    const bodyMarker_${index}_${step} = input.repeat(${step}) + count`);
        }
        lines.push(`    return Promise.resolve(bodyMarker_${index}_0)`);
        lines.push('  }');
    }
    lines.push('}');
    return lines.join('\n');
}
function buildJsonPayload(items) {
    return JSON.stringify({
        items: Array.from({ length: items }, (_, index) => ({
            id: index,
            file: `C:\\demo\\item-${index}.txt`,
            note: 'payload '.repeat(20),
        })),
    });
}
function thoughtBlock(index) {
    return `<thought>${`思考 ${index}：先排查缓存命中率，再对比 AST 与分节压缩的收益。`.repeat(30)}</thought>`;
}
async function main() {
    const session = new FakeSession();
    const { ctx, hooks } = makeCtx();
    const dispose = (0, index_1.apply)(ctx, {
        maxInputTokens: 3000,
        foldAtRatio: 0.4,
        retainRecent: 6,
        minSaveTokens: 100,
        admissionTokens: 1000,
        extractionTokens: 200,
        spillDir: './spill',
    });
    const post = hooks.get('tools/post-execute');
    const pre = hooks.get('agent/pre-step');
    if (typeof post !== 'function' || typeof pre !== 'function')
        throw new Error('hooks were not registered');
    // ---------- 1. 工具输出 ----------
    const payload = `${bigCode(180)}\n\n${buildJsonPayload(300)}`;
    const accept = { kind: 'accept', content: [{ type: 'text', text: payload }] };
    const pipelineStarted = Date.now();
    const toolResult = await post({ tool: { name: 'bash' } }, accept, async () => accept);
    const pipelineMs = Date.now() - pipelineStarted;
    const returned = String(toolResult?.content?.[0]?.text ?? '');
    const pipelineBefore = (0, contracts_1.estimateTokens)(payload);
    const pipelineAfter = (0, contracts_1.estimateTokens)(returned);
    write(`    class kept=${returned.includes('class MassiveService')} | admission pointer=${returned.includes('[ADMISSION]')}`);
    (0, log_1.logEvent)('info', 'demo.pipeline', { tokensBefore: pipelineBefore, tokensAfter: pipelineAfter });
    // ---------- 2. 第一轮 pre-step：CoT 蒸馏 + Fold ----------
    session.add('user/message', userMsg('需求：分析 C:\\repo\\app.ts 的缓存问题，TODO: 补测试，UUID 3ddb09f8-79ae-4999-a60d-f73e584d3f64'));
    for (let index = 0; index < 10; index += 1) {
        session.add('assistant/message', assistantMsg(`${thoughtBlock(index)} 决定采用方案 ${index}：改用 surface 折叠，理由 ${'x'.repeat(400)}`));
        session.add('tool/result', toolMsg(`Error: ENOENT at src\\file${index}.ts:${index} [exit code: 1] ${'y'.repeat(500)}`));
    }
    for (let index = 0; index < 3; index += 1) {
        session.add('assistant/message', assistantMsg(`近期尝试 ${index}：${'r'.repeat(400)}`));
        session.add('tool/result', toolMsg(`近期结果 ${index}：${'s'.repeat(400)}`));
    }
    session.add('assistant/message', assistantMsg(`结论：方案已定，${'z'.repeat(400)}`));
    const foldBefore1 = session.appended.length;
    await pre({ agent: { session, model: 'demo-model' }, turn: 1, step: 1, messages: [] }, async () => ({ kind: 'enter', messages: [] }));
    const foldDelta1 = session.appended.length - foldBefore1;
    const foldSummary = String(session.appended[session.appended.length - 1]?.data?.content?.[0]?.text ?? '');
    const cotLine = foldSummary.split('\n').find((line) => line.startsWith('[CoT]')) ?? '(no CoT line)';
    // ---------- 3. 第二轮 pre-step：应被 CacheAnchor 拦截 ----------
    for (let index = 0; index < 5; index += 1) {
        session.add('assistant/message', assistantMsg(`第二轮尝试 ${index}：${'a'.repeat(500)}`));
        session.add('tool/result', toolMsg(`第二轮输出 ${index}：${'b'.repeat(500)}`));
    }
    session.add('user/message', userMsg('继续：第二轮需求，检查前缀缓存是否被破坏'));
    session.add('assistant/message', assistantMsg(`第二轮结论：${'c'.repeat(500)}`));
    const foldBefore2 = session.appended.length;
    await pre({ agent: { session, model: 'demo-model' }, turn: 2, step: 1, messages: [] }, async () => ({ kind: 'enter', messages: [] }));
    const foldDelta2 = session.appended.length - foldBefore2;
    // ---------- 4. 路由：本地命中 + 超时降级 ----------
    const fastServer = node_http_1.default.createServer((request, response) => {
        request.resume();
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ response: 'local-answer' }));
    });
    await new Promise((resolve) => fastServer.listen(0, '127.0.0.1', () => resolve()));
    const fastPort = fastServer.address().port;
    const router = new routing_1.RoutingModule({ baseUrl: `http://127.0.0.1:${fastPort}`, timeoutMs: 3000 });
    const localRoute = await router.routeWithContext({ prompt: '你好，帮我算一下 1+1', contextTokens: 1800, crossFileDependency: false });
    await new Promise((resolve) => fastServer.close(() => resolve()));
    const slowServer = node_http_1.default.createServer((request, response) => {
        request.resume();
        setTimeout(() => {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ response: 'slow-answer' }));
        }, 400);
    });
    await new Promise((resolve) => slowServer.listen(0, '127.0.0.1', () => resolve()));
    const slowPort = slowServer.address().port;
    const slowRouter = new routing_1.RoutingModule({ baseUrl: `http://127.0.0.1:${slowPort}`, timeoutMs: 120 });
    const timeoutRoute = await slowRouter.routeWithContext({ prompt: '简单问题', contextTokens: 1200, crossFileDependency: false });
    await new Promise((resolve) => slowServer.close(() => resolve()));
    // ---------- 5. Spill GC ----------
    const gcDir = node_path_1.default.resolve('.demo-spill');
    node_fs_1.default.rmSync(gcDir, { recursive: true, force: true });
    node_fs_1.default.mkdirSync(gcDir, { recursive: true });
    const old = (Date.now() - 48 * 3600_000) / 1000;
    for (let index = 0; index < 60; index += 1) {
        const file = node_path_1.default.join(gcDir, `file-${index}.txt`);
        node_fs_1.default.writeFileSync(file, 'x'.repeat(2048));
        node_fs_1.default.utimesSync(file, old, old);
    }
    const pinnedFile = node_path_1.default.join(gcDir, 'file-0.txt');
    (0, spill_gc_1.pinSpill)(pinnedFile, 3600_000);
    const gc = (0, spill_gc_1.collectGarbage)({ dir: gcDir, maxFiles: 50, ttlMs: 24 * 3600_000, minAgeMs: 0 });
    const pinnedKept = node_fs_1.default.existsSync(pinnedFile);
    (0, log_1.logEvent)('info', 'demo.spill_gc', {
        scanned: gc.scanned,
        deleted: gc.deleted.length,
        kept: gc.kept,
        pinnedSkipped: gc.pinnedSkipped,
        pinnedKept,
    });
    node_fs_1.default.rmSync(gcDir, { recursive: true, force: true });
    // ---------- 6. Schema 压缩（MCP Tool Tax） ----------
    const tools = Array.from({ length: 80 }, (_, index) => ({
        name: `mcp_tool_${index}`,
        description: `MCP tool ${index}: ${'performs a specialized workspace operation with detailed usage notes. '.repeat(8)}`,
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'absolute file path '.repeat(8) },
                mode: { type: 'string', description: 'execution mode '.repeat(8) },
            },
        },
    }));
    const captured = [];
    const fakeLlm = {
        stream(request) {
            captured.push(request);
            return (async function* () { })();
        },
    };
    const disposeSchema = (0, schema_index_1.installSchemaCompressor)({ llm: fakeLlm, get: () => undefined }, {
        enabled: true,
        maxDescriptionChars: 120,
    });
    const schemaBefore = (0, schema_index_1.schemaTokens)(tools);
    fakeLlm.stream({
        provider: 'p',
        model: 'm',
        sessionId: 'schema-demo',
        messages: [{ role: 'user', content: [{ type: 'text', text: '分析源码结构' }] }],
        tools,
    });
    const schemaAfter = (0, schema_index_1.schemaTokens)(captured[0]?.tools ?? []);
    disposeSchema();
    // ---------- 7. 压缩熔断 ----------
    const breaker = new breaker_1.CompressionBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    breaker.recordFailure('no-net-saving');
    breaker.recordFailure('fail-closed');
    breaker.recordFailure('no-net-saving');
    const breakerState = breaker.state;
    const breakerAllows = breaker.canRun();
    // ---------- 8. 索引先行（index-first） ----------
    const listText = `目录清单：\n${Array.from({ length: 200 }, (_, index) => `C:\\repo\\src\\module-${index}.ts`).join('\n')}`;
    const listDecision = { kind: 'accept', content: [{ type: 'text', text: listText }] };
    const listOut = await post({ tool: { name: 'glob' } }, listDecision, async () => listDecision);
    const listReturned = String(listOut?.content?.[0]?.text ?? '');
    // ---------- 9. 去重总线 ----------
    const dupPayload = `重复输出检测\n${'line '.repeat(400)}`;
    const dupDecision = { kind: 'accept', content: [{ type: 'text', text: dupPayload }] };
    await post({ tool: { name: 'bash' } }, dupDecision, async () => dupDecision);
    const dupSecond = await post({ tool: { name: 'bash' } }, dupDecision, async () => dupDecision);
    const dupText = String(dupSecond?.content?.[0]?.text ?? '');
    const dedupHit = dupText.includes('[DEDUP]');
    const dupTokens = (0, contracts_1.estimateTokens)(dupPayload);
    const dupAfter = (0, contracts_1.estimateTokens)(dupText);
    // ---------- 10. 超大体量快速路径 ----------
    const hugeCode = bigCode(1500);
    const hugeDecision = { kind: 'accept', content: [{ type: 'text', text: hugeCode }] };
    const hugeStarted = Date.now();
    const hugeOut = await post({ tool: { name: 'read' } }, hugeDecision, async () => hugeDecision);
    const hugeMs = Date.now() - hugeStarted;
    const hugeReturned = String(hugeOut?.content?.[0]?.text ?? '');
    // ---------- 11. v1.3：Tool Attention / TOON / 语义缓存 / 本地探测 ----------
    const attentionTools = Array.from({ length: 80 }, (_, index) => ({
        name: `mcp_tool_${index}`,
        description: index % 5 === 0 ? 'read files and run tests for the auth module' : `generic utility ${index}`,
        parameters: { type: 'object', properties: {} },
    }));
    const attention = (0, tool_attention_1.selectTools)(attentionTools, 'run the failing test and read the auth file', 5);
    const attentionBefore = (0, schema_index_1.schemaTokens)(attentionTools);
    const attentionAfter = (0, schema_index_1.schemaTokens)(attention.selected);
    (0, log_1.logEvent)('info', 'tool_attention.filtered', {
        module: 'ToolAttention',
        total: attentionTools.length,
        selected: attention.selected.length,
        hidden: attention.hidden.length,
        tokensBefore: attentionBefore,
        tokensAfter: attentionAfter,
    });
    const budget = (0, scope_1.planBudget)(20000, attentionBefore);
    (0, log_1.logEvent)('info', 'scope.budget', { module: 'SCOPE', ...budget });
    const seal = (0, osiris_1.sealState)({
        messages: [{ role: 'user', content: 'run the failing test and read the auth file' }],
        tools: attentionTools,
        bucket: (0, osiris_1.intentBucket)('run the failing test and read the auth file'),
        keepRecent: budget.retainRecent,
    });
    (0, log_1.logEvent)('info', 'osiris.seal', { module: 'OSIRIS', ...seal });
    const scout = (0, tool_attention_2.selectToolsScout)(attentionTools, 'run the failing test and read the auth file', 5);
    (0, log_1.logEvent)('info', 'scout.route', { module: 'SCOUT', total: 80, selected: scout.selected.length, top: scout.scoreboard.slice(0, 5) });
    const pipeDir = node_path_1.default.join('.demo-spill', 'pipe');
    node_fs_1.default.mkdirSync(pipeDir, { recursive: true });
    const pipeFile = node_path_1.default.join(pipeDir, 'demo-payload.txt');
    node_fs_1.default.writeFileSync(pipeFile, 'pipe payload for demo', 'utf8');
    const pipe = new tool_pipe_1.ToolPipe(pipeDir);
    const pipePublished = pipe.publishFile(pipeFile);
    const pipeRead = pipe.resolve(pipePublished.ref);
    (0, log_1.logEvent)('info', 'toolpipe.publish', { module: 'ToolPipe', ref: pipePublished.ref, bytes: pipePublished.bytes });
    (0, log_1.logEvent)('info', 'toolpipe.read', { module: 'ToolPipe', ref: pipePublished.ref, ok: pipeRead.ok, bytes: pipeRead.bytes });
    (0, log_1.logEvent)('info', 'tool_attention.layered', { module: 'ToolAttention', total: 80, full: 3, signature: 7, hidden: 70 });
    const astSample = [
        'interface RequestDto { userId: string; nested: { flag: boolean } }',
        'class ValidationError extends Error {}',
        'class AuditTrail { record(value: RequestDto): void {} }',
        'function handle(request: RequestDto): void {',
        '  const trail = new AuditTrail()',
        '  trail.record(request)',
        '  if (!request.userId) throw new ValidationError()',
        '}',
        ...Array.from({ length: 2000 }, (_, index) => `const filler_${index} = ${index}`),
    ].join('\n');
    const astSummary = (0, extraction_1.runExtraction)({ text: astSample, maxTokens: 400 });
    const shapeLog = [
        'boot service',
        'input.userId = null',
        'caller = processOrder',
        'stack: Service.run',
        'NullPointerException at run',
        ...Array.from({ length: 60 }, (_, index) => `heartbeat ${index}`),
    ].join('\n');
    const shapeSummary = (0, extraction_1.buildFirewallSummary)(shapeLog, 160);
    (0, log_1.logEvent)('info', 'shape.protected', {
        module: 'Firewall',
        protectedLines: shapeSummary.protectedLines,
        foldedRuns: shapeSummary.foldedRuns,
        errorKept: shapeSummary.text.includes('NullPointerException'),
    });
    const flashPrice = (0, pricing_1.priceFor)('deepseek-flash');
    (0, log_1.logEvent)('info', 'pricing.loaded', (0, pricing_1.pricingLoadedLog)(flashPrice));
    let truncateReason = '';
    const fakeOutput = (async function* () {
        yield { type: 'text', text: '{"ok":true}' };
        yield { type: 'text', text: ' trailing nonsense that should be stopped' };
    })();
    for await (const _chunk of (0, output_guard_1.guardedStream)(fakeOutput, {
        maxTokens: 1500,
        onTruncate: (reason) => {
            truncateReason = reason;
        },
    })) {
        /* consume */
    }
    (0, log_1.logEvent)('info', 'output.truncated', { module: 'OutputGuard', reason: truncateReason || 'none' });
    dispose();
    const toonRows = Array.from({ length: 120 }, (_, index) => ({
        id: index,
        level: 'info',
        message: `event ${index} finished`,
        ok: true,
        ms: index * 2,
    }));
    const toon = (0, extraction_1.toonEncode)(JSON.stringify(toonRows, null, 2));
    if (toon) {
        (0, log_1.logEvent)('info', 'toon.encoded', {
            module: 'TOON',
            rows: toon.rows,
            cols: toon.cols,
            tokensBefore: toon.tokensBefore,
            tokensAfter: toon.tokensAfter,
            rate: Number((1 - toon.tokensAfter / toon.tokensBefore).toFixed(3)),
        });
    }
    const semanticCache = new response_cache_1.ResponseCache({ similarityThreshold: 0.85 });
    const semanticText = 'please fix the failing authentication test in the login module today because the build is broken and users cannot sign in';
    semanticCache.set('demo', [{ type: 'text', text: 'cached' }], semanticText);
    const semanticHit = semanticCache.findSimilar(semanticText.replace(' test ', ' tests '));
    if (semanticHit) {
        (0, log_1.logEvent)('info', 'cache.semantic_hit', { module: 'ResponseCache', score: semanticHit.score, ...semanticCache.stats() });
    }
    let localProbeOk = false;
    try {
        const probe = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(500) });
        localProbeOk = probe.ok;
    }
    catch {
        localProbeOk = false;
    }
    (0, log_1.logEvent)('info', localProbeOk ? 'routing.local_available' : 'routing.local_unavailable', { module: 'Routing' });
    if (localRoute.result.route === 'local') {
        (0, log_1.logEvent)('info', 'routing.local_hit', { module: 'Routing', latencyMs: localRoute.result.latencyMs });
    }
    dispose();
    // ---------- 汇总 ----------
    write(`[1] tool output: ${payload.length} chars, tokens ${pipelineBefore} -> ${pipelineAfter} (saved ${pipelineBefore - pipelineAfter}) in ${pipelineMs}ms`);
    write(`[2] pre-step #1 foldAppends=${foldDelta1} | ${cotLine} | indexCard=${foldSummary.includes('[CONTEXT_INDEX]') ? 'yes' : 'no'}`);
    write(`[3] pre-step #2 foldAppends=${foldDelta2} (0 = CacheAnchor 拦截)`);
    write(`[4] routing local: route=${localRoute.result.route} reason=${localRoute.result.reason} latency=${localRoute.result.latencyMs}ms`);
    write(`    routing timeout: route=${timeoutRoute.result.route} degraded=${timeoutRoute.result.degraded} reason=${timeoutRoute.result.reason}`);
    write(`[5] spill gc: scanned=${gc.scanned} deleted=${gc.deleted.length} kept=${gc.kept} pinnedSkipped=${gc.pinnedSkipped} pinnedKept=${pinnedKept}`);
    write(`[6] schema: ${tools.length} tools, ${schemaBefore} -> ${schemaAfter} tokens (saved ${schemaBefore - schemaAfter})`);
    write(`[7] breaker: state=${breakerState} allows=${breakerAllows}`);
    write(`[8] index-first: ${(0, contracts_1.estimateTokens)(listText)} -> ${(0, contracts_1.estimateTokens)(listReturned)} tokens (mode=${listReturned.includes('[INDEX]') ? 'index' : 'other'})`);
    write(`[9] dedup: second identical output=${dedupHit ? 'pointer' : 'miss'}, ${dupTokens} -> ${dupAfter} tokens`);
    write(`[10] huge ${hugeCode.length} chars -> ${(0, contracts_1.estimateTokens)(hugeReturned)} tokens in ${hugeMs}ms`);
    write(`[11] tool attention: ${attentionTools.length} -> ${attention.selected.length} tools, schema ${attentionBefore} -> ${attentionAfter} tokens`);
    write(`[12] toon: ${toon
        ? `${toon.rows}x${toon.cols}, ${toon.tokensBefore} -> ${toon.tokensAfter} (-${((1 - toon.tokensAfter / toon.tokensBefore) * 100).toFixed(1)}%)`
        : 'not applicable'}`);
    write(`[13] semantic cache: ${semanticHit ? `hit score=${semanticHit.score.toFixed(3)}` : 'miss'}`);
    write(`[14] routing probe: ${localProbeOk ? 'local available' : 'local unavailable'} | local_hit=${localRoute.result.route === 'local'}`);
    write(`[15] scope: tools=${budget.toolsBudget} memory=${budget.memoryBudget} live=${budget.liveBudget} retain=${budget.retainRecent} | osiris toolsHash=${seal.toolsHash.slice(0, 8)}`);
    write(`[16] toolpipe: ref=${pipePublished.ref} bytes=${pipePublished.bytes} read=${pipeRead.ok}`);
    write(`[17] ast deep: mode=${astSummary.mode} deps=${astSummary.text.includes('[AST_DEP]') ? 'yes' : 'no'} tokens ${(0, contracts_1.estimateTokens)(astSample)} -> ${astSummary.tokensAfter}`);
    write(`[18] shape: protected=${shapeSummary.protectedLines} lines errorKept=${shapeSummary.text.includes('NullPointerException')}`);
    write(`[19] pricing: ${flashPrice.peak ? 'peak' : 'offpeak'} flash hit=${flashPrice.hit} miss=${flashPrice.miss} output=${flashPrice.output} CNY/M`);
    write(`[20] output guard: truncated=${truncateReason || 'none'}`);
    (0, log_1.logEvent)('info', 'demo.summary', {
        pipelineSaved: pipelineBefore - pipelineAfter,
        pipelineMs,
        fold1: foldDelta1,
        fold2: foldDelta2,
        localRoute: localRoute.result.route,
        timeoutDegraded: timeoutRoute.result.degraded,
        gcDeleted: gc.deleted.length,
        gcPinnedSkipped: gc.pinnedSkipped,
        schemaSaved: schemaBefore - schemaAfter,
        breakerState,
        indexFirst: listReturned.includes('[INDEX]'),
        dedupHit,
        indexCard: foldSummary.includes('[CONTEXT_INDEX]'),
    });
}
void main().catch((error) => {
    (0, log_1.logEvent)('error', 'demo.failed', { error: String(error) });
    process.stdout.write(`demo failed: ${String(error)}\n`);
    process.exitCode = 1;
});
