/**
 * DedupBus —— 工具输出去重总线。
 *
 * Agent 循环里最常见的浪费之一：同一命令被重复执行（测试、构建、目录列表），
 * 输出在上下文里出现 2~N 次。这里用内容哈希识别重复，第二次起只留一行指针。
 *
 * 设计取舍：哈希基于「归一化文本」（去首尾空白 + 折叠连续空白），
 * 但只有完全一致才命中；任何差异都视为新输出，避免误删。
 */
export interface DedupEntry {
    tokens: number;
    spillPath: string | null;
    firstSeenAt: number;
}
export interface DedupHit {
    entry: DedupEntry;
    pointer: string;
}
/**
 * 内容哈希：只去掉尾部空白，正文逐字节比较。
 * 不做空白折叠 —— 避免「仅格式不同」的两次输出被误判为相同而丢信息。
 */
export declare function dedupeKey(text: string): string;
export declare class DedupBus {
    private readonly capacity;
    private readonly map;
    constructor(capacity?: number);
    get size(): number;
    lookup(key: string): DedupEntry | null;
    /** 记录一次输出；超出容量时淘汰最旧条目（LRU 近似）。 */
    remember(key: string, text: string, spillPath: string | null): DedupEntry;
    /** 命中时生成可直接放进上下文的指针（保留可回读路径，避免信息黑洞）。 */
    hit(key: string): DedupHit | null;
}
