"use strict";
/**
 * ResponseCache —— 精确哈希 + 轻量语义相似响应缓存（v1.3）。
 *
 * - 精确命中：model + messages + tools 字节级一致；
 * - 语义命中：对请求文本做小写/标点归一化后取关键词集合，Jaccard ≥ 阈值即命中。
 *   不使用向量模型，零额外延迟。
 * TTL + 容量双限制；命中时重放流式 chunk。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResponseCache = void 0;
exports.replayChunks = replayChunks;
const node_crypto_1 = require("node:crypto");
const history_rewriter_1 = require("./history-rewriter");
function tokenSet(text) {
    const tokens = String(text ?? '')
        .toLowerCase()
        .split(/[^a-z0-9\u4e00-\u9fa5]+/)
        .filter((token) => token.length > 1);
    return new Set(tokens);
}
function jaccard(left, right) {
    if (left.size === 0 || right.size === 0)
        return 0;
    let intersection = 0;
    for (const token of left)
        if (right.has(token))
            intersection += 1;
    return intersection / (left.size + right.size - intersection);
}
class ResponseCache {
    ttlMs;
    maxEntries;
    maxBytes;
    similarityThreshold;
    semanticReuse;
    entries = new Map();
    totalBytes = 0;
    hits = 0;
    misses = 0;
    semanticHits = 0;
    constructor(options = {}) {
        this.ttlMs = Math.max(1000, options.ttlMs ?? 5 * 60_000);
        this.maxEntries = Math.max(1, options.maxEntries ?? 32);
        this.maxBytes = Math.max(64_000, options.maxBytes ?? 8 * 1024 * 1024);
        this.similarityThreshold = Math.min(1, Math.max(0.5, options.similarityThreshold ?? 0.85));
        // 显式给出相似度阈值才算「主动开启」语义复用；两者都没给时默认关闭。
        this.semanticReuse = options.semanticReuse ?? options.similarityThreshold !== undefined;
    }
    keyFor(request) {
        // 采样参数必须进 key：同一个 prompt 用不同 reasoningEffort / maxTokens / temperature
        // 会得到不同的回答。原来的 key 只看 model::provider::messages，导致
        // ① 切了 effort 还在重放旧答案（调参完全无效），
        // ② 调小 maxTokens 也可能重放一段更长的缓存回答。
        // 实测踩到：配对校准里 max/high/low/off 四档拿到完全相同的结果，耗时 3ms（缓存命中）。
        const controls = `${request?.reasoningEffort ?? ''}::${request?.maxTokens ?? ''}::${request?.temperature ?? ''}::${request?.stop ?? ''}`;
        const raw = `${request?.model ?? ''}::${request?.provider ?? ''}::${controls}::${(0, history_rewriter_1.messagesCacheKey)(request?.messages, request?.tools)}`;
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
    /** 语义查找：Jaccard 相似度达到阈值即返回（阈值高，避免跨任务误命中）。 */
    findSimilar(text) {
        // 语义复用默认关闭：它按「最后一条用户消息的 Jaccard 相似度」重放旧回答。
        // 两轮说的是同一句话时（典型如连续两次「继续」）相似度=1，模型根本不会被调用，
        // 用户拿到的是上一轮的回答 —— 这是降智，不是省钱。
        if (!this.semanticReuse)
            return undefined;
        const probe = tokenSet(text);
        if (probe.size === 0)
            return undefined;
        let best;
        for (const entry of this.entries.values()) {
            if (entry.expiresAt <= Date.now())
                continue;
            const score = jaccard(probe, entry.tokens);
            if (score >= this.similarityThreshold && (!best || score > best.score))
                best = { entry, score };
        }
        if (!best)
            return undefined;
        this.semanticHits += 1;
        return { chunks: best.entry.chunks, score: best.score };
    }
    set(key, chunks, requestText = '') {
        const bytes = JSON.stringify(chunks).length;
        if (bytes > this.maxBytes / 2)
            return;
        const existing = this.entries.get(key);
        if (existing)
            this.totalBytes -= existing.bytes;
        this.entries.set(key, {
            chunks,
            expiresAt: Date.now() + this.ttlMs,
            bytes,
            tokens: tokenSet(requestText),
        });
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
        return { hits: this.hits, misses: this.misses, semanticHits: this.semanticHits, entries: this.entries.size, bytes: this.totalBytes };
    }
}
exports.ResponseCache = ResponseCache;
function replayChunks(chunks) {
    return (async function* () {
        for (const chunk of chunks)
            yield chunk;
    })();
}
