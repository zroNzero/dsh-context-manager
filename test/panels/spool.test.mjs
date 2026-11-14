import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createSpoolSource, SPOOL_DIR } from '../../panels/spool.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-spool-'))
}

function harness(dir) {
  const published = []
  const cleared = []
  const logs = []
  const source = createSpoolSource({
    dir,
    publish: (producer, panel) => {
      published.push({ producer, panel })
      return { ok: true }
    },
    clear: (producer) => {
      cleared.push(producer)
      return 1
    },
    log: (level, message) => logs.push({ level, message }),
  })
  return { source, published, cleared, logs }
}

test('the spool directory name is stable', () => {
  assert.equal(SPOOL_DIR, '.dsh-savings-panels')
})

test('a dropped file publishes a panel named after the file', () => {
  const dir = tempDir()
  const h = harness(dir)
  fs.writeFileSync(path.join(dir, 'my-plugin.json'), JSON.stringify({ v: 1, id: 'uptime', kind: 'badge', title: 'Uptime', payload: { text: 'ok' } }))
  const result = h.source.poll()
  assert.equal(result.changed, 1)
  assert.equal(h.published.length, 1)
  assert.equal(h.published[0].producer, 'my-plugin')
  assert.equal(h.published[0].panel.id, 'uptime')
})

test('a {panel: ...} wrapper is accepted', () => {
  const dir = tempDir()
  const h = harness(dir)
  fs.writeFileSync(path.join(dir, 'wrap.json'), JSON.stringify({ panel: { v: 1, id: 'x', kind: 'metric', title: 'X', payload: { value: 3 } } }))
  h.source.poll()
  assert.equal(h.published.length, 1)
  assert.equal(h.published[0].panel.payload.value, 3)
})

test('unchanged files are not re-read or re-published', () => {
  const dir = tempDir()
  const h = harness(dir)
  const file = path.join(dir, 'steady.json')
  fs.writeFileSync(file, JSON.stringify({ v: 1, id: 'a', kind: 'metric', title: 'A', payload: { value: 1 } }))
  h.source.poll()
  h.source.poll()
  h.source.poll()
  assert.equal(h.published.length, 1)
})

test('deleting the file removes that producer', () => {
  const dir = tempDir()
  const h = harness(dir)
  const file = path.join(dir, 'gone.json')
  fs.writeFileSync(file, JSON.stringify({ v: 1, id: 'a', kind: 'metric', title: 'A', payload: { value: 1 } }))
  h.source.poll()
  fs.unlinkSync(file)
  h.source.poll()
  assert.deepEqual(h.cleared, ['gone'])
})

test('a corrupt file is reported once per change and keeps the last good panel', () => {
  const dir = tempDir()
  const h = harness(dir)
  const file = path.join(dir, 'broken.json')
  fs.writeFileSync(file, '{ not json')
  h.source.poll()
  h.source.poll()
  assert.equal(h.published.length, 0)
  assert.equal(h.logs.filter((l) => l.message.includes('not valid JSON')).length, 1)
  fs.writeFileSync(file, JSON.stringify({ v: 1, id: 'b', kind: 'metric', title: 'B', payload: { value: 2 } }))
  h.source.poll()
  assert.equal(h.published.length, 1)
})

test('a rejected panel is reported and does not crash the poll', () => {
  const dir = tempDir()
  const logs = []
  const source = createSpoolSource({
    dir,
    publish: () => ({ ok: false, code: 'SCHEMA', error: 'nope' }),
    clear: () => 0,
    log: (level, message) => logs.push({ level, message }),
  })
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ v: 1 }))
  assert.doesNotThrow(() => source.poll())
  assert.equal(logs.filter((l) => l.message.includes('rejected')).length, 1)
})

test('illegal file names are ignored', () => {
  const dir = tempDir()
  const h = harness(dir)
  fs.writeFileSync(path.join(dir, 'has space.json'), JSON.stringify({ v: 1 }))
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello')
  h.source.poll()
  assert.equal(h.published.length, 0)
})

test('a UTF-8 BOM from Windows tooling does not break the file', () => {
  const dir = tempDir()
  const h = harness(dir)
  fs.writeFileSync(
    path.join(dir, 'bom.json'),
    '\uFEFF' + JSON.stringify({ v: 1, id: 'b', kind: 'metric', title: 'BOM', payload: { value: 1 } }),
    'utf8',
  )
  h.source.poll()
  assert.equal(h.published.length, 1)
  assert.equal(h.published[0].panel.title, 'BOM')
})

test('an unchanged file is re-published when its panel is no longer present', () => {
  const dir = tempDir()
  let present = true
  const published = []
  const source = createSpoolSource({
    dir,
    publish: (producer, panel) => {
      published.push({ producer, panel })
      return { ok: true }
    },
    clear: () => 0,
    present: () => present,
  })
  fs.writeFileSync(path.join(dir, 'steady.json'), JSON.stringify({ v: 1, id: 'a', kind: 'metric', title: 'A', payload: { value: 1 } }))
  source.poll()
  source.poll()
  assert.equal(published.length, 1, 'unchanged and present: no re-publish')
  present = false // the host expired or evicted it
  source.poll()
  assert.equal(published.length, 2, 'missing from the store: publish again')
})

test('a missing directory is not an error', () => {
  const h = harness(path.join(tempDir(), 'does-not-exist'))
  assert.doesNotThrow(() => h.source.poll())
  assert.equal(h.source.stats().producers, 0)
})
