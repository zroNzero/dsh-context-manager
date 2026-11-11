/**
 * ToolPipe —— 工具结果数据平面（v2.0 正式版）。
 *
 * 工具输出落盘后只传引用（pipe-xxxxxxxx），模型可通过 read_ref 元工具按需取回。
 * ref 索引写入 `<spillDir>/.pipe-index.json`，跨进程可用。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

interface PipeEntry {
  ref: string
  file: string
  bytes: number
  createdAt: string
}

export class ToolPipe {
  private readonly spillDir: string
  private readonly indexPath: string
  private readonly entries = new Map<string, PipeEntry>()

  constructor(spillDir: string) {
    this.spillDir = path.resolve(spillDir)
    this.indexPath = path.join(this.spillDir, '.pipe-index.json')
    this.load()
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexPath, 'utf8')) as PipeEntry[]
      for (const entry of raw) if (entry?.ref) this.entries.set(entry.ref, entry)
    } catch {
      /* 首次运行没有索引 */
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(this.spillDir, { recursive: true })
      fs.writeFileSync(this.indexPath, JSON.stringify([...this.entries.values()].slice(-200)), 'utf8')
    } catch {
      /* 索引写失败不影响主链路 */
    }
  }

  refForFile(filePath: string): string {
    return `pipe-${createHash('sha256').update(path.basename(filePath)).digest('hex').slice(0, 12)}`
  }

  publishFile(filePath: string): { ref: string; bytes: number } {
    const ref = this.refForFile(filePath)
    let bytes = 0
    try {
      bytes = fs.statSync(filePath).size
    } catch {
      bytes = 0
    }
    this.entries.set(ref, { ref, file: path.resolve(filePath), bytes, createdAt: new Date().toISOString() })
    this.persist()
    return { ref, bytes }
  }

  resolve(ref: string): { ok: boolean; text: string; bytes: number } {
    const entry = this.entries.get(ref)
    if (!entry) return { ok: false, text: `unknown ref: ${ref}`, bytes: 0 }
    try {
      const text = fs.readFileSync(entry.file, 'utf8')
      return { ok: true, text, bytes: Buffer.byteLength(text) }
    } catch (error) {
      return { ok: false, text: `ref unreadable: ${String(error)}`, bytes: 0 }
    }
  }

  size(): number {
    return this.entries.size
  }
}
