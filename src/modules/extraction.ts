/**
 * ExtractionModule —— 多引擎萃取（v3.4 审计修订版）。
 *
 * 顺序：核心约束（永不压缩）→ 代码结构骨架化 → JSON 压缩 → 分节压缩 → 头尾截断。
 *
 * Fail-Closed 三条硬规则：
 * 1. CORE_CONSTRAINTS 标记不闭合 → 返回原文本；
 * 2. 代码花括号不配对 / 结构渲染失败 / 声明名丢失 → 返回原文本；
 * 3. 抽取后任一约束值丢失 → 返回原文本。
 * 返回 safe=false 时，调用方（index.ts）必须使用 admitted.text（原文/收据），不得使用本模块输出。
 */

import { estimateTokens, hashText } from '../contracts'
import { logEvent } from '../log'

export type ExtractionMode = 'none' | 'ast' | 'json' | 'section' | 'index' | 'head-tail'

export interface ExtractionResult {
  text: string
  constraints: string
  safe: boolean
  mode: ExtractionMode
  tokensBefore: number
  tokensAfter: number
  tokensSaved: number
  reason?: string
  /** 是否因时间预算/体量而退化到快速路径。 */
  degraded?: boolean
  /** 本次萃取耗时（毫秒），用于延迟审计。 */
  elapsedMs?: number
}

const CORE_START = '[CORE_CONSTRAINTS]'
const CORE_END = '[/CORE_CONSTRAINTS]'

const PATH_RE = /(?:[A-Za-z]:[\\/](?:[^\s"'<>|?*\r\n]+[\\/])*[^\s"'<>|?*\r\n]+|\\\\[A-Za-z0-9._$-]+[\\/][^\s"'<>|?*\r\n]+)/g
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g
const HASH_RE = /\b[0-9a-fA-F]{32,64}\b/g
const TODO_RE = /\b(TODO|FIXME|XXX|HACK)\b\s*[:：-]?\s*([^\r\n]{0,90})/g
const CONFIG_RE = /\b[a-zA-Z_$][\w$]*(?:Limit|Timeout|Threshold|Budget|Ratio|Window|Depth)\b/g
const ENV_ASSIGN_RE = /\b([A-Z][A-Z0-9_]{2,})\s*(?:=|:=)/g

const CLASS_RE = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:declare\s+)?(?:class|interface|enum|namespace|module)\b/
const FUNC_RE = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b|^(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*=\s*(?:async\s*)?(?:function|\(|async\s*\()|^(?:public|private|protected|static|async|get|set|override|readonly)\s+[\w$#]+\s*[(<]|^[\w$#]+\s*(?:<[^>]*>)?\s*\(/
const DECL_HINT = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:declare\s+)?(?:async\s+)?(?:class|interface|function|const|let|var)\b/

function unique(values: string[], limit: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
    if (out.length >= limit) break
  }
  return out
}

/** 提取不可压缩约束块；标记不闭合时返回 null（调用方 Fail-Closed）。 */
export function extractConstraints(text: string): string | null {
  const starts = text.split(CORE_START).length - 1
  const ends = text.split(CORE_END).length - 1
  if (starts !== ends) return null

  const paths = unique(text.match(PATH_RE) ?? [], 8)
  const ids = unique([...(text.match(UUID_RE) ?? []), ...(text.match(HASH_RE) ?? [])], 8)
  const todos = unique(
    (text.match(TODO_RE) ?? []).map((entry) => entry.replace(/\s+/g, ' ').trim()).filter((entry) => entry.length > 0),
    5,
  )
  const config = unique(
    [...(text.match(CONFIG_RE) ?? []), ...(text.match(ENV_ASSIGN_RE) ?? []).map((entry) => entry.replace(/\s*[:=].*$/, ''))],
    8,
  )

  if (paths.length + ids.length + todos.length + config.length === 0) return ''

  const lines: string[] = [CORE_START]
  if (paths.length > 0) lines.push(`paths: ${paths.join(' | ')}`)
  if (ids.length > 0) lines.push(`ids: ${ids.join(' | ')}`)
  if (todos.length > 0) lines.push(`todos: ${todos.join(' | ')}`)
  if (config.length > 0) lines.push(`config: ${config.join(' | ')}`)
  lines.push(CORE_END)

  let block = lines.join('\n')
  if (block.length > 1600) block = `${block.slice(0, 1600)}…`
  return block
}

export function looksLikeCode(text: string): boolean {
  const head = text.slice(0, 6000)
  const declSignals = (head.match(/^\s*(?:import|export|class|interface|function|def|enum|package)\b/gm) ?? []).length
  const methodSignals = (
    head.match(
      /^\s*(?:(?:public|private|protected|static|async|get|set|override|readonly)\s+)?[\w$#]+\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::[^{]+)?\{/gm,
    ) ?? []
  ).length
  const hasDeclaration = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:class|interface|function|def)\b/m.test(head)
  const braces = (head.match(/[{}]/g) ?? []).length
  if (braces < 4) return false
  return hasDeclaration || declSignals >= 2 || methodSignals >= 3
}

interface Scan {
  open: number
  close: number
  firstOpen: number
}

/** 跳过字符串与行注释，统计一行里的花括号。 */
function scanLine(line: string): Scan {
  let open = 0
  let close = 0
  let firstOpen = -1
  let quote = ''
  let escaped = false

  for (let index = 0; index < line.length; index++) {
    const ch = line[index]!
    if (quote) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '/' && line[index + 1] === '/') break
    if (ch === '{') {
      open += 1
      if (firstOpen < 0) firstOpen = index
    } else if (ch === '}') {
      close += 1
    }
  }

  return { open, close, firstOpen }
}

/** 全文花括号是否配对（字符串/注释感知），不配对即视为不可解析。 */
export function isBalancedCode(text: string): boolean {
  let depth = 0
  let quote = ''
  let escaped = false
  let blockComment = false
  let lineComment = false

  for (let index = 0; index < text.length; index++) {
    const ch = text[index]!
    const next = text[index + 1]

    if (lineComment) {
      if (ch === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false
        index++
      }
      continue
    }
    if (quote) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '/' && next === '/') {
      lineComment = true
      index++
      continue
    }
    if (ch === '/' && next === '*') {
      blockComment = true
      index++
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth < 0) return false
    }
  }

  return depth === 0
}

