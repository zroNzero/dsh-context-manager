/**
 * PrefixSpill —— 前缀无损折叠（v1.3 主杠杆）。
 *
 * 问题：一次请求的上下文里，旧工具结果占 ~39%（实测 650K 字符预算下 251K 字符），
 * 每一次模型调用都要按缓存价把它们重读一遍。它们**几乎全是新内容就已经没了价值**的
 * 历史回显，但删掉又会让模型丢信息。
 *
 * 做法：把「最近 N 条之外」的旧工具结果整段落盘，上下文里只留
 * 「收据 + 绝对路径 + 字节数 + 头部摘要」。信息**一个字节都没丢**——模型需要时可以
 * 用 read 把原文件读回来，所以这不是降智式的截断，是有损压缩的可逆版本。
 *
 * 两条硬约束：
 *   1. **纯函数**：同一段文本永远得到同一个文件名与同一段收据，因此前缀在缓存里
 *      保持字节稳定；一旦收据长度随请求漂移，整段前缀会失效（0.02 元/M 变 1 元/M）。
 *   2. **绝不改消息配对的顺序或数量**：只替换 content 文本，tool-call 与 tool-result
 *      的对应关系完全不动（折叠事故的根因就是动了配对）。
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

const RECEIPT_HEAD = 240

/** 取消息的纯文本（tool 结果的 content 可能是 string 也可能是 block 数组）。 */
function toolText(message: any): string {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((block: any) => (typeof block?.text === 'string' ? block.text : '')).join('\n')
  }
  return ''
}

export function foldOldToolResults(
  messages: any[],
  options: PrefixSpillOptions,
): { messages: any[]; stats: PrefixSpillStats } {
  const stats: PrefixSpillStats = { folded: 0, charsBefore: 0, charsAfter: 0, files: [] }
  const spillDir = options.spillDir
  if (!spillDir || !Array.isArray(messages) || messages.length === 0) return { messages, stats }

  const retain = Math.max(0, Math.trunc(options.retainRecent ?? 6))
  const minChars = Math.max(400, Math.trunc(options.minChars ?? 1200))
  const headChars = Math.max(80, Math.trunc(options.headChars ?? RECEIPT_HEAD))
  const cutoff = messages.length - retain
  if (cutoff <= 0) return { messages, stats }

  const out = messages.slice()
  for (let index = 0; index < cutoff; index += 1) {
    const message = out[index]
    if (!message || message.role !== 'tool') continue
    const text = toolText(message)
    if (text.length <= minChars) continue
    stats.charsBefore += text.length

    const hash = hashText(text)
    const target = path.resolve(spillDir, `prefix-${hash}.txt`)
    try {
      if (!fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, text, 'utf8')
      }
    } catch {
      // 落盘失败 -> Fail-Closed：这条原样留着，绝不给出读不到的指针。
      stats.charsBefore -= text.length
      continue
    }

    const receipt = [
      `[PREFIX-SPILL] 旧工具结果 ${text.length} 字符已落盘：${target}`,
      `需要原文请用 read 工具读取该路径；不要重复执行同一条命令。`,
      `--- 摘要（前 ${headChars} 字符）---`,
      text.slice(0, headChars),
    ].join('\n')

    const replacement = Array.isArray(message.content)
      ? { ...message, content: [{ type: 'text', text: receipt }] }
      : { ...message, content: receipt }
    out[index] = replacement
    stats.folded += 1
    stats.charsAfter += receipt.length
    stats.files.push(target)
  }
  return { messages: out, stats }
}
