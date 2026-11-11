#!/usr/bin/env node
/** 打印最近一次 request/header 的形状，用来确认 system prompt 的体积与形态。 */
import { readSessionEvents } from './session-decode.mjs'

const file = process.argv[2]
const { events } = readSessionEvents(file)
const headers = events.filter((e) => e?.type === 'request/header')
const last = headers[headers.length - 1]
if (!last) {
  console.log('no request/header')
  process.exit(0)
}
const walk = (value, prefix, depth) => {
  if (depth > 2) return
  if (typeof value === 'string') {
    console.log(`${prefix} string len=${value.length}`)
    return
  }
  if (Array.isArray(value)) {
    console.log(`${prefix} array len=${value.length}`)
    value.slice(0, 6).forEach((item, index) => walk(item, `${prefix}[${index}]`, depth + 1))
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) walk(inner, `${prefix}.${key}`, depth + 1)
  }
}
walk(last, 'header', 0)
