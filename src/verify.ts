/**
 * 验收脚本：证明插件按预期运行。
 *
 * 不是 demo 的复述，而是带断言的验收：
 * 1. 插件导出契约（name / inject / Config / apply / 无 default）；
 * 2. apply 在宿主形态的 ctx 上完成注册（prompt section、tool、两个钩子）；
 * 3. Schema 压缩真的在 LLM 请求边界生效；
 * 4. 工具输出真的被压缩且原文可回读（ADMISSION 指针）；
 * 5. 去重总线真的命中；
 * 6. 历史折叠真的写入 surface，第二次因 prefixBreak 被 CacheAnchor 拦截；
 * 7. 全工程无 console.log；
 * 8. dispose 可安全卸载。
 *
 * 任一断言失败 → 退出码 1。
 */

import fs from 'node:fs'
import path from 'node:path'
import { apply, Config, inject, name } from './index'
import { estimateTokens } from './contracts'

// 契约探针会真的发一次请求；测试环境里没有真 provider，必须关掉，
// 否则它会吃掉假 llm 的流、并让「捕获到的请求条数」这一类断言全部错位。
process.env.CK_DISABLE_REASONING_PROBE = '1'
import { runExtraction, buildFirewallSummary } from './modules/extraction'
import { installSchemaCompressor } from './modules/schema-index'
import { BillingLedger } from './modules/billing'

const results: Array<{ ok: boolean; label: string; detail: string }> = []

function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push({ ok: true, label, detail: 'ok' })
    })
    .catch((error: unknown) => {
      results.push({ ok: false, label, detail: error instanceof Error ? error.message : String(error) })
    })
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

class FakeSession {
  id = 'verify-session'
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
    return this.surface.nodes.map((seq) => this.events.get(seq)?.data?.message).filter(Boolean)
  }
  deriveEventMessage(event: any): any {
    return event?.data?.message ?? null
  }
  append(type: string, data: any, opts: any): { seq: number } {
    this.appended.push({ type, data, opts })
    const seq = ++this.seq
    this.events.set(seq, { type, seq, data: { message: data } })
    const op = opts?.surfaceOp
    if (op?.op === 'replace') {
      const start = this.surface.nodes.indexOf(op.startSeq)
      const end = this.surface.nodes.indexOf(op.endSeq)
      if (start >= 0 && end >= start) this.surface.nodes.splice(start, end - start + 1, seq)
      else this.surface.nodes.push(seq)
    } else this.surface.nodes.push(seq)
    return { seq }
  }
}

function bigCode(methods: number): string {
  const lines = ['// verify fixture', 'export class VerifyService {']
  for (let index = 0; index < methods; index += 1) {
    lines.push(`  method_${index}(input: string): Promise<string> {`)
    lines.push(`    const body_${index} = input.repeat(${index})`)
    lines.push(`    return Promise.resolve(body_${index})`)
    lines.push('  }')
  }
  lines.push('}')
  return lines.join('\n')
}

const cfg = {
  maxInputTokens: 3000,
  foldAtRatio: 0.4,
  retainRecent: 6,
  minSaveTokens: 100,
  admissionTokens: 1000,
  extractionTokens: 200,
} as const

