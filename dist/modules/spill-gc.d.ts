/**
 * SpillGc —— 落盘目录治理（TTL + 上限 + 指针钉住）。
 *
 * 规则：
 * - 被 pin 的文件（仍被回执/上下文引用）永不删除；
 * - 超过 ttlMs（默认 24h）的文件删除；
 * - 文件总数超过 maxFiles（默认 50）时，按 mtime 从旧到新删到上限；
 * - 刚写入 minAgeMs（默认 10 分钟）内的文件不参与回收，避免误删正在使用的文件。
 */
export interface SpillGcOptions {
    dir: string;
    maxFiles?: number;
    ttlMs?: number;
    minAgeMs?: number;
    /** 额外钉住的绝对路径（调用方已知的活跃指针）。 */
    pinned?: readonly string[];
}
export interface SpillGcResult {
    dir: string;
    scanned: number;
    deleted: string[];
    kept: number;
    pinnedSkipped: number;
    freedBytes: number;
}
/** 钉住一个落盘文件（默认 30 分钟内不回收）。 */
export declare function pinSpill(file: string, ttlMs?: number): void;
/** 当前有效的钉住集合。 */
export declare function pinnedSpills(now?: number): string[];
export declare function collectGarbage(options: SpillGcOptions): SpillGcResult;
