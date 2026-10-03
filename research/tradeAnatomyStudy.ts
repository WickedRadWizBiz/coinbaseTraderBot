// Trade anatomy: why do the losing trades lose? For every trade of one setup type, by side:
//   - how far price went our way before the exit (max favourable excursion, MFE, in R) and against us
//     (MAE), so "it was +1.2R up and still stopped out" shows up as a number;
//   - whether the opposite trade (same stop distance, same moment) would have reached +1R first;
// then exit-rule changes suggested by those numbers, chosen per side on the tuning window and checked
// on the later test window.
//
//   npx tsx research/tradeAnatomyStudy.ts [historyDir] [tf] [kind]      (defaults: 1h burst)
import path from 'path';
import { loadAssetBars, simulateSetup } from './trainSetupModel';
import { detectAt, TF_MS, type ExitPlan, type SetupSignal } from '../bot/setups/detectors';
import { DEFAULT_COSTS, tradeResult, type OpenTrade } from '../bot/setups/exits';
import type { Timeframe } from '../bot/ta/knowledge';

const TUNE_FROM = Date.UTC(2020, 0, 1), TEST_FROM = Date.UTC(2025, 6, 1);
const M15 = 900_000;

type A = NonNullable<ReturnType<typeof loadAssetBars>>;
const riskOf = (t: OpenTrade) => Math.abs(t.entry - t.initialStop);
const R = (t: OpenTrade) => tradeResult(t).r;

/** Did the opposite trade (same stop distance) reach +1R before -1R within the setup's time limit? */
function oppositeWins(A: A, s: SetupSignal, t: OpenTrade): boolean {
  const risk = riskOf(t), d = -s.dir, e = t.entry;
  const up = e + d * risk, dn = e - d * risk;
  let k = A.m15Idx.get(t.entryTs) ?? -1;
  if (k < 0) return false;
  const end = t.entryTs + s.plan.maxBars * TF_MS[s.tf]!;
  for (; k < A.m15.length && A.m15[k].ts < end; k++) {
    const b = A.m15[k];
    const hitStop = d > 0 ? b.l <= dn : b.h >= dn, hitTgt = d > 0 ? b.h >= up : b.l <= up;
    if (hitStop) return false;
    if (hitTgt) return true;
  }
  return false;
}

function anatomy(label: string, rows: Array<{ A: A; s: SetupSignal; t: OpenTrade }>) {
  const n = rows.length;
  if (!n) { console.log(`  ${label}: no trades`); return; }
  const losers = rows.filter((x) => tradeResult(x.t).ret <= 0), winners = rows.filter((x) => tradeResult(x.t).ret > 0);
  const mfe = (x: { t: OpenTrade }) => (x.t.dir * ((x.t.maxFav ?? x.t.entry) - x.t.entry)) / riskOf(x.t);
  const mae = (x: { t: OpenTrade }) => (x.t.dir * (x.t.entry - (x.t.maxAdv ?? x.t.entry))) / riskOf(x.t);
  const pct = (xs: unknown[], of: unknown[]) => `${((100 * xs.length) / Math.max(1, of.length)).toFixed(0)}%`;
  const avg = (xs: number[]) => xs.reduce((a, v) => a + v, 0) / Math.max(1, xs.length);
  console.log(`  ${label}: ${n} trades, win ${pct(winners, rows)}, net ${avg(rows.map((x) => R(x.t))).toFixed(3)}R/trade`);
  console.log(`    losers (${losers.length}): reached +0.5R first ${pct(losers.filter((x) => mfe(x) >= 0.5), losers)}, +1R ${pct(losers.filter((x) => mfe(x) >= 1), losers)}, +1.5R ${pct(losers.filter((x) => mfe(x) >= 1.5), losers)}, +2R ${pct(losers.filter((x) => mfe(x) >= 2), losers)}; never got past +0.25R ${pct(losers.filter((x) => mfe(x) < 0.25), losers)}`);
  console.log(`    losers: the opposite trade would have won +1R first ${pct(losers.filter((x) => oppositeWins(x.A, x.s, x.t)), losers)}  (all trades: ${pct(rows.filter((x) => oppositeWins(x.A, x.s, x.t)), rows)})`);
  console.log(`    winners (${winners.length}): avg MFE ${avg(winners.map(mfe)).toFixed(2)}R, kept ${avg(winners.map((x) => R(x.t))).toFixed(2)}R (gave back ${(avg(winners.map(mfe)) - avg(winners.map((x) => R(x.t)))).toFixed(2)}R); avg MAE ${avg(winners.map(mae)).toFixed(2)}R`);
  const byExit: Record<string, number[]> = {};
  for (const x of rows) (byExit[x.t.closed!.reason] ??= []).push(R(x.t));
  console.log(`    exits: ${Object.entries(byExit).map(([k, v]) => `${k} ${v.length} (${avg(v).toFixed(2)}R)`).join(', ')}`);
}

