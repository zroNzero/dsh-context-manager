/**
 * HistoryRewriter —— 请求级历史重写（v1.2 主杠杆）。
 *
 * 在发往模型的 request.messages 层面做内存折叠，**不修改本地 session surface**：
 * - 旧 tool 结果：只保留头/尾与错误行 + 重跑提示；
 * - 旧 assistant 文本：剥离 CoT、截断到上限；
 * - user / system / 最近 N 条：原样保留（约束优先）。
 *
 * 安全边界：不删除、不重排消息，只改 content —— tool-call 与 tool-result 的配对
 * 结构完全不变，因此不会复现 surface 折叠那种孤儿 tool/call 事故。
 */
export interface RewriteOptions {
    retainRecent?: number;
    toolHeadLines?: number;
    toolTailLines?: number;
    assistantChars?: number;
    toolChars?: number;
    minMessages?: number;
}
export interface RewriteResult {
    messages: any[];
    beforeTokens: number;
    afterTokens: number;
    saved: number;
    rewritten: number;
}
export declare function rewriteMessages(messages: any[], options?: RewriteOptions): RewriteResult;
/** 仅用于缓存键：把消息内容压成稳定的字符串。 */
export declare function messagesCacheKey(messages: any[], tools: any[]): string;
