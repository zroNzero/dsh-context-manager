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

import { randomUUID } from 'node:crypto'
import { workspaceRef, type WorkspaceRef } from './workspace'
import { addToDay, dayKeyOf, daysToRecord, readDays, emptyDayBucket, mergeMissingDays, parseBillingLogAttributed, type DayBucket } from './day-ledger'

export type SavingsModule = 'admission' | 'extraction' | 'dedup' | 'fold' | 'schema' | 'rewrite'

export interface SavingsEvent {
  ts: string
  module: SavingsModule
  tokens: number
  detail: string
  workspace?: string
}

export interface WorkspaceSavingsSnapshot {
  workspace: string
  label: string
  /** 真实口径：Σ 每请求 before − after（可直接对账）。 */
  totalSavedTokens: number
  /** 归因总量（各模块因果节省之和，不可与 totalSavedTokens 相加）。 */
  causalReductions?: number
  estimatedCostTokens: number
  perRequestSavings: number
  eventSavings: number
  contextReduction: number
  byModule: Record<SavingsModule, number>
  /** 每个模块的原始大小（用于计算每维压缩率）。 */
  byModuleBefore: Record<SavingsModule, number>
  events: number
  folds: number
  /** 该工作区逐轮累计的金额（CNY）。 */
  moneyCny?: number
  /** 该工作区参与计价的轮次数。 */
  moneyTurns?: number
  moneyHitTokens?: number
  moneyMissTokens?: number
  /** 该工作区逐轮累计的「省下的输出 token」；与上面两项一起才能完整重建金额。 */
  moneyOutTokens?: number
  /** 该工作区逐轮累计的真实花费（CNY）。 */
  moneyActualCny?: number
  /** 该工作区按本地日期分账。 */
  byDay?: Record<string, DayBucket>
  tokensBeforeTotal: number
  tokensAfterTotal: number
  updatedAt: string
}

export interface SavingsSnapshot {
  schemaVersion: 5
  /** 记账口径版本；口径变了就 +1，消费方必须丢弃旧口径的累计。 */
  accountingVersion: number
  /** 每次插件 apply 生成的新账本 id；消费方看到新 id 必须「替换」而不是累加。 */
  ledgerId: string
  /** 同一账本内每次写盘递增，用于消费方去重。 */
  revision: number
  startedAt: string
  updatedAt: string
  /** 兼容字段：真实口径的 token 节省（Σ 每请求 before − after），可直接对账。 */
  totalSavedTokens: number
  /** 归因总量：各模块因果节省之和，仅用于解释来源，不可与 totalSavedTokens 相加。 */
  causalReductions?: number
  byModule: Record<SavingsModule, number>
  /** 每个模块的原始大小（byModule 的节省 / byModuleBefore 原值 = 压缩率）。 */
  byModuleBefore: Record<SavingsModule, number>
  perRequestSavings: number
  eventSavings: number
  contextReduction: number
  /** 缓存感知的估算成本节省（单位：miss-token 等价）。 */
  estimatedCostTokens: number
  /** Σ 每次请求「未压缩时的 prompt token」。 */
  tokensBeforeTotal: number
  /** Σ 每次请求「压缩后实际发送的 prompt token」。 */
  tokensAfterTotal: number
  /** 目前 before/after 只覆盖 schema 维度，按估算标注。 */
  tokensBeforeTotalEstimated: true
  /** 按工作区分账。 */
  byWorkspace: Record<string, WorkspaceSavingsSnapshot>
  /** 会话 → 工作区 id，供客户端按会话定位自己的工作区（无需解析路径）。 */
  bySession: Record<string, string>
  /** 全局按日分账（日期新→旧）；含从日志补齐、无工作区归属的部分。 */
  byDay: Record<string, DayBucket>
  /**
   * 金额（CNY）：逐轮累加，每轮用该轮实测命中率与峰谷价单独计价。
   * 不做「先汇总 token 再乘平均单价」，因为命中率与峰谷价都不是线性的。
   */
  money?: {
    currency: 'CNY'
    total: number
    basis: {
      mode: 'per-turn'
      /** 参与计价的轮次数。 */
      turns: number
      /** 各轮「省下的命中 token」之和。 */
      savedHitTokens: number
      /** 各轮「省下的未命中 token」之和。 */
      savedMissTokens: number
      /** 加权有效命中率 = savedHitTokens / (savedHitTokens + savedMissTokens)。 */
      effectiveHitRate: number | null
      hit: number
      miss: number
    }
  }
  events: number
  folds: number
  rejectedByAnchor: number
  lastEvents: SavingsEvent[]
}

