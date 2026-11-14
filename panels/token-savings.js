// Token-savings panel source.
//
// Reads the snapshot that dsh-context-manager periodically writes
// (`savings.json`, plus a Markdown mirror `savings.md`), validates it, and
// turns it into one protocol-v1 metric panel: total + per-module breakdown.
//
// This module is intentionally defensive. The producer is another plugin in the
// same process, writing with a plain `writeFileSync` and no atomic rename, so a
// read can land on a half-written file. Behaviour:
//   - a successful parse yields a panel;
//   - the Markdown mirror is used when the JSON does not parse;
//   - a single failed round keeps the previous panel (no flicker from a torn
//     read); `failuresBeforeEmpty` consecutive failures publish "暂无数据";
//   - missing files, unusable shapes, and snapshots older than `staleAfterMs`
//     all publish "暂无数据" instead of throwing.
//
// Nothing in here throws into the host: every failure becomes a panel state.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { LIMITS, readNumber, stripBom } from './schema.js'
import { dayCost, dayModuleCosts, dayModules, daySourceCount, dayTokenTotals, emptyDay, loadDay, localDayKey, recordDay, saveDay, dayBill } from './daily.js'
import { DAILY_FILE } from './daily.js'

export const PANEL_ID = 'token-savings'
export const PANEL_TITLE = 'Token 节省'
const MODULE_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/i

/**
 * 面板默认只显示两个数：节省的 token（含百分比）和省下的钱。
 * 置 true 会把模块明细、token 当量等调试信息一并放出（只用于排查）。
 */
let showBreakdown = false

/** 仅测试/排查用：打开分项明细。生产默认关闭，卡片只留总量与金额。 */
export function setBreakdownForTests(value) { showBreakdown = value === true }

/**
 * Candidate snapshot paths, most specific first. The producer writes to
 * `path.resolve(process.cwd(), 'savings.json')`, and the host process runs with
 * its profile directory as cwd, so DSH_PROFILE_DIR is the reliable anchor; the
 * rest are fallbacks for other launch styles.
 */
export function savingsCandidates(env = process.env, cwd = process.cwd(), home = env.DSH_HOME || path.join(os.homedir(), '.dsh')) {
  const out = []
  const push = (p) => {
    if (typeof p === 'string' && p.length > 0 && !out.includes(p)) out.push(p)
  }
  push(env.DSH_SAVINGS_FILE)
  if (env.DSH_PROFILE_DIR) push(path.join(env.DSH_PROFILE_DIR, 'savings.json'))
  push(path.join(cwd, 'savings.json'))
  const profileNames = new Set(['desktop', 'web'])
  if (env.DSH_PROFILE) profileNames.add(env.DSH_PROFILE)
  for (const name of profileNames) push(path.join(home, 'profiles', name, 'savings.json'))
  push(path.join(home, 'savings.json'))
  return out
}

/**
 * Every ledger this widget can see: the candidate list plus one file per
 * profile directory that actually exists. "All workspaces" means all DSH
 * profiles on this machine — the producer writes one ledger per host process,
 * and a profile is the closest thing to a workspace boundary the host exposes.
 */
export function sweepSavingsFiles(home, candidates, listDir = fs.readdirSync) {
  const out = []
  const push = (p) => {
    if (typeof p === 'string' && p.length > 0 && !out.includes(p)) out.push(p)
  }
  for (const file of candidates) push(file)
  if (typeof home !== 'string' || home.length === 0) return out
  try {
    for (const name of listDir(path.join(home, 'profiles'), { withFileTypes: true })) {
      if (!name || !name.isDirectory || !name.isDirectory()) continue
      push(path.join(home, 'profiles', name.name, 'savings.json'))
    }
  } catch (err) {}
  return out
}

function mdPathFor(jsonPath) {
  return jsonPath.endsWith('.json') ? jsonPath.slice(0, -5) + '.md' : jsonPath + '.md'
}

function fromNumberOrString(value) {
  if (typeof value === 'number') return readNumber(value)
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[,\s_]/g, '')
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null
  return readNumber(Number(cleaned))
}

function collectModules(byModule) {
  if (!byModule || typeof byModule !== 'object' || Array.isArray(byModule)) return []
  const modules = []
  for (const [name, raw] of Object.entries(byModule)) {
    if (!MODULE_RE.test(name)) continue
    const value = fromNumberOrString(raw)
    if (value === null || value < 0) continue
    modules.push([name.toLowerCase(), value])
  }
  return modules
}

/** Validate a parsed savings.json document. Returns null when unusable. */
export function parseMoney(money) {
  if (!money || typeof money !== 'object' || Array.isArray(money)) return null
  const total = Number(money.total)
  if (!Number.isFinite(total)) return null
  const byModule = {}
  if (money.byModule && typeof money.byModule === 'object') {
    for (const [key, value] of Object.entries(money.byModule)) {
      const cny = Number(value)
      if (Number.isFinite(cny)) byModule[key] = cny
    }
  }
  return {
    currency: typeof money.currency === 'string' ? money.currency : 'CNY',
    total,
    byModule,
    basis: money.basis && typeof money.basis === 'object' ? money.basis : null,
  }
}

