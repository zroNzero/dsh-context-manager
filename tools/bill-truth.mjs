#!/usr/bin/env node
/**
 * 从宿主会话日志直接按官方单价重算账单，和插件 billing.recorded 对账。
 * 这是「插件记账是否可信」的唯一裁决方式：宿主日志里是 provider 原始 usage。
 *
 * 用法：node tools/bill-truth.mjs <session.v4.jsonl.zstd> [--since ISO]
 */
import { readSessionEvents } from './session-decode.mjs'

const file = process.argv[2]
const sinceArg = process.argv.indexOf('--since')
const since = sinceArg > 0 ? Date.parse(process.argv[sinceArg + 1]) : 0
if (!file) {
  process.stderr.write('usage: node tools/bill-truth.mjs <session.v4.jsonl.zstd> [--since ISO]\n')
  process.exit(2)
}

const { events } = readSessionEvents(file)
let miss = 0
let hit = 0
let out = 0
let calls = 0
let first = null
for (const event of events) {
  if (event?.type !== 'assistant/message') continue
  const usage = event?.data?.usage
  if (!usage) continue
  const at = Number(event.time)
  if (at < since) continue
  calls += 1
  if (!first) first = new Date(at).toISOString()
  miss += Number(usage.inputTokens ?? 0)
  hit += Number(usage.cacheReadTokens ?? 0)
  out += Number(usage.outputTokens ?? 0)
}

const HIT = 0.02
const MISS = 1
const OUT = 4
const cost = (miss * MISS + hit * HIT + out * OUT) / 1e6
process.stdout.write(`calls=${calls} from=${first ?? '-'}\n`)
process.stdout.write(`miss=${miss} hit=${hit} out=${out}  hitRate=${((hit / Math.max(1, hit + miss)) * 100).toFixed(1)}%\n`)
process.stdout.write(`bill=¥${cost.toFixed(6)}\n`)
