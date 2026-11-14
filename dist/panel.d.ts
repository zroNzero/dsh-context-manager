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
/** provider 账单的口径版本；与 savings-ledger 的 ACCOUNTING_VERSION 同步演进。 */
export declare const PANEL_SCHEMA_VERSION = 1;
export declare const PANEL_ROUTE = "api/dsh-context-manager/summary";
export interface PanelWorkspaceRow {
    id: string;
    label: string;
    path: string;
    /** 实测节省 token = savedHitTokens + savedMissTokens（来自 provider usage）。 */
    savedTokens: number;
    savedHitTokens: number;
    savedMissTokens: number;
    /** 省下的输出 token（effort 降档的反事实输出量）；金额的第三个分量。 */
    savedOutTokens: number;
    /** 按官方单价折算的金额（CNY）。 */
    savedMoney: number;
    /** 逐轮累计的真实花费（CNY），与 savedMoney 同源同口径。 */
    actualMoney: number;
    /** savedMoney / (savedMoney + actualMoney)，0–1。 */
    savedShare: number | null;
    turns: number;
    /** 省下的 token 里命中缓存的比例；越高说明省的越「便宜」。 */
    cachedShare: number;
}
export interface PanelProcessBill {
    requests: number;
    actualCost: number;
    counterfactualCost: number;
    savedCost: number;
    reduction: number;
    hitTokens: number;
    missTokens: number;
    outputTokens: number;
    cacheHitRate: number;
    removedTokens: number;
    promptTokens: number;
}
export interface PanelDayRow {
    id: string;
    label: string;
    path: string;
    savedTokens: number;
    savedOutTokens: number;
    savedMoney: number;
    actualMoney: number;
    savedShare: number | null;
    turns: number;
}
export interface PanelDay {
    /** 本地日期 YYYY-MM-DD。 */
    date: string;
    savedTokens: number;
    savedOutTokens: number;
    savedMoney: number;
    actualMoney: number;
    savedShare: number | null;
    turns: number;
    /** 按工作区拆分的当日数据；日志补齐的部分没有归属，不在其中。 */
    workspaces: PanelDayRow[];
    /** 无法归属到工作区的当日省下 token / 金额（来自日志补齐），显式暴露而不是摊派。 */
    unattributedTokens: number;
    unattributedMoney: number;
    /** 上面两项 + 轮次的合并形式，供 UI 直接消费。 */
    unattributed: {
        tokens: number;
        money: number;
        turns: number;
    };
    /** 当日合计，字段与工作区行一致，便于 UI 用同一条渲染路径。 */
    totals: {
        savedTokens: number;
        savedOutTokens: number;
        savedMoney: number;
        actualMoney: number;
        savedShare: number | null;
        turns: number;
    };
}
export interface PanelSummary {
    ok: true;
    schema: number;
    revision: number;
    generatedAt: string;
    /** 账本开始计时的时间；null 表示账本还没写过。 */
    since: string | null;
    currency: 'CNY';
    totals: {
        savedTokens: number;
        savedHitTokens: number;
        savedMissTokens: number;
        savedOutTokens: number;
        savedMoney: number;
        actualMoney: number;
        savedShare: number | null;
        turns: number;
        cachedShare: number;
    };
    /** 当日（本地时区）汇总；字段口径与 totals 一致，只是范围限定在今天。 */
    today: PanelDay;
    /** 最近若干天的按日汇总，新→旧。 */
    days: PanelDay[];
    /** 按工作区分账，金额降序；面板的每个标签页对应一行。 */
    workspaces: PanelWorkspaceRow[];
    /** 本进程 provider 实测账单；没有记录时为 null。 */
    process: PanelProcessBill | null;
    formula: {
        money: string;
        tokens: string;
        price: string;
        note: string;
    };
}
export declare function buildPanelSummary(input: {
    snapshot?: any;
    bill?: any;
    now?: number;
}): PanelSummary;
export interface PanelRouteHost {
    get?: (name: string) => any;
    inject?: (deps: string[], fn: (connection: any) => unknown) => unknown;
}
/**
 * 挂只读路由。
 *
 * 面板是可选功能：connection 服务不存在、或注册抛错，都只记一条日志，
 * 绝不影响压缩主链路（这里不抛异常）。
 */
export declare function registerPanelRoute(host: PanelRouteHost, read: () => PanelSummary, onError?: (message: string) => void, onMount?: (path: string) => void): () => void;
