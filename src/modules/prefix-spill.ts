/**
 * PrefixSpill —— 前缀无损折叠（v1.4）。
 *
 * 问题：一次请求的上下文里，绝大部分是「模型自己走过的老路」——旧工具结果（38.7%）
 * 和旧 tool-call 参数（后者的占比在丢 thinking 之后升到 45%，成为最大单项）。
 * 每一次模型调用都要按缓存价把它们重读一遍，而命中量是账单里最大的单项支出之一。
 *
 * 做法：把「最近 N 条之外」的旧工具结果、旧 tool-call 参数整段落盘，上下文里只留
 * 「收据 + 绝对路径 + 头部摘要」。信息**一个字节都没丢**——模型需要时用 read 读回来，
 * 所以这不是降智式的截断，是有损压缩的可逆版本。
 *
 * 四条硬约束：
 *   1. **纯函数**：同一段文本永远得到同一个文件名与同一段收据，因此前缀在缓存里
 *      保持字节稳定；一旦收据长度随请求漂移，整段前缀会失效（0.02 元/M → 1 元/M）。
 *   2. **绝不改消息配对的顺序或数量**：只替换文本，tool-call 的 id 与 name 原样保留，
 *      tool-call 与 tool-result 的对应关系完全不动（折叠事故的根因就是动了配对）。
 *   3. **tool-call 的 arguments 必须是合法 JSON**：provider 要求它是 JSON 字符串，
 *      直接塞一段中文收据会被拒；所以参数一律替换成 JSON 对象字面量。
 *   4. **Fail-Closed**：落盘失败就原样留着，绝不给出读不到的指针。
 */

import fs from 'node:fs'
import path from 'node:path'
import { hashText } from '../contracts'

export interface PrefixSpillOptions {
  /** 落盘目录；缺省关闭。 */
  spillDir?: string
  /** 最近 N 条消息原样保留（模型正在用的窗口）。 */
  retainRecent?: number
  /** 超过这个字符数的旧工具结果才折叠。 */
  minChars?: number
  /** 超过这个字符数的旧 tool-call 参数才折叠。 */
  minArgChars?: number
  /** 收据里保留的头部字符数（工具结果）。 */
  headChars?: number
  /** 收据里保留的头部字符数（tool-call 参数）。 */
  argHeadChars?: number
}

export interface PrefixSpillStats {
  folded: number
  foldedArgs: number
  charsBefore: number
  charsAfter: number
  files: string[]
}

const DEFAULT_HEAD = 100
const DEFAULT_ARG_HEAD = 120

/**
 * 收据用短哈希：完整 sha256 是 64 个字符，而它出现在**每一条**收据里。
 * 实测 77 条结果收据 + 100 条参数收据，光哈希就吃掉约 1.1 万字符/请求。
 * 12 位十六进制在几千个文件的规模下碰撞概率可以忽略，同时收据短了 52 字符。
 */
function shortHash(text: string): string {
  return hashText(text).slice(0, 12)
}

/** 取消息的纯文本（tool 结果的 content 可能是 string 也可能是 block 数组）。 */
function toolText(message: any): string {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((block: any) => (typeof block?.text === 'string' ? block.text : '')).join('\n')
  }
  return ''
}

/** 参数可能是 JSON 字符串，也可能是对象；统一成字符串再判断长度。 */
function argText(value: any): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function writeOnce(dir: string, name: string, text: string): string | null {
  const target = path.resolve(dir, name)
  try {
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, text, 'utf8')
    }
    return target
  } catch {
    return null
  }
}

export function foldOldToolResults(
  messages: any[],
  options: PrefixSpillOptions,
): { messages: any[]; stats: PrefixSpillStats } {
  const stats: PrefixSpillStats = { folded: 0, foldedArgs: 0, charsBefore: 0, charsAfter: 0, files: [] }
  const spillDir = options.spillDir
  if (!spillDir || !Array.isArray(messages) || messages.length === 0) return { messages, stats }

  const retain = Math.max(0, Math.trunc(options.retainRecent ?? 6))
  const minChars = Math.max(200, Math.trunc(options.minChars ?? 600))
  const minArgChars = Math.max(160, Math.trunc(options.minArgChars ?? 320))
  const headChars = Math.max(40, Math.trunc(options.headChars ?? DEFAULT_HEAD))
  const argHeadChars = Math.max(40, Math.trunc(options.argHeadChars ?? DEFAULT_ARG_HEAD))
  const cutoff = messages.length - retain
  if (cutoff <= 0) return { messages, stats }

  const out = messages.slice()
  for (let index = 0; index < cutoff; index += 1) {
    const message = out[index]
    if (!message) continue

    // ---- 旧工具结果 ----
    if (message.role === 'tool') {
      const text = toolText(message)
      if (text.length <= minChars) continue
      stats.charsBefore += text.length
      const target = writeOnce(spillDir, `prefix-${shortHash(text)}.txt`, text)
      if (!target) {
        stats.charsBefore -= text.length
        continue
      }
      const receipt = `[SPILL] ${text.length}c ${path.basename(target)}\n${text.slice(0, headChars)}`
      out[index] = Array.isArray(message.content)
        ? { ...message, content: [{ type: 'text', text: receipt }] }
        : { ...message, content: receipt }
      stats.folded += 1
      stats.charsAfter += receipt.length
      stats.files.push(target)
      continue
    }

    // ---- 旧 tool-call 参数 ----
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    let touched = false
    const nextContent = message.content.map((block: any) => {
      if (block?.type !== 'tool-call') return block
      const raw = argText(block?.arguments)
      if (raw.length <= minArgChars) return block
      const target = writeOnce(spillDir, `args-${shortHash(raw)}.json`, raw)
      if (!target) return block
      // arguments 必须是合法 JSON，否则 provider 直接拒；所以收据本身写成 JSON 字面量。
      const receipt = JSON.stringify({ _spill: path.basename(target), _chars: raw.length, _head: raw.slice(0, argHeadChars) })
      stats.charsBefore += raw.length
      stats.charsAfter += receipt.length
      stats.foldedArgs += 1
      stats.files.push(target)
      touched = true
      return { ...block, arguments: receipt }
    })
    if (touched) out[index] = { ...message, content: nextContent }
  }
  return { messages: out, stats }
}
