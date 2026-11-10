"use strict";
/**
 * AdmissionModule —— 准入指针化。
 *
 * 超大工具输出/日志不进入上下文，只留「收据 + 真实绝对路径 + 哈希」。
 * 落盘失败时 Fail-Closed：原样返回，绝不给出读不到的指针。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runAdmission = runAdmission;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const contracts_1 = require("../contracts");
const log_1 = require("../log");
const spill_gc_1 = require("./spill-gc");
function runAdmission(text, options) {
    const tokensBefore = (0, contracts_1.estimateTokens)(text);
    const base = {
        text,
        admitted: false,
        spilledTo: null,
        tokensBefore,
        tokensAfter: tokensBefore,
        tokensSaved: 0,
    };
    if (tokensBefore <= options.maxInlineTokens || text.length === 0)
        return base;
    const digest = (0, contracts_1.hashText)(text);
    const fileName = `${digest.slice(0, 16)}-${Array.from(text).length}.txt`;
    const target = node_path_1.default.resolve(options.spillDir, fileName);
    try {
        node_fs_1.default.mkdirSync(node_path_1.default.dirname(target), { recursive: true });
        node_fs_1.default.writeFileSync(target, text, 'utf8');
        (0, spill_gc_1.pinSpill)(target);
    }
    catch (error) {
        (0, log_1.logEvent)('warn', 'admission.spill_failed', {
            module: 'Admission',
            error: error instanceof Error ? error.message : String(error),
        });
        return base;
    }
    const lines = text.split('\n').length;
    const receipt = `[ADMISSION] 原始输出 ${Array.from(text).length} 字符 / ~${tokensBefore} tokens 未进入上下文。` +
        `完整内容已落盘：${target}（sha256=${digest.slice(0, 16)}…, ${lines} 行）。` +
        `需要细节请使用 read 工具读取该路径；不要重复请求同一内容。`;
    const tokensAfter = (0, contracts_1.estimateTokens)(receipt);
    const result = {
        text: receipt,
        admitted: true,
        spilledTo: target,
        tokensBefore,
        tokensAfter,
        tokensSaved: Math.max(0, tokensBefore - tokensAfter),
    };
    (0, log_1.logEvent)('info', 'admission.spilled', {
        module: 'Admission',
        file: target,
        tokensBefore,
        tokensAfter,
        tokensSaved: result.tokensSaved,
        hash: digest.slice(0, 16),
    });
    return result;
}