/** 从 (startLine, startCol) 的 `{` 找配对 `}`；失败返回 null。 */
function findMatchingBrace(lines: string[], startLine: number, startCol: number): { line: number; col: number } | null {
  let depth = 0
  let quote = ''
  let escaped = false
  let blockComment = false

  for (let lineIndex = startLine; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!
    const from = lineIndex === startLine ? startCol : 0
    let lineComment = false

    for (let col = from; col < line.length; col++) {
      const ch = line[col]!
      const next = line[col + 1]

      if (lineComment) break
      if (blockComment) {
        if (ch === '*' && next === '/') {
          blockComment = false
          col++
        }
        continue
      }
      if (quote) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === quote) quote = ''
        continue
      }
      if (ch === '/' && next === '/') {
        lineComment = true
        break
      }
      if (ch === '/' && next === '*') {
        blockComment = true
        col++
        continue
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch
        continue
      }
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) return { line: lineIndex, col }
      }
    }
  }

  return null
}

/** 统计一行里未闭合的圆括号数量（忽略字符串内容）。 */
function openParens(line: string): number {
  let open = 0
  let quote = ''
  let escaped = false
  for (let index = 0; index < line.length; index++) {
    const ch = line[index]!
    if (quote) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '/' && line[index + 1] === '/') break
    if (ch === '(') open += 1
    else if (ch === ')') open -= 1
  }
  return open
}

/** 把「参数换行的签名」合并成一行，便于结构识别。 */
function joinSignatures(lines: string[]): string[] {
  const out: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const trimmed = line.trim()
    // 只合并「括号未闭合」的声明行；普通的 const x = y 不能被误合并。
    if (DECL_HINT.test(trimmed) && !trimmed.includes('{') && !trimmed.endsWith(';') && openParens(trimmed) > 0) {
      let merged = line
      let cursor = index + 1
      let closed = false
      while (cursor < lines.length && cursor - index <= 10) {
        const nextLine = lines[cursor]!
        merged += ` ${nextLine.trim()}`
        if (nextLine.includes('{')) {
          closed = true
          break
        }
        if (nextLine.trim() === '') break
        cursor += 1
      }
      if (closed) {
        out.push(merged)
        index = cursor
        continue
      }
    }
    out.push(line)
  }
  return out
}

function declarationNames(text: string): string[] {
  const names = new Set<string>()
  for (const match of text.matchAll(/\b(?:class|interface|enum|function)\s+([A-Za-z_$][\w$]*)/g)) {
    if (match[1]) names.add(match[1])
  }
  for (const match of text.matchAll(/^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/gm)) {
    if (match[1]) names.add(match[1])
  }
  return [...names]
}