const MAX_EVENTS = 20
/**
 * 记账口径版本 2：`saved` 改为真实的 token 差（v1 曾把字符数当 token 记账，
 * 虚增约 4 倍）。面板据此丢弃旧口径的当日累计，不把两个口径加在一起。
 */
export const ACCOUNTING_VERSION = 5
const CACHE_HIT_PRICE = 1
const CACHE_MISS_PRICE = 30
const UNKNOWN_WORKSPACE = workspaceRef('(unknown)')

interface WorkspaceAgg {
  ref: WorkspaceRef
  byModule: Record<SavingsModule, number>
  byModuleBefore: Record<SavingsModule, number>
  events: number
  folds: number
  tokensBefore: number
  tokensAfter: number
  /** 逐轮计价的累计金额（CNY）：每轮按该轮实测命中率与峰谷价单独算，再相加。 */
  moneyCny: number
  /** 被省下来的 token 中，按命中价/未命中价分别计了多少（用于反算有效命中率）。 */
  moneyHitTokens: number
  moneyMissTokens: number
  /** 被省下来的输出 token 累计（与上面两项一起构成金额的三个分量）。 */
  moneyOutTokens: number
  /** 参与计价的轮次数。 */
  moneyTurns: number
  /** 逐轮累计的真实花费（CNY），与 moneyCny 同源同口径。 */
  moneyActualCny: number
  /** 按本地日期分账：{ "2026-11-14": {...} }。 */
  byDay: Map<string, DayBucket>
  updatedAt: number
}

/** 一轮 LLM 调用的计价输入，由 billing 侧按该轮 usage 算好后写入。 */
export interface TurnMoneyInput {
  /** 该轮省下的钱：Σ(省下的命中 token × 命中价 + 省下的未命中 token × 未命中价 + 省下的输出 token × 输出价)。 */
  savedCny: number
  savedHitTokens: number
  savedMissTokens: number
  /** 该轮省下的输出 token（effort 降档的反事实输出量）；缺省按 0 计。 */
  savedOutTokens?: number
  /** 该轮真实花费（CNY）；用于算「省下 / (省下 + 实花)」这个可审计的百分比。 */
  actualCny?: number
  /** 归属日期（本地 `YYYY-MM-DD`）；缺省由 `dayKeyOf()` 取当前时刻。 */
  dayKey?: string
  /** 该轮实测命中率（hitTokens / promptTokens）。 */
  hitRate: number
  /** 该轮所处的计价时段，便于面板解释峰谷差异。 */
  window?: 'peak' | 'offpeak' | string
}

function emptyModuleRecord(): Record<SavingsModule, number> {
  return { admission: 0, extraction: 0, dedup: 0, fold: 0, schema: 0, rewrite: 0 }
}


export class SavingsLedger {
  private readonly ledgerId = randomUUID()
  private revision = 0
  private startedAt = Date.now()
  private updatedAt = Date.now()
  private readonly workspaces = new Map<string, WorkspaceAgg>()
  private readonly bySession = new Map<string, string>()
  private readonly lastEvents: SavingsEvent[] = []
  /** 全局按日分账（含从日志补齐、无工作区归属的部分）；各工作区的 byDay 是其子集。 */
  private readonly days = new Map<string, DayBucket>()
  private rejected = 0

  /** 记录会话归属，便于消费方按 sessionId 找到对应工作区。 */
  recordSession(sessionId: string, ref: WorkspaceRef): void {
    const id = String(sessionId || '')
    if (!id) return
    if (this.bySession.get(id) === ref.id) return
    this.bySession.set(id, ref.id)
    this.aggFor(ref)
    this.revision += 1
  }

