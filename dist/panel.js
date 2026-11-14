"use strict";
/**
 * 面板数据契约（host 半）。
 *
 * 这份文件只做两件事：
 *   1. 把已经写好盘的账本（savings.json）和本进程的 provider 实测账单，
 *      整理成**前端可以直接渲染**的扁平结构；
 *   2. 把一个只读 JSON 路由挂到 DSH 的 connection 上。
 *
 * 金额口径是严格公式，没有任何估算：
 *   省下的钱 = Σ(每个请求的 counterfactualCost − actualCost)
 * 其中 cost = miss×¥1/M + hit×¥0.02/M + output×¥4/M，三个 token 数全部来自
 * provider 返回的 usage，单价来自官方价目表。本文件只做加法，不重算价格。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PANEL_ROUTE = exports.PANEL_SCHEMA_VERSION = void 0;
exports.buildPanelSummary = buildPanelSummary;
exports.registerPanelRoute = registerPanelRoute;
/** provider 账单的口径版本；与 savings-ledger 的 ACCOUNTING_VERSION 同步演进。 */
exports.PANEL_SCHEMA_VERSION = 1;
const day_ledger_1 = require("./modules/day-ledger");
exports.PANEL_ROUTE = 'api/dsh-context-manager/summary';
/** 单价表（元 / 百万 token）。低峰价；高峰翻倍由调用方在 usage 侧体现。 */
const PRICE = { miss: 1, hit: 0.02, output: 4 };
const FORMULA = {
    money: '省钱 = Σ 逐请求[(省下命中 token × ¥0.02/M) + (省下未命中 token × ¥1/M) + (省下输出 token × ¥4/M)]，高峰时段该请求单价 ×2',
    tokens: '省下 prompt token = 实际发出的 − 不压缩时应发出的（provider usage 实测换算）',
    price: `成本 = miss×¥${PRICE.miss}/M + hit×¥${PRICE.hit}/M + output×¥${PRICE.output}/M`,
    note: '三个 token 分量与金额均来自 provider 返回的 usage 与官方单价，可逐项复算；不含任何估算',
};
function num(value) {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
function str(value) {
    return typeof value === 'string' ? value : '';
}
function basename(target) {
    const parts = target.split(/[\\/]/).filter((part) => part.length > 0);
    return parts.length > 0 ? parts[parts.length - 1] : '';
}
function ratio(part, whole) {
    return whole > 0 ? part / whole : 0;
}
/**
 * 账本里的 byWorkspace → 面板行。
 *
 * 每行只读三个已落盘的字段，不再做任何二次推算，保证「标签页金额之和 == 总额」。
 */
function readWorkspaces(snapshot, scopeId = null) {
    const source = snapshot?.byWorkspace;
    if (source === null || typeof source !== 'object')
        return [];
    const rows = [];
    for (const [id, raw] of Object.entries(source)) {
        // 会话作用域下只保留本会话所属工作区，其余工作区一律不出现。
        if (scopeId !== null && id !== scopeId)
            continue;
        const bucket = raw !== null && typeof raw === 'object' ? raw : {};
        const savedHitTokens = num(bucket.moneyHitTokens);
        const savedMissTokens = num(bucket.moneyMissTokens);
        const savedOutTokens = num(bucket.moneyOutTokens);
        const savedTokens = savedHitTokens + savedMissTokens;
        const savedMoney = num(bucket.moneyCny);
        const actualMoney = num(bucket.moneyActualCny);
        const path = str(bucket.workspace);
        rows.push({
            id,
            label: str(bucket.label) || basename(path) || '(unknown)',
            path,
            savedTokens,
            savedHitTokens,
            savedMissTokens,
            savedOutTokens,
            savedMoney,
            actualMoney,
            /** 省下占「省下 + 实花」的比例；两个加数都是逐轮实测累加，没有估算项。 */
            savedShare: actualMoney > 0 ? ratio(savedMoney, savedMoney + actualMoney) : null,
            turns: num(bucket.moneyTurns),
            cachedShare: ratio(savedHitTokens, savedTokens),
        });
    }
    // 金额高的排前面，标签页顺序稳定（同额时按 id，避免抖动）。
    rows.sort((left, right) => right.savedMoney - left.savedMoney || left.id.localeCompare(right.id));
    return rows;
}
/** 一天的账：来源只有账本自己落的 byDay，不做任何按比例摊派。 */
function readDayBucket(raw) {
    const bucket = raw !== null && typeof raw === 'object' ? raw : {};
    const savedTokens = num(bucket.savedTokens);
    const savedOutTokens = num(bucket.savedOutTokens);
    const savedMoney = num(bucket.savedMoney);
    const actualMoney = num(bucket.actualMoney);
    return {
        savedTokens,
        savedOutTokens,
        savedMoney,
        actualMoney,
        savedShare: actualMoney > 0 ? ratio(savedMoney, savedMoney + actualMoney) : null,
        turns: num(bucket.turns),
    };
}
function readProcessBill(bill) {
    if (bill === null || typeof bill !== 'object')
        return null;
    const requests = num(bill.requests);
    if (requests <= 0)
        return null;
    const hitTokens = num(bill.hitTokens);
    const missTokens = num(bill.missTokens);
    const actualCost = num(bill.actualCost);
    const counterfactualCost = num(bill.counterfactualCost);
    return {
        requests,
        actualCost,
        counterfactualCost,
        savedCost: Math.max(0, counterfactualCost - actualCost),
        reduction: num(bill.reduction),
        hitTokens,
        missTokens,
        outputTokens: num(bill.outputTokens),
        cacheHitRate: ratio(hitTokens, hitTokens + missTokens),
        removedTokens: num(bill.removedTokens),
        promptTokens: num(bill.promptTokens),
    };
}
/**
 * 组装面板 payload。
 *
 * 入参是**已经算好的**账本快照和账单快照（依赖由调用方注入，方便离线单测）。
 * 未知字段一律降级成 0 / 空数组，绝不让面板因为字段缺失而白屏。
 */
/** 面板只展示最近两周，避免 payload 随账本无限增长。 */
const DAY_HISTORY_LIMIT = 14;
function emptyDay(date) {
    return {
        date,
        savedTokens: 0,
        savedOutTokens: 0,
        savedMoney: 0,
        actualMoney: 0,
        savedShare: null,
        turns: 0,
        workspaces: [],
        unattributedTokens: 0,
        unattributedMoney: 0,
        unattributed: { tokens: 0, money: 0, turns: 0, savedOutTokens: 0, actualMoney: 0 },
        totals: { savedTokens: 0, savedOutTokens: 0, savedMoney: 0, actualMoney: 0, savedShare: null, turns: 0 },
    };
}
function shareOf(saved, actual) {
    const total = saved + actual;
    return total > 0 && Number.isFinite(total) ? saved / total : null;
}
/**
 * 按本地日期读日账。
 *
 * 口径与累计口径完全一致：`savedMoney` 是逐轮 `savedCost` 的加法，`savedTokens` 是
 * 逐轮 `removedPromptTokens` 的加法，`actualMoney` 是逐轮 `actualCost` 的加法。
 * 日志补齐的部分没有工作区归属，单独放进 `unattributed*`，不做任何按比例摊派。
 */
function readDays(snapshot, todayKey, scopeId = null) {
    const byDate = new Map();
    const dayOf = (date) => {
        const existing = byDate.get(date);
        if (existing)
            return existing;
        const created = emptyDay(date);
        byDate.set(date, created);
        return created;
    };
    // 限定工作区时，日总额改由该工作区自己的 byDay 求和；全局日账含「无法归属」的
    // 历史轮次，混进来就不再是「只看这个工作区」了。
    const globalDays = scopeId !== null
        ? {}
        : snapshot && typeof snapshot.byDay === 'object' && snapshot.byDay !== null
            ? snapshot.byDay
            : {};
    for (const [date, bucket] of Object.entries(globalDays)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
            continue;
        const day = dayOf(date);
        day.savedTokens = num(bucket.savedTokens);
        day.savedOutTokens = num(bucket.savedOutTokens);
        day.savedMoney = num(bucket.savedMoney);
        day.actualMoney = num(bucket.actualMoney);
        day.turns = num(bucket.turns);
    }
    // 逐工作区归集；这些行一定也计入了全局日账，所以只用于「归属」，不再累加总额。
    const buckets = snapshot && typeof snapshot.byWorkspace === 'object' && snapshot.byWorkspace !== null ? snapshot.byWorkspace : {};
    for (const [id, bucket] of Object.entries(buckets)) {
        // 限定工作区时必须过滤：否则「只看本工作区」会把别人的日账也加进来。
        if (scopeId !== null && id !== scopeId)
            continue;
        const perDay = bucket && typeof bucket.byDay === 'object' && bucket.byDay !== null ? bucket.byDay : {};
        for (const [date, dayBucket] of Object.entries(perDay)) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
                continue;
            const day = dayOf(date);
            const savedTokens = num(dayBucket.savedTokens);
            const savedMoney = num(dayBucket.savedMoney);
            if (savedTokens <= 0 && savedMoney <= 0)
                continue;
            day.workspaces.push({
                id: String(id),
                label: typeof bucket.label === 'string' && bucket.label ? bucket.label : String(id),
                path: typeof bucket.workspace === 'string' ? bucket.workspace : '',
                savedTokens,
                savedOutTokens: num(dayBucket.savedOutTokens),
                savedMoney,
                actualMoney: num(dayBucket.actualMoney),
                savedShare: shareOf(savedMoney, num(dayBucket.actualMoney)),
                turns: num(dayBucket.turns),
            });
            // 只有全局日账缺失时（旧账本），才用工作区之和兜底，保证不出现「有明细没总额」。
            if (!(date in globalDays)) {
                day.savedTokens += savedTokens;
                day.savedOutTokens += num(dayBucket.savedOutTokens);
                day.savedMoney += savedMoney;
                day.actualMoney += num(dayBucket.actualMoney);
                day.turns += num(dayBucket.turns);
            }
        }
    }
    for (const day of byDate.values()) {
        day.savedShare = shareOf(day.savedMoney, day.actualMoney);
        day.workspaces.sort((left, right) => right.savedMoney - left.savedMoney || left.label.localeCompare(right.label));
        const attributedTokens = day.workspaces.reduce((sum, row) => sum + row.savedTokens, 0);
        const attributedMoney = day.workspaces.reduce((sum, row) => sum + row.savedMoney, 0);
        day.unattributedTokens = Math.max(0, day.savedTokens - attributedTokens);
        day.unattributedMoney = Math.max(0, Math.round((day.savedMoney - attributedMoney) * 1e6) / 1e6);
        const attributedTurns = day.workspaces.reduce((sum, row) => sum + row.turns, 0);
        const attributedActual = day.workspaces.reduce((sum, row) => sum + row.actualMoney, 0);
        const attributedOut = day.workspaces.reduce((sum, row) => sum + row.savedOutTokens, 0);
        day.unattributed = {
            tokens: day.unattributedTokens,
            money: day.unattributedMoney,
            turns: Math.max(0, day.turns - attributedTurns),
            savedOutTokens: Math.max(0, day.savedOutTokens - attributedOut),
            actualMoney: Math.max(0, Math.round((day.actualMoney - attributedActual) * 1e6) / 1e6),
        };
        day.totals = {
            savedTokens: day.savedTokens,
            savedOutTokens: day.savedOutTokens,
            savedMoney: day.savedMoney,
            actualMoney: day.actualMoney,
            savedShare: day.savedShare,
            turns: day.turns,
        };
    }
    const days = [...byDate.values()].sort((left, right) => right.date.localeCompare(left.date)).slice(0, DAY_HISTORY_LIMIT);
    return { today: byDate.get(todayKey) ?? emptyDay(todayKey), days };
}
function buildPanelSummary(input) {
    const snapshot = input.snapshot ?? null;
    const sessionId = typeof input.sessionId === 'string' && input.sessionId ? input.sessionId : null;
    const mapped = sessionId ? (snapshot?.bySession?.[sessionId] ?? null) : null;
    const scopeId = typeof mapped === 'string' && mapped ? mapped : null;
    const workspaces = readWorkspaces(snapshot, sessionId ? (scopeId ?? '__none__') : null);
    let savedHitTokens = 0;
    let savedMissTokens = 0;
    let savedOutTokens = 0;
    let savedMoney = 0;
    let actualMoney = 0;
    let turns = 0;
    for (const row of workspaces) {
        savedHitTokens += row.savedHitTokens;
        savedMissTokens += row.savedMissTokens;
        savedOutTokens += row.savedOutTokens;
        savedMoney += row.savedMoney;
        actualMoney += row.actualMoney;
        turns += row.turns;
    }
    const savedTokens = savedHitTokens + savedMissTokens;
    const generatedAt = new Date(input.now ?? Date.now()).toISOString();
    const dayView = readDays(snapshot, (0, day_ledger_1.dayKeyOf)(input.now ?? Date.now()), sessionId ? (scopeId ?? '__none__') : null);
    return {
        ok: true,
        schema: exports.PANEL_SCHEMA_VERSION,
        revision: num(snapshot?.revision),
        generatedAt,
        since: str(snapshot?.startedAt) || null,
        currency: 'CNY',
        totals: { savedTokens, savedHitTokens, savedMissTokens, savedOutTokens, savedMoney, actualMoney, savedShare: actualMoney > 0 ? ratio(savedMoney, savedMoney + actualMoney) : null, turns, cachedShare: ratio(savedHitTokens, savedTokens) },
        workspaces,
        today: dayView.today,
        days: dayView.days,
        scope: {
            sessionId,
            workspaceId: scopeId,
            workspaceLabel: scopeId !== null && workspaces.length > 0 ? workspaces[0].label : null,
            resolved: scopeId !== null,
            all: sessionId === null,
        },
        process: readProcessBill(input.bill),
        formula: { ...FORMULA },
    };
}
function jsonResponse(body) {
    const text = JSON.stringify(body);
    const ResponseCtor = globalThis.Response;
    if (typeof ResponseCtor === 'function') {
        return new ResponseCtor(text, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
    // 极老的宿主没有全局 Response；退化成最小可用形状。
    return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: text };
}
/**
 * 挂只读路由。
 *
 * 面板是可选功能：connection 服务不存在、或注册抛错，都只记一条日志，
 * 绝不影响压缩主链路（这里不抛异常）。
 */
function registerPanelRoute(host, read, onError, onMount) {
    let dispose = null;
    /** 返回 null 表示这个 connection 形状不对，调用方应改用 inject 再试一次。 */
    const mount = (connection) => {
        const registry = connection?.fetch;
        if (registry === null || registry === undefined || typeof registry.register !== 'function') {
            return null;
        }
        const path = exports.PANEL_ROUTE.startsWith('/') ? exports.PANEL_ROUTE : `/${exports.PANEL_ROUTE}`;
        const handle = registry.register({
            // 宿主按绝对路径匹配：必须带前导斜杠（对照 dsh-context 的 '/api/dsh-context/detail'）。
            // 客户端用相对地址 fetch('api/...')，由浏览器补成同源绝对路径。
            path,
            methods: ['POST'],
            requestBody: 'buffered',
            /**
             * 会话标签页会把 sessionId 放进 POST body；带 sessionId 时只返回该会话所属
             * 工作区的数据（与 dsh-context 的 detail 路由同构），不带则返回全部工作区汇总。
             */
            fetch: async (request) => {
                let sessionId = null;
                try {
                    const body = await request.json();
                    if (body !== null && typeof body === 'object' && typeof body.sessionId === 'string' && body.sessionId) {
                        sessionId = body.sessionId;
                    }
                }
                catch { }
                return jsonResponse(read(sessionId));
            },
        });
        onMount?.(path);
        if (typeof handle === 'function') {
            // 契约是 `() => Promise<void>`；必须吞掉 rejection，否则卸载时会冒未处理拒绝。
            return () => {
                try {
                    const pending = handle();
                    if (pending !== null && typeof pending?.then === 'function') {
                        ;
                        pending.then(undefined, () => { });
                    }
                }
                catch { }
            };
        }
        return () => {
            try {
                handle?.dispose?.();
            }
            catch { }
        };
    };
    /** ctx.inject 的回调收到的是「带该服务的 context」，不是服务本身，必须再取一次。 */
    const serviceOf = (carrier) => carrier !== null && carrier !== undefined && typeof carrier.get === 'function'
        ? carrier.get('connection')
        : carrier;
    try {
        const existing = typeof host.get === 'function' ? host.get('connection') : undefined;
        if (existing !== null && existing !== undefined) {
            const mounted = mount(existing);
            if (mounted !== null) {
                dispose = mounted;
                return () => dispose?.();
            }
        }
        if (typeof host.inject === 'function') {
            host.inject(['connection'], (carrier) => {
                const mounted = mount(serviceOf(carrier));
                if (mounted === null)
                    onError?.('connection.fetch.register 不可用');
                else
                    dispose = mounted;
            });
            return () => dispose?.();
        }
        onError?.('connection 服务不可用');
    }
    catch (error) {
        onError?.(error instanceof Error ? error.message : String(error));
    }
    return () => { };
}
