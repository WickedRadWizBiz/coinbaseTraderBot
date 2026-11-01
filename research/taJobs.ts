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
import type { MidGateParams } from '../bot/model/midTakeGate';
import { recordingFiles } from '../bot/marketdata/recordingFiles';

/** Each variant's bot.env lines on top of the server's settings. The jobs add theirs as they are built. */
// Round 2 (run 41178608433, 120 days, $200 pool refilled like paper; $/h after Sep 1 vs the baseline's -2.50, with the
// day-bootstrap interval): j1_lag +0.14 [-0.34,+0.63], j1_voltarget +0.25 [-0.08,+0.62], j2_maker +0.35 [-0.11,+0.83],
// j2_maker_hi +1.01 [+0.36,+1.63], dir_lean +0.44 [-0.05,+0.96], j4_extreme -0.68 [-1.31,-0.05], j4_extreme_lo -0.69,
// all_on +0.60, j3_gate +5.25 [+3.81,+6.79] (+2.75/h), j3_gate_margin (1c) +5.99 [+4.49,+7.63] (+3.49/h), all_in +5.10.
// Round 3 (run 41201349346): g_m3 +4.41/h, g_m2 +2.51, 1c +2.61 (round 2: +3.49), leans on g_m2 +2.19, full +2.28;
// j4_v2 +0.17 [-0.08,+0.43] (job 4 no longer loses). Its gate replays started hours after its baseline and restored a
// newer copy of the server's model, so round 4 pins one copy for every replay and repeats the margins with the stacks.
// No job is switched off (Steven, Oct 31).
export const VARIANTS: Record<string, Record<string, string>> = {
  baseline: {},
  // Job 4, second iteration: sell on the stretch only near the fair value and for half of what is left to make.
  j4_v2: { TA_EXIT_EXTREME_VOTES: '1.5', TA_EXIT_EXTREME_EDGE: '0', TA_EXIT_EXTREME_SHARE: '0.5' },
};

/** Where train-gate writes the mid-anchored take gate (job 3) the gate variants read. */
const GATE_FILE = 'data/models/take_mid.json';
const LEANS = { TA_LEAN_MAKER: '0.01', TA_LEAN_PRICE: '0.005' };
const LAG = { DYN_EDGE_VOL: '-0.02', DYN_EDGE_MAX_DOWN: '0.02' };
const gate = (m: string) => ({ TAKE_MID_GATE: GATE_FILE, TAKE_MID_MARGIN: m });
export const GATE_VARIANTS: Record<string, Record<string, string>> = {
  j3_gate_margin: gate('0.01'),
  g_m3: gate('0.03'),
  g_m5: gate('0.05'),
  g_m3_maker: { ...gate('0.03'), TA_LEAN_MAKER: '0.01' },
  g_m3_full: { ...gate('0.03'), ...LEANS, ...LAG, ...VARIANTS.j4_v2 },
  // The skipped maker quotes lost 3c a contract: buy their other side instead when the gate favours it.
  g_m3_flip: { ...gate('0.03'), TAKE_MID_FLIP: 'true' },
  // Adversaries for the 3c gate (train-gate writes their files beside the gate's): see train-gate.
  adv_placebo: { ...gate('0.03'), TAKE_MID_GATE: GATE_FILE.replace('.json', '_placebo.json') },
  adv_midonly: { ...gate('0.03'), TAKE_MID_GATE: GATE_FILE.replace('.json', '_midonly.json') },
  adv_random: { ...gate('0.03'), TAKE_MID_GATE: GATE_FILE.replace('.json', '_random.json') },
  adv_reverse: { ...gate('0.03'), TAKE_MID_GATE: GATE_FILE.replace('.json', '_reverse.json') },
};