  private aggFor(ref: WorkspaceRef): WorkspaceAgg {
    let agg = this.workspaces.get(ref.id)
    if (!agg) {
      agg = this.emptyAgg(ref)
      this.workspaces.set(ref.id, agg)
      // 这个工作区此前只有日志归因那一行（`log:` 前缀），真跑起来后把它的账并过来，
      // 合并成一行，面板里不会出现同名两条。
      const label = typeof ref.label === 'string' ? ref.label : ''
      const logOnlyId = `log:${label}`
      const donated = label && logOnlyId !== ref.id ? this.workspaces.get(logOnlyId) : undefined
      if (donated) {
        agg.byDay = donated.byDay
        agg.tokensBefore += donated.tokensBefore
        agg.moneyCny += donated.moneyCny
        agg.moneyActualCny += donated.moneyActualCny
        agg.moneyTurns += donated.moneyTurns
        agg.updatedAt = Date.now()
        this.workspaces.delete(logOnlyId)
      }
    }
    return agg
  }

  /** 建一条空的工作区账。 */
  private emptyAgg(ref: WorkspaceRef): WorkspaceAgg {
    return {
      ref,
      byModule: emptyModuleRecord(),
      byModuleBefore: emptyModuleRecord(),
      events: 0,
      folds: 0,
      tokensBefore: 0,
      tokensAfter: 0,
      moneyCny: 0,
      moneyHitTokens: 0,
      moneyMissTokens: 0,
      moneyOutTokens: 0,
      moneyTurns: 0,
      moneyActualCny: 0,
      byDay: new Map<string, DayBucket>(),
      updatedAt: Date.now(),
    }
  }

  record(
    module: SavingsModule,
    tokens: number,
    detail = '',
    workspace?: WorkspaceRef,
    beforeTokens?: number,
  ): void {
    const value = Math.max(0, Math.round(tokens))
    if (value <= 0) return
    const before = Math.max(value, Math.round(beforeTokens ?? value))
    const ref = workspace ?? UNKNOWN_WORKSPACE
    const agg = this.aggFor(ref)
    agg.byModule[module] += value
    agg.byModuleBefore[module] += before
    agg.events += 1
    agg.updatedAt = Date.now()
    this.revision += 1
    this.updatedAt = Date.now()
    this.lastEvents.push({ ts: new Date().toISOString(), module, tokens: value, detail, workspace: ref.label })
    if (this.lastEvents.length > MAX_EVENTS) this.lastEvents.shift()
  }

  /** 记录一次请求的 prompt token（压缩前/后）；只计统计，不产生“节省事件”。 */
  recordRequestTokens(workspace: WorkspaceRef | undefined, beforeTokens: number, afterTokens: number): void {
    const before = Math.max(0, Math.round(beforeTokens))
    const after = Math.max(0, Math.min(before, Math.round(afterTokens)))
    if (before <= 0 && after <= 0) return
    const agg = this.aggFor(workspace ?? UNKNOWN_WORKSPACE)
    agg.tokensBefore += before
    agg.tokensAfter += after
    agg.updatedAt = Date.now()
    this.revision += 1
    this.updatedAt = Date.now()
  }

