// Real-bill analyzer: derives the ACTUAL provider billing from a DSH session log.
// No estimates: every number comes from provider-reported usage (assistant/message.usage).
import { readSessionEvents } from './session-decode.mjs';

// Official DeepSeek RMB prices per 1M tokens (peak / offpeak), mirroring src/modules/pricing.ts.
const TABLE = {
  flash: { peak: { hit: 0.04, miss: 2, output: 8 }, offpeak: { hit: 0.02, miss: 1, output: 4 } },
  v4pro: { peak: { hit: 0.3, miss: 9, output: 27 }, offpeak: { hit: 0.15, miss: 4.5, output: 13.5 } },
};

function isPeak(ms) {
  const b = new Date(ms + 8 * 3600 * 1000);
  const day = b.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = b.getUTCHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

function tierOf(model) {
  return String(model ?? '').toLowerCase().includes('pro') ? 'v4pro' : 'flash';
}

export function analyze(sessionFile, opts = {}) {
  const { events } = readSessionEvents(sessionFile);
  // Model per turn comes from request/header; fall back to the session default.
  const modelByTurn = new Map();
  for (const e of events) {
    if (e.type === 'request/header') {
      const cfg = e.data?.header?.config;
      if (cfg?.turn !== undefined) modelByTurn.set(cfg.turn, cfg);
      else if (cfg?.model) modelByTurn.set('*', cfg);
    }
  }
  const rows = [];
  for (const e of events) {
    if (e.type !== 'assistant/message') continue;
    const u = e.data?.usage;
    if (!u) continue;
    const turn = e.data.turn;
    const cfg = modelByTurn.get(turn) ?? modelByTurn.get('*') ?? {};
    const model = opts.model ?? cfg.model ?? 'deepseek-flash';
    const tier = tierOf(model);
    const peak = isPeak(e.time ?? Date.now());
    const p = TABLE[tier][peak ? 'peak' : 'offpeak'];
    const hit = u.cacheReadTokens ?? 0;
    const miss = u.inputTokens ?? 0;
    const out = u.outputTokens ?? 0;
    const costHit = (hit * p.hit) / 1e6;
    const costMiss = (miss * p.miss) / 1e6;
    const costOut = (out * p.output) / 1e6;
    rows.push({ seq: e.seq, turn, step: e.data.step, model, peak, hit, miss, out, costHit, costMiss, costOut, cost: costHit + costMiss + costOut });
  }
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  const total = sum('cost');
  const byTurn = new Map();
  for (const r of rows) {
    const t = byTurn.get(r.turn) ?? { turn: r.turn, requests: 0, hit: 0, miss: 0, out: 0, cost: 0 };
    t.requests++; t.hit += r.hit; t.miss += r.miss; t.out += r.out; t.cost += r.cost;
    byTurn.set(r.turn, t);
  }
  return {
    requests: rows.length,
    rows,
    total,
    costHit: sum('costHit'),
    costMiss: sum('costMiss'),
    costOut: sum('costOut'),
    hit: sum('hit'),
    miss: sum('miss'),
    out: sum('out'),
    cacheHitRate: (() => { const denom = sum('hit') + sum('miss'); return denom ? sum('hit') / denom : 0; })(),
    perTurn: [...byTurn.values()],
  };
}

const cny = (v) => `¥${v.toFixed(4)}`;
const pct = (v) => `${(v * 100).toFixed(1)}%`;

if (process.argv[2]) {
  const a = analyze(process.argv[2]);
  console.log(`requests=${a.requests}  total=${cny(a.total)}`);
  console.log(`tokens: hit=${a.hit} miss=${a.miss} out=${a.out}  cacheHitRate=${pct(a.cacheHitRate)}`);
  console.log(`cost split: hit=${cny(a.costHit)} (${pct(a.costHit / a.total)})  miss=${cny(a.costMiss)} (${pct(a.costMiss / a.total)})  out=${cny(a.costOut)} (${pct(a.costOut / a.total)})`);
  console.log('\nturn  reqs   hitTokens  missTokens  outTokens    cost');
  for (const t of a.perTurn) {
    console.log(`${String(t.turn).padStart(4)} ${String(t.requests).padStart(5)} ${String(t.hit).padStart(11)} ${String(t.miss).padStart(11)} ${String(t.out).padStart(10)} ${cny(t.cost).padStart(11)}`);
  }
}
