/**
 * 端到端演示 v3.5：CoT 蒸馏 / 缓存门控 / 路由决策 / Spill 回收。
 *
 * 1. 121k 字符工具输出 → AST 提纯 + 落盘指针；
 * 2. 历史含 <thought> 的 21 条中间消息 → CoT 蒸馏 + Fold（CacheAnchor 放行）；
 * 3. 第二轮折叠改到已发送前缀 → CacheAnchor 拦截；
 * 4. 路由：小上下文强制本地（mock Ollama 命中）+ 慢服务超时降级；
 * 5. Spill GC：TTL 回收，pinned 文件保留；
 * 6. 批量 20 条输出，统计整体降幅。
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { apply } from './index'
import { estimateTokens } from './contracts'
import { logEvent } from './log'
import { RoutingModule } from './modules/routing'
import { collectGarbage, pinSpill } from './modules/spill-gc'
import { installSchemaCompressor, schemaTokens } from './modules/schema-index'
import { CompressionBreaker } from './modules/breaker'
import { selectTools } from './modules/tool-attention'
import { toonEncode } from './modules/extraction'
import { ResponseCache } from './modules/response-cache'

const write = (line: string): void => {
  process.stdout.write(`${line}\n`)
}

class FakeSession {
  id = 'demo-session'
  surface = { nodes: [] as number[] }
  appended: Array<{ type: string; data: any; opts: any }> = []

  private seq = 0
  private events = new Map<number, any>()

  add(type: string, message: any): number {
    const seq = ++this.seq
    this.events.set(seq, { type, seq, data: { message } })
    this.surface.nodes.push(seq)
    return seq
  }

  eventAt(seq: number): any {
    return this.events.get(seq)
  }

  deriveMessages(): any[] {
    const messages: any[] = []
    for (const seq of this.surface.nodes) {
      const message = this.events.get(seq)?.data?.message
      if (message) messages.push(message)
    }
    return messages
  }

  deriveEventMessage(event: any): any {
    return event?.data?.message ?? null
  }

  append(type: string, data: any, opts: any): { seq: number } {
    this.appended.push({ type, data, opts })
    const seq = ++this.seq
    this.events.set(seq, { type, seq, data: { message: data } })
    const op = opts?.surfaceOp
    const nodes = this.surface.nodes
    if (op && op.op === 'replace') {
      const startIndex = nodes.indexOf(op.startSeq)
      const endIndex = nodes.indexOf(op.endSeq)
      if (startIndex >= 0 && endIndex >= startIndex) nodes.splice(startIndex, endIndex - startIndex + 1, seq)
      else nodes.push(seq)
    } else {
      nodes.push(seq)
    }
    return { seq }
  }
}

function makeCtx(): { ctx: any; hooks: Map<string, any> } {
  const hooks = new Map<string, any>()
  const ctx: any = {
    systemPrompt: { section: () => () => {} },
    tools: { register: () => () => {} },
    on: (event: string, fn: any) => {
      hooks.set(event, fn)
      return () => {}
    },
  }
  return { ctx, hooks }
}

const userMsg = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })
const assistantMsg = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] })
const toolMsg = (text: string) => ({ role: 'tool', content: [{ type: 'text', text }] })

function bigCode(methods: number): string {
  const lines: string[] = [
    '// ===== demo: MassiveService =====',
    "import { cache } from './cache'",
    'export class MassiveService {',
    '  private readonly store = new Map<string, string>()',
  ]
  for (let index = 0; index < methods; index += 1) {
    lines.push(`  method_${index}(input: string, count: number): Promise<string> {`)
    for (let step = 0; step < 4; step += 1) {
      lines.push(`    const bodyMarker_${index}_${step} = input.repeat(${step}) + count`)
    }
    lines.push(`    return Promise.resolve(bodyMarker_${index}_0)`)
    lines.push('  }')
  }
  lines.push('}')
  return lines.join('\n')
}

function buildJsonPayload(items: number): string {
  return JSON.stringify({
    items: Array.from({ length: items }, (_, index) => ({
      id: index,
      file: `C:\\demo\\item-${index}.txt`,
      note: 'payload '.repeat(20),
    })),
  })
}

function thoughtBlock(index: number): string {
  return `<thought>${`思考 ${index}：先排查缓存命中率，再对比 AST 与分节压缩的收益。`.repeat(30)}</thought>`
}

async function main(): Promise<void> {
  const session = new FakeSession()
  const { ctx, hooks } = makeCtx()
  const dispose = apply(ctx, {
    maxInputTokens: 3000,
    foldAtRatio: 0.4,
    retainRecent: 6,
    minSaveTokens: 100,
    admissionTokens: 1000,
    extractionTokens: 200,
    spillDir: './spill',
  })

  const post = hooks.get('tools/post-execute')
  const pre = hooks.get('agent/pre-step')
  if (typeof post !== 'function' || typeof pre !== 'function') throw new Error('hooks were not registered')

  // ---------- 1. 工具输出 ----------
  const payload = `${bigCode(180)}\n\n${buildJsonPayload(300)}`
  const accept = { kind: 'accept', content: [{ type: 'text', text: payload }] }
  const pipelineStarted = Date.now()
  const toolResult = await post({ tool: { name: 'bash' } }, accept, async () => accept)
  const pipelineMs = Date.now() - pipelineStarted
  const returned = String(toolResult?.content?.[0]?.text ?? '')
  const pipelineBefore = estimateTokens(payload)
  const pipelineAfter = estimateTokens(returned)
  write(`    class kept=${returned.includes('class MassiveService')} | admission pointer=${returned.includes('[ADMISSION]')}`)
  logEvent('info', 'demo.pipeline', { tokensBefore: pipelineBefore, tokensAfter: pipelineAfter })

  // ---------- 2. 第一轮 pre-step：CoT 蒸馏 + Fold ----------
  session.add('user/message', userMsg('需求：分析 C:\\repo\\app.ts 的缓存问题，TODO: 补测试，UUID 3ddb09f8-79ae-4999-a60d-f73e584d3f64'))
  for (let index = 0; index < 10; index += 1) {
    session.add(
      'assistant/message',
      assistantMsg(`${thoughtBlock(index)} 决定采用方案 ${index}：改用 surface 折叠，理由 ${'x'.repeat(400)}`),
    )
    session.add('tool/result', toolMsg(`Error: ENOENT at src\\file${index}.ts:${index} [exit code: 1] ${'y'.repeat(500)}`))
  }
  for (let index = 0; index < 3; index += 1) {
    session.add('assistant/message', assistantMsg(`近期尝试 ${index}：${'r'.repeat(400)}`))
    session.add('tool/result', toolMsg(`近期结果 ${index}：${'s'.repeat(400)}`))
  }
  session.add('assistant/message', assistantMsg(`结论：方案已定，${'z'.repeat(400)}`))

  const foldBefore1 = session.appended.length
  await pre({ agent: { session, model: 'demo-model' }, turn: 1, step: 1, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  const foldDelta1 = session.appended.length - foldBefore1
  const foldSummary = String(session.appended[session.appended.length - 1]?.data?.content?.[0]?.text ?? '')
  const cotLine = foldSummary.split('\n').find((line) => line.startsWith('[CoT]')) ?? '(no CoT line)'

  // ---------- 3. 第二轮 pre-step：应被 CacheAnchor 拦截 ----------
  for (let index = 0; index < 5; index += 1) {
    session.add('assistant/message', assistantMsg(`第二轮尝试 ${index}：${'a'.repeat(500)}`))
    session.add('tool/result', toolMsg(`第二轮输出 ${index}：${'b'.repeat(500)}`))
  }
  session.add('user/message', userMsg('继续：第二轮需求，检查前缀缓存是否被破坏'))
  session.add('assistant/message', assistantMsg(`第二轮结论：${'c'.repeat(500)}`))

  const foldBefore2 = session.appended.length
  await pre({ agent: { session, model: 'demo-model' }, turn: 2, step: 1, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  const foldDelta2 = session.appended.length - foldBefore2

  // ---------- 4. 路由：本地命中 + 超时降级 ----------
  const fastServer = http.createServer((request, response) => {
    request.resume()
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ response: 'local-answer' }))
  })
  await new Promise<void>((resolve) => fastServer.listen(0, '127.0.0.1', () => resolve()))
  const fastPort = (fastServer.address() as any).port
  const router = new RoutingModule({ baseUrl: `http://127.0.0.1:${fastPort}`, timeoutMs: 3000 })
  const localRoute = await router.routeWithContext({ prompt: '你好，帮我算一下 1+1', contextTokens: 1800, crossFileDependency: false })
  await new Promise<void>((resolve) => fastServer.close(() => resolve()))

  const slowServer = http.createServer((request, response) => {
    request.resume()
    setTimeout(() => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ response: 'slow-answer' }))
    }, 400)
  })
  await new Promise<void>((resolve) => slowServer.listen(0, '127.0.0.1', () => resolve()))
  const slowPort = (slowServer.address() as any).port
  const slowRouter = new RoutingModule({ baseUrl: `http://127.0.0.1:${slowPort}`, timeoutMs: 120 })
  const timeoutRoute = await slowRouter.routeWithContext({ prompt: '简单问题', contextTokens: 1200, crossFileDependency: false })
  await new Promise<void>((resolve) => slowServer.close(() => resolve()))

  // ---------- 5. Spill GC ----------
  const gcDir = path.resolve('.demo-spill')
  fs.rmSync(gcDir, { recursive: true, force: true })
  fs.mkdirSync(gcDir, { recursive: true })
  const old = (Date.now() - 48 * 3600_000) / 1000
  for (let index = 0; index < 60; index += 1) {
    const file = path.join(gcDir, `file-${index}.txt`)
    fs.writeFileSync(file, 'x'.repeat(2048))
    fs.utimesSync(file, old, old)
  }
  const pinnedFile = path.join(gcDir, 'file-0.txt')
  pinSpill(pinnedFile, 3600_000)
  const gc = collectGarbage({ dir: gcDir, maxFiles: 50, ttlMs: 24 * 3600_000, minAgeMs: 0 })
  const pinnedKept = fs.existsSync(pinnedFile)
  logEvent('info', 'demo.spill_gc', {
    scanned: gc.scanned,
    deleted: gc.deleted.length,
    kept: gc.kept,
    pinnedSkipped: gc.pinnedSkipped,
    pinnedKept,
  })
  fs.rmSync(gcDir, { recursive: true, force: true })

  // ---------- 6. Schema 压缩（MCP Tool Tax） ----------
  const tools = Array.from({ length: 80 }, (_, index) => ({
    name: `mcp_tool_${index}`,
    description: `MCP tool ${index}: ${'performs a specialized workspace operation with detailed usage notes. '.repeat(8)}`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'absolute file path '.repeat(8) },
        mode: { type: 'string', description: 'execution mode '.repeat(8) },
      },
    },
  }))
  const captured: any[] = []
  const fakeLlm = {
    stream(request: any) {
      captured.push(request)
      return (async function* () {})()
    },
  }
  const disposeSchema = installSchemaCompressor({ llm: fakeLlm, get: () => undefined } as any, {
    enabled: true,
    maxDescriptionChars: 120,
  })
  const schemaBefore = schemaTokens(tools)
  fakeLlm.stream({
    provider: 'p',
    model: 'm',
    sessionId: 'schema-demo',
    messages: [{ role: 'user', content: [{ type: 'text', text: '分析源码结构' }] }],
    tools,
  })
  const schemaAfter = schemaTokens(captured[0]?.tools ?? [])
  disposeSchema()

  // ---------- 7. 压缩熔断 ----------
  const breaker = new CompressionBreaker({ failureThreshold: 3, cooldownMs: 1000 })
  breaker.recordFailure('no-net-saving')
  breaker.recordFailure('fail-closed')
  breaker.recordFailure('no-net-saving')
  const breakerState = breaker.state
  const breakerAllows = breaker.canRun()

  // ---------- 8. 索引先行（index-first） ----------
  const listText = `目录清单：\n${Array.from({ length: 200 }, (_, index) => `C:\\repo\\src\\module-${index}.ts`).join('\n')}`
  const listDecision = { kind: 'accept', content: [{ type: 'text', text: listText }] }
  const listOut = await post({ tool: { name: 'glob' } }, listDecision, async () => listDecision)
  const listReturned = String(listOut?.content?.[0]?.text ?? '')

  // ---------- 9. 去重总线 ----------
  const dupPayload = `重复输出检测\n${'line '.repeat(400)}`
  const dupDecision = { kind: 'accept', content: [{ type: 'text', text: dupPayload }] }
  await post({ tool: { name: 'bash' } }, dupDecision, async () => dupDecision)
  const dupSecond = await post({ tool: { name: 'bash' } }, dupDecision, async () => dupDecision)
  const dupText = String(dupSecond?.content?.[0]?.text ?? '')
  const dedupHit = dupText.includes('[DEDUP]')
  const dupTokens = estimateTokens(dupPayload)
  const dupAfter = estimateTokens(dupText)

  // ---------- 10. 超大体量快速路径 ----------
  const hugeCode = bigCode(1500)
  const hugeDecision = { kind: 'accept', content: [{ type: 'text', text: hugeCode }] }
  const hugeStarted = Date.now()
  const hugeOut = await post({ tool: { name: 'read' } }, hugeDecision, async () => hugeDecision)
  const hugeMs = Date.now() - hugeStarted
  const hugeReturned = String(hugeOut?.content?.[0]?.text ?? '')

  // ---------- 11. v1.3：Tool Attention / TOON / 语义缓存 / 本地探测 ----------
  const attentionTools = Array.from({ length: 80 }, (_, index) => ({
    name: `mcp_tool_${index}`,
    description: index % 5 === 0 ? 'read files and run tests for the auth module' : `generic utility ${index}`,
    parameters: { type: 'object', properties: {} },
  }))
  const attention = selectTools(attentionTools, 'run the failing test and read the auth file', 5)
  const attentionBefore = schemaTokens(attentionTools as any)
  const attentionAfter = schemaTokens(attention.selected as any)
  logEvent('info', 'tool_attention.filtered', {
    module: 'ToolAttention',
    total: attentionTools.length,
    selected: attention.selected.length,
    hidden: attention.hidden.length,
    tokensBefore: attentionBefore,
    tokensAfter: attentionAfter,
  })

  const toonRows = Array.from({ length: 120 }, (_, index) => ({
    id: index,
    level: 'info',
    message: `event ${index} finished`,
    ok: true,
    ms: index * 2,
  }))
  const toon = toonEncode(JSON.stringify(toonRows, null, 2))
  if (toon) {
    logEvent('info', 'toon.encoded', {
      module: 'TOON',
      rows: toon.rows,
      cols: toon.cols,
      tokensBefore: toon.tokensBefore,
      tokensAfter: toon.tokensAfter,
      rate: Number((1 - toon.tokensAfter / toon.tokensBefore).toFixed(3)),
    })
  }

  const semanticCache = new ResponseCache({ similarityThreshold: 0.85 })
  const semanticText =
    'please fix the failing authentication test in the login module today because the build is broken and users cannot sign in'
  semanticCache.set('demo', [{ type: 'text', text: 'cached' }], semanticText)
  const semanticHit = semanticCache.findSimilar(semanticText.replace(' test ', ' tests '))
  if (semanticHit) {
    logEvent('info', 'cache.semantic_hit', { module: 'ResponseCache', score: semanticHit.score, ...semanticCache.stats() })
  }

  let localProbeOk = false
  try {
    const probe = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(500) })
    localProbeOk = probe.ok
  } catch {
    localProbeOk = false
  }
  logEvent('info', localProbeOk ? 'routing.local_available' : 'routing.local_unavailable', { module: 'Routing' })
  if (localRoute.result.route === 'local') {
    logEvent('info', 'routing.local_hit', { module: 'Routing', latencyMs: localRoute.result.latencyMs })
  }

  dispose()

  // ---------- 汇总 ----------
  write(`[1] tool output: ${payload.length} chars, tokens ${pipelineBefore} -> ${pipelineAfter} (saved ${pipelineBefore - pipelineAfter}) in ${pipelineMs}ms`)
  write(`[2] pre-step #1 foldAppends=${foldDelta1} | ${cotLine} | indexCard=${foldSummary.includes('[CONTEXT_INDEX]') ? 'yes' : 'no'}`)
  write(`[3] pre-step #2 foldAppends=${foldDelta2} (0 = CacheAnchor 拦截)`)
  write(`[4] routing local: route=${localRoute.result.route} reason=${localRoute.result.reason} latency=${localRoute.result.latencyMs}ms`)
  write(`    routing timeout: route=${timeoutRoute.result.route} degraded=${timeoutRoute.result.degraded} reason=${timeoutRoute.result.reason}`)
  write(`[5] spill gc: scanned=${gc.scanned} deleted=${gc.deleted.length} kept=${gc.kept} pinnedSkipped=${gc.pinnedSkipped} pinnedKept=${pinnedKept}`)
  write(`[6] schema: ${tools.length} tools, ${schemaBefore} -> ${schemaAfter} tokens (saved ${schemaBefore - schemaAfter})`)
  write(`[7] breaker: state=${breakerState} allows=${breakerAllows}`)
  write(`[8] index-first: ${estimateTokens(listText)} -> ${estimateTokens(listReturned)} tokens (mode=${listReturned.includes('[INDEX]') ? 'index' : 'other'})`)
  write(`[9] dedup: second identical output=${dedupHit ? 'pointer' : 'miss'}, ${dupTokens} -> ${dupAfter} tokens`)
  write(`[10] huge ${hugeCode.length} chars -> ${estimateTokens(hugeReturned)} tokens in ${hugeMs}ms`)
  write(`[11] tool attention: ${attentionTools.length} -> ${attention.selected.length} tools, schema ${attentionBefore} -> ${attentionAfter} tokens`)
  write(
    `[12] toon: ${
      toon
        ? `${toon.rows}x${toon.cols}, ${toon.tokensBefore} -> ${toon.tokensAfter} (-${((1 - toon.tokensAfter / toon.tokensBefore) * 100).toFixed(1)}%)`
        : 'not applicable'
    }`,
  )
  write(`[13] semantic cache: ${semanticHit ? `hit score=${semanticHit.score.toFixed(3)}` : 'miss'}`)
  write(`[14] routing probe: ${localProbeOk ? 'local available' : 'local unavailable'} | local_hit=${localRoute.result.route === 'local'}`)

  logEvent('info', 'demo.summary', {
    pipelineSaved: pipelineBefore - pipelineAfter,
    pipelineMs,
    fold1: foldDelta1,
    fold2: foldDelta2,
    localRoute: localRoute.result.route,
    timeoutDegraded: timeoutRoute.result.degraded,
    gcDeleted: gc.deleted.length,
    gcPinnedSkipped: gc.pinnedSkipped,
    schemaSaved: schemaBefore - schemaAfter,
    breakerState,
    indexFirst: listReturned.includes('[INDEX]'),
    dedupHit,
    indexCard: foldSummary.includes('[CONTEXT_INDEX]'),
  })
}

void main().catch((error) => {
  logEvent('error', 'demo.failed', { error: String(error) })
  process.stdout.write(`demo failed: ${String(error)}\n`)
  process.exitCode = 1
})