export function parseSnapshot(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null
  const total = fromNumberOrString(doc.totalSavedTokens)
  if (total === null || total < 0) return null
  const modules = collectModules(doc.byModule)
  const events = fromNumberOrString(doc.events)
  const folds = fromNumberOrString(doc.folds)
  const rejected = fromNumberOrString(doc.rejectedByAnchor)
  const updatedAt = typeof doc.updatedAt === 'string' ? Date.parse(doc.updatedAt) : NaN
  const contextTokens = fromNumberOrString(doc.contextTokens)
  const lastEvents = Array.isArray(doc.lastEvents) ? doc.lastEvents : []
  const lastEvent = lastEvents.length > 0 ? lastEvents[lastEvents.length - 1] : null
  const lastEventTokens = lastEvent && typeof lastEvent === 'object' ? fromNumberOrString(lastEvent.tokens) : null
  const estimatedCost = fromNumberOrString(doc.estimatedCostTokens)
  const contextReduction = fromNumberOrString(doc.contextReduction)
  const revision = fromNumberOrString(doc.revision)
  const beforeTotal = fromNumberOrString(doc.tokensBeforeTotal)
  const afterTotal = fromNumberOrString(doc.tokensAfterTotal)
  return {
    total,
    modules,
    schemaVersion: fromNumberOrString(doc.schemaVersion),
    // schemaVersion 3 contract: a ledgerId identifies one producer lifetime and
    // a new one must replace, not accumulate; revision dedupes snapshots.
    ledgerId: typeof doc.ledgerId === 'string' && doc.ledgerId.length > 0 ? doc.ledgerId : '',
    revision: revision === null ? null : Math.max(0, Math.round(revision)),
    estimatedCostTokens: estimatedCost === null ? null : Math.max(0, Math.round(estimatedCost)),
    contextReduction: contextReduction === null ? Math.max(0, Math.round(modules.find(([name]) => name === 'fold')?.[1] || 0)) : Math.max(0, Math.round(contextReduction)),
    // schemaVersion 4: Σ prompt tokens before/after compression, which is the
    // only honest denominator for a savings percentage.
    tokensBeforeTotal: beforeTotal === null ? null : Math.max(0, Math.round(beforeTotal)),
    tokensAfterTotal: afterTotal === null ? null : Math.max(0, Math.round(afterTotal)),
    tokensBeforeTotalEstimated: doc.tokensBeforeTotalEstimated === true,
    // Per-dimension rates, either already computed by the producer
    // (`byModuleRate`) or derivable from its original sizes (`byModuleBefore`).
    byModuleBefore: collectModules(doc.byModuleBefore),
    // 生产者按官方单价折算的金额（CNY）；realBill 缺失时的唯一来源。
    money: parseMoney(doc.money),
    byModuleRate: collectModules(doc.byModuleRate),
    /**
     * 真实账单（provider usage × 官方单价），由 dsh-context-manager 写入。
     * 面板只做展示，不重算价格 —— 单价表改了就两边不一致。
     */
    realBill: doc.realBill && typeof doc.realBill === 'object'
      ? {
          requests: fromNumberOrString(doc.realBill.requests),
          actualCost: fromNumberOrString(doc.realBill.actualCost),
          counterfactualCost: fromNumberOrString(doc.realBill.counterfactualCost),
          reduction: fromNumberOrString(doc.realBill.reduction),
          missTokens: fromNumberOrString(doc.realBill.missTokens),
          hitTokens: fromNumberOrString(doc.realBill.hitTokens),
          outputTokens: fromNumberOrString(doc.realBill.outputTokens),
          removedTokens: fromNumberOrString(doc.realBill.removedTokens),
          avoidedOutputTokens: fromNumberOrString(doc.realBill.avoidedOutputTokens),
          promptTokens: fromNumberOrString(doc.realBill.promptTokens),
        }
      : null,
    byWorkspace: parseWorkspaces(doc.byWorkspace),
    bySession: parseBySession(doc.bySession),
    events: events === null ? null : Math.max(0, Math.round(events)),
    folds: folds === null ? null : Math.max(0, Math.round(folds)),
    rejected: rejected === null ? null : Math.max(0, Math.round(rejected)),
    contextTokens: contextTokens === null ? null : Math.round(contextTokens),
    lastEventTokens: lastEventTokens === null ? null : Math.round(lastEventTokens),
    updatedMs: Number.isFinite(updatedAt) ? updatedAt : null,
    startedMs: typeof doc.startedAt === 'string' && Number.isFinite(Date.parse(doc.startedAt)) ? Date.parse(doc.startedAt) : null,
    source: 'savings.json',
  }
}

/** Normalize `byWorkspace` into display-ready slices, largest saving first. */
/** Normalize a per-workspace ratio into the canonical percent unit (60.5 = 60.5%), matching savingsPercent(). */
/** Wrap a percent number into the payload shape used by the renderer. */
function asPercent(value) {
  return Number.isFinite(value) ? { value } : null
}

function ratioValue(candidate, before, after) {
  const numeric = Number(candidate && typeof candidate === 'object' ? candidate.value : candidate)
  if (Number.isFinite(numeric) && numeric > 0) return Math.round((numeric <= 1 ? numeric * 100 : numeric) * 10) / 10
  return savingsPercent(Number(before), Number(after))
}

