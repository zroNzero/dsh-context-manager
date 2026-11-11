#!/usr/bin/env node
/**
 * 宿主侧真值：每个 assistant/message 事件里的 provider usage。
 * 用来对账插件 billing.recorded（inputTokens / outputTokens / cacheReadTokens）。
 *
 * 用法：node tools/usage-truth.mjs <session.v4.jsonl.zstd> [最后几条=12]
 */
import { readSessionEvents } from './session-decode.mjs'

const file = process.argv[2]
const limit = Number(process.argv[3] ?? 12)
if (!file) {
  process.stderr.write('usage: node tools/usage-truth.mjs <session.v4.jsonl.zstd> [n]\n')
  process.exit(2)
}

const { events } = readSessionEvents(file)
const rows = []
for (const event of events) {
  if (event?.type !== 'assistant/message') continue
  const usage = event?.data?.usage
  if (!usage) continue
  rows.push({
    time: new Date(Number(event.time)).toISOString().slice(11, 19),
    turn: event?.data?.turn,
    step: event?.data?.step,
    input: Number(usage.inputTokens ?? 0),
    output: Number(usage.outputTokens ?? 0),
    cacheRead: Number(usage.cacheReadTokens ?? 0),
    cacheWrite: Number(usage.cacheWriteTokens ?? 0),
  })
}

process.stdout.write('time     turn step  input  output  cacheRead  cacheWrite\n')
for (const row of rows.slice(-limit)) {
  process.stdout.write(
    `${row.time} ${String(row.turn).padStart(4)} ${String(row.step).padStart(4)} ` +
      `${String(row.input).padStart(6)} ${String(row.output).padStart(7)} ` +
      `${String(row.cacheRead).padStart(10)} ${String(row.cacheWrite).padStart(10)}\n`,
  )
}