  /**
   * 记录一轮 LLM 调用的金额。
   *
   * 必须逐轮记账，不能先汇总 token 再乘平均命中率：每一轮的命中率不同，
   * 峰谷价也不同，两者都是非线性的，事后平均会把误差抹进结果里。
   */
  recordTurn(workspace: WorkspaceRef | undefined, input: TurnMoneyInput): void {
    const savedCny = Number(input.savedCny)
    if (!Number.isFinite(savedCny) || savedCny <= 0) return
    const agg = this.aggFor(workspace ?? UNKNOWN_WORKSPACE)
    agg.moneyCny += savedCny
    agg.moneyHitTokens += Math.max(0, Math.round(Number(input.savedHitTokens) || 0))
    agg.moneyMissTokens += Math.max(0, Math.round(Number(input.savedMissTokens) || 0))
    agg.moneyOutTokens += Math.max(0, Math.round(Number(input.savedOutTokens) || 0))
    const actualCny = Number(input.actualCny)
    if (Number.isFinite(actualCny) && actualCny > 0) agg.moneyActualCny += actualCny
    agg.moneyTurns += 1
    const dayKey = input.dayKey || dayKeyOf()
    if (dayKey) {
      const delta = {
        savedTokens: input.savedHitTokens + (input.savedMissTokens ?? 0),
        savedOutTokens: input.savedOutTokens ?? 0,
        savedMoney: savedCny,
        actualMoney: actualCny > 0 ? actualCny : 0,
        turns: 1,
      }
      addToDay(agg.byDay, dayKey, delta)
      addToDay(this.days, dayKey, delta)
    }
    agg.updatedAt = Date.now()
    this.revision += 1
    this.updatedAt = Date.now()
  }

  noteFold(workspace?: WorkspaceRef): void {    this.aggFor(workspace ?? UNKNOWN_WORKSPACE).folds += 1
    this.revision += 1
  }

  noteRejected(): void {
    this.rejected += 1
    this.revision += 1
  }

  private totalSaved(): number {
    let total = 0
    for (const agg of this.workspaces.values()) {
      for (const value of Object.values(agg.byModule)) total += value
    }
    return total
  }

  /**
   * 用 `billing.recorded` 日志补齐「尚无记录」的日期（重启后当日数据不中断）。
   *
   * 只补**缺失**的日期（`mergeMissingDays`），绝不会与实时记账重叠。
   * 工作区维度只认日志行里自带的 `workspace` 字段：早期日志没有这个字段，
   * 那部分老实计入「未归属」，绝不按比例摊派——摊派就是估算。
   */
  seedDaysFromLog(text: string): number {
    const parsed = parseBillingLogAttributed(text)
    if (parsed.days.size === 0) return 0
    const added = mergeMissingDays(this.days, parsed.days)
    // 日志里带了工作区的，按 label 归到对应工作区。
    if (parsed.byWorkspace.size > 0) {
      for (const agg of this.workspaces.values()) {
        const label = agg.ref && typeof agg.ref.label === 'string' ? agg.ref.label : ''
        if (!label) continue
        const bucketMap = parsed.byWorkspace.get(label)
        if (!bucketMap) continue
        this.fillAggFromDays(agg, bucketMap)
        parsed.byWorkspace.delete(label)
      }
      // 账本里还没有的工作区：按日志的归因先立一行。否则面板里每个工作区都靠
      // 自己的 id 去查当日桶，查不到就一律显示 0——看起来就是「所有工作区同数」。
      for (const [label, bucketMap] of parsed.byWorkspace) {
        if (!label || label === UNKNOWN_WORKSPACE.label) continue
        this.fillAggFromDays(this.logRefFor(label), bucketMap)
      }
    }
    return added
  }

  /** 把日志里某几天的桶补进工作区；只有真正新增的日期才计入累计，避免重复累加。 */
  private fillAggFromDays(agg: WorkspaceAgg, bucketMap: Map<string, DayBucket>): number {
    let added = 0
    for (const [day, bucket] of bucketMap) {
      if (agg.byDay.has(day)) continue
      addToDay(agg.byDay, day, bucket)
      agg.moneyCny += Math.max(0, Number(bucket.savedMoney ?? 0))
      agg.moneyActualCny += Math.max(0, Number(bucket.actualMoney ?? 0))
      agg.moneyTurns += Math.max(0, Number(bucket.turns ?? 0))
      agg.tokensBefore += Math.max(0, Number(bucket.savedTokens ?? 0))
      added += 1
    }
    if (added > 0) agg.updatedAt = Date.now()
    return added
  }

  /** 只由日志归因立起来的工作区行（还没有任何会话真跑过）。 */
  private logRefFor(label: string): WorkspaceAgg {
    const id = `log:${label}`
    let agg = this.workspaces.get(id)
    if (agg) return agg
    agg = this.emptyAgg({ id, path: label, label })
    this.workspaces.set(id, agg)
    return agg
  }

