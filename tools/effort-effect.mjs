// Effort-effekt measurement: execution steps only, before vs after the policy,
// bucketed by prompt size so context growth does not confound the comparison.
import { readSessionEvents } from './session-decode.mjs';
import { pricesFor } from './billing-report.mjs';

const file = process.argv[2];
const { events } = readSessionEvents(file);
const EFFORT_ON = Date.parse('2026-11-11T12:13:00Z');

let prevCum = 0;
let lastRole = '';
const rows = [];
for (const e of events) {
  if (e.type === 'user/message') { lastRole = 'user'; continue; }
  if (e.type === 'tool/result') { lastRole = 'tool'; continue; }
  if (e.type === 'developer/message' || e.type === 'system/message') { lastRole = 'user'; continue; }
  if (e.type !== 'assistant/message' || !e.data?.usage) continue;
  const u = e.data.usage;
  const cum = u.cacheReadTokens ?? 0;
  const hit = cum >= prevCum ? cum - prevCum : cum;
  prevCum = cum;
  const miss = u.inputTokens ?? 0;
  const out = u.outputTokens ?? 0;
  let reason = 0;
  for (const b of e.data.message?.content ?? []) if (b?.type === 'reasoning') reason += (b.text ?? '').length;
  const p = pricesFor(e.time ?? Date.now());
  rows.push({
    t: e.time ?? 0,
    prompt: miss + hit,
    out,
    reason,
    cost: (miss * p.miss + hit * p.hit + out * p.output) / 1e6,
    before: (e.time ?? 0) < EFFORT_ON,
    execution: lastRole !== 'user',
  });
  lastRole = 'assistant';
}

const bucketOf = (r) => (r.prompt < 2000 ? 'prompt<2k' : r.prompt < 8000 ? '2k-8k' : r.prompt < 30000 ? '8k-30k' : '>=30k');
const stats = (list) => {
  if (!list.length) return null;
  const med = (k) => { const a = list.map((r) => r[k]).sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  const avg = (k) => list.reduce((s, r) => s + r[k], 0) / list.length;
  return { n: list.length, out: Math.round(avg('out')), outMed: med('out'), reason: Math.round(avg('reason')), cost: avg('cost') };
};

console.log('execution steps only, bucketed by prompt size\n');
console.log('bucket      window    n   avgOut  medOut  avgReason  avgCost');
for (const bucket of ['prompt<2k', '2k-8k', '8k-30k', '>=30k']) {
  for (const before of [true, false]) {
    const s = stats(rows.filter((r) => r.execution && bucketOf(r) === bucket && r.before === before));
    if (!s) continue;
    console.log(
      `${bucket.padEnd(10)} ${(before ? 'before' : 'AFTER ').padEnd(7)} ${String(s.n).padStart(3)}  ${String(s.out).padStart(6)}  ${String(s.outMed).padStart(6)}  ${String(s.reason).padStart(9)}  ${('¥' + s.cost.toFixed(5)).padStart(8)}`,
    );
  }
}

const all = (before) => {
  const list = rows.filter((r) => r.execution && r.before === before);
  const s = stats(list);
  if (!s) return null;
  const outMedBefore = stats(rows.filter((r) => r.execution && r.before === true))?.outMed;
  return { ...s, outMedBefore };
};
const b = all(true);
const a = all(false);
if (b && a) {
  console.log('');
  console.log(`execution avg output: ${b.out} -> ${a.out} (${(((a.out - b.out) / b.out) * 100).toFixed(1)}%)`);
  console.log(`execution med output: ${b.outMed} -> ${a.outMed} (${(((a.outMed - b.outMed) / b.outMed) * 100).toFixed(1)}%)`);
  console.log(`execution avg reasoning chars: ${b.reason} -> ${a.reason} (${(((a.reason - b.reason) / b.reason) * 100).toFixed(1)}%)`);
}
