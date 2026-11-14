import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PanelHub } from '../../panels/hub.js'
import { LIMITS } from '../../panels/schema.js'

function clock(start = 1_700_000_000_000) {
  let t = start
  return {
    now: () => t,
    advance(ms) {
      t += ms
    },
  }
}

function panel(overrides = {}) {
  return {
    v: 1,
    id: overrides.id || 'p1',
    kind: 'metric',
    title: overrides.title || 'Panel',
    payload: { value: 1 },
    ...overrides,
  }
}

test('publish stores, replaces, and reports the revision', () => {
  const c = clock()
  const hub = new PanelHub({ now: c.now, notifyIntervalMs: 0 })
  const first = hub.publish('plug', panel())
  assert.equal(first.ok, true)
  assert.equal(first.replaced, false)
  const second = hub.publish('plug', panel({ payload: { value: 2 } }))
  assert.equal(second.ok, true)
  assert.equal(second.replaced, true)
  assert.equal(hub.snapshot().panels.length, 1)
  assert.equal(hub.snapshot().panels[0].payload.value, 2)
  assert.equal(hub.revision, 2)
  hub.dispose()
})

test('rejects invalid panels without throwing', () => {
  const hub = new PanelHub({ now: clock().now })
  assert.equal(hub.publish('plug', null).ok, false)
  assert.equal(hub.publish('bad producer!', panel()).ok, false)
  assert.equal(hub.publish('plug', { v: 1, id: 'x', producer: 'p', kind: 'nope', title: 't' }).ok, false)
  assert.equal(hub.stats().rejected, 3)
  hub.dispose()
})

test('orders by priority desc, then order asc, then title', () => {
  const c = clock()
  const hub = new PanelHub({ now: c.now, notifyIntervalMs: 0 })
  hub.publish('a', panel({ id: 'low', title: 'low', priority: 1 }))
  hub.publish('a', panel({ id: 'high', title: 'high', priority: 9 }))
  hub.publish('a', panel({ id: 'mid', title: 'mid', priority: 5, order: 2 }))
  hub.publish('a', panel({ id: 'mid2', title: 'mid2', priority: 5, order: 1 }))
  const ids = hub.snapshot().panels.map((p) => p.id)
  assert.deepEqual(ids, ['high', 'mid2', 'mid', 'low'])
  hub.dispose()
})

test('evicts the lowest-value panel when full, and counts the drop', () => {
  const c = clock()
  const hub = new PanelHub({ now: c.now, notifyIntervalMs: 0, maxPanels: 3 })
  hub.publish('a', panel({ id: 'a1', title: 'a1', priority: 1 }))
  hub.publish('a', panel({ id: 'a2', title: 'a2', priority: 2 }))
  hub.publish('a', panel({ id: 'a3', title: 'a3', priority: 3 }))
  const result = hub.publish('b', panel({ id: 'b1', title: 'b1', priority: 9 }))
  assert.equal(result.ok, true)
  assert.equal(result.evicted, 'a/a1')
  const ids = hub.snapshot().panels.map((p) => p.id).sort()
  assert.deepEqual(ids, ['a2', 'a3', 'b1'])
  assert.equal(hub.stats().dropped, 1)
  hub.dispose()
})

test('rate limits a chatty producer but not a burst', () => {
  const c = clock()
  const hub = new PanelHub({ now: c.now, notifyIntervalMs: 0, bucket: { capacity: 3, refillMs: 1000 } })
  assert.equal(hub.publish('noisy', panel({ id: 'a' })).ok, true)
  assert.equal(hub.publish('noisy', panel({ id: 'b' })).ok, true)
  assert.equal(hub.publish('noisy', panel({ id: 'c' })).ok, true)
  const limited = hub.publish('noisy', panel({ id: 'd' }))
  assert.equal(limited.ok, false)
  assert.equal(limited.code, 'RATE_LIMIT')
  assert.ok(limited.retryAfterMs > 0)
  c.advance(2000)
  assert.equal(hub.publish('noisy', panel({ id: 'e' })).ok, true)
  hub.dispose()
})

test('rate limits are per producer', () => {
  const c = clock()
  const hub = new PanelHub({ now: c.now, notifyIntervalMs: 0, bucket: { capacity: 1, refillMs: 10_000 } })
  assert.equal(hub.publish('a', panel({ id: 'x' })).ok, true)
  assert.equal(hub.publish('a', panel({ id: 'y' })).ok, false)
  assert.equal(hub.publish('b', panel({ id: 'y' })).ok, true)
  hub.dispose()
})

