"use strict";
/**
 * SchemaIndex —— 工具 Schema 瘦身（MCP Tool Tax 治理）。
 *
 * 灵感来源：
 * - mcp-context-proxy / Bifrost-MCP-Gateway：MCP schema 每轮重复注入是截距大头；
 * - PenguinHarness《先压低上下文斜率》：同一会话内工具集必须固定，中途增删会让
 *   前缀缓存整体失效。
 *
 * 因此本模块**不做**每轮动态挑选工具（那会破坏 CacheAnchor 的前缀对齐红线），
 * 而是做确定性的描述压缩：工具名、参数结构、required 全部保留（能力无损），
 * 只把冗长的 description 截断到 maxDescriptionChars。同一请求输入永远得到同一输出，
 * 前缀哈希稳定，缓存不受影响。
 *
 * 可选的 selectStableToolSet 仅作为实验开关：按首轮意图固定一个子集，
 * 并在会话内保持稳定；默认关闭，避免模型在后续轮次需要被裁掉的工具。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.compressToolSchemas = compressToolSchemas;
exports.selectStableToolSet = selectStableToolSet;
exports.installSchemaCompressor = installSchemaCompressor;
exports.schemaTokens = schemaTokens;
const contracts_1 = require("../contracts");
const log_1 = require("../log");
const billing_js_1 = require("./billing.js");
const response_cache_1 = require("./response-cache");
const tool_attention_1 = require("./tool-attention");
const scope_1 = require("./scope");
const osiris_1 = require("./osiris");
const output_guard_1 = require("./output-guard");
function truncateText(value, maxChars) {
    const points = Array.from(value);
    if (points.length <= maxChars)
        return value;
    return `${points.slice(0, maxChars).join('')}…`;
}
function walk(value, maxChars, stats) {
    if (typeof value === 'string')
        return value;
    if (Array.isArray(value))
        return value.map((entry) => walk(entry, maxChars, stats));
    if (!value || typeof value !== 'object')
        return value;
    const record = value;
    const out = {};
    for (const [key, entry] of Object.entries(record)) {
        if (key === 'description' && typeof entry === 'string') {
            const truncated = truncateText(entry, maxChars);
            if (truncated !== entry) {
                stats.changed += 1;
                stats.removed += Array.from(entry).length - Array.from(truncated).length;
            }
            out[key] = truncated;
            continue;
        }
        out[key] = walk(entry, maxChars, stats);
    }
    return out;
}
/**
 * 确定性描述压缩：只截断 description 字段，其它 schema 内容原样保留。
 * 同样的 tools 输入永远得到同样的输出（可安全用于前缀缓存）。
 */
function compressToolSchemas(tools, maxDescriptionChars = 120) {
    const before = JSON.stringify(tools);
    const stats = { changed: 0, removed: 0 };
    const compressed = tools.map((tool) => walk(tool, maxDescriptionChars, stats));
    const after = JSON.stringify(compressed);
    const charsBefore = Array.from(before).length;
    const charsAfter = Array.from(after).length;
    return {
        tools: compressed,
        stats: {
            changed: stats.changed,
            charsBefore,
            charsAfter,
            tokensSaved: Math.max(0, Math.ceil(charsBefore / 4) - Math.ceil(charsAfter / 4)),
        },
    };
}
function lastUserText(messages) {
    if (!Array.isArray(messages))
        return '';
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'user' && message?.message?.role !== 'user')
            continue;
        const content = message?.content ?? message?.message?.content;
        if (typeof content === 'string')
            return content;
        if (Array.isArray(content)) {
            return content.map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('');
        }
    }
    return '';
}
/** 极简意图关键词表：用于实验性工具子集选择（默认不启用）。 */
const INTENT_KEYWORDS = {
    read: /(分析|查看|读取|排查|定位|源码|文件|describe|read|inspect)/i,
    mutate: /(修改|修复|实现|重构|写入|删除|edit|write|fix|refactor)/i,
    run: /(运行|执行|测试|build|test|run|execute)/i,
};
/**
 * 实验特性：按首轮意图固定一个稳定工具子集（会话内不再变化）。
 * 默认关闭 —— 中途增删工具会破坏前缀缓存，且后续轮次可能缺工具。
 */
