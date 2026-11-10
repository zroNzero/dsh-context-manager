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
    let lastLogKey = '';
    const transform = (request) => {
        try {
            const messagesTokens = estimateMessagesTokens(request?.messages);
            if (!request || !Array.isArray(request.tools) || request.tools.length === 0) {
                options.onRequest?.({
                    sessionId: String(request?.sessionId ?? ''),
                    beforeTokens: messagesTokens,
                    afterTokens: messagesTokens,
                    savedTokens: 0,
                });
                return request;
            }
            const toolsBeforeChars = JSON.stringify(request.tools).length;
            let tools = request.tools;
            let hidden = [];
            if (selectionEnabled) {
                const selected = selectStableToolSet(tools, lastUserText(request.messages), { topK });
                tools = selected.tools;
                hidden = selected.hidden;
            }
            const compressed = compressToolSchemas(tools, maxChars);
            options.onRequest?.({
                sessionId: String(request.sessionId ?? ''),
                beforeTokens: messagesTokens + Math.ceil(toolsBeforeChars / 4),
                afterTokens: messagesTokens + Math.ceil(JSON.stringify(compressed.tools).length / 4),
                savedTokens: compressed.stats.tokensSaved,
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
            return { ...request, tools: compressed.tools };
        }
        catch (error) {
            (0, log_1.logEvent)('warn', 'schema.compress_failed', { error: String(error) });
            return request;
        }
    };
    const originalStream = llm.stream;
    const originalPrepare = llm.prepareCall;
    try {
        llm.stream = function patchedStream(request) {
            return originalStream.call(this, transform(request));
        };
        if (typeof originalPrepare === 'function') {
            llm.prepareCall = async function patchedPrepare(config, signal, configure) {
                const prepared = await originalPrepare.call(this, config, signal, configure);
                if (!prepared || typeof prepared.stream !== 'function')
                    return prepared;
                const preparedStream = prepared.stream;
                return { ...prepared, stream: (request) => preparedStream.call(prepared, transform(request)) };
            };
        }
    }
    catch (error) {
        (0, log_1.logEvent)('warn', 'schema.install_failed', { error: String(error) });
        return () => { };
    }
    return () => {
        try {
            llm.stream = originalStream;
            if (typeof originalPrepare === 'function')
                llm.prepareCall = originalPrepare;
        }
        catch { }
    };
}
/** 供 demo 使用：估算一组 schema 的 token 数。 */
function schemaTokens(tools) {
    return (0, contracts_1.estimateTokens)(JSON.stringify(tools));
}
