// Panel protocol v1 — validation and normalization.
//
// Every panel that reaches the store goes through normalizePanel(): unknown
// fields are dropped, strings are stripped of control characters and capped,
// numbers must be finite, and each kind gets a small explicit payload schema.
// Normalization never throws: it returns a result object so the caller can map
// failures to a transport status code instead of an exception.
//
// Design rule: the client renders panel text with textContent only. Validation
// still bounds every string, because an unbounded string is a layout DoS even
// when it is not executable.

export const PROTOCOL_VERSION = 1

export const PANEL_KINDS = ['metric', 'progress', 'badge', 'list', 'text', 'toast']

export const LIMITS = {
  /** Panels kept at once across all producers. */
  panels: 8,
  /** Distinct producers tracked at once. */
  producers: 16,
  /** Largest accepted publish body, bytes. */
  bodyBytes: 16 * 1024,
  id: 64,
  title: 64,
  label: 48,
  unit: 8,
  note: 96,
  text: 280,
  itemLabel: 32,
  itemValue: 24,
  items: 8,
  line: 96,
  lines: 6,
  /** Largest absolute numeric value accepted for any metric. */
  valueAbs: 1e15,
  ttlMin: 5_000,
  ttlMax: 86_400_000,
  ttlDefault: 300_000,
  toastMinMs: 2_000,
  toastMaxMs: 15_000,
  toastDefaultMs: 4_500,
  /** Panels rendered by the pet at once; the rest are summarised. */
  visible: 4,
}

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/i
const PRODUCER_RE = /^[a-z0-9][a-z0-9._-]*$/i

function truncate(text, max) {
  const points = Array.from(text)
  if (points.length <= max) return text
  return points.slice(0, max).join('')
}

/**
 * Turn arbitrary input into a bounded, single-line, control-character-free
 * string. Returns null for values that normalize to nothing.
 */
export function readString(value, max) {
  if (typeof value !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return null
  return truncate(cleaned, max)
}

/** Read a finite number within the accepted magnitude. */
export function readNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (Math.abs(value) > LIMITS.valueAbs) return null
  return value
}

/**
 * Strip a leading UTF-8 BOM. Windows tools (PowerShell 5.1 `Set-Content
 * -Encoding UTF8`, Notepad) write one, and `JSON.parse` rejects it — a producer
 * whose file is otherwise perfect would silently never show up.
 */
export function stripBom(text) {
  if (typeof text !== 'string') return text
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export function readId(value, max = LIMITS.id) {
  const text = readString(value, max)
  if (text === null) return null
  if (!ID_RE.test(text)) return null
  return text.toLowerCase()
}

export function readProducerId(value) {
  const text = readString(value, LIMITS.id)
  if (text === null) return null
  if (!PRODUCER_RE.test(text)) return null
  return text.toLowerCase()
}

function readItems(value, withValues) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) return null
  const items = []
  for (const raw of value.slice(0, LIMITS.items)) {
    if (!raw || typeof raw !== 'object') continue
    const label = readString(raw.label, LIMITS.itemLabel)
    if (label === null) continue
    const item = { label }
    if (withValues && raw.value !== undefined) {
      if (typeof raw.value === 'number') {
        const n = readNumber(raw.value)
        if (n === null) continue
        item.value = n
      } else {
        const text = readString(raw.value, LIMITS.itemValue)
        if (text === null) continue
        item.value = text
      }
    }
    // Per-row compression rate: "this dimension saved 50% of what it used to
    // cost". Optional, because it needs the producer's per-dimension original.
    if (raw.percent !== undefined && raw.percent !== null) {
      const percent = readNumber(raw.percent)
      if (percent !== null && percent >= 0 && percent <= 100) item.percent = Math.round(percent * 10) / 10
    }
    items.push(item)
  }
  return items
}

