// Daily accumulator: the number on the pet must survive a host restart and must
// span every ledger the host can see, instead of resetting with each process.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ACCOUNTING_VERSION,
  dayBill,
  dayModules,
  daySourceCount,
  emptyDay,
  loadDay,
  localDayKey,
  recordDay,
  saveDay,
} from '../../panels/daily.js'

const TODAY = '2026-11-10'
const startedToday = '2026-11-10T09:00:00.000Z'

test('a fresh day starts at zero', () => {
  const state = emptyDay(TODAY)
  assert.equal(state.total, 0)
  assert.deepEqual(state.modules, {})
  assert.equal(daySourceCount(state), 0)
})

test('a generation that started today contributes its whole total', () => {
  const first = recordDay(null, [{ key: 'A', startedAt: startedToday, total: 1000, byModule: { schema: 1000 } }], TODAY)
  assert.equal(first.state.total, 1000)
  assert.deepEqual(first.state.modules, { schema: 1000 })
  assert.equal(daySourceCount(first.state), 1)

  const grown = recordDay(first.state, [{ key: 'A', startedAt: startedToday, total: 1600, byModule: { schema: 1600 } }], TODAY)
  assert.equal(grown.state.total, 1600, 'growth within one generation replaces, not adds')
})

test('a restart adds the previous generation instead of overwriting it', () => {
  const gen1 = recordDay(null, [{ key: 'A', startedAt: startedToday, total: 5000, byModule: { schema: 5000 } }], TODAY)
  const gen2 = recordDay(gen1.state, [{ key: 'A', startedAt: '2026-11-10T10:00:00.000Z', total: 700, byModule: { schema: 700 } }], TODAY)
  assert.equal(gen2.state.total, 5700, 'the day total survives a producer restart')
  assert.deepEqual(gen2.state.modules, { schema: 5700 })
})

test('multiple sources are summed', () => {
  const a = recordDay(null, [{ key: 'A', startedAt: startedToday, total: 300, byModule: { schema: 300 } }], TODAY)
  const b = recordDay(a.state, [
    { key: 'A', startedAt: startedToday, total: 300, byModule: { schema: 300 } },
    { key: 'B', startedAt: startedToday, total: 200, byModule: { fold: 200 } },
  ], TODAY)
  assert.equal(b.state.total, 500)
  assert.deepEqual(b.state.modules, { schema: 300, fold: 200 })
  assert.equal(daySourceCount(b.state), 2)
})

test('a generation that started before today counts only the growth we saw', () => {
  const old = recordDay(null, [{ key: 'A', startedAt: '2026-11-09T08:00:00.000Z', total: 9000, byModule: { schema: 9000 } }], TODAY)
  assert.equal(old.state.total, 0, 'its earlier tokens belong to an earlier day')
  const grown = recordDay(old.state, [{ key: 'A', startedAt: '2026-11-09T08:00:00.000Z', total: 9500, byModule: { schema: 9500 } }], TODAY)
  assert.equal(grown.state.total, 500)
})

test('a new day resets the accumulator', () => {
  const first = recordDay(null, [{ key: 'A', startedAt: startedToday, total: 1000 }], TODAY)
  const nextDay = recordDay(first.state, [], '2026-11-11')
  assert.equal(nextDay.state.date, '2026-11-11')
  assert.equal(nextDay.state.total, 0)
})

test('hostile observations never throw or produce NaN', () => {
  const cases = [
    null,
    { key: 'A' },
    { key: 'A', total: NaN },
    { key: 'A', total: -5 },
    { key: 42, total: 1 },
    { key: 'A', total: 10, byModule: [] },
    { key: 'A', total: 10, byModule: { bad: 'x', ok: 3 } },
  ]
  let state = null
  for (const observation of cases) {
    assert.doesNotThrow(() => {
      state = recordDay(state, [observation], TODAY).state
    })
  }
  assert.ok(Number.isFinite(state.total))
  assert.deepEqual(dayModules(state), [['ok', 3]])
})

test('dayModules sorts by value and drops junk', () => {
  const state = { modules: { a: 5, b: 50, c: 0 } }
  assert.deepEqual(dayModules(state), [['b', 50], ['a', 5], ['c', 0]])
  assert.deepEqual(dayModules(null), [])
})

test('the state file round-trips and a corrupt file starts a fresh day', () => {
  const written = new Map()
  const writeFile = (file, body) => written.set(file, body)
  const rename = (from, to) => written.set(to, written.get(from))
  const state = recordDay(null, [{ key: 'A', startedAt: startedToday, total: 1234, byModule: { schema: 1234 } }], TODAY).state

  const ok = saveDay('C:/h/day.json', state, writeFile, rename)
  assert.equal(ok, true)
  const loaded = loadDay('C:/h/day.json', TODAY, () => written.get('C:/h/day.json'))
  assert.equal(loaded.total, 1234)

  assert.equal(loadDay('C:/h/day.json', TODAY, () => '{oops').total, 0)
  assert.equal(loadDay('C:/h/day.json', '2026-11-11', () => JSON.stringify(state)).total, 0, 'stale day is discarded')
})

