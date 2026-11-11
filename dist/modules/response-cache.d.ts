/**
 * ResponseCache —— 极简精确哈希响应缓存（v1.2）。
 *
 * 只缓存「字节级完全相同」的请求（messages + tools + model），命中时重放流式 chunk。
 * 不缓存不同请求，避免语义漂移；TTL + 容量双限制。
 */
export interface ResponseCacheOptions {
    ttlMs?: number;
    maxEntries?: number;
    maxBytes?: number;
}
export declare class ResponseCache {
    private readonly ttlMs;
    private readonly maxEntries;
    private readonly maxBytes;
    private readonly entries;
    private totalBytes;
    private hits;
    private misses;
    constructor(options?: ResponseCacheOptions);
    keyFor(request: any): string;
    get(key: string): any[] | undefined;
    set(key: string, chunks: any[]): void;
    stats(): {
        hits: number;
        misses: number;
        entries: number;
        bytes: number;
    };
}
export declare function replayChunks(chunks: any[]): AsyncGenerator<any>;