function readPayload(kind, payload) {
  if (payload !== undefined && payload !== null && typeof payload !== 'object') return null
  const src = payload && typeof payload === 'object' ? payload : {}

  switch (kind) {
    case 'metric': {
      const value = readNumber(src.value)
      if (value === null) return null
      const out = { value }
      const unit = readString(src.unit, LIMITS.unit)
      if (unit !== null) out.unit = unit
      const label = readString(src.label, LIMITS.label)
      if (label !== null) out.label = label
      const items = readItems(src.items, true)
      if (items === null) return null
      if (items !== undefined) out.items = items
      const note = readString(src.note, LIMITS.note)
      if (note !== null) out.note = note
      // Optional savings rate. `percent` is a 0..100 number; the basis says what
      // it is relative to ("本轮" per turn, "整体" overall) so the card can print
      // an unambiguous chip instead of a naked percentage.
      if (src.rate !== undefined && src.rate !== null && typeof src.rate === 'object') {
        const percent = readNumber(src.rate.percent)
        if (percent !== null && percent >= 0 && percent <= 100) {
          const rate = { percent: Math.round(percent * 10) / 10 }
          const rateLabel = readString(src.rate.label, LIMITS.itemLabel)
          if (rateLabel !== null) rate.label = rateLabel
          out.rate = rate
        }
      }
      if (src.showShare === true) out.showShare = true
      // Optional secondary figure for detail surfaces: "today, all workspaces"
      // as the headline with "this session" beside it, or the reverse.
      if (src.scope !== undefined && src.scope !== null && typeof src.scope === 'object') {
        const scopeValue = readNumber(src.scope.value)
        if (scopeValue !== null) {
          const scope = { value: scopeValue }
          const scopeLabel = readString(src.scope.label, LIMITS.label)
          if (scopeLabel !== null) scope.label = scopeLabel
          const scopeUnit = readString(src.scope.unit, LIMITS.unit)
          if (scopeUnit !== null) scope.unit = scopeUnit
          const scopeItems = readItems(src.scope.items, true)
          if (scopeItems !== undefined) scope.items = scopeItems
          out.scope = scope
        }
      }
      // Where the numbers came from, for the detail view: a mismatched panel is
      // almost always a panel reading a different file than the user expects.
      const source = readString(src.source, LIMITS.title)
      if (source !== null) out.source = source
      // Money: provider usage × official unit price. It is a second, independent
      // metric — never converted from token counts, which would be a different
      // number (prefix tokens cost 1/200 of output tokens).
      const moneyText = readString(src.moneyText, LIMITS.title)
      if (moneyText !== null) out.moneyText = moneyText
      if (src.money && typeof src.money === 'object') {
        const money = {}
        for (const key of ['saved', 'actual', 'counterfactual', 'percent']) {
          const n = readNumber(src.money[key])
          if (n !== null && n >= 0) money[key] = Math.round(n * 10000) / 10000
        }
        const savedText = readString(src.money.savedText, LIMITS.title)
        if (savedText !== null) money.savedText = savedText
        // 逐轮计价的口径信息：轮次数、加权命中率、均价，渲染层要能解释金额来源。
        const basis = readString(src.money.basis, 24)
        if (basis !== null) money.basis = basis
        for (const key of ['turns', 'effectiveHitRate', 'avgPricePerMillion', 'savedHitTokens', 'savedMissTokens']) {
          const n = readNumber(src.money[key])
          if (n !== null && n >= 0) money[key] = Math.round(n * 10000) / 10000
        }
        if (Object.keys(money).length > 0) out.money = money
      }
      // A one-off reduction that must never blend into a cumulative figure.
      if (src.fold !== undefined && src.fold !== null) {
        const fold = readNumber(src.fold)
        if (fold !== null && fold >= 0) out.fold = Math.round(fold)
      }
      // Σ prompt tokens actually sent: the denominator every row's rate is
      // relative to, and the total rate's denominator too.
      if (src.consumed !== undefined && src.consumed !== null) {
        const consumed = readNumber(src.consumed)
        if (consumed !== null && consumed >= 0) out.consumed = Math.round(consumed)
      }
      // Cost-equivalent total (cache-prefix weighting), kept as a secondary
      // figure next to the raw token headline.
      if (src.cost !== undefined && src.cost !== null) {
        const cost = readNumber(src.cost)
        if (cost !== null && cost >= 0) out.cost = Math.round(cost)
      }
      // Savings ratio for the whole period. `estimate` tells the UI to label it
      // as such instead of presenting it as exact.
      if (src.percent !== undefined && src.percent !== null && typeof src.percent === 'object') {
        const value = readNumber(src.percent.value)
        if (value !== null && value >= 0 && value <= 100) {
          const percent = { value: Math.round(value * 10) / 10 }
          if (src.percent.estimate === true) percent.estimate = true
          const percentLabel = readString(src.percent.label, LIMITS.itemLabel)
          if (percentLabel !== null) percent.label = percentLabel
          out.percent = percent
        }
      }
      // Per-workspace slices, newest first. Detail surfaces render these; the
      // pet card ignores them and keeps the aggregate.
      if (Array.isArray(src.workspaces)) {
        const workspaces = []
        for (const raw of src.workspaces.slice(0, LIMITS.items)) {
          if (!raw || typeof raw !== 'object') continue
          const value = readNumber(raw.value)
          if (value === null || value < 0) continue
          const entry = { value: Math.round(value) }
          const label = readString(raw.label, LIMITS.itemLabel)
          if (label !== null) entry.label = label
          const id = readString(raw.id, LIMITS.id)
          if (id !== null) entry.id = id
          const cost = readNumber(raw.cost)
          if (cost !== null && cost >= 0) entry.cost = Math.round(cost)
          const percent = readNumber(raw.percent)
          if (percent !== null && percent >= 0 && percent <= 100) entry.percent = Math.round(percent * 10) / 10
          const items = readItems(raw.items, true)
          if (items !== undefined) entry.items = items
          // 该工作区自己的金额与轮次：会话内「节省」页必须显示本工作区的值，
          // 缺失就会退化成全局金额（0 token 却有钱的 bug）。
          const cny = readNumber(raw.cny)
          if (cny !== null && cny >= 0) entry.cny = Math.round(cny * 1000000) / 1000000
          const turns = readNumber(raw.turns)
          if (turns !== null && turns >= 0) entry.turns = Math.round(turns)
          const before = readNumber(raw.before)
          if (before !== null && before >= 0) entry.before = Math.round(before)
          const after = readNumber(raw.after)
          if (after !== null && after >= 0) entry.after = Math.round(after)
          workspaces.push(entry)
        }
        if (workspaces.length > 0) out.workspaces = workspaces
      }
      // sessionId -> workspaceId：会话内的「节省」页据此定位自己的工作区，
      // 不依赖客户端解析 cwd（宿主上该字段常为空）。
      if (src.bySession && typeof src.bySession === 'object' && !Array.isArray(src.bySession)) {
        const map = {}
        for (const [sessionId, workspaceId] of Object.entries(src.bySession)) {
          if (Object.keys(map).length >= LIMITS.items) break
          const key = readString(sessionId, LIMITS.id)
          const val = readString(workspaceId, LIMITS.id)
          if (key !== null && val !== null) map[key] = val
        }
        if (Object.keys(map).length > 0) out.bySession = map
      }
      return out
    }
    case 'progress': {
      const value = readNumber(src.value)
      const max = readNumber(src.max)
      if (value === null || max === null || max <= 0) return null
      const out = { value: Math.max(0, Math.min(value, max)), max }
      const label = readString(src.label, LIMITS.label)
      if (label !== null) out.label = label
      return out
    }
    case 'badge': {
      const text = readString(src.text, LIMITS.itemLabel)
      if (text === null) return null
      const out = { text }
      const tones = ['info', 'ok', 'warn', 'error']
      out.tone = tones.includes(src.tone) ? src.tone : 'info'
      return out
    }
    case 'list': {
      const items = readItems(src.items, true)
      if (!items || items.length === 0) return null
      return { items }
    }
    case 'text': {
      if (!Array.isArray(src.lines)) return null
      const lines = []
      for (const raw of src.lines.slice(0, LIMITS.lines)) {
        const line = readString(raw, LIMITS.line)
        if (line !== null) lines.push(line)
      }
      if (lines.length === 0) return null
      return { lines }
    }
    case 'toast': {
      const text = readString(src.text, LIMITS.text)
      if (text === null) return null
      const duration = readNumber(src.durationMs)
      const ms = duration === null
        ? LIMITS.toastDefaultMs
        : Math.min(LIMITS.toastMaxMs, Math.max(LIMITS.toastMinMs, Math.round(duration)))
      const out = { text, durationMs: ms }
      const tone = src.tone
      const tones = ['info', 'ok', 'warn', 'error']
      out.tone = tones.includes(tone) ? tone : 'info'
      return out
    }
    default:
      return null
  }
}

