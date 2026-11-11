/**
 * BILLING —— 真实账单账本（Gate 1 的地基）。
 *
 * 与 SavingsLedger 的区别（也是本次生产化的核心）：
 * - SavingsLedger 记的是「估算省了多少 token」，`tokensBeforeTotalEstimated: true`；
 * - BillingLedger 只记 provider 回传的 usage（`StreamChunk.usage`），按官方人民币单价
 *   换算，并给出反事实成本（counterfactual）。
 *
 * 反事实怎么算才不是糊弄：
 * 1. 本次请求的真实 prompt token = inputTokens(miss) + cacheReadTokens(hit)，由 provider 给出；
 * 2. 同一次请求里，压缩前后的载荷字符数都精确可得（beforeChars / afterChars）；
 * 3. 因此该请求的「字符 -> token」换算是**实测的**：tokensPerChar = realPromptTokens / afterChars；
 * 4. 被移除的字符数差分经同一系数换算，得到 removedPromptTokens —— 这是本请求实测的、
 *    而不是全局拍脑袋的估算；
 * 5. 反事实成本 = (prompt + removed) 按本次请求实测的 hit/miss 构成分别计价。
 *    removed 落在缓存前缀里的部分按 hit 价，落在新增部分里的按 miss 价，构成比例取实测值。
 *
 * 输出 token 一律不虚报收益：客户端截断是否真让 provider 少 decode 仍需实盘验证
 * （见 README「已知卡点 2」），所以只以 `unverifiedOutputTokens` 单独列示，不计入降幅。
 */

import { costOf, priceFor, type PricingSnapshot } from './pricing.js'

export interface ProviderUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface BillingRequestInput {
  at?: number
  purpose?: string
  model: string
  /** provider 原样回传的 usage；缺失时本条记录不计入成本（绝不估算补齐）。 */
  usage: ProviderUsage | undefined
  /** 同一个请求压缩前的模型可见载荷字符数（含 system / messages / tools）。 */
  beforeChars: number
  /** 同一个请求压缩后的字符数。 */
  afterChars: number
  /** 被输出截断丢弃的 token（未经验证，单独列示）。 */
  unverifiedOutputTokens?: number
}

export interface BillingRecord {
  at: number
  purpose: string
  model: string
  peak: boolean
  window: 'peak' | 'offpeak'
  /** 未命中缓存、按 miss 价计费的新增 prompt token。 */
  missTokens: number
  /** 命中缓存、按 hit 价计费的 prompt token。 */
  hitTokens: number
  outputTokens: number
  /** provider 真实计费（人民币）。 */
  actualCost: number
  /** 反事实计费（同一请求不压缩时的成本）。 */
  counterfactualCost: number
  savedCost: number
  /** 本请求实测移除的 prompt token（经字符比校准）。 */
  removedPromptTokens: number
  savedMissTokens: number
  savedHitTokens: number
  unverifiedOutputTokens: number
}

export interface BillingBucket {
  requests: number
  missTokens: number
  hitTokens: number
  outputTokens: number
  actualCost: number
  counterfactualCost: number
  savedCost: number
}

const emptyBucket = (): BillingBucket => ({
  requests: 0,
  missTokens: 0,
  hitTokens: 0,
  outputTokens: 0,
  actualCost: 0,
  counterfactualCost: 0,
  savedCost: 0,
})

const addTo = (bucket: BillingBucket, record: BillingRecord): void => {
  bucket.requests += 1
  bucket.missTokens += record.missTokens
  bucket.hitTokens += record.hitTokens
  bucket.outputTokens += record.outputTokens
  bucket.actualCost += record.actualCost
  bucket.counterfactualCost += record.counterfactualCost
  bucket.savedCost += record.savedCost
}

export interface BillingSnapshot {
  schemaVersion: 1
  /** 只有拿到 provider usage 的请求才计入。 */
  requests: number
  /** 拿到 usage 但字符数不变（压缩未生效）的请求数。 */
  requestsWithoutReduction: number
  actualCost: number
  counterfactualCost: number
  savedCost: number
  /** 真实账单降幅 = 1 - actual / counterfactual。分母为 0 时为 0。 */
  reduction: number
  currency: 'CNY'
  missTokens: number
  hitTokens: number
  outputTokens: number
  cacheHitRate: number
  unverifiedOutputTokens: number
  byPurpose: Record<string, BillingBucket>
  byModel: Record<string, BillingBucket>
  byWindow: Record<string, BillingBucket>
  /** 最近一次请求的计价快照，便于面板显示当前单价。 */
  lastPricing: { tier: string; window: 'peak' | 'offpeak'; hit: number; miss: number; output: number } | null
  updatedAt: string
}

const reductionOf = (actual: number, counterfactual: number): number =>
  counterfactual > 0 ? Math.max(0, 1 - actual / counterfactual) : 0

export class BillingLedger {
  private readonly records: BillingRecord[] = []
  private noReduction = 0
  private unverifiedOutput = 0
  private lastPricing: PricingSnapshot | null = null
  private readonly byPurpose = new Map<string, BillingBucket>()
  private readonly byModel = new Map<string, BillingBucket>()
  private readonly byWindow = new Map<string, BillingBucket>()

