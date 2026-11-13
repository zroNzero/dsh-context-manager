/**
 * SavingsLedger —— Token 节省账本（面板数据源，schemaVersion 5）。
 *
 * v5 新增：
 * - byModuleBefore：每个模块的「原始大小」，供面板计算每维压缩率；只加字段。
 *
 * v4 新增（向后兼容，只加字段）：
 * - byWorkspace：按会话工作区分账，workspaceId 是规范化路径的稳定短 hash；
 * - tokensBeforeTotal / tokensAfterTotal：Σ 每次请求的 prompt token（压缩前/后），
 *   供面板计算可靠比例；由于只覆盖 schema 压缩维度，标记 tokensBeforeTotalEstimated。
 *
 * 顶层字段始终等于各工作区之和；旧字段全部保留。
 */
import { type WorkspaceRef } from './workspace';
export type SavingsModule = 'admission' | 'extraction' | 'dedup' | 'fold' | 'schema' | 'rewrite';
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
    /** 真实口径：Σ 每请求 before − after（可直接对账）。 */
    totalSavedTokens: number;
    /** 归因总量（各模块因果节省之和，不可与 totalSavedTokens 相加）。 */
    causalReductions?: number;
    estimatedCostTokens: number;
    perRequestSavings: number;
    eventSavings: number;
    contextReduction: number;
    byModule: Record<SavingsModule, number>;
    /** 每个模块的原始大小（用于计算每维压缩率）。 */
    byModuleBefore: Record<SavingsModule, number>;
    events: number;
    folds: number;
    /** 该工作区逐轮累计的金额（CNY）。 */
    moneyCny?: number;
    /** 该工作区参与计价的轮次数。 */
    moneyTurns?: number;
    moneyHitTokens?: number;
    moneyMissTokens?: number;
    tokensBeforeTotal: number;
    tokensAfterTotal: number;
    updatedAt: string;
}
export interface SavingsSnapshot {
    schemaVersion: 5;
    /** 记账口径版本；口径变了就 +1，消费方必须丢弃旧口径的累计。 */
    accountingVersion: number;
    /** 每次插件 apply 生成的新账本 id；消费方看到新 id 必须「替换」而不是累加。 */
    ledgerId: string;
    /** 同一账本内每次写盘递增，用于消费方去重。 */
    revision: number;
    startedAt: string;
    updatedAt: string;
    /** 兼容字段：真实口径的 token 节省（Σ 每请求 before − after），可直接对账。 */
    totalSavedTokens: number;
    /** 归因总量：各模块因果节省之和，仅用于解释来源，不可与 totalSavedTokens 相加。 */
    causalReductions?: number;
    byModule: Record<SavingsModule, number>;
    /** 每个模块的原始大小（byModule 的节省 / byModuleBefore 原值 = 压缩率）。 */
    byModuleBefore: Record<SavingsModule, number>;
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
    /** 会话 → 工作区 id，供客户端按会话定位自己的工作区（无需解析路径）。 */
    bySession: Record<string, string>;
    /**
     * 金额（CNY）：逐轮累加，每轮用该轮实测命中率与峰谷价单独计价。
     * 不做「先汇总 token 再乘平均单价」，因为命中率与峰谷价都不是线性的。
     */
    money?: {
        currency: 'CNY';
        total: number;
        basis: {
            mode: 'per-turn';
            /** 参与计价的轮次数。 */
            turns: number;
            /** 各轮「省下的命中 token」之和。 */
            savedHitTokens: number;
            /** 各轮「省下的未命中 token」之和。 */
            savedMissTokens: number;
            /** 加权有效命中率 = savedHitTokens / (savedHitTokens + savedMissTokens)。 */
            effectiveHitRate: number | null;
            hit: number;
            miss: number;
        };
    };
    events: number;
    folds: number;
    rejectedByAnchor: number;
    lastEvents: SavingsEvent[];
}
/**
 * 记账口径版本 2：`saved` 改为真实的 token 差（v1 曾把字符数当 token 记账，
 * 虚增约 4 倍）。面板据此丢弃旧口径的当日累计，不把两个口径加在一起。
 */
export declare const ACCOUNTING_VERSION = 5;
/** 一轮 LLM 调用的计价输入，由 billing 侧按该轮 usage 算好后写入。 */
export interface TurnMoneyInput {
    /** 该轮省下的钱：Σ(省下的命中 token × 命中价 + 省下的未命中 token × 未命中价)。 */
    savedCny: number;
    savedHitTokens: number;
    savedMissTokens: number;
    /** 该轮实测命中率（hitTokens / promptTokens）。 */
    hitRate: number;
    /** 该轮所处的计价时段，便于面板解释峰谷差异。 */
    window?: 'peak' | 'offpeak' | string;
}
export declare class SavingsLedger {
    private readonly ledgerId;
    private revision;
    private startedAt;
    private updatedAt;
    private readonly workspaces;
    private readonly bySession;
    private readonly lastEvents;
    private rejected;
    /** 记录会话归属，便于消费方按 sessionId 找到对应工作区。 */
    recordSession(sessionId: string, ref: WorkspaceRef): void;
    private aggFor;
    record(module: SavingsModule, tokens: number, detail?: string, workspace?: WorkspaceRef, beforeTokens?: number): void;
    /** 记录一次请求的 prompt token（压缩前/后）；只计统计，不产生“节省事件”。 */
    recordRequestTokens(workspace: WorkspaceRef | undefined, beforeTokens: number, afterTokens: number): void;
    /**
     * 记录一轮 LLM 调用的金额。
     *
     * 必须逐轮记账，不能先汇总 token 再乘平均命中率：每一轮的命中率不同，
     * 峰谷价也不同，两者都是非线性的，事后平均会把误差抹进结果里。
     */
    recordTurn(workspace: WorkspaceRef | undefined, input: TurnMoneyInput): void;
    noteFold(workspace?: WorkspaceRef): void;
    noteRejected(): void;
    private totalSaved;
    /** 从上次运行的 savings.json 恢复累计（同一工作区跨重启延续，不再每次归零）。 */
    restore(snapshot: any): boolean;
    private sumMoney;
    snapshot(prices?: {
        hit: number;
        miss: number;
        cacheHitRate?: number;
    }): SavingsSnapshot;
    /** Markdown 面板：按模块汇总 + 按工作区 + 最近事件。 */
    renderMarkdown(): string;
}