/**
 * Normalize an arbitrary panel document.
 *
 * @param {unknown} raw candidate panel
 * @param {{producer?: string}} [context]
 * @returns {{ok: true, panel: object} | {ok: false, code: string, error: string}}
 */
export function normalizePanel(raw, context = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'SCHEMA', error: 'panel must be an object' }
  }
  const doc = raw

  const version = doc.v === undefined ? PROTOCOL_VERSION : doc.v
  if (version !== PROTOCOL_VERSION) {
    return { ok: false, code: 'VERSION', error: 'unsupported protocol version ' + String(version) }
  }

  const id = readId(doc.id)
  if (id === null) return { ok: false, code: 'SCHEMA', error: 'id must match [a-z0-9][a-z0-9._-]{0,63}' }

  const producer = context.producer !== undefined ? context.producer : readProducerId(doc.producer)
  if (!producer || !PRODUCER_RE.test(producer)) {
    return { ok: false, code: 'SCHEMA', error: 'producer is missing or invalid' }
  }

  const kind = doc.kind === undefined ? 'metric' : doc.kind
  if (!PANEL_KINDS.includes(kind)) {
    return { ok: false, code: 'SCHEMA', error: 'kind must be one of ' + PANEL_KINDS.join(', ') }
  }

  const title = doc.title === undefined ? null : readString(doc.title, LIMITS.title)
  if (title === null) return { ok: false, code: 'SCHEMA', error: 'title is required' }

  const status = doc.status === undefined ? 'ok' : doc.status
  if (status !== 'ok' && status !== 'empty') {
    return { ok: false, code: 'SCHEMA', error: "status must be 'ok' or 'empty'" }
  }

  let payload = null
  if (status === 'ok') {
    payload = readPayload(kind, doc.payload)
    if (payload === null) {
      return { ok: false, code: 'SCHEMA', error: 'payload does not match kind ' + kind }
    }
  } else {
    // An empty panel only needs to say why.
    const reason = readString(doc.emptyReason, LIMITS.note)
    payload = reason === null ? {} : { emptyReason: reason }
  }

  const ttlRaw = readNumber(doc.ttlMs)
  const ttlMs = ttlRaw === null
    ? LIMITS.ttlDefault
    : Math.min(LIMITS.ttlMax, Math.max(LIMITS.ttlMin, Math.round(ttlRaw)))

  const prioRaw = readNumber(doc.priority)
  const priority = prioRaw === null ? 5 : Math.max(0, Math.min(9, Math.round(prioRaw)))

  const orderRaw = readNumber(doc.order)
  const order = orderRaw === null ? 0 : Math.max(0, Math.min(999, Math.round(orderRaw)))

  return {
    ok: true,
    panel: {
      v: PROTOCOL_VERSION,
      id,
      producer,
      kind,
      title,
      status,
      ttlMs,
      priority,
      order,
      payload,
    },
  }
}
