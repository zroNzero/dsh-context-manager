/**
 * DAY-LEDGER —— 按「本地日期」分账，给面板提供「当日」视图。
 *
 * 三个原则：
 * 1. **只做加法**。每个字段都是逐轮实测量的累加，不做任何比例摊派或反推。
 * 2. **不用本地时区猜日期**：日期键由 `dayKeyOf()` 用 `Intl` 在固定时区
 *    （默认 Asia/Shanghai）里格式化成 `YYYY-MM-DD`，跨时区/跨夏令时都不会串日。
 * 3. **补齐必须可审计**：只从 `debug.log` 的 `billing.recorded` 行补齐，
 *    因为那类行里的 `removedPromptTokens` / `avoidedOutputTokens` / `savedCost` /
 *    `actualCost` 与账本里的金额同源同口径；且只在某天「尚无记录」时补，
 *    绝不与实时记账重叠。
 */
/** 单日累计。字段定义与 SavingsLedger 的金额三件套一一对应。 */
export interface DayBucket {
    /** 当日少发的 prompt token（= 省下命中 + 省下未命中）。 */
    savedTokens: number;
    /** 当日被省下的输出 token（effort 降档的反事实输出量）。 */
    savedOutTokens: number;
    /** 当日省下的钱（CNY）。 */
    savedMoney: number;
    /** 当日真实花费（CNY）。 */
    actualMoney: number;
    /** 当日计入的轮次数。 */
    turns: number;
}
export declare const PANEL_TIME_ZONE = "Asia/Shanghai";
export declare function emptyDayBucket(): DayBucket;
/** 把任意时刻（毫秒或 Date）格式化成该时区下的 `YYYY-MM-DD`。 */
export declare function dayKeyOf(at?: number | Date): string;
/** 原地累加一个 delta。非有限值一律按 0 处理，避免 NaN 污染整本账。 */
export declare function addToDay(days: Map<string, DayBucket>, dayKey: string, delta: Partial<DayBucket>): void;
/** 序列化成 `Record<date, DayBucket>`，日期新→旧。 */
export declare function daysToRecord(days: Map<string, DayBucket>): Record<string, DayBucket>;
/** 从快照里读回按日分账；返回是否读到了至少一天。 */
export declare function readDays(target: Map<string, DayBucket>, raw: unknown): boolean;
/** 只补「尚无记录」的日期，保证补齐与实时记账永不重叠。 */
export declare function mergeMissingDays(target: Map<string, DayBucket>, incoming: Map<string, DayBucket>): number;
/**
 * 从日志文本里解析 `billing.recorded` 行，按日期累计，并**同时**按工作区细分。
 *
 * 只认这五个字段，其余一概忽略：`removedPromptTokens`（少发的 prompt token）、
 * `avoidedOutputTokens`（省下的输出 token）、`savedCost`、`actualCost`、
 * `workspace`（该轮所属工作区 label；早期日志没有这个字段，那部分只能计入未归属）。
 *
 * 返回的两个映射是同一批数据的两种切法，行级金额完全相同，不会重复计入。
 */
export declare function parseBillingLogAttributed(text: string): {
    days: Map<string, DayBucket>;
    byWorkspace: Map<string, Map<string, DayBucket>>;
};
export declare function parseBillingLog(text: string): Map<string, DayBucket>;
