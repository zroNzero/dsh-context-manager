// Real-bill analyzer v2, with the two semantics that matter:
//
//  1. `cacheReadTokens` is a CUMULATIVE per-session counter (it rises monotonically
//     across requests). Per-request cache reads are the DELTA of that series.
//     `inputTokens` / `outputTokens` are per request.
//  2. A request that repeats the previous prompt should be served almost entirely
//     from the provider cache (hit price) as long as the prefix is byte-stable and
//     the cache TTL (≈4 min) has not lapsed. Comparing the real bill against that
//     counterfactual isolates the cost of prefix drift and TTL expiry.
//
// Every cost below comes from provider usage × the official RMB price table.
import { readSessionEvents } from './session-decode.mjs';

const TABLE = {
  flash: { peak: { hit: 0.04, miss: 2, output: 8 }, offpeak: { hit: 0.02, miss: 1, output: 4 } },
  v4pro: { peak: { hit: 0.3, miss: 9, output: 27 }, offpeak: { hit: 0.15, miss: 4.5, output: 13.5 } },
};
const TTL_MS = Number(process.env.CACHE_TTL_MS ?? 4 * 60 * 1000);

export const isPeak = (ms) => {
  const b = new Date(ms + 8 * 3600 * 1000);
  const d = b.getUTCDay();
  if (d === 0 || d === 6) return false;
  const h = b.getUTCHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
};
export const pricesFor = (ms, model = 'deepseek-flash') => {
  const tier = /pro/i.test(model) ? 'v4pro' : 'flash';
  return TABLE[tier][isPeak(ms) ? 'peak' : 'offpeak'];
};

export function analyze(file) {
  const { events } = readSessionEvents(file);
  const modelByTurn = new Map();
  let model = 'deepseek-flash';
  for (const e of events) {
    if (e.type === 'request/header') {
      const cfg = e.data?.header?.config;
      if (cfg?.model) {
        model = cfg.model;
        if (cfg.turn !== undefined) modelByTurn.set(cfg.turn, cfg.model);
      }
    }
  }

  const rows = [];
  let prevCumHit = 0;
  let prevTime = 0;
  for (const e of events) {
    if (e.type !== 'assistant/message' || !e.data?.usage) continue;
    const u = e.data.usage;
    const cumHit = u.cacheReadTokens ?? 0;
    // 计数器会随宿主重启重置（实测 296448 -> 5760）：回退时按新序列起算，
    // 直接 max(0, cum - prev) 会把重置后的第一段缓存命中算成 0。
    const hit = cumHit >= prevCumHit ? cumHit - prevCumHit : cumHit;
    prevCumHit = cumHit;
    const miss = u.inputTokens ?? 0;
    const out = u.outputTokens ?? 0;
    const prompt = miss + hit;
    const time = e.time ?? 0;
    const p = pricesFor(time, modelByTurn.get(e.data.turn) ?? model);
    // 只记实测事实：TTL 是否过期（相邻请求间隔 > 4 分钟）不作为收益推断用。
    const ttlAlive = prevTime > 0 && time - prevTime <= TTL_MS;
    const actualCost = (miss * p.miss + hit * p.hit + out * p.output) / 1e6;
    rows.push({ seq: e.seq, turn: e.data.turn, time, prompt, miss, hit, out, actualCost, ttlAlive });
    prevTime = time;
  }

  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  const actual = sum('actualCost');
  return {
    model,
    rows,
    requests: rows.length,
    actual,
    miss: sum('miss'),
    hit: sum('hit'),
    out: sum('out'),
    prompt: sum('prompt'),
    missCost: rows.reduce((a, r) => a + (r.miss * pricesFor(r.time, model).miss) / 1e6, 0),
    hitCost: rows.reduce((a, r) => a + (r.hit * pricesFor(r.time, model).hit) / 1e6, 0),
    outCost: rows.reduce((a, r) => a + (r.out * pricesFor(r.time, model).output) / 1e6, 0),
    cacheHitRate: (() => { const d = sum('hit') + sum('miss'); return d ? sum('hit') / d : 0; })(),
    ttlExpired: rows.filter((r) => !r.ttlAlive).length,
    /** 真实账单里 prompt 侧最多能拿回的比例：整个 prompt 归零时的上限。 */
    promptCeiling: null,
  };
}

const cny = (v) => `¥${v.toFixed(4)}`;
const pct = (v) => `${(v * 100).toFixed(1)}%`;

if (process.argv[2] && import.meta.url.endsWith('billing-report.mjs')) {
  const a = analyze(process.argv[2]);
  const promptCost = a.missCost + a.hitCost;
  console.log(`requests=${a.requests}  model=${a.model}`);
  console.log(`REAL bill      ${cny(a.actual)}`);
  console.log(`tokens: prompt=${a.prompt} (miss ${a.miss} / hit ${a.hit}, hitRate ${pct(a.cacheHitRate)})  output=${a.out}`);
  console.log(`cost: miss ${cny(a.missCost)} (${pct(a.missCost / a.actual)})  hit ${cny(a.hitCost)} (${pct(a.hitCost / a.actual)})  out ${cny(a.outCost)} (${pct(a.outCost / a.actual)})`);
  console.log(`PROMPT CEILING: even if the whole prompt vanished, the bill falls ${pct(promptCost / a.actual)} only`);
  console.log(`ttl-expired gaps=${a.ttlExpired}/${a.requests}`);
}
