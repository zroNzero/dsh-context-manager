/**
 * ResponseCache —— 极简精确哈希响应缓存（v1.2）。
 *
 * 只缓存「字节级完全相同」的请求（messages + tools + model），命中时重放流式 chunk。
 * 不缓存不同请求，避免语义漂移；TTL + 容量双限制。
 */

import { createHash } from 'node:crypto'
import { messagesCacheKey } from './history-rewriter'

interface CacheEntry {
  chunks: any[]
  expiresAt: number
  bytes: number
}

export interface ResponseCacheOptions {
  ttlMs?: number
  maxEntries?: number
  maxBytes?: number
}

export class ResponseCache {
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly maxBytes: number
  private readonly entries = new Map<string, CacheEntry>()
  private totalBytes = 0
  private hits = 0
  private misses = 0

  constructor(options: ResponseCacheOptions = {}) {
    this.ttlMs = Math.max(1000, options.ttlMs ?? 5 * 60_000)
    this.maxEntries = Math.max(1, options.maxEntries ?? 32)
    this.maxBytes = Math.max(64_000, options.maxBytes ?? 8 * 1024 * 1024)
  }

  keyFor(request: any): string {
    const raw = `${request?.model ?? ''}::${request?.provider ?? ''}::${messagesCacheKey(request?.messages, request?.tools)}`
    return createHash('sha256').update(raw).digest('hex')
  }

  get(key: string): any[] | undefined {
    const entry = this.entries.get(key)
    if (!entry) {
      this.misses += 1
      return undefined
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key)
      this.totalBytes -= entry.bytes
      this.misses += 1
      return undefined
    }
    this.hits += 1
    return entry.chunks
  }

  set(key: string, chunks: any[]): void {
    const bytes = JSON.stringify(chunks).length
    if (bytes > this.maxBytes / 2) return
    const existing = this.entries.get(key)
    if (existing) this.totalBytes -= existing.bytes
    this.entries.set(key, { chunks, expiresAt: Date.now() + this.ttlMs, bytes })
    this.totalBytes += bytes
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      const entry = this.entries.get(oldest)!
      this.entries.delete(oldest)
      this.totalBytes -= entry.bytes
    }
  }

  stats(): { hits: number; misses: number; entries: number; bytes: number } {
    return { hits: this.hits, misses: this.misses, entries: this.entries.size, bytes: this.totalBytes }
  }
}

export function replayChunks(chunks: any[]): AsyncGenerator<any> {
  return (async function* () {
    for (const chunk of chunks) yield chunk
  })()
}
