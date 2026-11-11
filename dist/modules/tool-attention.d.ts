/**
 * ToolAttention —— 基于意图的工具懒加载（v1.3）。
 *
 * 每轮按最后一条用户消息对工具做轻量打分（名称命中权重更高），只注入 top-K 完整
 * Schema；其余工具在 system prompt 中保留一行“名称 + 一句话描述”的目录。
 * 缺省提供 search_tools 元工具用于按需拉取完整 Schema。
 *
 * 注意：动态工具集会改变请求前缀，可能击穿缓存；调用方必须记录并自行承担
 * CacheAnchor 风险（日志 tool_attention.prefix_risk）。
 */
export interface ToolLike {
    name: string;
    description?: string;
    parameters?: unknown;
}
export declare const SEARCH_TOOLS_DEF: ToolLike;
export declare function tokenize(text: string): string[];
export declare function firstSentence(text: string, maxChars?: number): string;
export interface ToolSelection {
    /** 需要注入完整 schema 的工具（含 search_tools）。 */
    selected: ToolLike[];
    /** 被隐藏的工具目录行。 */
    catalog: string[];
    hidden: string[];
    scoreboard: Array<{
        name: string;
        score: number;
    }>;
}
export declare function selectTools(tools: readonly ToolLike[], prompt: string, topK?: number): ToolSelection;
/** SCOUT：BM25 轻量打分（IDF 抑制高频词），比纯意图命中更稳。 */
export declare function selectToolsScout(tools: readonly ToolLike[], prompt: string, topK?: number): ToolSelection;
/** 由「已锁定工具名集合」重建 selection（OSIRIS 稳定锚定用）。 */
export declare function selectionFromNames(tools: readonly ToolLike[], names: readonly string[]): ToolSelection | null;
/** 把目录行并入 system 消息（不新建、不重排其它消息）。 */
export declare function withCatalog(messages: any[], catalog: string[]): any[];
