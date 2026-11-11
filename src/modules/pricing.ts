/**
 * PRICING_TABLE —— DeepSeek 官方真实计费（人民币 / 百万 token）。
 *
 * 高峰：北京时间周一至周五 09:00-12:00、14:00-18:00；其余时间与法定节假日为空闲。
 * 空闲价 = 高峰价的一半。
 */

export type PricingTier = 'flash' | 'v4pro'
export type PriceKind = 'hit' | 'miss' | 'output'

export interface PriceSet {
  hit: number
  miss: number
  output: number
}

export const PRICING_TABLE: Record<PricingTier, { peak: PriceSet; offpeak: PriceSet }> = {
  flash: {
    peak: { hit: 0.04, miss: 2, output: 8 },
    offpeak: { hit: 0.02, miss: 1, output: 4 },
  },
  v4pro: {
    peak: { hit: 0.3, miss: 9, output: 27 },
    offpeak: { hit: 0.15, miss: 4.5, output: 13.5 },
  },
}

export interface PricingSnapshot extends PriceSet {
  tier: PricingTier
  peak: boolean
  currency: 'CNY'
  perTokens: number
  at: string
}

/** 北京时间（UTC+8），不依赖本机时区。 */
export function isPeakHour(now: Date = new Date()): boolean {
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  const day = beijing.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = beijing.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

export function tierOf(model: string): PricingTier {
  return String(model ?? '').toLowerCase().includes('pro') ? 'v4pro' : 'flash'
}

export function priceFor(model: string, now: Date = new Date()): PricingSnapshot {
  const tier = tierOf(model)
  const peak = isPeakHour(now)
  const prices = PRICING_TABLE[tier][peak ? 'peak' : 'offpeak']
  return {
    tier,
    peak,
    currency: 'CNY',
    perTokens: 1_000_000,
    at: now.toISOString(),
    ...prices,
  }
}

/** 把 token 数换算成人民币成本（元）。 */
export function costOf(tokens: number, pricePerMillion: number): number {
  return (Math.max(0, tokens) * pricePerMillion) / 1_000_000
}

export function pricingLoadedLog(price: PricingSnapshot): Record<string, unknown> {
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
  }
}
