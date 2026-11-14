// Daily savings accumulator.
//
// The producer's ledger (`savings.json`) is **per host process**: it starts at
// zero on every DSH restart and it writes to the process cwd, so one profile's
// file only covers the sessions that ran in that process. A number that resets
// on every restart is useless as a "how much did I save today" figure, so the
// widget keeps its own day-scoped accumulator.
//
// Model: every observation is a *generation* of one source file, identified by
// the producer's `startedAt`. Today's contribution of a generation is its
// current total minus the total it already had when we first saw it today:
//
//   - a process that started today contributes its whole total;
//   - a process that was already running when the day began contributes only
//     what it grew since we first saw it (its earlier tokens belong to an
//     earlier day and cannot be split any finer than that).
//
// The state is a small JSON file under $DSH_HOME, so it survives restarts and
// is shared by every surface of this widget.
//
// Failure policy: an unreadable/corrupt state file starts a fresh day. Losing
// one day's accumulator is annoying; refusing to render is worse.

import fs from 'node:fs'

export const DAILY_FILE = '.dshw-savings-day.json'
const MAX_SOURCES = 32

export function localDayKey(ms = Date.now()) {
  const d = new Date(ms)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return d.getFullYear() + '-' + m + '-' + day
}

/** Coerce to a finite number, falling back to `fallback` for anything else. */
function numberOr(value, fallback) {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

/**
 * 记账口径版本。改动「token 怎么算」时必须 +1，日累计会自动作废重来。
 *
 * 起因：2026-11-12 之前 producer 把「字符差」当成「token 差」上报，日累计把旧数值
 * 和修好之后的数值加在一起，面板显示 66.6%，而两份数据各自都算得对。
 * 只要口径变了就必须断代，否则面板永远是两次不同记账的混合平均。
 */
export const ACCOUNTING_VERSION = 2

export function emptyDay(date) {
  return {
    v: 2,
    date,
    accountingVersion: ACCOUNTING_VERSION,
    total: 0,
    cost: 0,
    before: 0,
    after: 0,
    modules: {},
    resetStamp: null,
    sources: {},
    updatedAt: null,
  }
}

function readModules(byModule) {
  const out = {}
  if (!byModule || typeof byModule !== 'object' || Array.isArray(byModule)) return out
  for (const [name, value] of Object.entries(byModule)) {
    const num = Number(value)
    if (!Number.isFinite(num) || num < 0) continue
    out[name] = Math.round(num)
  }
  return out
}

/**
 * Fold one round of observations into the day state.
 *
 * @param {object} state previous state (from loadDay) or null
 * @param {Array<{key: string, generation?: string, startedAt?: string, total: number, cost?: number, byModule?: object, updatedMs?: number|null}>} observations
 * @param {string} today local day key
 * @returns {{state: object, changed: boolean}}
 */
/** Read one field of the observation's money block, defaulting to 0. */
function thisBill(observation, field) {
  // Observations carry flat keys (billActual / billCounterfactual / billRequests);
  // an earlier revision also accepted a nested `bill` object. Read both, because
  // the mismatch silently summed every money column to 0 and the card showed no
  // money at all while the tokens were still counted.
  if (!observation || typeof observation !== 'object') return 0
  const nested = observation.bill
  if (nested && Number.isFinite(nested[field]) && nested[field] >= 0) return nested[field]
  const flat = observation['bill' + field.charAt(0).toUpperCase() + field.slice(1)]
  return Number.isFinite(flat) && flat >= 0 ? flat : 0
}

export function recordDay(state, observations, today, accountingVersion = ACCOUNTING_VERSION) {
  const version = Number.isFinite(Number(accountingVersion)) ? Number(accountingVersion) : ACCOUNTING_VERSION
  const sameEpoch = Math.max(version, ACCOUNTING_VERSION)
  const base =
    state && state.date === today && typeof state === 'object' && Number(state.accountingVersion ?? 1) >= sameEpoch
      ? state
      : emptyDay(today)
  const next = {
    v: 2,
    accountingVersion: sameEpoch,
    date: today,
    total: 0,
    cost: 0,
    before: 0,
    after: 0,
    modules: {},
    billActual: 0,
    billCounterfactual: 0,
    billRequests: 0,
    resetStamp: base.resetStamp || null,
    sources: { ...(base.sources || {}) },
    updatedAt: base.updatedAt || null,
  }
  let changed = base !== state
  const list = Array.isArray(observations) ? observations : []
  for (const observation of list) {
    if (!observation || typeof observation.key !== 'string') continue
    const total = Number(observation.total)
    if (!Number.isFinite(total) || total < 0) continue
    const costNumber = Number(observation.cost)
    const cost = Number.isFinite(costNumber) && costNumber >= 0 ? Math.round(costNumber) : Math.round(total)
    const beforeNumber = Number(observation.before)
    const before = Number.isFinite(beforeNumber) && beforeNumber >= 0 ? Math.round(beforeNumber) : 0
    const afterNumber = Number(observation.after)
    const after = Number.isFinite(afterNumber) && afterNumber >= 0 ? Math.round(afterNumber) : 0
    const byModule = readModules(observation.byModule)
    const startedAt = typeof observation.startedAt === 'string' ? observation.startedAt : ''
    // The producer's ledgerId is the authoritative identity of one ledger
    // generation ("a new id must be replaced, not accumulated"). `startedAt` is
    // the fallback for snapshots that predate it.
    const generation = typeof observation.generation === 'string' && observation.generation.length > 0
      ? observation.generation
      : startedAt
    const generationKey = observation.key + '\u0000' + generation
    const previous = next.sources[generationKey]

    if (!previous) {
      // First sight of this generation today. A ledgerId is minted per apply, so
      // its first snapshot already belongs to this generation; a bare
      // `startedAt` that predates today only counts its growth from here on.
      const freshLedger = generation !== startedAt
      const startedToday = startedAt !== '' && localDayKey(Date.parse(startedAt)) === today
      const countWhole = freshLedger || startedToday
      next.sources[generationKey] = {
        startedAt,
        baselineTotal: countWhole ? 0 : Math.round(total),
        baselineCost: countWhole ? 0 : cost,
        baselineBefore: countWhole ? 0 : before,
        baselineAfter: countWhole ? 0 : after,
        baselineModules: countWhole ? {} : byModule,
        lastTotal: Math.round(total),
        lastCost: cost,
        lastBefore: before,
        lastAfter: after,
        lastModules: byModule,
        baselineBillActual: countWhole ? 0 : thisBill(observation, 'actual'),
        baselineBillCounterfactual: countWhole ? 0 : thisBill(observation, 'counterfactual'),
        baselineBillRequests: countWhole ? 0 : thisBill(observation, 'requests'),
        baselineBillSaved: countWhole ? 0 : thisBill(observation, 'saved'),
        baselineBillConsumed: countWhole ? 0 : thisBill(observation, 'consumed'),
        billActual: Number(observation.billActual) || 0,
        billCounterfactual: Number(observation.billCounterfactual) || 0,
        billRequests: Number(observation.billRequests) || 0,
        billSaved: Number(observation.billSaved) || 0,
        billConsumed: Number(observation.billConsumed) || 0,
        seenAt: observation.updatedMs || null,
      }
      changed = true
      continue
    }

    if (total > previous.lastTotal) {
      previous.lastTotal = Math.round(total)
      changed = true
    }

    // 每个进程的 realBill 是累计值，直接覆盖而不是累加：同一 source 的新快照
    // 已经包含旧的。之前只更新 total/modules，钱会永久停在第一次快照上。
    const nextActual = thisBill(observation, 'actual')
    const nextCounter = thisBill(observation, 'counterfactual')
    const nextRequests = thisBill(observation, 'requests')
    if (nextActual > (previous.billActual || 0)) {
      previous.billActual = nextActual
      changed = true
    }
    if (nextCounter > (previous.billCounterfactual || 0)) {
      previous.billCounterfactual = nextCounter
      changed = true
    }
    if (nextRequests > (previous.billRequests || 0)) {
      previous.billRequests = nextRequests
      changed = true
    }
    if (cost > previous.lastCost) {
      previous.lastCost = cost
      changed = true
    }
    const nextBill = thisBill(observation, 'actual')
    if (nextBill > (previous.billActual || 0)) {
      previous.billActual = nextBill
      previous.billCounterfactual = thisBill(observation, 'counterfactual')
      previous.billRequests = thisBill(observation, 'requests')
      changed = true
    }
    if (before > (previous.lastBefore || 0)) {
      previous.lastBefore = before
      changed = true
    }
    if (after > (previous.lastAfter || 0)) {
      previous.lastAfter = after
      changed = true
    }
    for (const [name, value] of Object.entries(byModule)) {
      if (value > (previous.lastModules[name] || 0)) {
        previous.lastModules = { ...previous.lastModules, [name]: value }
        changed = true
      }
    }
    if (observation.updatedMs) previous.seenAt = observation.updatedMs
    // The sum below reads billActual (not lastBill*), so an existing source must
    // refresh it too — otherwise a ledger created before this field existed keeps
    // contributing 0 money forever.
    const billA = Number(observation.billActual) || 0
    const liveSaved = Number(observation.billSaved) || 0
    if (liveSaved > (previous.billSaved || 0)) {
      previous.billSaved = liveSaved
      changed = true
    }
    const liveConsumed = Number(observation.billConsumed) || 0
    if (liveConsumed > (previous.billConsumed || 0)) {
      previous.billConsumed = liveConsumed
      changed = true
    }
    if (billA > (previous.billActual || 0)) {
      previous.billActual = billA
      changed = true
    }
    const billC = Number(observation.billCounterfactual) || 0
    if (billC > (previous.billCounterfactual || 0)) {
      previous.billCounterfactual = billC
      changed = true
    }
    const billR = Number(observation.billRequests) || 0
    if (billR > (previous.billRequests || 0)) {
      previous.billRequests = billR
      changed = true
    }
  }

  // Bound the file: keep the freshest sources only, then sum once.
  const keys = Object.keys(next.sources)
  if (keys.length > MAX_SOURCES) {
    const keep = new Set(
      keys
        .map((key) => ({ key, seen: Date.parse(next.sources[key].seenAt || '') || 0 }))
        .sort((a, b) => b.seen - a.seen)
        .slice(0, MAX_SOURCES)
        .map((entry) => entry.key),
    )
    for (const key of keys) {
      if (!keep.has(key)) delete next.sources[key]
    }
    changed = true
  }

  next.total = 0
  next.cost = 0
  next.before = 0
  next.after = 0
  next.billActual = 0
  next.billCounterfactual = 0
  next.billRequests = 0
  for (const source of Object.values(next.sources)) {
    // Generations recorded before a field existed simply contribute 0 to it —
    // never NaN. `undefined - 0` used to poison the whole sum into null.
    const baseTotal = numberOr(source.baselineTotal, 0)
    const lastTotal = numberOr(source.lastTotal, 0)
    next.total += Math.max(0, lastTotal - baseTotal)

    const baseCost = numberOr(source.baselineCost, 0)
    const lastCost = numberOr(source.lastCost, 0)
    next.cost += Math.max(0, lastCost - baseCost)

    const baseBefore = numberOr(source.baselineBefore, 0)
    const lastBefore = numberOr(source.lastBefore, 0)
    next.before += Math.max(0, lastBefore - baseBefore)

    const baseAfter = numberOr(source.baselineAfter, 0)
    const lastAfter = numberOr(source.lastAfter, 0)
    next.after += Math.max(0, lastAfter - baseAfter)

    next.billActual += Math.max(0, numberOr(source.billActual, 0) - numberOr(source.baselineBillActual, 0))
    next.billCounterfactual += Math.max(
      0,
      numberOr(source.billCounterfactual, 0) - numberOr(source.baselineBillCounterfactual, 0),
    )
    next.billRequests += Math.max(
      0,
      numberOr(source.billRequests, 0) - numberOr(source.baselineBillRequests, 0),
    )

    for (const [name, value] of Object.entries(source.lastModules || {})) {
      const baseline = numberOr(source.baselineModules?.[name], 0)
      const current = numberOr(value, 0)
      next.modules[name] = (next.modules[name] || 0) + Math.max(0, current - baseline)
    }
  }

  next.updatedAt = new Date().toISOString()
  return { state: next, changed }
}

/** Read the day state; any problem yields a fresh day rather than an error. */
export function loadDay(file, today, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  try {
    const parsed = JSON.parse(readFile(file))
    if (!parsed || typeof parsed !== 'object' || parsed.date !== today) return emptyDay(today)
    if (typeof parsed.total !== 'number' || !parsed.sources || typeof parsed.sources !== 'object') return emptyDay(today)
    return parsed
  } catch (err) {
    return emptyDay(today)
  }
}

/** Persist atomically (write + rename) so a crash cannot leave a torn file. */
export function saveDay(file, state, writeFile = fs.writeFileSync, rename = fs.renameSync) {
  const body = JSON.stringify(state)
  const temp = file + '.tmp'
  try {
    writeFile(temp, body, 'utf8')
    rename(temp, file)
    return true
  } catch (err) {
    try {
      writeFile(file, body, 'utf8')
      return true
    } catch (err2) {
      return false
    }
  }
}

/** The modules of a day state, sorted by value. */
export function dayModules(state) {
  if (!state || !state.modules || typeof state.modules !== 'object') return []
  return Object.entries(state.modules)
    .filter(([, value]) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => b[1] - a[1])
}

/** How many distinct generations/sources fed today's number. */
export function daySourceCount(state) {
  if (!state || !state.sources || typeof state.sources !== 'object') return 0
  return Object.keys(state.sources).length
}

/** Today's cache-aware cost-equivalent saving (miss-token equivalent). */
export function dayCost(state) {
  const value = Number(state && state.cost)
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0
}

/** Today's Σ prompt tokens before/after compression, for the savings ratio. */
export function dayBill(state) {
  let actual = 0
  let counterfactual = 0
  let requests = 0
  let saved = 0
  let consumed = 0
  const sources = (state && state.sources) || {}
  for (const key of Object.keys(sources)) {
    const s = sources[key] || {}
    actual += Math.max(0, (Number(s.billActual) || 0) - (Number(s.baselineBillActual) || 0))
    counterfactual += Math.max(
      0,
      (Number(s.billCounterfactual) || 0) - (Number(s.baselineBillCounterfactual) || 0),
    )
    requests += Math.max(0, (Number(s.billRequests) || 0) - (Number(s.baselineBillRequests) || 0))
    saved += Math.max(0, (Number(s.billSaved) || 0) - (Number(s.baselineBillSaved) || 0))
    consumed += Math.max(0, (Number(s.billConsumed) || 0) - (Number(s.baselineBillConsumed) || 0))
  }
  return { actual, counterfactual, requests, saved, consumed }
}

export function dayTokenTotals(state) {
  const before = Number(state && state.before)
  const after = Number(state && state.after)
  return {
    before: Number.isFinite(before) && before > 0 ? Math.round(before) : 0,
    after: Number.isFinite(after) && after >= 0 ? Math.round(after) : 0,
  }
}

/**
 * The day's module breakdown, weighted per generation.
 *
 * Weighting per generation (rather than summing raw deltas and weighting once)
 * is what makes the rows add up to the headline: a generation recorded before
 * the cost field existed still has raw module deltas, and `weight()` maps them
 * to their cost equivalent. `fold` is excluded — it is a one-off reduction, not
 * a per-request saving.
 *
 * @param {object} state day state
 * @param {(label: string, value: number) => number} weight per-module weigher
 * @returns {{total: number, modules: Record<string, number>, items: Array<[string, number]>}}
 */
export function dayModuleCosts(state, weight = (_label, value) => value) {
  const modules = {}
  for (const source of Object.values((state && state.sources) || {})) {
    for (const [name, value] of Object.entries(source.lastModules || {})) {
      if (name === 'fold') continue
      const baseline = numberOr(source.baselineModules?.[name], 0)
      const delta = Math.max(0, numberOr(value, 0) - baseline)
      if (delta <= 0) continue
      const weighted = numberOr(weight(name, delta), 0)
      if (weighted <= 0) continue
      modules[name] = (modules[name] || 0) + weighted
    }
  }
  const items = Object.entries(modules).sort((a, b) => b[1] - a[1])
  const total = items.reduce((sum, [, value]) => sum + value, 0)
  return { total, modules, items }
}
