// The benched features over months (thread "Rework benched features to $4.50/h"; Steven, Nov 1: "if historical data is
// used to iterate it needs to be deep on days and represent multiple market regimes"). The whole bot, as paper runs it,
// replayed on the Kalshi history days with each reworked feature at its settings: the take-profit's level, the model's
// skill weight, the exit curve's cross and its inversion (the dip buy), the probation's graded GP vote. A variant is a set of
// bot.env lines, scored by the production backtester exactly as the random sweep scores a trial (research/randomSweep.ts),
// with the pool refilled like paper.
//
//   node --import tsx research/benchedJobs.ts run    --variant baseline --days data/sweep-days --model data/models/model.json --out research/out/benched-jobs
//   node --import tsx research/benchedJobs.ts report --days data/sweep-days --out research/out/benched-jobs [--split 2026-09-01] [--block 30]
//
// The report prints aggregates only (this repository is public): $ an hour after fees on the days before and after the
// split, each variant against the baseline day by day with a bootstrap interval, and the same by block of days (one
// market regime after another), so a variant that wins only in one stretch shows it.

import fs from 'fs';
import path from 'path';
import { rng } from './stats';
import type { TrialResult } from './randomSweep';
import { recordingFiles } from '../bot/marketdata/recordingFiles';

/** Each variant's bot.env lines on top of the server's settings. The baseline is the branch's defaults: the take-profit's
 *  level ladder (adaptive), the model's skill weight (adaptive), the probation graded, the cross and the dip buy off. */
export const VARIANTS: Record<string, Record<string, string>> = {
  // Ordered by what each wave of three runners should answer first (the account runs at most three jobs at once).
  baseline: {},
  // The placebo: the same bot deciding on a tick shifted by half a second. Its gap from the baseline is path noise alone;
  // a variant's gain smaller than that gap is not believed.
  placebo: { RS_TICK_PHASE_MS: '500' },
  skill_w75: { MODEL_SKILL_W: '0.75' },
  tp_l0: { TP_LEVEL: '0' },
  tp_l1: { TP_LEVEL: '1' },
  skill_off: { MODEL_SKILL: 'false' },
  dip8: { SINUOUS_DIP_BUY: 'true', SINUOUS_DIP_MARGIN: '0.08' },
  cross_l3: { SINUOUS_CROSS: 'true', SINUOUS_CROSS_LEVEL: '3' },
  gp_full: { PROBATION_GP_MULT: '1' },
};

/** Run after the first verdicts: neighbours of the winners, the latency stress, and the other levels and margins. */
export const LATER: Record<string, Record<string, string>> = {
  base_lat500: { RS_LATENCY_MS: '500' },
  tp_l2: { TP_LEVEL: '2' },
  skill_w50: { MODEL_SKILL_W: '0.5' },
  cross_l1: { SINUOUS_CROSS: 'true', SINUOUS_CROSS_LEVEL: '1' },
  dip12: { SINUOUS_DIP_BUY: 'true', SINUOUS_DIP_MARGIN: '0.12' },
  dip8_1: { SINUOUS_DIP_BUY: 'true', SINUOUS_DIP_MARGIN: '0.08', SINUOUS_DIP_MAX: '1', SINUOUS_DIP_COOLDOWN_SEC: '300' },
  gp_low: { PROBATION_GP_MULT: '0.1' },
};

function dayList(days: string, out: string): string[] {
  const listed = fs.existsSync(days) ? recordingFiles(days).map((d) => d.day).sort() : [];
  if (listed.length) return listed;
  const seen = new Set<string>();
  for (const f of fs.existsSync(out) ? fs.readdirSync(out) : []) if (f.endsWith('.json')) for (const d of Object.keys(JSON.parse(fs.readFileSync(path.join(out, f), 'utf8')).byDay ?? {})) seen.add(d);
  return [...seen].sort();
}

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

/** Bootstrap of the mean resampling runs of `len` consecutive days (a regime lasts longer than a day; days are not
 *  independent), at the two-sided level `alpha`. */
