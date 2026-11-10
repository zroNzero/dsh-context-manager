"use strict";
/**
 * ContextIndex —— 结构化任务状态索引（“高智商”模块）。
 *
 * 观察：纯摘要（"已折叠 21 条消息"）只降 token，不提升推理；模型仍需自己从残片重建任务状态。
 * 本模块把历史压成一份确定性的任务状态卡：目标 / 已决策 / 未决问题 / 硬约束 / 下一步。
 * 折叠时用它替代裸摘要，模型拿到的是“结论态”而不是“删减版流水账”。
 *
 * 全部规则为本地正则，无模型调用（低延迟、确定性、可缓存）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildContextIndex = buildContextIndex;
exports.isEmptyIndex = isEmptyIndex;
exports.renderContextIndex = renderContextIndex;
const contracts_1 = require("../contracts");
const DECISION_RE = /(决定|结论|采用|方案|修复|迁移|改用|decided|decision|approach|conclusion)/i;
const NEXT_RE = /(下一步|接下来|待办|TODO|next step|remain|pending)/i;
const CONSTRAINT_RE = /(?:[A-Za-z]:\\[^\s"']+|TODO:\s*[^。\n]{0,60}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const ERROR_RE = /(?:Error:|Exception|FAILED|失败|报错|exit code\s*[1-9])/i;
function clip(text, limit) {
    const compact = text.replace(/\s+/g, ' ').trim();
    if (compact.length === 0)
        return '';
    const points = Array.from(compact);
    return points.length > limit ? `${points.slice(0, limit).join('')}…` : compact;
}
function collect(entries, pattern, limit, onlyRole) {
    const out = [];
    const seen = new Set();
    for (const entry of entries) {
        if (onlyRole !== undefined && entry.role !== onlyRole)
            continue;
        for (const line of entry.text.split(/\r?\n/)) {
            const trimmed = line.replace(/\s+/g, ' ').trim();
            if (trimmed.length < 4 || trimmed.length > 220)
                continue;
            if (!pattern.test(trimmed))
                continue;
            const key = trimmed.toLowerCase();
            if (seen.has(key))
                continue;
            seen.add(key);
            out.push(clip(trimmed, 100));
            if (out.length >= limit)
                return out;
        }
    }
    return out;
}
/**
 * 从历史消息提炼任务状态。用户目标取最后一条 user 消息；
 * 决策/未决/约束/下一步 各取前 N 条，保证确定性与可缓存。
 */
function buildContextIndex(entries, limit = 3) {
    const users = entries.filter((entry) => entry.role === 'user');
    const lastUser = users.length > 0 ? users[users.length - 1] : undefined;
    return {
        goal: lastUser ? clip(lastUser.text, 160) : '',
        decisions: collect(entries, DECISION_RE, limit, 'assistant'),
        open: entries
            .filter((entry) => entry.isError === true || (entry.role === 'tool' && ERROR_RE.test(entry.text)))
            .slice(-limit)
            .map((entry) => clip(entry.text, 100))
            .filter((value) => value.length > 0),
        constraints: collect(entries, CONSTRAINT_RE, limit + 1),
        next: collect(entries, NEXT_RE, limit),
    };
}
function isEmptyIndex(index) {
    return (index.goal.length === 0 &&
        index.decisions.length === 0 &&
        index.open.length === 0 &&
        index.constraints.length === 0 &&
        index.next.length === 0);
}
/** 渲染为稳定、紧凑的状态卡（同输入同输出，可用于缓存对齐）。 */
function renderContextIndex(index) {
    const lines = ['[CONTEXT_INDEX]'];
    if (index.goal)
        lines.push(`goal: ${index.goal}`);
    if (index.decisions.length > 0)
        lines.push(`decisions: ${index.decisions.join(' | ')}`);
    if (index.open.length > 0)
        lines.push(`open: ${index.open.join(' | ')}`);
    if (index.constraints.length > 0)
        lines.push(`constraints: ${index.constraints.join(' | ')}`);
    if (index.next.length > 0)
        lines.push(`next: ${index.next.join(' | ')}`);
    let text = lines.join('\n');
    if ((0, contracts_1.estimateTokens)(text) > 180) {
        text = `${Array.from(text).slice(0, 700).join('')}…`;
    }
    return text;
}