test('toasts have their own cooldown', () => {
  const c = clock()
  const hub = new PanelHub({ now: c.now, notifyIntervalMs: 0, toastCooldownMs: 2000 })
  const toast = { v: 1, id: 'toast', kind: 'toast', title: 't', payload: { text: 'hi' } }
  assert.equal(hub.publish('p', toast).ok, true)
  const blocked = hub.publish('p', toast)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'TOAST_COOLDOWN')
  c.advance(2500)
  assert.equal(hub.publish('p', { ...toast, id: 'toast2' }).ok, true)
  hub.dispose()
})

test('expire drops panels whose producer stopped refreshing them', () => {
  const c = clock()
  const hub = new PanelHub({ now: c.now, notifyIntervalMs: 0 })
  hub.publish('p', panel({ id: 'short', ttlMs: 5000 }))
  hub.publish('p', panel({ id: 'long', ttlMs: 600_000 }))
  c.advance(10_000)
  assert.equal(hub.expire(), 1)
  const ids = hub.snapshot().panels.map((p) => p.id)
  assert.deepEqual(ids, ['long'])
  hub.dispose()
})

test('snapshot exposes age and expiry for every panel', () => {
  const c = clock()
  const hub = new PanelHub({ now: c.now, notifyIntervalMs: 0 })
  hub.publish('p', panel({ ttlMs: 60_000 }))
  c.advance(1500)
  const entry = hub.snapshot().panels[0]
  assert.equal(entry.ageMs, 1500)
  assert.equal(entry.expiresAt, new Date(c.now() + 58_500).toISOString())
  hub.dispose()
})

test('remove and clearProducer', () => {
  const c = clock()
  const hub = new PanelHub({ now: c.now, notifyIntervalMs: 0 })
  hub.publish('p', panel({ id: 'a' }))
  hub.publish('p', panel({ id: 'b' }))
  assert.equal(hub.remove('p', 'a'), true)
  assert.equal(hub.remove('p', 'a'), false)
  assert.equal(hub.clearProducer('p'), 1)
  assert.equal(hub.snapshot().panels.length, 0)
  hub.dispose()
})

test('subscribers are coalesced, not called once per publish', async () => {
  const c = clock()
  const hub = new PanelHub({ now: c.now, notifyIntervalMs: 20 })
  const seen = []
  hub.subscribe((snapshot, reason) => seen.push({ count: snapshot.panels.length, reason }))
  hub.publish('p', panel({ id: 'a' }))
  hub.publish('p', panel({ id: 'b' }))
  hub.publish('p', panel({ id: 'c' }))
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].count, 3)
  hub.dispose()
})

test('a throwing subscriber cannot break the hub', () => {
  const c = clock()
  const hub = new PanelHub({ now: c.now, notifyIntervalMs: 0 })
  hub.subscribe(() => {
    throw new Error('boom')
  })
  hub.publish('p', panel())
  assert.doesNotThrow(() => hub.flushNow())
  assert.equal(hub.snapshot().panels.length, 1)
  hub.dispose()
})

test('producer cap evicts idle producers, never ones holding panels', () => {
  const c = clock()
  const hub = new PanelHub({ now: c.now, notifyIntervalMs: 0, maxProducers: 2 })
  hub.publish('a', panel({ id: 'x' }))
  hub.publish('b', panel({ id: 'y' }))
  // 'a' and 'b' both hold panels; a third producer must not evict them.
  hub.publish('c', panel({ id: 'z' }))
  assert.equal(hub.producers.size, 3)
  hub.clearProducer('c')
  c.advance(10)
  hub.publish('d', panel({ id: 'w' }))
  assert.ok(hub.producers.size <= 3)
  hub.dispose()
})

test('has and hasProducer report presence', () => {
  const c = clock()
  const hub = new PanelHub({ now: c.now, notifyIntervalMs: 0 })
  hub.publish('p', panel({ id: 'a' }))
  assert.equal(hub.has('p', 'a'), true)
  assert.equal(hub.has('p', 'b'), false)
  assert.equal(hub.has('nope', 'a'), false)
  assert.equal(hub.has('bad id', 'a'), false)
  assert.equal(hub.hasProducer('p'), true)
  assert.equal(hub.hasProducer('q'), false)
  hub.remove('p', 'a')
  assert.equal(hub.hasProducer('p'), false)
  hub.dispose()
})

test('disposed hub refuses writes', () => {
  const hub = new PanelHub({ now: clock().now })
  hub.dispose()
  const result = hub.publish('p', panel())
  assert.equal(result.ok, false)
  assert.equal(result.code, 'DISPOSED')
})

test('the panel cap is bounded by LIMITS', () => {
  const c = clock()
  const hub = new PanelHub({ now: c.now, notifyIntervalMs: 0 })
  for (let i = 0; i < LIMITS.panels + 5; i++) {
    hub.publish('p', panel({ id: 'pane-' + i, title: 'pane-' + i }))
  }
  assert.equal(hub.snapshot().panels.length, LIMITS.panels)
  hub.dispose()
})
