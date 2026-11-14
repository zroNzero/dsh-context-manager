import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createTokenSavingsSource } from '../../panels/token-savings.js'
import { localDayKey, recordDay, saveDay } from '../../panels/daily.js'

/**
 * The headline is a day number. After a host restart the producer starts a new
 * ledger with small counts, so a payload that reads only `current.realBill`
 * silently drops from millions to thousands — exactly the regression below.
 */
function ledgerDoc(overrides = {}) {
  const now = new Date().toISOString()
  return {
    schemaVersion: 5,
    accountingVersion: 1,
    ledgerId: 'L2',
    revision: 2,
    startedAt: now,
    updatedAt: now,
    totalSavedTokens: 500,
    byModule: { schema: 500 },
    byModuleBefore: { schema: 1000 },
    tokensBeforeTotal: 1000,
    tokensAfterTotal: 500,
    tokensBeforeTotalEstimated: false,
    events: 1,
    byWorkspace: {},
    realBill: {
      requests: 1,
      actualCost: 0.01,
      counterfactualCost: 0.02,
      reduction: 0.5,
      missTokens: 100,
      hitTokens: 100,
      outputTokens: 100,
      removedTokens: 500,
      promptTokens: 500,
      avoidedOutputTokens: 0,
    },
    ...overrides,
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-headline-'))
}

