// The TA jobs comparison (thread "Rework TA signals into real bot edge", Oct 31): the whole bot, as paper runs it, replayed
// on the history days with each of the reworked TA jobs on and off. The jobs (plan: the Claude Doc "Reworking TA into bot
// edge") stop asking the TA pieces for direction and give them other work: when to trade, where to rest maker orders,
// take or skip, when to take profit, and which signals stay on. Each is a bot setting, so a variant is a set of bot.env
// lines, scored by the production backtester exactly as the random sweep scores a trial (research/randomSweep.ts).
//
//   node --import tsx research/taJobs.ts run    --variant baseline --days data/sweep-days --model data/models/model.json --out research/out/ta-jobs [--entry-log]
//   node --import tsx research/taJobs.ts report --days data/sweep-days --out research/out/ta-jobs [--split 2026-09-01]
//
// The report prints aggregates only (this repository is public): $ an hour after fees on the days before and after
// --split, each variant against the baseline day by day with a bootstrap interval, and, from the baseline's entry log,
// what the bot's own entries made by price band, by maker / taker, and with each candidate conditioner for or against them.

import fs from 'fs';
import path from 'path';
import { rng } from './stats';
import type { TrialResult } from './randomSweep';
import type { EntryLogRow } from './backtest';

/** Each variant's bot.env lines on top of the server's settings. The jobs add theirs as they are built. */
export const VARIANTS: Record<string, Record<string, string>> = {
  baseline: {},
  // Job 1, when to trade: ask less edge while volatility rises (the contract lags a moving coin) / volatility targeting.
  j1_lag: { DYN_EDGE_VOL: '-0.02', DYN_EDGE_MAX_DOWN: '0.02' },
  j1_voltarget: { REGIME_VOL_TARGET: '0.5' },
  // Job 2, where to rest maker orders: the reversal lean on the quoted centre (cents a vote, capped at 2).
  j2_maker: { TA_LEAN_MAKER: '0.005' },
  j2_maker_hi: { TA_LEAN_MAKER: '0.01' },
  // Direction: the reversal lean on close calls (fair value within 15 points of 50%).
  dir_lean: { TA_LEAN_PRICE: '0.005' },
  all_on: { DYN_EDGE_VOL: '-0.02', DYN_EDGE_MAX_DOWN: '0.02', TA_LEAN_MAKER: '0.005', TA_LEAN_PRICE: '0.005' },
};

function arg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }

const f2 = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2);

/** Mean of `xs` with a percentile bootstrap interval (days resampled). */
export function bootMean(xs: number[], draws = 4000, seed = 5): { mean: number; lo: number; hi: number } {
  if (!xs.length) return { mean: NaN, lo: NaN, hi: NaN };
  const mean = xs.reduce((a, v) => a + v, 0) / xs.length;
  const r = rng(seed);
  const ms: number[] = [];
  for (let d = 0; d < draws; d++) { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[Math.floor(r() * xs.length)]; ms.push(s / xs.length); }
  ms.sort((a, b) => a - b);
  return { mean, lo: ms[Math.floor(draws * 0.025)], hi: ms[Math.floor(draws * 0.975)] };
}

/** Profit after fees per contract of an entry held to settlement. */
export const entryProfit = (r: EntryLogRow) => (r.won ? 1 : 0) - r.price - r.fee;

