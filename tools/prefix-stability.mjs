// Prefix-stability probe: do consecutive requests keep an identical system+tools
// prefix? A changed prefix invalidates the provider cache for the whole prompt.
import { createHash } from 'node:crypto';
import { readSessionEvents } from './session-decode.mjs';

const file = process.argv[2];
const { events } = readSessionEvents(file);
const headers = events.filter((e) => e.type === 'request/header');
const hash = (v) => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 12);

console.log(`request/header events: ${headers.length}`);
const toolsHashes = [];
for (const [i, h] of headers.entries()) {
  const header = h.data?.header ?? {};
  const tools = header.tools ?? [];
  const tHash = hash(tools);
  toolsHashes.push(tHash);
  const prev = i > 0 ? toolsHashes[i - 1] : null;
  const changed = prev !== null && prev !== tHash;
  const names = tools.map((t) => t.name);
  const descLens = tools.map((t) => (t.description ?? '').length);
  console.log(
    `#${String(i).padStart(2)} seq=${h.seq} tools=${String(tools.length).padStart(2)} hash=${tHash}${changed ? ` CHANGED(prev ${prev})` : ''} ` +
      `descMax=${Math.max(0, ...descLens)} descSum=${descLens.reduce((a, b) => a + b, 0)}`,
  );
}

// Cache-read delta per request, to correlate with prefix changes.
let prevCum = 0;
const rows = [];
for (const e of events) {
  if (e.type !== 'assistant/message' || !e.data?.usage) continue;
  const cum = e.data.usage.cacheReadTokens ?? 0;
  rows.push({ seq: e.seq, hit: Math.max(0, cum - prevCum), miss: e.data.usage.inputTokens ?? 0, turn: e.data.turn });
  prevCum = Math.max(prevCum, cum);
}
const hit = rows.reduce((a, r) => a + r.hit, 0);
const miss = rows.reduce((a, r) => a + r.miss, 0);
console.log(`\ncache reads=${hit} misses=${miss} hitRate=${((hit / (hit + miss)) * 100).toFixed(1)}%`);
const zeroHit = rows.filter((r) => r.hit === 0).length;
console.log(`requests with zero cache read: ${zeroHit}/${rows.length}`);
