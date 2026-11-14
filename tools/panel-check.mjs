/**
 * 面板口径自检：拿真实落盘的 savings.json 跑一遍 buildPanelSummary，
 * 把「工作区 / token / 钱」逐行打出来，方便和 debug.log 的实测账单对账。
 *
 * 用法：node tools/panel-check.mjs [savings.json]
 */
import fs from 'node:fs'
import path from 'node:path'
import { buildPanelSummary, PANEL_ROUTE, PANEL_SCHEMA_VERSION } from '../dist/panel.js'

const file = process.argv[2] ?? path.join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop', 'savings.json')
const doc = JSON.parse(fs.readFileSync(file, 'utf8'))

const summary = buildPanelSummary({ snapshot: doc, bill: doc.money ?? null })

const cny = (n) => '¥' + Number(n).toFixed(4)
const num = (n) => Number(n).toLocaleString('en-US')

console.log(`route   ${PANEL_ROUTE}  schema v${PANEL_SCHEMA_VERSION}`)
console.log(`since   ${summary.since}`)
console.log(`totals  ${num(summary.totals.savedTokens)} tokens (hit ${num(summary.totals.savedHitTokens)} / miss ${num(summary.totals.savedMissTokens)})  ${cny(summary.totals.savedMoney)}  ${summary.totals.turns} turns`)
console.log('')
console.log('workspace'.padEnd(28) + 'tokens'.padStart(14) + 'hit'.padStart(14) + 'miss'.padStart(11) + 'money'.padStart(11) + 'turns'.padStart(7))
for (const w of summary.workspaces) {
  console.log(
    String(w.label).padEnd(28) +
      num(w.savedTokens).padStart(14) +
      num(w.savedHitTokens).padStart(14) +
      num(w.savedMissTokens).padStart(11) +
      cny(w.savedMoney).padStart(11) +
      String(w.turns).padStart(7),
  )
}

// 严格公式复核：钱只能由 token×单价得出，不允许出现别的来源。
const price = { hit: doc.money?.basis?.hit ?? null, miss: doc.money?.basis?.miss ?? null }
const priceOut = doc.money?.basis?.out ?? 4
if (price.hit !== null && price.miss !== null) {
  const t = summary.totals
  const tracked = (t.savedHitTokens * price.hit + t.savedMissTokens * price.miss + t.savedOutTokens * priceOut) / 1e6
  const residual = t.savedMoney - tracked
  console.log('')
  console.log(
    `formula  (hit×${price.hit} + miss×${price.miss} + out×${priceOut})/1M = ${cny(tracked)}   panel=${cny(t.savedMoney)}   Δ=${residual.toFixed(8)}`,
  )
  console.log(`output   savedOutTokens=${t.savedOutTokens}（历史轮次未单独记账 → 残差 ${cny(residual)}）`)
  console.log(`actual   ${cny(t.actualMoney)}   省下占比 ${(t.savedShare * 100).toFixed(2)}%   实花+省下=${cny(t.savedMoney + t.actualMoney)}`)
  const okResidual = residual >= -1e-6 && residual <= Math.max(0, t.savedTokens * priceOut) / 1e6 + 1e-6
  if (okResidual) console.log('PASS: 金额只由 token×官方单价三项构成（残差在上限内）')
  else {
    console.log('FAIL: 面板金额无法由 token×官方单价解释')
    process.exitCode = 1
  }
} else {
  console.log('NO PRICE BASIS: savings.json 里没有 money.basis，无法复核')
  process.exitCode = 1
}
