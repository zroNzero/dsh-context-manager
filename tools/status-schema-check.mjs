/**
 * costkiller_status 的输出必须能通过它自己声明的 schema。
 *
 * 事故：schema 里 required 列了 tier/window/hit/miss/output，但 getStatus() 把它们放在
 * lastPricing 子对象里，顶层根本没有 → 宿主校验失败 → 工具返回 {}（且不报错）。
 * 这个脚本把「声明」和「实际」对一遍，防止再次静默。
 */
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

// 抓 required 数组
const reqMatch = /required:\s*\[([^\]]*)\]/.exec(src)
if (reqMatch === null) {
  console.log('FAIL 找不到 status schema 的 required')
  process.exit(1)
}
const required = [...reqMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])

// 抓 additionalProperties
const additional = /additionalProperties:\s*(true|false)/.exec(src)?.[1]

// 抓 getStatus 返回对象的顶层 key
const start = src.indexOf('execute: async () => getStatus()')
const bodyStart = src.lastIndexOf('buildStatusTool(', start)
const body = src.slice(bodyStart, start)
const keys = new Set()
for (const m of body.matchAll(/^\s{6}([a-zA-Z][\w]*):/gm)) keys.add(m[1])
for (const m of body.matchAll(/'([a-zA-Z][\w]*)'/g)) keys.add(m[1])

const problems = []
for (const field of required) {
  if (!keys.has(field)) problems.push(`required 里有 "${field}"，但返回对象没有这个顶层字段`)
}
if (additional === 'false' && required.length > 0) {
  // 严格模式下任何未声明字段都会被丢掉，这里提示风险即可
  const undeclared = [...keys].filter((k) => !src.includes(`'${k}'`))
  if (undeclared.length > 0) problems.push(`additionalProperties:false 下这些字段未声明: ${undeclared.join(', ')}`)
}

console.log(`required=${required.length} | additionalProperties=${additional} | 返回顶层字段=${keys.size}`)
console.log('required:', required.join(', '))
if (problems.length > 0) {
  console.log('FAIL')
  for (const p of problems) console.log('  - ' + p)
  process.exit(1)
}
console.log('RESULT PASS: 声明与实际一致，工具不会因校验失败而返回空对象')
