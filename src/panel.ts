/**
 * 面板数据契约（host 半）。
 *
 * 这份文件只做两件事：
 *   1. 把已经写好盘的账本（savings.json）和本进程的 provider 实测账单，
 *      整理成**前端可以直接渲染**的扁平结构；
 *   2. 把一个只读 JSON 路由挂到 DSH 的 connection 上。
 *
 * 金额口径是严格公式，没有任何估算：
 *   省下的钱 = Σ(每个请求的 counterfactualCost − actualCost)
 * 其中 cost = miss×¥1/M + hit×¥0.02/M + output×¥4/M，三个 token 数全部来自
 * provider 返回的 usage，单价来自官方价目表。本文件只做加法，不重算价格。
 */

/** provider 账单的口径版本；与 savings-ledger 的 ACCOUNTING_VERSION 同步演进。 */
export const PANEL_SCHEMA_VERSION = 1

import { dayKeyOf, type DayBucket } from './modules/day-ledger'

export const PANEL_ROUTE = 'api/dsh-context-manager/summary'

export interface PanelWorkspaceRow {
  id: string
  label: string
  path: string
  /** 实测节省 token = savedHitTokens + savedMissTokens（来自 provider usage）。 */
  savedTokens: number
  savedHitTokens: number
  savedMissTokens: number
  /** 省下的输出 token（effort 降档的反事实输出量）；金额的第三个分量。 */
  savedOutTokens: number
  /** 按官方单价折算的金额（CNY）。 */
  savedMoney: number
  /** 逐轮累计的真实花费（CNY），与 savedMoney 同源同口径。 */
  actualMoney: number
  /** savedMoney / (savedMoney + actualMoney)，0–1。 */
  savedShare: number | null
  turns: number
  /** 省下的 token 里命中缓存的比例；越高说明省的越「便宜」。 */
  cachedShare: number
}

export interface PanelProcessBill {
  requests: number
  actualCost: number
  counterfactualCost: number
  savedCost: number
  reduction: number
  hitTokens: number
  missTokens: number
  outputTokens: number
  cacheHitRate: number
  removedTokens: number
  promptTokens: number
}

export interface PanelDayRow {
  id: string
  label: string
  path: string
  savedTokens: number
  savedOutTokens: number
  savedMoney: number
  actualMoney: number
  savedShare: number | null
  turns: number
}

export interface PanelDay {
  /** 本地日期 YYYY-MM-DD。 */
  date: string
  savedTokens: number
  savedOutTokens: number
  savedMoney: number
  actualMoney: number
  savedShare: number | null
  turns: number
  /** 按工作区拆分的当日数据；日志补齐的部分没有归属，不在其中。 */
  workspaces: PanelDayRow[]
  /** 无法归属到工作区的当日省下 token / 金额（来自日志补齐），显式暴露而不是摊派。 */
  unattributedTokens: number
  unattributedMoney: number
  /** 上面两项 + 轮次的合并形式，供 UI 直接消费。 */
  unattributed: { tokens: number; money: number; turns: number }
  /** 当日合计，字段与工作区行一致，便于 UI 用同一条渲染路径。 */
  totals: { savedTokens: number; savedOutTokens: number; savedMoney: number; actualMoney: number; savedShare: number | null; turns: number }
}

export interface PanelSummary {
  ok: true
  schema: number
  revision: number
  generatedAt: string
  /** 账本开始计时的时间；null 表示账本还没写过。 */
  since: string | null
  currency: 'CNY'
  totals: {
    savedTokens: number
    savedHitTokens: number
    savedMissTokens: number
    savedOutTokens: number
    savedMoney: number
    actualMoney: number
    savedShare: number | null
    turns: number
    cachedShare: number
  }
  /** 当日（本地时区）汇总；字段口径与 totals 一致，只是范围限定在今天。 */
  today: PanelDay
  /** 最近若干天的按日汇总，新→旧。 */
  days: PanelDay[]
  /** 按工作区分账，金额降序；面板的每个标签页对应一行。 */
  workspaces: PanelWorkspaceRow[]
  /** 本进程 provider 实测账单；没有记录时为 null。 */
  process: PanelProcessBill | null
  formula: {
    money: string
    tokens: string
    price: string
    note: string
  }
}

/** 单价表（元 / 百万 token）。低峰价；高峰翻倍由调用方在 usage 侧体现。 */
const PRICE = { miss: 1, hit: 0.02, output: 4 } as const

