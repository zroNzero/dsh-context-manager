"use strict";
/**
 * CostKillerOrchestrator 入口。
 *
 * 钩子编排：
 * - tools/post-execute: Admission（超大输出落盘）→ Extraction（约束 + 骨架/JSON/分节）
 * - agent/pre-step: Memory 折叠 → CacheAnchor 净收益门控 → 通过才提交 surface 补丁
 *
 * 铁律：
 * - 所有状态经 logEvent 写 ./debug.log，全工程无 console.log。
 * - 模块只产出 Patch；payload 永不被原地修改。
 * - 任何异常都 Fail-Open 到原行为，绝不阻断对话。
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.Config = exports.inject = exports.name = void 0;
exports.apply = apply;
const zod_1 = require("zod");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const contracts_1 = require("./contracts");
const cacheAnchor_1 = require("./cacheAnchor");
const log_1 = require("./log");
const admission_1 = require("./modules/admission");
const extraction_1 = require("./modules/extraction");
const memory_1 = require("./modules/memory");
const routing_1 = require("./modules/routing");
const spill_gc_1 = require("./modules/spill-gc");
const schema_index_1 = require("./modules/schema-index");
const breaker_1 = require("./modules/breaker");
const dedup_bus_1 = require("./modules/dedup-bus");
const savings_ledger_1 = require("./modules/savings-ledger");
const workspace_1 = require("./modules/workspace");
exports.name = 'dsh-context-manager';
exports.inject = ['systemPrompt', 'tools', 'sessions', 'agents'];
exports.Config = zod_1.z.object({
    maxInputTokens: zod_1.z.number().int().positive().default(100000),
    maxOutputTokens: zod_1.z.number().int().positive().default(16000),
    /** 上下文占用超过 maxInputTokens * foldAtRatio 才允许折叠。 */
    foldAtRatio: zod_1.z.number().gt(0).lte(1).default(0.6),
    /** 最近 N 条消息永不折叠。 */
    retainRecent: zod_1.z.number().int().nonnegative().default(8),
    /** 单次折叠至少节省多少 token 才提交。 */
    minSaveTokens: zod_1.z.number().int().nonnegative().default(100),
    /** 落盘目录（相对进程工作目录）。 */
    spillDir: zod_1.z.string().default('./spill'),
    /** 单条工具输出超过该 token 数即准入落盘。 */
    admissionTokens: zod_1.z.number().int().positive().default(800),
    /** 单条工具输出经萃取后的目标 token 上限。 */
    extractionTokens: zod_1.z.number().int().positive().default(500),
    /** 上下文防火墙阈值：超过该 token 数的工具输出一律摘要化 + 落盘。 */
    firewallTokens: zod_1.z.number().int().positive().default(250),
    /** 会话总回合数预估，用于 CacheAnchor 的寿命摊销（默认 40：约 2× 冷读回本线）。 */
    assumedTurns: zod_1.z.number().int().positive().default(40),
    /** 是否真正发起本地路由请求（决策与日志始终开启）。 */
    localRouting: zod_1.z.boolean().default(false),
    /** spill 目录保留的最大文件数。 */
    spillMaxFiles: zod_1.z.number().int().positive().default(50),
    /** spill 文件 TTL（小时）。 */
    spillTtlHours: zod_1.z.number().positive().default(24),
    /** 单次萃取的时间预算（毫秒）；超时退化为快速路径，避免阻塞主链路。 */
    compressionBudgetMs: zod_1.z.number().int().positive().default(50),
    /** 去重总线容量。 */
    dedupCapacity: zod_1.z.number().int().positive().default(256),
}).prefault({});
const POLICY_TEXT = [
    'You are running with CostKillerOrchestrator active.',
    'Large tool outputs are replaced by a [ADMISSION] receipt holding the absolute spill path: use the read tool instead of re-running the command.',
    'Compressed history may contain [CORE_CONSTRAINTS] blocks; never drop, reorder, or rewrite those constraints.',
].join(' ');
function textOfContent(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (!block || typeof block !== 'object')
            continue;
        const record = block;
        if (record.type === 'reasoning' || record.type === 'thinking')
            continue;
        if (typeof record.text === 'string')
            parts.push(record.text);
    }
    return parts.join('\n');
}
function messageText(message) {
    if (!message || typeof message !== 'object')
        return '';
    return textOfContent(message.content) || textOfContent(message.message?.content) || '';
}
function flattenPlainText(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return undefined;
    let text = '';
    for (const block of content) {
        if (!block || typeof block !== 'object')
            return undefined;
        const record = block;
        if (record.type !== 'text' || typeof record.text !== 'string')
            return undefined;
        text += record.text;
    }
    return text;
}
function collectEntries(session) {
    const nodes = Array.from(session?.surface?.nodes ?? []);
    const entries = [];
    for (const seq of nodes) {
        let event;
        let message;
        try {
            event = session.eventAt?.(seq);
            if (!event)
                continue;
            message = session.deriveEventMessage(event);
        }
        catch {
            continue;
        }
        if (!message)
            continue;
        const content = message?.content;
        const contentHasToolCall = Array.isArray(content) && content.some((block) => block?.type === 'tool-call');
        const declaredToolCalls = (Array.isArray(message?.toolCalls) && message.toolCalls.length > 0) ||
            (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0);
        const hasToolCall = contentHasToolCall || declaredToolCalls;
        entries.push({
            seq,
            role: typeof message.role === 'string' ? message.role : String(event.type ?? 'other'),
            text: messageText(message),
            isError: event?.type === 'tool/result' && event?.data?.error !== undefined,
            sourceKind: typeof message?.source?.kind === 'string' ? message.source.kind : undefined,
            hasToolCall,
        });
    }
    return entries;
}
/**
 * 计算 surface replacement 需要声明遮蔽的节点集合。
 *
 * DSH 的会话加载器会校验：「被替换区间内每一个有消息的 surface 节点，都必须
 * 出现在 sourceEventSeqs 里」，否则整份日志被判为 corrupt
 * （SessionFormatError: replacement sourceEventSeqs omit a shadowed surface node）。
 * 折叠计划只含纯文本 assistant 消息，区间内仍可能夹着其它可投影节点，
 * 因此这里按事件真实类型重新收集，而不是沿用计划里的原始 seqs。
 */