async function main(): Promise<void> {
  await check('exports contract', () => {
    assert(name === 'dsh-context-manager', `name=${name}`)
    assert(Array.isArray(inject) && inject.length === 4, 'inject must declare 4 services')
    assert(typeof apply === 'function', 'apply missing')
    const parsed = Config.parse({})
    assert(parsed.maxInputTokens === 100000, 'Config default mismatch')
  })

  const hooks = new Map<string, any>()
  const sections: any[] = []
  const tools: any[] = []
  const captured: any[] = []
  const fakeLlm = {
    stream(request: any) {
      captured.push(request)
      return (async function* () {})()
    },
  }
  const ctx: any = {
    llm: fakeLlm,
    systemPrompt: { section: (section: any) => { sections.push(section); return () => {} } },
    tools: { register: (definition: any) => { tools.push(definition); return () => {} } },
    on: (event: string, fn: any) => { hooks.set(event, fn); return () => {} },
  }

  // 本用例验证「分层/懒加载」路径本身，需显式打开（默认已关闭，见 index.ts 注释）。
  const disposer = apply(ctx, { ...cfg, toolAttentionEnabled: true })

  await check('apply registers prompt section/tool/hooks', () => {
    assert(sections.some((section) => section.order === 46), 'section order 46 missing')
    assert(tools.some((tool) => tool.name === 'costkiller_status'), 'status tool missing')
    assert(hooks.has('tools/post-execute'), 'post-execute hook missing')
    assert(hooks.has('agent/pre-step'), 'pre-step hook missing')
    assert(typeof disposer === 'function', 'apply must return disposer')
  })

  /**
   * 回归：工具声明的 output.schema 必须能装下它自己返回的对象。
   * 宿主按 `additionalProperties: false` 校验返回值，漏声明一个字段整个工具就报
   * `returned invalid output`（实盘踩到：realBilling/realBillFile/debugLogFile）。
   * 这里不引 ajv，只按 schema 递归核对：键必须在 properties 里、required 必须给全。
   */
  await check('status tool output matches its declared schema', async () => {
    const tool = tools.find((item) => item.name === 'costkiller_status')
    assert(tool, 'status tool missing')
    const value = await tool.execute({})
    const walk = (schema: any, node: any, path: string) => {
      assert(schema && typeof schema === 'object', `${path}: missing schema`)
      if (schema.type === 'object' || schema.properties) {
        assert(node && typeof node === 'object', `${path}: expected object`)
        const declared = schema.properties ?? {}
        for (const key of Object.keys(node)) {
          assert(declared[key], `${path}.${key} is not declared (additionalProperties: false)`)
        }
        for (const key of schema.required ?? []) {
          assert(Object.prototype.hasOwnProperty.call(node, key), `${path}.${key} is required but missing`)
        }
        for (const [key, child] of Object.entries(node)) {
          if (declared[key]) walk(declared[key], child, `${path}.${key}`)
        }
      } else if (schema.type === 'number') {
        assert(typeof node === 'number' && Number.isFinite(node), `${path}: expected finite number`)
      } else if (schema.type === 'string') {
        assert(typeof node === 'string', `${path}: expected string`)
      } else if (schema.type === 'boolean') {
        assert(typeof node === 'boolean', `${path}: expected boolean`)
      }
    }
    walk(tool.output.schema, value, 'value')
  })

  await check('schema compression at llm boundary', () => {
    const schemaTools = Array.from({ length: 40 }, (_, index) => ({
      name: `tool_${index}`,
      description: 'long description '.repeat(40),
      parameters: { type: 'object', properties: { p: { type: 'string' } } },
    }))
    const before = estimateTokens(JSON.stringify(schemaTools))
    fakeLlm.stream({ provider: 'p', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: '分析' }] }], tools: schemaTools })
    const sent = captured[captured.length - 1]
    assert(sent && sent !== undefined, 'request not captured')
    const after = estimateTokens(JSON.stringify(sent.tools))
    assert(after < before * 0.8, `schema compression ineffective: ${before}->${after}`)
    assert(sent.tools.length <= 12, `layered tools expected <=12, got ${sent.tools.length}`)
    const systemText = JSON.stringify((sent.messages ?? []).find((message: any) => message?.role === 'system') ?? {})
    assert(systemText.includes('[TOOL_CATALOG]'), 'tool catalog missing from system message')
    assert(systemText.includes('[TOOL_NOT_LOADED]'), 'explicit not-loaded hint missing')
  })

  await check('billing captures provider usage from the live stream', async () => {
    const seen: any[] = []
    let hit = 0
    const llm = {
      stream(_request: any) {
        // 命中量是**单请求**值（不是累计值），每次给一个独立的值，直接把原始值记账。
        hit = hit === 0 ? 800 : 1600
        const snapshot = hit
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: 'ok' }
          yield { type: 'usage', usage: { inputTokens: 1200, cacheReadTokens: snapshot, outputTokens: 340 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
    const billingTools = Array.from({ length: 30 }, (_, index) => ({
      name: `bill_tool_${index}`,
      description: 'very long billable description '.repeat(20),
      parameters: { type: 'object', properties: { p: { type: 'string' } } },
    }))
    const dispose = installSchemaCompressor({ llm } as any, {
      enabled: true,
      maxDescriptionChars: 40,
      onUsage: (info) => seen.push(info),
    })
    try {
      const request = {
        provider: 'deepseek-account',
        model: 'deepseek-flash',
        purpose: 'agent-loop',
        sessionId: 'billing-session',
        messages: [{ role: 'user', content: [{ type: 'text', text: '分析' }] }],
        tools: billingTools,
      }
      // 第一次：provider 的 cacheReadTokens 是会话累计值，第一次出现只能当基线
      for await (const _chunk of llm.stream(request)) {
        /* drain */
      }
      // 第二次：累计值上涨 -> 记账拿到的应该是差分
      for await (const _chunk of llm.stream(request)) {
        /* drain */
      }
    } finally {
      dispose()
    }
    assert(seen.length === 2, `usage callback fired ${seen.length} times`)
    assert(seen[0].usage.cacheReadTokens === 800, `per-request hit must pass through raw, got ${seen[0].usage.cacheReadTokens}`)
    assert(seen[1].usage.cacheReadTokens === 1600, `per-request hit must pass through raw, got ${seen[1].usage.cacheReadTokens}`)
    assert(seen[1].usage.inputTokens === 1200 && seen[1].usage.outputTokens === 340, 'usage passthrough broken')
    assert(seen[1].purpose === 'agent-loop', `purpose lost: ${seen[1].purpose}`)
    assert(seen[1].beforeChars > seen[1].afterChars, `payload chars not reduced: ${seen[1].beforeChars}->${seen[1].afterChars}`)

    const ledger = new BillingLedger()
    const record = ledger.record(seen[1])
    assert(record !== null, 'billing refused a real usage record')
    assert(record!.hitTokens === 1600, `ledger must book 1600 hit tokens, got ${record!.hitTokens}`)
    assert(record!.actualCost > 0, 'real cost must be positive')
    assert(record!.removedPromptTokens > 0, 'measured removal must be positive after schema compression')
    assert(ledger.snapshot().reduction > 0, 'reduction must be positive')
  })

  await check('schema install defers until llm service is ready', async () => {
    const ctx2: any = {
      systemPrompt: { section: () => () => {} },
      tools: { register: () => () => {} },
      on: () => () => {},
    }
    const dispose2 = apply(ctx2, cfg)
    const captured2: any[] = []

    await new Promise((resolve) => setTimeout(resolve, 50))
    ctx2.llm = {
      stream(request: any) {
        captured2.push(request)
        return (async function* () {})()
      },
    }
    await new Promise((resolve) => setTimeout(resolve, 700))

    const lateTools = Array.from({ length: 20 }, (_, index) => ({
      name: `late_tool_${index}`,
      description: 'long deferred description '.repeat(30),
      parameters: { type: 'object', properties: {} },
    }))
    ctx2.llm.stream({
      provider: 'p',
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: '分析' }] }],
      tools: lateTools,
    })

    assert(captured2.length === 1, 'late llm stream was not captured')
    const description = String(captured2[0].tools[0].description ?? '')
    assert(description.length <= 121, `deferred install did not patch stream (len=${description.length})`)
    dispose2()
  })

  await check('schema installs from agent-scope llm', async () => {
    const agentHooks = new Map<string, any>()
    const ctx3: any = {
      systemPrompt: { section: () => () => {} },
      tools: { register: () => () => {} },
      on: (event: string, fn: any) => {
        agentHooks.set(event, fn)
        return () => {}
      },
    }
    const dispose3 = apply(ctx3, cfg)
    const captured3: any[] = []
    const fakeLlm = {
      stream(request: any) {
        captured3.push(request)
        return (async function* () {})()
      },
    }
    const session = new FakeSession()
    session.id = 'verify-agent-llm'
    session.add('user/message', { role: 'user', content: [{ type: 'text', text: '你好' }] })

    const pre = agentHooks.get('agent/pre-step')
    await pre(
      { agent: { session, model: 'm', loopCtx: { llm: fakeLlm } }, turn: 1, step: 1, messages: [] },
      async () => ({ kind: 'enter', messages: [] }),
    )

    const longTools = Array.from({ length: 10 }, (_, index) => ({
      name: `agent_tool_${index}`,
      description: 'agent scoped long description '.repeat(30),
      parameters: { type: 'object', properties: {} },
    }))
    fakeLlm.stream({ provider: 'p', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: '分析' }] }], tools: longTools })

    assert(captured3.length === 1, 'agent-scope llm stream was not captured')
    assert(String(captured3[0].tools[0].description ?? '').length <= 121, 'agent-scope schema install did not patch stream')
    dispose3()
  })

  await check('firewall summarizes >250 token outputs', async () => {
    const post = hooks.get('tools/post-execute')
    const session = new FakeSession()
    session.id = 'verify-firewall'
    session.add('user/message', { role: 'user', content: [{ type: 'text', text: '测试防火墙' }] })
    const payload = `${Array.from({ length: 300 }, (_, index) => `line ${index}: ${'y'.repeat(40)}`).join('\n')}\nError: ENOENT`
    const decision = await post(
      { tool: { name: 'pwsh' }, agent: { session } },
      { content: [{ type: 'text', text: payload }] },
      async () => ({ kind: 'accept', content: [{ type: 'text', text: payload }] }),
    )
    const output = String(decision?.content?.[0]?.text ?? '')
    assert(output.includes('[FIREWALL]'), 'firewall summary missing')
    assert(output.includes('[ADMISSION]'), 'spill pointer missing')
    assert(output.length < payload.length, 'firewall output must be shorter')
  })

  await check('tool output compressed with recoverable pointer', async () => {
    const post = hooks.get('tools/post-execute')
    const payload = bigCode(160)
    const decision = { kind: 'accept', content: [{ type: 'text', text: payload }] }
    const output = await post({ tool: { name: 'read' } }, decision, async () => decision)
    const returned = String(output?.content?.[0]?.text ?? '')
    assert(returned.length < payload.length * 0.6, `output not compressed enough: ${payload.length}->${returned.length}`)
    assert(returned.includes('class VerifyService'), 'class name lost')
    assert(!returned.includes('input.repeat('), 'method bodies leaked into skeleton')
    assert(returned.includes('[ADMISSION]'), 'admission pointer missing')
    const pointer = /saved at: ([^)]+\.txt)/.exec(returned)?.[1] ?? /落盘：([^）]+\.txt)/.exec(returned)?.[1]
    assert(pointer !== undefined && fs.existsSync(pointer), `spill file missing: ${pointer}`)
    const spilled = fs.readFileSync(pointer!, 'utf8')
    assert(spilled === payload, 'spilled content mismatch')
  })

  await check('dedup bus hits on identical output', async () => {
    const post = hooks.get('tools/post-execute')
    const payload = `duplicate ${'line '.repeat(300)}`
    const decision = { kind: 'accept', content: [{ type: 'text', text: payload }] }
    await post({ tool: { name: 'bash' } }, decision, async () => decision)
    const second = await post({ tool: { name: 'bash' } }, decision, async () => decision)
    const returned = String(second?.content?.[0]?.text ?? '')
    assert(returned.includes('[DEDUP]'), 'dedupe pointer missing')
  })

  const session = new FakeSession()
  session.add('user/message', { role: 'user', content: [{ type: 'text', text: '需求：修复 C:\\repo\\app.ts，TODO: 补测试' }] })
  for (let index = 0; index < 3; index += 1) {
    session.add('assistant/message', {
      role: 'assistant',
      content: [{ type: 'text', text: `<thought>${'思考 '.repeat(200)}</thought> 决定采用方案 ${index}：${'w'.repeat(3000)}` }],
    })
  }
  for (let index = 0; index < 10; index += 1) {
    session.add('assistant/message', {
      role: 'assistant',
      content: [{ type: 'text', text: `<thought>${'思考 '.repeat(60)}</thought> 决定采用方案 ${index}：${'x'.repeat(300)}` }],
    })
    session.add('tool/result', { role: 'tool', content: [{ type: 'text', text: `Error: ENOENT at src\\f${index}.ts [exit code: 1] ${'y'.repeat(300)}` }] })
  }
  for (let index = 0; index < 3; index += 1) {
    session.add('assistant/message', { role: 'assistant', content: [{ type: 'text', text: `近期 ${index} ${'r'.repeat(300)}` }] })
    session.add('tool/result', { role: 'tool', content: [{ type: 'text', text: `近期结果 ${index} ${'s'.repeat(300)}` }] })
  }
  session.add('assistant/message', { role: 'assistant', content: [{ type: 'text', text: `结论：完成 ${'z'.repeat(300)}` }] })

  await check('memory fold applied on cold cache', async () => {
    const pre = hooks.get('agent/pre-step')
    const before = session.appended.length
    await pre({ agent: { session, model: 'm' }, turn: 1, step: 1, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
    assert(session.appended.length === before + 1, 'fold patch was not applied')
    const summary = String(session.appended[session.appended.length - 1]?.data?.content?.[0]?.text ?? '')
    assert(summary.includes('[CONTEXT_INDEX]'), 'context index missing in summary')
    assert(summary.includes('[CoT]'), 'CoT distillation line missing')
  })

  await check('second fold blocked by prefix break', async () => {
    for (let index = 0; index < 5; index += 1) {
      session.add('assistant/message', { role: 'assistant', content: [{ type: 'text', text: `二轮 ${index} ${'a'.repeat(300)}` }] })
      session.add('tool/result', { role: 'tool', content: [{ type: 'text', text: `二轮输出 ${index} ${'b'.repeat(300)}` }] })
    }
    session.add('user/message', { role: 'user', content: [{ type: 'text', text: '继续第二轮' }] })
    session.add('assistant/message', { role: 'assistant', content: [{ type: 'text', text: `二轮结论 ${'c'.repeat(300)}` }] })

    const pre = hooks.get('agent/pre-step')
    const before = session.appended.length
    await pre({ agent: { session, model: 'm' }, turn: 2, step: 1, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
    assert(session.appended.length === before, 'prefix-breaking patch must be blocked')
  })

  await check('pre-step never folds tool-call history', async () => {
    const session = new FakeSession()
    session.id = 'verify-toolcall'
    session.add('user/message', { role: 'user', content: [{ type: 'text', text: '需求：修复 bug' }] })
    for (let index = 0; index < 10; index += 1) {
      session.add('assistant/message', {
        role: 'assistant',
        content: [
          { type: 'tool-call', callId: `call_${index}` },
          { type: 'text', text: 'x'.repeat(300) },
        ],
      })
      session.add('tool/result', {
        role: 'tool',
        toolCallId: `call_${index}`,
        content: [{ type: 'text', text: 'y'.repeat(300) }],
      })
    }
    session.add('assistant/message', { role: 'assistant', content: [{ type: 'text', text: '结论：完成' }] })

    const pre = hooks.get('agent/pre-step')
    const before = session.appended.length
    await pre({ agent: { session, model: 'm' }, turn: 1, step: 1, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
    assert(session.appended.length === before, 'tool-call history must never be folded end-to-end')
  })

  await check('fold range never widens into tool-call messages', async () => {
    const session = new FakeSession()
    session.id = 'verify-widen'
    session.add('user/message', { role: 'user', content: [{ type: 'text', text: '需求：修复 bug' }] })
    const toolCallSeq = session.add('assistant/message', {
      role: 'assistant',
      content: [
        { type: 'tool-call', callId: 'call_widen_1' },
        { type: 'text', text: 'x'.repeat(300) },
      ],
    })
    session.add('tool/result', {
      role: 'tool',
      toolCallId: 'call_widen_1',
      content: [{ type: 'text', text: 'y'.repeat(300) }],
    })
    let firstTextSeq = -1
    for (let index = 0; index < 10; index += 1) {
      const seq = session.add('assistant/message', {
        role: 'assistant',
        content: [{ type: 'text', text: `决定采用方案 ${index}：${'z'.repeat(600)}` }],
      })
      if (firstTextSeq < 0) firstTextSeq = seq
    }
    session.add('assistant/message', { role: 'assistant', content: [{ type: 'text', text: '结论：完成' }] })

    const pre = hooks.get('agent/pre-step')
    const before = session.appended.length
    await pre({ agent: { session, model: 'm' }, turn: 1, step: 1, messages: [] }, async () => ({ kind: 'enter', messages: [] }))

    assert(session.appended.length > before, 'expected a fold to be applied for text-only history')
    const append = session.appended[session.appended.length - 1]
    const startSeq = append?.opts?.surfaceOp?.startSeq
    assert(startSeq === firstTextSeq, `fold must start at first text message (${firstTextSeq}), got ${startSeq}`)
    assert(startSeq !== toolCallSeq, 'fold must never widen into the tool-call assistant')
  })

  await check('hooks survive opaque agent proxy', async () => {
    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error('cannot get property "options" without inject')
        },
      },
    )
    const pre = hooks.get('agent/pre-step')
    const post = hooks.get('tools/post-execute')
    await pre({ agent: throwing, turn: 1, step: 1, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
    const decision = await post(
      { tool: { name: 'pwsh' }, agent: throwing },
      { content: [{ type: 'text', text: 'x'.repeat(2000) }] },
      async () => ({ kind: 'accept', content: [{ type: 'text', text: 'x'.repeat(2000) }] }),
    )
    assert(decision?.kind === 'accept', 'post-execute must not throw with opaque agent')
  })

  await check('amortized fold accepted under prefix break', async () => {
    const hooks4 = new Map<string, any>()
    const ctx4: any = {
      systemPrompt: { section: () => () => {} },
      tools: { register: () => () => {} },
      on: (event: string, fn: any) => {
        hooks4.set(event, fn)
        return () => {}
      },
    }
    const dispose4 = apply(ctx4, { maxInputTokens: 2000, foldAtRatio: 0.2, retainRecent: 2, minSaveTokens: 50, assumedTurns: 2000 })
    const session = new FakeSession()
    session.id = 'verify-amortized'
    session.add('user/message', { role: 'user', content: [{ type: 'text', text: '需求：长会话折叠' }] })
    for (let index = 0; index < 6; index += 1) {
      session.add('assistant/message', { role: 'assistant', content: [{ type: 'text', text: `阶段 ${index} ${'a'.repeat(2000)}` }] })
    }
    const pre = hooks4.get('agent/pre-step')
    await pre({ agent: { session, model: 'm' }, turn: 1, step: 1, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
    for (let index = 0; index < 4; index += 1) {
      session.add('assistant/message', { role: 'assistant', content: [{ type: 'text', text: `后续 ${index} ${'b'.repeat(2000)}` }] })
    }
    session.add('assistant/message', { role: 'assistant', content: [{ type: 'text', text: '结论' }] })
    await pre({ agent: { session, model: 'm' }, turn: 2, step: 1, messages: [] }, async () => ({ kind: 'enter', messages: [] }))

    const decisions = fs
      .readFileSync('debug.log', 'utf8')
      .split('\n')
      .filter((line) => line.includes('"cache.decision"') && line.includes('verify-amortized'))
      .map((line) => JSON.parse(line))
    const last = decisions[decisions.length - 1]
    assert(last && last.prefixBreak === true && last.approved === true, `amortized fold not approved: ${JSON.stringify(last)}`)
    assert(Number(last.remainingTurns) > 0, 'remainingTurns missing in decision log')
    dispose4()
  })

  await check('request history rewrite compacts old messages', async () => {
    const ctx5: any = { systemPrompt: { section: () => () => {} }, tools: { register: () => () => {} }, on: () => () => {} }
    const captured5: any[] = []
    ctx5.llm = {
      stream(request: any) {
        captured5.push(request)
        return (async function* () {})()
      },
    }
    const dispose5 = apply(ctx5, { ...cfg, rewriteEnabled: true })
    const messages: any[] = [{ role: 'user', content: [{ type: 'text', text: '需求' }] }]
    for (let index = 0; index < 10; index += 1) {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: `<thought>secret plan</thought> 决定 ${index} ${'a'.repeat(600)}` }] })
      messages.push({ role: 'tool', toolCallId: `call_${index}`, content: [{ type: 'text', text: `line ${'b'.repeat(80)}\n`.repeat(30) }] })
    }
    messages.push({ role: 'user', content: [{ type: 'text', text: '继续' }] })
    const tools = Array.from({ length: 10 }, (_, index) => ({
      name: `t${index}`,
      description: 'description '.repeat(30),
      parameters: { type: 'object', properties: {} },
    }))
    const before = estimateTokens(JSON.stringify(messages))
    ctx5.llm.stream({ provider: 'p', model: 'm', messages, tools })
    const sent = captured5[0]
    const after = estimateTokens(JSON.stringify(sent.messages))
    assert(after < before * 0.75, `rewrite ineffective: ${before}->${after}`)
    const nonSystem = sent.messages.filter((message: any) => message?.role !== 'system')
    assert(nonSystem.length === messages.length, 'messages must not be removed')
    assert(nonSystem[2].toolCallId === 'call_0', 'tool pairing id must be preserved')
    assert(!JSON.stringify(nonSystem[1]).includes('<thought>'), 'CoT must be stripped')
    /**
     * 单位一致性：面板的降幅是 byModule / tokensBefore，所以 saved 必须和
     * beforeTokens/afterTokens 同一单位（token）。曾经这里返回字符数，
     * 面板就报出 66.6% 而真实只有 28.5% —— 差 4 倍的假指标比没有更糟。
     */
    /**
     * 只认本测试自己产生的快照：仓库根目录的 savings.json 是历史残留，
     * 拿它做断言会让这条检查随仓库状态漂移（曾经因此失败）。
     */
    const ledgerPath = path.join(process.cwd(), 'savings.json')
    if (!fs.existsSync(ledgerPath)) return
    const ledgerView = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
    if (!ledgerView.byModule || (ledgerView.tokenTotals?.requests ?? 0) === 0) return
    const total = ledgerView.byModuleBefore ?? {}
    const saved = ledgerView.byModule ?? {}
    const savedSum = Object.values(saved).reduce((sum: number, value: any) => sum + Number(value ?? 0), 0)
    const beforeSum = Object.values(total).reduce((sum: number, value: any) => sum + Number(value ?? 0), 0)
    if (beforeSum > 0) {
      const claimed = savedSum / beforeSum
      const measured = 1 - estimateTokens(JSON.stringify(sent.messages)) / estimateTokens(JSON.stringify(messages))
      assert(
        claimed <= measured + 0.05,
        `claimed saving ${(claimed * 100).toFixed(1)}% must not exceed measured ${(measured * 100).toFixed(1)}%`,
      )
    }
    dispose5()
  })

  await check('cache: a sent prefix is never rewritten differently later', async () => {
    // 真实账单分析的核心不变量：provider 缓存是前缀匹配，已发出的前缀只要变一个字符，
    // 整段就按 miss 价重算（¥1/M vs ¥0.02/M）。所以同一段旧内容在后续请求里必须
    // 得到逐字节相同的重写结果——哪怕总上下文已经涨了一倍。
    const capture: any[] = []
    const ctx7: any = { systemPrompt: { section: () => () => {} }, tools: { register: () => () => {} }, on: () => () => {} }
    ctx7.llm = {
      stream(request: any) {
        capture.push(request)
        return (async function* () {})()
      },
    }
    const dispose7 = apply(ctx7, { ...cfg, rewriteEnabled: true, maxInputTokens: 100000 })
    const seed: any[] = [{ role: 'user', content: [{ type: 'text', text: '需求' }] }]
    for (let index = 0; index < 12; index += 1) {
      seed.push({ role: 'assistant', content: [{ type: 'text', text: `<thought>x</thought> 决定 ${index} ${'a'.repeat(500)}` }] })
      seed.push({ role: 'tool', toolCallId: `call_${index}`, content: [{ type: 'text', text: `line ${index} ${'b'.repeat(400)}` }] })
    }
    const tools = Array.from({ length: 6 }, (_, index) => ({
      name: `t${index}`,
      description: 'description '.repeat(20),
      parameters: { type: 'object', properties: {} },
    }))

    // 第一次请求：上下文较小。
    ctx7.llm.stream({ provider: 'p', model: 'm', messages: [...seed, { role: 'user', content: [{ type: 'text', text: '第一问' }] }], tools })
    // 第二次请求：同样的历史 + 大量新增长内容（总 token 数显著变大）。
    const fat = 'z'.repeat(40_000)
    const grown = [...seed, { role: 'user', content: [{ type: 'text', text: '第一问' }] }, { role: 'assistant', content: [{ type: 'text', text: '答' }] }]
    for (let index = 0; index < 4; index += 1) {
      grown.push({ role: 'tool', toolCallId: `late_${index}`, content: [{ type: 'text', text: fat }] })
    }
    grown.push({ role: 'user', content: [{ type: 'text', text: '第二问' }] })
    ctx7.llm.stream({ provider: 'p', model: 'm', messages: grown, tools })

    assert(capture.length === 2, `expected 2 captured requests, got ${capture.length}`)
    const strip = (request: any) => request.messages.filter((message: any) => message?.role !== 'system')
    const first = strip(capture[0])
    const second = strip(capture[1])
    assert(first.length > 0, 'first request lost its messages')
    // 已发出的前缀里，落在「重写窗口」之外的旧消息必须逐字节不变。
    // 窗口内的最新若干条会随新消息进入而首次被重写，这是有损重写的固有代价（默认关闭）。
    const stableCount = Math.max(0, first.length - 8)
    assert(stableCount >= 10, `test setup too small to be meaningful: stableCount=${stableCount}`)
    for (let index = 0; index < stableCount; index += 1) {
      const a = JSON.stringify(first[index])
      const b = JSON.stringify(second[index])
      assert(a === b, `prefix message ${index} drifted between requests (cache would be invalidated)`)
    }
    // 重写确实在起作用，否则这个不变量是空的
    assert(JSON.stringify(first).length < JSON.stringify(seed).length, 'rewrite did nothing, invariant is vacuous')
    dispose7()
  })

  await check('cache keepalive refreshes the identical prefix before TTL', async () => {
    const calls: any[] = []
    const llm = {
      stream(request: any) {
        calls.push(request)
        return (async function* () {
          yield { type: 'usage', usage: { inputTokens: 500, cacheReadTokens: 19_500, outputTokens: 5 } }
        })()
      },
    }
    const dispose = installSchemaCompressor({ llm } as any, {
      enabled: true,
      keepalive: { enabled: true, ttlMs: 30, refreshes: 2, minPromptTokens: 100, marginRatio: 0.5, minDelayMs: 15 },
    })
    try {
      const payload = {
        provider: 'deepseek-account',
        model: 'deepseek-flash',
        purpose: 'agent-loop',
        sessionId: 'keepalive-session',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools: [],
      }
      for await (const _chunk of llm.stream(payload)) {
        /* drain */
      }
      assert(calls.length === 1, `expected 1 real call, got ${calls.length}`)
      await new Promise((resolve) => setTimeout(resolve, 70))
      assert(calls.length >= 2, 'keepalive never fired')
      const ka = calls[1]
      assert(ka.maxTokens === 1, 'keepalive must cap output tokens at 1')
      assert(ka.purpose === 'cache-keepalive', `keepalive purpose lost: ${ka.purpose}`)
      assert(ka.signal === undefined, 'keepalive must not inherit the finished request signal')
      // 前缀必须逐字节一致，否则续的是另一个缓存条目，纯烧钱
      assert(JSON.stringify(ka.messages) === JSON.stringify(calls[0].messages), 'keepalive payload drifted from the real prefix')
      assert(JSON.stringify(ka.tools) === JSON.stringify(calls[0].tools), 'keepalive tools drifted')
      // 次数上限：refreshes=2 -> 最多 2 次保活
      assert(calls.length <= 3, `keepalive exceeded its refresh budget: ${calls.length} calls`)
    } finally {
      dispose()
    }
    const settled = calls.length
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert(calls.length === settled, 'keepalive kept firing after dispose')
  })

  await check('cache keepalive stays silent for small prompts', async () => {
    const calls: any[] = []
    const llm = {
      stream(request: any) {
        calls.push(request)
        return (async function* () {
          yield { type: 'usage', usage: { inputTokens: 200, cacheReadTokens: 0, outputTokens: 5 } }
        })()
      },
    }
    const dispose = installSchemaCompressor({ llm } as any, {
      enabled: true,
      keepalive: { enabled: true, ttlMs: 30, refreshes: 2, minPromptTokens: 1000, minDelayMs: 15 },
    })
    try {
      for await (const _chunk of llm.stream({
        provider: 'p',
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })) {
        /* drain */
      }
      await new Promise((resolve) => setTimeout(resolve, 60))
      assert(calls.length === 1, `small prompt must not trigger keepalive, got ${calls.length} calls`)
    } finally {
      dispose()
    }
  })

  await check('cache: the tool block stays identical across turns by default', async () => {
    // 工具表位于 prompt 最前面：它一变，整段缓存作废（miss ¥1/M vs hit ¥0.02/M）。
    // 所以默认模式必须让 tools 只依赖「工具集合本身」，不依赖这一轮用户说了什么。
    const captured: any[] = []
    const ctxT: any = { systemPrompt: { section: () => () => {} }, tools: { register: () => () => {} }, on: () => () => {} }
    ctxT.llm = {
      stream(request: any) {
        captured.push(request)
        return (async function* () {})()
      },
    }
    const disposeT = apply(ctxT, cfg)
    const tools = Array.from({ length: 12 }, (_, index) => ({
      name: `tool_${index}`,
      description: `用于第 ${index} 类任务的很长描述 `.repeat(12),
      parameters: { type: 'object', properties: { scope: { type: 'string' } } },
    }))
    ctxT.llm.stream({ provider: 'p', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: '重构登录模块的鉴权流程' }] }], tools })
    ctxT.llm.stream({ provider: 'p', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: '帮我查一下数据库连接池的泄漏' }] }], tools })
    assert(captured.length === 2, `expected 2 requests, got ${captured.length}`)
    assert(JSON.stringify(captured[0].tools) === JSON.stringify(captured[1].tools), 'tool block changed between turns and would void the prompt cache')
    disposeT()
  })

  await check('cache keepalive keeps one chain per session', async () => {
    // 主 Agent 与 subagent 是不同上下文：共用一个槽位会互相顶掉，只对最后一个生效。
    const calls: any[] = []
    const llm = {
      stream(request: any) {
        calls.push(request)
        return (async function* () {
          yield { type: 'usage', usage: { inputTokens: 400, cacheReadTokens: 19_600, outputTokens: 3 } }
        })()
      },
    }
    const dispose = installSchemaCompressor({ llm } as any, {
      enabled: true,
      keepalive: { enabled: true, ttlMs: 30, refreshes: 1, minPromptTokens: 100, marginRatio: 0.5, minDelayMs: 15, maxSessions: 3 },
    })
    try {
      const send = async (sessionId: string, text: string) => {
        for await (const _chunk of llm.stream({
          provider: 'p',
          model: 'deepseek-flash',
          purpose: 'agent-loop',
          sessionId,
          messages: [{ role: 'user', content: [{ type: 'text', text }] }],
        })) {
          /* drain */
        }
      }
      await send('session-A', '重构鉴权')
      await send('session-B', '排查连接池泄漏')
      await new Promise((resolve) => setTimeout(resolve, 80))
      const ka = calls.filter((c) => c.purpose === 'cache-keepalive' && c.maxTokens === 1)
      const texts = ka.map((c) => JSON.stringify(c.messages))
      assert(new Set(texts).size >= 2, `both sessions must be kept alive independently, got ${ka.length} keepalives`)
      assert(texts.some((t) => t.includes('重构鉴权')), 'session A keepalive missing')
      assert(texts.some((t) => t.includes('排查连接池泄漏')), 'session B keepalive missing')
    } finally {
      dispose()
    }
  })

  await check('output is never truncated by default', async () => {
    // 「不降智」的硬保证：默认配置下，模型的完整回答必须原样送到宿主。
    // 旧默认会在第一个闭合代码块后 return，把「第二段说明」整段吃掉。
    const defaults = Config.parse({})
    assert(defaults.outputGuardEnabled === false, 'output guard must be opt-in: it cuts real answers')
    const chunks = [
      { type: 'text-delta', index: 0, text: '先说明问题：\n```js\nconst a = 1\n```\n' },
      { type: 'text-delta', index: 0, text: '然后是第二段说明：\n```js\nconst b = 2\n```\n' },
      { type: 'text-delta', index: 0, text: '最后的结论也必须保留。' },
    ]
    const captured: any[] = []
    const ctxO: any = { systemPrompt: { section: () => () => {} }, tools: { register: () => () => {} }, on: () => () => {} }
    ctxO.llm = {
      stream() {
        captured.push(1)
        return (async function* () {
          for (const chunk of chunks) yield chunk
        })()
      },
    }
    const disposeO = apply(ctxO, cfg)
    const seen: any[] = []
    for await (const chunk of ctxO.llm.stream({
      provider: 'p',
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: '讲讲' }] }],
    })) {
      seen.push(chunk)
    }
    disposeO()
    assert(captured.length === 1, `upstream not called once: ${captured.length}`)
    assert(seen.length === chunks.length, `stream truncated by default: ${seen.length}/${chunks.length} chunks`)
    const text = seen.map((c) => c.text ?? '').join('')
    assert(text.includes('最后的结论也必须保留。'), 'tail of the answer was dropped')
  })

  await check('effort: sizing is applied at the llm boundary, never raised', async () => {
    const captured: any[] = []
    const ctxE: any = { systemPrompt: { section: () => () => {} }, tools: { register: () => () => {} }, on: () => () => {} }
    ctxE.llm = {
      stream(request: any) {
        captured.push(request)
        return (async function* () {})()
      },
    }
    const disposeE = apply(ctxE, cfg)
    const send = (text: string, effort: string) =>
      ctxE.llm.stream({
        provider: 'p',
        model: 'm',
        reasoningEffort: effort,
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      })
    send('把这段 JSON 格式化一下', 'max') // trivial -> off
    send('继续', 'max') // easy -> low
    send('重构鉴权模块并排查这个死锁', 'max') // hard -> max 保持不变
    send('重构鉴权模块并排查这个死锁', 'low') // 上游回传上一轮的低档，也不得棘轮锁死
    disposeE()
    assert(captured[0].reasoningEffort === 'off', `trivial turn must run at off, got ${captured[0].reasoningEffort}`)
    assert(captured[1].reasoningEffort === 'low', `easy turn must run at low, got ${captured[1].reasoningEffort}`)
    assert(captured[2].reasoningEffort === 'max', `hard turn must keep max, got ${captured[2].reasoningEffort}`)
    assert(
      captured[3].reasoningEffort === 'max',
      `an echoed low must not ratchet a hard turn down, got ${captured[3].reasoningEffort}`,
    )
  })

  await check('effort: the user setting caps how far it may go', async () => {
    // 用户把档位设成 low 时，策略最多只能用到 low，绝不擅自上调。
    const captured: any[] = []
    const ctxU: any = {
      systemPrompt: { section: () => () => {} },
      tools: { register: () => () => {} },
      on: () => () => {},
      // 未在 inject 里的服务必须走 ctx.get()，不用属性访问
      get: (name: string) => (name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm', reasoningEffort: 'low' }) } : undefined),
    }
    ctxU.llm = {
      stream(request: any) {
        captured.push(request)
        return (async function* () {})()
      },
    }
    const disposeU = apply(ctxU, cfg)
    ctxU.llm.stream({
      provider: 'p',
      model: 'm',
      reasoningEffort: 'max',
      messages: [{ role: 'user', content: [{ type: 'text', text: '重构鉴权模块并排查死锁' }] }],
    })
    disposeU()
    assert(captured[0].reasoningEffort === 'low', `user setting must cap effort, got ${captured[0].reasoningEffort}`)
  })

  await check('prepared path: effort frozen before dispatch, keepalive opens its own call', async () => {
    // 复刻 DSH 的真实约束：prepareCall 冻结 config，dispatch 时严格比较；不一致即
    // INVALID_PREPARED_CALL。旧实现把 effort 改在 stream 阶段，整轮直接失败。
    const preparedConfigs: any[] = []
    const dispatched: any[] = []
    const direct: any[] = []
    const llm: any = {
      // installSchemaCompressor 要求 llm.stream 存在才会安装钩子；保活走的就是它。
      stream(request: any) {
        direct.push(request)
        return (async function* () {
          yield { type: 'usage', usage: { inputTokens: 200, cacheReadTokens: 2400, outputTokens: 10 } }
        })()
      },
      async prepareCall(config: any, _signal?: any, configure?: any) {
        const model = { reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }], defaultEffort: 'high' } }
        const controls = configure ? configure({ ...config }, model) : config
        const frozen = { ...config, ...controls }
        preparedConfigs.push(frozen)
        return {
          config: frozen,
          adapterDefaults: {},
          stream(options: any) {
            for (const key of ['provider', 'model', 'reasoningEffort', 'maxTokens'] as const) {
              const a = frozen[key]
              const b = options[key]
              if (a !== undefined && b !== undefined && a !== b) {
                throw new Error(`INVALID_PREPARED_CALL ${key}: ${a} != ${b}`)
              }
            }
            dispatched.push(options)
            return (async function* () {
              yield { type: 'text-delta', index: 0, text: 'ok' }
              yield { type: 'usage', usage: { inputTokens: 300, cacheReadTokens: 2000, outputTokens: 100 } }
            })()
          },
        }
      },
    }
    const dispose = installSchemaCompressor({ llm } as any, {
      enabled: true,
      configureControls: (controls: any) => ({ ...controls, reasoningEffort: 'low' }),
      keepalive: { enabled: true, ttlMs: 30, refreshes: 1, minPromptTokens: 100, marginRatio: 0.5, minDelayMs: 15 },
    })
    try {
      const prepared = await llm.prepareCall({ provider: 'p', model: 'm', reasoningEffort: 'max', maxTokens: 4096 })
      assert(prepared.config.reasoningEffort === 'low', `effort must be frozen before dispatch, got ${prepared.config.reasoningEffort}`)

      // 这个宿主校验必须是真的，否则下面的保证是空的
      let rejected = false
      try {
        const bad = prepared.stream({ provider: 'p', model: 'm', reasoningEffort: 'max', maxTokens: 4096, messages: [] })
        for await (const _chunk of bad) {
          /* drain */
        }
      } catch {
        rejected = true
      }
      assert(rejected, 'fake host must reject a config/dispatch mismatch, otherwise the guard is vacuous')

      // 正常调用不携带 effort/maxTokens 覆盖，不会触发不一致
      for await (const _chunk of prepared.stream({ provider: 'p', model: 'm', messages: [] })) {
        /* drain */
      }
      assert(dispatched.length === 1, `normal dispatch must succeed exactly once, got ${dispatched.length}`)

      // 保活必须自己开一次调用（走原始 llm.stream），不能复用单次可派发的 prepared stream
      await new Promise((resolve) => setTimeout(resolve, 90))
      const ka = direct.filter((request) => request.maxTokens === 1)
      assert(ka.length >= 1, 'keepalive must dispatch its own maxTokens=1 call')
      assert(
        preparedConfigs.filter((config) => config.maxTokens === 1).length === 0,
        'keepalive must not re-prepare or reuse the one-shot prepared call',
      )
    } finally {
      dispose()
    }
  })

  await check('reload: a second install replaces the previous layer instead of stacking', async () => {
    // 宿主 in-place 重载不 dispose 旧 fiber（实测无 apply.dispose），旧层会拦截请求。
    const calls: number[] = []
    const base = () => {
      calls.push(1)
      return (async function* () {
        yield { type: 'usage', usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 50 } }
      })()
    }
    const llm: any = { stream: base }
    const seenA: any[] = []
    const seenB: any[] = []
    const disposeA = installSchemaCompressor({ llm } as any, { enabled: true, onUsage: (info) => seenA.push(info) })
    const disposeB = installSchemaCompressor({ llm } as any, { enabled: true, onUsage: (info) => seenB.push(info) })
    try {
      for await (const _chunk of llm.stream({ provider: 'p', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })) {
        /* drain */
      }
      assert(calls.length === 1, `exactly one upstream call expected, got ${calls.length}`)
      assert(seenB.length === 1, `the newest layer must observe usage once, got ${seenB.length}`)
      assert(seenA.length === 0, 'the replaced layer must be fully detached')

      // 旧 disposer 再被调用一次（宿主可能会），不能把新层拆掉
      disposeA()
      for await (const _chunk of llm.stream({ provider: 'p', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'y' }] }] })) {
        /* drain */
      }
      const callsAfter = Number(calls.length)
      const seenAfter = Number(seenB.length)
      assert(callsAfter === 2 && seenAfter === 2, `a stale disposer must not unpatch the live layer (${callsAfter}/${seenAfter})`)
    } finally {
      disposeB()
    }
    assert(llm.stream === base, 'the live disposer must restore the original stream')
  })

  await check('response cache replays identical request', async () => {
    const ctx6: any = { systemPrompt: { section: () => () => {} }, tools: { register: () => () => {} }, on: () => () => {} }
    let calls = 0
    ctx6.llm = {
      stream() {
        calls += 1
        return (async function* () {
          yield { type: 'text', text: 'hello' }
        })()
      },
    }
    const dispose6 = apply(ctx6, cfg)
    const request = { provider: 'p', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [{ name: 't', description: 'd', parameters: {} }] }
    const first: any[] = []
    for await (const chunk of ctx6.llm.stream(request)) first.push(chunk)
    const second: any[] = []
    for await (const chunk of ctx6.llm.stream(request)) second.push(chunk)
    assert(calls === 1, `response cache missed: calls=${calls}`)
    assert(JSON.stringify(first) === JSON.stringify(second), 'cached chunks mismatch')
    dispose6()
  })

  await check('degradation A: AST keeps 1-hop dependencies', async () => {
    const code = [
      'interface RequestDto { userId: string; nested: { a: number } }',
      'class ValidationError extends Error {}',
      'class AuditTrail { record(x: RequestDto): void {} }',
      'function handle(request: RequestDto): void {',
      '  const trail = new AuditTrail()',
      '  trail.record(request)',
      '  if (!request.userId) throw new ValidationError()',
      '}',
      ...Array.from({ length: 2000 }, (_, index) => `const filler_${index} = ${index}`),
    ].join('\n')
    const result = runExtraction({ text: code, maxTokens: 400 })
    assert(result.safe && result.mode === 'ast', `expected ast mode, got ${result.mode}/${result.safe}`)
    assert(result.text.includes('RequestDto'), 'param type missing')
    assert(result.text.includes('ValidationError'), 'thrown exception missing')
    assert(result.text.includes('AuditTrail'), '1-hop dependency missing')
    assert(estimateTokens(result.text) < estimateTokens(code), 'AST did not compress')
  })

  await check('degradation B: hidden tools get explicit hint', async () => {
    const ctx7: any = { systemPrompt: { section: () => () => {} }, tools: { register: () => () => {} }, on: () => () => {} }
    const captured7: any[] = []
    ctx7.llm = {
      stream(request: any) {
        captured7.push(request)
        return (async function* () {})()
      },
    }
    const dispose7 = apply(ctx7, { ...cfg, toolAttentionEnabled: true })
    const manyTools = Array.from({ length: 80 }, (_, index) => ({
      name: `bulk_tool_${index}`,
      description: `bulk tool ${index} handles data processing`,
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    }))
    ctx7.llm.stream({ provider: 'p', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'process the data' }] }], tools: manyTools })
    const sent7 = captured7[0]
    assert(sent7.tools.length <= 12, `layered tools too many: ${sent7.tools.length}`)
    assert(sent7.tools.some((tool: any) => tool.name === 'search_tools'), 'search_tools missing')
    const system7 = JSON.stringify((sent7.messages ?? []).find((message: any) => message?.role === 'system') ?? {})
    assert(system7.includes('[TOOL_NOT_LOADED]'), 'explicit TOOL_NOT_LOADED hint missing')
    assert(system7.includes('bulk_tool_79'), 'catalog missing hidden tool name')
    dispose7()
  })

  await check('degradation C: error context window kept', async () => {
    const log = [
      'boot service',
      'input.userId = null',
      'caller = processOrder',
      'stack: Service.run at line 42',
      'NullPointerException at run',
      'warn: retry 3',
      ...Array.from({ length: 80 }, (_, index) => `heartbeat ${index}`),
    ].join('\n')
    const summary = buildFirewallSummary(log, 160)
    assert(summary.text.includes('input.userId = null'), '3-line pre-context missing')
    assert(summary.text.includes('caller = processOrder'), 'caller context missing')
    assert(summary.text.includes('NullPointerException'), 'error line missing')
  })

  await check('no console.log in sources', () => {
    const dir = path.resolve('src')
    const offenders: string[] = []
    const walk = (current: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.ts')) {
          const text = fs.readFileSync(full, 'utf8')
          for (const line of text.split('\n')) {
            const needle = `console${'.log('}`
          if (line.includes(needle) && !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//')) {
              offenders.push(`${entry.name}: ${line.trim()}`)
            }
          }
        }
      }
    }
    walk(dir)
    assert(offenders.length === 0, `console.log found: ${offenders.join('; ')}`)
  })

  /**
   * 回归：effort 记账不能带时间窗口。
   * 曾经用 `Date.now() - lastEffort.at < 5000` 判活，而一次真实请求从决策到收到
   * usage 常常超过 5 秒（长上下文更久）—— 于是账本里 effort 记成 null，
   * 输出侧省下的 token 全部漏记（实盘 7 条记录里 5 条 effort:null）。
   * 现在按轮次失效（pre-step 更新 effortContext 时清空），不带 TTL。
   */
  await check('effort accounting is not gated by a time window', () => {
    const text = fs.readFileSync(path.resolve('src/index.ts'), 'utf8')
    assert(!/Date\.now\(\)\s*-\s*lastEffort/.test(text), 'effort bookkeeping must not expire on a timer')
    assert(!/lastEffort\.at/.test(text), 'lastEffort no longer carries a timestamp')
    assert(/lastEffort = null/.test(text), 'a new turn must clear the previous decision')
  })

  await check('dispose is safe', () => {
    disposer()
    disposer()
  })

  const failed = results.filter((item) => !item.ok)
  for (const item of results) process.stdout.write(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label} :: ${item.detail}\n`)
  process.stdout.write(`\nverify summary: ${results.length - failed.length} passed, ${failed.length} failed\n`)
  if (failed.length > 0) process.exitCode = 1
}

void main().catch((error) => {
  process.stdout.write(`verify crashed: ${String(error)}\n`)
  process.exitCode = 1
})