const VARIANTS: Record<string, (p: ExitPlan, s: SetupSignal) => ExitPlan> = {
  current: (p) => p,
  'break-even at +1R': (p) => ({ ...p, breakevenR: 1 }),
  'break-even at +0.5R': (p) => ({ ...p, breakevenR: 0.5 }),
  'half off at +1R, then trail': (p, s) => ({ ...p, target1: s.ref + s.dir * Math.abs(s.ref - s.stop) }),
  'half off at +1.5R, then trail': (p, s) => ({ ...p, target1: s.ref + s.dir * 1.5 * Math.abs(s.ref - s.stop) }),
  'trail 1.5 ATR': (p) => ({ ...p, trailAtr: 1.5 }),
  'trail 3.5 ATR': (p) => ({ ...p, trailAtr: 3.5 }),
  'time stop 8 bars': (p) => ({ ...p, maxBars: 8 }),
  'time stop 32 bars': (p) => ({ ...p, maxBars: 32 }),
  'break-even +1R and trail 3.5 ATR': (p) => ({ ...p, breakevenR: 1, trailAtr: 3.5 }),
  'lock profit: trail 1.5 ATR after +2R': (p) => ({ ...p, tightenAfterR: 2, tightTrailAtr: 1.5 }),
  'lock profit: trail 1.5 ATR after +1.5R': (p) => ({ ...p, tightenAfterR: 1.5, tightTrailAtr: 1.5 }),
  'lock profit: trail 1 ATR after +2.5R': (p) => ({ ...p, tightenAfterR: 2.5, tightTrailAtr: 1 }),
};

