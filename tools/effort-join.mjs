#!/usr/bin/env node
/**
 * 把 `effort.decided` 与 `billing.recorded` 按时间离线对齐，算出「输出侧杠杆」
 * 在真实账单里到底占多少。
 *
 * 为什么需要离线做：build c206c86 的账本里 effort 字段因为 5 秒 TTL 被记成 null
 * （一次请求从决策到 usage 常常超过 5 秒），所以 savedCost 里的输出侧部分是 0。
 * 这个脚本用日志里独立存在的 effort.decided 还原当时真正生效的 effort。
 *
 * 用法：node tools/effort-join.mjs <debug.log> [--since ISO]
 */
import fs from 'node:fs'

const FACTOR = { max: 1, high: 0.566, low: 0.587, off: 0.158 }
const RANK = { off: 0, low: 1, high: 2, max: 3 }

const file = process.argv[2]
if (!file) {
  process.stderr.write('usage: node tools/effort-join.mjs <debug.log> [--since ISO]\n')
  process.exit(2)
}
const sinceArg = process.argv.indexOf('--since')
const since = sinceArg > 0 ? Date.parse(process.argv[sinceArg + 1]) : 0

const rows = []
for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
  const text = line.trim()
  if (!text.startsWith('{')) continue
  let event
  try {
    event = JSON.parse(text)
  } catch {
    continue
  }
  if (event.event !== 'effort.decided' && event.event !== 'billing.recorded') continue
  const at = Date.parse(event.ts ?? '')
  if (!Number.isFinite(at) || at < since) continue
  rows.push({ at, event })
}
rows.sort((a, b) => a.at - b.at)

/** 每个 purpose+model 的「当前生效 effort」；decided 事件之后的第一条账单吃这个值。 */
let inForce = { effort: 'max', baseline: 'max' }
const records = []
for (const { at, event } of rows) {
  if (event.event === 'effort.decided') {
    inForce = { effort: String(event.to ?? 'max'), baseline: String(event.baseline ?? 'max') }
    continue
  }
  if (event.event !== 'billing.recorded') continue
  records.push({ at, ...event, effortUsed: inForce.effort, baselineUsed: inForce.baseline })
}

const price = (record) => {
  const hit = 0.02
  const miss = 1
  const out = 4
  const actual = (record.missTokens * miss + record.hitTokens * hit + record.outputTokens * out) / 1e6
  const effort = FACTOR[record.effortUsed] ?? 1
  const avoided = Math.max(0, Math.round(record.outputTokens * (1 / effort - 1)))
  const lower = RANK[record.effortUsed] < RANK[record.baselineUsed]
  const counter = (record.missTokens * miss + record.hitTokens * hit + (record.outputTokens + (lower ? avoided : 0)) * out) / 1e6
  return { actual, counter, avoided: lower ? avoided : 0, lowered: lower }
}

let actual = 0
let counter = 0
let outTokens = 0
let avoided = 0
let loweredCalls = 0
const byEffort = new Map()
for (const record of records) {
  const p = price(record)
  actual += p.actual
  counter += p.counter
  outTokens += record.outputTokens
  avoided += p.avoided
  if (p.lowered) loweredCalls += 1
  const key = `${record.effortUsed} (base ${record.baselineUsed})`
  const slot = byEffort.get(key) ?? { calls: 0, out: 0, avoided: 0, cost: 0 }
  slot.calls += 1
  slot.out += record.outputTokens
  slot.avoided += p.avoided
  slot.cost += p.actual
  byEffort.set(key, slot)
}

const pad = (value, width) => String(value).padStart(width)
process.stdout.write(`requests: ${records.length}   lowered: ${loweredCalls}\n`)
process.stdout.write(`output tokens: ${outTokens}   avoided at max: ${avoided}   output saving: ${((avoided / Math.max(1, outTokens + avoided)) * 100).toFixed(1)}%\n`)
process.stdout.write(`actual: ¥${actual.toFixed(6)}   counterfactual(max everywhere): ¥${counter.toFixed(6)}   reduction: ${(((counter - actual) / Math.max(1e-12, counter)) * 100).toFixed(2)}%\n\n`)
process.stdout.write('| effort (baseline) | calls | out tokens | avoided | cost |\n|---|---:|---:|---:|---:|\n')
for (const [key, slot] of [...byEffort.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
  process.stdout.write(`| ${key} | ${pad(slot.calls, 3)} | ${pad(slot.out, 7)} | ${pad(slot.avoided, 7)} | ¥${slot.cost.toFixed(5)} |\n`)
}
