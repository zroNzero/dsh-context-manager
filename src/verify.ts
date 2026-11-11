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

  const disposer = apply(ctx, cfg)

  await check('apply registers prompt section/tool/hooks', () => {
    assert(sections.some((section) => section.order === 46), 'section order 46 missing')
    assert(tools.some((tool) => tool.name === 'costkiller_status'), 'status tool missing')
    assert(hooks.has('tools/post-execute'), 'post-execute hook missing')
    assert(hooks.has('agent/pre-step'), 'pre-step hook missing')
    assert(typeof disposer === 'function', 'apply must return disposer')
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
    assert(sent.tools.length <= 6, `tool attention expected <=6 tools, got ${sent.tools.length}`)
    const systemText = JSON.stringify((sent.messages ?? []).find((message: any) => message?.role === 'system') ?? {})
    assert(systemText.includes('[TOOL_CATALOG]'), 'tool catalog missing from system message')
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
    const dispose5 = apply(ctx5, cfg)
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
    dispose5()
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