function dayList(days: string, out: string): string[] {
  const listed = fs.existsSync(days) ? recordingFiles(days).map((d) => d.day).sort() : [];
  if (listed.length) return listed;
  const seen: string[] = [];
  for (const f of fs.existsSync(out) ? fs.readdirSync(out) : []) if (f.endsWith('.json')) seen.push(...Object.keys(JSON.parse(fs.readFileSync(path.join(out, f), 'utf8')).byDay ?? {}));
  if (!seen.length) return [];
  seen.sort();
  const res: string[] = [];
  for (let t = Date.parse(`${seen[0]}T00:00:00Z`); t <= Date.parse(`${seen[seen.length - 1]}T00:00:00Z`); t += 86_400_000) res.push(new Date(t).toISOString().slice(0, 10));
  return res;
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

/** The baseline's entry log, from every part it ran in (baseline.entries.jsonl, baseline.p1.entries.jsonl, ...). */
function baselineLog(out: string): EntryLogRow[] {
  return (fs.existsSync(out) ? fs.readdirSync(out) : []).filter((f) => /^baseline(\.p\d+)?\.entries\.jsonl$/.test(f)).flatMap((f) => readLog(path.join(out, f)));
}

/** Two parts of one variant's replay (older and newer days) as one result. */
function mergeParts(a: TrialResult, b: TrialResult): TrialResult {
  const add = (x: Record<string, number>, y: Record<string, number>) => { const o = { ...x }; for (const [k, v] of Object.entries(y ?? {})) o[k] = (o[k] ?? 0) + v; return o; };
  return {
    ...a, ok: a.ok && b.ok, error: a.error ?? b.error, pnl: a.pnl + b.pnl, fees: a.fees + b.fees, contracts: a.contracts + b.contracts, fills: a.fills + b.fills, trades: a.trades + b.trades,
    byDay: add(a.byDay, b.byDay), tradesByDay: add(a.tradesByDay, b.tradesByDay), byHour: add(a.byHour, b.byHour),
    diag: a.diag && b.diag ? { entryEvaluations: a.diag.entryEvaluations + b.diag.entryEvaluations, accuracyBlocks: a.diag.accuracyBlocks + b.diag.accuracyBlocks, refills: a.diag.refills + b.diag.refills, refillUsd: a.diag.refillUsd + b.diag.refillUsd } : a.diag ?? b.diag,
  };
}

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
  if (cmd === 'run') {
    const name = arg('variant', 'baseline');
    const env = VARIANTS[name] ?? GATE_VARIANTS[name];
    if (!env) throw new Error(`unknown variant ${name} (${[...Object.keys(VARIANTS), ...Object.keys(GATE_VARIANTS)].join(', ')})`);
    const { evalTrial } = await import('./randomSweep');
    const t0 = Date.now();
    // --part p1: one stretch of the days (randomSweep.ts days --part); the report adds a variant's parts together.
    const part = arg('part', ''), tag = part ? `${name}.${part}` : name;
    const r = await evalTrial(days, arg('model', 'data/models/model.json'), env, 3, 'all', undefined, { entryLog: process.argv.includes('--entry-log') ? path.join(out, `${tag}.entries.jsonl`) : undefined, refill: true });
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, `${tag}.json`), JSON.stringify({ name, part, ...r }));
    console.log(`[ta-jobs] ${name}: ${r.ok ? `P&L ${f2(r.pnl)}, fees ${r.fees.toFixed(2)}, ${r.trades} trades, ${r.contracts} contracts, ${r.diag?.entryEvaluations ?? 0} decisions, ${r.diag?.accuracyBlocks ?? 0} accuracy blocks, ${r.diag?.refills ?? 0} refills ($${(r.diag?.refillUsd ?? 0).toFixed(0)})` : `FAILED ${r.error}`} in ${((Date.now() - t0) / 60_000).toFixed(1)} min`);
    return;
  }
  if (cmd === 'train-gate') {
    // Job 3: the mid-anchored take gate from the baseline's entry fills before the split, checked on those after it.
    const { fitMidGate, midGateInputs, midGateProbability } = await import('../bot/model/midTakeGate');
    const all = dayList(days, out);
    const split = arg('split', all[Math.floor(all.length * 0.5)] ?? '');
    const rows = baselineLog(out).map((r) => {
      const { x, midSide } = midGateInputs(r.side, r.price, !r.taker, r.pYes, r.mid, r.spread ?? 0.02, r.tauSec, r.f);
      return { x, midSide, won: Boolean(r.won), weight: r.count, day: new Date(r.t).toISOString().slice(0, 10), r };
    });
    const train = rows.filter((x) => x.day < split), test = rows.filter((x) => x.day >= split);
    const fit = fitMidGate(train);
    const ll = (p: number, y: boolean) => -Math.log(Math.max(1e-6, y ? p : 1 - p));
    const w = test.reduce((a, x) => a + x.weight, 0) || 1;
    const llMid = test.reduce((a, x) => a + x.weight * ll(Math.min(0.9999, Math.max(1e-4, x.midSide)), x.won), 0) / w;
    const params = { ...fit, validation: { n: test.length, logLossMid: llMid, logLossGate: 0, validated: false, from: split, to: all[all.length - 1] } };
    params.validation.logLossGate = test.reduce((a, x) => a + x.weight * ll(midGateProbability(params, x.x, x.midSide), x.won), 0) / w;
    params.validation.validated = test.length >= 300 && params.validation.logLossGate < params.validation.logLossMid;
    fs.mkdirSync(path.dirname(GATE_FILE), { recursive: true });
    const gateOut = arg('gate-out', GATE_FILE);
    fs.writeFileSync(gateOut, JSON.stringify(params));
    // Adversaries (Steven, Nov 1: try to break what makes the gains). Each is forced on, so its replay shows what it does:
    //   placebo  the same fit on shuffled win/loss labels: any gain it keeps is not the inputs' doing
    //   midonly  no inputs at all (P(win) = the mid): what skipping on price vs the mid alone is worth
    //   random   skips entries at random at the real gate's held-out skip share: what trading less alone is worth
    //   reverse  fit on the days after the split, used on those before: the gain must hold backwards in time
    const on = (g: Omit<MidGateParams, 'validation'>, extra: Record<string, unknown> = {}) => ({ ...g, ...extra, validation: { ...params.validation, validated: true } });
    const shuf = rng(97);
    const labels = train.map((x) => x.won);
    for (let i = labels.length - 1; i > 0; i--) { const j = Math.floor(shuf() * (i + 1)); [labels[i], labels[j]] = [labels[j], labels[i]]; }
    const ctl = (k: string) => gateOut.replace(/\.json$/, `_${k}.json`);
    fs.writeFileSync(ctl('placebo'), JSON.stringify(on(fitMidGate(train.map((x, i) => ({ ...x, won: labels[i] }))))));
    fs.writeFileSync(ctl('midonly'), JSON.stringify(on({ ...fit, w: fit.w.map(() => 0), b: 0 })));
    const skipShare = test.length ? 1 - test.filter((x) => midGateProbability(params, x.x, x.midSide) >= x.r.price + x.r.fee).length / test.length : 0;
    fs.writeFileSync(ctl('random'), JSON.stringify(on({ ...fit, w: fit.w.map(() => 0), b: 50 }, { randomSkip: skipShare })));
    fs.writeFileSync(ctl('reverse'), JSON.stringify(on(fitMidGate(test))));
    console.log(`[ta-jobs] adversary gates written (random skips ${(100 * skipShare).toFixed(0)}% of entries)`);
    console.log(`[ta-jobs] gate: trained on ${train.length} entry fills before ${split}, checked on ${test.length} after: log loss ${params.validation.logLossGate.toFixed(4)} vs the mid ${llMid.toFixed(4)} -> ${params.validation.validated ? 'VALIDATED' : 'not validated (the gate stays off in its variants)'}`);
    const top = fit.features.map((n, i) => ({ n, w: fit.w[i] })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w)).slice(0, 10);
    console.log(`[ta-jobs] gate weights (per standard deviation, + = more likely to win): ${top.map((t) => `${t.n} ${f2(t.w)}`).join(', ')}`);
    // What skipping would have done on the held-out fills (held to settlement): kept vs skipped, c/ct after fees.
    const kept = test.filter((x) => midGateProbability(params, x.x, x.midSide) >= x.r.price + x.r.fee), skipped = test.filter((x) => !kept.includes(x));
    console.log(`[ta-jobs] gate on held-out fills: kept ${summary(kept.map((x) => x.r))} | skipped ${summary(skipped.map((x) => x.r))}`);
    // Job 5, the signals reweighted by their record: does the frozen gate decay, and does refitting it every 15 days on
    // every fill before the block (the weights follow each input's latest record; none is switched off) keep its edge?
    const days15 = [...new Set(test.map((x) => x.day))].sort();
    for (let i = 0; i < days15.length; i += 15) {
      const from = days15[i], to = days15[Math.min(days15.length, i + 15) - 1];
      const blk = test.filter((x) => x.day >= from && x.day <= to);
      if (blk.length < 50) continue;
      const refit = { ...fitMidGate(rows.filter((x) => x.day < from)), validation: params.validation };
      const bw = blk.reduce((a, x) => a + x.weight, 0) || 1;
      const llOf = (g: typeof params | null) => blk.reduce((a, x) => a + x.weight * ll(g ? midGateProbability(g, x.x, x.midSide) : Math.min(0.9999, Math.max(1e-4, x.midSide)), x.won), 0) / bw;
      const keptBy = (g: typeof params) => blk.filter((x) => midGateProbability(g, x.x, x.midSide) >= x.r.price + x.r.fee).map((x) => x.r);
      console.log(`[ta-jobs] job 5 ${from}..${to}: log loss mid ${llOf(null).toFixed(4)}, frozen ${llOf(params).toFixed(4)}, refit ${llOf(refit).toFixed(4)} | kept frozen ${summary(keptBy(params))} | kept refit ${summary(keptBy(refit))}`);
    }
    return;
  }
  if (cmd === 'report') {
    const { scoreOf } = await import('./randomSweep');
    const all = dayList(days, out);
    const split = arg('split', all[Math.floor(all.length * 0.5)] ?? '');
    const train = all.filter((d) => d < split), test = all.filter((d) => d >= split);
    const res = new Map<string, TrialResult>();
    for (const f of fs.existsSync(out) ? fs.readdirSync(out) : []) if (f.endsWith('.json')) { const j = JSON.parse(fs.readFileSync(path.join(out, f), 'utf8')); const had = res.get(j.name); res.set(j.name, had ? mergeParts(had, j) : j); }
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
      if (r.diag) console.log(`${''.padEnd(14)} ${r.diag.entryEvaluations} decisions, ${r.diag.accuracyBlocks} accuracy-gate blocks, ${r.diag.refills} refills ($${r.diag.refillUsd.toFixed(0)}), ${r.contracts} contracts, fees ${r.fees.toFixed(0)}, days traded ${Object.keys(r.tradesByDay ?? {}).length}`);
    }
    if (base?.ok) {
      const perDay = all.map((d) => base.byDay[d] ?? 0);
      const pos = perDay.filter((v) => v > 0).length;
      console.log(`baseline: ${pos} of ${all.length} days profitable; best day ${f2(Math.max(...perDay))}, worst ${f2(Math.min(...perDay))}`);
    }
    const log = baselineLog(out);
    if (log.length) entryReport(log);
    return;
  }
  throw new Error('usage: taJobs.ts run|report (see the header)');
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) main().catch((e) => { console.error((e as Error).stack ?? e); process.exitCode = 1; });