/** The candidate conditioners read from the decision's feature map, each oriented to the bought side (+ = for it). */
export const CONDITIONERS: Array<{ name: string; read: (r: EntryLogRow) => number | undefined }> = (() => {
  const side = (r: EntryLogRow) => (r.side === 'yes' ? 1 : -1);
  const num = (r: EntryLogRow, k: string) => (Number.isFinite(r.f[k]) ? r.f[k] : undefined);
  const oriented = (k: string, centre = 0) => (r: EntryLogRow) => { const v = num(r, k); return v === undefined ? undefined : side(r) * (v - centre); };
  return [
    { name: 'mid vs fair value (side)', read: (r) => side(r) * (r.pYes - r.mid) },
    { name: 'bollinger %b 300s (side)', read: oriented('bb_pctb_300', 0.5) },
    { name: 'rsi 60s (side)', read: oriented('rsi_60', 50) },
    { name: 'rsi 14 1m (side)', read: oriented('rsi_14_1m', 50) },
    { name: 'macd hist z (side)', read: oriented('macd_hist_z') },
    { name: 'return 60s z (side)', read: oriented('ret_60s_z') },
    { name: 'return 300s z (side)', read: oriented('ret_300s_z') },
    { name: 'taker flow 60s (side)', read: oriented('tfi_60s') },
    { name: 'order flow 30s (side)', read: oriented('ofi_30s') },
    { name: 'depth imbalance (side)', read: oriented('depth_imbalance_5') },
    { name: 'TA net up 1h (side)', read: oriented('tanet_up_1h', 0.5) },
    { name: 'confluence count (side)', read: oriented('conf_count') },
    { name: 'USDT.D 15m z (side, inverted)', read: (r) => { const v = num(r, 'usdtd_ret_15m_z'); return v === undefined ? undefined : -side(r) * v; } },
    { name: 'vol ratio 15m/4h', read: (r) => num(r, 'vol_ratio_15m_4h') },
    { name: 'trade intensity 60s', read: (r) => num(r, 'trade_intensity_60s') },
  ];
})();

function readLog(file: string): EntryLogRow[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as EntryLogRow).filter((r) => r.won !== undefined);
}

/** What the entries made, contract-weighted: n entries, contracts, win share, profit after fees per contract (cents). */
function summary(rows: EntryLogRow[]): string {
  const c = rows.reduce((a, r) => a + r.count, 0);
  if (!c) return 'none';
  const won = rows.reduce((a, r) => a + (r.won ? r.count : 0), 0) / c;
  const per = rows.reduce((a, r) => a + entryProfit(r) * r.count, 0) / c;
  const px = rows.reduce((a, r) => a + r.price * r.count, 0) / c;
  return `${rows.length} fills, ${c} ct, price ${px.toFixed(3)}, won ${(won * 100).toFixed(1)}%, ${f2(per * 100)} c/ct, $${f2(per * c)}`;
}

