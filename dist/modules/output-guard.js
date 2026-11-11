"use strict";
/**
 * OutputGuard —— 输出端硬截断（v2.0）。
 *
 * 1) 累计输出超过 maxTokens 立即停止；
 * 2) 检测到 JSON 闭合（括号深度回到 0）或 Markdown 代码块闭合（```）后立即停止，
 *    避免模型继续输出“废话尾巴”；
 * 3) 截断时回调记录 output.truncated。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.guardedStream = guardedStream;
function chunkText(chunk) {
    if (typeof chunk === 'string')
        return chunk;
    if (typeof chunk?.text === 'string')
        return chunk.text;
    if (typeof chunk?.delta?.text === 'string')
        return chunk.delta.text;
    if (typeof chunk?.content === 'string')
        return chunk.content;
    return '';
}
async function* guardedStream(stream, options) {
    if (options.enabled === false) {
        yield* stream;
        return;
    }
    const maxChars = Math.max(200, Math.floor(options.maxTokens * 4));
    let text = '';
    let braces = 0;
    let sawBrace = false;
    let fences = 0;
    for await (const chunk of stream) {
        text += chunkText(chunk);
        const trimmed = text.trimStart();
        if (!sawBrace && (trimmed.startsWith('{') || trimmed.startsWith('[')))
            sawBrace = true;
        if (sawBrace) {
            for (const char of chunkText(chunk)) {
                if (char === '{' || char === '[')
                    braces += 1;
                else if (char === '}' || char === ']')
                    braces -= 1;
            }
        }
        fences = (text.match(/```/g) ?? []).length;
        yield chunk;
        if (sawBrace && braces <= 0 && text.trim().length > 8) {
            options.onTruncate?.('json_closed');
            return;
        }
        if (fences >= 2) {
            options.onTruncate?.('code_closed');
            return;
        }
        if (text.length >= maxChars) {
            options.onTruncate?.('max_tokens');
            return;
        }
    }
}