  /** 记录一次真实请求。usage 缺失时返回 null，绝不估算补齐。 */
  record(input: BillingRequestInput): BillingRecord | null {
    const miss = Math.max(0, Math.trunc(input.usage?.inputTokens ?? 0))
    const hit = Math.max(0, Math.trunc(input.usage?.cacheReadTokens ?? 0))
    const out = Math.max(0, Math.trunc(input.usage?.outputTokens ?? 0))
    if (!input.usage || (miss === 0 && hit === 0 && out === 0)) return null

    const at = input.at ?? Date.now()
    const price = priceFor(input.model, new Date(at))
    this.lastPricing = price
    const actualCost = costOf(miss, price.miss) + costOf(hit, price.hit) + costOf(out, price.output)

    // 反事实：被移除的内容仍然存在时的 prompt。
    const removedChars = Math.max(0, input.beforeChars - input.afterChars)
    const promptTokens = miss + hit
    const tokensPerChar = input.afterChars > 0 && promptTokens > 0 ? promptTokens / input.afterChars : 0
    const removedPromptTokens = removedChars > 0 ? Math.round(removedChars * tokensPerChar) : 0

    // 构成比例取本请求实测值：命中部分按 hit 价，新增部分按 miss 价。
    const hitRatio = promptTokens > 0 ? hit / promptTokens : 0
    const savedHitTokens = Math.round(removedPromptTokens * hitRatio)
    const savedMissTokens = removedPromptTokens - savedHitTokens
    const counterfactualCost = actualCost + costOf(savedHitTokens, price.hit) + costOf(savedMissTokens, price.miss)

    const unverified = Math.max(0, Math.trunc(input.unverifiedOutputTokens ?? 0))
    const record: BillingRecord = {
      at,
      purpose: input.purpose ?? 'unknown',
      model: price.tier,
      peak: price.peak,
      window: price.peak ? 'peak' : 'offpeak',
      missTokens: miss,
      hitTokens: hit,
      outputTokens: out,
      actualCost,
      counterfactualCost,
      savedCost: counterfactualCost - actualCost,
      removedPromptTokens,
      savedMissTokens,
      savedHitTokens,
      unverifiedOutputTokens: unverified,
    }

    if (removedPromptTokens === 0) this.noReduction += 1
    else {
      this.records.push(record)
      this.unverifiedOutput += unverified
      const bump = (map: Map<string, BillingBucket>, key: string): void => {
        const bucket = map.get(key) ?? emptyBucket()
        addTo(bucket, record)
        map.set(key, bucket)
      }
      bump(this.byPurpose, record.purpose)
      bump(this.byModel, record.model)
      bump(this.byWindow, record.window)
    }
    return record
  }

  /** 全部记录（含零削减请求），用于调试与断言。 */
  all(): readonly BillingRecord[] {
    return this.records
  }

  snapshot(): BillingSnapshot {
    const total = emptyBucket()
    for (const record of this.records) addTo(total, record)
    const promptTokens = total.missTokens + total.hitTokens
    return {
      schemaVersion: 1,
      requests: total.requests,
      requestsWithoutReduction: this.noReduction,
      actualCost: total.actualCost,
      counterfactualCost: total.counterfactualCost,
      savedCost: total.savedCost,
      reduction: reductionOf(total.actualCost, total.counterfactualCost),
      currency: 'CNY',
      missTokens: total.missTokens,
      hitTokens: total.hitTokens,
      outputTokens: total.outputTokens,
      cacheHitRate: promptTokens > 0 ? total.hitTokens / promptTokens : 0,
      unverifiedOutputTokens: this.unverifiedOutput,
      byPurpose: Object.fromEntries([...this.byPurpose.entries()].sort((a, b) => b[1].actualCost - a[1].actualCost)),
      byModel: Object.fromEntries(this.byModel.entries()),
      byWindow: Object.fromEntries(this.byWindow.entries()),
      lastPricing: this.lastPricing
        ? {
            tier: this.lastPricing.tier,
            window: this.lastPricing.peak ? 'peak' : 'offpeak',
            hit: this.lastPricing.hit,
            miss: this.lastPricing.miss,
            output: this.lastPricing.output,
          }
        : null,
      updatedAt: new Date().toISOString(),
    }
  }

  renderMarkdown(): string {
    const s = this.snapshot()
    const pct = (v: number): string => `${(v * 100).toFixed(1)}%`
    const cny = (v: number): string => `¥${v.toFixed(4)}`
    const rows = Object.entries(s.byPurpose)
      .map(([k, v]) => `| ${k} | ${v.requests} | ${cny(v.actualCost)} | ${cny(v.counterfactualCost)} | ${pct(reductionOf(v.actualCost, v.counterfactualCost))} |`)
      .join('\n')
    return [
      '# 真实账单（provider usage × 官方单价）',
      '',
      `- 请求数：${s.requests}（无削减 ${s.requestsWithoutReduction}）`,
      `- 真实花费：${cny(s.actualCost)}；反事实：${cny(s.counterfactualCost)}`,
      `- **真实降幅：${pct(s.reduction)}**`,
      `- token：miss ${s.missTokens} / hit ${s.hitTokens} / out ${s.outputTokens}；缓存命中率 ${pct(s.cacheHitRate)}`,
      `- 未验证的输出截断 token：${s.unverifiedOutputTokens}（不计入降幅）`,
      '',
      '| 用途 | 请求 | 真实花费 | 反事实 | 降幅 |',
      '|---|---:|---:|---:|---:|',
      rows,
      '',
    ].join('\n')
  }
}
