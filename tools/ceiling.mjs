// Physical-ceiling analysis: how much of the REAL bill is addressable by prompt
// compression at all? Uses provider usage for cost and the logged message surface
// for content shares. No target number is assumed.
import { readSessionEvents } from './session-decode.mjs';

const TABLE = {
  flash: { peak: { hit: 0.04, miss: 2, output: 8 }, offpeak: { hit: 0.02, miss: 1, output: 4 } },
  v4pro: { peak: { hit: 0.3, miss: 9, output: 27 }, offpeak: { hit: 0.15, miss: 4.5, output: 13.5 } },
};
const isPeak = (ms) => {
  const b = new Date(ms + 8 * 3600 * 1000);
  const d = b.getUTCDay();
  if (d === 0 || d === 6) return false;
  const h = b.getUTCHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
};
const pricesFor = (ms, model = 'deepseek-flash') => {
  const tier = /pro/i.test(model) ? 'v4pro' : 'flash';
  return TABLE[tier][isPeak(ms) ? 'peak' : 'offpeak'];
};

const file = process.argv[2];
const { events } = readSessionEvents(file);

// Model-visible surface, in log order.
const surface = []; // { kind, chars, index }
let toolCharsTotal = 0;
const toolEntries = []; // { atRequest, chars }

const msgChars = (message) => {
  const content = message?.content;
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) {
    if (typeof block?.text === 'string') n += block.text.length;
    else if (block?.type === 'tool-call') n += JSON.stringify(block).length;
    else if (block?.type === 'reasoning') n += (block.text ?? '').length;
    else n += JSON.stringify(block ?? null).length;
  }
  return n;
};

const requests = [];
for (const e of events) {
  if (e.type === 'user/message' || e.type === 'developer/message' || e.type === 'system/message') {
    surface.push({ kind: e.type, chars: msgChars(e.data?.message) });
  } else if (e.type === 'assistant/message') {
    const usage = e.data?.usage;
    if (usage) {
      requests.push({ seq: e.seq, time: e.time, usage, surfaceChars: surface.reduce((a, m) => a + m.chars, 0) });
    }
    surface.push({ kind: 'assistant', chars: msgChars(e.data?.message) });
  } else if (e.type === 'tool/result') {
    const chars = msgChars(e.data?.message);
    surface.push({ kind: 'tool', chars });
    toolCharsTotal += chars;
    toolEntries.push({ atRequest: requests.length, chars });
  }
}

const sum = (k) => requests.reduce((a, r) => a + (r.usage[k] ?? 0), 0);
const realPromptTokens = sum('inputTokens') + sum('cacheReadTokens');
const surfaceCharsSum = requests.reduce((a, r) => a + r.surfaceChars, 0);
// Global calibration: real prompt tokens per surface char across all requests.
const ratio = surfaceCharsSum > 0 ? realPromptTokens / surfaceCharsSum : 0.25;

let totalCost = 0;
for (const r of requests) {
  const p = pricesFor(r.time ?? Date.now());
  totalCost +=
    ((r.usage.inputTokens ?? 0) * p.miss + (r.usage.cacheReadTokens ?? 0) * p.hit + (r.usage.outputTokens ?? 0) * p.output) / 1e6;
}

// Cost attributable to tool-output content: paid once as a cache miss when it
// enters the prompt, then re-read at the hit price on every later request.
const R = requests.length;
let toolCost = 0;
for (const t of toolEntries) {
  const tokens = t.chars * ratio;
  if (tokens <= 0) continue;
  const i = Math.min(t.atRequest, R - 1);
  const p = pricesFor(requests[i]?.time ?? Date.now());
  const rereads = Math.max(0, R - 1 - i);
  toolCost += (tokens * p.miss + tokens * p.hit * rereads) / 1e6;
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const promptCost = totalCost - requests.reduce((a, r) => {
  const p = pricesFor(r.time ?? Date.now());
  return a + ((r.usage.outputTokens ?? 0) * p.output) / 1e6;
}, 0);

console.log(`requests=${requests.length}  realBill=¥${totalCost.toFixed(4)}  calibration=${ratio.toFixed(4)} tok/char`);
console.log(`promptCost=¥${promptCost.toFixed(4)} (${pct(promptCost / totalCost)})   outputCost=¥${(totalCost - promptCost).toFixed(4)} (${pct((totalCost - promptCost) / totalCost)})`);
console.log(`tool-contentCost=¥${toolCost.toFixed(4)} (${pct(toolCost / totalCost)} of real bill)`);
console.log(`tool chars=${toolCharsTotal}  tool tokens≈${Math.round(toolCharsTotal * ratio)}  of prompt tokens=${realPromptTokens} (${pct((toolCharsTotal * ratio) / realPromptTokens)})`);
console.log('');
console.log(`MAX reduction if ALL prompt content vanished: ${pct(promptCost / totalCost)}`);
console.log(`MAX reduction if ALL tool output vanished:   ${pct(toolCost / totalCost)}`);
for (const rho of [0.3, 0.5, 0.644, 0.8]) {
  console.log(`  at ${pct(rho)} tool-output compression -> ${pct((toolCost * rho) / totalCost)} real-bill reduction`);
}
