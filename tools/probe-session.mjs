// Probe a DSH session log: decompress and summarize event types + usage records.
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const file = process.argv[2];
const mode = process.argv[3] ?? 'types';
const buf = readFileSync(file);
const text = zstdDecompressSync(buf).toString('utf8');
const lines = text.split('\n').filter((l) => l.trim().length > 0);
const events = [];
for (const line of lines) {
  try { events.push(JSON.parse(line)); } catch { /* skip partial */ }
}
if (mode === 'types') {
  const counts = new Map();
  for (const e of events) {
    const t = e.type ?? e.kind ?? '??';
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  console.log('lines:', lines.length, 'parsed:', events.length);
  for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(6), k);
  const sample = events.find((e) => JSON.stringify(e).includes('usage') || JSON.stringify(e).includes('inputTokens'));
  console.log('\n--- sample with usage ---');
  console.log(JSON.stringify(sample, null, 2)?.slice(0, 2000));
} else if (mode === 'usage') {
  let i = 0;
  for (const e of events) {
    const s = JSON.stringify(e);
    if (!/usage|inputTokens|prompt_tokens|promptTokens/i.test(s)) continue;
    console.log('---', e.type, e.seq ?? '');
    console.log(s.slice(0, 1200));
    if (++i > 8) break;
  }
} else if (mode === 'keys') {
  const keys = new Set();
  const walk = (o, p) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) { keys.add(p + k); if (typeof v === 'object') walk(v, p + k + '.'); }
  };
  for (const e of events.slice(0, 400)) walk(e, '');
  console.log([...keys].sort().join('\n'));
}
