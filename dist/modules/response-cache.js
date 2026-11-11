"use strict";
/**
 * ResponseCache —— 极简精确哈希响应缓存（v1.2）。
 *
 * 只缓存「字节级完全相同」的请求（messages + tools + model），命中时重放流式 chunk。
 * 不缓存不同请求，避免语义漂移；TTL + 容量双限制。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResponseCache = void 0;
exports.replayChunks = replayChunks;
const node_crypto_1 = require("node:crypto");
const history_rewriter_1 = require("./history-rewriter");
class ResponseCache {
    ttlMs;
    maxEntries;
    maxBytes;
    entries = new Map();
    totalBytes = 0;
    hits = 0;
    misses = 0;
    constructor(options = {}) {
        this.ttlMs = Math.max(1000, options.ttlMs ?? 5 * 60_000);
        this.maxEntries = Math.max(1, options.maxEntries ?? 32);
        this.maxBytes = Math.max(64_000, options.maxBytes ?? 8 * 1024 * 1024);
    }
    keyFor(request) {
        const raw = `${request?.model ?? ''}::${request?.provider ?? ''}::${(0, history_rewriter_1.messagesCacheKey)(request?.messages, request?.tools)}`;
        return (0, node_crypto_1.createHash)('sha256').update(raw).digest('hex');
    }
    get(key) {
        const entry = this.entries.get(key);
        if (!entry) {
            this.misses += 1;
            return undefined;
        }
        if (entry.expiresAt <= Date.now()) {
            this.entries.delete(key);
            this.totalBytes -= entry.bytes;
            this.misses += 1;
            return undefined;
        }
        this.hits += 1;
        return entry.chunks;
    }
    set(key, chunks) {
        const bytes = JSON.stringify(chunks).length;
        if (bytes > this.maxBytes / 2)
            return;
        const existing = this.entries.get(key);
        if (existing)
            this.totalBytes -= existing.bytes;
        this.entries.set(key, { chunks, expiresAt: Date.now() + this.ttlMs, bytes });
        this.totalBytes += bytes;
        while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined)
                break;
            const entry = this.entries.get(oldest);
            this.entries.delete(oldest);
            this.totalBytes -= entry.bytes;
        }
    }
    stats() {
        return { hits: this.hits, misses: this.misses, entries: this.entries.size, bytes: this.totalBytes };
    }
}
exports.ResponseCache = ResponseCache;
function replayChunks(chunks) {
    return (async function* () {
        for (const chunk of chunks)
            yield chunk;
    })();
}
