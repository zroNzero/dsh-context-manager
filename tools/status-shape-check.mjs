/**
 * 宿主工具契约的两条硬约束：
 * 1. `output.schema` 会被逐层（含嵌套）校验；
 * 2. `output.render` 的签名是 `render(args, value)` —— 第一参是调用参数，第二参才是返回值。
 *
 * 为什么需要它：`costkiller_status` 曾静默返回 `{}`。真因不是 schema，而是 render 只声明了
 * 一个形参，于是没有任何入参的调用把「参数对象 `{}`」当成返回值渲染了出去，日志里恰好是
 * 1 token。`search_tools` / `read_ref` 同病（渲染出空串）。schema 这条曾经也写严过，
 * 同样会让宿主退化成 `{}`，所以两条一起守。
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

// 每个工具都必须按 render(args, value) 渲染：用一个只出现在返回值里的探针，
// 一旦实现把第一参当返回值，探针就消失。
// 探针按工具自己声明过的字段投放（有的渲染 JSON，有的只渲染 `text`/`tools` 这类字符串字段），
// 光靠 arity 不够——箭头函数带默认值或解构时 length 可能骗人。
const MARKER = '__render_value_probe__'
let renderBroken = 0
for (const t of registered) {
  const render = t.output?.render
  if (typeof render !== 'function') continue
  const props = t.output?.schema?.properties ?? {}
  const probe = { ok: true }
  for (const [key, spec] of Object.entries(props)) {
    if (spec?.type === 'string') probe[key] = MARKER
  }
  if (!Object.values(probe).includes(MARKER)) probe.marker = MARKER
  const blocks = render({ unrelated: 'args' }, probe)
  const text = Array.isArray(blocks) ? blocks.map((b) => b?.text ?? '').join('') : ''
  if (!text.includes(MARKER)) {
    console.log(`FAIL: ${t.name} 的 render 没渲染返回值（宿主签名是 render(args, value)）`)
    console.log(`  实际渲染出: ${JSON.stringify(text.slice(0, 120))}`)
    renderBroken += 1
  }
}
if (renderBroken > 0) process.exit(1)

console.log('RESULT PASS: 逐层（含嵌套对象）都满足 required 与 additionalProperties')