/** Normalize `bySession` (sessionId -> workspaceId) so the per-session tab can scope itself. */
function parseBySession(bySession) {
  if (!bySession || typeof bySession !== 'object' || Array.isArray(bySession)) return {}
  const out = {}
  for (const [sessionId, workspaceId] of Object.entries(bySession)) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) continue
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) continue
    if (Object.keys(out).length >= LIMITS.items * 40) break
    out[sessionId.slice(0, 120)] = workspaceId.slice(0, 40)
  }
  return out
}

/** 工作区自己的分项（label/value/percent/cny），供标签页的环形图使用。 */
function workspaceItems(slice, wsCny) {
  const list = Array.isArray(slice.modules) ? slice.modules : []
  const beforeMap = new Map(Array.isArray(slice.modulesBefore) ? slice.modulesBefore : [])
  const sum = list.reduce((acc, entry) => acc + (Number(entry[1]) || 0), 0)
  return list
    .filter((entry) => Number(entry[1]) > 0)
    .slice(0, 8)
    .map(([label, value]) => {
      const own = Number(value) || 0
      const before = Number(beforeMap.get(label) || 0)
      const share = sum > 0 ? own / sum : 0
      return {
        label,
        value: Math.round(own),
        percent: before > 0 && own <= before ? Math.round(((before - own) / before) * 1000) / 10 : null,
        cny: typeof wsCny === 'number' ? Math.round(wsCny * share * 10000) / 10000 : null,
      }
    })
}

function parseWorkspaces(byWorkspace) {
  if (!byWorkspace || typeof byWorkspace !== 'object' || Array.isArray(byWorkspace)) return []
  const out = []
  for (const [id, raw] of Object.entries(byWorkspace)) {
    if (!raw || typeof raw !== 'object') continue
    const total = fromNumberOrString(raw.totalSavedTokens)
    const before = fromNumberOrString(raw.tokensBeforeTotal)
    const after = fromNumberOrString(raw.tokensAfterTotal)
    out.push({
      id: String(id).slice(0, 64),
      workspace: typeof raw.workspace === 'string' ? raw.workspace.slice(0, 200) : '',
      label: typeof raw.label === 'string' && raw.label.length > 0 ? raw.label.slice(0, 48) : String(id).slice(0, 12),
      total: total === null ? 0 : Math.max(0, Math.round(total)),
      cost: fromNumberOrString(raw.estimatedCostTokens) === null ? 0 : Math.max(0, Math.round(fromNumberOrString(raw.estimatedCostTokens))),
      modules: collectModules(raw.byModule),
      modulesBefore: collectModules(raw.byModuleBefore),
      before,
      after,
      events: fromNumberOrString(raw.events),
      // 该工作区自己的逐轮计价金额（CNY）与轮次：面板按本工作区显示，不能拿全局值顶替。
      moneyCny: fromNumberOrString(raw.moneyCny),
      moneyTurns: fromNumberOrString(raw.moneyTurns),
      moneyHitTokens: fromNumberOrString(raw.moneyHitTokens),
      moneyMissTokens: fromNumberOrString(raw.moneyMissTokens),
      updatedMs: typeof raw.updatedAt === 'string' && Number.isFinite(Date.parse(raw.updatedAt)) ? Date.parse(raw.updatedAt) : null,
    })
  }
  out.sort((a, b) => b.total - a.total)
  return out
}

/** Percentage saved, from the before/after totals. Null when unusable. */
/**
 * 读取纪元起点。文件形如 { "since": "2026-11-12T10:30:00.000Z" }；
 * 缺失或不可解析一律返回 null（= 不启用闸门，统计保持累计）。
 */
function readResetStamp(file) {
  try {
    if (!fs.existsSync(file)) return null
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const stamp = raw && (raw.since ?? raw.stamp)
    if (stamp === undefined || stamp === null) return null
    const value = String(stamp)
    return Number.isFinite(Date.parse(value)) ? value : null
  } catch {
    return null
  }
}

export function savingsPercent(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null
  if (before <= 0 || after < 0 || after > before) return null
  const percent = ((before - after) / before) * 100
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null
  return Math.round(percent * 10) / 10
}

/**
 * Parse the Markdown mirror. Used only when the JSON is unusable, so the panel
 * degrades to slightly less precise data instead of disappearing.
 */
