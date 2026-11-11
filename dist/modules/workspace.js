"use strict";
/**
 * WorkspaceRef —— 会话工作区的稳定标识。
 *
 * 消费端要按工作区分账，且「同一工作区在不同会话 / 不同进程重启后必须是同一个 key」。
 * 因此 id 取规范化绝对路径的短 hash：
 * - 盘符小写、分隔符统一为反斜杠、去掉尾部斜杠；
 * - hash 输入再做小写化，避免大小写差异造成重复账本。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeWorkspacePath = normalizeWorkspacePath;
exports.workspaceRef = workspaceRef;
exports.resolveSessionWorkspace = resolveSessionWorkspace;
exports.workspaceRefFromSession = workspaceRefFromSession;
exports.shortWorkspaceLabel = shortWorkspaceLabel;
const node_crypto_1 = require("node:crypto");
const node_path_1 = __importDefault(require("node:path"));
const UNKNOWN = '(unknown)';
function normalizeWorkspacePath(input) {
    if (typeof input !== 'string')
        return '';
    let value = input.trim();
    if (value.length === 0)
        return '';
    value = value.replace(/\//g, '\\');
    value = value.replace(/^([A-Za-z]):/, (_match, drive) => `${drive.toLowerCase()}:`);
    value = value.replace(/\\+$/, '');
    return value;
}
function workspaceRef(input) {
    const normalized = normalizeWorkspacePath(String(input ?? '')) || UNKNOWN;
    const id = (0, node_crypto_1.createHash)('sha256').update(normalized.toLowerCase()).digest('hex').slice(0, 12);
    const segments = normalized.split('\\').filter((part) => part.length > 0);
    const label = segments.length > 0 ? segments[segments.length - 1] : normalized;
    return { id, path: normalized, label };
}
/** 安全读取：cordis ctx 代理对未 inject 的服务属性会抛错，必须逐项捕获。 */
function readString(getter) {
    try {
        const value = getter();
        return typeof value === 'string' && value.trim().length > 0 ? value : null;
    }
    catch {
        return null;
    }
}
/** 从会话/代理对象上尽量解析工作目录；找不到返回 null（由调用方决定 fallback）。 */
function resolveSessionWorkspace(session, agent) {
    const candidates = [
        () => session?.cwd,
        () => session?.header?.cwd,
        () => session?.meta?.cwd,
        () => session?.info?.cwd,
        () => session?.workspace,
        () => session?.workspacePath,
        () => session?.projectRoot,
        () => session?.options?.cwd,
        () => agent?.session?.header?.cwd,
        () => agent?.session?.cwd,
    ];
    for (const getter of candidates) {
        const value = readString(getter);
        if (value !== null)
            return value;
    }
    return null;
}
/** 供测试与调用方使用：由原始路径直接得到 ref。 */
function workspaceRefFromSession(session, agent) {
    const cwd = resolveSessionWorkspace(session, agent);
    return cwd === null ? null : workspaceRef(cwd);
}
/** 仅用于展示：把绝对路径截成最后两段，避免面板过宽。 */
function shortWorkspaceLabel(work) {
    if (work.label && work.label !== UNKNOWN)
        return work.label;
    return node_path_1.default.basename(work.path) || work.path;
}
