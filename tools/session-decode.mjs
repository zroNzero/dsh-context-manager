// Decode a DSH v4 session log (concatenated zstd frames) into an array of events.
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function readSessionEvents(file) {
  const buf = readFileSync(file);
  const events = [];
  let off = 0;
  let bad = 0;
  while (off < buf.length) {
    const idx = buf.indexOf(MAGIC, off);
    if (idx < 0) break;
    let text = null;
    try {
      text = zstdDecompressSync(buf.subarray(idx)).toString('utf8');
    } catch {
      // Frame boundary guess: next magic minus current
      const next = buf.indexOf(MAGIC, idx + 4);
      if (next < 0) break;
      try { text = zstdDecompressSync(buf.subarray(idx, next)).toString('utf8'); } catch { bad++; off = next; continue; }
      off = next;
    }
    if (text) {
      for (const line of text.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try { events.push(JSON.parse(s)); } catch { /* partial */ }
      }
      // Advance past this frame: try next magic after idx+4
      const next = buf.indexOf(MAGIC, idx + 4);
      off = next < 0 ? buf.length : next;
    } else {
      off = idx + 4;
    }
  }
  return { events, bad };
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node tools/session-decode.mjs <session.jsonl.zstd> [mode]');
    process.exit(1);
  }
  const mode = process.argv[3] ?? 'types';
  const { events, bad } = readSessionEvents(file);
  console.log('events:', events.length, 'badFrames:', bad);
  if (mode === 'types') {
    const counts = new Map();
    for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(6), k);
  } else if (mode === 'usageshape') {
    const us = events.filter((e) => e.type === 'assistant/message' && e.data?.usage);
    console.log('with usage:', us.length, 'of', events.filter((e) => e.type === 'assistant/message').length);
    console.log('--- first ---');
    console.log(JSON.stringify(us[0]?.data?.usage, null, 1));
    console.log('--- last ---');
    console.log(JSON.stringify(us.at(-1)?.data?.usage, null, 1));
  } else if (mode === 'usage') {
    const hits = events.filter((e) => /usage|promptTokens|inputTokens|cachedTokens/i.test(JSON.stringify(e.data ?? e)));
    console.log('usage-bearing events:', hits.length);
    for (const e of hits.slice(0, 6)) {
      console.log('---', e.type, e.seq);
      console.log(JSON.stringify(e.data).slice(0, 1500));
    }
  }
}
