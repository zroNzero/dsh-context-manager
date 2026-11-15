/* 复现 costkiller_status 的返回体，检查是否有 null/undefined 落在 number 字段上。 */
import fs from 'node:fs'
import { SavingsLedger } from './dist/modules/savings-ledger.js'
import { BillingLedger } from './dist/modules/billing.js'

const ledger = new SavingsLedger()
const doc = JSON.parse(fs.readFileSync('C:/Users/zro_0/.dsh/profiles/desktop/savings.json', 'utf8'))
const restored = ledger.restore(doc)
const snapshot = ledger.snapshot()
const real = new BillingLedger().snapshot()

const payload = {
  ok: true,
  admitted: 0,
  extracted: 0,
  folds: 0,
  savedTokens: snapshot.totalSavedTokens,
  rejectedByAnchor: 0,
  deduped: 0,
  savedByAdmission: snapshot.byModule.admission,
  savedByExtraction: snapshot.byModule.extraction,
  savedByDedup: snapshot.byModule.dedup,
  savedByFold: snapshot.byModule.fold,
  savedBySchema: snapshot.byModule.schema,
  perRequestSavings: snapshot.perRequestSavings,
  eventSavings: snapshot.eventSavings,
  contextReduction: snapshot.contextReduction,
  estimatedCostTokens: snapshot.estimatedCostTokens,
  tokensBeforeTotal: snapshot.tokensBeforeTotal,
  tokensAfterTotal: snapshot.tokensAfterTotal,
  workspaceCount: Object.keys(snapshot.byWorkspace).length,
  schemaVersion: snapshot.schemaVersion,
  ledgerId: snapshot.ledgerId,
  revision: snapshot.revision,
  realBilling: {
    requests: real.requests,
    currency: real.currency,
    actualCost: Number(real.actualCost.toFixed(6)),
    counterfactualCost: Number(real.counterfactualCost.toFixed(6)),
    savedCost: Number(real.savedCost.toFixed(6)),
    reduction: Number((real.reduction * 100).toFixed(2)),
    cacheHitRate: Number((real.cacheHitRate * 100).toFixed(2)),
    missTokens: real.missTokens,
    hitTokens: real.hitTokens,
    outputTokens: real.outputTokens,
    unverifiedOutputTokens: real.unverifiedOutputTokens,
    lastPricing: {
      tier: String(real.lastPricing?.tier ?? 'unknown'),
      window: String(real.lastPricing?.window ?? 'offpeak'),
      hit: Number(real.lastPricing?.hit ?? 0),
      miss: Number(real.lastPricing?.miss ?? 0),
      output: Number(real.lastPricing?.output ?? 0),
    },
  },
  realBillFile: 'x.md',
  debugLogFile: 'debug.log',
  savingsFile: 'y.md',
}

console.log('ledger restored:', restored)
const bad = []
const walk = (obj, path) => {
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k
    if (typeof v === 'number' && !Number.isFinite(v)) bad.push(`${p} = ${v}`)
    else if (v === null || v === undefined) bad.push(`${p} = ${v}`)
    else if (typeof v === 'object') walk(v, p)
  }
}
walk(payload, '')
console.log('non-finite / null fields:', bad.length === 0 ? 'none' : bad)
console.log('json roundtrip keys:', Object.keys(JSON.parse(JSON.stringify(payload))).length)
console.log('cacheHitRate:', real.cacheHitRate, '| reduction:', real.reduction)
