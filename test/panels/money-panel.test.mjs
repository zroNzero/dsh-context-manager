import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { emptyDay, localDayKey, saveDay } from '../../panels/daily.js'
import { createTokenSavingsSource } from '../../panels/token-savings.js'

// 这里不打开分项明细（setBreakdownForTests），用例验证的就是生产默认的两行卡片。

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-money-'))
}

const BILL = {
  requests: 58,
  actualCost: 0.58367144,
  counterfactualCost: 1.2351108799999997,
  reduction: 0.5274,
  missTokens: 123456,
  hitTokens: 12345678,
  outputTokens: 12345,
  removedTokens: 10000,
  promptTokens: 400000,
  avoidedOutputTokens: 6000,
}

function writeSavings(dir, overrides = {}) {
  const file = path.join(dir, 'savings.json')
  const doc = {
    schemaVersion: 4,
    ledgerId: 'ledger-money',
    revision: 3,
    totalSavedTokens: 16000,
    byModule: { schema: 16000 },
    tokensBeforeTotal: 900000,
    tokensAfterTotal: 884000,
    realBill: { ...BILL },
    ...overrides,
  }
  fs.writeFileSync(file, JSON.stringify(doc))
  return file
}




