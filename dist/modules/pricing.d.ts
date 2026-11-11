/**
 * PRICING_TABLE —— DeepSeek 官方真实计费（人民币 / 百万 token）。
 *
 * 高峰：北京时间周一至周五 09:00-12:00、14:00-18:00；其余时间与法定节假日为空闲。
 * 空闲价 = 高峰价的一半。
 */
export type PricingTier = 'flash' | 'v4pro';
export type PriceKind = 'hit' | 'miss' | 'output';
export interface PriceSet {
    hit: number;
    miss: number;
    output: number;
}
export declare const PRICING_TABLE: Record<PricingTier, {
    peak: PriceSet;
    offpeak: PriceSet;
}>;
export interface PricingSnapshot extends PriceSet {
    tier: PricingTier;
    peak: boolean;
    currency: 'CNY';
    perTokens: number;
    at: string;
}
/** 北京时间（UTC+8），不依赖本机时区。 */
export declare function isPeakHour(now?: Date): boolean;
export declare function tierOf(model: string): PricingTier;
export declare function priceFor(model: string, now?: Date): PricingSnapshot;
/** 把 token 数换算成人民币成本（元）。 */
export declare function costOf(tokens: number, pricePerMillion: number): number;
export declare function pricingLoadedLog(price: PricingSnapshot): Record<string, unknown>;
