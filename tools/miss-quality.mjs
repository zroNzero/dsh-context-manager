// Is the miss bill mostly NEW content or wasted re-reads?
// For each request, compare the missed prompt tokens with the tokens of the
// messages appended since the previous request. miss >> added => cache waste.
import { readSessionEvents } from './session-decode.mjs';
import { pricesFor } from './billing-report.mjs';

const file = process.argv[2];
const from = Date.parse(process.argv[3] ?? '2026-11-11T12:20:00Z');
const { events } = readSessionEvents(file);

const msgChars = (m) => {
  const c = m?.content;
  if (typeof c === 'string') return c.length;
  if (!Array.isArray(c)) return 0;
  let n = 0;
  for (const b of c) {
    if (typeof b?.text === 'string') n += b.text.length;
    else if (b?.type === 'tool-call') n += JSON.stringify(b).length;
    else n += JSON.stringify(b ?? null).length;
  }
  return n;
};

let prevCum = 0;
let addedChars = 0; // content appended since the previous request
let surfaceChars = 0; // total model-visible characters so far
let first = true;
const rows = [];
for (const e of events) {
  if (e.type === 'user/message' || e.type === 'developer/message' || e.type === 'system/message') {
    addedChars += msgChars(e.data?.message);
    continue;
  }
  if (e.type === 'tool/result') {
    addedChars += msgChars(e.data?.message);
    continue;
  }
  if (e.type !== 'assistant/message' || !e.data?.usage) continue;
  const u = e.data.usage;
  const cum = u.cacheReadTokens ?? 0;
  const hit = cum >= prevCum ? cum - prevCum : cum;
  prevCum = cum;
  const miss = u.inputTokens ?? 0;
  const out = u.outputTokens ?? 0;
  const prompt = miss + hit;
  const ownChars = msgChars(e.data?.message)
  surfaceChars += ownChars
  const ratio = surfaceChars > 0 ? prompt / surfaceChars : 0.3;
  if ((e.time ?? 0) >= from) {
    const p = pricesFor(e.time ?? Date.now());
    rows.push({
      miss,
      hit,
      added: Math.round(addedChars * ratio), // calibrate chars->tokens with this request's own ratio
      cost: (miss * p.miss + hit * p.hit + out * p.output) / 1e6,
      missCost: (miss * p.miss) / 1e6,
    });
  }
  addedChars = 0;
}

const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const totalMiss = sum('miss');
const totalAdded = sum('added');
console.log(`requests=${rows.length}  missTokens=${totalMiss}  newContentTokens≈${totalAdded}`);
console.log(`miss cost=¥${sum('missCost').toFixed(4)}`);
console.log(`=> genuinely new content ≈ ${pct(totalAdded / (totalMiss || 1))} of missed tokens`);
console.log(`=> wasted re-reads ≈ ${pct(Math.max(0, 1 - totalAdded / (totalMiss || 1)))} of missed tokens`);
console.log(`waste cost ≈ ¥${(sum('missCost') * Math.max(0, 1 - totalAdded / (totalMiss || 1))).toFixed(4)}`);
