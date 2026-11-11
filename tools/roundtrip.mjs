#!/usr/bin/env node
/**
 * 往返结构分析：每一轮里模型发了几个 tool-call。
 *
 * 动机：账单里 45.6% 是「每次请求重读前缀」的固定成本，它跟**请求数**成正比，
 * 跟内容量无关。所以真正能继续压的不是「每次少发一点」，而是「少发几次」。
 * 一个 step 里并发几个独立工具调用，就省下几次完整的前缀重读。
 *
 * 用法：node tools/roundtrip.mjs <session.v4.jsonl.zstd>
 */
import { readSessionEvents } from './session-decode.mjs'

const file = process.argv[2]
if (!file) {
  process.stderr.write('usage: node tools/roundtrip.mjs <session.v4.jsonl.zstd>\n')
  process.exit(2)
}

const { events } = readSessionEvents(file)
/** assistant/message -> 里面有几个 tool-call block */
const perStep = []
for (const event of events) {
  if (event?.type !== 'assistant/message') continue
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) continue
  const calls = content.filter((b) => b?.type === 'tool-call')
  if (calls.length === 0) continue
  perStep.push({ tool: calls[0]?.name ?? '?', calls: calls.length })
}

const buckets = new Map()
for (const step of perStep) buckets.set(step.calls, (buckets.get(step.calls) ?? 0) + 1)

const steps = perStep.length
const totalCalls = perStep.reduce((sum, s) => sum + s.calls, 0)
const single = buckets.get(1) ?? 0

console.log(`steps with tool calls: ${steps}`)
console.log(`total tool calls     : ${totalCalls}`)
console.log(`avg calls / step     : ${(totalCalls / Math.max(1, steps)).toFixed(2)}`)
console.log(`single-call steps    : ${single} (${((single / Math.max(1, steps)) * 100).toFixed(1)}%)`)
console.log('\ncalls per step:')
for (const [calls, count] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${calls} call(s): ${count} steps`)
}

// 单调用最多的工具：这些正是「可以合并成一次 run_code / 批量调用」的候选
const byTool = new Map()
for (const step of perStep) {
  if (step.calls !== 1) continue
  byTool.set(step.tool, (byTool.get(step.tool) ?? 0) + 1)
}
console.log('\nsingle-call steps by tool:')
for (const [tool, count] of [...byTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${String(count).padStart(4)}  ${tool}`)
}