function shadowedFoldSeqs(session, startSeq, endSeq, planned) {
    const nodes = Array.from(session?.surface?.nodes ?? []);
    const seqs = new Set(planned);
    for (const seq of nodes) {
        if (seq < startSeq || seq > endSeq || seqs.has(seq))
            continue;
        let message;
        try {
            message = session.eventAt && session.deriveEventMessage ? session.deriveEventMessage(session.eventAt(seq)) : undefined;
        }
        catch {
            message = undefined;
        }
        if (message)
            seqs.add(seq);
    }
    return [...seqs].sort((a, b) => a - b);
}
function applyFoldToSurface(session, patch, summary, seqs) {
    if (seqs.length === 0)
        return false;
    const startSeq = seqs[0];
    const endSeq = seqs[seqs.length - 1];
    const message = {
        id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role: 'user',
        content: [{ type: 'text', text: summary }],
        source: { kind: 'user' },
    };
    session.append('user/message', message, {
        surfaceOp: { op: 'replace', startSeq, endSeq },
        sourceEventSeqs: shadowedFoldSeqs(session, startSeq, endSeq, seqs),
    });
    return true;
}
function buildStatusTool(getStatus) {
    return {
        name: 'costkiller_status',
        description: 'Return dsh-context-manager token savings and runtime counters (savings panel data).',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    admitted: { type: 'number' },
                    extracted: { type: 'number' },
                    folds: { type: 'number' },
                    savedTokens: { type: 'number' },
                    rejectedByAnchor: { type: 'number' },
                    deduped: { type: 'number' },
                    savedByAdmission: { type: 'number' },
                    savedByExtraction: { type: 'number' },
                    savedByDedup: { type: 'number' },
                    savedByFold: { type: 'number' },
                    savedBySchema: { type: 'number' },
                    perRequestSavings: { type: 'number' },
                    eventSavings: { type: 'number' },
                    contextReduction: { type: 'number' },
                    estimatedCostTokens: { type: 'number' },
                    tokensBeforeTotal: { type: 'number' },
                    tokensAfterTotal: { type: 'number' },
                    workspaceCount: { type: 'number' },
                    schemaVersion: { type: 'number' },
                    ledgerId: { type: 'string' },
                    revision: { type: 'number' },
                    savingsFile: { type: 'string' },
                },
                required: [
                    'ok',
                    'admitted',
                    'extracted',
                    'folds',
                    'savedTokens',
                    'rejectedByAnchor',
                    'deduped',
                    'savedByAdmission',
                    'savedByExtraction',
                    'savedByDedup',
                    'savedByFold',
                    'savedBySchema',
                    'perRequestSavings',
                    'eventSavings',
                    'contextReduction',
                    'estimatedCostTokens',
                    'tokensBeforeTotal',
                    'tokensAfterTotal',
                    'workspaceCount',
                    'schemaVersion',
                    'ledgerId',
                    'revision',
                    'savingsFile',
                ],
                additionalProperties: false,
            },
            render: (value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: async () => getStatus(),
    };
}
function resolveConfig(raw) {
    const parsed = exports.Config.safeParse(raw ?? {});
    if (parsed.success)
        return parsed.data;
    (0, log_1.logEvent)('warn', 'config.invalid', { error: parsed.error.message });
    return exports.Config.parse({});
}
function apply(ctx, rawConfig = {}) {
    const config = resolveConfig(rawConfig);
    const services = ctx;
    const disposers = [];
    const counters = { admitted: 0, extracted: 0, folds: 0, savedTokens: 0, rejectedByAnchor: 0, deduped: 0 };
    let admissionRuns = 0;
    let lastRoutingKey = '';
    const sessions = new Map();
    const router = new routing_1.RoutingModule();
    const breaker = new breaker_1.CompressionBreaker({ name: 'extraction', failureThreshold: 3, cooldownMs: 10 * 60_000 });
    const dedup = new dedup_bus_1.DedupBus(256);
    const ledger = new savings_ledger_1.SavingsLedger();
    const savingsMarkdown = path.resolve(process.cwd(), 'savings.md');
    const savingsJson = path.resolve(process.cwd(), 'savings.json');
    let savingsTimer = null;
    const persistSavings = () => {
        try {
            fs.writeFileSync(savingsJson, JSON.stringify(ledger.snapshot(), null, 2), 'utf8');
            fs.writeFileSync(savingsMarkdown, ledger.renderMarkdown(), 'utf8');
        }
        catch {
            /* 面板写盘失败不影响主链路 */
        }
    };
    const scheduleSavings = () => {
        if (savingsTimer !== null)
            return;
        savingsTimer = setTimeout(() => {
            savingsTimer = null;
            persistSavings();
        }, 800);
    };
    const stateFor = (sessionId) => {
        let state = sessions.get(sessionId);
        if (!state) {
            state = { prefixHash: '', folds: 0, lastSentSeq: 0 };
            sessions.set(sessionId, state);
        }
        return state;
    };
    // 会话 -> 工作区映射：schema 压缩发生在 llm 层，只能靠 sessionId 反查。
    const sessionWorkspaces = new Map();
    const liveSession = (sessionId, fallback) => {
        try {
            const store = services.sessions;
            if (!store)
                return fallback;
            if (typeof store.get === 'function') {
                const fromStore = store.get(sessionId);
                if (fromStore)
                    return fromStore;
            }
            if (typeof store.list === 'function') {
                const listed = store.list();
                const items = Array.isArray(listed) ? listed : Array.from(listed ?? []);
                const found = items.find((item) => item?.header?.id === sessionId || item?.id === sessionId);
                if (found)
                    return found;
            }
        }
        catch {
            /* 服务不可用时回退到 hook 传入的实例 */
        }
        return fallback;
    };
    const workspaceFor = (session, agent) => (0, workspace_1.workspaceRefFromSession)(session, agent) ?? (0, workspace_1.workspaceRef)('(unknown)');
    (0, log_1.logEvent)('info', 'apply.start', { plugin: exports.name, config });
    try {
        const sectionDisposer = services.systemPrompt?.section?.({
            name: 'cost-killer:policy',
            order: 46,
            text: POLICY_TEXT,
        });
        if (typeof sectionDisposer === 'function')
            disposers.push(sectionDisposer);
    }
    catch (error) {
        (0, log_1.logEvent)('warn', 'systemPrompt.section.failed', { error: String(error) });
    }
    try {
        const toolDisposer = services.tools?.register?.(buildStatusTool(() => {
            const snapshot = ledger.snapshot();
            return {
                ok: true,
                admitted: counters.admitted,
                extracted: counters.extracted,
                folds: counters.folds,
                savedTokens: snapshot.totalSavedTokens,
                rejectedByAnchor: counters.rejectedByAnchor,
                deduped: counters.deduped,
                savedByAdmission: snapshot.byModule.admission,
                savedByExtraction: snapshot.byModule.extraction,
                savedByDedup: snapshot.byModule.dedup,
                savedByFold: snapshot.byModule.fold,
                savedBySchema: snapshot.byModule.schema,
                perRequestSavings: snapshot.perRequestSavings,
                eventSavings: snapshot.eventSavings,
                contextReduction: snapshot.contextReduction,
                estimatedCostTokens: snapshot.estimatedCostTokens,
                tokensBeforeTotal: snapshot.tokensBeforeTotal,
                tokensAfterTotal: snapshot.tokensAfterTotal,
                workspaceCount: Object.keys(snapshot.byWorkspace).length,
                schemaVersion: snapshot.schemaVersion,
                ledgerId: snapshot.ledgerId,
                revision: snapshot.revision,
                savingsFile: savingsMarkdown,
            };
        }));
        if (typeof toolDisposer === 'function')
            disposers.push(toolDisposer);
    }
    catch (error) {
        (0, log_1.logEvent)('warn', 'tools.register.failed', { error: String(error) });
    }
    // Schema 压缩依赖 llm 服务。真实 DSH 里 llm 可能挂在 agent 作用域而非 profile 根，
    // 因此既在根 ctx 上重试，也在首条 pre-step 的 payload.agent.loopCtx.llm 上补装。
    const pendingTimers = [];
    let schemaDisposer = null;
    const installSchema = (llm, source) => {
        if (schemaDisposer !== null)
            return true;
        if (!llm || typeof llm.stream !== 'function')
            return false;
        const dispose = (0, schema_index_1.installSchemaCompressor)({ llm, get: () => undefined }, {
            enabled: true,
            maxDescriptionChars: 120,
            onRequest: ({ sessionId, beforeTokens, afterTokens, savedTokens, toolsBeforeTokens }) => {
                const workspace = sessionWorkspaces.get(sessionId) ?? (0, workspace_1.workspaceRef)('(unknown)');
                ledger.recordRequestTokens(workspace, beforeTokens, afterTokens);
                if (savedTokens > 0) {
                    ledger.record('schema', savedTokens, 'tool schema descriptions', workspace, toolsBeforeTokens);
                }
                scheduleSavings();
            },
        });
        if (typeof dispose !== 'function')
            return false;
        schemaDisposer = dispose;
        disposers.push(dispose);
        (0, log_1.logEvent)('info', 'schema.installed', { source });
        return true;
    };
    const resolveRootLlm = () => {
        try {
            return services.llm ?? services.get?.('llm');
        }
        catch {
            return undefined;
        }
    };
    const tryInstallSchema = (attempt = 0) => {
        if (schemaDisposer !== null)
            return;
        if (installSchema(resolveRootLlm(), 'root'))
            return;
        if (attempt >= 40) {
            (0, log_1.logEvent)('warn', 'schema.unavailable', { attempts: attempt, hint: 'llm service not found on root ctx' });
            return;
        }
        const timer = setTimeout(() => tryInstallSchema(attempt + 1), 500);
        pendingTimers.push(timer);
    };
    tryInstallSchema();
    const installSchemaFromAgent = (agent) => {
        if (schemaDisposer !== null || !agent)
            return;
        let llm;
        try {
            llm = agent?.loopCtx?.llm ?? agent?.llm ?? agent?.ctx?.llm;
        }
        catch {
            return;
        }
        if (llm)
            installSchema(llm, 'agent');
    };
    const onPostExecute = async (exec, result, next) => {
        const decision = await next();
        try {
            if (decision?.kind !== 'accept' || Object.prototype.hasOwnProperty.call(decision, 'value'))
                return decision;
            const content = decision.content ?? result?.content;
            const text = flattenPlainText(content);
            if (text === undefined)
                return decision;
            let execSession;
            try {
                execSession = exec?.agent?.session;
            }
            catch {
                execSession = undefined;
            }
            const execSessionId = String((execSession && typeof execSession === 'object' && execSession.id) ||
                (typeof execSession === 'string' ? execSession : '') ||
                '');
            const workspace = workspaceFor(execSessionId ? liveSession(execSessionId, typeof execSession === 'object' ? execSession : undefined) : undefined, exec?.agent);
            // 去重总线：同一输出第二次出现时只留指针（最常见的是重复跑测试/构建/目录列表）。
            const dedupKeyValue = (0, dedup_bus_1.dedupeKey)(text);
            const dedupHit = dedup.hit(dedupKeyValue);
            if (dedupHit !== null && (0, contracts_1.estimateTokens)(text) > 100) {
                counters.deduped += 1;
                ledger.record('dedup', dedupHit.entry.tokens, 'duplicate tool output', workspace, dedupHit.entry.tokens);
                scheduleSavings();
                (0, log_1.logEvent)('info', 'dedup.hit', {
                    module: 'DedupBus',
                    tokensSaved: dedupHit.entry.tokens,
                    spillPath: dedupHit.entry.spillPath,
                });
                return { ...decision, content: [{ type: 'text', text: dedupHit.pointer }] };
            }
            const tokensBefore = (0, contracts_1.estimateTokens)(text);
            // 先做结构感知提纯（AST / JSON / 索引 / 分节），再做准入落盘；
            // 两者可叠加：压缩产物 + 原文指针同时保留，保证可逆。
            // 压缩器自身受 Breaker 保护：连续失败/零收益时跳过，避免死循环与无效算力。
            let extracted = null;
            if (breaker.canRun()) {
                extracted = (0, extraction_1.runExtraction)({ text, maxTokens: config.extractionTokens, budgetMs: config.compressionBudgetMs });
                if (!extracted.safe || (extracted.mode !== 'none' && extracted.tokensSaved <= 0)) {
                    breaker.recordFailure(extracted.reason ?? 'no-net-saving');
                }
                else if (extracted.mode !== 'none') {
                    breaker.recordSuccess();
                }
            }
            else {
                (0, log_1.logEvent)('warn', '[Breaker] skip compression', { module: 'Breaker', state: breaker.state, tool: exec?.tool?.name ?? 'unknown' });
            }
            // 上下文防火墙（v1.1 主杠杆）：超过 firewallTokens 的输出，若没有拿到
            // 结构化压缩（ast/json/index），一律改用「结构化摘要 + 落盘指针」。
            const weakExtraction = !extracted ||
                !extracted.safe ||
                extracted.mode === 'none' ||
                extracted.mode === 'head-tail' ||
                extracted.mode === 'section';
            if (weakExtraction && tokensBefore > config.firewallTokens) {
                const firewall = (0, extraction_1.buildFirewallSummary)(text, config.firewallTokens);
                const currentTokens = extracted && extracted.safe && extracted.mode !== 'none' ? extracted.tokensAfter : tokensBefore;
                if (firewall.text.length > 0 && firewall.text.length < text.length && firewall.tokens < currentTokens) {
                    extracted = {
                        text: firewall.text,
                        constraints: '',
                        safe: true,
                        mode: 'firewall',
                        tokensBefore: firewall.tokensBefore,
                        tokensAfter: firewall.tokens,
                        tokensSaved: Math.max(0, firewall.tokensBefore - firewall.tokens),
                        reason: 'firewall',
                    };
                    (0, log_1.logEvent)('info', 'firewall.summarized', {
                        module: 'Firewall',
                        tokensBefore: firewall.tokensBefore,
                        tokensAfter: firewall.tokens,
                        saved: extracted.tokensSaved,
                    });
                }
            }
            const compressed = extracted && extracted.safe && extracted.mode !== 'none' ? extracted.text : text;
            if (extracted && extracted.mode !== 'none' && extracted.safe)
                counters.extracted += 1;
            // 有损模式（AST / 索引 / 分节 / 头尾）必须强制落盘原文并附指针，保证可逆；
            // JSON 压缩只是去空白，属于无损，不需要额外指针。
            const lossy = extracted !== null && extracted.safe && extracted.mode !== 'none' && extracted.mode !== 'json';
            const admitted = (0, admission_1.runAdmission)(text, { maxInlineTokens: lossy ? 0 : config.admissionTokens, spillDir: config.spillDir });
            if (admitted.admitted)
                counters.admitted += 1;
            dedup.remember(dedupKeyValue, text, admitted.spilledTo);
            admissionRuns += 1;
            if (admissionRuns % 10 === 0) {
                const gc = (0, spill_gc_1.collectGarbage)({
                    dir: path.resolve(config.spillDir),
                    maxFiles: config.spillMaxFiles,
                    ttlMs: config.spillTtlHours * 60 * 60_000,
                });
                (0, log_1.logEvent)('info', 'spill.gc', {
                    module: 'SpillGc',
                    scanned: gc.scanned,
                    deleted: gc.deleted.length,
                    kept: gc.kept,
                    pinnedSkipped: gc.pinnedSkipped,
                    freedBytes: gc.freedBytes,
                });
            }
            const finalText = admitted.admitted
                ? compressed === text
                    ? admitted.text
                    : `${compressed}\n\n${admitted.text}`
                : compressed;
            const tokensAfter = (0, contracts_1.estimateTokens)(finalText);
            const saved = Math.max(0, tokensBefore - tokensAfter);
            counters.savedTokens += saved;
            // 分账口径：extraction 负责「原文 → 压缩文」，admission 负责「压缩文 → 指针化结果」，
            // 两者相加等于 saved，避免把落盘节省全部记到 extraction（面板 admission 一直是 0）。
            const extractionAfterTokens = (0, contracts_1.estimateTokens)(compressed);
            const extractionSaved = Math.max(0, tokensBefore - extractionAfterTokens);
            const admissionSaved = Math.max(0, extractionAfterTokens - tokensAfter);
            if (extractionSaved > 0) {
                ledger.record('extraction', extractionSaved, extracted?.mode ?? 'none', workspace, tokensBefore);
                scheduleSavings();
            }
            if (admissionSaved > 0) {
                ledger.record('admission', admissionSaved, 'spill', workspace, extractionAfterTokens);
                scheduleSavings();
            }
            (0, log_1.logEvent)('info', 'pipeline.tool_output', {
                module: 'Orchestrator',
                tool: exec?.tool?.name ?? exec?.name ?? 'unknown',
                tokensBefore,
                tokensAfter,
                saved,
                extractionMode: extracted?.mode ?? 'none',
                extractionSafe: extracted?.safe ?? true,
                lossy,
                admitted: admitted.admitted,
                spilledTo: admitted.spilledTo,
            });
            if (finalText === text)
                return decision;
            return { ...decision, content: [{ type: 'text', text: finalText }] };
        }
        catch (error) {
            (0, log_1.logEvent)('warn', 'postExecute.failed', { error: String(error) });
            return decision;
        }
    };
    const onPreStep = async (payload, next) => {
        const downstream = await next();
        try {
            if (!downstream || downstream.kind === 'reject')
                return downstream;
            installSchemaFromAgent(payload?.agent);
            let sessionRef;
            try {
                sessionRef = payload?.agent?.session;
            }
            catch {
                sessionRef = undefined;
            }
            const sessionId = String((sessionRef && typeof sessionRef === 'object' && sessionRef.id) ||
                (typeof sessionRef === 'string' ? sessionRef : '') ||
                'unknown');
            const live = liveSession(sessionId, typeof sessionRef === 'object' ? sessionRef : undefined);
            if (!live || typeof live.deriveMessages !== 'function')
                return downstream;
            const entries = collectEntries(live);
            if (entries.length === 0)
                return downstream;
            const workspace = workspaceFor(live, payload?.agent);
            if (!sessionWorkspaces.has(sessionId)) {
                sessionWorkspaces.set(sessionId, workspace);
                const hookCwd = (() => {
                    try {
                        return String(sessionRef?.cwd ?? '');
                    }
                    catch {
                        return '';
                    }
                })();
                const storeCwd = (() => {
                    try {
                        return String(live?.header?.cwd ?? '');
                    }
                    catch {
                        return '';
                    }
                })();
                (0, log_1.logEvent)('info', workspace.path === '(unknown)' ? 'workspace.unresolved' : 'workspace.resolved', {
                    sessionId,
                    workspace: workspace.path,
                    workspaceId: workspace.id,
                    label: workspace.label,
                    hookCwd,
                    storeCwd,
                });
            }
            const state = stateFor(sessionId);
            const tokens = entries.reduce((sum, entry) => sum + (0, contracts_1.estimateTokens)(entry.text), 0);
            const maxSeq = entries.reduce((max, entry) => (entry.seq > max ? entry.seq : max), 0);
            const previousSent = state.lastSentSeq;
            state.lastSentSeq = maxSeq;
            const threshold = Math.floor(config.maxInputTokens * config.foldAtRatio);
            if (tokens <= threshold)
                return downstream;
            // 角色感知：子代理（agent-message）上下文更窄，保留窗口收缩，避免把子任务历史永久带在主线。
            const lastUser = [...entries].reverse().find((entry) => entry.role === 'user');
            const roleAware = lastUser?.sourceKind === 'agent-message';
            const retainRecent = roleAware ? Math.max(2, config.retainRecent - 3) : config.retainRecent;
            if (roleAware) {
                (0, log_1.logEvent)('info', '[RoleAware] subagent context', {
                    module: 'RoleAware',
                    role: 'subagent',
                    retainRecent,
                    totalMessages: entries.length,
                });
            }
            const plan = (0, memory_1.planMemoryFold)(entries, { retainRecent, minSaveTokens: config.minSaveTokens });
            // 路由决策：以「压降后」的上下文规模为依据；<4000 且无跨文件依赖 → 强制本地。
            const routingTokens = Math.max(0, tokens - (plan.patch ? plan.tokensSaved : 0));
            const routingDecision = router.decide({
                prompt: lastUser?.text ?? '',
                contextTokens: routingTokens,
                crossFileDependency: (0, routing_1.hasCrossFileDependency)(entries.slice(-6).map((entry) => entry.text).join('\n')),
            });
            // 只在路由结果发生变化时记录，避免每步刷屏（生产日志体积控制）。
            const routingKey = `${routingDecision.route}:${routingDecision.reason}`;
            if (routingKey !== lastRoutingKey) {
                lastRoutingKey = routingKey;
                (0, log_1.logEvent)('info', 'routing.decision', {
                    module: 'Routing',
                    route: routingDecision.route,
                    reason: routingDecision.reason,
                    contextTokens: routingDecision.contextTokens,
                    tokensBefore: tokens,
                });
            }
            if (config.localRouting && routingDecision.route === 'local') {
                const routed = await router.attemptLocal(lastUser?.text ?? '');
                (0, log_1.logEvent)('info', 'routing.result', {
                    module: 'Routing',
                    route: routed.route,
                    degraded: routed.degraded,
                    latencyMs: routed.latencyMs,
                });
            }
            if (!plan.patch)
                return downstream;
            // 缓存语义：补丁若改到「已发送的 seq 区间」即破坏前缀；
            // 冷读代价只计从改写点开始往后需要重算的 token（前缀缓存命中的部分不受影响）。
            const firstFoldedSeq = plan.foldedSeqs[0] ?? Number.MAX_SAFE_INTEGER;
            const prefixBreak = previousSent > 0 && firstFoldedSeq <= previousSent;
            const cachedPrefixTokens = entries
                .filter((entry) => entry.seq >= firstFoldedSeq)
                .reduce((sum, entry) => sum + (0, contracts_1.estimateTokens)(entry.text), 0);
            (0, log_1.logEvent)('info', 'cache.penetration', {
                sessionId,
                firstFoldedSeq,
                previousSent,
                prefixBreak,
                cachedPrefixTokens,
            });
            // 寿命摊销：按“会话总回合预估 − 当前回合”估算剩余回合，供 CacheAnchor 折算。
            const remainingTurns = Math.max(0, Math.floor(config.assumedTurns - Number(payload?.turn ?? 0)));
            const decision = (0, cacheAnchor_1.gatePatch)({
                prefixBreak,
                cachedPrefixTokens,
                savedByCompression: plan.tokensSaved,
                savedBySchema: 0,
                recallPenalty: 0,
                expectedRemainingTurns: remainingTurns,
                contextTokens: tokens,
                patch: plan.patch,
            });
            (0, log_1.logEvent)('info', 'cache.decision', {
                sessionId,
                tokens,
                prefixBreak,
                approved: decision.approved,
                reason: decision.reason,
                netBenefit: decision.netBenefit,
                coldReadPenalty: decision.coldReadPenalty,
                patchId: decision.patchId,
                savedTokens: plan.tokensSaved,
                remainingTurns,
            });
            if (!decision.approved) {
                counters.rejectedByAnchor += 1;
                ledger.noteRejected();
                return downstream;
            }
            const envelope = (0, contracts_1.createEnvelope)({
                meta: { sessionId, turnId: String(payload?.turn ?? 0), targetModel: String(payload?.agent?.model ?? 'unknown'), timestamp: Date.now() },
                zones: {
                    staticZone: '',
                    dynamicZone: entries.slice(0, Math.max(0, entries.length - config.retainRecent)).map((entry) => entry.text),
                    liveZone: entries.slice(Math.max(0, entries.length - config.retainRecent)).map((entry) => entry.text),
                },
                budget: { maxInputTokens: config.maxInputTokens, maxOutputTokens: config.maxOutputTokens, currentEstimatedCost: 0 },
            });
            const nextEnvelope = (0, contracts_1.applyPatch)(envelope, plan.patch);
            if (nextEnvelope.ledger.savedByCompression <= 0)
                return downstream;
            applyFoldToSurface(live, plan.patch, plan.summary, plan.foldedSeqs);
            state.folds += 1;
            counters.folds += 1;
            ledger.record('fold', plan.tokensSaved, decision.patchId, workspace, plan.tokensBefore);
            ledger.noteFold(workspace);
            scheduleSavings();
            (0, log_1.logEvent)('info', 'memory.fold_applied', {
                sessionId,
                folds: state.folds,
                foldedMessages: plan.foldedMessages,
                savedTokens: plan.tokensSaved,
                ledger: nextEnvelope.ledger,
                digest: (0, contracts_1.hashText)(plan.summary).slice(0, 16),
            });
            return downstream;
        }
        catch (error) {
            (0, log_1.logEvent)('warn', 'preStep.failed', { error: String(error) });
            return downstream;
        }
    };
    try {
        const disposePost = services.on?.('tools/post-execute', onPostExecute);
        if (typeof disposePost === 'function')
            disposers.push(disposePost);
    }
    catch (error) {
        (0, log_1.logEvent)('warn', 'hook.postExecute.failed', { error: String(error) });
    }
    try {
        const disposePre = services.on?.('agent/pre-step', onPreStep);
        if (typeof disposePre === 'function')
            disposers.push(disposePre);
    }
    catch (error) {
        (0, log_1.logEvent)('warn', 'hook.preStep.failed', { error: String(error) });
    }
    (0, log_1.logEvent)('info', 'apply.ready', { plugin: exports.name, mode: 'full', routing: router.circuitOpen ? 'open' : 'closed' });
    return () => {
        (0, log_1.logEvent)('info', 'apply.dispose', { plugin: exports.name });
        if (savingsTimer !== null)
            clearTimeout(savingsTimer);
        savingsTimer = null;
        persistSavings();
        for (const timer of pendingTimers)
            clearTimeout(timer);
        pendingTimers.length = 0;
        for (const dispose of disposers.reverse()) {
            try {
                dispose();
            }
            catch { }
        }
        disposers.length = 0;
    };
}