export function parseMarkdown(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const totalMatch = /total saved tokens:\s*\*{0,2}([\d,]+)\*{0,2}/i.exec(text)
  if (!totalMatch) return null
  const total = fromNumberOrString(totalMatch[1])
  if (total === null) return null
  const updatedMatch = /-\s*updated:\s*(\S+)/i.exec(text)
  const updatedMs = updatedMatch ? Date.parse(updatedMatch[1]) : NaN
  const eventsMatch = /events:\s*([\d,]+)/i.exec(text)
  const foldsMatch = /folds:\s*([\d,]+)/i.exec(text)

  const modules = []
  const section = text.split(/^##\s+By module\s*$/im)[1]
  if (section) {
    for (const line of section.split(/\r?\n/)) {
      const row = /^\|\s*([a-z0-9][a-z0-9_-]{0,23})\s*\|\s*([\d,]+)\s*\|\s*$/i.exec(line.trim())
      if (!row) continue
      const value = fromNumberOrString(row[2])
      if (value === null) continue
      modules.push([row[1].toLowerCase(), value])
    }
  }

  return {
    total,
    modules,
    events: eventsMatch ? fromNumberOrString(eventsMatch[1]) : null,
    folds: foldsMatch ? fromNumberOrString(foldsMatch[1]) : null,
    rejected: null,
    updatedMs: Number.isFinite(updatedMs) ? updatedMs : null,
    startedMs: null,
    source: 'savings.md',
  }
}

/** Human-readable age, capped at "很久以前" so the note stays bounded. */
export function formatAge(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return '刚刚更新'
  const sec = Math.floor(ageMs / 1000)
  if (sec < 60) return '刚刚更新'
  const min = Math.floor(sec / 60)
  if (min < 60) return min + ' 分钟前更新'
  const hour = Math.floor(min / 60)
  if (hour < 24) return hour + ' 小时前更新'
  const day = Math.floor(hour / 24)
  if (day < 30) return day + ' 天前更新'
  return '很久以前更新'
}

/**
 * The savings ledger does not publish the context size, so the only place the
 * producer records it is its own debug log, one `routing.decision` /
 * `memory.planned` line per request (`"contextTokens":78596`). Read only the
 * tail of the file and take the last value; a missing or unreadable log simply
 * means "no rate", never an error.
 *
 * This is deliberately a fallback: if the producer ever adds `contextTokens` to
 * savings.json, `parseSnapshot` picks it up and the log is not consulted.
 */
export function readContextTokensFromLog(logPath, options = {}) {
  const readFile = options.readFile
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : 64 * 1024
  let text = null
  try {
    if (typeof readFile === 'function') {
      text = readFile(logPath, maxBytes)
    } else {
      const stat = fs.statSync(logPath)
      const size = Math.min(stat.size, maxBytes)
      const fd = fs.openSync(logPath, 'r')
      try {
        const buffer = Buffer.alloc(size)
        fs.readSync(fd, buffer, 0, size, stat.size - size)
        text = buffer.toString('utf8')
      } finally {
        fs.closeSync(fd)
      }
    }
  } catch (err) {
    return null
  }
  if (typeof text !== 'string' || text.length === 0) return null
  let last = null
  const re = /"contextTokens"\s*:\s*(\d+)/g
  let match
  while ((match = re.exec(text)) !== null) last = match[1]
  if (last === null) return null
  const value = Number(last)
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Savings rate for the latest recorded event: how much smaller this request's
 * context was because of that saving. Both numbers are required; returning null
 * is better than inventing a denominator.
 */
export function computeRate(perTurnSaved, contextTokens) {
  if (!Number.isFinite(perTurnSaved) || perTurnSaved <= 0) return null
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) return null
  const percent = (perTurnSaved / (perTurnSaved + contextTokens)) * 100
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return null
  return Math.round(percent * 10) / 10
}

function emptyPanel(reason) {
  return {
    v: 1,
    id: PANEL_ID,
    kind: 'metric',
    title: PANEL_TITLE,
    status: 'empty',
    priority: 8,
    order: 10,
    ttlMs: 900_000,
    emptyReason: reason,
  }
}

// Every dimension the producer records. They are always rendered, even at zero:
// a card that silently hides four dimensions when the producer's thresholds
// have not fired yet reads as "only schema exists".
const TRACKED_MODULES = ['schema', 'extraction', 'admission', 'dedup']

// The producer prices the cached prefix at 1/30 of a fresh token
// (`CACHE_HIT_PRICE / CACHE_MISS_PRICE`), and schema tokens are the ones that
// live in that prefix. This weighting is now a *secondary* figure: the headline
// and the rows count raw tokens so the percentages stay additive.
const CACHE_PREFIX_DIVISOR = 30

/** Cost-equivalent value of one module's raw prompt-token saving. */
export function moduleCost(label, rawTokens) {
  const value = Number(rawTokens)
  if (!Number.isFinite(value) || value <= 0) return 0
  if (label === 'schema') return Math.round(value / CACHE_PREFIX_DIVISOR)
  return Math.round(value)
}

/**
 * Raw token saving per dimension, zeros included, in display order.
 *
 * Percentages must be additive: each dimension is `saved_i / consumed`, so their
 * sum is exactly the total savings percentage. That only works when every row
 * carries the raw token count of its own dimension.
 */
function buildRows(daily, current) {
  const map = new Map()
  const dailyRows = daily && daily.sources && Object.keys(daily.sources).length > 0 ? dayModules(daily) : []
  const dailySum = dailyRows.reduce((sum, [, value]) => sum + Math.max(0, Number(value) || 0), 0)
  // Day store wins only when it really carries numbers: an empty-but-present day
  // store used to zero every row while the headline still used the measured bill,
  // which is exactly how "总数和分项对不上" appeared on the panel.
  if (dailySum > 0) {
    for (const [label, value] of dailyRows) map.set(label, value)
  } else if (current) {
    for (const [label, value] of current.modules) map.set(label, value)
  }
  for (const label of [...TRACKED_MODULES, 'fold']) {
    if (!map.has(label)) map.set(label, 0)
  }
  return [...map.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]
    return TRACKED_MODULES.indexOf(a[0]) - TRACKED_MODULES.indexOf(b[0])
  })
}

