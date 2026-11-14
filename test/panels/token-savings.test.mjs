import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { computeRate, createTokenSavingsSource, formatAge, parseMarkdown, parseSnapshot, readContextTokensFromLog, savingsCandidates, savingsPercent, setBreakdownForTests } from '../../panels/token-savings.js'
// 这些用例验证的是分项明细契约（生产默认隐藏），因此显式打开。
setBreakdownForTests(true)


function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-savings-'))
}

const SNAPSHOT = {
  startedAt: '2026-11-10T07:49:24.753Z',
  updatedAt: new Date().toISOString(),
  totalSavedTokens: 197531,
  byModule: { admission: 0, extraction: 4473, dedup: 0, fold: 160610, schema: 32448 },
  events: 14,
  folds: 1,
  rejectedByAnchor: 4,
  lastEvents: [],
}

const V3 = {
  schemaVersion: 5,
  accountingVersion: 3,
  ledgerId: 'ledger-a',
  revision: 7,
  startedAt: '2026-11-10T09:00:00.000Z',
  updatedAt: new Date().toISOString(),
  tokensBeforeTotal: 260000,
  tokensAfterTotal: 180674,
  totalSavedTokens: 79326,
  byModule: { admission: 0, extraction: 0, dedup: 0, fold: 910, schema: 78416 },
  events: 31,
  folds: 1,
  rejectedByAnchor: 2,
  lastEvents: [],
}

const MARKDOWN = `# Token Savings

- updated: ${SNAPSHOT.updatedAt}
- started: 2026-11-10T07:49:24.753Z
- total saved tokens: **197531**
- events: 14 | folds: 1 | rejected by CacheAnchor: 4

## By module

| module | tokens saved |
|---|---:|
| admission | 0 |
| extraction | 4,473 |
| dedup | 0 |
| fold | 160610 |
| schema | 32448 |
`

test('falls back to the Markdown mirror when the JSON does not parse', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'savings.json'), '{"totalSavedTokens": 19')
  fs.writeFileSync(path.join(dir, 'savings.md'), MARKDOWN)
  const source = createTokenSavingsSource({ files: [path.join(dir, 'savings.json')] })
  const result = source.poll()
  assert.equal(result.panel.status, 'ok')
  assert.equal(result.panel.payload.value, 197531, 'same raw total through the Markdown fallback')
  assert.match(result.panel.payload.note, /markdown/)
})

test('reports 暂无数据 when the snapshot is missing', () => {
  const dir = tempDir()
  const source = createTokenSavingsSource({ files: [path.join(dir, 'nope.json')] })
  const result = source.poll()
  assert.equal(result.panel.status, 'empty')
  assert.match(result.panel.emptyReason, /找不到 savings\.json/)
})

test('reports 暂无数据 when both formats are corrupt', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'savings.json'), 'not json at all')
  fs.writeFileSync(path.join(dir, 'savings.md'), '# nothing useful here')
  const source = createTokenSavingsSource({ files: [path.join(dir, 'savings.json')], failuresBeforeEmpty: 1 })
  const result = source.poll()
  assert.equal(result.panel.status, 'empty')
  assert.match(result.panel.emptyReason, /解析失败/)
})

test('reports 暂无数据 when the data is older than the staleness budget', () => {
  const dir = tempDir()
  const file = path.join(dir, 'savings.json')
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000)
  fs.writeFileSync(file, JSON.stringify({ ...SNAPSHOT, updatedAt: old.toISOString() }))
  fs.utimesSync(file, old, old)
  const source = createTokenSavingsSource({
    files: [file],
    staleAfterMs: 60_000,
    now: () => Date.now(),
    statFile: () => ({ mtimeMs: old.getTime() }),
  })
  const result = source.poll()
  assert.equal(result.panel.status, 'empty')
  assert.match(result.panel.emptyReason, /过期/)
})

test('tolerates one torn read, then says 暂无数据', () => {
  let mode = 'good'
  const source = createTokenSavingsSource({
    files: ['C:/fake/savings.json'],
    failuresBeforeEmpty: 2,
    readFile: () => {
      if (mode === 'good') return JSON.stringify(SNAPSHOT)
      throw new Error('Unexpected end of JSON input')
    },
    statFile: () => ({ mtimeMs: Date.now() }),
  })

  const good = source.poll()
  assert.equal(good.panel.status, 'ok')

  mode = 'torn'
  const firstFailure = source.poll()
  assert.equal(firstFailure.panel, null, 'one torn read keeps the last good panel')
  assert.match(firstFailure.reason, /解析失败/)

  const secondFailure = source.poll()
  assert.equal(secondFailure.panel.status, 'empty')

  mode = 'good'
  const recovered = source.poll()
  assert.equal(recovered.panel.status, 'ok')
})

test('never throws on hostile file contents', () => {
  const hostile = ['', 'null', '[]', '"str"', '{"totalSavedTokens":{}}', '{"byModule":[]}', '\u0000']
  for (const body of hostile) {
    const source = createTokenSavingsSource({
      files: ['C:/fake/x.json'],
      failuresBeforeEmpty: 1,
      readFile: () => body,
      statFile: () => ({ mtimeMs: Date.now() }),
    })
    assert.doesNotThrow(() => source.poll())
    assert.equal(source.poll().panel.status, 'empty', 'body: ' + JSON.stringify(body))
  }
})

