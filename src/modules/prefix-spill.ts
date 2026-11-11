/**
 * PrefixSpill —— 前缀无损折叠（v1.5）。
 *
 * 问题：一次请求的上下文里，绝大部分是「模型自己走过的老路」——旧工具结果约占 39%。
 * 每一次模型调用都要按缓存价把它们重读一遍，是账单里最大的单项支出之一。
 *
 * 做法：把「最近 N 条之外」的旧工具结果整段落盘，上下文里只留
 * 「收据 + 文件名 + 头部摘要」。信息**一个字节都没丢**——模型需要时用 read 读回来。
 *
 * 五条硬约束：
 *   1. **绝不改动 assistant 的任何字节**。这条是事故换来的：v1.4 曾把旧 tool-call 的
 *      arguments 换成 `{"_spill":...}` 收据，结果模型把它当成调用范式照抄，直接产出
 *      `{"_spill":...}` 当 write 的参数，宿主判 MALFORMED_RESPONSE（tool input is
 *      invalid JSON），整轮失败。assistant 消息是模型的模仿模板，不是可压缩的自由文本。
 *      因此本模块只碰 `role === 'tool'` 的消息。
 *   2. **纯函数**：同一段文本永远得到同一个文件名与同一段收据，因此前缀在缓存里
 *      保持字节稳定；一旦收据长度随请求漂移，整段前缀会失效（0.02 元/M → 1 元/M）。
 *   3. **绝不改消息配对的顺序或数量**：只替换 tool 消息的文本，tool-call 的 id 与 name
 *      原样保留，tool-call 与 tool-result 的对应关系完全不动。
 *   4. **收据要短**：它出现在每一条折叠里，哈希 64→12 位、路径→裸文件名、
 *      头部 160→100 字符，合计省下约 1/4 的收据开销。
 *   5. **Fail-Closed**：落盘失败就原样留着，绝不给出读不到的指针。
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
  /** 收据里保留的头部字符数。 */
  headChars?: number
}

export interface PrefixSpillStats {
  folded: number
  charsBefore: number
  charsAfter: number
  files: string[]
}

const DEFAULT_HEAD = 100

/**
 * 收据用短哈希：完整 sha256 是 64 个字符，而它出现在**每一条**收据里。
 * 12 位十六进制在几千个文件的规模下碰撞概率可以忽略，同时每条收据短 52 字符。
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
  const stats: PrefixSpillStats = { folded: 0, charsBefore: 0, charsAfter: 0, files: [] }
  const spillDir = options.spillDir
  if (!spillDir || !Array.isArray(messages) || messages.length === 0) return { messages, stats }

  const retain = Math.max(0, Math.trunc(options.retainRecent ?? 6))
  const minChars = Math.max(200, Math.trunc(options.minChars ?? 600))
  const headChars = Math.max(40, Math.trunc(options.headChars ?? DEFAULT_HEAD))
  const cutoff = messages.length - retain
  if (cutoff <= 0) return { messages, stats }

  const out = messages.slice()
  for (let index = 0; index < cutoff; index += 1) {
    const message = out[index]
    // 约束 1：只有工具结果可以被折叠；assistant（含 tool-call 参数）一律原样。
    if (!message || message.role !== 'tool') continue
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
  }
  return { messages: out, stats }
}