/** Per-dimension compression rate: saved / the dimension's own original size. */
function buildRates(current) {
  if (!current) return {}
  const direct = new Map(current.byModuleRate || [])
  const before = new Map(current.byModuleBefore || [])
  const saved = new Map(current.modules || [])
  const rates = {}
  for (const [label, value] of saved) {
    if (direct.has(label)) {
      const rate = Number(direct.get(label))
      if (Number.isFinite(rate) && rate >= 0 && rate <= 100) rates[label] = Math.round(rate * 10) / 10
      continue
    }
    const original = Number(before.get(label))
    if (!Number.isFinite(original) || original <= 0 || value < 0) continue
    if (value > original) continue
    rates[label] = Math.round((value / original) * 1000) / 10
  }
  return rates
}

/** Σ prompt tokens actually sent (the denominator of the total percentage). */
/** Provider-anchored token counts out of one ledger realBill, or null. */
function measuredFromBill(bill) {
  if (!bill || !Number.isFinite(bill.removedTokens) || !Number.isFinite(bill.promptTokens)) return null
  if (bill.removedTokens <= 0) return null
  return {
    saved: bill.removedTokens + (Number.isFinite(bill.avoidedOutputTokens) ? bill.avoidedOutputTokens : 0),
    consumed: bill.promptTokens + (Number.isFinite(bill.outputTokens) ? bill.outputTokens : 0),
  }
}

function consumedTokens(daily, current) {
  if (daily) {
    const totals = dayTokenTotals(daily)
    if (totals.after > 0) return totals.after
  }
  return (current && current.tokensAfterTotal) || 0
}

/**
 * The panel's headline is **today's savings across every source the host can
 * see**, because a per-process total resets on every restart. The current
 * process's ledger — the number that belongs to this workspace — travels as
 * `scope` and is what the detail surfaces show next to it.
 */
function okPanel({ current, rate, sourceLabel, sources, note, today, epochSince, persisted }) {
  /**
   * 单一真相：一切数字都来自同一份账本快照。
   * - tokens = Σ(每次请求 before − after)，可直接对账；
   * - money  = 同一账本里 provider 权威用量算出的真实金额（requests > 0 才成立）；
   * - 分项/工作区只是「归因占比」，按总量等比折算，因此三者的钱与百分比互相对得上。
   */
  const tokens = Math.max(0, Math.round(Number(current.total) || 0))
  const before = Math.max(0, Math.round(Number(current.tokensBeforeTotal) || 0))
  const after = Math.max(0, Math.round(Number(current.tokensAfterTotal) || 0))
  const percent = savingsPercent(before, after)

  const bill = current.realBill
  const measured = Boolean(bill) && Number(bill.requests) > 0
  const ledgerMoney = current.money
  const basis = (ledgerMoney && ledgerMoney.basis) || {}
  const hitPrice = Number.isFinite(Number(basis.hit)) ? Number(basis.hit) : 0.02
  const missPrice = Number.isFinite(Number(basis.miss)) ? Number(basis.miss) : 1

  // 金额由插件逐轮累加得到：每轮用「该轮实测命中率 + 该轮峰/谷价」单独计价后相加。
  // 这里只做汇总展示，绝不用「总 token × 平均单价」重算——那会把各轮的差异抹平。
  const perTurnTotal = ledgerMoney && Number.isFinite(Number(ledgerMoney.total)) ? Number(ledgerMoney.total) : null
  const perTurnTurns = Number(basis.turns) || 0
  const moneyTotal = perTurnTotal

  // 有效命中率 = 各轮省下的命中 token / 各轮省下的全部 token（加权，不是算术平均）。
  const savedHit = Number(basis.savedHitTokens) || 0
  const savedMiss = Number(basis.savedMissTokens) || 0
  const savedDenom = savedHit + savedMiss
  const effRate =
    savedDenom > 0
      ? savedHit / savedDenom
      : Number.isFinite(Number(basis.effectiveHitRate)) && basis.effectiveHitRate !== null
        ? Number(basis.effectiveHitRate)
        : null
  const moneyBasis = perTurnTotal !== null ? 'per-turn' : 'none'
  const cnyOf = (shareRatio) => {
    if (moneyTotal === null) return null
    const value = moneyTotal * Math.max(0, Math.min(1, Number(shareRatio) || 0))
    return Math.round(value * 1000000) / 1000000
  }
  const ratePct = effRate === null ? null : Math.round(effRate * 1000) / 10
  // 该批节省 token 折算出的平均单价（仅用于展示，不参与计算）。
  const priceText = savedDenom > 0 && moneyTotal ? ((moneyTotal / savedDenom) * 1e6).toFixed(4) : null

  const rows = (Array.isArray(current.modules) ? current.modules : [])
    .filter(([, value]) => Number(value) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
  const rowTotal = rows.reduce((sum, [, value]) => sum + Number(value), 0)
  const beforeMap = new Map(Array.isArray(current.byModuleBefore) ? current.byModuleBefore : [])
  const items = rows.slice(0, LIMITS.items).map(([label, value]) => {
    const raw = Number(value)
    const share = rowTotal > 0 ? raw / rowTotal : 0
    // 行百分比 = 该模块自己的 before→after，不用全局比例充数。
    const ownBefore = Number(beforeMap.get(label) || 0)
    const ownRate = ownBefore > 0 && raw <= ownBefore ? Math.round(((ownBefore - raw) / ownBefore) * 1000) / 10 : null
    return {
      label,
      value: Math.round(tokens * share),
      percent: ownRate !== null && ownRate > 0 && ownRate <= 100 ? ownRate : null,
      cny: cnyOf(share),
    }
  })

  const workspaces = (Array.isArray(current.byWorkspace) ? current.byWorkspace : [])
    .filter((slice) => Number(slice.total) > 0)
    .sort((a, b) => Number(b.total) - Number(a.total))
    .slice(0, 8)
    .map((slice) => {
      const share = tokens > 0 ? Number(slice.total) / tokens : 0
      const wsBefore = Number(slice.before) || 0
      const wsAfter = Number(slice.after) || 0
      const wsCny =
        slice.moneyCny !== null && slice.moneyCny !== undefined && Number.isFinite(Number(slice.moneyCny)) && Number(slice.moneyCny) > 0
          ? Math.round(Number(slice.moneyCny) * 10000) / 10000
          : cnyOf(share)
      return {
        id: slice.id,
        label: slice.label,
        workspace: slice.workspace,
        value: Math.round(Number(slice.total) || 0),
        before: Math.round(wsBefore),
        after: Math.round(wsAfter),
        percent: savingsPercent(wsBefore, wsAfter),
        // 工作区金额用它自己的逐轮累计值；缺失时才按 token 占比分摊（并在 meta 标明）。
        cny: wsCny,
        turns: Number(slice.moneyTurns) || 0,
        items: workspaceItems(slice, wsCny),
      }
    })

  const payload = {
    value: tokens,
    unit: 'tokens',
    label: '少发 prompt',
    percent: percent === null ? null : { value: percent },
    items,
    workspaces,
    bySession: current.bySession || {},
    meta: {
      schemaVersion: current.schemaVersion,
      accountingVersion: current.accountingVersion,
      ledgerId: current.ledgerId || '',
      revision: current.revision || 0,
      updatedAt: current.updatedMs || 0,
      sources: (sources || []).length,
      measured,
      moneyBasis,
    },
  }

  if (moneyTotal !== null && moneyTotal > 0) {
    payload.money = {
      // `saved` 是 schema 白名单里的规范字段名；`savedCny` 保留给直接读 payload 的渲染层。
      saved: moneyTotal,
      savedCny: moneyTotal,
      actualCny: Number(bill && bill.actualCost) || 0,
      counterfactualCny: Number(bill && bill.counterfactualCost) || 0,
      basis: moneyBasis,
      turns: perTurnTurns,
      effectiveHitRate: ratePct === null ? null : Math.round(ratePct * 10) / 1000,
      savedHitTokens: savedHit,
      savedMissTokens: savedMiss,
      avgPricePerMillion: priceText === null ? null : Number(priceText),
    }
    // 把口径摊开：逐轮计价后相加，命中率是各轮实测的加权值。
    payload.moneyText =
      ratePct === null || perTurnTurns === 0
        ? `逐轮计价 ¥${moneyTotal.toFixed(4)}`
        : `逐轮计价 ¥${moneyTotal.toFixed(4)} · ${perTurnTurns} 轮 · 加权命中 ${ratePct}% · 均价 ¥${priceText}/M`
  } else {
    payload.money = null
    payload.moneyText = perTurnTurns > 0 ? '逐轮计价 ¥0.0000' : '账单待采集'
  }

  if (rate !== null && rate !== undefined) payload.rate = { percent: rate, label: '本轮' }

  const bits = []
  if (note) bits.push(note)
  bits.push(today || new Date().toLocaleDateString('zh-CN'))
  payload.note = bits.filter(Boolean).join(' · ')

  return {
    v: 1,
    id: PANEL_ID,
    kind: 'metric',
    title: PANEL_TITLE,
    status: 'ok',
    priority: 8,
    order: 10,
    ttlMs: 900_000,
    payload,
  }
}
function outNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}


