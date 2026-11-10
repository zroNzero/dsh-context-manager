"use strict";
/**
 * 统一日志出口。
 * 红线：全工程禁止 console.log；一切关键状态、缓存拦截、净收益决策都经此处
 * 追加写入 ./debug.log（JSON Lines，便于机器检索）。
 *
 * 生产保护：日志超过 MAX_LOG_BYTES 时轮转为 debug.log.1（只保留一代），
 * 避免长期运行把磁盘写满；轮转失败不影响主链路。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logEvent = logEvent;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const LOG_FILE = node_path_1.default.resolve(process.cwd(), 'debug.log');
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const ROTATE_CHECK_EVERY = 50;
let writes = 0;
function rotateIfNeeded() {
    writes += 1;
    if (writes % ROTATE_CHECK_EVERY !== 0)
        return;
    try {
        const stat = node_fs_1.default.statSync(LOG_FILE);
        if (stat.size > MAX_LOG_BYTES)
            node_fs_1.default.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
    catch {
        /* 文件不存在或轮转失败：忽略 */
    }
}
function sanitize(value) {
    if (value === undefined)
        return undefined;
    if (value === null)
        return null;
    if (typeof value === 'bigint')
        return value.toString();
    if (typeof value === 'function')
        return `[function ${value.name || 'anonymous'}]`;
    if (Array.isArray(value))
        return value.map(sanitize);
    if (typeof value === 'object') {
        const out = {};
        for (const [key, entry] of Object.entries(value)) {
            const clean = sanitize(entry);
            if (clean !== undefined)
                out[key] = clean;
        }
        return out;
    }
    return value;
}
function logEvent(level, event, detail) {
    const payload = {
        ts: new Date().toISOString(),
        level,
        event,
    };
    if (detail !== undefined) {
        const clean = sanitize(detail);
        if (clean && typeof clean === 'object')
            Object.assign(payload, clean);
    }
    try {
        node_fs_1.default.appendFileSync(LOG_FILE, `${JSON.stringify(payload)}\n`, 'utf8');
        rotateIfNeeded();
    }
    catch {
        /* 日志失败绝不能影响主链路 */
    }
}
