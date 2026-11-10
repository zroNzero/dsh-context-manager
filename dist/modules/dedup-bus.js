"use strict";
/**
 * DedupBus —— 工具输出去重总线。
 *
 * Agent 循环里最常见的浪费之一：同一命令被重复执行（测试、构建、目录列表），
 * 输出在上下文里出现 2~N 次。这里用内容哈希识别重复，第二次起只留一行指针。
 *
 * 设计取舍：哈希基于「归一化文本」（去首尾空白 + 折叠连续空白），
 * 但只有完全一致才命中；任何差异都视为新输出，避免误删。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DedupBus = void 0;
exports.dedupeKey = dedupeKey;
const node_crypto_1 = require("node:crypto");
/**
 * 内容哈希：只去掉尾部空白，正文逐字节比较。
 * 不做空白折叠 —— 避免「仅格式不同」的两次输出被误判为相同而丢信息。
 */
function dedupeKey(text) {
    const exact = text.replace(/\s+$/, '');
    return (0, node_crypto_1.createHash)('sha256').update(exact, 'utf8').digest('hex');
}
function estimate(text) {
    return Math.ceil(Array.from(text).length / 4);
}
class DedupBus {
    capacity;
    map = new Map();
    constructor(capacity = 256) {
        this.capacity = capacity;
    }
    get size() {
        return this.map.size;
    }
    lookup(key) {
        const entry = this.map.get(key);
        return entry ?? null;
    }
    /** 记录一次输出；超出容量时淘汰最旧条目（LRU 近似）。 */
    remember(key, text, spillPath) {
        const entry = { tokens: estimate(text), spillPath, firstSeenAt: Date.now() };
        this.map.set(key, entry);
        if (this.map.size > this.capacity) {
            const oldest = this.map.keys().next().value;
            if (typeof oldest === 'string')
                this.map.delete(oldest);
        }
        return entry;
    }
    /** 命中时生成可直接放进上下文的指针（保留可回读路径，避免信息黑洞）。 */
    hit(key) {
        const entry = this.lookup(key);
        if (!entry)
            return null;
        const pointer = `[DEDUP] 本轮工具输出与之前完全一致（约 ${entry.tokens} tokens），已省略重复内容。` +
            (entry.spillPath ? `完整原文见落盘路径：${entry.spillPath}` : '完整内容已在本会话更早的上下文中。');
        return { entry, pointer };
    }
}
exports.DedupBus = DedupBus;