  /** 从上次运行的 savings.json 恢复累计（同一工作区跨重启延续，不再每次归零）。 */
  restore(snapshot: any): boolean {
    if (!snapshot || typeof snapshot !== 'object') return false
    if (Number(snapshot.schemaVersion ?? 0) < 5) return false
    // 旧账本（accountingVersion < 3）把归因量与真实量混在一起累计，
    // 恢复它们会把虚高值带进新一轮，因此拒绝并重新开始。
    if (Number(snapshot.accountingVersion ?? 0) < ACCOUNTING_VERSION) return false
    const byWorkspace = snapshot.byWorkspace
    if (!byWorkspace || typeof byWorkspace !== 'object') return false
    let restored = 0
    for (const [id, raw] of Object.entries(byWorkspace as Record<string, any>)) {
      if (!raw || typeof raw !== 'object') continue
      const agg = this.aggFor({ id, path: String(raw.workspace ?? `(unknown)`), label: String(raw.label ?? `(unknown)`) })
      for (const key of Object.keys(agg.byModule) as SavingsModule[]) {
        agg.byModule[key] += Math.max(0, Math.round(Number(raw.byModule?.[key] ?? 0)))
        agg.byModuleBefore[key] += Math.max(0, Math.round(Number(raw.byModuleBefore?.[key] ?? 0)))
      }
      agg.events += Math.max(0, Math.round(Number(raw.events ?? 0)))
      agg.folds += Math.max(0, Math.round(Number(raw.folds ?? 0)))
      agg.tokensBefore += Math.max(0, Math.round(Number(raw.tokensBeforeTotal ?? 0)))
      agg.tokensAfter += Math.max(0, Math.round(Number(raw.tokensAfterTotal ?? 0)))
      // 逐轮计的金额同样要跨重启延续，否则面板金额每次重启都归零。
      agg.moneyCny += Math.max(0, Number(raw.moneyCny ?? 0))
      agg.moneyTurns += Math.max(0, Math.round(Number(raw.moneyTurns ?? 0)))
      agg.moneyHitTokens += Math.max(0, Math.round(Number(raw.moneyHitTokens ?? 0)))
      agg.moneyMissTokens += Math.max(0, Math.round(Number(raw.moneyMissTokens ?? 0)))
      agg.moneyOutTokens += Math.max(0, Math.round(Number(raw.moneyOutTokens ?? 0)))
      agg.moneyActualCny += Math.max(0, Number(raw.moneyActualCny ?? 0))
      readDays(agg.byDay, raw.byDay)
      restored += 1
    }
    if (restored === 0) return false
    // 全局日账：优先用顶层 byDay（含补齐部分）；缺失时退化为各工作区之和。
    if (!readDays(this.days, snapshot.byDay)) {
      for (const agg of this.workspaces.values()) {
        for (const [day, bucket] of agg.byDay) addToDay(this.days, day, bucket)
      }
    }
    if (snapshot.bySession && typeof snapshot.bySession === 'object') {
      for (const [sessionId, workspaceId] of Object.entries(snapshot.bySession as Record<string, unknown>)) {
        if (typeof sessionId === 'string' && typeof workspaceId === 'string') {
          this.bySession.set(sessionId, workspaceId)
        }
      }
    }
    if (typeof snapshot.startedAt === 'string') {
      const started = Date.parse(snapshot.startedAt)
      if (Number.isFinite(started)) this.startedAt = started
    }
    this.revision = Math.max(0, Math.round(Number(snapshot.revision ?? 0)))
        this.rejected = Math.max(0, Math.round(Number(snapshot.rejectedByAnchor ?? 0)))
    this.updatedAt = Date.now()
    return true
  }