function renderBlock(lines: string[], from: number, to: number, indent: string, depth: number): string[] {
  const out: string[] = []
  let index = from

  while (index <= to) {
    const raw = lines[index]!
    const trimmed = raw.trim()

    if (trimmed === '') {
      index += 1
      continue
    }

    if (/^(?:\/\/|#(?!include)|\/\*|\*)/.test(trimmed)) {
      if (depth <= 1 && trimmed.length <= 160) out.push(`${indent}${trimmed}`)
      index += 1
      continue
    }

    if (/^(?:import|from|package|#include)\b/.test(trimmed)) {
      out.push(`${indent}${trimmed}`)
      index += 1
      continue
    }

    const scan = scanLine(raw)
    if (scan.open > scan.close && scan.firstOpen >= 0) {
      const close = findMatchingBrace(lines, index, scan.firstOpen)
      if (!close) return out

      const signature = raw.slice(0, raw.indexOf('{')).trim()
      if (CLASS_RE.test(trimmed) && depth < 2) {
        out.push(`${indent}${signature} {`)
        out.push(...renderBlock(lines, index + 1, close.line - 1, `${indent}  `, depth + 1))
        out.push(`${indent}}`)
      } else if (CLASS_RE.test(trimmed)) {
        out.push(`${indent}${signature} { ... }`)
      } else if (FUNC_RE.test(trimmed)) {
        out.push(`${indent}${signature} { ... }`)
      } else {
        out.push(`${indent}${signature} { ... }`)
      }
      index = close.line + 1
      continue
    }

    if (trimmed.length <= 200) out.push(`${indent}${trimmed}`)
    index += 1
  }

  return out
}

/**
 * 结构化骨架化：保留 import / 类名 / 方法签名 / 注释，函数体与方法体折成 `{ ... }`。
 * 返回 null 表示「不可解析」——调用方必须 Fail-Closed 使用原文本。
 */
export function skeletonize(text: string): string | null {
  if (!isBalancedCode(text)) return null

  const lines = joinSignatures(text.split(/\r?\n/))
  const rendered = renderBlock(lines, 0, lines.length - 1, '', 0)
  const skeleton = rendered.join('\n').trim()

  if (skeleton.length === 0 || skeleton.length >= text.length) return null

  // 声明名丢失 = 结构识别失败 → Fail-Closed。
  for (const name of declarationNames(text)) {
    if (!skeleton.includes(name)) return null
  }

  return skeleton
}

function compressJson(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.stringify(JSON.parse(trimmed) as unknown)
  } catch {
    return null
  }
}

function compressSections(text: string): string | null {
  const lines = text.split(/\r?\n/)
  const headings = lines.filter((line) => /^#{1,6}\s/.test(line.trim())).length
  // 没有真实分节结构的日志不允许走分节压缩（否则会退化成“只留两行”）。
  if (headings < 3) return null

  const out: string[] = []
  let kept = 0
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line.trim())) {
      out.push(line.trim())
      kept = 0
      continue
    }
    if (kept < 2 && line.trim().length > 0) {
      out.push(line)
      kept += 1
    }
  }
  out.push('[... 分节压缩，正文已省略 ...]')
  return out.join('\n')
}

/**
 * 索引先行（index first, fetch on demand）：
 * 当输出是「大量文件路径/清单」时，只保留条目数与前 12 条，其余按需从落盘指针读取。
 * 灵感：PenguinHarness《先压低上下文斜率》——清单类输出的斜率应恒定，而不是随条目线性增长。
 */
function compressIndexFirst(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length < 40) return null

  const pathLines = lines.filter((line) => /(?:^|\s)(?:[A-Za-z]:\\|\/(?:[\w.-]+\/)+)[^\s]+/.test(line))
  if (pathLines.length < 30) return null

  const unique = [...new Set(pathLines)]
  const head = unique.slice(0, 12).map((line) => `- ${line}`).join('\n')
  return [
    `[INDEX] 共 ${unique.length} 个路径/条目（原文 ${Array.from(text).length} 字符）。前 12 条：`,
    head,
    '[... 其余条目已省略；完整清单见下方落盘指针，按需用 read 工具读取 ...]',
  ].join('\n')
}

function headTail(text: string, headChars: number, tailChars: number): string {
  const points = Array.from(text)
  if (points.length <= headChars + tailChars) return text
  return `${points.slice(0, headChars).join('')}\n\n[... 中间内容已省略 ...]\n\n${points.slice(-tailChars).join('')}`
}