function selectStableToolSet(tools, prompt, options = {}) {
    const topK = options.topK ?? 12;
    const alwaysKeep = new Set(options.alwaysKeep ?? ['read', 'bash', 'pwsh', 'write', 'edit', 'todo_write']);
    if (tools.length <= topK)
        return { tools: [...tools], hidden: [] };
    const wanted = new Set();
    for (const [tag, pattern] of Object.entries(INTENT_KEYWORDS)) {
        if (pattern.test(prompt))
            wanted.add(tag);
    }
    const scored = tools.map((tool) => {
        const name = String(tool.name ?? '');
        const description = String(tool.description ?? '');
        let score = alwaysKeep.has(name) ? 100 : 0;
        if (wanted.has('read') && /(read|grep|glob|search|list|view)/i.test(name))
            score += 10;
        if (wanted.has('mutate') && /(write|edit|apply|patch|delete|move|rename)/i.test(name))
            score += 10;
        if (wanted.has('run') && /(bash|sh|run|exec|test)/i.test(name))
            score += 10;
        if (prompt.length > 0 && (name.length > 0 && prompt.toLowerCase().includes(name.toLowerCase())))
            score += 5;
        score += Math.min(5, description.length / 200);
        return { tool, score, name };
    });
    scored.sort((a, b) => b.score - a.score);
    const kept = scored.slice(0, topK);
    const keptNames = new Set(kept.map((entry) => entry.name));
    return {
        tools: kept.map((entry) => entry.tool),
        hidden: tools.filter((tool) => !keptNames.has(String(tool.name ?? ''))).map((tool) => String(tool.name ?? '')),
    };
}
/** 模型可见载荷的字符数（system + messages + tools），用于真实账本的字符比校准。 */
function payloadChars(request) {
    if (!request)
        return 0;
    const system = typeof request.system === 'string' ? request.system.length : 0;
    let messages = 0;
    let tools = 0;
    try {
        messages = Array.isArray(request.messages) ? JSON.stringify(request.messages).length : 0;
    }
    catch {
        messages = 0;
    }
    try {
        tools = Array.isArray(request.tools) ? JSON.stringify(request.tools).length : 0;
    }
    catch {
        tools = 0;
    }
    return system + messages + tools;
}
/** 粗略估算消息侧 token（4 字符/token），用于面板比例的分母。 */
function estimateMessagesTokens(messages) {
    if (!Array.isArray(messages))
        return 0;
    let chars = 0;
    for (const message of messages) {
        const content = message?.content;
        if (typeof content === 'string') {
            chars += content.length;
            continue;
        }
        if (!Array.isArray(content))
            continue;
        for (const block of content) {
            if (typeof block?.text === 'string')
                chars += block.text.length;
        }
    }
    return Math.ceil(chars / 4);
}
/** 第二层：签名（参数名 + 类型，不含嵌套 schema/描述细节）。 */
function signatureTool(tool) {
    const parameters = tool.parameters ?? {};
    const properties = parameters.properties ?? {};
    const signatureProperties = {};
    for (const [key, value] of Object.entries(properties)) {
        signatureProperties[key] = { type: value?.type ?? 'any' };
    }
    return {
        ...tool,
        description: (0, tool_attention_1.firstSentence)(tool.description ?? '', 60),
        parameters: { type: 'object', properties: signatureProperties, required: parameters.required ?? [] },
    };
}
/**
 * 包装 llm.stream / prepareCall：在请求发往适配器前压缩工具描述。
 * 失败安全：任何异常原样放行。
 */