export function blockBootMean(xs: number[], len = 7, alpha = 0.05, draws = 4000, seed = 9): { mean: number; lo: number; hi: number } {
  if (!xs.length) return { mean: NaN, lo: NaN, hi: NaN };
  const mean = xs.reduce((a, v) => a + v, 0) / xs.length;
  const r = rng(seed), n = xs.length, L = Math.max(1, Math.min(len, n));
  const ms: number[] = [];
  for (let d = 0; d < draws; d++) {
    let s = 0, k = 0;
    while (k < n) { const st = Math.floor(r() * (n - L + 1)); for (let j = 0; j < L && k < n; j++, k++) s += xs[st + j]; }
    ms.push(s / n);
  }
  ms.sort((a, b) => a - b);
  return { mean, lo: ms[Math.floor(draws * alpha / 2)], hi: ms[Math.min(draws - 1, Math.floor(draws * (1 - alpha / 2)))] };
}

/** The adversary's verdict on a variant against the baseline (Steven, Nov 1: try to break whatever creates gains). A gain
 *  counts as genuine only if it survives all of: the held-out days (after the split), a week-block bootstrap with the
 *  level corrected for the number of variants tried (Bonferroni), and most blocks of days (regimes) on its side; a
 *  variant whose gain rests on one block is reported with that block. */
export function adversary(r: TrialResult, base: TrialResult, all: string[], after: string[], blocks: string[][], tried: number): { verdict: string; line: string } {
  const diff = (ds: string[]) => ds.map((d) => ((r.byDay[d] ?? 0) - (base.byDay[d] ?? 0)) / 24);
  const alpha = 0.05 / Math.max(1, tried);
  const held = blockBootMean(diff(after), 7, alpha);
  const per = blocks.map((b) => diff(b).reduce((a, v) => a + v, 0) / Math.max(1, b.length));
  const wins = per.filter((v) => v > 0).length;
  const total = diff(all).reduce((a, v) => a + v, 0);
  const best = per.indexOf(Math.max(...per));
  const withoutBest = per.length > 1 ? (total - per[best] * blocks[best].length) / Math.max(1, all.length - blocks[best].length) : NaN;
  const genuine = held.lo > 0 && wins * 3 >= per.length * 2 && withoutBest > 0;
  const hurt = held.hi < 0;
  return {
    verdict: genuine ? 'GENUINE' : hurt ? 'LOSES' : 'NOT PROVEN',
    line: `held out, week blocks, ${(100 * (1 - alpha)).toFixed(1)}% for ${tried} variants: ${f2(held.mean)}/h [${f2(held.lo)}, ${f2(held.hi)}] | wins ${wins} of ${per.length} blocks | without its best block ${f2(withoutBest)}/h`,
  };
}

/** $ an hour of a variant on `days` (its day P&L over 24 h), and against the baseline day by day. */
export function perHour(r: TrialResult, days: string[]): number { return days.length ? days.reduce((a, d) => a + (r.byDay[d] ?? 0), 0) / (days.length * 24) : NaN; }
export function vsBase(r: TrialResult, base: TrialResult, days: string[]) { return bootMean(days.map((d) => ((r.byDay[d] ?? 0) - (base.byDay[d] ?? 0)) / 24)); }

/** Where a variant wins and loses against the baseline by market condition at entry (randomSweep.regimeKey), so a setting
 *  that pays in some conditions becomes a dynamic one there (Steven, Nov 1) instead of on or off everywhere. Conditions
 *  with fewer than `minN` markets in either run are pooled as 'thin'. */
