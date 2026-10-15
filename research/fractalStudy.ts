// Fractal Alignment Engine study (bot/macro/fractalEngine.ts) on the stored BTC.D history:
//   - today's alignment: the parent week matched to now, the phase, dilation, fit, the projection and the next waterfall
//   - the alignment week by week since the child had a year (how the matched parent date moved)
//   - walk-forward skill of the projection: at every week, the engine's projected BTC.D change over 30 / 90 / 180
//     days (from data known then) against what happened, next to "no change" (the persistence baseline): mean
//     absolute error and the hit rate on the direction of the move. The engine is a map of the cycle, not a
//     forecaster with a record; this says how far its projection can be trusted, and when.
//
//   npm run research:fractal [-- --history data/history --out data/models/fractal_study.json]
import fs from 'fs';
import path from 'path';
import { macroConfig } from '../bot/config';
import { fractalState, projectedCross } from '../bot/macro/fractalEngine';
import { loadMacroDaily, macroSettings } from '../bot/macro/macroSeries';
import { gateHit, shibVelocity, usdtBreakdown } from '../bot/macro/waterfall';

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }

export interface FractalStudy {
  now: ReturnType<typeof summary> | null;
  weekly: Array<{ asOf: string; parent: string; progress: number; phase: string; fit: number; recentFit: number; btcd: number }>;
  skill: Record<'d30' | 'd90' | 'd180', { n: number; maeEngine: number; maeFlat: number; directionHit: number; byFit: { high: { n: number; maeEngine: number; maeFlat: number; directionHit: number } } }>;
  parentBars: number;
}

function summary(s: NonNullable<ReturnType<typeof fractalState>>, gate: number) {
  return {
    asOf: iso(s.asOf), parent: iso(s.parentTs), progress: +s.progress.toFixed(3), phase: s.phase, dilation: +s.dilation.toFixed(2), localDilation: +s.localDilation.toFixed(2),
    map: { a: +s.map.a.toFixed(2), b: +s.map.b.toFixed(3) }, fit: { r: +s.fit.r.toFixed(3), recentR: +s.fit.recentR.toFixed(3), maePts: +s.fit.maePts.toFixed(2), recentMaePts: +s.fit.recentMaePts.toFixed(2) },
    btcd: +s.btcd.toFixed(2), proj: { d30: +s.proj.d30.toFixed(2), d90: +s.proj.d90.toFixed(2), d180: +s.proj.d180.toFixed(2) },
    nextWaterfall: s.nextWaterfall ? { start: iso(s.nextWaterfall.startTs), end: iso(s.nextWaterfall.endTs), from: +s.nextWaterfall.fromBtcd.toFixed(1), to: +s.nextWaterfall.toBtcd.toFixed(1), weeksAway: +s.nextWaterfall.weeksAway.toFixed(1), inside: s.nextWaterfall.inside } : null,
    low: s.low ? { at: iso(s.low.ts), btcd: +s.low.btcd.toFixed(1) } : null,
    gateCross: (() => { const c = projectedCross(s, gate); return c ? iso(c) : null; })(),
  };
}

