"use strict";
/**
 * SpillGc —— 落盘目录治理（TTL + 上限 + 指针钉住）。
 *
 * 规则：
 * - 被 pin 的文件（仍被回执/上下文引用）永不删除；
 * - 超过 ttlMs（默认 24h）的文件删除；
 * - 文件总数超过 maxFiles（默认 50）时，按 mtime 从旧到新删到上限；
 * - 刚写入 minAgeMs（默认 10 分钟）内的文件不参与回收，避免误删正在使用的文件。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.pinSpill = pinSpill;
exports.pinnedSpills = pinnedSpills;
exports.collectGarbage = collectGarbage;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const pins = new Map();
/** 钉住一个落盘文件（默认 30 分钟内不回收）。 */
function pinSpill(file, ttlMs = 30 * 60_000) {
    try {
        pins.set(node_path_1.default.resolve(file), Date.now() + ttlMs);
    }
    catch {
        /* ignore */
    }
}
/** 当前有效的钉住集合。 */
function pinnedSpills(now = Date.now()) {
    const out = [];
    for (const [file, expiry] of [...pins.entries()]) {
        if (expiry > now)
            out.push(file);
        else
            pins.delete(file);
    }
    return out;
}
function collectGarbage(options) {
    const dir = node_path_1.default.resolve(options.dir);
    const maxFiles = options.maxFiles ?? 50;
    const ttlMs = options.ttlMs ?? 24 * 60 * 60_000;
    const minAgeMs = options.minAgeMs ?? 10 * 60_000;
    const pinned = new Set([...pinnedSpills(), ...(options.pinned ?? []).map((file) => node_path_1.default.resolve(file))]);
    const result = { dir, scanned: 0, deleted: [], kept: 0, pinnedSkipped: 0, freedBytes: 0 };
    let names;
    try {
        names = node_fs_1.default.readdirSync(dir);
    }
    catch {
        return result;
    }
    const now = Date.now();
    const entries = [];
    for (const name of names) {
        if (!name.endsWith('.txt'))
            continue;
        const file = node_path_1.default.join(dir, name);
        try {
            const stat = node_fs_1.default.statSync(file);
            if (!stat.isFile())
                continue;
            entries.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
        }
        catch {
            /* ignore */
        }
    }
    result.scanned = entries.length;
    const deletable = [];
    for (const entry of entries) {
        if (pinned.has(entry.file)) {
            result.pinnedSkipped += 1;
            continue;
        }
        const age = now - entry.mtimeMs;
        if (age < minAgeMs)
            continue;
        if (age > ttlMs) {
            deletable.push(entry);
            continue;
        }
        deletable.push(entry);
    }
    // 先删过期（age > ttl），再按数量从旧到新删。
    const expired = deletable.filter((entry) => now - entry.mtimeMs > ttlMs);
    const survivors = entries.filter((entry) => !expired.includes(entry));
    const toDelete = new Set(expired);
    const afterExpired = survivors.length;
    if (afterExpired > maxFiles) {
        const sorted = [...survivors]
            .filter((entry) => !pinned.has(entry.file) && now - entry.mtimeMs >= minAgeMs)
            .sort((a, b) => a.mtimeMs - b.mtimeMs);
        let remaining = afterExpired;
        for (const entry of sorted) {
            if (remaining <= maxFiles)
                break;
            toDelete.add(entry);
            remaining -= 1;
        }
    }
    for (const entry of toDelete) {
        try {
            node_fs_1.default.unlinkSync(entry.file);
            result.deleted.push(entry.file);
            result.freedBytes += entry.size;
        }
        catch {
            /* ignore */
        }
    }
    result.kept = entries.length - result.deleted.length;
    return result;
}