export function entryReport(rows: EntryLogRow[], log = console.log): void {
  log(`entries held to settlement (profit after fees, as if held): ${summary(rows)}`);
  log('by price band:');
  for (const [lo, hi] of [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.01]]) log(`  ${lo.toFixed(1)}-${Math.min(1, hi).toFixed(1)}: ${summary(rows.filter((r) => r.price >= lo && r.price < hi))}`);
  log(`maker: ${summary(rows.filter((r) => !r.taker))}`);
  log(`taker: ${summary(rows.filter((r) => r.taker))}`);
  log('by minutes left at the fill:');
  for (const [lo, hi] of [[0, 3], [3, 6], [6, 10], [10, 16], [16, 1e9]]) log(`  ${lo}-${hi > 1e8 ? 'more' : hi} min: ${summary(rows.filter((r) => (r.closeTs - r.t) / 60_000 >= lo && (r.closeTs - r.t) / 60_000 < hi))}`);
  log('conditioners (entries split at the median of each, oriented to the bought side where marked; c/ct with a day-bootstrap 95% interval of the difference):');
  for (const c of CONDITIONERS) {
    const xs = rows.map((r) => ({ r, v: c.read(r) })).filter((x): x is { r: EntryLogRow; v: number } => x.v !== undefined && Number.isFinite(x.v));
    if (xs.length < 200) { log(`  ${c.name}: ${xs.length} fills, too few`); continue; }
    const sorted = xs.map((x) => x.v).sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const hiSet = xs.filter((x) => x.v > med).map((x) => x.r), loSet = xs.filter((x) => x.v <= med).map((x) => x.r);
    // The difference by day (high half minus low half, c/ct), bootstrapped over days.
    const byDay = new Map<string, { h: [number, number]; l: [number, number] }>();
    for (const x of xs) {
      const d = new Date(x.r.t).toISOString().slice(0, 10);
      const b = byDay.get(d) ?? { h: [0, 0], l: [0, 0] };
      const k = x.v > med ? b.h : b.l;
      k[0] += entryProfit(x.r) * x.r.count; k[1] += x.r.count;
      byDay.set(d, b);
    }
    const diffs = [...byDay.values()].filter((b) => b.h[1] > 0 && b.l[1] > 0).map((b) => 100 * (b.h[0] / b.h[1] - b.l[0] / b.l[1]));
    const bm = bootMean(diffs);
    const per = (s: EntryLogRow[]) => { const n = s.reduce((a, r) => a + r.count, 0); return n ? (100 * s.reduce((a, r) => a + entryProfit(r) * r.count, 0)) / n : NaN; };
    log(`  ${c.name}: median ${med.toFixed(3)} | above ${f2(per(hiSet))} c/ct (${hiSet.length}) | at or below ${f2(per(loSet))} c/ct (${loSet.length}) | daily diff ${f2(bm.mean)} [${f2(bm.lo)}, ${f2(bm.hi)}] over ${diffs.length} d`);
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const out = arg('out', 'research/out/ta-jobs');
  const days = arg('days', 'data/sweep-days');
  const { recordingFiles } = await import('../bot/marketdata/recordingFiles');
  if (cmd === 'run') {
    const name = arg('variant', 'baseline');
    const env = VARIANTS[name];
    if (!env) throw new Error(`unknown variant ${name} (${Object.keys(VARIANTS).join(', ')})`);
    const { evalTrial } = await import('./randomSweep');
    const t0 = Date.now();
    const r = await evalTrial(days, arg('model', 'data/models/model.json'), env, 3, 'all', undefined, { entryLog: process.argv.includes('--entry-log') ? path.join(out, `${name}.entries.jsonl`) : undefined });
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ name, ...r }));
    console.log(`[ta-jobs] ${name}: ${r.ok ? `P&L ${f2(r.pnl)}, fees ${r.fees.toFixed(2)}, ${r.trades} trades, ${r.contracts} contracts` : `FAILED ${r.error}`} in ${((Date.now() - t0) / 60_000).toFixed(1)} min`);
    return;
  }
  if (cmd === 'report') {
    const { scoreOf } = await import('./randomSweep');
    const all = recordingFiles(days).map((d) => d.day).sort();
    const split = arg('split', all[Math.floor(all.length * 0.5)] ?? '');
    const train = all.filter((d) => d < split), test = all.filter((d) => d >= split);
    const res = new Map<string, TrialResult>();
    for (const f of fs.existsSync(out) ? fs.readdirSync(out) : []) if (f.endsWith('.json')) { const j = JSON.parse(fs.readFileSync(path.join(out, f), 'utf8')); res.set(j.name, j); }
    const span = (d: string[]) => (d.length ? `${d[0]}..${d[d.length - 1]} (${d.length} d)` : 'none');
    console.log(`days: before split ${span(train)} | after ${span(test)}`);
    const base = res.get('baseline');
    for (const [name, r] of [...res.entries()].sort((a, b) => (a[0] === 'baseline' ? -1 : b[0] === 'baseline' ? 1 : a[0].localeCompare(b[0])))) {
      if (!r.ok) { console.log(`${name}: FAILED ${r.error}`); continue; }
      const a = scoreOf(r, train), b = scoreOf(r, test);
      let vs = '';
      if (base?.ok && name !== 'baseline') {
        const diff = test.map((d) => ((r.byDay[d] ?? 0) - (base.byDay[d] ?? 0)) / 24);
        const bm = bootMean(diff);
        vs = ` | vs baseline after split ${f2(bm.mean)}/h [${f2(bm.lo)}, ${f2(bm.hi)}]`;
      }
      console.log(`${name.padEnd(14)} before ${f2(a.perHour)}/h (${a.trades} trades, max drawdown ${a.maxDd.toFixed(0)}) | after ${f2(b.perHour)}/h (${b.trades} trades, max drawdown ${b.maxDd.toFixed(0)}, P&L ${f2(b.pnl)})${vs}`);
    }
    if (base?.ok) {
      const perDay = all.map((d) => base.byDay[d] ?? 0);
      const pos = perDay.filter((v) => v > 0).length;
      console.log(`baseline: ${pos} of ${all.length} days profitable; best day ${f2(Math.max(...perDay))}, worst ${f2(Math.min(...perDay))}`);
    }
    const log = readLog(path.join(out, 'baseline.entries.jsonl'));
    if (log.length) entryReport(log);
    return;
  }
  throw new Error('usage: taJobs.ts run|report (see the header)');
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) main().catch((e) => { console.error((e as Error).stack ?? e); process.exitCode = 1; });