function installSchemaCompressor(ctx, options = {}) {
    const enabled = options.enabled !== false;
    const maxChars = options.maxDescriptionChars ?? 120;
    const selectionEnabled = options.selectionEnabled === true;
    const topK = options.topK ?? 12;
    let llm;
    try {
        llm = ctx?.llm ?? ctx?.get?.('llm');
    }
    catch {
        llm = undefined;
    }
    if (!enabled)
        return () => { };
    if (!llm || typeof llm.stream !== 'function') {
        (0, log_1.logEvent)('warn', 'schema.unavailable', { module: 'SchemaIndex', reason: 'llm service not ready' });
        return () => { };
    }
    /**
     * 热重载防护：宿主对已加载的插件做 in-place 重新应用时**不会** dispose 旧 fiber
     * （实测 12:23 / 12:26 两次重载之间没有任何 apply.dispose），于是每重载一次就在
     * llm.stream 外面多套一层。旧层会先拦截请求（自带缓存/旧策略），新层的修复形同虚设。
     *
     * 用 globalThis 上的单例记录上一个安装：跨模块实例也能生效，先拆掉旧的再装新的。
     * 注意顺序 —— 必须先把旧层恢复成真正的原始 stream，再捕获 originalStream，
     * 否则会捕获到旧层的包装函数，等于又叠一层。
     */
    const registry = globalThis;
    try {
        const previous = registry.__costKillerStreamInstall;
        if (previous && previous.llm === llm) {
            previous.dispose();
            (0, log_1.logEvent)('info', 'schema.replaced', { module: 'SchemaIndex', reason: 'in-place reload; previous layer removed' });
        }
    }
    catch {
        /* 拆旧层失败不影响重新安装 */
    }
    let lastLogKey = '';
    let lastBudgetKey = '';
    const anchors = new Map();
    const lastSeals = new Map();
    const transform = (request) => {
        try {
            if (!request)
                return request;
            const sessionKey = String(request.sessionId ?? 'unknown');
            const rawMessagesTokens = estimateMessagesTokens(request.messages);
            const toolsTokensBefore = Math.ceil(JSON.stringify(request.tools ?? []).length / 4);
            const totalTokens = rawMessagesTokens + toolsTokensBefore;
            const budget = (0, scope_1.planBudget)(totalTokens, toolsTokensBefore);
            const budgetKey = `${sessionKey}:${Math.floor(totalTokens / 2000)}`;
            if (budgetKey !== lastBudgetKey) {
                lastBudgetKey = budgetKey;
                (0, log_1.logEvent)('info', 'scope.budget', { module: 'SCOPE', sessionId: sessionKey, ...budget });
            }
            const rewrite = options.rewriteHistory?.(request.messages) ?? null;
            let messages = rewrite?.messages ?? request.messages;
            const rewriteSaved = rewrite?.saved ?? 0;
            const rewriteBeforeTokens = rewrite?.beforeTokens ?? rawMessagesTokens;
            const bucketPrompt = lastUserText(messages) ?? '';
            const bucket = (0, osiris_1.intentBucket)(bucketPrompt);
            let attendedTools = null;
            let selection = null;
            if (options.toolAttention?.enabled && Array.isArray(request.tools) && request.tools.length > 1) {
                const previous = anchors.get(sessionKey);
                if (previous && previous.bucket === bucket) {
                    selection = (0, tool_attention_1.selectionFromNames)(request.tools, previous.names);
                    if (selection) {
                        (0, log_1.logEvent)('info', 'osiris.anchor', {
                            module: 'OSIRIS',
                            sessionId: sessionKey,
                            bucket: previous.bucket,
                            tools: previous.names.length,
                            reused: true,
                        });
                    }
                }
                if (!selection) {
                    selection = (0, tool_attention_1.selectToolsScout)(request.tools, bucketPrompt, options.toolAttention.topK ?? 5);
                    anchors.set(sessionKey, { bucket, names: selection.selected.map((tool) => tool.name) });
                    (0, log_1.logEvent)('info', 'scout.route', {
                        module: 'SCOUT',
                        sessionId: sessionKey,
                        bucket,
                        total: request.tools.length,
                        selected: selection.selected.length,
                        top: selection.scoreboard.slice(0, 5),
                    });
                }
                if (selection.hidden.length > 0) {
                    const selectedNames = selection.selected.map((tool) => tool.name).filter((name) => name !== 'search_tools');
                    const fullNames = selectedNames.slice(0, 3);
                    const signatureNames = selectedNames.slice(3, 10);
                    const byName = new Map(request.tools.map((tool) => [tool.name, tool]));
                    const fullTools = fullNames.map((name) => byName.get(name)).filter((tool) => tool !== undefined);
                    const signatureTools = signatureNames
                        .map((name) => byName.get(name))
                        .filter((tool) => tool !== undefined)
                        .map(signatureTool);
                    const included = new Set([...fullNames, ...signatureNames, 'search_tools']);
                    const hiddenTools = request.tools.filter((tool) => !included.has(tool.name));
                    const catalog = hiddenTools.map((tool) => `- ${tool.name}: ${(0, tool_attention_1.firstSentence)(tool.description ?? '')}`);
                    const layered = [...fullTools, ...signatureTools, tool_attention_1.SEARCH_TOOLS_DEF];
                    messages = (0, tool_attention_1.withCatalog)(messages, [
                        ...catalog,
                        '[TOOL_NOT_LOADED] 未列出的工具必须先调用 search_tools 拉取完整 schema；直接调用会收到 TOOL_NOT_LOADED 提示。',
                    ]);
                    options.onToolCatalog?.(request.tools);
                    attendedTools = layered;
                    (0, log_1.logEvent)('info', 'tool_attention.layered', {
                        module: 'ToolAttention',
                        total: request.tools.length,
                        full: fullTools.length,
                        signature: signatureTools.length,
                        hidden: hiddenTools.length,
                        fullTools: fullNames,
                    });
                }
            }
            const seal = (0, osiris_1.sealState)({
                messages,
                tools: attendedTools ?? request.tools ?? [],
                bucket,
                keepRecent: budget.retainRecent,
            });
            const sealKey = `${seal.systemHash}|${seal.toolsHash}|${seal.historyHash}`;
            const previousSeal = lastSeals.get(sessionKey);
            if (sealKey !== previousSeal) {
                lastSeals.set(sessionKey, sealKey);
                (0, log_1.logEvent)('info', 'osiris.seal', {
                    module: 'OSIRIS',
                    sessionId: sessionKey,
                    ...seal,
                    changed: previousSeal !== undefined,
                });
            }
            const messagesTokens = estimateMessagesTokens(messages);
            if (!Array.isArray(request.tools) || request.tools.length === 0) {
                options.onRequest?.({
                    sessionId: String(request.sessionId ?? ''),
                    beforeTokens: rewriteBeforeTokens,
                    afterTokens: messagesTokens,
                    savedTokens: 0,
                    toolsBeforeTokens: 0,
                    toolsAfterTokens: 0,
                    rewriteSaved,
                    rewriteBeforeTokens,
                    rewriteAfterTokens: messagesTokens,
                });
                return rewrite ? { ...request, messages } : request;
            }
            const toolsBeforeChars = JSON.stringify(request.tools).length;
            // 工具目录始终回填，保证 search_tools 在任何模式下都可查（懒加载关闭时尤其重要）。
            if (Array.isArray(request.tools) && request.tools.length > 0) {
                options.onToolCatalog?.(request.tools);
            }
            let tools = (attendedTools ?? request.tools);
            let hidden = [];
            if (selectionEnabled) {
                const selected = selectStableToolSet(tools, lastUserText(request.messages), { topK });
                tools = selected.tools;
                hidden = selected.hidden;
            }
            const compressed = compressToolSchemas(tools, maxChars);
            const toolsBeforeTokens = Math.ceil(toolsBeforeChars / 4);
            const toolsAfterTokens = Math.ceil(JSON.stringify(compressed.tools).length / 4);
            options.onRequest?.({
                sessionId: String(request.sessionId ?? ''),
                beforeTokens: rewriteBeforeTokens + toolsBeforeTokens,
                afterTokens: messagesTokens + toolsAfterTokens,
                savedTokens: compressed.stats.tokensSaved,
                toolsBeforeTokens,
                toolsAfterTokens,
                rewriteSaved,
                rewriteBeforeTokens,
                rewriteAfterTokens: messagesTokens,
            });
            if (compressed.stats.changed === 0 && hidden.length === 0)
                return request;
            options.onSavings?.(compressed.stats.tokensSaved);
            const logKey = `${request.sessionId ?? 'unknown'}:${compressed.stats.charsAfter}:${hidden.length}`;
            if (logKey !== lastLogKey) {
                lastLogKey = logKey;
                (0, log_1.logEvent)('info', 'schema.compressed', {
                    module: 'SchemaIndex',
                    sessionId: request.sessionId ?? 'unknown',
                    tools: compressed.tools.length,
                    hidden: hidden.length,
                    changedDescriptions: compressed.stats.changed,
                    tokensSaved: compressed.stats.tokensSaved,
                    charsBefore: compressed.stats.charsBefore,
                    charsAfter: compressed.stats.charsAfter,
                });
            }
            return { ...request, messages, tools: compressed.tools };
        }
        catch (error) {
            (0, log_1.logEvent)('warn', 'schema.compress_failed', { error: String(error) });
            return request;
        }
    };
    const originalStream = llm.stream;
    const originalPrepare = llm.prepareCall;
    // -------------------------------------------------------------------------
    // TTL Keepalive（武器 30）
    //
    // provider 的 prompt 缓存约 4 分钟过期。用户读完回答再回来，通常已经超过这个窗口，
    // 于是下一轮第一个请求必然整段 miss（¥1/M），而它本来可以按 hit（¥0.02/M）计费。
    //
    // 做法：在缓存过期之前，用**完全相同**的 system/tools/messages 再发一次（maxTokens=1），
    // 把缓存条目续上。代价是那次重放按 hit 价计费（约 miss 的 1/50），收益是下一轮的首请求
    // 不再全价。策略上限：最多续 `refreshes` 次，实时请求一发出就取消（缓存已被真正刷新）。
    //
    // 红线：
    // - 绝不继承原请求的 AbortSignal（回合结束后 signal 已 abort，会让保活立刻失败）；
    // - 绝不改写内容（prefix 必须逐字节一致，否则续的是另一个缓存条目，纯烧钱）；
    // - 保活失败/超时对主链路零影响。
    // -------------------------------------------------------------------------
    const keepaliveCfg = options.keepalive;
    // 按 session 分开：主 Agent 与多个 subagent 是不同上下文，共用一个槽位会互相顶掉，
    // 保活就只对「最后一个说话的人」生效。同时限制总的会话数，避免一堆 subagent 各自烧保活费。
    const keepaliveSlots = new Map();
    /** 每个会话连续保活失败次数；达到阈值就停掉该会话的保活。 */
    const keepaliveFailures = new Map();
    // provider �?cacheReadTokens 是会话累计值（已用宿主日志交叉验证：usage chunk 的原始值
    // 与日志里的累计列完全一致），所有记�?阈值都必须用差分。
    const cacheRead = new billing_js_1.CacheReadNormalizer();
    const maxKeepaliveSessions = Math.max(1, Math.trunc(keepaliveCfg?.maxSessions ?? 3));
    let disposed = false;
    const cancelSlot = (slot) => {
        if (slot?.timer) {
            clearTimeout(slot.timer);
            slot.timer = null;
        }
    };
    const cancelKeepalive = (key) => {
        if (key === undefined) {
            for (const slot of keepaliveSlots.values())
                cancelSlot(slot);
            keepaliveSlots.clear();
            return;
        }
        cancelSlot(keepaliveSlots.get(key));
        keepaliveSlots.delete(key);
    };
    const armKeepalive = (key, invoke, optimized, promptTokens) => {
        if (disposed || !keepaliveCfg?.enabled)
            return;
        const slot = keepaliveSlots.get(key);
        if (!slot)
            return;
        if (promptTokens < (keepaliveCfg.minPromptTokens ?? 500) || slot.remaining <= 0) {
            cancelKeepalive(key);
            return;
        }
        slot.invoke = invoke;
        slot.request = optimized;
        slot.promptTokens = promptTokens;
        const ttl = keepaliveCfg.ttlMs ?? 240_000;
        const delay = Math.max(keepaliveCfg.minDelayMs ?? 5_000, Math.floor(ttl * (keepaliveCfg.marginRatio ?? 0.5)));
        cancelSlot(slot);
        slot.timer = setTimeout(() => {
            slot.timer = null;
            void runKeepalive(key);
        }, delay);
        const timer = slot.timer;
        if (typeof timer.unref === 'function')
            timer.unref();
    };
    const runKeepalive = async (key) => {
        const slot = keepaliveSlots.get(key);
        if (disposed || !slot || slot.remaining <= 0)
            return;
        slot.remaining -= 1;
        const { invoke, request: optimized } = slot;
        let promptTokens = slot.promptTokens;
        try {
            // maxTokens 由各自路径自己决定：direct 直接改 options，prepared 重新 prepare 一个
            // maxTokens=1 的调用（不能改已冻结的 config）。所以这里只带 purpose。
            const body = { ...optimized, purpose: 'cache-keepalive' };
            delete body.signal;
            delete body.maxTokens;
            delete body.reasoningEffort;
            const stream = await invoke(body);
            if (!stream || typeof stream[Symbol.asyncIterator] !== 'function')
                return;
            let cached = 0;
            let fresh = 0;
            for await (const chunk of stream) {
                if (chunk?.type !== 'usage' || !chunk.usage)
                    continue;
                cached = cacheRead.normalize(String(optimized?.sessionId ?? 'default'), chunk.usage.cacheReadTokens ?? 0);
                fresh = Math.max(0, chunk.usage.inputTokens ?? 0);
                promptTokens = cached + fresh;
                // 保活本身就是真实支出，必须进账本（压缩前后字符相同 -> 零削减，只计成本）。
                if (options.onUsage) {
                    try {
                        options.onUsage({
                            purpose: 'cache-keepalive',
                            model: String(optimized?.model ?? ''),
                            usage: { ...chunk.usage, cacheReadTokens: cached },
                            beforeChars: 0,
                            afterChars: 0,
                        });
                    }
                    catch {
                        /* 记账失败不影响保活 */
                    }
                }
            }
            (0, log_1.logEvent)('info', 'cache.keepalive_refresh', {
                module: 'Keepalive',
                sessionId: optimized?.sessionId ?? 'unknown',
                promptTokens,
                cachedTokens: cached,
                freshTokens: fresh,
                remaining: slot.remaining,
            });
        }
        catch (error) {
            // 保活是尽力而为：连续失败两次就对这个会话关掉，避免一直烧钱和刷日志。
            const failures = (keepaliveFailures.get(key) ?? 0) + 1;
            keepaliveFailures.set(key, failures);
            (0, log_1.logEvent)('warn', 'cache.keepalive_failed', {
                module: 'Keepalive',
                sessionId: optimized?.sessionId ?? 'unknown',
                attempts: failures,
                error: String(error),
                stack: error instanceof Error ? String(error.stack ?? '').slice(0, 400) : undefined,
            });
            if (failures >= 2) {
                keepaliveFailures.delete(key);
                cancelKeepalive(key);
                (0, log_1.logEvent)('warn', 'cache.keepalive_disabled', {
                    module: 'Keepalive',
                    sessionId: optimized?.sessionId ?? 'unknown',
                    reason: 'repeated failures',
                });
            }
            return;
        }
        armKeepalive(key, invoke, optimized, promptTokens);
    };
    const observeUsage = (chunk, optimized, beforeChars, afterChars, invoke) => {
        if (chunk?.type !== 'usage' || !chunk.usage)
            return;
        const isKeepalive = optimized?.purpose === 'cache-keepalive';
        const hitDelta = cacheRead.normalize(String(optimized?.sessionId ?? 'default'), chunk.usage.cacheReadTokens ?? 0);
        if (!isKeepalive && keepaliveCfg?.enabled) {
            // 真实请求发出去了：它自己会刷新缓存，先撤掉这个会话挂起的保活。
            const key = String(optimized?.sessionId ?? 'default');
            const existing = keepaliveSlots.get(key);
            if (existing)
                cancelSlot(existing);
            if (existing || keepaliveSlots.size < maxKeepaliveSessions) {
                keepaliveSlots.set(key, {
                    timer: null,
                    remaining: Math.max(0, Math.trunc(keepaliveCfg.refreshes ?? 4)),
                    invoke,
                    request: optimized,
                    promptTokens: 0,
                });
                const promptTokens = (chunk.usage.inputTokens ?? 0) + hitDelta;
                armKeepalive(key, invoke, optimized, promptTokens);
            }
        }
        if (!options.onUsage)
            return;
        try {
            options.onUsage({
                purpose: String(optimized?.purpose ?? 'agent-loop'),
                model: String(optimized?.model ?? ''),
                usage: { ...chunk.usage, cacheReadTokens: hitDelta },
                beforeChars,
                afterChars,
                effort: !isKeepalive ? options.effortContext?.()?.effort : undefined,
                baselineEffort: !isKeepalive ? options.effortContext?.()?.baseline : undefined,
            });
        }
        catch (error) {
            (0, log_1.logEvent)('warn', 'billing.usage_failed', { module: 'Billing', error: String(error) });
        }
    };
    /** 在透传 chunk 的同时把 provider usage 交给真实账本；不改动流本身。 */
    const invokeMeasured = (invoke, optimized, beforeChars, afterChars, keepaliveInvoke) => {
        const source = invoke(optimized);
        if (!source || typeof source[Symbol.asyncIterator] !== 'function')
            return source;
        const kaInvoke = keepaliveInvoke ?? ((body) => invoke({ ...body, maxTokens: 1 }));
        return (async function* () {
            for await (const chunk of source) {
                observeUsage(chunk, optimized, beforeChars, afterChars, kaInvoke);
                yield chunk;
            }
        })();
    };
    const runOptimized = (invoke, request, prepared) => {
        /**
         * 保活必须**自己开一次调用**，绝不能复用 prepared 的 stream：
         * `prepared.stream` 是单次可派发的句柄，第二次派发会抛
         * `LlmError: a prepared LLM call can only be dispatched once`（实盘踩到过）。
         * 这里走宿主原始的 `llm.stream`，由宿主自己 prepare + dispatch，语义上等价于一次
         * 手搓调用，也不受我们那次 prepared 的冻结配置约束。
         */
        const kaInvoke = (body) => originalStream.call(llm, { ...body, maxTokens: 1 });
        const beforeChars = payloadChars(request);
        const transformed = transform(request);
        // 动态 reasoning effort：prepared 路径必须在 prepareCall 前修正（见 prepareCallConfig），
        // 这里只对 direct stream 生效；否则会触发 INVALID_PREPARED_CALL。
        let optimized = transformed;
        const effort = options.resolveEffort?.(transformed);
        if (!prepared && effort && effort.effort && effort.effort !== transformed?.reasoningEffort) {
            optimized = { ...transformed, reasoningEffort: effort.effort };
        }
        const afterChars = payloadChars(optimized);
        const cache = options.responseCache;
        if (!cache)
            return invokeMeasured(invoke, optimized, beforeChars, afterChars, kaInvoke);
        let key;
        try {
            key = cache.keyFor(optimized);
        }
        catch {
            return invokeMeasured(invoke, optimized, beforeChars, afterChars, kaInvoke);
        }
        const hit = cache.get(key);
        if (hit) {
            options.onCacheHit?.();
            return (0, response_cache_1.replayChunks)(hit);
        }
        const semanticText = `${optimized?.model ?? ''} ${lastUserText(optimized?.messages) ?? ''} ${(optimized?.tools ?? [])
            .map((tool) => tool?.name ?? '')
            .join(' ')}`;
        const similar = cache.findSimilar(semanticText);
        if (similar) {
            options.onSemanticHit?.(similar.score);
            return (0, response_cache_1.replayChunks)(similar.chunks);
        }
        const source = invoke(optimized);
        const stream = options.outputGuard
            ? (0, output_guard_1.guardedStream)(source, {
                maxTokens: options.outputGuard.maxTokens,
                enabled: options.outputGuard.enabled,
                onTruncate: options.onOutputTruncated,
            })
            : source;
        return (async function* () {
            const chunks = [];
            for await (const chunk of stream) {
                observeUsage(chunk, optimized, beforeChars, afterChars, kaInvoke);
                chunks.push(chunk);
                yield chunk;
            }
            cache.set(key, chunks, semanticText);
        })();
    };
    try {
        llm.stream = function patchedStream(request) {
            const self = this;
            return runOptimized((optimized) => originalStream.call(self, optimized), request, false);
        };
        if (typeof originalPrepare === 'function') {
            llm.prepareCall = async function patchedPrepare(config, signal, configure) {
                // 组合宿主的 ConfigureCall：宿主先选，我们再只下调。返回值就是随后被冻结的 config，
                // 所以 dispatch 时的相等校验必然成立。
                const composed = typeof options.configureControls === 'function'
                    ? (controls, model) => options.configureControls(configure ? configure(controls, model) : controls, model)
                    : configure;
                const prepared = await originalPrepare.call(this, config, signal, composed);
                if (!prepared || typeof prepared.stream !== 'function')
                    return prepared;
                const preparedStream = prepared.stream;
                return {
                    ...prepared,
                    stream: (request) => runOptimized((optimized) => preparedStream.call(prepared, optimized), request, true),
                };
            };
        }
    }
    catch (error) {
        (0, log_1.logEvent)('warn', 'schema.install_failed', { error: String(error) });
        return () => { };
    }
    const dispose = () => {
        // 幂等：热重载时新实例会先调旧实例的 dispose，用户/宿主之后再调一次不能把新层拆掉。
        if (disposed)
            return;
        disposed = true;
        cancelKeepalive();
        try {
            llm.stream = originalStream;
            if (typeof originalPrepare === 'function')
                llm.prepareCall = originalPrepare;
        }
        catch {
            /* 恢复失败也不抛出 */
        }
        if (registry.__costKillerStreamInstall?.dispose === dispose)
            delete registry.__costKillerStreamInstall;
    };
    registry.__costKillerStreamInstall = { llm, dispose };
    return dispose;
}
/** 供 demo 使用：估算一组 schema 的 token 数。 */
function schemaTokens(tools) {
    return (0, contracts_1.estimateTokens)(JSON.stringify(tools));
}
