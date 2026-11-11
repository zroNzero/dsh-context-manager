#!/usr/bin/env node
/**
 * 测两件事：
 *   1) 工具结果里有多少是**完全相同**的重复（换收据都不用，直接指向上一条即可）；
 *   2) 单条结果内部有多少**重复行**（日志类输出，折叠成 ⟨×N⟩ 完全无损）。
 * 这两类都是零信息损失的，且不像落盘收据那样有「每次多一次 read」的摩擦成本。
 *
 * 用法：node tools/dup-scan.mjs <session.v4.jsonl.zstd> [window=700000]
 */
import { readSessionEvents } from './session-decode.mjs'

const [file, windowArg] = process.argv.slice(2)
const budget = Number(windowArg ?? 700000)
if (!file) {
  process.stderr.write('usage: node tools/dup-scan.mjs <session.v4.jsonl.zstd> [window]\n')
  process.exit(2)
}

const { events } = readSessionEvents(file)
const rows = []
for (const event of events) {
  if (event?.type !== 'tool/result') continue
  const payload = event?.data?.result ?? event?.data?.message ?? event?.data?.content ?? ''
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  rows.push(text)
}

// 最近的那一段（按字符预算）
const kept = []
let sum = 0
for (let index = rows.length - 1; index >= 0; index -= 1) {
  if (sum + rows[index].length > budget) break
  sum += rows[index].length
  kept.push(rows[index])
}

const seen = new Map()
let dupChars = 0
let dupCount = 0
for (const text of kept) {
  const count = seen.get(text) ?? 0
  if (count > 0) {
    dupChars += text.length
    dupCount += 1
  }
  seen.set(text, count + 1)
}

let lineDupChars = 0
for (const text of new Set(kept)) {
  const lines = text.split('\n')
  if (lines.length < 8) continue
  const unique = new Set(lines).size
  lineDupChars += text.length - Math.round((text.length * unique) / lines.length)
}

console.log(`tool results in window : ${kept.length} (${sum} chars)`)
console.log(`exact duplicates       : ${dupCount} results, ${dupChars} chars (${((dupChars / Math.max(1, sum)) * 100).toFixed(1)}%)`)
console.log(`repeated lines inside  : ${lineDupChars} chars (${((lineDupChars / Math.max(1, sum)) * 100).toFixed(1)}%)`)
