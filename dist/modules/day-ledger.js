"use strict";
/**
 * DAY-LEDGER —— 按「本地日期」分账，给面板提供「当日」视图。
 *
 * 三个原则：
 * 1. **只做加法**。每个字段都是逐轮实测量的累加，不做任何比例摊派或反推。
 * 2. **不用本地时区猜日期**：日期键由 `dayKeyOf()` 用 `Intl` 在固定时区
 *    （默认 Asia/Shanghai）里格式化成 `YYYY-MM-DD`，跨时区/跨夏令时都不会串日。
 * 3. **补齐必须可审计**：只从 `debug.log` 的 `billing.recorded` 行补齐，
 *    因为那类行里的 `removedPromptTokens` / `avoidedOutputTokens` / `savedCost` /
 *    `actualCost` 与账本里的金额同源同口径；且只在某天「尚无记录」时补，
 *    绝不与实时记账重叠。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PANEL_TIME_ZONE = void 0;
exports.emptyDayBucket = emptyDayBucket;
exports.dayKeyOf = dayKeyOf;
exports.addToDay = addToDay;
exports.daysToRecord = daysToRecord;
exports.readDays = readDays;
exports.mergeMissingDays = mergeMissingDays;
exports.parseBillingLogAttributed = parseBillingLogAttributed;
exports.parseBillingLog = parseBillingLog;
exports.PANEL_TIME_ZONE = 'Asia/Shanghai';
function emptyDayBucket() {
    return { savedTokens: 0, savedOutTokens: 0, savedMoney: 0, actualMoney: 0, turns: 0 };
}
const dayKeyFormat = new Intl.DateTimeFormat('en-CA', {
    timeZone: exports.PANEL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});
/** 把任意时刻（毫秒或 Date）格式化成该时区下的 `YYYY-MM-DD`。 */
function dayKeyOf(at = Date.now()) {
    const date = at instanceof Date ? at : new Date(at);
    if (!Number.isFinite(date.getTime()))
        return '';
    // en-CA 的输出即 YYYY-MM-DD；再兜一层，防止运行环境给别的顺序。
    const parts = dayKeyFormat.formatToParts(date);
    const pick = (type) => parts.find((part) => part.type === type)?.value ?? '';
    const year = pick('year');
    const month = pick('month');
    const day = pick('day');
    if (year === '' || month === '' || day === '')
        return '';
    return `${year}-${month}-${day}`;
}
/** 原地累加一个 delta。非有限值一律按 0 处理，避免 NaN 污染整本账。 */
function addToDay(days, dayKey, delta) {
    if (!dayKey)
        return;
    const current = days.get(dayKey) ?? emptyDayBucket();
    const num = (value) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    };
    days.set(dayKey, {
        savedTokens: current.savedTokens + Math.round(num(delta.savedTokens)),
        savedOutTokens: current.savedOutTokens + Math.round(num(delta.savedOutTokens)),
        savedMoney: current.savedMoney + num(delta.savedMoney),
        actualMoney: current.actualMoney + num(delta.actualMoney),
        turns: current.turns + Math.round(num(delta.turns)),
    });
}
/** 序列化成 `Record<date, DayBucket>`，日期新→旧。 */
function daysToRecord(days) {
    const keys = [...days.keys()].sort((left, right) => (left < right ? 1 : left > right ? -1 : 0));
    const out = {};
    for (const key of keys) {
        const bucket = days.get(key);
        if (!bucket)
            continue;
        out[key] = {
            savedTokens: Math.round(bucket.savedTokens),
            savedOutTokens: Math.round(bucket.savedOutTokens),
            savedMoney: Math.round(bucket.savedMoney * 1e6) / 1e6,
            actualMoney: Math.round(bucket.actualMoney * 1e6) / 1e6,
            turns: Math.round(bucket.turns),
        };
    }
    return out;
}
/** 从快照里读回按日分账；返回是否读到了至少一天。 */
function readDays(target, raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return false;
    let seen = 0;
    for (const [key, value] of Object.entries(raw)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(key))
            continue;
        if (!value || typeof value !== 'object')
            continue;
        const bucket = value;
        addToDay(target, key, {
            savedTokens: bucket.savedTokens,
            savedOutTokens: bucket.savedOutTokens,
            savedMoney: bucket.savedMoney,
            actualMoney: bucket.actualMoney,
            turns: bucket.turns,
        });
        seen += 1;
    }
    return seen > 0;
}
/** 只补「尚无记录」的日期，保证补齐与实时记账永不重叠。 */
function mergeMissingDays(target, incoming) {
    let added = 0;
    for (const [key, bucket] of incoming) {
        if (target.has(key))
            continue;
        target.set(key, { ...bucket });
        added += 1;
    }
    return added;
}
/**
 * 从日志文本里解析 `billing.recorded` 行，按日期累计，并**同时**按工作区细分。
 *
 * 只认这五个字段，其余一概忽略：`removedPromptTokens`（少发的 prompt token）、
 * `avoidedOutputTokens`（省下的输出 token）、`savedCost`、`actualCost`、
 * `workspace`（该轮所属工作区 label；早期日志没有这个字段，那部分只能计入未归属）。
 *
 * 返回的两个映射是同一批数据的两种切法，行级金额完全相同，不会重复计入。
 */
function parseBillingLogAttributed(text) {
    const days = new Map();
    const byWorkspace = new Map();
    if (typeof text !== 'string' || text === '')
        return { days, byWorkspace };
    for (const line of text.split(/\r?\n/)) {
        if (line === '' || !line.includes('"billing.recorded"'))
            continue;
        let record;
        try {
            record = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (!record || record.event !== 'billing.recorded')
            continue;
        const parsed = Date.parse(String(record.ts ?? ''));
        if (!Number.isFinite(parsed))
            continue;
        const dayKey = dayKeyOf(parsed);
        if (dayKey === '')
            continue;
        const delta = {
            savedTokens: record.removedPromptTokens,
            savedOutTokens: record.avoidedOutputTokens,
            savedMoney: record.savedCost,
            actualMoney: record.actualCost,
            turns: 1,
        };
        addToDay(days, dayKey, delta);
        const label = typeof record.workspace === 'string' ? record.workspace.trim() : '';
        if (label !== '') {
            const bucketMap = byWorkspace.get(label) ?? new Map();
            addToDay(bucketMap, dayKey, delta);
            byWorkspace.set(label, bucketMap);
        }
    }
    return { days, byWorkspace };
}
function parseBillingLog(text) {
    return parseBillingLogAttributed(text).days;
}