const FORMULA = {
  money:
    '省钱 = Σ 逐请求[(省下命中 token × ¥0.02/M) + (省下未命中 token × ¥1/M) + (省下输出 token × ¥4/M)]，高峰时段该请求单价 ×2',
  tokens: '省下 prompt token = 实际发出的 − 不压缩时应发出的（provider usage 实测换算）',
  price: `成本 = miss×¥${PRICE.miss}/M + hit×¥${PRICE.hit}/M + output×¥${PRICE.output}/M`,
  note: '三个 token 分量与金额均来自 provider 返回的 usage 与官方单价，可逐项复算；不含任何估算',
} as const

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function basename(target: string): string {
  const parts = target.split(/[\\/]/).filter((part) => part.length > 0)
  return parts.length > 0 ? (parts[parts.length - 1] as string) : ''
}

function ratio(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0
}

/**
 * 账本里的 byWorkspace → 面板行。
 *
 * 每行只读三个已落盘的字段，不再做任何二次推算，保证「标签页金额之和 == 总额」。
 */
function readWorkspaces(snapshot: any): PanelWorkspaceRow[] {
  const source = snapshot?.byWorkspace
  if (source === null || typeof source !== 'object') return []
  const rows: PanelWorkspaceRow[] = []
  for (const [id, raw] of Object.entries(source as Record<string, any>)) {
    const bucket = raw !== null && typeof raw === 'object' ? raw : {}
    const savedHitTokens = num(bucket.moneyHitTokens)
    const savedMissTokens = num(bucket.moneyMissTokens)
    const savedOutTokens = num(bucket.moneyOutTokens)
    const savedTokens = savedHitTokens + savedMissTokens
    const savedMoney = num(bucket.moneyCny)
    const actualMoney = num(bucket.moneyActualCny)
    const path = str(bucket.workspace)
    rows.push({
      id,
      label: str(bucket.label) || basename(path) || '(unknown)',
      path,
      savedTokens,
      savedHitTokens,
      savedMissTokens,
      savedOutTokens,
      savedMoney,
      actualMoney,
      /** 省下占「省下 + 实花」的比例；两个加数都是逐轮实测累加，没有估算项。 */
      savedShare: actualMoney > 0 ? ratio(savedMoney, savedMoney + actualMoney) : null,
      turns: num(bucket.moneyTurns),
      cachedShare: ratio(savedHitTokens, savedTokens),
    })
  }
  // 金额高的排前面，标签页顺序稳定（同额时按 id，避免抖动）。
  rows.sort((left, right) => right.savedMoney - left.savedMoney || left.id.localeCompare(right.id))
  return rows
}

/** 一天的账：来源只有账本自己落的 byDay，不做任何按比例摊派。 */
function readDayBucket(raw: any) {
  const bucket = raw !== null && typeof raw === 'object' ? raw : {}
  const savedTokens = num(bucket.savedTokens)
  const savedOutTokens = num(bucket.savedOutTokens)
  const savedMoney = num(bucket.savedMoney)
  const actualMoney = num(bucket.actualMoney)
  return {
    savedTokens,
    savedOutTokens,
    savedMoney,
    actualMoney,
    savedShare: actualMoney > 0 ? ratio(savedMoney, savedMoney + actualMoney) : null,
    turns: num(bucket.turns),
  }
}

function readProcessBill(bill: any): PanelProcessBill | null {  if (bill === null || typeof bill !== 'object') return null
  const requests = num(bill.requests)
  if (requests <= 0) return null
  const hitTokens = num(bill.hitTokens)
  const missTokens = num(bill.missTokens)
  const actualCost = num(bill.actualCost)
  const counterfactualCost = num(bill.counterfactualCost)
  return {
    requests,
    actualCost,
    counterfactualCost,
    savedCost: Math.max(0, counterfactualCost - actualCost),
    reduction: num(bill.reduction),
    hitTokens,
    missTokens,
    outputTokens: num(bill.outputTokens),
    cacheHitRate: ratio(hitTokens, hitTokens + missTokens),
    removedTokens: num(bill.removedTokens),
    promptTokens: num(bill.promptTokens),
  }
}

/**
 * 组装面板 payload。
 *
 * 入参是**已经算好的**账本快照和账单快照（依赖由调用方注入，方便离线单测）。
 * 未知字段一律降级成 0 / 空数组，绝不让面板因为字段缺失而白屏。
 */
/** 面板只展示最近两周，避免 payload 随账本无限增长。 */
const DAY_HISTORY_LIMIT = 14

function emptyDay(date: string): PanelDay {
  return {
    date,
    savedTokens: 0,
    savedOutTokens: 0,
    savedMoney: 0,
    actualMoney: 0,
    savedShare: null,
    turns: 0,
    workspaces: [],
    unattributedTokens: 0,
    unattributedMoney: 0,
    unattributed: { tokens: 0, money: 0, turns: 0 },
    totals: { savedTokens: 0, savedOutTokens: 0, savedMoney: 0, actualMoney: 0, savedShare: null, turns: 0 },
  }
}