  private sumMoney(prices?: { hit: number; miss: number }): SavingsSnapshot['money'] {
    let total = 0
    let savedHitTokens = 0
    let savedMissTokens = 0
    let turns = 0
    for (const agg of this.workspaces.values()) {
      total += agg.moneyCny
      savedHitTokens += agg.moneyHitTokens
      savedMissTokens += agg.moneyMissTokens
      turns += agg.moneyTurns
    }
    if (turns === 0 && total === 0) return undefined
    const denom = savedHitTokens + savedMissTokens
    return {
      currency: 'CNY',
      total: Math.round(total * 1e6) / 1e6,
      basis: {
        mode: 'per-turn',
        turns,
        savedHitTokens,
        savedMissTokens,
        effectiveHitRate: denom > 0 ? Math.round((savedHitTokens / denom) * 10000) / 10000 : null,
        hit: prices?.hit ?? 0.02,
        miss: prices?.miss ?? 1,
      },
    }
  }

  snapshot(prices?: { hit: number; miss: number; cacheHitRate?: number }): SavingsSnapshot {
    const byWorkspace: Record<string, WorkspaceSavingsSnapshot> = {}
    const byModule = emptyModuleRecord()
    const byModuleBefore = emptyModuleRecord()
    let totalSavedTokens = 0
    let events = 0
    let folds = 0
    let tokensBeforeTotal = 0
    let tokensAfterTotal = 0

    for (const [id, agg] of this.workspaces) {
      const causal = Object.values(agg.byModule).reduce((sum, value) => sum + value, 0)
      // 唯一真实口径：Σ(每次请求的 before − after)。这是「本来要计费的 token 少发了多少」，
      // 可直接对账；byModule 只是归因，不能再叠加到它上面（否则同一段历史会被重复计一次）。
      const realSaved = Math.max(0, agg.tokensBefore - agg.tokensAfter)
      const eventSavings = agg.byModule.admission + agg.byModule.extraction + agg.byModule.dedup
      const estimatedCostTokens =
        Math.round((agg.byModule.schema * CACHE_HIT_PRICE) / CACHE_MISS_PRICE) + eventSavings
      byWorkspace[id] = {
        workspace: agg.ref.path,
        label: agg.ref.label,
        totalSavedTokens: realSaved,
        causalReductions: causal,
        estimatedCostTokens,
        perRequestSavings: agg.byModule.schema,
        eventSavings,
        contextReduction: agg.byModule.fold,
        byModule: { ...agg.byModule },
        byModuleBefore: { ...agg.byModuleBefore },
        events: agg.events,
        folds: agg.folds,
        moneyCny: Math.round(agg.moneyCny * 1e6) / 1e6,
        moneyTurns: agg.moneyTurns,
        moneyHitTokens: agg.moneyHitTokens,
        moneyMissTokens: agg.moneyMissTokens,
        moneyOutTokens: agg.moneyOutTokens,
        moneyActualCny: Math.round(agg.moneyActualCny * 1e6) / 1e6,
        byDay: daysToRecord(agg.byDay),
        tokensBeforeTotal: agg.tokensBefore,
        tokensAfterTotal: agg.tokensAfter,
        updatedAt: new Date(agg.updatedAt).toISOString(),
      }
      totalSavedTokens += realSaved
      events += agg.events
      folds += agg.folds
      tokensBeforeTotal += agg.tokensBefore
      tokensAfterTotal += agg.tokensAfter
      for (const key of Object.keys(byModule) as SavingsModule[]) {
        byModule[key] += agg.byModule[key]
        byModuleBefore[key] += agg.byModuleBefore[key]
      }
    }
    const causalReductions = Object.values(byModule).reduce((sum, value) => sum + value, 0)

    const eventSavings = byModule.admission + byModule.extraction + byModule.dedup
    const estimatedCostTokens =
      Math.round((byModule.schema * CACHE_HIT_PRICE) / CACHE_MISS_PRICE) + eventSavings

    return {
      schemaVersion: 5,
      /**
       * 记账口径版本。语义一变（例如「saved 从字符改成 token」）就必须 +1：
       * 面板按这个值判废，避免把旧口径的累计数和新口径的累加到一起。
       */
      accountingVersion: ACCOUNTING_VERSION,
      ledgerId: this.ledgerId,
      revision: this.revision,
      startedAt: new Date(this.startedAt).toISOString(),
      updatedAt: new Date(this.updatedAt).toISOString(),
      totalSavedTokens,
      /** 归因总量（仅解释「为什么少了」，与 totalSavedTokens 不可相加）。 */
      causalReductions,
      byModule,
      byModuleBefore,
      perRequestSavings: byModule.schema,
      eventSavings,
      contextReduction: byModule.fold,
      estimatedCostTokens,
      tokensBeforeTotal,
      tokensAfterTotal,
      tokensBeforeTotalEstimated: true,
      byWorkspace,
      bySession: Object.fromEntries(this.bySession),
      byDay: daysToRecord(this.days),
      money: this.sumMoney(prices),
      events,
      folds,
      rejectedByAnchor: this.rejected,
      lastEvents: [...this.lastEvents],
    }
  }

