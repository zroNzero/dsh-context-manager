// Aggregate the real bill across every DSH session log on this machine.
// Facts only: provider usage × official RMB prices, with the derived prompt ceiling.
import { readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { analyze } from './billing-report.mjs';

const root = process.argv[2] ?? path.join(process.env.USERPROFILE ?? 'C:/Users/zro_0', '.dsh', 'sessions');
const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name === 'session.v4.jsonl.zstd') files.push(full);
  }
};
walk(root);

const rows = [];
for (const file of files) {
  const size = statSync(file).size;
  if (size < 8000) continue; // 跳过刚开的空会话
  let a;
  try {
    a = analyze(file);
  } catch {
    continue;
  }
  if (!a.requests) continue;
  const promptCost = a.missCost + a.hitCost;
  const workspace = file.split(path.sep).find((p) => p.startsWith('--')) ?? '?';
  rows.push({
    id: path.basename(path.dirname(file)).replace('session-', '').slice(0, 8),
    workspace: workspace.replace(/^--|--$/g, '').replace(/-D-/g, ':/').slice(0, 28),
    requests: a.requests,
    bill: a.actual,
    outShare: a.outCost / a.actual,
    promptCeiling: promptCost / a.actual,
    hitRate: a.cacheHitRate,
    out: a.out,
    miss: a.miss,
    hit: a.hit,
  });
}

rows.sort((x, y) => y.bill - x.bill);
const totalBill = rows.reduce((s, r) => s + r.bill, 0);
const totalOut = rows.reduce((s, r) => s + r.out, 0);
const totalMiss = rows.reduce((s, r) => s + r.miss, 0);
const totalHit = rows.reduce((s, r) => s + r.hit, 0);
// 全机器合计的 prompt 上限：按各会话真实单价构成汇总
const totalPromptCost = rows.reduce((s, r) => s + r.bill * r.promptCeiling, 0);

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const cny = (v) => `¥${v.toFixed(4)}`;
console.log(`sessions=${rows.length}  total=${cny(totalBill)}`);
console.log(`tokens: miss=${totalMiss} hit=${totalHit} out=${totalOut}  hitRate=${pct(totalHit / (totalHit + totalMiss))}`);
console.log(`PROMPT CEILING across all real traffic: ${pct(totalPromptCost / totalBill)}`);
console.log('');
console.log('session   workspace                     reqs      bill   out%   promptCeiling  hitRate');
for (const r of rows) {
  console.log(
    `${r.id}  ${r.workspace.padEnd(28)} ${String(r.requests).padStart(4)} ${cny(r.bill).padStart(9)}  ${pct(r.outShare).padStart(6)}  ${pct(r.promptCeiling).padStart(12)}  ${pct(r.hitRate).padStart(7)}`,
  );
}