test('parseSnapshot rejects documents without a usable total', () => {
  assert.equal(parseSnapshot(null), null)
  assert.equal(parseSnapshot({}), null)
  assert.equal(parseSnapshot({ totalSavedTokens: 'abc' }), null)
  assert.equal(parseSnapshot({ totalSavedTokens: -1 }), null)
  assert.equal(parseSnapshot({ totalSavedTokens: 5 }).total, 5)
  assert.equal(parseSnapshot({ totalSavedTokens: '1,234' }).total, 1234)
})

test('parseMarkdown tolerates table noise and missing sections', () => {
  assert.equal(parseMarkdown('no totals here'), null)
  const parsed = parseMarkdown('total saved tokens: 42\n')
  assert.equal(parsed.total, 42)
  assert.deepEqual(parsed.modules, [])
})

test('formatAge is bounded and never negative', () => {
  assert.equal(formatAge(-5), '刚刚更新')
  assert.equal(formatAge(1000), '刚刚更新')
  assert.equal(formatAge(5 * 60_000), '5 分钟前更新')
  assert.equal(formatAge(3 * 3600_000), '3 小时前更新')
  assert.equal(formatAge(400 * 86400_000), '很久以前更新')
})

test('a UTF-8 BOM in savings.json is tolerated', () => {
  const dir = tempDir()
  const file = path.join(dir, 'savings.json')
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify(SNAPSHOT), 'utf8')
  const source = createTokenSavingsSource({ files: [file] })
  const result = source.poll()
  assert.equal(result.panel.status, 'ok')
  assert.equal(result.panel.payload.value, 197531, 'a BOM must not change the numbers')
})

test('the rate is computed against the context size from the producer log', () => {
  assert.equal(computeRate(2704, 78088), 3.3)
  assert.equal(computeRate(0, 78088), null)
  assert.equal(computeRate(2704, null), null)
  assert.equal(computeRate(2704, 0), null)
})

test('readContextTokensFromLog takes the last value and never throws', () => {
  const dir = tempDir()
  const log = path.join(dir, 'debug.log')
  fs.writeFileSync(
    log,
    [
      '{"event":"routing.decision","contextTokens":75546}',
      '{"event":"memory.planned","contextTokens":76191}',
      '{"event":"routing.decision","contextTokens":78088}',
    ].join('\n'),
  )
  assert.equal(readContextTokensFromLog(log), 78088)
  assert.equal(readContextTokensFromLog(path.join(dir, 'missing.log')), null)
  fs.writeFileSync(log, 'no numbers here')
  assert.equal(readContextTokensFromLog(log), null)
})

test('an unchanged revision is not republished', () => {
  const dir = tempDir()
  const file = path.join(dir, 'savings.json')
  fs.writeFileSync(file, JSON.stringify(V3))
  const source = createTokenSavingsSource({ files: [file] })
  const first = source.poll()
  assert.ok(first.panel)
  const second = source.poll()
  assert.equal(
    second.panel,
    null,
    'same ledgerId + revision: nothing to publish; got ' + JSON.stringify({ unchanged: second.unchanged, debug: second.debug, note: second.panel && second.panel.payload.note }),
  )
  assert.equal(second.unchanged, true)
})

test('a cancelled generation reset: new ledger with the same numbers still publishes', () => {
  const dir = tempDir()
  const file = path.join(dir, 'savings.json')
  fs.writeFileSync(file, JSON.stringify(V3))
  const source = createTokenSavingsSource({ files: [file] })
  assert.ok(source.poll().panel)
  fs.writeFileSync(file, JSON.stringify({ ...V3, ledgerId: 'ledger-c', revision: 1 }))
  const after = source.poll()
  assert.ok(after.panel, 'a new ledgerId must not be treated as an unchanged snapshot')
})

test('savingsPercent rejects unusable denominators', () => {
  assert.equal(savingsPercent(893395, 885283), 0.9)
  assert.equal(savingsPercent(0, 0), null)
  assert.equal(savingsPercent(100, 120), null, 'after > before is not a saving')
  assert.equal(savingsPercent(NaN, 1), null)
})

test('candidate paths prefer DSH_PROFILE_DIR and stay deduplicated', () => {
  const env = { DSH_PROFILE_DIR: 'C:/p', DSH_PROFILE: 'web', DSH_HOME: 'C:/h' }
  const list = savingsCandidates(env, 'C:/p', 'C:/h')
  assert.equal(list[0], path.join('C:/p', 'savings.json'))
  assert.equal(new Set(list).size, list.length)
  const explicit = savingsCandidates({ DSH_SAVINGS_FILE: 'C:/x/s.json' }, 'C:/p', 'C:/h')
  assert.equal(explicit[0], 'C:/x/s.json')
})

// 主数字必须来自 provider usage，而不是 chars/4 的估算。