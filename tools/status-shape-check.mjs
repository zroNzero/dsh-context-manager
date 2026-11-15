/**
 * 宿主输出校验的忠实模拟：对象节点一律按 `required` + `additionalProperties`
 * 逐层校验，不只是顶层。
 *
 * 为什么需要它：宿主对工具返回值做严格校验，任一层不匹配就把整个结果判为
 * `invalid output` 并退化成空对象 —— costkiller_status 曾因此静默返回 `{}`，
 * 而顶层断言全绿，完全看不出问题。
 *
 * 用法：node tools/status-shape-check.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { apply } = require('../dist/index.js')

/** 极简 fake host：只提供 tools.register 与最小服务面。 */
function makeHost() {
  const registered = []
  const host = {
    tools: { register: (tool) => { registered.push(tool); return () => {} } },
    get: () => undefined,
    inject: (_deps, fn) => fn(host),
    effect: (fn) => { try { return fn() } catch { return () => {} } },
    on: () => () => {},
    logger: () => {},
  }
  return { host, registered }
}

/** 按 JSON Schema 子集递归校验；返回错误列表（空 = 通过）。 */
function validate(value, schema, at = '$', errors = []) {
  if (schema === null || typeof schema !== 'object') return errors
  const type = schema.type

  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${at}: 期望 object，实为 ${value === null ? 'null' : typeof value}`)
      return errors
    }
    const props = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${at}.${key}: 缺失但被 required 声明`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${at}.${key}: additionalProperties:false 下未声明`)
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) validate(value[key], sub, `${at}.${key}`, errors)
    }
    return errors
  }

  if (type === 'array') {
    if (!Array.isArray(value)) { errors.push(`${at}: 期望 array`); return errors }
    if (schema.items) value.forEach((item, i) => validate(item, schema.items, `${at}[${i}]`, errors))
    return errors
  }

  if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    errors.push(`${at}: 期望有限 number，实为 ${JSON.stringify(value)}`)
  }
  if (type === 'string' && typeof value !== 'string') {
    errors.push(`${at}: 期望 string，实为 ${typeof value}`)
  }
  if (type === 'boolean' && typeof value !== 'boolean') {
    errors.push(`${at}: 期望 boolean，实为 ${typeof value}`)
  }
  return errors
}

const { host, registered } = makeHost()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-status-'))
const previousCwd = process.cwd()
process.chdir(tmp)
try {
  apply(host, {})
} catch (err) {
  console.log('apply threw:', err && err.message)
}
process.chdir(previousCwd)

const tool = registered.find((t) => t.name === 'costkiller_status')
if (!tool) {
  console.log('FAIL: costkiller_status 未注册')
  process.exit(1)
}

const payload = await tool.execute()
const schema = tool.output?.schema
if (!schema) {
  console.log('FAIL: 没有 output.schema')
  process.exit(1)
}

const errors = validate(payload, schema)
const bytes = JSON.stringify(payload).length
const topKeys = Object.keys(payload ?? {}).length

console.log(`payload 顶层字段: ${topKeys} | JSON: ${bytes} bytes`)

const realBill = payload?.realBilling
if (realBill) {
  console.log(`realBilling.lastPricing: ${JSON.stringify(realBill.lastPricing)}`)
}

if (errors.length > 0) {
  console.log('FAIL: 这份 payload 会被宿主判为 invalid output（将退化成 {}）')
  for (const e of errors.slice(0, 12)) console.log('  - ' + e)
  if (errors.length > 12) console.log(`  …共 ${errors.length} 处`)
  process.exit(1)
}

console.log('RESULT PASS: 逐层（含嵌套对象）都满足 required 与 additionalProperties')
