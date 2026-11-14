// Panel store: the single source of truth between producers and the pet.
//
// Responsibilities, deliberately kept in one small dependency-free class:
//   - accept panels from many producers, keyed by (producer, id)
//   - reject malformed input through schema.js
//   - bound growth: at most LIMITS.panels panels and LIMITS.producers producers
//   - rate limit per producer (token bucket) and toasts (cooldown)
//   - expire panels that stop being refreshed (ttlMs)
//   - notify subscribers at a bounded rate, never per publish
//
// The hub never touches sockets, timers owned by the plugin, or the filesystem;
// the runtime wires those. That keeps it unit-testable with a fake clock.

import { LIMITS, normalizePanel, readId, readProducerId } from './schema.js'

const DEFAULT_BUCKET = { capacity: 20, refillMs: 200 }
const DEFAULT_TOAST_COOLDOWN_MS = 2_000
const DEFAULT_NOTIFY_INTERVAL_MS = 250

class Bucket {
  constructor(capacity, refillMs) {
    this.capacity = capacity
    this.refillMs = refillMs
    this.tokens = capacity
    this.updatedAt = 0
  }

  take(now) {
    if (this.updatedAt === 0) this.updatedAt = now
    const elapsed = Math.max(0, now - this.updatedAt)
    if (elapsed > 0) {
      const gained = elapsed / this.refillMs
      if (gained >= 1) {
        this.tokens = Math.min(this.capacity, this.tokens + gained)
        this.updatedAt = now
      }
    }
    if (this.tokens < 1) {
      return { ok: false, retryAfterMs: Math.ceil((1 - this.tokens) * this.refillMs) }
    }
    this.tokens -= 1
    return { ok: true, retryAfterMs: 0 }
  }
}

