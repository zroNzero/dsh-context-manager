/**
 * SavingsLedger —— Token 节省账本（面板数据源）。
 *
 * 所有节省事件统一记账：Admission / Extraction / Dedup / Fold / Schema。
 * 运行期把快照写入 ./savings.json 与 ./savings.md，
 * 面板可以通过工具 costkiller_status 或直接查看 savings.md 获取。
 */

export type SavingsModule = 'admission' | 'extraction' | 'dedup' | 'fold' | 'schema'

export interface SavingsEvent {
  ts: string
  module: SavingsModule
  tokens: number
  detail: string
}

export interface SavingsSnapshot {
  startedAt: string
  updatedAt: string
  totalSavedTokens: number
  byModule: Record<SavingsModule, number>
  events: number
  folds: number
  rejectedByAnchor: number
  lastEvents: SavingsEvent[]
}

const MAX_EVENTS = 20

export class SavingsLedger {
  private readonly startedAt = Date.now()
  private updatedAt = Date.now()
  private readonly byModule: Record<SavingsModule, number> = {
    admission: 0,
    extraction: 0,
    dedup: 0,
    fold: 0,
    schema: 0,
  }
  private eventCount = 0
  private foldCount = 0
  private rejected = 0
  private readonly lastEvents: SavingsEvent[] = []

  record(module: SavingsModule, tokens: number, detail = ''): void {
    const value = Math.max(0, Math.round(tokens))
    if (value <= 0) return
    this.byModule[module] += value
    this.eventCount += 1
    this.updatedAt = Date.now()
    this.lastEvents.push({ ts: new Date().toISOString(), module, tokens: value, detail })
    if (this.lastEvents.length > MAX_EVENTS) this.lastEvents.shift()
  }

  noteFold(): void {
    this.foldCount += 1
  }

  noteRejected(): void {
    this.rejected += 1
  }

  get total(): number {
    return Object.values(this.byModule).reduce((sum, value) => sum + value, 0)
  }

  snapshot(): SavingsSnapshot {
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      updatedAt: new Date(this.updatedAt).toISOString(),
      totalSavedTokens: this.total,
      byModule: { ...this.byModule },
      events: this.eventCount,
      folds: this.foldCount,
      rejectedByAnchor: this.rejected,
      lastEvents: [...this.lastEvents],
    }
  }

  /** Markdown 面板：按模块汇总 + 最近事件。 */
  renderMarkdown(): string {
    const snapshot = this.snapshot()
    const rows = (Object.keys(snapshot.byModule) as SavingsModule[])
      .map((key) => `| ${key} | ${snapshot.byModule[key]} |`)
      .join('\n')
    const events = snapshot.lastEvents
      .slice(-10)
      .map((event) => `| ${event.ts} | ${event.module} | ${event.tokens} | ${event.detail} |`)
      .join('\n')

    return [
      '# Token Savings',
      '',
      `- updated: ${snapshot.updatedAt}`,
      `- started: ${snapshot.startedAt}`,
      `- total saved tokens: **${snapshot.totalSavedTokens}**`,
      `- events: ${snapshot.events} | folds: ${snapshot.folds} | rejected by CacheAnchor: ${snapshot.rejectedByAnchor}`,
      '',
      '## By module',
      '',
      '| module | tokens saved |',
      '|---|---:|',
      rows,
      '',
      '## Recent events',
      '',
      '| time | module | tokens | detail |',
      '|---|---|---:|---|',
      events || '| - | - | 0 | (no events yet) |',
      '',
    ].join('\n')
  }
}
