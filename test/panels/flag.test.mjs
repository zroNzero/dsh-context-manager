import assert from 'node:assert/strict'
import { test } from 'node:test'

import { FLAG_ENV, FLAG_FILE, resolvePanelsFlag } from '../../panels/flag.js'

function reader(files) {
  return (p) => {
    const key = p.replace(/\\/g, '/').split('/').pop()
    if (Object.hasOwn(files, key)) return files[key]
    const err = new Error('ENOENT')
    err.code = 'ENOENT'
    throw err
  }
}

test('defaults to disabled', () => {
  const flag = resolvePanelsFlag({ env: {}, home: 'C:/h', readFile: reader({}) })
  assert.equal(flag.enabled, false)
  assert.equal(flag.source, 'default')
})

test('environment variable wins over the flag file and config', () => {
  const flag = resolvePanelsFlag({
    env: { [FLAG_ENV]: '1' },
    home: 'C:/h',
    readFile: reader({ [FLAG_FILE]: JSON.stringify({ enabled: false }) }),
    config: { panels: { enabled: false } },
  })
  assert.equal(flag.enabled, true)
  assert.equal(flag.source, 'env')
})

test('a false environment value disables even when the file enables', () => {
  const flag = resolvePanelsFlag({
    env: { [FLAG_ENV]: 'off' },
    home: 'C:/h',
    readFile: reader({ [FLAG_FILE]: JSON.stringify({ enabled: true }) }),
  })
  assert.equal(flag.enabled, false)
  assert.equal(flag.source, 'env')
})

test('the flag file enables the panels', () => {
  const flag = resolvePanelsFlag({ env: {}, home: 'C:/h', readFile: reader({ [FLAG_FILE]: JSON.stringify({ enabled: true }) }) })
  assert.equal(flag.enabled, true)
  assert.equal(flag.source, 'file')
})

test('the flag file also accepts {"panels": true}', () => {
  const flag = resolvePanelsFlag({ env: {}, home: 'C:/h', readFile: reader({ [FLAG_FILE]: JSON.stringify({ panels: true }) }) })
  assert.equal(flag.enabled, true)
})

test('a flag file written by PowerShell 5.1 (UTF-8 BOM) still works', () => {
  const flag = resolvePanelsFlag({
    env: {},
    home: 'C:/h',
    readFile: reader({ [FLAG_FILE]: '\uFEFF' + JSON.stringify({ enabled: true }) }),
  })
  assert.equal(flag.enabled, true)
  assert.equal(flag.source, 'file')
})

test('a malformed flag file falls through to config', () => {
  const flag = resolvePanelsFlag({
    env: {},
    home: 'C:/h',
    readFile: reader({ [FLAG_FILE]: '{oops' }),
    config: { panels: { enabled: true } },
  })
  assert.equal(flag.enabled, true)
  assert.equal(flag.source, 'config')
})

test('config is the last real source', () => {
  const flag = resolvePanelsFlag({ env: {}, home: 'C:/h', readFile: reader({}), config: { panels: { enabled: true } } })
  assert.equal(flag.enabled, true)
  assert.equal(flag.source, 'config')
})

function missing(p) {
  const err = new Error('ENOENT: ' + p)
  err.code = 'ENOENT'
  throw err
}

test('a package-root flag file enables a checkout without touching the profile', () => {
  const flag = resolvePanelsFlag({
    env: {},
    home: 'C:/h',
    packageRoot: 'D:/code/dsh-context-manager',
    readFile: (p) => (p.includes('dsh-context-manager') ? JSON.stringify({ enabled: true }) : missing(p)),
  })
  assert.equal(flag.enabled, true)
  assert.equal(flag.source, 'package')
})

test('the $DSH_HOME flag file wins over the package-root one', () => {
  const flag = resolvePanelsFlag({
    env: {},
    home: 'C:/h',
    packageRoot: 'D:/code/pkg',
    readFile: (p) => (p.includes('pkg') ? JSON.stringify({ enabled: true }) : JSON.stringify({ enabled: false })),
  })
  assert.equal(flag.enabled, false)
  assert.equal(flag.source, 'file')
})

test('the env var still beats both flag files', () => {
  const flag = resolvePanelsFlag({
    env: { [FLAG_ENV]: '0' },
    home: 'C:/h',
    packageRoot: 'D:/code/pkg',
    readFile: () => JSON.stringify({ enabled: true }),
  })
  assert.equal(flag.enabled, false)
  assert.equal(flag.source, 'env')
})

test('a package with no flag file still defaults to disabled', () => {
  const flag = resolvePanelsFlag({ env: {}, home: 'C:/h', packageRoot: 'D:/code/pkg', readFile: reader({}) })
  assert.equal(flag.enabled, false)
  assert.equal(flag.source, 'default')
})

test('garbage values never enable the feature', () => {
  for (const value of ['maybe', '', '2', null, undefined]) {
    const flag = resolvePanelsFlag({ env: value === null || value === undefined ? {} : { [FLAG_ENV]: value }, home: 'C:/h', readFile: reader({}) })
    assert.equal(flag.enabled, false, 'value ' + JSON.stringify(value))
  }
})
