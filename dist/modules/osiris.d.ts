/**
 * OSIRIS —— 前缀缓存感知的状态密封（v2.0 正式版）。
 *
 * 三套哈希分别锚定 system / tools / history：
 * - systemHash：system prompt 段（通常稳定，漂移即关键变更）；
 * - toolsHash：工具集（动态选择时用它检测漂移）；
 * - historyHash：历史消息（按 retainRecent 截断后的稳定前缀）。
 *
 * 结合意图桶（bucket）实现「会话内工具集稳定」：同一 bucket 复用上一轮工具集，
 * 避免 Tool Attention 每轮换工具导致前缀缓存击穿。
 */
export interface StateSeal {
    systemHash: string;
    toolsHash: string;
    historyHash: string;
    bucket: string;
    toolsTokens: number;
    historyTokens: number;
}
export declare function shortHash(value: string): string;
export declare function sealState(input: {
    messages: any[];
    tools: any[];
    bucket: string;
    keepRecent?: number;
}): StateSeal;
/** 意图桶：取查询词的稳定集合，避免同义改写导致桶抖动。 */
export declare function intentBucket(prompt: string, depth?: number): string;
