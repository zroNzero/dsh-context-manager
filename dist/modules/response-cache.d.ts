/**
 * ResponseCache —— 精确哈希 + 轻量语义相似响应缓存（v1.3）。
 *
 * - 精确命中：model + messages + tools 字节级一致；
 * - 语义命中：对请求文本做小写/标点归一化后取关键词集合，Jaccard ≥ 阈值即命中。
 *   不使用向量模型，零额外延迟。
 * TTL + 容量双限制；命中时重放流式 chunk。
 */
export interface SemanticHit {
    chunks: any[];
    score: number;
}
export interface ResponseCacheOptions {
    ttlMs?: number;
    maxEntries?: number;
    maxBytes?: number;
    /** Jaccard 阈值，默认 0.85。 */
    similarityThreshold?: number;
    /** 是否允许相似度复用；未显式给出阈值时默认 false（不降智）。 */
    semanticReuse?: boolean;
}
export declare class ResponseCache {
    private readonly ttlMs;
    private readonly maxEntries;
    private readonly maxBytes;
    private readonly similarityThreshold;
    private readonly semanticReuse;
    private readonly entries;
    private totalBytes;
    private hits;
    private misses;
    private semanticHits;
    constructor(options?: ResponseCacheOptions);
    keyFor(request: any): string;
    get(key: string): any[] | undefined;
    /** 语义查找：Jaccard 相似度达到阈值即返回（阈值高，避免跨任务误命中）。 */
    findSimilar(text: string): SemanticHit | undefined;
    set(key: string, chunks: any[], requestText?: string): void;
    stats(): {
        hits: number;
        misses: number;
        semanticHits: number;
        entries: number;
        bytes: number;
    };
}
export declare function replayChunks(chunks: any[]): AsyncGenerator<any>;
