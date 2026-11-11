#!/usr/bin/env node
/**
 * 复现插件的压缩结果，并拆开「真正发出去的内容」由什么构成。
 * 这是判断「还剩下多少可压」的唯一可靠依据。
 *
 * 用法：node tools/sent-composition.mjs <session.v4.jsonl.zstd> [retain=6] [minChars=600]
 */
import { readSessionEvents } from './session-decode.mjs'

const [file, retainArg, minArg] = process.argv.slice(2)
const retain = Number(retainArg ?? 6)
const minChars = Number(minArg ?? 600)
if (!file) {
  process.stderr.write('usage: node tools/sent-composition.mjs <session.v4.jsonl.zstd> [retain] [minChars]\n')
  process.exit(2)
}

const { events } = readSessionEvents(file)
const CONVERSATION = new Set(['user/message', 'assistant/message', 'tool/result', 'system/message', 'developer/message'])
const rows = []
for (const event of events) {
  const type = String(event?.type ?? '')
  if (!CONVERSATION.has(type)) continue
  const payload = event?.data?.message ?? event?.data?.result ?? event?.data?.content ?? event?.data ?? ''
  rows.push({ type, payload })
}

const RECEIPT = 420
const cutoff = rows.length - retain
const bucket = { 'old tool receipts': 0, 'old tool kept (small)': 0, 'old reasoning (dropped)': 0, 'old assistant text': 0, 'old assistant tool-call args': 0, 'old user/system': 0, 'recent window (verbatim)': 0 }

rows.forEach((row, index) => {
  const isRecent = index >= cutoff
  const raw = JSON.stringify(row.payload)
  if (isRecent) {
    bucket['recent window (verbatim)'] += raw.length
    return
  }
  if (row.type === 'tool/result') {
    const text = typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload)
    if (text.length > minChars) bucket['old tool receipts'] += RECEIPT
    else bucket['old tool kept (small)'] += raw.length
    return
  }
  if (row.type === 'assistant/message') {
    const content = row.payload?.content
    if (!Array.isArray(content)) {
      bucket['old assistant text'] += raw.length
      return
    }
    for (const block of content) {
      if (block?.type === 'reasoning' || block?.type === 'thinking') {
        bucket['old reasoning (dropped)'] += String(block?.text ?? '').length
      } else if (block?.type === 'tool-call') bucket['old assistant tool-call args'] += JSON.stringify(block?.arguments ?? '').length
      else bucket['old assistant text'] += JSON.stringify(block?.text ?? '').length
    }
    return
  }
  bucket['old user/system'] += raw.length
})

const sent = Object.entries(bucket)
  .filter(([key]) => key !== 'old reasoning (dropped)')
  .reduce((sum, [, value]) => sum + value, 0)
process.stdout.write(`sent total ≈ ${sent} chars\n\n| part | chars | share of sent |\n|---|---:|---:|\n`)
for (const [key, value] of Object.entries(bucket).sort((a, b) => b[1] - a[1])) {
  const note = key === 'old reasoning (dropped)' ? ' (already saved)' : ''
  process.stdout.write(`| ${key}${note} | ${value} | ${((value / Math.max(1, sent)) * 100).toFixed(1)}% |\n`)
}
