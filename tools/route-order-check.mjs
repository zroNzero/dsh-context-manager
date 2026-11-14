/**
 * 只读检查：client 包里两处 slot 注册的先后顺序与 id/key 一致性。
 * 顺序写反时，点侧栏会先跳到还不存在的 key，表现为「点了没反应」。
 */
import fs from 'node:fs'

const text = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const mainAt = text.indexOf("inject('main'")
const sideAt = text.indexOf("inject('sidebar.panellist'")
const idMatch = text.match(/const PANEL_ID = '([^']+)'/)
const keyMatch = text.match(/name: 'main', key: PANEL_ID/)
const sideIdMatch = text.match(/name: 'sidebar\.panellist',\s*id: PANEL_ID/)

const problems = []
if (mainAt < 0) problems.push("missing slots.inject('main')")
if (sideAt < 0) problems.push("missing slots.inject('sidebar.panellist')")
if (mainAt >= 0 && sideAt >= 0 && mainAt > sideAt) problems.push('main registered after sidebar entry')
if (!idMatch) problems.push('PANEL_ID not found')
if (!keyMatch) problems.push('main is not keyed by PANEL_ID')
if (!sideIdMatch) problems.push('sidebar entry is not keyed by PANEL_ID')

console.log('PANEL_ID  ', idMatch ? idMatch[1] : '(missing)')
console.log('main at   ', mainAt)
console.log('sidebar at', sideAt)
if (problems.length === 0) console.log('PASS: order and id/key alignment are correct')
else {
  for (const problem of problems) console.log('FAIL:', problem)
  process.exitCode = 1
}
