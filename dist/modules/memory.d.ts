/**
 * MemoryModule —— 计划感知折叠 + 历史 CoT 蒸馏（v3.5）。
 *
 * 两刀：
 * 1. CoT Distill：历史消息里的 <thought>/<thinking>/[思考] 块被剪成一行
 *    `[决策: ...]` 状态结论，冗长推理从上下文中物理移除；
 * 2. DAG 折叠：连续的中段 ATTEMPT/FAILURE 折叠为一条摘要 Patch。
 *
 * 永远不动：全部 user 需求（REQUIREMENT）、最近 retainRecent 条、最后一条 assistant 结论。
 */
import { type Patch } from '../contracts';
export interface MemoryEntry {
    seq: number;
    role: string;
    text: string;
    isError?: boolean;
    /** 消息来源种类（user / agent-message / runtime-context…），用于角色感知保留窗口。 */
    sourceKind?: string;
}
export interface MemoryPlan {
    patch: Patch | null;
    foldedSeqs: number[];
    foldedMessages: number;
    tokensBefore: number;
    tokensAfter: number;
    tokensSaved: number;
    summary: string;
    /** CoT 蒸馏统计。 */
    cotSegments: number;
    cotCharsBefore: number;
    cotCharsAfter: number;
    cotSavedTokens: number;
    /** 摘要是否包含结构化任务状态卡。 */
    indexIncluded?: boolean;
    /** 质量校验：关键约束是否全部保留在摘要中。 */
    qualityPass?: boolean;
}
export interface DistillResult {
    text: string;
    segments: number;
    removedChars: number;
    keptChars: number;
}
/** 蒸馏单条文本里的全部思考块；返回文本与真实字符/片段统计。 */
export declare function distillThoughts(text: string): DistillResult;
export declare function planMemoryFold(entries: readonly MemoryEntry[], options?: {
    retainRecent?: number;
    minSaveTokens?: number;
}): MemoryPlan;