export function fractalStudy(hist: string, now = Date.now()): FractalStudy {
  const { fractal: cfg, params } = macroSettings(macroConfig(process.env));
  const daily = loadMacroDaily(hist);
  const btcd = daily.btcd;
  const parentBars = btcd.filter((c) => c.ts >= cfg.parentFrom && c.ts < cfg.parentTo).length;
  const closeAt = (t: number) => { let lo = 0, hi = btcd.length; while (lo < hi) { const m = (lo + hi) >> 1; if (btcd[m].ts + DAY <= t) lo = m + 1; else hi = m; } return lo > 0 ? btcd[lo - 1].c : NaN; };
  const weekly: FractalStudy['weekly'] = [];
  const errs: Record<'d30' | 'd90' | 'd180', Array<{ e: number; f: number; hit: number; fit: number }>> = { d30: [], d90: [], d180: [] };
  for (let t = cfg.childFrom + cfg.minChildBars * cfg.barMs; t <= now; t += cfg.barMs) {
    const s = fractalState(btcd, t, cfg);
    if (!s) continue;
    weekly.push({ asOf: iso(s.asOf), parent: iso(s.parentTs), progress: +s.progress.toFixed(3), phase: s.phase, fit: +s.fit.r.toFixed(3), recentFit: +s.fit.recentR.toFixed(3), btcd: +s.btcd.toFixed(2) });
    for (const [k, days] of [['d30', 30], ['d90', 90], ['d180', 180]] as const) {
      const p = s.proj[k];
      const later = s.asOf + days * DAY;
      if (!Number.isFinite(p) || later > now) continue;
      const real = closeAt(later + DAY);
      if (!Number.isFinite(real)) continue;
      errs[k].push({ e: Math.abs(p - real), f: Math.abs(s.btcd - real), hit: Math.sign(p - s.btcd) === Math.sign(real - s.btcd) ? 1 : 0, fit: Math.min(s.fit.r, s.fit.recentR) });
    }
  }
  const agg = (xs: Array<{ e: number; f: number; hit: number }>) => ({ n: xs.length, maeEngine: +(xs.reduce((a, x) => a + x.e, 0) / Math.max(1, xs.length)).toFixed(2), maeFlat: +(xs.reduce((a, x) => a + x.f, 0) / Math.max(1, xs.length)).toFixed(2), directionHit: +(xs.reduce((a, x) => a + x.hit, 0) / Math.max(1, xs.length)).toFixed(3) });
  const skill = Object.fromEntries((['d30', 'd90', 'd180'] as const).map((k) => [k, { ...agg(errs[k]), byFit: { high: agg(errs[k].filter((x) => x.fit >= params.minFit)) } }])) as FractalStudy['skill'];
  const s = fractalState(btcd, now, cfg);
  return { now: s ? summary(s, params.gate) : null, weekly, skill, parentBars };
}

function main() {
  const hist = cliArg('history', process.env.HISTORY_DIR ?? 'data/history');
  const out = cliArg('out', '');
  const r = fractalStudy(hist);
  const { params } = macroSettings(macroConfig(process.env));
  const daily = loadMacroDaily(hist);
  console.log(`BTC.D daily bars: ${daily.btcd.length} (${daily.btcd.length ? `${iso(daily.btcd[0].ts)} .. ${iso(daily.btcd[daily.btcd.length - 1].ts)}` : 'none'}), ${r.parentBars} in the parent window`);
  if (!r.now) { console.log('no alignment: BTC.D history for the parent window (2016-2017) is missing or the child has under a year of weeks'); }
  else console.log('now:', JSON.stringify(r.now, null, 2));
  const hit = gateHit(daily.btcd, Date.now(), params.gate);
  console.log(`gate ${params.gate}%: ${hit ? `hit ${iso(hit.ts)} at ${hit.level.toFixed(2)}% (peak ${hit.peak.toFixed(2)}%)` : 'not hit'} | USDT.D breakdown: ${usdtBreakdown(daily.usdtd, Date.now()) ?? 'n/a'} | SHIB velocity: ${shibVelocity(daily.shib, Date.now())?.toFixed(2) ?? 'n/a'}`);
  console.log('\nweekly alignment (every 13th week):');
  for (const w of r.weekly.filter((_, i, a) => i % 13 === 0 || i === a.length - 1)) console.log(`  ${w.asOf}  BTC.D ${w.btcd.toFixed(1).padStart(5)}  parent ${w.parent}  ${(100 * w.progress).toFixed(0).padStart(3)}%  fit ${w.fit.toFixed(2)}/${w.recentFit.toFixed(2)}  ${w.phase}`);
  console.log('\nprojection skill (walk-forward; flat = no change):');
  for (const [k, v] of Object.entries(r.skill)) console.log(`  ${k}: n ${v.n}, MAE engine ${v.maeEngine} vs flat ${v.maeFlat} pts, direction ${(100 * v.directionHit).toFixed(0)}% | fit >= ${params.minFit}: n ${v.byFit.high.n}, MAE ${v.byFit.high.maeEngine} vs ${v.byFit.high.maeFlat}, direction ${(100 * v.byFit.high.directionHit).toFixed(0)}%`);
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(r, null, 2)); console.log(`\nwrote ${out}`); }
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) main();
