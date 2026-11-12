import fs from 'node:fs'

const file = 'src/modules/reasoning-drop.ts'
let text = fs.readFileSync(file, 'utf8')

if (text.includes('probeCacheKey')) {
  console.log('already present')
  process.exit(0)
}

text = text.replace(
  `export interface ReasoningDropResult {`,
  `import { readFileSync as readFs, writeFileSync as writeFs, renameSync as renameFs, mkdirSync } from 'node:fs'
import * as path from 'node:path'

export interface ReasoningDropResult {`,
)

const helpers = `
/**
 * 探针裁决落盘缓存。
 *
 * 探针是异步的（要真发两条短请求）。如果每个进程启动都重新探，那么启动后最初那
 * 几秒发出的请求会用「未剥离」的历史，与之后「已剥离」的历史字节不同：
 *   1. 那几条请求白付一次全量前缀（实测 1.9M 字符 vs 常态 0.8M）；
 *   2. 剥离一生效，前缀当场作废，再冷读一次（实测 miss 54,949 = ¥0.055）。
 * 于是每次重启白付两次冷读，命中率被拉低到 98%。裁决与进程无关，落盘即可只探一次。
 *
 * key 带 provider/model/契约版本：换模型或改剥离逻辑都必须重探。
 */
export interface ProbeCacheEntry {
  key: string
  verdict: ReasoningProbeVerdict
  control: boolean
  stripped: boolean
  at: string
}

export function probeCacheKey(provider: unknown, model: unknown): string {
  return ['v1', String(provider ?? ''), String(model ?? '')].join('|')
}

export function readProbeCache(file: string, key: string): ProbeCacheEntry | null {
  try {
    const raw = JSON.parse(readFs(file, 'utf8')) as any
    if (!raw || raw.key !== key) return null
    if (raw.verdict !== 'allowed' && raw.verdict !== 'denied' && raw.verdict !== 'inconclusive') return null
    return raw as ProbeCacheEntry
  } catch {
    return null
  }
}

export function writeProbeCache(file: string, entry: ProbeCacheEntry): boolean {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    const temp = file + '.tmp'
    writeFs(temp, JSON.stringify(entry, null, 2), 'utf8')
    renameFs(temp, file)
    return true
  } catch {
    return false
  }
}
`

fs.appendFileSync(file, helpers)
console.log('helpers appended')
