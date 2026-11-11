"use strict";
/**
 * ToolPipe —— 工具结果数据平面（v2.0 正式版）。
 *
 * 工具输出落盘后只传引用（pipe-xxxxxxxx），模型可通过 read_ref 元工具按需取回。
 * ref 索引写入 `<spillDir>/.pipe-index.json`，跨进程可用。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolPipe = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = require("node:crypto");
class ToolPipe {
    spillDir;
    indexPath;
    entries = new Map();
    constructor(spillDir) {
        this.spillDir = node_path_1.default.resolve(spillDir);
        this.indexPath = node_path_1.default.join(this.spillDir, '.pipe-index.json');
        this.load();
    }
    load() {
        try {
            const raw = JSON.parse(node_fs_1.default.readFileSync(this.indexPath, 'utf8'));
            for (const entry of raw)
                if (entry?.ref)
                    this.entries.set(entry.ref, entry);
        }
        catch {
            /* 首次运行没有索引 */
        }
    }
    persist() {
        try {
            node_fs_1.default.mkdirSync(this.spillDir, { recursive: true });
            node_fs_1.default.writeFileSync(this.indexPath, JSON.stringify([...this.entries.values()].slice(-200)), 'utf8');
        }
        catch {
            /* 索引写失败不影响主链路 */
        }
    }
    refForFile(filePath) {
        return `pipe-${(0, node_crypto_1.createHash)('sha256').update(node_path_1.default.basename(filePath)).digest('hex').slice(0, 12)}`;
    }
    publishFile(filePath) {
        const ref = this.refForFile(filePath);
        let bytes = 0;
        try {
            bytes = node_fs_1.default.statSync(filePath).size;
        }
        catch {
            bytes = 0;
        }
        this.entries.set(ref, { ref, file: node_path_1.default.resolve(filePath), bytes, createdAt: new Date().toISOString() });
        this.persist();
        return { ref, bytes };
    }
    resolve(ref) {
        const entry = this.entries.get(ref);
        if (!entry)
            return { ok: false, text: `unknown ref: ${ref}`, bytes: 0 };
        try {
            const text = node_fs_1.default.readFileSync(entry.file, 'utf8');
            return { ok: true, text, bytes: Buffer.byteLength(text) };
        }
        catch (error) {
            return { ok: false, text: `ref unreadable: ${String(error)}`, bytes: 0 };
        }
    }
    size() {
        return this.entries.size;
    }
}
exports.ToolPipe = ToolPipe;