export function runExtraction(input: { text: string; maxTokens: number; budgetMs?: number }): ExtractionResult {
  const startedAt = Date.now()
  const budgetMs = input.budgetMs ?? 50
  const deadline = startedAt + budgetMs
  const expired = () => Date.now() > deadline
  const text = typeof input.text === 'string' ? input.text : ''
  const tokensBefore = estimateTokens(text)
  const raw: ExtractionResult = {
    text,
    constraints: '',
    safe: true,
    mode: 'none',
    tokensBefore,
    tokensAfter: tokensBefore,
    tokensSaved: 0,
  }

  if (tokensBefore <= input.maxTokens || text.length === 0) return raw

  const constraints = extractConstraints(text)
  if (constraints === null) {
    logEvent('warn', 'extraction.constraint_unclosed', { module: 'Extraction', tokensBefore })
    return { ...raw, safe: false, reason: 'CORE_CONSTRAINTS markers are unbalanced' }
  }

  let mode: ExtractionMode = 'none'
  let body = text
  let degraded = false

  const codeIntent =
    looksLikeCode(text) ||
    /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:class|interface|function|def)\s+[A-Za-z_$][\w$]*/m.test(text)

  if (codeIntent) {
    // 速度优先：超大代码不跑 AST（最坏 O(n) 且递归渲染开销大），直接头尾 + 落盘指针。
    if (text.length > 250_000) {
      body = headTail(text, Math.max(1000, Math.floor(text.length * 0.2)), Math.max(1000, Math.floor(text.length * 0.05)))
      mode = 'head-tail'
      degraded = true
      logEvent('warn', 'extraction.fast_path', {
        module: 'Extraction',
        chars: text.length,
        reason: 'input too large for AST within budget',
      })
    } else {
      const skeleton = skeletonize(text)
      if (skeleton === null) {
        logEvent('warn', 'extraction.code_parse_failed', { module: 'Extraction', tokensBefore })
        return { ...raw, safe: false, reason: 'code structure unparseable (fail-closed)' }
      }
      body = skeleton
      mode = 'ast'
      if (expired()) {
        body = headTail(text, Math.max(1000, Math.floor(text.length * 0.2)), Math.max(1000, Math.floor(text.length * 0.05)))
        mode = 'head-tail'
        degraded = true
        logEvent('warn', 'extraction.deadline_exceeded', {
          module: 'Extraction',
          budgetMs,
          elapsedMs: Date.now() - startedAt,
        })
      }
    }
  }

  if (mode === 'none') {
    const json = compressJson(text)
    if (json !== null && json.length < text.length) {
      body = json
      mode = 'json'
    }
  }

  if (mode === 'none') {
    const indexed = compressIndexFirst(text)
    if (indexed !== null) {
      body = indexed
      mode = 'index'
    }
  }

  if (mode === 'none') {
    const sections = compressSections(text)
    if (sections !== null && sections.length < text.length) {
      body = sections
      mode = 'section'
    }
  }

  if (mode === 'none') {
    body = headTail(text, Math.max(1000, Math.floor(text.length * 0.3)), Math.max(1000, Math.floor(text.length * 0.1)))
    mode = 'head-tail'
  }

  const composed = constraints.length > 0 ? `${constraints}\n\n${body}` : body

  // Fail-Closed：抽取后仍必须包含全部关键约束，否则回退原文。
  const constraintLines = constraints
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('['))
  for (const line of constraintLines) {
    const values = line.replace(/^[a-z]+:\s*/i, '').split('|').map((entry) => entry.trim()).filter(Boolean)
    for (const value of values) {
      if (!composed.includes(value)) {
        logEvent('warn', 'extraction.fail_closed', { module: 'Extraction', lost: value.slice(0, 120) })
        return { ...raw, safe: false, reason: `constraint lost after extraction: ${value.slice(0, 80)}` }
      }
    }
  }

  const tokensAfter = estimateTokens(composed)
  if (tokensAfter >= tokensBefore) {
    return { ...raw, mode: 'none', safe: true, reason: 'no net saving' }
  }

  const result: ExtractionResult = {
    text: composed,
    constraints,
    safe: true,
    mode,
    tokensBefore,
    tokensAfter,
    tokensSaved: tokensBefore - tokensAfter,
    degraded,
    elapsedMs: Date.now() - startedAt,
  }

  logEvent('info', 'extraction.applied', {
    module: 'Extraction',
    mode,
    tokensBefore,
    tokensAfter,
    tokensSaved: result.tokensSaved,
    elapsedMs: result.elapsedMs,
    degraded,
    digest: hashText(composed).slice(0, 16),
  })

  return result
}
