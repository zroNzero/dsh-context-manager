/**
 * SavingsLedger —— Token 节省账本（面板数据源）。
 *
 * 所有节省事件统一记账：Admission / Extraction / Dedup / Fold / Schema。
 * 运行期把快照写入 ./savings.json 与 ./savings.md，
 * 面板可以通过工具 costkiller_status 或直接查看 savings.md 获取。
 */
export type SavingsModule = 'admission' | 'extraction' | 'dedup' | 'fold' | 'schema';
export interface SavingsEvent {
    ts: string;
    module: SavingsModule;
    tokens: number;
    detail: string;
}
export interface SavingsSnapshot {
    schemaVersion: 3;
    /** 每次插件 apply 生成的新账本 id；消费方看到新 id 必须「替换」而不是累加。 */
    ledgerId: string;
    /** 同一账本内每次写盘递增，用于消费方去重。 */
    revision: number;
    startedAt: string;
    updatedAt: string;
    /** 兼容字段：所有模块的「prompt token 减少量」之和（不是账单）。 */
    totalSavedTokens: number;
    byModule: Record<SavingsModule, number>;
    /** 按请求累计的节省（schema 每次请求都会生效）。 */
    perRequestSavings: number;
    /** 单次事件节省（admission / extraction / dedup）。 */
    eventSavings: number;
    /** 一次性上下文缩减（fold）：只计一次，后续请求持续受益但不重复累加。 */
    contextReduction: number;
    /** 缓存感知的估算成本节省（单位：miss-token 等价）。 */
    estimatedCostTokens: number;
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
    private readonly byModule;
    private eventCount;
    private foldCount;
    private rejected;
    private readonly lastEvents;
    record(module: SavingsModule, tokens: number, detail?: string): void;
    noteFold(): void;
    noteRejected(): void;
    get total(): number;
    snapshot(): SavingsSnapshot;
    /** Markdown 面板：按模块汇总 + 最近事件。 */
    renderMarkdown(): string;
}
