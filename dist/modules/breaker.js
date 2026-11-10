"use strict";
/**
 * CompressionBreaker —— 压缩模块自己的熔断器。
 *
 * 灵感来源：NousResearch/hermes-agent 的 circuit breaker with compression model judgment。
 * 目的：避免压缩器连续产出无效结果（失败 / 零收益 / Fail-Closed）时继续消耗算力，
 * 或陷入“压缩 → 失败 → 再压缩”的死循环。
 *
 * 规则：
 * - 连续 failureThreshold（默认 3）次失败/零收益 → open；
 * - open 期间跳过压缩，cooldownMs（默认 10 分钟）后进入半开，允许一次试探；
 * - 任何一次成功立即 closed。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CompressionBreaker = void 0;
const log_1 = require("../log");
class CompressionBreaker {
    threshold;
    cooldownMs;
    name;
    failures = 0;
    openedAt = 0;
    halfOpenUsed = false;
    constructor(options = {}) {
        this.threshold = options.failureThreshold ?? 3;
        this.cooldownMs = options.cooldownMs ?? 10 * 60_000;
        this.name = options.name ?? 'compression';
    }
    get state() {
        if (this.openedAt === 0)
            return 'closed';
        if (Date.now() - this.openedAt < this.cooldownMs)
            return 'open';
        return this.halfOpenUsed ? 'open' : 'half-open';
    }
    /** 是否允许本次压缩。半开状态只放行一次试探。 */
    canRun() {
        const state = this.state;
        if (state === 'closed')
            return true;
        if (state === 'half-open') {
            this.halfOpenUsed = true;
            (0, log_1.logEvent)('info', '[Breaker] half-open trial', { module: 'Breaker', name: this.name });
            return true;
        }
        return false;
    }
    recordSuccess() {
        if (this.failures > 0 || this.openedAt > 0) {
            (0, log_1.logEvent)('info', '[Breaker] closed', { module: 'Breaker', name: this.name, previousFailures: this.failures });
        }
        this.failures = 0;
        this.openedAt = 0;
        this.halfOpenUsed = false;
    }
    recordFailure(reason) {
        this.failures += 1;
        if (this.failures >= this.threshold) {
            this.openedAt = Date.now();
            this.halfOpenUsed = false;
            (0, log_1.logEvent)('warn', '[Breaker] open', {
                module: 'Breaker',
                name: this.name,
                reason,
                failures: this.failures,
                cooldownMs: this.cooldownMs,
            });
            return;
        }
        (0, log_1.logEvent)('info', '[Breaker] failure recorded', {
            module: 'Breaker',
            name: this.name,
            reason,
            failures: this.failures,
            threshold: this.threshold,
        });
    }
    snapshot() {
        const state = this.state;
        return {
            name: this.name,
            state,
            failures: this.failures,
            openedAt: this.openedAt,
            cooldownRemainingMs: state === 'open' ? Math.max(0, this.cooldownMs - (Date.now() - this.openedAt)) : 0,
        };
    }
}
exports.CompressionBreaker = CompressionBreaker;
