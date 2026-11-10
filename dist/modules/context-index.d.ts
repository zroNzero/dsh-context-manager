/**
 * ContextIndex —— 结构化任务状态索引（“高智商”模块）。
 *
 * 观察：纯摘要（"已折叠 21 条消息"）只降 token，不提升推理；模型仍需自己从残片重建任务状态。
 * 本模块把历史压成一份确定性的任务状态卡：目标 / 已决策 / 未决问题 / 硬约束 / 下一步。
 * 折叠时用它替代裸摘要，模型拿到的是“结论态”而不是“删减版流水账”。
 *
 * 全部规则为本地正则，无模型调用（低延迟、确定性、可缓存）。
 */
export interface ContextIndexEntry {
    role: string;
    text: string;
    isError?: boolean;
}
export interface ContextIndex {
    goal: string;
    decisions: string[];
    open: string[];
    constraints: string[];
    next: string[];
}
/**
 * 从历史消息提炼任务状态。用户目标取最后一条 user 消息；
 * 决策/未决/约束/下一步 各取前 N 条，保证确定性与可缓存。
 */
export declare function buildContextIndex(entries: readonly ContextIndexEntry[], limit?: number): ContextIndex;
export declare function isEmptyIndex(index: ContextIndex): boolean;
/** 渲染为稳定、紧凑的状态卡（同输入同输出，可用于缓存对齐）。 */
export declare function renderContextIndex(index: ContextIndex): string;