export class PanelHub {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now] injectable clock (ms)
   * @param {number} [options.maxPanels]
   * @param {number} [options.maxProducers]
   * @param {{capacity: number, refillMs: number}} [options.bucket]
   * @param {number} [options.toastCooldownMs]
   * @param {number} [options.notifyIntervalMs]
   * @param {(level: string, message: string, detail?: object) => void} [options.log]
   */
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.maxPanels = Number.isFinite(options.maxPanels) ? options.maxPanels : LIMITS.panels
    this.maxProducers = Number.isFinite(options.maxProducers) ? options.maxProducers : LIMITS.producers
    this.bucketConfig = options.bucket || DEFAULT_BUCKET
    this.toastCooldownMs = Number.isFinite(options.toastCooldownMs) ? options.toastCooldownMs : DEFAULT_TOAST_COOLDOWN_MS
    this.notifyIntervalMs = Number.isFinite(options.notifyIntervalMs) ? options.notifyIntervalMs : DEFAULT_NOTIFY_INTERVAL_MS
    this.log = typeof options.log === 'function' ? options.log : () => {}

    /** @type {Map<string, {panel: object, updatedAt: number, key: string}>} */
    this.entries = new Map()
    /** @type {Map<string, {bucket: Bucket, lastToastAt: number, lastSeenAt: number, rejected: number}>} */
    this.producers = new Map()
    this.listeners = new Set()
    this.revision = 0
    this.dropped = 0
    this.rejected = 0
    this.notifyTimer = null
    this.pendingReason = null
    this.disposed = false
  }

  producerState(producer) {
    let state = this.producers.get(producer)
    if (!state) {
      if (this.producers.size >= this.maxProducers) {
        this.evictIdleProducer()
      }
      state = {
        bucket: new Bucket(this.bucketConfig.capacity, this.bucketConfig.refillMs),
        lastToastAt: 0,
        lastSeenAt: this.now(),
        rejected: 0,
      }
      this.producers.set(producer, state)
    }
    return state
  }

  evictIdleProducer() {
    let victim = null
    for (const [producer, state] of this.producers) {
      const hasPanels = this.countPanelsOf(producer) > 0
      if (hasPanels) continue
      if (!victim || state.lastSeenAt < victim.state.lastSeenAt) victim = { producer, state }
    }
    if (!victim) return false
    this.producers.delete(victim.producer)
    return true
  }

  countPanelsOf(producer) {
    let n = 0
    for (const entry of this.entries.values()) if (entry.panel.producer === producer) n++
    return n
  }

  /** True when this exact panel is currently stored. */
  has(producer, id) {
    const producerId = readProducerId(producer)
    const panelId = readId(id)
    if (producerId === null || panelId === null) return false
    return this.entries.has(this.keyOf(producerId, panelId))
  }

  /** True when the producer has at least one panel stored. */
  hasProducer(producer) {
    const producerId = readProducerId(producer)
    if (producerId === null) return false
    return this.countPanelsOf(producerId) > 0
  }

  keyOf(producer, id) {
    return producer + '\u0000' + id
  }

  /** Lowest-value panel to drop when the store is full: low priority, then oldest. */
  pickEvictionVictim() {
    let victim = null
    for (const [key, entry] of this.entries) {
      if (!victim) {
        victim = { key, entry }
        continue
      }
      const a = entry.panel
      const b = victim.entry.panel
      if (a.priority < b.priority || (a.priority === b.priority && entry.updatedAt < victim.entry.updatedAt)) {
        victim = { key, entry }
      }
    }
    return victim
  }

  /**
   * Publish (insert or replace) one panel for a producer.
   *
   * @param {string} producer producer id, already validated or validated here
   * @param {unknown} raw panel document
   * @param {{allowToast?: boolean}} [options]
   * @returns {{ok: true, panel: object, replaced: boolean, evicted: string|null, revision: number}
   *          | {ok: false, code: string, error: string, retryAfterMs?: number}}
   */
  publish(producer, raw, options = {}) {
    if (this.disposed) return { ok: false, code: 'DISPOSED', error: 'panel hub is disposed' }

    const producerId = readProducerId(producer)
    if (producerId === null) {
      this.rejected++
      return { ok: false, code: 'SCHEMA', error: 'producer id is invalid' }
    }

    const normalized = normalizePanel(raw, { producer: producerId })
    if (!normalized.ok) {
      this.rejected++
      this.log('warn', 'panel rejected by schema', { producer: producerId, code: normalized.code, error: normalized.error })
      return normalized
    }
    const panel = normalized.panel

    if (options.allowToast === false && panel.kind === 'toast') {
      return { ok: false, code: 'FORBIDDEN', error: 'toasts are not accepted on this channel' }
    }

    const state = this.producerState(producerId)

    if (panel.kind === 'toast') {
      const since = this.now() - state.lastToastAt
      if (state.lastToastAt !== 0 && since < this.toastCooldownMs) {
        this.rejected++
        state.rejected++
        return { ok: false, code: 'TOAST_COOLDOWN', error: 'toast rate limited', retryAfterMs: this.toastCooldownMs - since }
      }
    }

    const budget = state.bucket.take(this.now())
    if (!budget.ok) {
      this.rejected++
      state.rejected++
      this.log('warn', 'panel publish rate limited', { producer: producerId })
      return { ok: false, code: 'RATE_LIMIT', error: 'publish rate limited', retryAfterMs: budget.retryAfterMs }
    }

    const key = this.keyOf(producerId, panel.id)
    const previous = this.entries.get(key)
    let evicted = null

    if (!previous && this.entries.size >= this.maxPanels) {
      const victim = this.pickEvictionVictim()
      if (victim) {
        this.entries.delete(victim.key)
        evicted = victim.entry.panel.producer + '/' + victim.entry.panel.id
        this.dropped++
        this.log('info', 'panel evicted to stay under the cap', { evicted, limit: this.maxPanels })
      }
    }

    const updatedAt = this.now()
    if (panel.kind === 'toast') state.lastToastAt = updatedAt
    state.lastSeenAt = updatedAt

    this.entries.set(key, { panel, updatedAt, key })
    this.revision++
    this.schedule('publish')
    return { ok: true, panel: { ...panel, updatedAt: toIso(updatedAt) }, replaced: Boolean(previous), evicted, revision: this.revision }
  }

  /** Remove one panel. Returns true when something was removed. */
  remove(producer, id) {
    const producerId = readProducerId(producer)
    const panelId = readId(id)
    if (producerId === null || panelId === null) return false
    const key = this.keyOf(producerId, panelId)
    if (!this.entries.has(key)) return false
    this.entries.delete(key)
    this.revision++
    this.schedule('remove')
    return true
  }

  /** Remove every panel of a producer; returns how many were removed. */
  clearProducer(producer) {
    const producerId = readProducerId(producer)
    if (producerId === null) return 0
    let removed = 0
    for (const [key, entry] of [...this.entries]) {
      if (entry.panel.producer !== producerId) continue
      this.entries.delete(key)
      removed++
    }
    if (removed > 0) {
      this.revision++
      this.schedule('remove')
    }
    return removed
  }

  /** Drop panels whose producer stopped refreshing them. */
  expire() {
    const now = this.now()
    let removed = 0
    for (const [key, entry] of [...this.entries]) {
      if (now - entry.updatedAt > entry.panel.ttlMs) {
        this.entries.delete(key)
        removed++
      }
    }
    if (removed > 0) {
      this.revision++
      this.dropped += removed
      this.schedule('expire')
    }
    return removed
  }

  /** Panels in rendering order: highest priority first, then order, then title. */
  sortedPanels() {
    const panels = []
    for (const entry of this.entries.values()) panels.push(entry)
    panels.sort((a, b) => {
      if (a.panel.priority !== b.panel.priority) return b.panel.priority - a.panel.priority
      if (a.panel.order !== b.panel.order) return a.panel.order - b.panel.order
      if (a.panel.title !== b.panel.title) return a.panel.title < b.panel.title ? -1 : 1
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
    })
    return panels
  }

  /** Wire representation of the whole store. */
  snapshot() {
    const now = this.now()
    const panels = this.sortedPanels().map((entry) => ({
      ...entry.panel,
      producer: entry.panel.producer,
      updatedAt: toIso(entry.updatedAt),
      ageMs: now - entry.updatedAt,
      // The client uses expiresAt to drop a panel if the stream goes quiet;
      // the host re-sends the snapshot on reconnect, so drift is bounded.
      expiresAt: toIso(entry.updatedAt + entry.panel.ttlMs),
    }))
    return {
      v: 1,
      now: toIso(now),
      revision: this.revision,
      panels,
      dropped: this.dropped,
      rejected: this.rejected,
    }
  }

  /** Subscribe to change notifications. Returns the unsubscribe function. */
  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function')
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Coalesce notifications: many publishes inside one window emit one change. */
  schedule(reason) {
    if (this.listeners.size === 0) return
    this.pendingReason = reason
    if (this.notifyTimer !== null) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      this.flushNow()
    }, this.notifyIntervalMs)
    if (typeof this.notifyTimer.unref === 'function') this.notifyTimer.unref()
  }

  /** Emit a change notification immediately (tests and shutdown paths). */
  flushNow() {
    if (this.notifyTimer !== null) {
      clearTimeout(this.notifyTimer)
      this.notifyTimer = null
    }
    if (this.listeners.size === 0) return 0
    const snapshot = this.snapshot()
    const reason = this.pendingReason || 'change'
    this.pendingReason = null
    let delivered = 0
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot, reason)
        delivered++
      } catch (err) {
        this.log('warn', 'panel subscriber threw', { error: String((err && err.message) || err) })
      }
    }
    return delivered
  }

  stats() {
    return {
      panels: this.entries.size,
      producers: this.producers.size,
      subscribers: this.listeners.size,
      revision: this.revision,
      dropped: this.dropped,
      rejected: this.rejected,
    }
  }

  dispose() {
    this.disposed = true
    if (this.notifyTimer !== null) {
      clearTimeout(this.notifyTimer)
      this.notifyTimer = null
    }
    this.listeners.clear()
    this.entries.clear()
    this.producers.clear()
  }
}

function toIso(ms) {
  try {
    return new Date(ms).toISOString()
  } catch {
    return new Date(0).toISOString()
  }
}
