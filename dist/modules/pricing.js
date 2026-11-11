"use strict";
/**
 * PRICING_TABLE —— DeepSeek 官方真实计费（人民币 / 百万 token）。
 *
 * 高峰：北京时间周一至周五 09:00-12:00、14:00-18:00；其余时间与法定节假日为空闲。
 * 空闲价 = 高峰价的一半。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PRICING_TABLE = void 0;
exports.isPeakHour = isPeakHour;
exports.tierOf = tierOf;
exports.priceFor = priceFor;
exports.costOf = costOf;
exports.pricingLoadedLog = pricingLoadedLog;
exports.PRICING_TABLE = {
    flash: {
        peak: { hit: 0.04, miss: 2, output: 8 },
        offpeak: { hit: 0.02, miss: 1, output: 4 },
    },
    v4pro: {
        peak: { hit: 0.3, miss: 9, output: 27 },
        offpeak: { hit: 0.15, miss: 4.5, output: 13.5 },
    },
};
/** 北京时间（UTC+8），不依赖本机时区。 */
function isPeakHour(now = new Date()) {
    const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const day = beijing.getUTCDay();
    if (day === 0 || day === 6)
        return false;
    const hour = beijing.getUTCHours();
    return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}
function tierOf(model) {
    return String(model ?? '').toLowerCase().includes('pro') ? 'v4pro' : 'flash';
}
function priceFor(model, now = new Date()) {
    const tier = tierOf(model);
    const peak = isPeakHour(now);
    const prices = exports.PRICING_TABLE[tier][peak ? 'peak' : 'offpeak'];
    return {
        tier,
        peak,
        currency: 'CNY',
        perTokens: 1_000_000,
        at: now.toISOString(),
        ...prices,
    };
}
/** 把 token 数换算成人民币成本（元）。 */
function costOf(tokens, pricePerMillion) {
    return (Math.max(0, tokens) * pricePerMillion) / 1_000_000;
}
function pricingLoadedLog(price) {
    return {
        module: 'Pricing',
        model: price.tier,
        peak: price.peak,
        window: price.peak ? 'peak' : 'offpeak',
        currency: price.currency,
        perTokens: price.perTokens,
        hit: price.hit,
        miss: price.miss,
        output: price.output,
    };
}
