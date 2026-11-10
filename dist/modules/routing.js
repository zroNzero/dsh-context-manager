"use strict";
/**
 * RoutingModule —— 本地优先路由（v3.5）。
 *
 * 策略（按优先级）：
 * 1. 存在跨文件依赖 → 云端（云端上下文更完整）；
 * 2. Extraction 压降后上下文 < smallContextTokens（默认 4000）→ 强制本地；
 * 3. 极短、无推理要求的任务 → 本地；
 * 4. 其余 → 云端。
 *
 * 本地调用硬超时 5 秒；超时/连接失败一律降级云端，并写
 * `[Routing] Fallback to cloud due to timeout` 审计日志。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RoutingModule = void 0;
exports.isTrivialTask = isTrivialTask;
exports.hasCrossFileDependency = hasCrossFileDependency;
const log_1 = require("../log");
const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'qwen2.5:1.5b';
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_SMALL_CONTEXT = 4000;
/** 短任务判定：<500 字符、未出现推理关键词。 */
function isTrivialTask(text) {
    if (typeof text !== 'string')
        return false;
    const length = Array.from(text).length;
    if (length === 0 || length >= 500)
        return false;
    if (/(推理|证明|架构|设计|规划|重构|迁移|analy[sz]e deeply|prove|design|architect|refactor)/i.test(text))
        return false;
    return true;
}
/** 跨文件依赖探测：显式 import/require 多文件路径、或同时出现多个源文件引用。 */
function hasCrossFileDependency(text) {
    if (typeof text !== 'string' || text.length === 0)
        return false;
    const imports = text.match(/\b(?:import|require|from)\b[\s\S]{0,80}?['"][^'"]+['"]/g) ?? [];
    if (imports.length >= 2)
        return true;
    const sources = new Set((text.match(/\b[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java)\b/g) ?? []).map((entry) => entry.toLowerCase()));
    return sources.size >= 3;
}
class RoutingModule {
    baseUrl;
    model;
    timeoutMs;
    failureThreshold;
    cooldownMs;
    smallContextTokens;
    failures = 0;
    openUntil = 0;
    constructor(options = {}) {
        this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
        this.model = options.model ?? DEFAULT_MODEL;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.failureThreshold = options.failureThreshold ?? 3;
        this.cooldownMs = options.cooldownMs ?? 60_000;
        this.smallContextTokens = options.smallContextTokens ?? DEFAULT_SMALL_CONTEXT;
    }
    get circuitOpen() {
        return Date.now() < this.openUntil;
    }
    /** 纯策略决策（不发起网络请求），供 pre-step 记录与外部编排使用。 */
    decide(context) {
        const base = { contextTokens: context.contextTokens };
        if (context.crossFileDependency) {
            return { ...base, route: 'cloud', reason: 'cross-file-dependency' };
        }
        if (context.contextTokens >= 0 && context.contextTokens < this.smallContextTokens) {
            return { ...base, route: 'local', reason: 'small-context' };
        }
        if (isTrivialTask(context.prompt)) {
            return { ...base, route: 'local', reason: 'trivial-task' };
        }
        return { ...base, route: 'cloud', reason: 'complex-context' };
    }
    /** 决策 + 必要时尝试本地调用；失败/超时返回云端结果。 */
    async routeWithContext(context, signal) {
        const decision = this.decide(context);
        (0, log_1.logEvent)('info', 'routing.decision', {
            module: 'Routing',
            route: decision.route,
            reason: decision.reason,
            contextTokens: decision.contextTokens,
            crossFile: context.crossFileDependency,
        });
        if (decision.route === 'cloud') {
            return {
                decision,
                result: { route: 'cloud', text: '', reason: decision.reason, latencyMs: 0, degraded: false },
            };
        }
        const result = await this.attemptLocal(context.prompt, signal);
        return { decision, result };
    }
    /** 尝试本地执行；失败/超时/熔断一律 route='cloud' 且 degraded=true。 */
    async attemptLocal(prompt, signal) {
        const startedAt = Date.now();
        if (this.circuitOpen) {
            (0, log_1.logEvent)('warn', '[Routing] Fallback to cloud: circuit open', { module: 'Routing' });
            return { route: 'cloud', text: '', reason: 'circuit-open', latencyMs: 0, degraded: true };
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        const onAbort = () => controller.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            const response = await fetch(`${this.baseUrl}/api/generate`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ model: this.model, prompt, stream: false }),
                signal: controller.signal,
            });
            if (!response.ok)
                throw new Error(`http ${response.status}`);
            const payload = (await response.json());
            const text = typeof payload.response === 'string' ? payload.response : '';
            if (text.length === 0)
                throw new Error('empty response');
            this.failures = 0;
            const latencyMs = Date.now() - startedAt;
            (0, log_1.logEvent)('info', 'routing.local_ok', { module: 'Routing', latencyMs, chars: text.length });
            return { route: 'local', text, reason: 'local-hit', latencyMs, degraded: false };
        }
        catch (error) {
            const timedOut = error instanceof Error && error.name === 'AbortError';
            this.failures += 1;
            if (this.failures >= this.failureThreshold)
                this.openUntil = Date.now() + this.cooldownMs;
            const latencyMs = Date.now() - startedAt;
            if (timedOut) {
                (0, log_1.logEvent)('warn', '[Routing] Fallback to cloud due to timeout', {
                    module: 'Routing',
                    timeoutMs: this.timeoutMs,
                    failures: this.failures,
                });
            }
            else {
                (0, log_1.logEvent)('warn', '[Routing] Fallback to cloud', {
                    module: 'Routing',
                    reason: String(error),
                    failures: this.failures,
                });
            }
            return {
                route: 'cloud',
                text: '',
                reason: timedOut ? 'timeout' : String(error),
                latencyMs,
                degraded: true,
            };
        }
        finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        }
    }
}
exports.RoutingModule = RoutingModule;
