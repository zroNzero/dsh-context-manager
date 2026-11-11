/**
 * SCOPE —— 分层预算（v2.0 正式版）。
 *
 * 把请求上下文预算切成 Tools / Memory / Live 三份：
 * - Tools：schema 注入上限（默认 15%，避免 MCP 工具税吃掉预算）；
 * - Memory：历史重写可用的预算（决定 retainRecent 与 toolChars）；
 * - Live：最近消息原样保留。
 *
 * 目标是让压缩随上下文规模自适应：小请求少压，大请求多压。
 */
export interface ScopeBudget {
    totalTokens: number;
    toolsBudget: number;
    memoryBudget: number;
    liveBudget: number;
    retainRecent: number;
    toolChars: number;
    assistantChars: number;
}
export interface ScopeOptions {
    toolsRatio?: number;
    memoryRatio?: number;
    minRetain?: number;
    maxRetain?: number;
}
export declare function planBudget(totalTokens: number, schemaTokens: number, options?: ScopeOptions): ScopeBudget;
