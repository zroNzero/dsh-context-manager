// Where the cache money is lost: turn-start requests (cache expired while the user
// was idle) versus mid-turn requests (prefix should be append-only and hit).
// The split tells us what prefix repair can win vs what only keepalive can win.
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { readSessionEvents } from './session-decode.mjs';
import { pricesFor } from './billing-report.mjs';

const root = process.argv[2] ?? path.join(process.env.USERPROFILE ?? 'C:/Users/zro_0', '.dsh', 'sessions');
const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name === 'session.v4.jsonl.zstd') files.push(full);
  }
};
walk(root);

const acc = { start: { miss: 0, hit: 0, cost: 0, n: 0 }, mid: { miss: 0, hit: 0, cost: 0, n: 0 } };
let bill = 0;
for (const file of files) {
  if (statSync(file).size < 8000) continue;
  let events;
  try {
    events = readSessionEvents(file).events;
  } catch {
    continue;
  }
  let prevCum = 0;
  let prevTurn = null;
  for (const e of events) {
    if (e.type !== 'assistant/message' || !e.data?.usage) continue;
    const u = e.data.usage;
    const cum = u.cacheReadTokens ?? 0;
    const hit = Math.max(0, cum - prevCum);
    prevCum = Math.max(prevCum, cum);
    const miss = u.inputTokens ?? 0;
    const out = u.outputTokens ?? 0;
    const p = pricesFor(e.time ?? Date.now());
    const cost = (miss * p.miss + hit * p.hit + out * p.output) / 1e6;
    bill += cost;
    const bucket = e.data.turn !== prevTurn ? acc.start : acc.mid;
    prevTurn = e.data.turn;
    bucket.miss += miss;
    bucket.hit += hit;
    bucket.cost += cost;
    bucket.n += 1;
  }
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const missCost = (b) => b.miss * 1e-6; // 空闲档 miss ¥1/M；用整段单价的保守近似
for (const [name, b] of [['turn-start', acc.start], ['mid-turn  ', acc.mid]]) {
  const prompt = b.miss + b.hit;
  console.log(
    `${name} requests=${String(b.n).padStart(5)}  prompt=${String(prompt).padStart(9)}  hitRate=${pct(prompt ? b.hit / prompt : 0).padStart(6)}  cost=¥${b.cost.toFixed(4)}`,
  );
}
const totalMiss = acc.start.miss + acc.mid.miss;
console.log(`\nreal bill=¥${bill.toFixed(4)}  missTokens=${totalMiss}`);
console.log(`mid-turn miss share of all miss: ${pct(acc.mid.miss / (totalMiss || 1))}  (pure prefix-drift damage -> prefix repair)`);
console.log(`turn-start miss share:          ${pct(acc.start.miss / (totalMiss || 1))}  (cache expired while idle -> only keepalive helps)`);
console.log(`\nif all mid-turn miss became hit: saves ~¥${(acc.mid.miss * 0.98e-6).toFixed(4)} (${pct((acc.mid.miss * 0.98e-6) / bill)})`);
console.log(`if all turn-start miss became hit: saves ~¥${(acc.start.miss * 0.98e-6).toFixed(4)} (${pct((acc.start.miss * 0.98e-6) / bill)})`);