function shareOf(saved: number, actual: number): number | null {
  const total = saved + actual
  return total > 0 && Number.isFinite(total) ? saved / total : null
}

/**
 * 按本地日期读日账。
 *
 * 口径与累计口径完全一致：`savedMoney` 是逐轮 `savedCost` 的加法，`savedTokens` 是
 * 逐轮 `removedPromptTokens` 的加法，`actualMoney` 是逐轮 `actualCost` 的加法。
 * 日志补齐的部分没有工作区归属，单独放进 `unattributed*`，不做任何按比例摊派。
 */
function readDays(snapshot: any, todayKey: string): { today: PanelDay; days: PanelDay[] } {
  const byDate = new Map<string, PanelDay>()
  const dayOf = (date: string): PanelDay => {
    const existing = byDate.get(date)
    if (existing) return existing
    const created = emptyDay(date)
    byDate.set(date, created)
    return created
  }

  const globalDays = snapshot && typeof snapshot.byDay === 'object' && snapshot.byDay !== null ? snapshot.byDay : {}
  for (const [date, bucket] of Object.entries(globalDays as Record<string, DayBucket>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const day = dayOf(date)
    day.savedTokens = num((bucket as DayBucket).savedTokens)
    day.savedOutTokens = num((bucket as DayBucket).savedOutTokens)
    day.savedMoney = num((bucket as DayBucket).savedMoney)
    day.actualMoney = num((bucket as DayBucket).actualMoney)
    day.turns = num((bucket as DayBucket).turns)
  }

  // 逐工作区归集；这些行一定也计入了全局日账，所以只用于「归属」，不再累加总额。
  const buckets = snapshot && typeof snapshot.byWorkspace === 'object' && snapshot.byWorkspace !== null ? snapshot.byWorkspace : {}
  for (const [id, bucket] of Object.entries(buckets as Record<string, any>)) {
    const perDay = bucket && typeof bucket.byDay === 'object' && bucket.byDay !== null ? bucket.byDay : {}
    for (const [date, dayBucket] of Object.entries(perDay as Record<string, DayBucket>)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
      const day = dayOf(date)
      const savedTokens = num((dayBucket as DayBucket).savedTokens)
      const savedMoney = num((dayBucket as DayBucket).savedMoney)
      if (savedTokens <= 0 && savedMoney <= 0) continue
      day.workspaces.push({
        id: String(id),
        label: typeof bucket.label === 'string' && bucket.label ? bucket.label : String(id),
        path: typeof bucket.workspace === 'string' ? bucket.workspace : '',
        savedTokens,
        savedOutTokens: num((dayBucket as DayBucket).savedOutTokens),
        savedMoney,
        actualMoney: num((dayBucket as DayBucket).actualMoney),
        savedShare: shareOf(savedMoney, num((dayBucket as DayBucket).actualMoney)),
        turns: num((dayBucket as DayBucket).turns),
      })
      // 只有全局日账缺失时（旧账本），才用工作区之和兜底，保证不出现「有明细没总额」。
      if (!(date in globalDays)) {
        day.savedTokens += savedTokens
        day.savedOutTokens += num((dayBucket as DayBucket).savedOutTokens)
        day.savedMoney += savedMoney
        day.actualMoney += num((dayBucket as DayBucket).actualMoney)
        day.turns += num((dayBucket as DayBucket).turns)
      }
    }
  }

  for (const day of byDate.values()) {
    day.savedShare = shareOf(day.savedMoney, day.actualMoney)
    day.workspaces.sort((left, right) => right.savedMoney - left.savedMoney || left.label.localeCompare(right.label))
    const attributedTokens = day.workspaces.reduce((sum, row) => sum + row.savedTokens, 0)
    const attributedMoney = day.workspaces.reduce((sum, row) => sum + row.savedMoney, 0)
    day.unattributedTokens = Math.max(0, day.savedTokens - attributedTokens)
    day.unattributedMoney = Math.max(0, Math.round((day.savedMoney - attributedMoney) * 1e6) / 1e6)
    const attributedTurns = day.workspaces.reduce((sum, row) => sum + row.turns, 0)
    day.unattributed = {
      tokens: day.unattributedTokens,
      money: day.unattributedMoney,
      turns: Math.max(0, day.turns - attributedTurns),
    }
    day.totals = {
      savedTokens: day.savedTokens,
      savedOutTokens: day.savedOutTokens,
      savedMoney: day.savedMoney,
      actualMoney: day.actualMoney,
      savedShare: day.savedShare,
      turns: day.turns,
    }
  }

  const days = [...byDate.values()].sort((left, right) => right.date.localeCompare(left.date)).slice(0, DAY_HISTORY_LIMIT)
  return { today: byDate.get(todayKey) ?? emptyDay(todayKey), days }
}

export function buildPanelSummary(input: {
  snapshot?: any
  bill?: any
  now?: number
}): PanelSummary {
  const snapshot = input.snapshot ?? null
  const workspaces = readWorkspaces(snapshot)

  let savedHitTokens = 0
  let savedMissTokens = 0
  let savedOutTokens = 0
  let savedMoney = 0
  let actualMoney = 0
  let turns = 0
  for (const row of workspaces) {
    savedHitTokens += row.savedHitTokens
    savedMissTokens += row.savedMissTokens
    savedOutTokens += row.savedOutTokens
    savedMoney += row.savedMoney
    actualMoney += row.actualMoney
    turns += row.turns
  }
  const savedTokens = savedHitTokens + savedMissTokens

  const generatedAt = new Date(input.now ?? Date.now()).toISOString()
  const dayView = readDays(snapshot, dayKeyOf(input.now ?? Date.now()))
  return {
    ok: true,
    schema: PANEL_SCHEMA_VERSION,
    revision: num(snapshot?.revision),
    generatedAt,
    since: str(snapshot?.startedAt) || null,
    currency: 'CNY',
    totals: { savedTokens, savedHitTokens, savedMissTokens, savedOutTokens, savedMoney, actualMoney, savedShare: actualMoney > 0 ? ratio(savedMoney, savedMoney + actualMoney) : null, turns, cachedShare: ratio(savedHitTokens, savedTokens) },
    workspaces,
    today: dayView.today,
    days: dayView.days,
    process: readProcessBill(input.bill),
    formula: { ...FORMULA },
  }
}

function jsonResponse(body: unknown): unknown {
  const text = JSON.stringify(body)
  const ResponseCtor = (globalThis as any).Response
  if (typeof ResponseCtor === 'function') {
    return new ResponseCtor(text, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } })
  }
  // 极老的宿主没有全局 Response；退化成最小可用形状。
  return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: text }
}