test('cost-equivalent savings accumulate across ledger generations', () => {
  const gen1 = recordDay(null, [
    { key: 'A', generation: 'ledger-a', startedAt: startedToday, total: 79326, cost: 2614, byModule: { schema: 78416, fold: 910 } },
  ], TODAY)
  assert.equal(gen1.state.total, 79326)
  assert.equal(gen1.state.cost, 2614)

  // A producer restart mints a new ledgerId; its own counters restart at zero.
  const gen2 = recordDay(gen1.state, [
    { key: 'A', generation: 'ledger-b', startedAt: '2026-11-10T10:00:00.000Z', total: 1000, cost: 100, byModule: { schema: 1000 } },
  ], TODAY)
  assert.equal(gen2.state.total, 80326, 'raw tokens still add up')
  assert.equal(gen2.state.cost, 2714, 'cost-equivalent adds up too')
})

test('a ledgerId is authoritative even when the clock says the ledger is older', () => {
  // startedAt says yesterday, but a fresh ledgerId can only be a new generation,
  // so it counts from zero rather than being treated as "growth since first sight".
  const state = recordDay(null, [
    { key: 'A', generation: 'ledger-old', startedAt: '2026-11-09T08:00:00.000Z', total: 5000, cost: 500 },
  ], TODAY)
  assert.equal(state.state.total, 5000)
  assert.equal(state.state.cost, 500)
})

test('a generation recorded before a field existed contributes 0, never NaN', () => {
  // Reproduces the day file that broke the headline: two generations written by
  // the old recordDay have no cost, and `undefined - 0` used to turn the whole
  // day cost into NaN (serialized as null).
  const legacy = {
    v: 1,
    // 该字段缺失的旧文件会被丢弃（口径版本闸门），所以这里标注为「当前口径但缺 cost」，
    // 保留本用例真正要验的「缺字段当 0，不得产生 NaN」。
    accountingVersion: ACCOUNTING_VERSION,
    date: TODAY,
    total: 173804,
    sources: {
      'A\u0000old-1': { startedAt: '2026-11-10T08:00:00.000Z', baselineTotal: 0, lastTotal: 173804, baselineModules: {}, lastModules: { schema: 173804 } },
      'A\u0000old-2': { startedAt: '2026-11-10T09:00:00.000Z', baselineTotal: 0, lastTotal: 238862, baselineModules: {}, lastModules: { schema: 238862 } },
    },
    updatedAt: null,
  }
  const merged = recordDay(legacy, [
    { key: 'A', generation: 'new-1', startedAt: '2026-11-10T10:00:00.000Z', total: 5408, cost: 180, byModule: { schema: 5408 } },
  ], TODAY)
  assert.ok(Number.isFinite(merged.state.cost), 'day cost must stay finite')
  assert.equal(merged.state.cost, 180, 'legacy generations add 0 cost, the new one adds its own')
  assert.equal(merged.state.total, 418074)
})

test('localDayKey is the local calendar day', () => {
  const key = localDayKey(Date.parse('2026-11-10T17:30:00+08:00'))
  assert.equal(key, '2026-11-10')
})

test('the day bill follows the live source fields on every poll', () => {
  // Regression: the sum used to read `lastBillActual`, a field the refresh path
  // never wrote, so the top-level bill stayed 0 forever after the first sight.
  const first = recordDay(
    null,
    [
      {
        key: 'A',
        startedAt: startedToday,
        total: 1000,
        byModule: {},
        billActual: 0.4,
        billCounterfactual: 0.9,
        billRequests: 30,
      },
    ],
    TODAY,
  )
  assert.equal(first.state.billActual, 0.4)
  assert.equal(first.state.billRequests, 30)

  const second = recordDay(
    first.state,
    [
      {
        key: 'A',
        startedAt: startedToday,
        total: 2000,
        byModule: {},
        billActual: 0.58367144,
        billCounterfactual: 1.2351108799999997,
        billRequests: 58,
      },
    ],
    TODAY,
  )
  assert.equal(second.state.billActual, 0.58367144, 'the top-level bill is no longer stuck at 0')
  assert.equal(second.state.billCounterfactual, 1.2351108799999997)
  assert.equal(second.state.billRequests, 58)
  assert.deepEqual(dayBill(second.state), {
    actual: 0.58367144,
    counterfactual: 1.2351108799999997,
    requests: 58,
    saved: 0,
    consumed: 0,
  })
})

test('a source seen before the epoch only contributes its growth', () => {
  // countWhole=false sets baseline to the value at first sight, so a reset day
  // starts from 0 money instead of re-showing the pre-reset ledger.
  const state = {
    ...emptyDay(TODAY),
    sources: {
      A: {
        startedAt: '2026-11-09T09:00:00.000Z',
        lastBillActual: 0,
        lastBillCounterfactual: 0,
        lastBillRequests: 0,
        billActual: 5,
        billCounterfactual: 9,
        billRequests: 100,
        baselineBillActual: 5,
        baselineBillCounterfactual: 9,
        baselineBillRequests: 100,
        lastModules: {},
        baselineModules: {},
      },
    },
  }
  assert.deepEqual(dayBill(state), { actual: 0, counterfactual: 0, requests: 0, saved: 0, consumed: 0 })
  state.sources.A.billActual = 5.25
  state.sources.A.billCounterfactual = 9.5
  state.sources.A.billRequests = 104
  assert.deepEqual(dayBill(state), { actual: 0.25, counterfactual: 0.5, requests: 4, saved: 0, consumed: 0 })
})