function buildNote(spec, now, mtimeMs) {
  const stamp = Math.max(
    Number.isFinite(spec.updatedMs) ? spec.updatedMs : -Infinity,
    Number.isFinite(mtimeMs) ? mtimeMs : -Infinity,
  )
  const age = stamp === -Infinity ? '' : formatAge(now - stamp)
  const parts = []
  if (age) parts.push(age)
  if (spec.events !== null) parts.push(spec.events + ' 事件')
  if (spec.folds !== null && spec.folds > 0) parts.push(spec.folds + ' 次折叠')
  if (spec.source === 'savings.md') parts.push('JSON 不可用，读自 markdown')
  return parts.join(' · ')
}

/**
 * @param {object} [options]
 * @param {string[]} [options.files] candidate savings.json paths
 * @param {() => number} [options.now]
 * @param {number} [options.staleAfterMs] age after which the panel reports 暂无数据
 * @param {number} [options.failuresBeforeEmpty]
 * @param {typeof fs.readFileSync} [options.readFile]
 * @param {typeof fs.statSync} [options.statFile]
 * @param {(level: string, message: string, detail?: object) => void} [options.log]
 */
export function createTokenSavingsSource(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const readFile = options.readFile || ((p) => fs.readFileSync(p, 'utf8'))
  const statFile = options.statFile || ((p) => fs.statSync(p))
  const staleAfterMs = Number.isFinite(options.staleAfterMs) ? options.staleAfterMs : 6 * 60 * 60 * 1000
  const failuresBeforeEmpty = Number.isFinite(options.failuresBeforeEmpty) ? options.failuresBeforeEmpty : 2
  const log = typeof options.log === 'function' ? options.log : () => {}
  const files = Array.isArray(options.files) && options.files.length > 0 ? options.files : savingsCandidates()

  let consecutiveFailures = 0
  let lastPanel = null
  let lastReason = null
  // Snapshot identity across polls (schemaVersion 3): ledgerId resets the
  // consumer's per-ledger state, revision dedupes unchanged snapshots.
  let lastLedgerId = ''
  let lastRevision = -1
  let lastNoteBucket = -1

  function readOne(file) {
    const stat = statFile(file)
    let spec = null
    let jsonError = null
    try {
      spec = parseSnapshot(JSON.parse(stripBom(readFile(file))))
      if (!spec) jsonError = 'unsupported shape'
    } catch (err) {
      jsonError = String((err && err.message) || err)
    }
    if (!spec) {
      try {
        spec = parseMarkdown(stripBom(readFile(mdPathFor(file))))
      } catch (err) {
        // both formats unavailable: fall through with the JSON error
      }
    }
    if (!spec) return { spec: null, reason: 'savings.json 解析失败' + (jsonError ? '（' + jsonError.slice(0, 40) + '）' : ''), file, mtimeMs: null }
    const mtimeMs = stat && typeof stat.mtimeMs === 'number' ? stat.mtimeMs : null
    return { spec, reason: null, file, mtimeMs }
  }

  /**
   * One poll. Returns `{ panel }` where panel is a raw protocol document, or
   * `{ panel: null, reason }` meaning "keep whatever is on the pet".
   */
  function poll() {
    const at = now()
    const today = localDayKey(at)
    let lastMissing = '找不到 savings.json'

    // Sweep every ledger the host can see, so the day total spans workspaces.
    const swept = sweepSavingsFiles(options.home, files, options.listDir)
    const observations = []
    let primary = null
    let lastFailureReason = '找不到 savings.json'

    for (const file of swept) {
      let hit
      try {
        hit = readOne(file)
      } catch (err) {
        continue
      }
      if (!hit || !hit.spec) {
        if (hit && hit.reason) lastFailureReason = hit.reason
        continue
      }
      observations.push({
        key: file,
        // ledgerId is the producer's own generation identity (schemaVersion 3);
        // startedAt is the fallback for older snapshots.
        generation: hit.spec.ledgerId || '',
        startedAt: hit.spec.startedMs !== null ? new Date(hit.spec.startedMs).toISOString() : '',
        total: hit.spec.total,
        cost: hit.spec.estimatedCostTokens === null ? hit.spec.total : hit.spec.estimatedCostTokens,
        billSaved: (measuredFromBill(hit.spec && hit.spec.realBill) || {}).saved || 0,
        billConsumed: (measuredFromBill(hit.spec && hit.spec.realBill) || {}).consumed || 0,
        before: hit.spec.tokensBeforeTotal || 0,
        after: hit.spec.tokensAfterTotal || 0,
        byModule: Object.fromEntries(hit.spec.modules),
        updatedMs: hit.spec.updatedMs,
        billActual: hit.spec && hit.spec.realBill ? Number(hit.spec.realBill.actualCost) || 0 : 0,
        billCounterfactual:
          hit.spec && hit.spec.realBill ? Number(hit.spec.realBill.counterfactualCost) || 0 : 0,
        billRequests: hit.spec && hit.spec.realBill ? Number(hit.spec.realBill.requests) || 0 : 0,
      })
      if (primary === null && files.includes(file)) primary = hit
    }
    if (primary === null && observations.length > 0) {
      // Nothing matched the preferred candidate list, but a profile ledger exists.
      primary = readOneSafe(observations[0].key)
    }
    lastMissing = lastFailureReason

    // Fold into the persisted day total (survives restarts, spans sources).
    const dailyFile = options.dailyFile
    let daily = dailyFile ? loadDay(dailyFile, today, options.readFile) : null
    let dailyChanged = false
    /**
     * 纪元闸门：`.dshw-savings-reset.json` 写 { "since": "<ISO>" } 后，
     * 只有 startedAt 不早于该时刻的账本才计入。当前进程（早于 since 启动）立即出局，
     * 重启后的新进程自动接上；结果与轮询次数无关，不依赖「标记被消费」。
     */
    const resetFile = dailyFile
      ? (options.resetFile || path.join(path.dirname(dailyFile), '.dshw-savings-reset.json'))
      : null
    const epochSince = resetFile ? readResetStamp(resetFile) : null
    // 清空必须立即落盘：否则下一次轮询会从旧文件读回被清掉的来源。
    if (daily && dailyChanged && typeof options.writeDaily === 'function') {
      try {
        options.writeDaily(dailyFile, daily)
      } catch {
        /* 落盘失败时保持内存视图，下一轮会再试。 */
      }
    }
    if (daily && epochSince !== null && String(daily.resetStamp ?? '') !== epochSince) {
      daily = emptyDay(today)
      daily.resetStamp = epochSince
      dailyChanged = true
    }
    if (epochSince !== null) {
      const sinceMs = Date.parse(epochSince)
      if (Number.isFinite(sinceMs)) {
        for (let i = observations.length - 1; i >= 0; i -= 1) {
          const started = Date.parse(observations[i].startedAt || '')
          if (!Number.isFinite(started) || started < sinceMs) observations.splice(i, 1)
        }
      }
    }
    // 清空必须落盘：观测被纪元过滤光了就不会走 recordDay，旧 total 会残留。
    if (dailyChanged && daily && typeof options.writeDaily === 'function') {
      try {
        options.writeDaily(dailyFile, daily)
      } catch {
        /* 落盘失败不影响本轮展示 */
      }
    }

    if (daily && observations.length > 0) {
      const recorded = recordDay(
        daily,
        observations,
        today,
        epochSince,
        observations[0] && observations[0].accountingVersion,
      )
      daily = recorded.state
      dailyChanged = recorded.changed
      if (recorded.changed && typeof options.writeDaily === 'function') {
        try {
          options.writeDaily(dailyFile, daily)
        } catch (err) {
          log('warn', 'could not persist the daily savings ledger', { error: String((err && err.message) || err) })
        }
      }
    }

    function readOneSafe(file) {
      try {
        return readOne(file)
      } catch (err) {
        return null
      }
    }

    if (primary && primary.spec) {
      const stamp = Math.max(
        Number.isFinite(primary.spec.updatedMs) ? primary.spec.updatedMs : -Infinity,
        Number.isFinite(primary.mtimeMs) ? primary.mtimeMs : -Infinity,
      )
      const age = stamp === -Infinity ? 0 : at - stamp
      if (age > staleAfterMs) {
        consecutiveFailures = 0
        const reason = '数据已过期（' + formatAge(age) + '）'
        lastPanel = emptyPanel(reason)
        lastReason = reason
        return { panel: lastPanel, reason, source: primary.spec.source, file: primary.file }
      }

      consecutiveFailures = 0
      // Snapshot identity. A new ledgerId is a new producer lifetime: the
      // per-ledger figures are replaced, never accumulated onto the old ones.
      const ledgerKey = primary.spec.ledgerId !== '' ? primary.spec.ledgerId : String(primary.spec.startedMs || '')
      if (ledgerKey !== lastLedgerId) {
        lastLedgerId = ledgerKey
        lastRevision = -1
        lastNoteBucket = -1
        if (ledgerKey !== '') log('info', 'savings ledger changed; replacing instead of accumulating', { ledgerId: ledgerKey })
      }
      // Clamp: a filesystem mtime a fraction of a millisecond in the future
      // would otherwise flip the bucket between -1 and 0 across two polls and
      // defeat the dedupe.
      const noteBucket = Math.floor(Math.max(0, age) / 60_000)
      const dedupeHit = !dailyChanged && primary.spec.revision !== null && primary.spec.revision === lastRevision && noteBucket === lastNoteBucket
      if (dedupeHit) {
        // Same ledger revision and nothing else moved: nothing to republish.
        return { panel: null, reason: null, unchanged: true }
      }
      lastRevision = primary.spec.revision === null ? lastRevision : primary.spec.revision
      lastNoteBucket = noteBucket

      // Context size comes from savings.json when the producer publishes it,
      // otherwise from the tail of its debug log in the same directory.
      let contextTokens = primary.spec.contextTokens
      if (contextTokens === null) {
        contextTokens = readContextTokensFromLog(path.join(path.dirname(primary.file), 'debug.log'), {
          readFile: options.readLog,
        })
      }
      const rate = computeRate(primary.spec.lastEventTokens, contextTokens)
      const sourceLabel = path.basename(path.dirname(primary.file)) + '/' + path.basename(primary.file)
      lastPanel = okPanel({
        daily: daily || {
          total: primary.spec.total,
          cost: primary.spec.estimatedCostTokens === null ? primary.spec.total : primary.spec.estimatedCostTokens,
          modules: Object.fromEntries(primary.spec.modules),
        },
        current: primary.spec,
        rate,
        sourceLabel,
        sources: daily ? daySourceCount(daily) : 1,
        note: buildNote(primary.spec, at, primary.mtimeMs),
        today,
        epochSince,
        persisted: Boolean(daily),
      })
      lastReason = null
      return {
        panel: lastPanel,
        reason: null,
        source: primary.spec.source,
        file: primary.file,
        rate,
        contextTokens,
        today: daily ? daily.total : primary.spec.total,
      }
    }

    // No readable ledger this round. If today already has a total, keep showing
    // it: the producer restarting must not blank the day figure.
    if (daily && daily.total > 0) {
      consecutiveFailures++
      lastPanel = okPanel({
        daily,
        current: null,
        rate: null,
        sourceLabel: null,
        sources: daySourceCount(daily),
        note: '数据源暂时不可读，显示今日累计',
        today,
        epochSince,
        persisted: true,
      })
      lastReason = lastMissing
      return { panel: lastPanel, reason: lastMissing, today: daily.total, degraded: true }
    }

    consecutiveFailures++
    if (lastPanel && lastPanel.status === 'ok' && consecutiveFailures < failuresBeforeEmpty) {
      log('debug', 'token savings read failed; keeping the last good panel', { failures: consecutiveFailures, reason: lastMissing })
      return { panel: null, reason: lastMissing }
    }
    lastPanel = emptyPanel(lastMissing)
    lastReason = lastMissing
    return { panel: lastPanel, reason: lastMissing }
  }

  return {
    id: PANEL_ID,
    title: PANEL_TITLE,
    files,
    dailyFile: options.dailyFile || null,
    poll,
    stats() {
      return { files, dailyFile: options.dailyFile || null, consecutiveFailures, lastReason, staleAfterMs, failuresBeforeEmpty }
    },
  }
}