function main(hist: string, tf: Timeframe, kind: string) {
  const assets = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'].map((a) => loadAssetBars(hist, a)!).filter(Boolean);
  const sigs: Array<{ A: A; s: SetupSignal }> = [];
  for (const A of assets) {
    const se = A.series[tf]!;
    for (let i = 60; i < se.cs.length; i++) { if (se.cs[i].ts < TUNE_FROM) continue; const g = detectAt(A.asset, tf, se, i, process.env.NO_DAILY ? undefined : A.series['1d']); if (g?.kind === kind) sigs.push({ A, s: g }); }
  }
  console.log(`\n=== ${tf} ${kind}: ${sigs.length} setups since 2020 (tuning = 2020 to Jun 2025, test = Jul 2025 on) ===`);
  const run = (v: (p: ExitPlan, s: SetupSignal) => ExitPlan) => sigs.map(({ A, s }) => ({ A, s, t: simulateSetup(A, { ...s, plan: v(s.plan, s) }, DEFAULT_COSTS) })).filter((x): x is { A: A; s: SetupSignal; t: OpenTrade } => Boolean(x.t?.closed));
  const cur = run(VARIANTS.current);
  for (const side of [1, -1] as const) {
    console.log(`\n-- ${side > 0 ? 'LONGS' : 'SHORTS'} --`);
    anatomy('tuning', cur.filter((x) => x.s.dir === side && x.s.ts < TEST_FROM));
    anatomy('test  ', cur.filter((x) => x.s.dir === side && x.s.ts >= TEST_FROM));
  }
  console.log('\n-- exit-rule changes, net R per trade (tuning | test), per side --');
  const best: Record<number, { name: string; r: number }> = { 1: { name: '', r: -Infinity }, [-1]: { name: '', r: -Infinity } };
  const results: Record<string, Record<number, [number, number, number, number]>> = {};
  for (const [name, v] of Object.entries(VARIANTS)) {
    const rows = run(v);
    results[name] = {};
    for (const side of [1, -1] as const) {
      const tune = rows.filter((x) => x.s.dir === side && x.s.ts < TEST_FROM), test = rows.filter((x) => x.s.dir === side && x.s.ts >= TEST_FROM);
      const m = (xs: typeof rows) => xs.reduce((a, x) => a + R(x.t), 0) / Math.max(1, xs.length);
      results[name][side] = [m(tune), tune.length, m(test), test.length];
      if (m(tune) > best[side].r) best[side] = { name, r: m(tune) };
    }
    const L = results[name][1], S = results[name][-1];
    console.log(`  ${name.padEnd(34)} longs ${L[0].toFixed(3)} (${L[1]}) | ${L[2].toFixed(3)} (${L[3]})    shorts ${S[0].toFixed(3)} (${S[1]}) | ${S[2].toFixed(3)} (${S[3]})`);
  }
  // Entry filter: the daily trend must agree (last closed day's close vs its SMA 50, and SMA 50 vs SMA 200).
  console.log('\n-- entry filter: daily trend agrees (current exits), net R per trade (tuning | test) --');
  const dailyOk = (x: { A: A; s: SetupSignal }, mode: 'sma50' | 'sma50_200') => {
    const d = x.A.series['1d']!, t = x.s.ts + TF_MS[x.s.tf]!;
    let lo = 0, hi = d.cs.length - 1, j = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (d.cs[m].ts + 86_400_000 <= t) { j = m; lo = m + 1; } else hi = m - 1; }
    if (j < 0 || !Number.isFinite(d.sma50[j])) return true;
    const above = d.cs[j].c > d.sma50[j], golden = d.sma50[j] > d.sma200[j];
    if (mode === 'sma50') return x.s.dir > 0 ? above : !above;
    return x.s.dir > 0 ? above && golden : !above && !golden;
  };
  for (const mode of ['sma50', 'sma50_200'] as const) {
    const rows = cur.filter((x) => dailyOk(x, mode));
    const m = (xs: typeof rows) => xs.reduce((a, x) => a + R(x.t), 0) / Math.max(1, xs.length);
    const part = (side: number, test: boolean) => rows.filter((x) => x.s.dir === side && (x.s.ts >= TEST_FROM) === test);
    console.log(`  daily ${mode === 'sma50' ? 'close vs SMA50' : 'close vs SMA50 and SMA50 vs SMA200'}: longs ${m(part(1, false)).toFixed(3)} (${part(1, false).length}) | ${m(part(1, true)).toFixed(3)} (${part(1, true).length})    shorts ${m(part(-1, false)).toFixed(3)} (${part(-1, false).length}) | ${m(part(-1, true)).toFixed(3)} (${part(-1, true).length})`);
  }
  for (const side of [1, -1] as const) {
    const r = results[best[side].name][side];
    console.log(`\n  ${side > 0 ? 'LONGS' : 'SHORTS'}: best on tuning = "${best[side].name}" (${r[0].toFixed(3)}R); on the unseen test window ${r[2].toFixed(3)}R over ${r[3]} trades (current: ${results.current[side][2].toFixed(3)}R)`);
  }
  void M15;
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) main(process.argv[2] ?? 'data/history', (process.argv[3] ?? '1h') as Timeframe, process.argv[4] ?? 'burst');
