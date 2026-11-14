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
  savedShare: number
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
    savedShare: number
    turns: number
    cachedShare: number
  }
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
      savedShare: actualMoney > 0 ? ratio(savedMoney, savedMoney + actualMoney) : 0,
      turns: num(bucket.moneyTurns),
      cachedShare: ratio(savedHitTokens, savedTokens),
    })
  }
  // 金额高的排前面，标签页顺序稳定（同额时按 id，避免抖动）。
  rows.sort((left, right) => right.savedMoney - left.savedMoney || left.id.localeCompare(right.id))
  return rows
}

function readProcessBill(bill: any): PanelProcessBill | null {
  if (bill === null || typeof bill !== 'object') return null
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
  return {
    ok: true,
    schema: PANEL_SCHEMA_VERSION,
    revision: num(snapshot?.revision),
    generatedAt,
    since: str(snapshot?.startedAt) || null,
    currency: 'CNY',
    totals: { savedTokens, savedHitTokens, savedMissTokens, savedOutTokens, savedMoney, actualMoney, savedShare: actualMoney > 0 ? ratio(savedMoney, savedMoney + actualMoney) : 0, turns, cachedShare: ratio(savedHitTokens, savedTokens) },
    workspaces,
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

  const mount = (connection: any): (() => void) => {
    const registry = connection?.fetch
    if (registry === null || registry === undefined || typeof registry.register !== 'function') {
      onError?.('connection.fetch.register 不可用')
      return () => {}
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
    if (typeof handle === 'function') return handle as () => void
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
      dispose = mount(existing)
      return () => dispose?.()
    }
    if (typeof host.inject === 'function') {
      host.inject(['connection'], (carrier: any) => {
        dispose = mount(serviceOf(carrier))
      })
      return () => dispose?.()
    }
    onError?.('connection 服务不可用')
  } catch (error) {
    onError?.(error instanceof Error ? error.message : String(error))
  }
  return () => {}
}
