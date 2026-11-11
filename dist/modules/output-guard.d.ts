/**
 * OutputGuard —— 输出端硬截断（v2.0）。
 *
 * 1) 累计输出超过 maxTokens 立即停止；
 * 2) 检测到 JSON 闭合（括号深度回到 0）或 Markdown 代码块闭合（```）后立即停止，
 *    避免模型继续输出“废话尾巴”；
 * 3) 截断时回调记录 output.truncated。
 */
export interface OutputGuardOptions {
    maxTokens: number;
    enabled?: boolean;
    onTruncate?: (reason: 'max_tokens' | 'json_closed' | 'code_closed') => void;
}
export declare function guardedStream(stream: AsyncIterable<any>, options: OutputGuardOptions): AsyncGenerator<any>;
