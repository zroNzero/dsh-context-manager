// Request-composition probe: is request/header the pre-plugin or post-plugin payload?
import { readSessionEvents } from './session-decode.mjs';

const file = process.argv[2];
const { events } = readSessionEvents(file);
const headers = events.filter((e) => e.type === 'request/header');
console.log('request/header events:', headers.length);

for (const [i, h] of headers.slice(0, 2).entries()) {
  const header = h.data?.header ?? {};
  const tools = header.tools ?? [];
  const descs = tools.map((t) => (t.description ?? '').length);
  const toolChars = JSON.stringify(tools).length;
  console.log(`\n#${i} seq=${h.seq} tools=${tools.length} toolsJsonChars=${toolChars} ~tokens=${Math.ceil(toolChars / 4)}`);
  console.log(`  desc length: max=${Math.max(0, ...descs)} avg=${Math.round(descs.reduce((a, b) => a + b, 0) / (descs.length || 1))} truncated(<=130)=${descs.filter((d) => d > 0 && d <= 130).length}`);
  console.log(`  names: ${tools.slice(0, 12).map((t) => t.name).join(',')}${tools.length > 12 ? ',...' : ''}`);
  console.log(`  config: ${JSON.stringify(header.config)}`);
}

// Real usage per request for this session
const us = events.filter((e) => e.type === 'assistant/message' && e.data?.usage).map((e) => e.data.usage);
if (us.length) {
  const sum = (k) => us.reduce((a, u) => a + (u[k] ?? 0), 0);
  const promptSizes = us.map((u) => (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0)).sort((a, b) => a - b);
  const q = (p) => promptSizes[Math.min(promptSizes.length - 1, Math.floor(p * promptSizes.length))];
  console.log(`\nusage requests=${us.length}`);
  console.log(`  hit=${sum('cacheReadTokens')} miss=${sum('inputTokens')} out=${sum('outputTokens')}`);
  console.log(`  prompt tokens p50=${q(0.5)} p90=${q(0.9)} max=${promptSizes.at(-1)}`);
  console.log(`  cacheHitRate=${((sum('cacheReadTokens') / (sum('cacheReadTokens') + sum('inputTokens'))) * 100).toFixed(1)}%`);
}
