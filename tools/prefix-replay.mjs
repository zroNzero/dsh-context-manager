// Replay a real session's message surface through the history rewriter and measure
// how much of the ALREADY-SENT prefix it changes. Any change invalidates the provider
// cache from that point on, so this is a direct measure of self-inflicted cache damage.
//
// OLD policy: truncation limits derived from the live token count (what shipped before).
// NEW policy: fixed limits from config (or the rewriter disabled entirely).
import path from 'node:path';
import { readSessionEvents } from './session-decode.mjs';
import { rewriteMessages } from '../dist/modules/history-rewriter.js';

const file = process.argv[2];
const { events } = readSessionEvents(file);

const textOf = (message) => {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (typeof b?.text === 'string' ? b.text : ''))
    .join('');
};

// Rebuild the model-visible message surface in log order.
const messages = [];
const snapshots = [];
for (const e of events) {
  if (e.type === 'user/message' || e.type === 'developer/message' || e.type === 'system/message') {
    const m = e.data?.message;
    if (m) messages.push({ role: String(m.role ?? 'user'), content: [{ type: 'text', text: textOf(m) }] });
  } else if (e.type === 'tool/result') {
    const m = e.data?.message;
    messages.push({ role: 'tool', toolCallId: m?.toolCallId ?? 'x', content: [{ type: 'text', text: textOf(m) }] });
  } else if (e.type === 'assistant/message') {
    if (e.data?.usage) snapshots.push(messages.slice());
    const m = e.data?.message;
    if (m) messages.push({ role: 'assistant', content: [{ type: 'text', text: textOf(m) }] });
  }
}

const RETENTION = 8;
const FIXED = { retainRecent: RETENTION, assistantChars: 400, toolChars: 700 };
// 旧策略：toolChars 随上下文规模漂移（planBudget 的实现）。
const drift = (tokens) => {
  const memoryBudget = Math.floor(tokens * 0.45);
  const toolChars = Math.max(200, Math.min(3200, Math.round((memoryBudget * 4) / 64)));
  const liveRatio = Math.max(0, tokens - memoryBudget - Math.min(tokens * 0.15, tokens * 0.15)) / (tokens || 1);
  return {
    retainRecent: Math.max(2, Math.min(12, Math.round(liveRatio * 16))),
    assistantChars: Math.max(120, Math.min(1200, Math.round(toolChars / 2))),
    toolChars,
  };
};

const chars = (list) => list.reduce((n, m) => n + textOf(m).length, 0);
const measure = (label, transform) => {
  let prev = null;
  let churn = 0;
  let total = 0;
  let anyDrift = 0;
  for (const snap of snapshots) {
    const out = transform(snap);
    if (prev) {
      const n = Math.min(prev.length, out.length);
      let changed = 0;
      for (let i = 0; i < n; i += 1) {
        if (textOf(prev[i]) !== textOf(out[i])) changed += textOf(prev[i]).length;
      }
      if (changed > 0) anyDrift += 1;
      churn += changed;
      total += chars(prev);
    }
    prev = out;
  }
  console.log(
    `${label.padEnd(10)} prefix churn ${String(churn).padStart(9)} chars over ${snapshots.length} requests ` +
      `(${((churn / (total || 1)) * 100).toFixed(1)}% of all sent chars), requests with drift: ${anyDrift}`,
  );
  return { churn, anyDrift };
};

console.log(`session ${path.basename(path.dirname(file))}  requests=${snapshots.length}  messages=${messages.length}`);
const oldR = measure('OLD', (m) => {
  const res = rewriteMessages(m, drift(chars(m) / 4));
  return res.messages;
});
const newR = measure('NEW-fixed', (m) => rewriteMessages(m, FIXED).messages);
const offR = measure('NEW-off', (m) => m);
console.log(
  `\n旧策略把已发前缀改了 ${oldR.anyDrift} 次；新策略(fixed) ${newR.anyDrift} 次，关闭 ${offR.anyDrift} 次。`,
);
