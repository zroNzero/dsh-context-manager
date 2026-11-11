/**
 * ToolAttention —— 基于意图的工具懒加载（v1.3）。
 *
 * 每轮按最后一条用户消息对工具做轻量打分（名称命中权重更高），只注入 top-K 完整
 * Schema；其余工具在 system prompt 中保留一行“名称 + 一句话描述”的目录。
 * 缺省提供 search_tools 元工具用于按需拉取完整 Schema。
 *
 * 注意：动态工具集会改变请求前缀，可能击穿缓存；调用方必须记录并自行承担
 * CacheAnchor 风险（日志 tool_attention.prefix_risk）。
 */

export interface ToolLike {
  name: string
  description?: string
  parameters?: unknown
}

export const SEARCH_TOOLS_DEF: ToolLike = {
  name: 'search_tools',
  description:
    'Return the full JSON schema of a tool that was hidden by lazy loading. Use this when you need a tool not present in the current list.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'tool name or keywords' } },
    required: ['query'],
  },
}

export function tokenize(text: string): string[] {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .filter((token) => token.length > 1)
}

export function firstSentence(text: string, maxChars = 80): string {
  const cleaned = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxChars) return cleaned
  const cut = cleaned.slice(0, maxChars)
  const dot = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('。'))
  return `${(dot > 20 ? cut.slice(0, dot) : cut).trim()}…`
}

export interface ToolSelection {
  /** 需要注入完整 schema 的工具（含 search_tools）。 */
  selected: ToolLike[]
  /** 被隐藏的工具目录行。 */
  catalog: string[]
  hidden: string[]
  scoreboard: Array<{ name: string; score: number }>
}

export function selectTools(tools: readonly ToolLike[], prompt: string, topK = 5): ToolSelection {
  const intent = new Set(tokenize(prompt))
  const scored = tools.map((tool) => {
    const nameTokens = tokenize(tool.name)
    const descTokens = tokenize(tool.description ?? '')
    let score = 0
    for (const token of nameTokens) if (intent.has(token)) score += 4
    for (const token of descTokens) if (intent.has(token)) score += 1
    // 名字里带常见动词（read/run/search/edit/list…）且意图含同类词时加权
    return { tool, score }
  })

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    return left.tool.name.localeCompare(right.tool.name)
  })

  const hasSearchTool = tools.some((tool) => tool.name === 'search_tools')
  const limit = Math.max(1, topK) - (hasSearchTool ? 0 : 1)
  const top = scored.slice(0, Math.max(1, limit))
  const hidden = scored.slice(top.length)
  const selected = top.map((item) => item.tool)
  if (!hasSearchTool) selected.push(SEARCH_TOOLS_DEF)

  const catalog = hidden.map((item) => `- ${item.tool.name}: ${firstSentence(item.tool.description ?? '')}`)
  return {
    selected,
    catalog,
    hidden: hidden.map((item) => item.tool.name),
    scoreboard: scored.map((item) => ({ name: item.tool.name, score: item.score })),
  }
}

/** SCOUT：BM25 轻量打分（IDF 抑制高频词），比纯意图命中更稳。 */
export function selectToolsScout(tools: readonly ToolLike[], prompt: string, topK = 5): ToolSelection {
  const intent = tokenize(prompt)
  const intentSet = new Set(intent)
  const docs = tools.map((tool) => new Set(tokenize(`${tool.name} ${tool.description ?? ''}`)))
  const df = new Map<string, number>()
  for (const doc of docs) for (const token of doc) df.set(token, (df.get(token) ?? 0) + 1)
  const total = Math.max(1, docs.length)
  const idf = (token: string): number => Math.log(1 + (total - (df.get(token) ?? 0) + 0.5) / ((df.get(token) ?? 0) + 0.5))
  const avgLength = docs.reduce((sum, doc) => sum + doc.size, 0) / total

  const scored = tools.map((tool, index) => {
    const doc = docs[index]!
    const nameTokens = new Set(tokenize(tool.name))
    let score = 0
    for (const token of new Set(intent)) {
      if (!doc.has(token)) continue
      const weight = (nameTokens.has(token) ? 2.5 : 1) * idf(token)
      const tf = 1
      const k1 = 1.2
      const b = 0.75
      score += weight * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.size / Math.max(1, avgLength)))))
    }
    return { tool, score }
  })
  scored.sort((left, right) => (right.score - left.score) || left.tool.name.localeCompare(right.tool.name))

  const hasSearchTool = tools.some((tool) => tool.name === 'search_tools')
  const limit = Math.max(1, topK) - (hasSearchTool ? 0 : 1)
  const top = scored.slice(0, Math.max(1, limit))
  const hidden = scored.slice(top.length)
  const selected = top.map((item) => item.tool)
  if (!hasSearchTool) selected.push(SEARCH_TOOLS_DEF)
  return {
    selected,
    catalog: hidden.map((item) => `- ${item.tool.name}: ${firstSentence(item.tool.description ?? '')}`),
    hidden: hidden.map((item) => item.tool.name),
    scoreboard: scored.map((item) => ({ name: item.tool.name, score: Number(item.score.toFixed(3)) })),
  }
}

/** 由「已锁定工具名集合」重建 selection（OSIRIS 稳定锚定用）。 */
export function selectionFromNames(tools: readonly ToolLike[], names: readonly string[]): ToolSelection | null {
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const selected = names.map((name) => byName.get(name)).filter((tool): tool is ToolLike => tool !== undefined)
  if (selected.length === 0) return null
  const selectedNames = new Set(selected.map((tool) => tool.name))
  const hidden = tools.filter((tool) => !selectedNames.has(tool.name))
  if (!selectedNames.has('search_tools') && !tools.some((tool) => tool.name === 'search_tools')) {
    selected.push(SEARCH_TOOLS_DEF)
  }
  return {
    selected,
    catalog: hidden.map((tool) => `- ${tool.name}: ${firstSentence(tool.description ?? '')}`),
    hidden: hidden.map((tool) => tool.name),
    scoreboard: [],
  }
}

/** 把目录行并入 system 消息（不新建、不重排其它消息）。 */
export function withCatalog(messages: any[], catalog: string[]): any[] {
  if (catalog.length === 0) return messages
  const block = `[TOOL_CATALOG] 以下工具未加载完整 schema，需要时调用 search_tools 拉取：\n${catalog.join('\n')}`
  if (!Array.isArray(messages) || messages.length === 0) {
    return [{ role: 'system', content: [{ type: 'text', text: block }] }]
  }
  const index = messages.findIndex((message) => message?.role === 'system')
  if (index >= 0) {
    const target = messages[index]
    const content = Array.isArray(target?.content)
      ? [...target.content, { type: 'text', text: block }]
      : [{ type: 'text', text: `${String(target?.content ?? '')}\n${block}` }]
    const next = messages.slice()
    next[index] = { ...target, content }
    return next
  }
  return [{ role: 'system', content: [{ type: 'text', text: block }] }, ...messages]
}
