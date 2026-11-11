"use strict";
/**
 * HistoryRewriter —— 请求级历史重写（v1.2 主杠杆）。
 *
 * 在发往模型的 request.messages 层面做内存折叠，**不修改本地 session surface**：
 * - 旧 tool 结果：只保留头/尾与错误行 + 重跑提示；
 * - 旧 assistant 文本：剥离 CoT、截断到上限；
 * - user / system / 最近 N 条：原样保留（约束优先）。
 *
 * 安全边界：不删除、不重排消息，只改 content —— tool-call 与 tool-result 的配对
 * 结构完全不变，因此不会复现 surface 折叠那种孤儿 tool/call 事故。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.rewriteMessages = rewriteMessages;
exports.messagesCacheKey = messagesCacheKey;
const contracts_1 = require("../contracts");
function textOf(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content
        .map((block) => (typeof block?.text === 'string' ? block.text : ''))
        .filter((part) => part.length > 0)
        .join('\n');
}
function estimateMessages(messages) {
    let total = 0;
    for (const message of messages)
        total += (0, contracts_1.estimateTokens)(textOf(message?.content));
    return total;
}
const THOUGHT_RE = /<(thought|thinking)>[\s\S]*?<\/\1>|\[思考\][\s\S]*?(?=\n|$)/g;
function compactText(text, maxChars) {
    const cleaned = text.replace(THOUGHT_RE, '').trim();
    if (cleaned.length <= maxChars)
        return cleaned;
    return `${cleaned.slice(0, maxChars)}\n[CTX compacted by dsh-context-manager]`;
}
function compactToolText(text, head, tail, maxChars) {
    const lines = text.split(/\r?\n/);
    if (lines.length <= head + tail + 2 && text.length <= maxChars)
        return text;
    const signals = lines.filter((line) => /\b(error|exception|failed|denied|exit code|timeout|fatal)\b/i.test(line)).slice(0, 5);
    const body = [
        ...lines.slice(0, head),
        ...(signals.length > 0 ? ['--- errors ---', ...signals] : []),
        ...(lines.length > head + tail ? [`... (${lines.length - head - tail} lines omitted) ...`] : []),
        ...lines.slice(-tail),
    ].join('\n');
    const note = `[CTX] tool output compacted (${lines.length} lines, ~${(0, contracts_1.estimateTokens)(text)} tokens); re-run tool or read spill if details needed.`;
    const combined = `${note}\n${body}`;
    if (combined.length <= maxChars)
        return combined;
    return `${combined.slice(0, maxChars)}\n[CTX truncated]`;
}
function rewriteMessages(messages, options = {}) {
    const retainRecent = Math.max(0, options.retainRecent ?? 8);
    const toolHeadLines = Math.max(1, options.toolHeadLines ?? 4);
    const toolTailLines = Math.max(1, options.toolTailLines ?? 3);
    const assistantChars = Math.max(80, options.assistantChars ?? 400);
    const toolChars = Math.max(200, options.toolChars ?? 700);
    const minMessages = Math.max(1, options.minMessages ?? 6);
    if (!Array.isArray(messages) || messages.length <= Math.max(minMessages, retainRecent + 2)) {
        const tokens = estimateMessages(Array.isArray(messages) ? messages : []);
        return { messages, beforeTokens: tokens, afterTokens: tokens, saved: 0, rewritten: 0 };
    }
    const beforeTokens = estimateMessages(messages);
    const boundary = messages.length - retainRecent;
    let rewritten = 0;
    const next = messages.map((message, index) => {
        if (index >= boundary)
            return message;
        const role = message?.role;
        if (role !== 'tool' && role !== 'assistant')
            return message;
        // thinking 模式：assistant 的 reasoning 块必须原样回传，重写等于删掉它，
        // DeepSeek 会直接报 `content[].thinking ... must be passed back`。
        if (role === 'assistant' &&
            Array.isArray(message?.content) &&
            message.content.some((block) => block?.type === 'reasoning' || block?.type === 'thinking')) {
            return message;
        }
        const original = textOf(message?.content);
        if (original.length === 0)
            return message;
        const compacted = role === 'tool'
            ? compactToolText(original, toolHeadLines, toolTailLines, toolChars)
            : compactText(original, assistantChars);
        if (compacted === original || compacted.length >= original.length)
            return message;
        rewritten += 1;
        return { ...message, content: [{ type: 'text', text: compacted }] };
    });
    const afterTokens = estimateMessages(next);
    return {
        messages: next,
        beforeTokens,
        afterTokens,
        saved: Math.max(0, beforeTokens - afterTokens),
        rewritten,
    };
}
/** 仅用于缓存键：把消息内容压成稳定的字符串。 */
function messagesCacheKey(messages, tools) {
    const parts = [];
    for (const message of messages ?? []) {
        parts.push(`${message?.role ?? ''}:${textOf(message?.content)}`);
    }
    return `${parts.join('|')}::${JSON.stringify(tools ?? [])}`;
}
