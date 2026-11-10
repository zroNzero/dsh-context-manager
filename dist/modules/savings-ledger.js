"use strict";
/**
 * SavingsLedger —— Token 节省账本（面板数据源）。
 *
 * 所有节省事件统一记账：Admission / Extraction / Dedup / Fold / Schema。
 * 运行期把快照写入 ./savings.json 与 ./savings.md，
 * 面板可以通过工具 costkiller_status 或直接查看 savings.md 获取。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SavingsLedger = void 0;
const MAX_EVENTS = 20;
class SavingsLedger {
    startedAt = Date.now();
    updatedAt = Date.now();
    byModule = {
        admission: 0,
        extraction: 0,
        dedup: 0,
        fold: 0,
        schema: 0,
    };
    eventCount = 0;
    foldCount = 0;
    rejected = 0;
    lastEvents = [];
    record(module, tokens, detail = '') {
        const value = Math.max(0, Math.round(tokens));
        if (value <= 0)
            return;
        this.byModule[module] += value;
        this.eventCount += 1;
        this.updatedAt = Date.now();
        this.lastEvents.push({ ts: new Date().toISOString(), module, tokens: value, detail });
        if (this.lastEvents.length > MAX_EVENTS)
            this.lastEvents.shift();
    }
    noteFold() {
        this.foldCount += 1;
    }
    noteRejected() {
        this.rejected += 1;
    }
    get total() {
        return Object.values(this.byModule).reduce((sum, value) => sum + value, 0);
    }
    snapshot() {
        return {
            startedAt: new Date(this.startedAt).toISOString(),
            updatedAt: new Date(this.updatedAt).toISOString(),
            totalSavedTokens: this.total,
            byModule: { ...this.byModule },
            events: this.eventCount,
            folds: this.foldCount,
            rejectedByAnchor: this.rejected,
            lastEvents: [...this.lastEvents],
        };
    }
    /** Markdown 面板：按模块汇总 + 最近事件。 */
    renderMarkdown() {
        const snapshot = this.snapshot();
        const rows = Object.keys(snapshot.byModule)
            .map((key) => `| ${key} | ${snapshot.byModule[key]} |`)
            .join('\n');
        const events = snapshot.lastEvents
            .slice(-10)
            .map((event) => `| ${event.ts} | ${event.module} | ${event.tokens} | ${event.detail} |`)
            .join('\n');
        return [
            '# Token Savings',
            '',
            `- updated: ${snapshot.updatedAt}`,
            `- started: ${snapshot.startedAt}`,
            `- total saved tokens: **${snapshot.totalSavedTokens}**`,
            `- events: ${snapshot.events} | folds: ${snapshot.folds} | rejected by CacheAnchor: ${snapshot.rejectedByAnchor}`,
            '',
            '## By module',
            '',
            '| module | tokens saved |',
            '|---|---:|',
            rows,
            '',
            '## Recent events',
            '',
            '| time | module | tokens | detail |',
            '|---|---|---:|---|',
            events || '| - | - | 0 | (no events yet) |',
            '',
        ].join('\n');
    }
}
exports.SavingsLedger = SavingsLedger;
