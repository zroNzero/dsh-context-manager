#!/usr/bin/env node
/**
 * 离线回放器：用真实会话重建 request.messages，在**本机**验证任何「改消息表」的优化。
 *
 * 红线第 6 条：能本机复现才允许上线。线上验证的代价是一次断轮 + 一次重启（≈¥0.09 缓存）。
 *
 * 用法：node tools/replay-verify.mjs <session.v4.jsonl.zstd> [minArg=600]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readSessionEvents } from './session-decode.mjs'
import { evictOldEpisodes, assertToolPairing } from '../dist/modules/episode-evict.js'

const [file, minArgRaw] = process.argv.slice(2)
const minArg = Number(minArgRaw ?? 600)
if (!file) {
  process.stderr.write('usage: node tools/replay-verify.mjs <session.v4.jsonl.zstd> [minArg]\n')
  process.exit(2)
}

const { events } = readSessionEvents(file)

/** 按 DSH 给插件的样子重建：assistant/message -> assistant，tool/result -> tool(toolCallId)。 */
const messages = []
for (const event of events) {
  const type = String(event?.type ?? '')
  if (type === 'user/message' || type === 'system/message' || type === 'developer/message') {
    messages.push({ role: type.replace('/message', ''), content: event?.data?.message?.content })
    continue
  }
  if (type === 'assistant/message') {
    messages.push({ role: 'assistant', content: event?.data?.message?.content })
    continue
  }
  if (type === 'tool/result') {
    const message = event?.data?.message ?? {}
    messages.push({ role: 'tool', toolCallId: message.toolCallId, content: message.content })
  }
}

/**
 * 会话日志是「进行中」的快照：最后一条 assistant 可能已经发出 tool-call 但结果还没落盘。
 * 那不是配对错误，是采样时机。回放时必须先把这个未完成的尾巴剪掉，
 * 否则会把「正常的进行中状态」误判成违规。
 */
{
  let end = messages.length
  while (end > 0) {
    const last = messages[end - 1]
    const hasCalls =
      last?.role === 'assistant' &&
      Array.isArray(last.content) &&
      last.content.some((block) => String(block?.type) === 'tool-call')
    if (!hasCalls) break
    end -= 1
  }
  if (end < messages.length) {
    console.log(`trimmed ${messages.length - end} in-flight assistant message(s) with no results yet`)
    messages.length = end
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-replay-'))
const size = (content) => (typeof content === 'string' ? content.length : JSON.stringify(content ?? '').length)

console.log(`session messages=${messages.length}`)
console.log(`baseline pairing valid: ${assertToolPairing(messages)}`)
console.log('')
console.log('| window | evicted | dropped | saved chars | pairing after |')
console.log('|---:|---:|---:|---:|---|')

let failures = 0
for (const windowSize of [200, 400, 700, 1000, 1400, messages.length]) {
  /**
   * 窗口切片会从「一对调用/结果的中间」开始，那本身不是配对错误。
   * 剪掉开头的孤儿 tool 消息，让每个窗口成为自洽的对话。
   */
  const windowMessages = messages.slice(-windowSize)
  while (windowMessages.length > 0 && windowMessages[0]?.role === 'tool') windowMessages.shift()
  const before = windowMessages.reduce((sum, message) => sum + size(message.content), 0)
  const { messages: out, stats } = evictOldEpisodes(windowMessages, {
    spillDir: dir,
    retainRecent: 8,
    minArgChars: minArg,
  })
  const ok = assertToolPairing(out)
  if (!ok) failures += 1
  console.log(
    `| ${windowSize} | ${stats.episodes} | ${stats.droppedMessages} | ${stats.charsSaved} | ${ok ? 'PASS' : '**FAIL**'} |`,
  )
  if (stats.episodes > 0) {
    console.log(`    before=${before} after=${before - stats.charsSaved} (−${((stats.charsSaved / before) * 100).toFixed(1)}%)`)
  }
}

console.log('')
console.log(failures === 0 ? 'VERDICT: pairing holds on every window' : `VERDICT: ${failures} window(s) broke pairing`)
process.exitCode = failures === 0 ? 0 : 1
