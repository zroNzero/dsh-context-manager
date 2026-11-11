/**
 * CALIBRATION —— 配对测量 reasoning effort 的真实折算率。
 *
 * 目的：把「reasoning effort 能省多少」从区间猜测变成实测数字。
 * 做法：同一条 prompt 分别用 max / high / low / off 各跑一次，比较
 * provider 真实回传的 output token 与 reasoning 字符数。
 *
 * 触发方式：状态目录下存在 `calibrate.flag` 时在 apply 后跑一次并删掉该文件
 * （避免为了一次性测量去改 profile 配置或环境变量）。
 *
 * 红线：这是测量仪器，不是生产路径 ——
 * - 用 purpose='calibration'，不走 effort 策略、不进真实账本；
 * - 失败一律吞掉，绝不影响宿主启动。
 */
export interface CalibrationSample {
    promptId: string;
    effort: string;
    outputTokens: number;
    reasoningChars: number;
    textChars: number;
    ms: number;
}
export declare const CALIBRATION_PROMPTS: Array<{
    id: string;
    text: string;
}>;
export declare function runCalibration(stream: (options: any) => AsyncIterable<any>, options: {
    provider: string;
    model: string;
    efforts: string[];
    maxTokens?: number;
}): Promise<CalibrationSample[]>;
/** 汇总：每个 effort 档的平均 output token 与相对 max 的节省比例。 */
export declare function summarize(samples: CalibrationSample[]): Record<string, {
    n: number;
    avgOutput: number;
    avgReasoningChars: number;
    savingVsMax: number;
}>;
