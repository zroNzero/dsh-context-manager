/**
 * SavingsLedger —— Token 节省账本（面板数据源，schemaVersion 4）。
 *
 * v4 新增（向后兼容，只加字段）：
 * - byWorkspace：按会话工作区分账，workspaceId 是规范化路径的稳定短 hash；
 * - tokensBeforeTotal / tokensAfterTotal：Σ 每次请求的 prompt token（压缩前/后），
 *   供面板计算可靠比例；由于只覆盖 schema 压缩维度，标记 tokensBeforeTotalEstimated。
 *
 * 顶层字段始终等于各工作区之和；旧字段全部保留。
 */
import { type WorkspaceRef } from './workspace';
export type SavingsModule = 'admission' | 'extraction' | 'dedup' | 'fold' | 'schema';
export interface SavingsEvent {
    ts: string;
    module: SavingsModule;
    tokens: number;
    detail: string;
    workspace?: string;
}
export interface WorkspaceSavingsSnapshot {
    workspace: string;
    label: string;
    totalSavedTokens: number;
    estimatedCostTokens: number;
    perRequestSavings: number;
    eventSavings: number;
    contextReduction: number;
    byModule: Record<SavingsModule, number>;
    events: number;
    folds: number;
    tokensBeforeTotal: number;
    tokensAfterTotal: number;
    updatedAt: string;
}
export interface SavingsSnapshot {
    schemaVersion: 4;
    /** 每次插件 apply 生成的新账本 id；消费方看到新 id 必须「替换」而不是累加。 */
    ledgerId: string;
    /** 同一账本内每次写盘递增，用于消费方去重。 */
    revision: number;
    startedAt: string;
    updatedAt: string;
    /** 兼容字段：所有模块的「prompt token 减少量」之和（不是账单）。 */
    totalSavedTokens: number;
    byModule: Record<SavingsModule, number>;
    perRequestSavings: number;
    eventSavings: number;
    contextReduction: number;
    /** 缓存感知的估算成本节省（单位：miss-token 等价）。 */
    estimatedCostTokens: number;
    /** Σ 每次请求「未压缩时的 prompt token」。 */
    tokensBeforeTotal: number;
    /** Σ 每次请求「压缩后实际发送的 prompt token」。 */
    tokensAfterTotal: number;
    /** 目前 before/after 只覆盖 schema 维度，按估算标注。 */
    tokensBeforeTotalEstimated: true;
    /** 按工作区分账。 */
    byWorkspace: Record<string, WorkspaceSavingsSnapshot>;
    events: number;
    folds: number;
    rejectedByAnchor: number;
    lastEvents: SavingsEvent[];
}
export declare class SavingsLedger {
    private readonly ledgerId;
    private revision;
    private readonly startedAt;
    private updatedAt;
    private readonly workspaces;
    private readonly lastEvents;
    private rejected;
    private aggFor;
    record(module: SavingsModule, tokens: number, detail?: string, workspace?: WorkspaceRef): void;
    /** 记录一次请求的 prompt token（压缩前/后）；只计统计，不产生“节省事件”。 */
    recordRequestTokens(workspace: WorkspaceRef | undefined, beforeTokens: number, afterTokens: number): void;
    noteFold(workspace?: WorkspaceRef): void;
    noteRejected(): void;
    private totalSaved;
    snapshot(): SavingsSnapshot;
    /** Markdown 面板：按模块汇总 + 按工作区 + 最近事件。 */
    renderMarkdown(): string;
}
