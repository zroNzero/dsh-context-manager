/**
 * 自检：面板插件的槽位契约。
 *
 * 校验四件事（都是实测会静默失败的）：
 *   1. sidebar.panellist.id === main.key === 模块 id  —— 否则点了切不过去
 *   2. main 的注册里没有 id / order                    —— 它是 keyed slot
 *   3. 有 __ModuleLoader__ 且末尾 return module.exports —— 否则宿主加载不到
 *   4. 没有顶层 import / export、没有相对路径 require    —— 否则不是经典脚本
 *
 * 用法：node tools/check-slots.mjs [client.js]
 */
import fs from 'node:fs'
import path from 'node:path'

const file = path.resolve(process.argv[2] ?? 'client.js')
const text = fs.readFileSync(file, 'utf8')
const problems = []

/** 文件里所有 `const NAME = '字面量'`，用于把 main.key 的常量名解析成值。 */
const consts = new Map()
for (const m of text.matchAll(/(?:const|var|let)\s+([A-Za-z_$][\w$]*)\s*=\s*'([^']*)'/g)) {
  consts.set(m[1], m[2])
}

const resolve = (raw) => {
  if (raw === null) return null
  const trimmed = raw.trim()
  if (/^'.*'$/.test(trimmed)) return trimmed.slice(1, -1)
  return consts.get(trimmed) ?? trimmed
}

const pick = (re, label) => {
  const m = re.exec(text)
  if (!m) problems.push(`无法解析 ${label}`)
  return m ? m[1] : null
}

const moduleId = resolve(pick(/__ModuleLoader__\s*\.\s*load\(\s*\{[^}]*?\bid\s*:\s*([^,\s}]+)/, '__ModuleLoader__.load 的 id'))
const mainKey = resolve(pick(/name:\s*'main'\s*,\s*key:\s*([^,}\s]+)/, 'main.key'))
const sideId = resolve(pick(/name:\s*'sidebar\.panellist'\s*,\s*id:\s*([^,}\s]+)/, 'sidebar.panellist.id'))

if (moduleId !== null && mainKey !== null && sideId !== null && !(moduleId === mainKey && moduleId === sideId)) {
  problems.push(
    `id/key 不对齐：module=${moduleId} main.key=${mainKey} sidebar.id=${sideId}` +
      '（三者必须相同，否则点击侧栏条目切不到页面）',
  )
}

const mainBlock = /register\(\s*\{[^}]*name:\s*'main'[^}]*\}/.exec(text)
if (mainBlock) {
  if (/\bid\s*:/.test(mainBlock[0])) problems.push('main 的注册里出现 id：main 是 keyed slot，只认 key')
  if (/\border\s*:/.test(mainBlock[0])) problems.push('main 的注册里出现 order：main 是 keyed slot，不参与排序')
} else {
  problems.push("没找到 main 的注册块（应为 ctx.slots.register({ name: 'main', key: ... }))")
}

if (!/__ModuleLoader__\s*\.\s*load\(/.test(text)) problems.push('缺少 window.__ModuleLoader__.load({...}) —— 宿主加载不到这个文件')
if (!/return\s+module\.exports/.test(text)) problems.push('factory 末尾缺少 return module.exports')
if (/^\s*(import|export)\s/m.test(text)) problems.push('存在顶层 import/export —— UI 半必须是经典脚本，不是 ES 模块')
if (/require\(\s*['"]\.\.?\//.test(text)) problems.push('存在相对路径 require —— 模块表无法解析，必然运行时抛错')

const mainAt = text.search(/inject\(\s*'main'/)
const sideAt = text.search(/inject\(\s*'sidebar\.panellist'/)
if (mainAt >= 0 && sideAt >= 0 && mainAt > sideAt) {
  problems.push("注册顺序反了：先 inject('main') 再 inject('sidebar.panellist')，否则首帧点击会切到空白页")
}

if (problems.length > 0) {
  console.log('FAIL ' + file)
  for (const p of problems) console.log('  - ' + p)
  process.exitCode = 1
} else {
  console.log(`PASS ${path.basename(file)} :: module=${moduleId} main.key=${mainKey} sidebar.id=${sideId}`)
}
