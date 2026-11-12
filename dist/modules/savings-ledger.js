"use strict";
/**
 * SavingsLedger —— Token 节省账本（面板数据源，schemaVersion 5）。
 *
 * v5 新增：
 * - byModuleBefore：每个模块的「原始大小」，供面板计算每维压缩率；只加字段。
 *
 * v4 新增（向后兼容，只加字段）：
 * - byWorkspace：按会话工作区分账，workspaceId 是规范化路径的稳定短 hash；
 * - tokensBeforeTotal / tokensAfterTotal：Σ 每次请求的 prompt token（压缩前/后），
 *   供面板计算可靠比例；由于只覆盖 schema 压缩维度，标记 tokensBeforeTotalEstimated。
 *
 * 顶层字段始终等于各工作区之和；旧字段全部保留。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SavingsLedger = exports.ACCOUNTING_VERSION = void 0;
const node_crypto_1 = require("node:crypto");
const workspace_1 = require("./workspace");
const MAX_EVENTS = 20;
/**
 * 记账口径版本 2：`saved` 改为真实的 token 差（v1 曾把字符数当 token 记账，
 * 虚增约 4 倍）。面板据此丢弃旧口径的当日累计，不把两个口径加在一起。
 */
exports.ACCOUNTING_VERSION = 2;
const CACHE_HIT_PRICE = 1;
const CACHE_MISS_PRICE = 30;
const UNKNOWN_WORKSPACE = (0, workspace_1.workspaceRef)('(unknown)');
function emptyModuleRecord() {
    return { admission: 0, extraction: 0, dedup: 0, fold: 0, schema: 0 };
}
class SavingsLedger {
    ledgerId = (0, node_crypto_1.randomUUID)();
    revision = 0;
    startedAt = Date.now();
    updatedAt = Date.now();
    workspaces = new Map();
    lastEvents = [];
    rejected = 0;
    aggFor(ref) {
        let agg = this.workspaces.get(ref.id);
        if (!agg) {
            agg = {
                ref,
                byModule: emptyModuleRecord(),
                byModuleBefore: emptyModuleRecord(),
                events: 0,
                folds: 0,
                tokensBefore: 0,
                tokensAfter: 0,
                updatedAt: Date.now(),
            };
            this.workspaces.set(ref.id, agg);
        }
        return agg;
    }
    record(module, tokens, detail = '', workspace, beforeTokens) {
        const value = Math.max(0, Math.round(tokens));
        if (value <= 0)
            return;
        const before = Math.max(value, Math.round(beforeTokens ?? value));
        const ref = workspace ?? UNKNOWN_WORKSPACE;
        const agg = this.aggFor(ref);
        agg.byModule[module] += value;
        agg.byModuleBefore[module] += before;
        agg.events += 1;
        agg.updatedAt = Date.now();
        this.revision += 1;
        this.updatedAt = Date.now();
        this.lastEvents.push({ ts: new Date().toISOString(), module, tokens: value, detail, workspace: ref.label });
        if (this.lastEvents.length > MAX_EVENTS)
            this.lastEvents.shift();
    }
    /** 记录一次请求的 prompt token（压缩前/后）；只计统计，不产生“节省事件”。 */
    recordRequestTokens(workspace, beforeTokens, afterTokens) {
        const before = Math.max(0, Math.round(beforeTokens));
        const after = Math.max(0, Math.min(before, Math.round(afterTokens)));
        if (before <= 0 && after <= 0)
            return;
        const agg = this.aggFor(workspace ?? UNKNOWN_WORKSPACE);
        agg.tokensBefore += before;
        agg.tokensAfter += after;
        agg.updatedAt = Date.now();
        this.revision += 1;
        this.updatedAt = Date.now();
    }
    noteFold(workspace) {
        this.aggFor(workspace ?? UNKNOWN_WORKSPACE).folds += 1;
        this.revision += 1;
    }
    noteRejected() {
        this.rejected += 1;
        this.revision += 1;
    }
    totalSaved() {
        let total = 0;
        for (const agg of this.workspaces.values()) {
            for (const value of Object.values(agg.byModule))
                total += value;
        }
        return total;
    }
    /** 从上次运行的 savings.json 恢复累计（同一工作区跨重启延续，不再每次归零）。 */
    restore(snapshot) {
        if (!snapshot || typeof snapshot !== 'object')
            return false;
        if (Number(snapshot.schemaVersion ?? 0) < 5)
            return false;
        const byWorkspace = snapshot.byWorkspace;
        if (!byWorkspace || typeof byWorkspace !== 'object')
            return false;
        let restored = 0;
        for (const [id, raw] of Object.entries(byWorkspace)) {
            if (!raw || typeof raw !== 'object')
                continue;
            const agg = this.aggFor({ id, path: String(raw.workspace ?? `(unknown)`), label: String(raw.label ?? `(unknown)`) });
            for (const key of Object.keys(agg.byModule)) {
                agg.byModule[key] += Math.max(0, Math.round(Number(raw.byModule?.[key] ?? 0)));
                agg.byModuleBefore[key] += Math.max(0, Math.round(Number(raw.byModuleBefore?.[key] ?? 0)));
            }
            agg.events += Math.max(0, Math.round(Number(raw.events ?? 0)));
            agg.folds += Math.max(0, Math.round(Number(raw.folds ?? 0)));
            agg.tokensBefore += Math.max(0, Math.round(Number(raw.tokensBeforeTotal ?? 0)));
            agg.tokensAfter += Math.max(0, Math.round(Number(raw.tokensAfterTotal ?? 0)));
            restored += 1;
        }
        if (restored === 0)
            return false;
        if (typeof snapshot.startedAt === 'string') {
            const started = Date.parse(snapshot.startedAt);
            if (Number.isFinite(started))
                this.startedAt = started;
        }
        this.revision = Math.max(0, Math.round(Number(snapshot.revision ?? 0)));
        this.rejected = Math.max(0, Math.round(Number(snapshot.rejectedByAnchor ?? 0)));
        this.updatedAt = Date.now();
        return true;
    }
    snapshot() {
        const byWorkspace = {};
        const byModule = emptyModuleRecord();
        const byModuleBefore = emptyModuleRecord();
        let totalSavedTokens = 0;
        let events = 0;
        let folds = 0;
        let tokensBeforeTotal = 0;
        let tokensAfterTotal = 0;
        for (const [id, agg] of this.workspaces) {
            const wsTotal = Object.values(agg.byModule).reduce((sum, value) => sum + value, 0);
            const eventSavings = agg.byModule.admission + agg.byModule.extraction + agg.byModule.dedup;
            const estimatedCostTokens = Math.round((agg.byModule.schema * CACHE_HIT_PRICE) / CACHE_MISS_PRICE) + eventSavings;
            byWorkspace[id] = {
                workspace: agg.ref.path,
                label: agg.ref.label,
                totalSavedTokens: wsTotal,
                estimatedCostTokens,
                perRequestSavings: agg.byModule.schema,
                eventSavings,
                contextReduction: agg.byModule.fold,
                byModule: { ...agg.byModule },
                byModuleBefore: { ...agg.byModuleBefore },
                events: agg.events,
                folds: agg.folds,
                tokensBeforeTotal: agg.tokensBefore,
                tokensAfterTotal: agg.tokensAfter,
                updatedAt: new Date(agg.updatedAt).toISOString(),
            };
            totalSavedTokens += wsTotal;
            events += agg.events;
            folds += agg.folds;
            tokensBeforeTotal += agg.tokensBefore;
            tokensAfterTotal += agg.tokensAfter;
            for (const key of Object.keys(byModule)) {
                byModule[key] += agg.byModule[key];
                byModuleBefore[key] += agg.byModuleBefore[key];
            }
        }
        const eventSavings = byModule.admission + byModule.extraction + byModule.dedup;
        const estimatedCostTokens = Math.round((byModule.schema * CACHE_HIT_PRICE) / CACHE_MISS_PRICE) + eventSavings;
        return {
            schemaVersion: 5,
            /**
             * 记账口径版本。语义一变（例如「saved 从字符改成 token」）就必须 +1：
             * 面板按这个值判废，避免把旧口径的累计数和新口径的累加到一起。
             */
            accountingVersion: exports.ACCOUNTING_VERSION,
            ledgerId: this.ledgerId,
            revision: this.revision,
            startedAt: new Date(this.startedAt).toISOString(),
            updatedAt: new Date(this.updatedAt).toISOString(),
            totalSavedTokens,
            byModule,
            byModuleBefore,
            perRequestSavings: byModule.schema,
            eventSavings,
            contextReduction: byModule.fold,
            estimatedCostTokens,
            tokensBeforeTotal,
            tokensAfterTotal,
            tokensBeforeTotalEstimated: true,
            byWorkspace,
            events,
            folds,
            rejectedByAnchor: this.rejected,
            lastEvents: [...this.lastEvents],
        };
    }
    /** Markdown 面板：按模块汇总 + 按工作区 + 最近事件。 */
    renderMarkdown() {
        const snapshot = this.snapshot();
        const moduleRows = Object.keys(snapshot.byModule)
            .map((key) => {
            const saved = snapshot.byModule[key];
            const before = snapshot.byModuleBefore[key];
            const rate = before > 0 ? `${((saved / before) * 100).toFixed(1)}%` : '-';
            return `| ${key} | ${saved} | ${before} | ${rate} |`;
        })
            .join('\n');
        const workspaceRows = Object.values(snapshot.byWorkspace)
            .map((workspace) => `| ${workspace.label} | ${workspace.totalSavedTokens} | ${workspace.estimatedCostTokens} | ${workspace.events} |`)
            .join('\n');
        const events = snapshot.lastEvents
            .slice(-10)
            .map((event) => `| ${event.ts} | ${event.workspace ?? '-'} | ${event.module} | ${event.tokens} | ${event.detail} |`)
            .join('\n');
        const raito = snapshot.tokensBeforeTotal > 0
            ? `${((1 - snapshot.tokensAfterTotal / snapshot.tokensBeforeTotal) * 100).toFixed(2)}%`
            : 'n/a';
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
            `- tokens before/after: ${snapshot.tokensBeforeTotal} / ${snapshot.tokensAfterTotal}（压缩比 ${raito}，估算）`,
            `- events: ${snapshot.events} | folds: ${snapshot.folds} | rejected by CacheAnchor: ${snapshot.rejectedByAnchor}`,
            '',
            '> 口径说明：totalSavedTokens 是「prompt 中少发的 token 数」，不是账单。',
            '> schema 位于缓存前缀（价格 1/30），extraction/admission/dedup 是新 token（价格 1）。',
            '> 消费方必须以 ledgerId 识别新账本：新 id 时必须「替换」而不是累加。',
            '',
            '## By module',
            '',
            '| module | tokens saved | before | rate |',
            '|---|---:|---:|---:|',
            moduleRows,
            '',
            '## By workspace',
            '',
            '| workspace | prompt tokens removed | est. cost | events |',
            '|---|---:|---:|---:|',
            workspaceRows || '| - | 0 | 0 | 0 |',
            '',
            '## Recent events',
            '',
            '| time | workspace | module | tokens | detail |',
            '|---|---|---|---:|---|',
            events || '| - | - | - | 0 | (no events yet) |',
            '',
        ].join('\n');
    }
}
exports.SavingsLedger = SavingsLedger;