export interface PanelRouteHost {
  get?: (name: string) => any
  inject?: (deps: string[], fn: (connection: any) => unknown) => unknown
}

/**
 * 挂只读路由。
 *
 * 面板是可选功能：connection 服务不存在、或注册抛错，都只记一条日志，
 * 绝不影响压缩主链路（这里不抛异常）。
 */
export function registerPanelRoute(
  host: PanelRouteHost,
  read: () => PanelSummary,
  onError?: (message: string) => void,
  onMount?: (path: string) => void,
): () => void {
  let dispose: (() => void) | null = null

  /** 返回 null 表示这个 connection 形状不对，调用方应改用 inject 再试一次。 */
  const mount = (connection: any): (() => void) | null => {
    const registry = connection?.fetch
    if (registry === null || registry === undefined || typeof registry.register !== 'function') {
      return null
    }
    const path = PANEL_ROUTE.startsWith('/') ? PANEL_ROUTE : `/${PANEL_ROUTE}`
    const handle = registry.register({
      // 宿主按绝对路径匹配：必须带前导斜杠（对照 dsh-context 的 '/api/dsh-context/detail'）。
      // 客户端用相对地址 fetch('api/...')，由浏览器补成同源绝对路径。
      path,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: () => jsonResponse(read()),
    })
    onMount?.(path)
    if (typeof handle === 'function') {
      // 契约是 `() => Promise<void>`；必须吞掉 rejection，否则卸载时会冒未处理拒绝。
      return () => {
        try {
          const pending = (handle as () => unknown)()
          if (pending !== null && typeof (pending as any)?.then === 'function') {
            ;(pending as Promise<unknown>).then(undefined, () => {})
          }
        } catch {}
      }
    }
    return () => {
      try {
        handle?.dispose?.()
      } catch {}
    }
  }

  /** ctx.inject 的回调收到的是「带该服务的 context」，不是服务本身，必须再取一次。 */
  const serviceOf = (carrier: any): any =>
    carrier !== null && carrier !== undefined && typeof carrier.get === 'function'
      ? carrier.get('connection')
      : carrier

  try {
    const existing = typeof host.get === 'function' ? host.get('connection') : undefined
    if (existing !== null && existing !== undefined) {
      const mounted = mount(existing)
      if (mounted !== null) {
        dispose = mounted
        return () => dispose?.()
      }
    }
    if (typeof host.inject === 'function') {
      host.inject(['connection'], (carrier: any) => {
        const mounted = mount(serviceOf(carrier))
        if (mounted === null) onError?.('connection.fetch.register 不可用')
        else dispose = mounted
      })
      return () => dispose?.()
    }
    onError?.('connection 服务不可用')
  } catch (error) {
    onError?.(error instanceof Error ? error.message : String(error))
  }
  return () => {}
}
