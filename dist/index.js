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
const effort_policy_1 = require("./modules/effort-policy");
const calibrate_1 = require("./modules/calibrate");
const schema_index_1 = require("./modules/schema-index");
const breaker_1 = require("./modules/breaker");
const dedup_bus_1 = require("./modules/dedup-bus");
const savings_ledger_1 = require("./modules/savings-ledger");
const billing_1 = require("./modules/billing");
const workspace_1 = require("./modules/workspace");
const history_rewriter_1 = require("./modules/history-rewriter");
const prefix_spill_1 = require("./modules/prefix-spill");
const episode_evict_1 = require("./modules/episode-evict");
const reasoning_drop_1 = require("./modules/reasoning-drop");
const response_cache_1 = require("./modules/response-cache");
const tool_pipe_1 = require("./modules/tool-pipe");
const pricing_1 = require("./modules/pricing");
exports.name = 'dsh-context-manager';
/**
 * 编码 Agent 的「工作原料」类工具：read / grep / glob / 编辑差异等。
 * 这些输出被摘要化会直接导致 Agent 读不到关键代码、改错行，因此原文透传。
 * 命令执行（pwsh/bash）与网络抓取不在其中——它们的日志才是压缩收益的主要来源。
 */
const SOURCE_READ_TOOLS = new Set([
    'read',
    'read_file',
    'readfile',
    'grep',
    'glob',
    'list_dir',
    'ls',
    'edit',
    'write',
    'str_replace_editor',
    'apply_patch',
    'search_tools',
    'read_ref',
]);
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
    /** 请求级历史重写（v1.2）：只改 messages 内容，不动 session surface。 */
    /**
     * 历史重写（有损）默认关闭 —— 真实账单决定的，不是口味问题。
     *
     * provider 缓存是前缀匹配：命中 ¥0.02/M、未命中 ¥1/M（差 50 倍）。重写把已经被
     * 请求过的旧消息改成更短的文本，等于把那段前缀作废，它后面的整段都要按 miss 价
     * 重算一次；而它换来的只是「后续每轮少读几千个 hit token」。实测：
     *   - 有重写（预算随 token 数漂移）：轮内命中率 24.2%；
     *   - 重写带来的省量按 hit 价折算，只有作废成本的十分之一量级。
     * 而且截断旧工具输出本身就是信息损失。所以默认关；需要主动压缩的用户可以显式打开。
     */
    rewriteEnabled: zod_1.z.boolean().default(false),
    rewriteRetainRecent: zod_1.z.number().int().positive().default(8),
    rewriteToolChars: zod_1.z.number().int().positive().default(700),
    rewriteAssistantChars: zod_1.z.number().int().positive().default(400),
    /**
     * 前缀无损折叠（v1.3）：把「最近 N 条之外」的旧工具结果整段落盘，上下文里只留
     * 「收据 + 绝对路径 + 头部摘要」。**不丢信息**（模型可 read 回来），因此默认开。
     * 实测一次请求里旧工具结果占 38.7%，而 hit 占账单 50.6%——这是目前最大的杠杆。
     */
    prefixSpillEnabled: zod_1.z.boolean().default(true),
    prefixSpillRetainRecent: zod_1.z.number().int().nonnegative().default(6),
    prefixSpillMinChars: zod_1.z.number().int().positive().default(600),
    /**
     * 旧 tool-call 参数折叠阈值。丢完老 thinking 之后参数成了最大单项（约占发出内容的
     * 45%），而模型真正需要的是「我调了什么工具」+「结果是什么」，不是当初那段长脚本文本。
     * 参数落盘后替换成合法 JSON 收据（_spilled/_chars/_head），id 与 name 原样保留。
     */
    prefixSpillHeadChars: zod_1.z.number().int().positive().default(100),
    /**
     * 已完成工具调用「整对逐出」（武器库 #14/#15）。
     *
     * 线上曾经害人（2026-11-11 15:00Z `INVALID_REQUEST: tool_use ... without
     * tool_result immediately after`）。重新启用前补了三道锁，全部可离线验证：
     *   1. 局部不变量：被逐出的调用必须**正好**是紧随其后的那段 tool 消息，
     *      于是「整段删」按归纳法不可能破坏全局配对；
     *   2. 全量配对校验：`assertToolPairing` 按「紧随其后」语义逐条核对；
     *   3. Fail-Closed：校验不过就返回**未改动**的消息表。
     * 离线回放（真实 2669 条消息 × 6 个窗口）全部 PASS，见 tools/replay-verify.mjs。
     */
    episodeEvictEnabled: zod_1.z.boolean().default(true),
    episodeEvictRetainRecent: zod_1.z.number().int().nonnegative().default(8),
    episodeEvictMinArgChars: zod_1.z.number().int().positive().default(600),
    /**
     * 丢掉「最近 N 条之外」的历史 thinking（约占前缀 1/3）。
     * auto：启动后先发两条一次性探针，只有对照组和删除组都成功才开启；denied/inconclusive
     * 一律保持关闭——thinking 契约违反会直接打断会话，不能拿它赌。
     */
    dropStaleReasoning: zod_1.z.enum(['auto', 'off']).default('auto'),
    dropStaleReasoningRetainRecent: zod_1.z.number().int().nonnegative().default(6),
    /** 精确哈希响应缓存（v1.2）：同一请求 5 分钟内直接重放。 */
    responseCacheEnabled: zod_1.z.boolean().default(true),
    responseCacheTtlMs: zod_1.z.number().int().positive().default(300_000),
    /** 输出端硬截断（v2.0）。 */
    /**
     * 输出端硬截断默认关闭 —— 它会**直接砍掉回答**，与「不降智」冲突。
     *
     * 现在的实现在「第一次 JSON 闭合」或「第一次代码块闭合」时立刻 return，
     * 于是「说明 + 第一段代码 + 第二段说明」这种正常回答会被截在第一个代码块之后。
     * 而且「客户端提前停止消费是否真的让 provider 少 decode」至今没有实盘验证
     * （见 STARTUP-PROMPT 的已知卡点 2），收益不确定、代价是确定的信息丢失。
     * 需要它的人可以显式打开。
     */
    outputGuardEnabled: zod_1.z.boolean().default(false),
    outputMaxTokens: zod_1.z.number().int().positive().default(1500),
    /** 语义缓存 Jaccard 阈值（v1.3）。 */
    semanticCacheThreshold: zod_1.z.number().min(0.5).max(1).default(0.85),
    /** 相似度语义复用（默认关）：会让「同一句话的第二轮」直接重放上一轮回答。 */
    semanticCacheEnabled: zod_1.z.boolean().default(false),
    /** TTL Keepalive（武器 30）：在 provider 缓存过期前重放前缀续命，避免跨轮首请求全价。 */
    keepaliveEnabled: zod_1.z.boolean().default(true),
    keepaliveTtlMs: zod_1.z.number().int().positive().default(240_000),
    keepaliveRefreshes: zod_1.z.number().int().min(0).max(24).default(4),
    keepaliveMinPromptTokens: zod_1.z.number().int().positive().default(500),
    /**
     * 动态 reasoning effort（默认开）。按本轮任务难度分配思考预算，只在不需要深思的
     * 地方省，绝不往上加。实测 reasoning 占输出 60.7%、输出占账单 67.1%。
     */
    dynamicEffortEnabled: zod_1.z.boolean().default(true),
    effortTrivial: zod_1.z.enum(['off', 'low', 'high', 'max']).default('off'),
    effortEasy: zod_1.z.enum(['off', 'low', 'high', 'max']).default('low'),
    effortNormal: zod_1.z.enum(['off', 'low', 'high', 'max']).default('high'),
    effortHard: zod_1.z.enum(['off', 'low', 'high', 'max']).default('max'),
    effortEscalateOnError: zod_1.z.boolean().default(false),
    /** 工具懒加载（v1.3）：只注入 top-K 完整 schema。 */
    /**
     * 动态工具集（Tool Attention 分层）默认关闭 —— 与 keepalive 直接冲突。
     *
     * 命中价 ¥0.02/M、未命中 ¥1/M（差 50 倍）。分层每轮按「最后一条用户消息」的意图桶
     * 重选 top-k，用户一说新话，工具表就变 -> 位于 prompt 最前面的 tools 一变，
     * **整段缓存作废**，这一轮按 miss 价重算全部 prompt。
     * 而它省下的只是工具 schema 的 token，而且是按 hit 价算的，量级差 50 倍。
     * 另外「只给一部分工具 + 让模型先 search_tools」本身也有选错工具的风险。
     * 需要它的用户可显式打开；schema 描述瘦身仍然生效，且是稳定的（同样的输入永远同样的输出）。
     */
    toolAttentionEnabled: zod_1.z.boolean().default(false),
    toolAttentionTopK: zod_1.z.number().int().positive().default(5),
    /** 本地 LLM 端点（v1.3 快速探测）。 */
    localBaseUrl: zod_1.z.string().default('http://127.0.0.1:11434'),
    /** 是否真正发起本地路由请求（决策与日志始终开启）。 */
    localRouting: zod_1.z.boolean().default(true),
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
    // 输出纪律：提高信息密度，不降低能力。省的是客套与复述，不是结论。
    'Output discipline: lead with the result. No preamble, no restating the request, no closing pleasantries, no summary of what you just did if the diff or output already shows it.',
    'Prefer minimal diffs, JSON, or tables over prose; include only the lines that changed and never print a whole file unless asked. Reasoning effort is sized per task, so spend tokens on the work, not on narration.',
    /**
     * 往返纪律：这是唯一一条「不降智反而更快」的省钱规则。
     *
     * 实测：本会话 1,087 个带工具调用的 step 里 1,045 个（96.1%）只发 1 个调用。
     * 每次 step 都要把整段前缀按缓存价重读一遍（≈¥0.0034），所以请求数本身就是账单，
     * 而它跟回答质量毫无关系。把互相独立的调用放进同一条消息，是纯赚。
     */
    'Round-trip discipline: when several tool calls are independent (different files, different commands, different queries), issue them in ONE message instead of one per message. Every round trip re-reads the whole prefix, so batching is both faster and cheaper. Never batch calls that depend on each other\'s output.',
    'Folded history uses [SPILL] receipts: when only the file name is given, it is under the spill directory stated above — read it if you need the original.',
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
        // thinking / reasoning 块：DeepSeek thinking 模式要求原样回传，任何折叠都会让整轮
        // 直接 INVALID_REQUEST（实测 2026-11-11 20:32）。这里把它标出来，供折叠排除。
        const hasThinking = Array.isArray(content) &&
            content.some((block) => block?.type === 'reasoning' || block?.type === 'thinking') ||
            (message?.thinking !== undefined && message?.thinking !== null);
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
            hasThinking,
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
                    /**
                     * 真实账单必须在这里声明完整：
                     * 宿主按 `additionalProperties: false` 校验工具返回值，少声明一个字段
                     * 整个工具就报 `returned invalid output`（实盘踩到：realBilling/realBillFile/
                     * debugLogFile 三个字段漏声明，costkiller_status 直接不可用）。
                     */
                    realBilling: {
                        type: 'object',
                        properties: {
                            requests: { type: 'number' },
                            currency: { type: 'string' },
                            actualCost: { type: 'number' },
                            counterfactualCost: { type: 'number' },
                            savedCost: { type: 'number' },
                            reduction: { type: 'number' },
                            cacheHitRate: { type: 'number' },
                            missTokens: { type: 'number' },
                            hitTokens: { type: 'number' },
                            outputTokens: { type: 'number' },
                            unverifiedOutputTokens: { type: 'number' },
                            lastPricing: {
                                type: 'object',
                                properties: {
                                    tier: { type: 'string' },
                                    window: { type: 'string' },
                                    hit: { type: 'number' },
                                    miss: { type: 'number' },
                                    output: { type: 'number' },
                                },
                                required: ['tier', 'window', 'hit', 'miss', 'output'],
                                additionalProperties: false,
                            },
                        },
                        required: [
                            'requests',
                            'currency',
                            'actualCost',
                            'counterfactualCost',
                            'savedCost',
                            'reduction',
                            'cacheHitRate',
                            'missTokens',
                            'hitTokens',
                            'outputTokens',
                            'unverifiedOutputTokens',
                            'lastPricing',
                        ],
                        additionalProperties: false,
                    },
                    realBillFile: { type: 'string' },
                    debugLogFile: { type: 'string' },
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
                    'realBilling',
                    'realBillFile',
                    'debugLogFile',
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
    const router = new routing_1.RoutingModule({ baseUrl: config.localBaseUrl, timeoutMs: 1500 });
    const breaker = new breaker_1.CompressionBreaker({ name: 'extraction', failureThreshold: 3, cooldownMs: 10 * 60_000 });
    const dedup = new dedup_bus_1.DedupBus(256);
    const ledger = new savings_ledger_1.SavingsLedger();
    const billing = new billing_1.BillingLedger();
    const responseCache = new response_cache_1.ResponseCache({
        ttlMs: config.responseCacheTtlMs,
        // 默认关闭语义复用（不降智）：见 ResponseCache.findSimilar 的说明。
        semanticReuse: config.semanticCacheEnabled,
        similarityThreshold: config.semanticCacheThreshold,
    });
    const toolPipe = new tool_pipe_1.ToolPipe(path.resolve(config.spillDir));
    const toolSchemas = new Map();
    let localAvailable = false;
    const probeLocal = async () => {
        try {
            const response = await fetch(`${config.localBaseUrl.replace(/\/+$/, '')}/api/tags`, {
                signal: AbortSignal.timeout(500),
            });
            localAvailable = response.ok;
        }
        catch {
            localAvailable = false;
        }
        (0, log_1.logEvent)('info', localAvailable ? 'routing.local_available' : 'routing.local_unavailable', {
            module: 'Routing',
            baseUrl: config.localBaseUrl,
        });
    };
    if (config.localRouting)
        void probeLocal();
    const savingsMarkdown = path.resolve(process.cwd(), 'savings.md');
    const savingsJson = path.resolve(process.cwd(), 'savings.json');
    const realBillMarkdown = path.resolve(process.cwd(), 'real-bill.md');
    // 跨重启延续累计：上一轮写下的 savings.json 若仍是 v5 结构，按工作区恢复。
    try {
        if (fs.existsSync(savingsJson)) {
            const previous = JSON.parse(fs.readFileSync(savingsJson, 'utf8'));
            if (ledger.restore(previous)) {
                (0, log_1.logEvent)('info', 'savings.restored', {
                    module: 'SavingsLedger',
                    workspaces: Object.keys(previous.byWorkspace ?? {}).length,
                    totalSavedTokens: Number(previous.totalSavedTokens ?? 0),
                    startedAt: previous.startedAt,
                });
            }
        }
    }
    catch (error) {
        (0, log_1.logEvent)('warn', 'savings.restore_failed', { module: 'SavingsLedger', error: String(error) });
    }
    let savingsTimer = null;
    const persistSavings = () => {
        try {
            const bill = billing.snapshot();
            // realBill 是 Gate 1 的唯一可信口径：全部来自 provider usage，不含估算。
            const snapshot = {
                ...ledger.snapshot({
                    hit: (0, pricing_1.priceFor)('deepseek-flash').hit,
                    miss: (0, pricing_1.priceFor)('deepseek-flash').miss,
                    // 实测缓存命中率：金额折算按它加权命中价/未命中价，而非按模块猜。
                    cacheHitRate: bill.cacheHitRate,
                }),
            };
            snapshot.realBill = bill;
            fs.writeFileSync(savingsJson, JSON.stringify(snapshot, null, 2), 'utf8');
            fs.writeFileSync(savingsMarkdown, `${ledger.renderMarkdown()}\n\n${billing.renderMarkdown()}`, 'utf8');
            fs.writeFileSync(realBillMarkdown, billing.renderMarkdown(), 'utf8');
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
    /**
     * 当前正在进行的这一轮（由 pre-step 写入、onUsage 读取）。
     * 金额必须记到「产生这一轮的工作区」上，而不是全局汇总后再摊派。
     */
    let activeTurn = null;
    /** 最近一次 pre-step 的观测信号，供 prepareCall 前判定 reasoning effort。 */
    let effortContext = null;
    /**
     * 最近一次 effort 决策（供真实账本把 effort 杠杆折算成反事实成本）。
     * 不带时间戳过期：一次真实请求从决策到收到 usage 可能超过 10 秒（实测 1.3–5.6s，
     * 长上下文更久），用 TTL 判活会把 effort 记成 null，输出侧杠杆在账本里直接归零
     * （实测 7 条记录里 5 条 effort:null）。改为「按轮次失效」：pre-step 更新
     * effortContext 时一并清空，跨轮不会串味。
     */
    let lastEffort = null;
    /**
     * 是否允许丢掉老 thinking。默认 false，只有启动探针拿到 'allowed' 才置 true。
     * 见 modules/reasoning-drop.ts：违反 thinking 回传契约会直接打断会话。
     */
    let staleReasoningAllowed = false;
    /** 探针每次进程只跑一次（重载插件不重复花钱）。 */
    let staleReasoningProbed = false;
    /**
     * 用户配置的 reasoning effort —— 只作为「不得超越」的上限。
     * 不能拿上游传进来的 reasoningEffort 当上限：宿主会把我们上一轮写进 config 的
     * 结果写回会话 header，下一轮再当 requested 传回来，于是形成单向棘轮（实测踩到）。
     */
    const effortBaseline = () => {
        try {
            const selection = services.get?.('agentDefaultModel')?.currentSelection?.();
            const effort = selection?.reasoningEffort ?? selection?.controls?.reasoningEffort ?? selection?.config?.reasoningEffort;
            if (effort)
                return { effort, source: 'agentDefaultModel' };
        }
        catch {
            /* 服务不可用就退回默认上限 */
        }
        return { effort: undefined, source: 'default-max' };
    };
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
    (0, log_1.logEvent)('info', 'apply.start', { plugin: exports.name, debugLog: log_1.LOG_FILE_PATH, cwd: process.cwd(), config });
    (0, log_1.logEvent)('info', 'pricing.loaded', (0, pricing_1.pricingLoadedLog)((0, pricing_1.priceFor)('deepseek-flash')));
    try {
        const sectionDisposer = services.systemPrompt?.section?.({
            name: 'cost-killer:policy',
            order: 46,
            text: config.prefixSpillEnabled
                ? `${POLICY_TEXT} the directory is ${path.resolve(config.spillDir)}`
                : POLICY_TEXT,
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
            const real = billing.snapshot();
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
                // 真实账单：只用 provider usage × 官方单价，estimates 上面那些字段不是验收口径。
                realBilling: {
                    requests: real.requests,
                    currency: real.currency,
                    actualCost: Number(real.actualCost.toFixed(6)),
                    counterfactualCost: Number(real.counterfactualCost.toFixed(6)),
                    savedCost: Number(real.savedCost.toFixed(6)),
                    reduction: Number((real.reduction * 100).toFixed(2)),
                    cacheHitRate: Number((real.cacheHitRate * 100).toFixed(2)),
                    missTokens: real.missTokens,
                    hitTokens: real.hitTokens,
                    outputTokens: real.outputTokens,
                    unverifiedOutputTokens: real.unverifiedOutputTokens,
                    // 没有请求时账本里 lastPricing 是 null；这里给一个形状稳定的默认值，
                    // 免得工具声明的 schema 和实际返回对不上（宿主按 additionalProperties:false 校验）。
                    lastPricing: {
                        tier: String(real.lastPricing?.tier ?? 'unknown'),
                        window: String(real.lastPricing?.window ?? 'offpeak'),
                        hit: Number(real.lastPricing?.hit ?? 0),
                        miss: Number(real.lastPricing?.miss ?? 0),
                        output: Number(real.lastPricing?.output ?? 0),
                    },
                },
                realBillFile: realBillMarkdown,
                debugLogFile: log_1.LOG_FILE_PATH,
                savingsFile: savingsMarkdown,
            };
        }));
        if (typeof toolDisposer === 'function')
            disposers.push(toolDisposer);
    }
    catch (error) {
        (0, log_1.logEvent)('warn', 'tools.register.failed', { error: String(error) });
    }
    // v1.3：search_tools 元工具，供模型按需拉取被懒加载隐藏的工具 schema。
    try {
        const searchDisposer = services.tools?.register?.({
            name: 'search_tools',
            description: 'Return the full JSON schema of tools hidden by lazy loading. Query by tool name or keywords.',
            parameters: {
                query: { type: 'string', description: 'tool name or keywords', required: true },
            },
            output: {
                schema: {
                    type: 'object',
                    properties: { ok: { type: 'boolean' }, tools: { type: 'string' } },
                    required: ['ok', 'tools'],
                    additionalProperties: false,
                },
                render: (value) => [{ type: 'text', text: String(value?.tools ?? '') }],
            },
            execute: async (exec) => {
                const query = String(exec?.parameters?.query ?? exec?.query ?? '').toLowerCase();
                const matches = [...toolSchemas.values()]
                    .filter((tool) => {
                    if (!query)
                        return false;
                    return (String(tool.name ?? '').toLowerCase().includes(query) ||
                        String(tool.description ?? '').toLowerCase().includes(query));
                })
                    .slice(0, 5);
                return {
                    ok: matches.length > 0,
                    tools: matches.length > 0 ? JSON.stringify(matches) : `no tool matched "${query}"`,
                };
            },
        });
        if (typeof searchDisposer === 'function')
            disposers.push(searchDisposer);
    }
    catch (error) {
        (0, log_1.logEvent)('warn', 'search_tools.register.failed', { error: String(error) });
    }
    // v2.0：ToolPipe 数据平面——按 [PIPE] ref 取回落盘原文。
    try {
        const pipeDisposer = services.tools?.register?.({
            name: 'read_ref',
            description: 'Read the full content of a spilled tool result by its [PIPE] ref (e.g. pipe-1a2b3c4d5e6f).',
            parameters: {
                ref: { type: 'string', description: 'PIPE reference', required: true },
            },
            output: {
                schema: {
                    type: 'object',
                    properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
                    required: ['ok', 'text'],
                    additionalProperties: false,
                },
                render: (value) => [{ type: 'text', text: String(value?.text ?? '') }],
            },
            execute: async (exec) => {
                const ref = String(exec?.parameters?.ref ?? exec?.ref ?? '');
                const result = toolPipe.resolve(ref);
                (0, log_1.logEvent)('info', 'toolpipe.read', { module: 'ToolPipe', ref, ok: result.ok, bytes: result.bytes });
                return { ok: result.ok, text: result.text.slice(0, 20000) };
            },
        });
        if (typeof pipeDisposer === 'function')
            disposers.push(pipeDisposer);
    }
    catch (error) {
        (0, log_1.logEvent)('warn', 'read_ref.register.failed', { error: String(error) });
    }
    // Schema 压缩依赖 llm 服务。真实 DSH 里 llm 可能挂在 agent 作用域而非 profile 根，
    // 因此既在根 ctx 上重试，也在首条 pre-step 的 payload.agent.loopCtx.llm 上补装。
    const pendingTimers = [];
    let schemaDisposer = null;
    /**
     * 一次性测量仪器：状态目录里有 calibrate.flag 时，用未打补丁的原始 stream
     * 对同一批 prompt 分别跑 max/high/low/off，量出真实的 output token 折算率。
     * 跑完删掉 flag，失败只记日志，绝不影响宿主。
     */
    const maybeCalibrate = (rawStream) => {
        const flag = path.resolve(process.cwd(), 'calibrate.flag');
        try {
            if (!fs.existsSync(flag))
                return;
            fs.rmSync(flag, { force: true });
        }
        catch {
            return;
        }
        void (async () => {
            try {
                const selection = services.get?.('agentDefaultModel')?.currentSelection?.();
                const provider = String(selection?.provider ?? 'deepseek-account');
                const model = String(selection?.model ?? 'deepseek-flash');
                const samples = await (0, calibrate_1.runCalibration)(rawStream, { provider, model, efforts: ['max', 'high', 'low', 'off'], maxTokens: 4000 });
                (0, log_1.logEvent)('info', 'calibration.result', { module: 'Calibration', provider, model, samples, summary: (0, calibrate_1.summarize)(samples) });
            }
            catch (error) {
                (0, log_1.logEvent)('warn', 'calibration.failed', { module: 'Calibration', error: String(error) });
            }
        })();
    };
    const installSchema = (llm, source) => {
        if (schemaDisposer !== null)
            return true;
        if (!llm || typeof llm.stream !== 'function')
            return false;
        // 打补丁前先抓住原始 stream，供校准使用（必须绕过本插件，才量得到真实模型行为）。
        const rawStream = llm.stream.bind(llm);
        /**
         * 一次性契约探针：只有在「保留 thinking 的对照组」和「删掉老 thinking 的实验组」
         * 都成功时，才允许后续请求丢弃老 thinking。两条都是极短请求（maxTokens 8）。
         * 失败一律按不允许处理 —— 省钱的收益远小于一次 `content[].thinking` 报错的代价。
         */
        /**
         * 先吃落盘裁决：探针是异步的，如果每个进程都重新探，启动后最初几秒发出的
         * 请求会带着「未剥离」的历史，与之后「已剥离」的历史字节不同 ——
         * 那几条请求白付一次全量前缀，剥离一生效前缀又当场作废，再冷读一次。
         * 实测每次重启因此多付 miss 54,949（≈¥0.055），命中率被压到 98%。
         */
        const probeFile = path.resolve(config.spillDir, '.reasoning-probe.json');
        const probeKey = (0, reasoning_drop_1.probeCacheKey)('deepseek-account', 'deepseek-flash');
        if (config.dropStaleReasoning === 'auto' && !staleReasoningProbed) {
            const cached = (0, reasoning_drop_1.readProbeCache)(probeFile, probeKey);
            if (cached) {
                staleReasoningProbed = true;
                staleReasoningAllowed = cached.verdict === 'allowed';
                (0, log_1.logEvent)('info', 'reasoning.probe_cached', {
                    module: 'ReasoningDrop',
                    verdict: cached.verdict,
                    at: cached.at,
                });
            }
        }
        if (config.dropStaleReasoning === 'auto' && !staleReasoningProbed && process.env.CK_DISABLE_REASONING_PROBE !== '1') {
            staleReasoningProbed = true;
            void (0, reasoning_drop_1.probeStaleReasoning)((request) => rawStream(request), {
                provider: 'deepseek-account',
                model: 'deepseek-flash',
            })
                .then((result) => {
                staleReasoningAllowed = result.verdict === 'allowed';
                // 只有明确的 allowed/denied 才缓存；inconclusive 不缓存，下次重启重探。
                if (result.verdict !== 'inconclusive') {
                    (0, reasoning_drop_1.writeProbeCache)(probeFile, {
                        key: probeKey,
                        verdict: result.verdict,
                        control: result.control,
                        stripped: result.stripped,
                        at: new Date().toISOString(),
                    });
                }
                (0, log_1.logEvent)('info', 'reasoning.probe', {
                    module: 'ReasoningDrop',
                    verdict: result.verdict,
                    control: result.control,
                    stripped: result.stripped,
                    error: result.error ? result.error.slice(0, 200) : undefined,
                });
            })
                .catch(() => undefined);
        }
        const dispose = (0, schema_index_1.installSchemaCompressor)({ llm, get: () => undefined }, {
            enabled: true,
            maxDescriptionChars: 120,
            rewriteHistory: config.prefixSpillEnabled
                ? (messages) => {
                    /**
                     * 前缀无损折叠：旧工具结果整段落盘，上下文只留「收据 + 绝对路径 + 摘要」。
                     * 实测一次请求的 650K 字符预算里旧工具结果占 251K（38.7%），而它们每个
                     * 请求都要按缓存价重读一遍（hit 占账单 50.6%）。落盘后可读回，不丢信息。
                     *
                     * 必须先于 rewriteMessages：后者会按字符截断，一旦先截断就没法再落盘了。
                     */
                    /**
                     * 逐出必须先于折叠：折叠会把工具结果换成收据，那样落盘的 episode 里
                     * 就只剩收据而不是原文了。
                     */
                    const evicted = config.episodeEvictEnabled
                        ? (0, episode_evict_1.evictOldEpisodes)(Array.isArray(messages) ? messages : [], {
                            spillDir: config.spillDir,
                            retainRecent: config.episodeEvictRetainRecent,
                            minArgChars: config.episodeEvictMinArgChars,
                        })
                        : { messages: Array.isArray(messages) ? messages : [], stats: null };
                    const folded = (0, prefix_spill_1.foldOldToolResults)(evicted.messages, {
                        spillDir: config.spillDir,
                        retainRecent: config.prefixSpillRetainRecent,
                        minChars: config.prefixSpillMinChars,
                        headChars: config.prefixSpillHeadChars,
                    });
                    const finish = (next) => {
                        if (config.rewriteEnabled) {
                            // 固定预算（只取配置值）：重写结果必须是「消息内容」的纯函数。
                            return (0, history_rewriter_1.rewriteMessages)(next, {
                                retainRecent: config.rewriteRetainRecent,
                                assistantChars: config.rewriteAssistantChars,
                                toolChars: config.rewriteToolChars,
                            });
                        }
                        return {
                            messages: next,
                            beforeTokens: (0, contracts_1.estimateTokens)(JSON.stringify(messages)),
                            afterTokens: (0, contracts_1.estimateTokens)(JSON.stringify(next)),
                            /**
                             * 必须是「实测 token 差」，不能是字符差。
                             *
                             * 旧实现给的是 `charsBefore - charsAfter`（字符），而账本拿它当 token 用，
                             * 同一行里 beforeTokens 又是 token —— 单位混用把降幅放大 4 倍，
                             * 面板因此显示 52%~66%，而实测只有 28.5%。
                             * 而且它只算了 fold 一项，strip/evict 省下的没进去。
                             * 现在直接量「改前 token − 改后 token」，三个杠杆一次性覆盖。
                             */
                            saved: Math.max(0, (0, contracts_1.estimateTokens)(JSON.stringify(messages)) - (0, contracts_1.estimateTokens)(JSON.stringify(next))),
                            rewritten: folded.stats.folded,
                        };
                    };
                    /**
                     * 老 thinking 只在探针判定 allowed 之后才丢（默认 false，见 reasoning-drop.ts）：
                     * 违反 thinking 回传契约会直接打断会话，不能拿它赌。
                     */
                    const stripStats = staleReasoningAllowed
                        ? (0, reasoning_drop_1.stripStaleReasoning)(folded.messages, config.dropStaleReasoningRetainRecent)
                        : null;
                    const next = stripStats ? stripStats.messages : folded.messages;
                    /**
                     * 折叠与剥 thinking 的真实结果必须落日志。
                     * 之前只有 `removedPromptTokens` 一个汇总数，看不出剥 thinking 到底有没有生效
                     * （`payloadChars` 一直停在 680K，而预测应到 172K），只能靠猜。
                     * 现在把 role 直方图、块类型直方图、两边各省多少一起打出来。
                     *
                     * 2026-11-11 14:16Z 实测结果：fold 省 266,033 字符、strip 省 541,092 字符，
                     * 两者合计把 ~1.59M 压到 ~783K。所以两个杠杆都在工作，之前的「strip 失效」
                     * 是我用错误基数的算术误判。
                     *
                     * 现在再加 **按字符数的构成**：只剩体积才能看出还能砍哪一块。
                     * `sent` 是压缩后真正发出去的，`roleChars` / `blockChars` 都是它的分解。
                     */
                    const roleChars = {};
                    const blockChars = {};
                    let sentChars = 0;
                    for (const message of next) {
                        const role = String(message?.role ?? '?');
                        const content = message?.content;
                        const size = typeof content === 'string' ? content.length : JSON.stringify(content ?? '').length;
                        roleChars[role] = (roleChars[role] ?? 0) + size;
                        sentChars += size;
                        if (Array.isArray(content)) {
                            for (const block of content) {
                                const type = String(block?.type ?? '?');
                                const inner = typeof block?.text === 'string'
                                    ? block.text.length
                                    : JSON.stringify(block?.arguments ?? block ?? '').length;
                                blockChars[type] = (blockChars[type] ?? 0) + inner;
                            }
                        }
                        else if (typeof content === 'string') {
                            blockChars['plain-string'] = (blockChars['plain-string'] ?? 0) + content.length;
                        }
                    }
                    if (folded.stats.folded > 0 || stripStats || staleReasoningAllowed || evicted.stats) {
                        (0, log_1.logEvent)('debug', 'history.fold', {
                            module: 'PrefixSpill',
                            messages: Array.isArray(messages) ? messages.length : 0,
                            evictedEpisodes: evicted.stats ? evicted.stats.episodes : 0,
                            evictSaved: evicted.stats ? evicted.stats.charsSaved : 0,
                            evictDropped: evicted.stats ? evicted.stats.droppedMessages : 0,
                            evictRejected: evicted.stats ? evicted.stats.rejected === true : false,
                            foldCharsSaved: folded.stats.charsBefore - folded.stats.charsAfter,
                            folded: folded.stats.folded,
                            stripAllowed: staleReasoningAllowed,
                            stripCharsSaved: stripStats ? stripStats.charsSaved : 0,
                            stripped: stripStats ? stripStats.stripped : 0,
                            sentChars,
                            roleChars,
                            blockChars,
                        });
                    }
                    return finish(next);
                }
                : undefined,
            responseCache: config.responseCacheEnabled ? responseCache : undefined,
            onCacheHit: () => (0, log_1.logEvent)('info', 'cache.response_hit', responseCache.stats()),
            onSemanticHit: (score) => (0, log_1.logEvent)('info', 'cache.semantic_hit', { score, ...responseCache.stats() }),
            outputGuard: { enabled: config.outputGuardEnabled, maxTokens: config.outputMaxTokens },
            /**
             * reasoning effort 必须在宿主冻结 call config **之前** 改。
             * 用的就是宿主自己的 `ConfigureCall` 钩子（prepareCall 的第三个参数），
             * 而不是事后改 request —— 后者会触发 INVALID_PREPARED_CALL。
             */
            configureControls: (controls, model) => {
                if (!config.dynamicEffortEnabled || effortContext === null)
                    return controls;
                const requested = controls?.reasoningEffort ?? model?.reasoning?.defaultEffort;
                const baseline = effortBaseline();
                const decision = (0, effort_policy_1.decideEffort)({
                    messages: (0, effort_policy_1.syntheticMessages)(effortContext),
                    requested,
                    baseline: baseline.effort,
                    policy: {
                        enabled: config.dynamicEffortEnabled,
                        trivial: config.effortTrivial,
                        easy: config.effortEasy,
                        normal: config.effortNormal,
                        hard: config.effortHard,
                        escalateOnError: config.effortEscalateOnError,
                    },
                });
                lastEffort = { effort: String(decision.effort), baseline: String(baseline.effort ?? 'max') };
                if (!decision.effort || decision.effort === decision.requested)
                    return controls;
                (0, log_1.logEvent)('info', 'effort.decided', {
                    module: 'EffortPolicy',
                    scope: 'configureCall',
                    tier: decision.tier,
                    baseline: String(baseline.effort ?? 'max'),
                    baselineSource: baseline.source,
                    from: decision.requested,
                    to: decision.effort,
                    effortSource: requested === undefined ? 'assumed-max' : 'request',
                    reason: decision.reason,
                    escalated: decision.escalated,
                });
                return { ...controls, reasoningEffort: decision.effort };
            },
            resolveEffort: (request) => {
                const requested = request?.reasoningEffort ?? request?.config?.reasoningEffort;
                const baseline = effortBaseline();
                const decision = (0, effort_policy_1.decideEffort)({
                    messages: request?.messages,
                    requested,
                    baseline: baseline.effort,
                    policy: {
                        enabled: config.dynamicEffortEnabled,
                        trivial: config.effortTrivial,
                        easy: config.effortEasy,
                        normal: config.effortNormal,
                        hard: config.effortHard,
                        escalateOnError: config.effortEscalateOnError,
                    },
                });
                lastEffort = { effort: String(decision.effort), baseline: String(baseline.effort ?? 'max') };
                if (decision.effort === decision.requested)
                    return null;
                (0, log_1.logEvent)('info', 'effort.decided', {
                    module: 'EffortPolicy',
                    sessionId: request?.sessionId ?? 'unknown',
                    tier: decision.tier,
                    baseline: String(baseline.effort ?? 'max'),
                    baselineSource: baseline.source,
                    from: decision.requested,
                    to: decision.effort,
                    effortSource: requested === undefined ? 'assumed-max' : 'request',
                    reason: decision.reason,
                    escalated: decision.escalated,
                });
                return { effort: decision.effort };
            },
            keepalive: {
                enabled: config.keepaliveEnabled,
                ttlMs: config.keepaliveTtlMs,
                refreshes: config.keepaliveRefreshes,
                minPromptTokens: config.keepaliveMinPromptTokens,
            },
            onOutputTruncated: (reason) => (0, log_1.logEvent)('info', 'output.truncated', { module: 'OutputGuard', reason, maxTokens: config.outputMaxTokens }),
            toolAttention: { enabled: config.toolAttentionEnabled, topK: config.toolAttentionTopK },
            effortContext: () => (lastEffort ? { effort: lastEffort.effort, baseline: lastEffort.baseline } : null),
            onUsage: ({ purpose, model, usage, beforeChars, afterChars, effort, baselineEffort }) => {
                const record = billing.record({ purpose, model, usage, beforeChars, afterChars, effort, baselineEffort });
                if (record) {
                    // 逐轮把这一轮的金额写进账本：命中率与峰谷价都是该轮自身的实测值，
                    // 汇总时只做加法，不做「平均单价 × 总 token」这种事后折算。
                    ledger.recordTurn(activeTurn?.workspace, {
                        savedCny: record.savedCost,
                        savedHitTokens: record.savedHitTokens,
                        savedMissTokens: record.savedMissTokens,
                        hitRate: record.hitRate,
                        window: record.window,
                    });
                }
                if (record)
                    (0, log_1.logEvent)('debug', 'billing.recorded', {
                        module: 'Billing',
                        purpose: record.purpose,
                        model: record.model,
                        window: record.window,
                        missTokens: record.missTokens,
                        hitTokens: record.hitTokens,
                        outputTokens: record.outputTokens,
                        removedPromptTokens: record.removedPromptTokens,
                        avoidedOutputTokens: record.avoidedOutputTokens,
                        effort: effort ?? null,
                        baselineEffort: baselineEffort ?? null,
                        /** 本次请求模型可见载荷的字符数：用来离线区分「新增内容」与「缓存浪费」。 */
                        payloadChars: afterChars,
                        actualCost: Number(record.actualCost.toFixed(6)),
                        savedCost: Number(record.savedCost.toFixed(6)),
                    });
                scheduleSavings();
            },
            onToolCatalog: (tools) => {
                toolSchemas.clear();
                for (const tool of tools)
                    toolSchemas.set(tool.name, tool);
            },
            onRequest: ({ sessionId, beforeTokens, afterTokens, savedTokens, toolsBeforeTokens, rewriteSaved, rewriteBeforeTokens, rewriteAfterTokens, }) => {
                const workspace = sessionWorkspaces.get(sessionId) ?? (0, workspace_1.workspaceRef)('(unknown)');
                // 每个请求都会经过这里，是最可靠的「本轮属于哪个工作区」的锚点。
                activeTurn = { workspace, sessionId, startedAt: Date.now() };
                ledger.recordRequestTokens(workspace, beforeTokens, afterTokens, sessionId);
                if (savedTokens > 0) {
                    ledger.record('schema', savedTokens, 'tool schema descriptions', workspace, toolsBeforeTokens);
                }
                if ((rewriteSaved ?? 0) > 0) {
                    // 归到 fold（上下文缩减）桶：这是「历史被压掉多少」，不是抽取。
                    // 之前记成 extraction，导致面板把 fold/reasoning-drop/episode-evict 全算成
                    // "extraction"，而 fold 行永远是 0 —— 数字是真的，归属是错的。
                    ledger.record('rewrite', rewriteSaved, 'history-rewrite', workspace, rewriteBeforeTokens);
                    (0, log_1.logEvent)('info', 'context.rewritten', {
                        module: 'HistoryRewriter',
                        sessionId,
                        beforeTokens: rewriteBeforeTokens,
                        afterTokens: rewriteAfterTokens,
                        saved: rewriteSaved,
                    });
                }
                scheduleSavings();
            },
        });
        if (typeof dispose !== 'function')
            return false;
        schemaDisposer = dispose;
        disposers.push(dispose);
        (0, log_1.logEvent)('info', 'schema.installed', { source });
        maybeCalibrate(rawStream);
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
            // 编码类工具（read/grep/glob/edit 等）的输出是 Agent 的「工作原料」：
            // 摘要化/指针化会让它无法精确编辑（实测会导致读不到关键代码、改错行）。
            // 这类输出必须在去重与压缩之前放行，原文照旧透传。
            const earlyToolName = String(exec?.tool?.name ?? exec?.name ?? '');
            if (SOURCE_READ_TOOLS.has(earlyToolName)) {
                (0, log_1.logEvent)('info', 'pipeline.source_passthrough', {
                    module: 'Firewall',
                    tool: earlyToolName,
                    chars: text.length,
                    reason: 'source-read',
                });
                return decision;
            }
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
            // 编码类工具（read/grep/glob 等）的输出是 Agent 的「工作原料」：
            // 摘要化会让它无法精确编辑（实测会导致读不到关键代码、改错行）。
            // 这类输出只做去重，绝不进防火墙/抽取，原文照旧透传。
            const toolName = String(exec?.tool?.name ?? exec?.name ?? '');
            const sourceRead = SOURCE_READ_TOOLS.has(toolName);
            if (sourceRead) {
                (0, log_1.logEvent)('info', 'pipeline.source_passthrough', {
                    module: 'Firewall',
                    tool: toolName,
                    tokensBefore,
                    reason: 'source-read',
                });
                return decision;
            }
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
                        protectedLines: firewall.protectedLines,
                        foldedRuns: firewall.foldedRuns,
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
            let pipeLine = '';
            if (admitted.admitted && admitted.spilledTo) {
                const published = toolPipe.publishFile(admitted.spilledTo);
                pipeLine = `\n[PIPE] ref=${published.ref}`;
                (0, log_1.logEvent)('info', 'toolpipe.publish', { module: 'ToolPipe', ref: published.ref, bytes: published.bytes });
            }
            const finalText = (admitted.admitted ? (compressed === text ? admitted.text : `${compressed}\n\n${admitted.text}`) : compressed) + pipeLine;
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
            // 按信号记录，而不是截取最近 N 条消息：多步工具调用后最近的消息里往往没有
            // 用户消息，靠它判档位会退化成 normal。这里显式回溯最后一条用户消息。
            {
                const last = entries[entries.length - 1];
                let userText = '';
                for (let index = entries.length - 1; index >= 0; index -= 1) {
                    if (entries[index].role === 'user') {
                        userText = entries[index].text;
                        break;
                    }
                }
                // 新一轮观测：上一轮的 effort 决策随之失效，避免跨轮串味。
                lastEffort = null;
                effortContext = {
                    userText,
                    lastRole: String(last?.role ?? ''),
                    // 只认宿主给出的错误标记。用文本猜（looksLikeError）会把「输出里恰好含 error/失败
                    // 字样」的普通工具结果当成失败，于是每一步都升级回 max，effort 杠杆直接失效
                    // （实盘 5/5 次决策都是 execute+error）。
                    toolErrored: last?.role === 'tool' ? last?.isError === true : false,
                };
            }
            const workspace = workspaceFor(live, payload?.agent);
            if (!sessionWorkspaces.has(sessionId)) {
                sessionWorkspaces.set(sessionId, workspace);
                ledger.recordSession(sessionId, workspace);
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
            // 标记本轮属于哪个工作区：onUsage 结算金额时按这个归属记账。
            activeTurn = { workspace, sessionId, startedAt: Date.now() };
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
            if (config.localRouting && localAvailable && routingDecision.route === 'local' && routingTokens < 3000) {
                // 只做观测，不接管请求：真实请求始终走云端。所以绝不能 await ——
                // 它会让每一轮都多等一次本地模型的生成时间（红线：不得阻塞主链路）。
                void (async () => {
                    try {
                        const routed = await router.attemptLocal(lastUser?.text ?? '');
                        (0, log_1.logEvent)('info', 'routing.result', {
                            module: 'Routing',
                            route: routed.route,
                            degraded: routed.degraded,
                            latencyMs: routed.latencyMs,
                        });
                        if (routed.route === 'local') {
                            (0, log_1.logEvent)('info', 'routing.local_hit', { module: 'Routing', latencyMs: routed.latencyMs });
                        }
                        else {
                            (0, log_1.logEvent)('info', 'routing.local_degraded', { module: 'Routing', reason: routed.reason });
                        }
                    }
                    catch (error) {
                        (0, log_1.logEvent)('warn', 'routing.probe_failed', { module: 'Routing', error: String(error) });
                    }
                })();
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
            const price = (0, pricing_1.priceFor)(String(payload?.agent?.model ?? 'deepseek-flash'));
            const missRatio = price.hit > 0 ? price.miss / price.hit : 30;
            const decision = (0, cacheAnchor_1.gatePatch)({
                prefixBreak,
                cachedPrefixTokens,
                savedByCompression: plan.tokensSaved,
                savedBySchema: 0,
                recallPenalty: 0,
                expectedRemainingTurns: remainingTurns,
                contextTokens: tokens,
                hitPrice: 1,
                missPrice: missRatio,
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
                pricing: { tier: price.tier, peak: price.peak, hit: price.hit, miss: price.miss, output: price.output },
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
