#!/usr/bin/env node
/**
 * 复现插件当前的压缩管线（旧工具结果落盘 + 旧参数落盘 + 丢老 thinking），
 * 逐项拆开「真正发出去的内容」，并预测相对变化。
 *
 * 用法：node tools/sent-composition.mjs <session.v4.jsonl.zstd> [budget=772849] [retain=6]
 */
import { readSessionEvents } from './session-decode.mjs'

const [file, budgetArg, retainArg] = process.argv.slice(2)
const budget = Number(budgetArg ?? 772849)
const retain = Number(retainArg ?? 6)
const MIN_CHARS = 600
const MIN_ARG = 320
if (!file) {
  process.stderr.write('usage: node tools/sent-composition.mjs <session.v4.jsonl.zstd> [budget] [retain]\n')
  process.exit(2)
}

const { events } = readSessionEvents(file)
const CONVERSATION = new Set(['user/message', 'assistant/message', 'tool/result', 'system/message', 'developer/message'])
const all = []
for (const event of events) {
  const type = String(event?.type ?? '')
  if (!CONVERSATION.has(type)) continue
  const payload = event?.data?.message ?? event?.data?.result ?? event?.data?.content ?? event?.data ?? ''
  all.push({ type, payload })
}

const window = []
let raw = 0
for (let index = all.length - 1; index >= 0; index -= 1) {
  const chars = JSON.stringify(all[index].payload).length
  if (raw + chars > budget) break
  raw += chars
  window.push(all[index])
}
window.reverse()

// 收据现在是「短哈希 + 裸文件名」，目录由 system prompt 说明。
const resultReceipt = (chars) => `[SPILL] ${chars}c prefix-a1b2c3d4e5f6.txt\n`.length + 100
const argReceipt = (chars) => JSON.stringify({ _spill: 'args-a1b2c3d4e5f6.json', _chars: chars, _head: 'x'.repeat(120) }).length

const cutoff = window.length - retain
const sent = {
  'assistant tool-call args (folded)': 0,
  'assistant tool-call args (kept)': 0,
  'assistant text': 0,
  'tool results (folded)': 0,
  'tool results (kept)': 0,
  'user/system': 0,
  'recent (verbatim)': 0,
}
let saved = 0

window.forEach((row, index) => {
  if (index >= cutoff) {
    sent['recent (verbatim)'] += JSON.stringify(row.payload).length
    return
  }
  if (row.type === 'tool/result') {
    const text = typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload)
    if (text.length > MIN_CHARS) {
      const receipt = resultReceipt(text.length)
      sent['tool results (folded)'] += receipt
      saved += text.length - receipt
    } else sent['tool results (kept)'] += JSON.stringify(row.payload).length
    return
  }
  if (row.type === 'assistant/message') {
    const content = row.payload?.content
    if (!Array.isArray(content)) {
      sent['assistant text'] += JSON.stringify(row.payload).length
      return
    }
    for (const block of content) {
      if (block?.type === 'reasoning' || block?.type === 'thinking') {
        saved += String(block?.text ?? '').length
      } else if (block?.type === 'tool-call') {
        const args = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? '')
        if (args.length > MIN_ARG) {
          const receipt = argReceipt(args.length)
          sent['assistant tool-call args (folded)'] += receipt
          saved += args.length - receipt
        } else sent['assistant tool-call args (kept)'] += args.length
      } else sent['assistant text'] += JSON.stringify(block?.text ?? '').length
    }
    return
  }
  sent['user/system'] += JSON.stringify(row.payload).length
})

const sentTotal = Object.values(sent).reduce((a, b) => a + b, 0)
process.stdout.write(`raw window=${raw} chars -> sent~${sentTotal} chars (-${((1 - sentTotal / raw) * 100).toFixed(1)}%)\n\n`)
process.stdout.write('| part | chars | share of sent |\n|---|---:|---:|\n')
for (const [key, value] of Object.entries(sent).sort((a, b) => b[1] - a[1])) {
  process.stdout.write(`| ${key} | ${value} | ${((value / Math.max(1, sentTotal)) * 100).toFixed(1)}% |\n`)
}
process.stdout.write(`\nsaved total=${saved} chars\n`)
