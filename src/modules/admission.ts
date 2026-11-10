/**
 * AdmissionModule —— 准入指针化。
 *
 * 超大工具输出/日志不进入上下文，只留「收据 + 真实绝对路径 + 哈希」。
 * 落盘失败时 Fail-Closed：原样返回，绝不给出读不到的指针。
 */

import fs from 'node:fs'
import path from 'node:path'
import { estimateTokens, hashText } from '../contracts'
import { logEvent } from '../log'
import { pinSpill } from './spill-gc'

export interface AdmissionOptions {
  maxInlineTokens: number
  spillDir: string
}

export interface AdmissionResult {
  text: string
  admitted: boolean
  spilledTo: string | null
  tokensBefore: number
  tokensAfter: number
  tokensSaved: number
}

export function runAdmission(text: string, options: AdmissionOptions): AdmissionResult {
  const tokensBefore = estimateTokens(text)
  const base: AdmissionResult = {
    text,
    admitted: false,
    spilledTo: null,
    tokensBefore,
    tokensAfter: tokensBefore,
    tokensSaved: 0,
  }

  if (tokensBefore <= options.maxInlineTokens || text.length === 0) return base

  const digest = hashText(text)
  const fileName = `${digest.slice(0, 16)}-${Array.from(text).length}.txt`
  const target = path.resolve(options.spillDir, fileName)

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, text, 'utf8')
    pinSpill(target)
  } catch (error) {
    logEvent('warn', 'admission.spill_failed', {
      module: 'Admission',
      error: error instanceof Error ? error.message : String(error),
    })
    return base
  }

  const lines = text.split('\n').length
  const receipt =
    `[ADMISSION] 原始输出 ${Array.from(text).length} 字符 / ~${tokensBefore} tokens 未进入上下文。` +
    `完整内容已落盘：${target}（sha256=${digest.slice(0, 16)}…, ${lines} 行）。` +
    `需要细节请使用 read 工具读取该路径；不要重复请求同一内容。`

  const tokensAfter = estimateTokens(receipt)
  const result: AdmissionResult = {
    text: receipt,
    admitted: true,
    spilledTo: target,
    tokensBefore,
    tokensAfter,
    tokensSaved: Math.max(0, tokensBefore - tokensAfter),
  }

  logEvent('info', 'admission.spilled', {
    module: 'Admission',
    file: target,
    tokensBefore,
    tokensAfter,
    tokensSaved: result.tokensSaved,
    hash: digest.slice(0, 16),
  })

  return result
}
