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
const node_crypto_1 = require("node:crypto");
const MAX_EVENTS = 20;
/** 与 CacheAnchor 同一套缓存经济学：命中价 1，未命中价 30。 */
const CACHE_HIT_PRICE = 1;
const CACHE_MISS_PRICE = 30;
class SavingsLedger {
    ledgerId = (0, node_crypto_1.randomUUID)();
    revision = 0;
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
        this.revision += 1;
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
        const byModule = { ...this.byModule };
        const eventSavings = byModule.admission + byModule.extraction + byModule.dedup;
        // schema 命中缓存前缀（价格 1/30），工具输出属于新 token（价格 1）。
        const estimatedCostTokens = Math.round((byModule.schema * CACHE_HIT_PRICE) / CACHE_MISS_PRICE) + eventSavings;
        return {
            schemaVersion: 3,
            ledgerId: this.ledgerId,
            revision: this.revision,
            startedAt: new Date(this.startedAt).toISOString(),
            updatedAt: new Date(this.updatedAt).toISOString(),
            totalSavedTokens: this.total,
            byModule,
            perRequestSavings: byModule.schema,
            eventSavings,
            contextReduction: byModule.fold,
            estimatedCostTokens,
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
            `- ledgerId: ${snapshot.ledgerId} (revision ${snapshot.revision})`,
            `- started: ${snapshot.startedAt}`,
            `- prompt tokens removed: **${snapshot.totalSavedTokens}**`,
            `- 按请求累计（schema）: ${snapshot.perRequestSavings}`,
            `- 单次事件（admission/extraction/dedup）: ${snapshot.eventSavings}`,
            `- 一次性上下文缩减（fold）: ${snapshot.contextReduction}`,
            `- 缓存感知估算成本节省（miss-token 等价）: **${snapshot.estimatedCostTokens}**`,
            `- events: ${snapshot.events} | folds: ${snapshot.folds} | rejected by CacheAnchor: ${snapshot.rejectedByAnchor}`,
            '',
            '> 口径说明：totalSavedTokens 是「prompt 中少发的 token 数」，不是账单。',
            '> schema 位于缓存前缀（价格 1/30），extraction/admission/dedup 是新 token（价格 1），',
            '> estimatedCostTokens 按此加权；fold 是一次性上下文缩减，单独展示。',
            '> 消费方必须以 ledgerId 识别新账本：新 id 时必须「替换」而不是累加。',
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
