"use strict";
/**
 * OSIRIS —— 前缀缓存感知的状态密封（v2.0 正式版）。
 *
 * 三套哈希分别锚定 system / tools / history：
 * - systemHash：system prompt 段（通常稳定，漂移即关键变更）；
 * - toolsHash：工具集（动态选择时用它检测漂移）；
 * - historyHash：历史消息（按 retainRecent 截断后的稳定前缀）。
 *
 * 结合意图桶（bucket）实现「会话内工具集稳定」：同一 bucket 复用上一轮工具集，
 * 避免 Tool Attention 每轮换工具导致前缀缓存击穿。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.shortHash = shortHash;
exports.sealState = sealState;
exports.intentBucket = intentBucket;
const node_crypto_1 = require("node:crypto");
const contracts_1 = require("../contracts");
function shortHash(value) {
    return (0, node_crypto_1.createHash)('sha256').update(value).digest('hex').slice(0, 16);
}
function systemText(messages) {
    return (messages ?? [])
        .filter((message) => message?.role === 'system')
        .map((message) => {
        const content = message?.content;
        if (typeof content === 'string')
            return content;
        return Array.isArray(content) ? content.map((block) => block?.text ?? '').join('\n') : '';
    })
        .join('\n');
}
function historyText(messages, keepRecent) {
    const tail = (messages ?? []).slice(-Math.max(1, keepRecent));
    return tail
        .map((message) => {
        const content = message?.content;
        if (typeof content === 'string')
            return `${message?.role}:${content}`;
        if (!Array.isArray(content))
            return `${message?.role}:`;
        return `${message?.role}:${content.map((block) => block?.text ?? block?.type ?? '').join('\u0001')}`;
    })
        .join('\u0002');
}
function sealState(input) {
    const keep = Math.max(1, input.keepRecent ?? 8);
    return {
        systemHash: shortHash(systemText(input.messages)),
        toolsHash: shortHash((input.tools ?? []).map((tool) => tool?.name ?? '').join(',')),
        historyHash: shortHash(historyText(input.messages, keep)),
        bucket: input.bucket,
        toolsTokens: (0, contracts_1.estimateTokens)(JSON.stringify(input.tools ?? [])),
        historyTokens: (0, contracts_1.estimateTokens)(historyText(input.messages, keep)),
    };
}
/** 意图桶：取查询词的稳定集合，避免同义改写导致桶抖动。 */
function intentBucket(prompt, depth = 6) {
    const tokens = String(prompt ?? '')
        .toLowerCase()
        .split(/[^a-z0-9\u4e00-\u9fa5]+/)
        .filter((token) => token.length > 1);
    const unique = [...new Set(tokens)].slice(0, depth).sort();
    return shortHash(unique.join('|'));
}
