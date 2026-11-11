"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.CALIBRATION_PROMPTS = void 0;
exports.runCalibration = runCalibration;
exports.summarize = summarize;
const node_crypto_1 = require("node:crypto");
exports.CALIBRATION_PROMPTS = [
    {
        id: 'debug',
        text: [
            '这段 JS 有个边界 bug，只输出修正后的函数体，不要解释：',
            'function merge(a, b) { const out = []; let i = 0, j = 0;',
            '  while (i < a.length && j < b.length) out.push(a[i] <= b[j] ? a[i++] : b[j++]);',
            '  while (i < a.length) out.push(a[i++]);',
            '  while (j < b.length) out.push(a[j]);',
            '  return out; }',
        ].join('\n'),
    },
    {
        id: 'reason',
        text: '一个 3x3 的格子，从左下角走到右上角，每步只能向右或向上，有多少条不同路径？只给数字和一行推导。',
    },
    {
        id: 'concept',
        text: '用不超过 3 条要点说明：为什么给范围查询建 B-Tree 索引能减少 IO，而给低选择性列建索引反而更慢。',
    },
];
const textOf = (chunk) => {
    if (chunk?.type === 'reasoning-delta')
        return -1;
    return 0;
};
async function runCalibration(stream, options) {
    const samples = [];
    for (const prompt of exports.CALIBRATION_PROMPTS) {
        for (const effort of options.efforts) {
            const nonce = (0, node_crypto_1.randomUUID)().slice(0, 8);
            const started = Date.now();
            let reasoningChars = 0;
            let textChars = 0;
            let outputTokens = 0;
            try {
                const iterable = stream({
                    provider: options.provider,
                    model: options.model,
                    reasoningEffort: effort,
                    purpose: 'calibration',
                    maxTokens: options.maxTokens ?? 1200,
                    messages: [
                        {
                            role: 'user',
                            content: [
                                {
                                    type: 'text',
                                    // 加一段唯一 nonce：插件自身的精确响应缓存按 messages 建 key，
                                    // 不加的话同一 prompt 的 max/high/low/off 会命中同一条缓存，
                                    // 四档拿到完全一样的 output（实测踩到，整轮测量作废）。
                                    text: `${prompt.text}\n\n[probe ${nonce} ${prompt.id} ${effort}]`,
                                },
                            ],
                        },
                    ],
                });
                for await (const chunk of iterable) {
                    if (chunk?.type === 'reasoning-delta')
                        reasoningChars += (chunk.text ?? '').length;
                    else if (chunk?.type === 'text-delta')
                        textChars += (chunk.text ?? '').length;
                    else if (chunk?.type === 'usage')
                        outputTokens = chunk.usage?.outputTokens ?? outputTokens;
                }
            }
            catch {
                continue;
            }
            samples.push({
                promptId: prompt.id,
                effort,
                outputTokens,
                reasoningChars,
                textChars,
                ms: Date.now() - started,
            });
        }
    }
    return samples;
}
/** 汇总：每个 effort 档的平均 output token 与相对 max 的节省比例。 */
function summarize(samples) {
    const byEffort = new Map();
    for (const sample of samples) {
        const list = byEffort.get(sample.effort) ?? [];
        list.push(sample);
        byEffort.set(sample.effort, list);
    }
    const avg = (list, key) => list.length === 0 ? 0 : list.reduce((sum, item) => sum + item[key], 0) / list.length;
    const maxAvg = avg(byEffort.get('max') ?? [], 'outputTokens');
    const out = {};
    for (const [effort, list] of byEffort.entries()) {
        const avgOutput = avg(list, 'outputTokens');
        out[effort] = {
            n: list.length,
            avgOutput: Math.round(avgOutput),
            avgReasoningChars: Math.round(avg(list, 'reasoningChars')),
            savingVsMax: maxAvg > 0 ? 1 - avgOutput / maxAvg : 0,
        };
    }
    return out;
}