export function byCondition(r: TrialResult, base: TrialResult, minN = 40): string {
  if (!r.byRegime || !base.byRegime) return '';
  const keys = new Set([...Object.keys(r.byRegime), ...Object.keys(base.byRegime)]);
  const rows: Array<{ k: string; d: number; n: number }> = [];
  let thin = 0, thinN = 0;
  for (const k of keys) {
    const a = r.byRegime[k] ?? { pnl: 0, n: 0 }, b = base.byRegime[k] ?? { pnl: 0, n: 0 };
    if (Math.min(a.n, b.n) < minN) { thin += a.pnl - b.pnl; thinN += b.n; continue; }
    rows.push({ k, d: a.pnl - b.pnl, n: b.n });
  }
  rows.sort((x, y) => y.d - x.d);
  const fmt = (x: { k: string; d: number; n: number }) => `${x.k} ${f2(x.d)} (${x.n} mkts)`;
  return `\n${''.padEnd(10)} by condition ($ vs baseline): ${rows.map(fmt).join(', ')}${thinN ? `, thin ${f2(thin)} (${thinN} mkts)` : ''}`;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const out = arg('out', 'research/out/benched-jobs');
  const days = arg('days', 'data/sweep-days');
  if (cmd === 'run') {
    const name = arg('variant', 'baseline');
    const env = VARIANTS[name] ?? LATER[name];
    if (!env) throw new Error(`unknown variant ${name} (${Object.keys(VARIANTS).join(', ')})`);
    const { evalTrial } = await import('./randomSweep');
    const t0 = Date.now();
    const r = await evalTrial(days, arg('model', 'data/models/model.json'), env, 3, 'all', undefined, { refill: true });
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ name, ...r }));
    const d = r.diag;
    console.log(`[benched-jobs] ${name}: ${r.ok ? `P&L ${f2(r.pnl)}, fees ${r.fees.toFixed(2)}, ${r.trades} trades, ${r.contracts} contracts, ${d?.entryEvaluations ?? 0} decisions, ${d?.refills ?? 0} refills ($${(d?.refillUsd ?? 0).toFixed(0)}), ${d?.crossSales ?? 0} cross sales, ${d?.dipBuys ?? 0} dip buys` : `FAILED ${r.error}`} in ${((Date.now() - t0) / 60_000).toFixed(1)} min`);
    return;
  }
  if (cmd === 'report') {
    const all = dayList(days, out);
    const split = arg('split', all[Math.floor(all.length * 0.5)] ?? '');
    const block = Math.max(5, Number(arg('block', '30')) || 30);
    const before = all.filter((d) => d < split), after = all.filter((d) => d >= split);
    const blocks: string[][] = [];
    for (let i = 0; i < all.length; i += block) blocks.push(all.slice(i, i + block));
    const res = new Map<string, TrialResult & { name: string }>();
    for (const f of fs.existsSync(out) ? fs.readdirSync(out) : []) if (f.endsWith('.json')) { const j = JSON.parse(fs.readFileSync(path.join(out, f), 'utf8')); res.set(j.name, j); }
    const span = (d: string[]) => (d.length ? `${d[0]}..${d[d.length - 1]} (${d.length} d)` : 'none');
    console.log(`days: all ${span(all)} | before split ${span(before)} | after ${span(after)} | blocks of ${block} d: ${blocks.map((b) => `${b[0]}..${b[b.length - 1]}`).join(', ')}`);
    const base = res.get('baseline');
    const names = [...res.keys()].sort((a, b) => (a === 'baseline' ? -1 : b === 'baseline' ? 1 : a.localeCompare(b)));
    for (const name of names) {
      const r = res.get(name)!;
      if (!r.ok) { console.log(`${name}: FAILED ${r.error}`); continue; }
      const d = r.diag;
      let line = `${name.padEnd(10)} all ${f2(perHour(r, all))}/h | before ${f2(perHour(r, before))}/h | after ${f2(perHour(r, after))}/h | ${r.trades} trades, ${d?.refills ?? 0} refills, ${d?.crossSales ?? 0} cross sales, ${d?.dipBuys ?? 0} dip buys`;
      if (base?.ok && name !== 'baseline') {
        const a = vsBase(r, base, all), b = vsBase(r, base, after);
        const adv = adversary(r, base, all, after, blocks, res.size - 1);
        line += `\n${''.padEnd(10)} adversary: ${adv.verdict} (${adv.line})`;
        line += byCondition(r, base);
        line += `\n${''.padEnd(10)} vs baseline: all ${f2(a.mean)}/h [${f2(a.lo)}, ${f2(a.hi)}] | after split ${f2(b.mean)}/h [${f2(b.lo)}, ${f2(b.hi)}] | by block ${blocks.map((x) => f2(vsBase(r, base, x).mean)).join(' ')}`;
      } else line += `\n${''.padEnd(10)} by block ${blocks.map((x) => f2(perHour(r, x))).join(' ')}/h; ${all.filter((x) => (r.byDay[x] ?? 0) > 0).length} of ${all.length} days profitable`;
      console.log(line);
    }
    return;
  }
  throw new Error('usage: benchedJobs.ts run|report (see the header)');
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) main().catch((e) => { console.error((e as Error).stack ?? e); process.exitCode = 1; });
