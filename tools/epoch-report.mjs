// Comprehensive savings accounting across build epochs of one real session.
// Every number is provider usage (cacheReadTokens handled as a cumulative counter).
import { readSessionEvents } from './session-decode.mjs';
import { pricesFor } from './billing-report.mjs';

const file = process.argv[2];
const { events } = readSessionEvents(file);

const EPOCHS = [
  { name: 'W1 old defaults', from: 0, to: Date.parse('2026-11-11T11:20:00Z') },
  { name: 'W1b old defaults', from: Date.parse('2026-11-11T11:20:00Z'), to: Date.parse('2026-11-11T11:47:36Z') },
  { name: 'W2 cache-safe', from: Date.parse('2026-11-11T11:47:36Z'), to: Date.parse('2026-11-11T12:08:00Z') },
  { name: 'W2b plugin off', from: Date.parse('2026-11-11T12:08:00Z'), to: Date.parse('2026-11-11T12:13:00Z') },
  { name: 'W3 effort on', from: Date.parse('2026-11-11T12:13:00Z'), to: Number.MAX_SAFE_INTEGER },
];

const empty = () => ({ n: 0, prompt: 0, miss: 0, hit: 0, out: 0, reasonChars: 0, textChars: 0, cost: 0, missCost: 0, hitCost: 0, outCost: 0 });
const buckets = EPOCHS.map(() => empty());

let prevCum = 0;
for (const e of events) {
  if (e.type !== 'assistant/message' || !e.data?.usage) continue;
  const u = e.data.usage;
  const cum = u.cacheReadTokens ?? 0;
  const hit = cum >= prevCum ? cum - prevCum : cum; // counter resets on host restart
  prevCum = cum;
  const miss = u.inputTokens ?? 0;
  const out = u.outputTokens ?? 0;
  const time = e.time ?? 0;
  const idx = EPOCHS.findIndex((x) => time >= x.from && time < x.to);
  if (idx < 0) continue;
  const b = buckets[idx];
  const p = pricesFor(time);
  b.n += 1;
  b.miss += miss;
  b.hit += hit;
  b.out += out;
  b.prompt += miss + hit;
  b.missCost += (miss * p.miss) / 1e6;
  b.hitCost += (hit * p.hit) / 1e6;
  b.outCost += (out * p.output) / 1e6;
  b.cost += (miss * p.miss + hit * p.hit + out * p.output) / 1e6;
  for (const block of e.data.message?.content ?? []) {
    if (block?.type === 'reasoning') b.reasonChars += (block.text ?? '').length;
    else if (block?.type === 'text') b.textChars += (block.text ?? '').length;
  }
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const cny = (v) => `¥${v.toFixed(4)}`;
console.log('epoch            reqs  avgPrompt  hitRate  avgOut  avgReasonChars   bill      per-req');
for (const [i, ep] of EPOCHS.entries()) {
  const b = buckets[i];
  if (!b.n) continue;
  const hitRate = b.hit + b.miss > 0 ? b.hit / (b.hit + b.miss) : 0;
  console.log(
    `${ep.name.padEnd(16)} ${String(b.n).padStart(4)}  ${String(Math.round(b.prompt / b.n)).padStart(9)}  ${pct(hitRate).padStart(7)}  ` +
      `${String(Math.round(b.out / b.n)).padStart(6)}  ${String(Math.round(b.reasonChars / b.n)).padStart(14)}  ${cny(b.cost).padStart(9)}  ${cny(b.cost / b.n).padStart(8)}`,
  );
}

const sum = (a, k) => buckets.reduce((s, b) => s + b[k], 0);
const total = sum(buckets, 'cost');
const outCost = sum(buckets, 'outCost');
const missCost = sum(buckets, 'missCost');
const hitCost = sum(buckets, 'hitCost');
console.log('');
console.log(`whole session: bill ${cny(total)}  miss ${cny(missCost)} (${pct(missCost / total)})  hit ${cny(hitCost)} (${pct(hitCost / total)})  out ${cny(outCost)} (${pct(outCost / total)})`);
