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
    startedAt: string;
    updatedAt: string;
    totalSavedTokens: number;
    byModule: Record<SavingsModule, number>;
    events: number;
    folds: number;
    rejectedByAnchor: number;
    lastEvents: SavingsEvent[];
}
export declare class SavingsLedger {
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
