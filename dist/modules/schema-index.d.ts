/**
 * SchemaIndex —— 工具 Schema 瘦身（MCP Tool Tax 治理）。
 *
 * 灵感来源：
 * - mcp-context-proxy / Bifrost-MCP-Gateway：MCP schema 每轮重复注入是截距大头；
 * - PenguinHarness《先压低上下文斜率》：同一会话内工具集必须固定，中途增删会让
 *   前缀缓存整体失效。
 *
 * 因此本模块**不做**每轮动态挑选工具（那会破坏 CacheAnchor 的前缀对齐红线），
 * 而是做确定性的描述压缩：工具名、参数结构、required 全部保留（能力无损），
 * 只把冗长的 description 截断到 maxDescriptionChars。同一请求输入永远得到同一输出，
 * 前缀哈希稳定，缓存不受影响。
 *
 * 可选的 selectStableToolSet 仅作为实验开关：按首轮意图固定一个子集，
 * 并在会话内保持稳定；默认关闭，避免模型在后续轮次需要被裁掉的工具。
 */
import type { RewriteResult } from './history-rewriter';
import { type ResponseCache } from './response-cache';
import { type ToolLike } from './tool-attention';
export interface SchemaStats {
    changed: number;
    charsBefore: number;
    charsAfter: number;
    tokensSaved: number;
}
export interface ToolSchemaLike {
    name?: string;
    description?: string;
    parameters?: unknown;
    [key: string]: unknown;
}
/**
 * 确定性描述压缩：只截断 description 字段，其它 schema 内容原样保留。
 * 同样的 tools 输入永远得到同样的输出（可安全用于前缀缓存）。
 */
export declare function compressToolSchemas(tools: readonly ToolSchemaLike[], maxDescriptionChars?: number): {
    tools: ToolSchemaLike[];
    stats: SchemaStats;
};
/**
 * 实验特性：按首轮意图固定一个稳定工具子集（会话内不再变化）。
 * 默认关闭 —— 中途增删工具会破坏前缀缓存，且后续轮次可能缺工具。
 */
export declare function selectStableToolSet(tools: readonly ToolSchemaLike[], prompt: string, options?: {
    topK?: number;
    alwaysKeep?: readonly string[];
}): {
    tools: ToolSchemaLike[];
    hidden: string[];
};
export interface SchemaCompressorOptions {
    enabled?: boolean;
    maxDescriptionChars?: number;
    /** 实验：固定工具子集，默认 false。 */
    selectionEnabled?: boolean;
    topK?: number;
    /** 每次压缩成功后回调节省的 token（用于 SavingsLedger）。 */
    onSavings?: (tokens: number) => void;
    /** 每次请求回调 prompt token 的压缩前/后统计（用于面板比例）。 */
    onRequest?: (event: {
        sessionId: string;
        beforeTokens: number;
        afterTokens: number;
        savedTokens: number;
        toolsBeforeTokens: number;
        toolsAfterTokens: number;
        rewriteSaved?: number;
        rewriteBeforeTokens?: number;
        rewriteAfterTokens?: number;
    }) => void;
    /**
     * 请求级历史重写（v1.2）：只改 messages 内容，不删除/重排消息。
     *
     * 缓存不变量（2026-11-11 真实账单分析）：provider 的 prompt 缓存是**前缀匹配**，
     * 已发出的前缀只要有一个字符变了，整段就以 miss 价重算（miss ¥1/M vs hit ¥0.02/M，
     * 差 50 倍）。因此这个回调**故意不提供实时预算**：任何按当前 token 数算出来的
     * 压缩上限都会让旧消息每次被截成不同的长度，轮内命中率实测因此掉到 24%。
     * 重写必须只依赖「消息内容 + 固定配置」，同一段内容永远得到同一段输出。
     */
    rewriteHistory?: (messages: any) => RewriteResult | null;
    /** 精确哈希响应缓存（v1.2）：命中时直接重放 chunk。 */
    responseCache?: ResponseCache;
    onCacheHit?: () => void;
    /** 语义缓存命中回调（v1.3）。 */
    onSemanticHit?: (score: number) => void;
    /** 工具懒加载（v1.3）：只注入 top-K 完整 schema，其余进目录。 */
    toolAttention?: {
        enabled?: boolean;
        topK?: number;
    };
    /** 把完整工具表回传给宿主，供 search_tools 元工具查询。 */
    onToolCatalog?: (tools: ToolLike[]) => void;
    /** 输出端硬截断（v2.0）：超过 maxTokens 或 JSON/代码块闭合后立即停止。 */
    outputGuard?: {
        enabled?: boolean;
        maxTokens: number;
    };
    onOutputTruncated?: (reason: 'max_tokens' | 'json_closed' | 'code_closed') => void;
    /**
     * TTL Keepalive（武器 30）：在 provider 缓存过期前，用逐字节相同的载荷重放一次
     * （maxTokens=1）把缓存续上。默认关闭，由 apply() 按配置显式打开。
     */
    keepalive?: {
        enabled?: boolean;
        /** provider 缓存 TTL，默认 240_000ms。 */
        ttlMs?: number;
        /** 一次空闲期最多续几次，默认 4。 */
        refreshes?: number;
        /** 低于这个 prompt 规模不值得续，默认 8000 token。 */
        minPromptTokens?: number;
        /** 在 TTL 的这个比例处触发，默认 0.5。 */
        marginRatio?: number;
        /** 触发延迟下限，默认 5000ms（测试用）。 */
        minDelayMs?: number;
        /** 同时保温的会话数上限，默认 3（防止一堆 subagent 各自烧保活费）。 */
        maxSessions?: number;
    };
    /**
     * 动态 reasoning effort：返回要写进请求的档位。实现方必须保证只下调、不上调
     * （见 modules/effort-policy.ts）。返回 null 表示不干预。
     */
    resolveEffort?: (request: any) => {
        effort: string;
    } | null;
    /**
     * 在 prepareCall 之前修正 call config（provider/model/reasoningEffort/temperature/maxTokens/stop）。
     * DSH 会冻结 prepare 解析出的 config 并在 dispatch 时做相等校验，因此 effort 必须在这里改，
     * 绝不能在 stream 阶段改（会触发 INVALID_PREPARED_CALL）。
     */
    prepareCallConfig?: (config: any) => any;
    /**
     * provider 真实 usage 回调（Gate 1）：只有流里真的出现 `usage` chunk 才回调，
     * 并同时给出同一请求压缩前/后的载荷字符数，供 BillingLedger 实测校准。
     */
    onUsage?: (info: {
        purpose: string;
        model: string;
        usage: {
            inputTokens?: number;
            outputTokens?: number;
            cacheReadTokens?: number;
            cacheWriteTokens?: number;
        };
        beforeChars: number;
        afterChars: number;
    }) => void;
}
/**
 * 包装 llm.stream / prepareCall：在请求发往适配器前压缩工具描述。
 * 失败安全：任何异常原样放行。
 */
export declare function installSchemaCompressor(ctx: any, options?: SchemaCompressorOptions): () => void;
/** 供 demo 使用：估算一组 schema 的 token 数。 */
export declare function schemaTokens(tools: readonly ToolSchemaLike[]): number;
