import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LIMITS, PANEL_KINDS, normalizePanel, readString } from '../../panels/schema.js'

const base = {
  v: 1,
  id: 'token-savings',
  kind: 'metric',
  title: 'Token 节省',
  payload: { value: 197531, unit: 'tokens', label: '累计节省' },
}

test('accepts a well-formed metric panel and applies defaults', () => {
  const result = normalizePanel({ ...base, producer: 'dsh-context-manager' })
  assert.equal(result.ok, true)
  assert.equal(result.panel.id, 'token-savings')
  assert.equal(result.panel.producer, 'dsh-context-manager')
  assert.equal(result.panel.status, 'ok')
  assert.equal(result.panel.ttlMs, LIMITS.ttlDefault)
  assert.equal(result.panel.priority, 5)
  assert.equal(result.panel.order, 0)
  assert.deepEqual(result.panel.payload, { value: 197531, unit: 'tokens', label: '累计节省' })
})

test('producer comes from context when provided', () => {
  const result = normalizePanel(base, { producer: 'other-plugin' })
  assert.equal(result.ok, true)
  assert.equal(result.panel.producer, 'other-plugin')
})

test('rejects missing producer, bad id, bad kind, missing title', () => {
  assert.equal(normalizePanel(base).ok, false)
  assert.equal(normalizePanel({ ...base, producer: 'p', id: 'has space' }).ok, false)
  assert.equal(normalizePanel({ ...base, producer: 'p', id: '-leading' }).ok, false)
  assert.equal(normalizePanel({ ...base, producer: 'p', kind: 'chart' }).ok, false)
  const noTitle = normalizePanel({ ...base, producer: 'p', title: '   ' })
  assert.equal(noTitle.ok, false)
  assert.equal(noTitle.code, 'SCHEMA')
})

test('rejects an unsupported protocol version', () => {
  const result = normalizePanel({ ...base, producer: 'p', v: 99 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'VERSION')
})

test('strips control characters and collapses whitespace', () => {
  const result = normalizePanel({
    ...base,
    producer: 'p',
    title: 'Token\u0000 节省\n\n面板',
    payload: { value: 1, items: [{ label: 'a\u0007b', value: 2 }] },
  })
  assert.equal(result.ok, true)
  assert.equal(result.panel.title, 'Token 节省 面板')
  assert.equal(result.panel.payload.items[0].label, 'a b')
})

test('truncates oversized strings instead of rejecting them', () => {
  const long = 'x'.repeat(500)
  const result = normalizePanel({ ...base, producer: 'p', title: long })
  assert.equal(result.ok, true)
  assert.equal(Array.from(result.panel.title).length, LIMITS.title)
})

test('clamps ttl, priority and order into their ranges', () => {
  const result = normalizePanel({ ...base, producer: 'p', ttlMs: 1, priority: 99, order: -5 })
  assert.equal(result.ok, true)
  assert.equal(result.panel.ttlMs, LIMITS.ttlMin)
  assert.equal(result.panel.priority, 9)
  assert.equal(result.panel.order, 0)
})

test('rejects non-finite and absurd numbers', () => {
  assert.equal(normalizePanel({ ...base, producer: 'p', payload: { value: NaN } }).ok, false)
  assert.equal(normalizePanel({ ...base, producer: 'p', payload: { value: Infinity } }).ok, false)
  assert.equal(normalizePanel({ ...base, producer: 'p', payload: { value: 1e18 } }).ok, false)
  assert.equal(normalizePanel({ ...base, producer: 'p', payload: { value: '12' } }).ok, false)
})

test('caps the item list and drops unusable rows', () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ label: 'm' + i, value: i }))
  items.push({ label: '', value: 3 })
  const result = normalizePanel({ ...base, producer: 'p', payload: { value: 1, items } })
  assert.equal(result.ok, true)
  assert.equal(result.panel.payload.items.length, LIMITS.items)
})

test('progress payload requires max > 0 and clamps value', () => {
  const ok = normalizePanel({ v: 1, id: 'p1', producer: 'p', kind: 'progress', title: 't', payload: { value: 120, max: 100 } })
  assert.equal(ok.ok, true)
  assert.equal(ok.panel.payload.value, 100)
  assert.equal(normalizePanel({ v: 1, id: 'p1', producer: 'p', kind: 'progress', title: 't', payload: { value: 1, max: 0 } }).ok, false)
})

test('badge and text kinds validate their payloads', () => {
  assert.equal(normalizePanel({ v: 1, id: 'b', producer: 'p', kind: 'badge', title: 't', payload: { text: 'ok' } }).panel.payload.tone, 'info')
  assert.equal(normalizePanel({ v: 1, id: 'b', producer: 'p', kind: 'badge', title: 't', payload: { text: 'ok', tone: 'chartreuse' } }).panel.payload.tone, 'info')
  assert.equal(normalizePanel({ v: 1, id: 'b', producer: 'p', kind: 'text', title: 't', payload: { lines: [] } }).ok, false)
  assert.equal(normalizePanel({ v: 1, id: 'b', producer: 'p', kind: 'text', title: 't', payload: { lines: ['a', 2, 'b'] } }).panel.payload.lines.length, 2)
})

test('toast duration is clamped and defaults', () => {
  const short = normalizePanel({ v: 1, id: 't', producer: 'p', kind: 'toast', title: 't', payload: { text: 'hi', durationMs: 10 } })
  assert.equal(short.panel.payload.durationMs, LIMITS.toastMinMs)
  const none = normalizePanel({ v: 1, id: 't', producer: 'p', kind: 'toast', title: 't', payload: { text: 'hi' } })
  assert.equal(none.panel.payload.durationMs, LIMITS.toastDefaultMs)
})

test('empty status carries a reason and needs no payload', () => {
  const result = normalizePanel({ v: 1, id: 'e', producer: 'p', kind: 'metric', title: '暂无', status: 'empty', emptyReason: '找不到 savings.json' })
  assert.equal(result.ok, true)
  assert.equal(result.panel.status, 'empty')
  assert.deepEqual(result.panel.payload, { emptyReason: '找不到 savings.json' })
})

test('every declared kind has a reachable validator', () => {
  for (const kind of PANEL_KINDS) {
    const payload = kind === 'metric'
      ? { value: 1 }
      : kind === 'progress'
        ? { value: 1, max: 2 }
        : kind === 'badge'
          ? { text: 'x' }
          : kind === 'list'
            ? { items: [{ label: 'a' }] }
            : kind === 'text'
              ? { lines: ['x'] }
              : { text: 'x' }
    const result = normalizePanel({ v: 1, id: 'k-' + kind, producer: 'p', kind, title: 't', payload })
    assert.equal(result.ok, true, 'kind ' + kind + ' should validate')
  }
})

test('readString is total: never throws on hostile input', () => {
  const hostile = [undefined, null, 1, {}, [], '\u0000\u0000', 'a'.repeat(10000)]
  for (const value of hostile) {
    assert.doesNotThrow(() => readString(value, 10))
  }
  assert.equal(readString('\u0000\u0000', 10), null)
})