  /** Markdown 面板：按模块汇总 + 按工作区 + 最近事件。 */
  renderMarkdown(): string {
    const snapshot = this.snapshot()
    const moduleRows = (Object.keys(snapshot.byModule) as SavingsModule[])
      .map((key) => {
        const saved = snapshot.byModule[key]
        const before = snapshot.byModuleBefore[key]
        const rate = before > 0 ? `${((saved / before) * 100).toFixed(1)}%` : '-'
        return `| ${key} | ${saved} | ${before} | ${rate} |`
      })
      .join('\n')
    const workspaceRows = Object.values(snapshot.byWorkspace)
      .map(
        (workspace) =>
          `| ${workspace.label} | ${workspace.totalSavedTokens} | ${workspace.estimatedCostTokens} | ${workspace.events} |`,
      )
      .join('\n')
    const events = snapshot.lastEvents
      .slice(-10)
      .map((event) => `| ${event.ts} | ${event.workspace ?? '-'} | ${event.module} | ${event.tokens} | ${event.detail} |`)
      .join('\n')

    const raito =
      snapshot.tokensBeforeTotal > 0
        ? `${((1 - snapshot.tokensAfterTotal / snapshot.tokensBeforeTotal) * 100).toFixed(2)}%`
        : 'n/a'

    return [
      '# Token Savings',
      '',
      `- updated: ${snapshot.updatedAt}`,
      `- ledgerId: ${snapshot.ledgerId} (revision ${snapshot.revision})`,
      `- started: ${snapshot.startedAt}`,
      `- prompt tokens removed: **${snapshot.totalSavedTokens}**`,
      `- 按请求累计（schema）: ${snapshot.perRequestSavings}`,
      `- 单次事件（admission/extraction/dedup）: ${snapshot.eventSavings}`,
      `- 一次性上下文缩减（fold）: ${snapshot.contextReduction}`,
      `- 缓存感知估算成本节省（miss-token 等价）: **${snapshot.estimatedCostTokens}**`,
      `- tokens before/after: ${snapshot.tokensBeforeTotal} / ${snapshot.tokensAfterTotal}（压缩比 ${raito}，估算）`,
      `- events: ${snapshot.events} | folds: ${snapshot.folds} | rejected by CacheAnchor: ${snapshot.rejectedByAnchor}`,
      '',
      '> 口径说明：totalSavedTokens 是「prompt 中少发的 token 数」，不是账单。',
      '> schema 位于缓存前缀（价格 1/30），extraction/admission/dedup 是新 token（价格 1）。',
      '> 消费方必须以 ledgerId 识别新账本：新 id 时必须「替换」而不是累加。',
      '',
      '## By module',
      '',
      '| module | tokens saved | before | rate |',
      '|---|---:|---:|---:|',
      moduleRows,
      '',
      '## By workspace',
      '',
      '| workspace | prompt tokens removed | est. cost | events |',
      '|---|---:|---:|---:|',
      workspaceRows || '| - | 0 | 0 | 0 |',
      '',
      '## Recent events',
      '',
      '| time | workspace | module | tokens | detail |',
      '|---|---|---|---:|---|',
      events || '| - | - | - | 0 | (no events yet) |',
      '',
    ].join('\n')
  }
}


