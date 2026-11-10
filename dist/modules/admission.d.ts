/**
 * AdmissionModule —— 准入指针化。
 *
 * 超大工具输出/日志不进入上下文，只留「收据 + 真实绝对路径 + 哈希」。
 * 落盘失败时 Fail-Closed：原样返回，绝不给出读不到的指针。
 */
export interface AdmissionOptions {
    maxInlineTokens: number;
    spillDir: string;
}
export interface AdmissionResult {
    text: string;
    admitted: boolean;
    spilledTo: string | null;
    tokensBefore: number;
    tokensAfter: number;
    tokensSaved: number;
}
export declare function runAdmission(text: string, options: AdmissionOptions): AdmissionResult;
