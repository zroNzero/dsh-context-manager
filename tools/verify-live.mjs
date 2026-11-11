// One-command live verification: reads the ledger the plugin writes at runtime and
// compares it against the pre-fix baseline measured from session logs.
//
// Run it after the host has been restarted so the new build is live.
//   node tools/verify-live.mjs
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { analyze } from './billing-report.mjs';

const profileDir = process.env.DSH_PROFILE_DIR ?? path.join(process.env.USERPROFILE ?? 'C:/Users/zro_0', '.dsh', 'profiles', 'desktop');
const savingsFile = path.join(profileDir, 'savings.json');
const realBillFile = path.join(profileDir, 'real-bill.md');

const pct = (v) => `${(v * 100).toFixed(2)}%`;
const cny = (v) => `¥${Number(v).toFixed(4)}`;

if (!existsSync(savingsFile)) {
  console.log(`找不到 ${savingsFile} —— 插件还没在新宿主里跑起来。`);
  process.exit(1);
}
const savings = JSON.parse(readFileSync(savingsFile, 'utf8'));
const real = savings.realBill;
if (!real) {
  console.log('savings.json 里没有 realBill —— 说明宿主仍在跑旧构建（旧构建不会写真实账本）。');
  console.log('请重启桌面应用，让 profile 目录里的 dist 重新加载。');
  process.exit(2);
}

console.log('=== 插件自报的真实账单（provider usage × 官方单价）===');
console.log(`请求数：${real.requests}（其中无削减 ${real.requestsWithoutReduction}）`);
console.log(`真实花费 ${cny(real.actualCost)}   反事实 ${cny(real.counterfactualCost)}   节省 ${cny(real.savedCost)}`);
console.log(`真实降幅（reduction）：${pct(real.reduction)}`);
console.log(`缓存命中率：${pct(real.cacheHitRate)}   miss=${real.missTokens} hit=${real.hitTokens} out=${real.outputTokens}`);
console.log(`未验证的输出截断 token：${real.unverifiedOutputTokens}（不计入降幅）`);
if (real.lastPricing) console.log(`当前单价：${JSON.stringify(real.lastPricing)}`);

const purposes = Object.entries(real.byPurpose ?? {});
if (purposes.length) {
  console.log('\n按用途：');
  for (const [name, b] of purposes) {
    const reduction = b.counterfactualCost > 0 ? 1 - b.actualCost / b.counterfactualCost : 0;
    console.log(`  ${name.padEnd(16)} reqs=${String(b.requests).padStart(4)} 实际=${cny(b.actualCost).padStart(9)} 降幅=${pct(reduction)}`);
  }
  const ka = (real.byPurpose ?? {})['cache-keepalive'];
  if (ka) console.log(`\n保活支出 ${cny(ka.actualCost)} —— 只有当它换回来的命中大于这笔钱时才划算。`);
}

// 与修复前的实测基线对比：全机器 15 会话的整体命中率 31.8%，轮内命中率 42.0%
const BASELINE = { hitRate: 0.318, midTurnHitRate: 0.42, ceiling: 0.442, addressable: 0.356 };
console.log('\n=== 与修复前基线对比 ===');
console.log(`命中率 ${pct(real.cacheHitRate)} vs 基线 ${pct(BASELINE.hitRate)}  -> ${real.cacheHitRate > BASELINE.hitRate ? '改善' : '未改善'}`);
console.log(`物理上限（prompt 全清零）${pct(BASELINE.ceiling)}；可及上限（缓存修复+保活）${pct(BASELINE.addressable)}`);

// 顺带把最近一个会话日志的真实账单算一遍，便于交叉核对
const sessionsRoot = path.join(process.env.USERPROFILE ?? 'C:/Users/zro_0', '.dsh', 'sessions');
let newest = null;
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name === 'session.v4.jsonl.zstd') {
      const m = statSync(full).mtimeMs;
      if (!newest || m > newest.m) newest = { file: full, m };
    }
  }
};
try {
  walk(sessionsRoot);
  if (newest) {
    const a = analyze(newest.file);
    const promptCost = a.missCost + a.hitCost;
    console.log(`\n=== 最新会话日志交叉核对（${path.basename(path.dirname(newest.file)).slice(0, 16)}）===`);
    console.log(`requests=${a.requests} 真实账单=${cny(a.actual)} 命中率=${pct(a.cacheHitRate)} prompt 上限=${pct(promptCost / (a.actual || 1))}`);
  }
} catch (error) {
  console.log(`\n（交叉核对跳过：${String(error)}）`);
}
console.log(`\n${existsSync(realBillFile) ? `明细：${realBillFile}` : 'real-bill.md 尚未生成'}`);
