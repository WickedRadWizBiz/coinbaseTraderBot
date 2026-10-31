// SNN staging ablations (PDF section 5): walk-forward replay with strict timestamps, one mechanism
// at a time, unit of evidence = settlement EVENT (strikes within one event are averaged into one
// observation), paired per-event Brier difference with a day-block bootstrap 95% CI.
//
// A mechanism is accepted only if ALL hold:
//   (a) the CI of delta = Brier(new) - Brier(old) lies entirely below 0;
//   (b) the calibration slope of p_snn stays within 0.9-1.1;
//   (c) correlation with p_model stays below 0.7;
//   (d) the blended p_final Brier improves over p_model alone (event-clustered CI below 0);
//   (e) latency p99 and health stay in band (p99 step < 150 ms, frozen < 5% of steps, no NaN restore);
//   (f) fee-aware paper P&L of p_final is not worse than p_model's (alongside Brier, never instead).
// Each mechanism's hyperparameter grid is pre-registered (--grid file) and capped at 20 configs;
// every configuration tried is reported.
//
//   npm run research:snn-ablation -- --recordings data/recordings [--grid grid.json] [--model params/model.json] [--from 2026-06-01 --to 2026-07-01] [--out research/out/snn_ablation.json]

import fs from 'fs';
import path from 'path';
import { loadCalendar } from '../bot/model/calendar';
import { MetaModel } from '../bot/model/metaModel';
import { dayBlockBootstrap } from '../bot/snn/blender';
import { blend, brier, calibrationSlope, correlation, surpriseConfidence } from '../bot/snn/formulas';
import { DEFAULT_SNN, domainParams, stageFlags, type SnnFlags, type SnnParams, type Stage } from '../bot/snn/params';
import { replaySnn, type SnnReplayResult, type SnnRow } from './snnReplay';
import { replayGain, volScaled, type GainOpts } from '../bot/snn/correctionGain';

export interface Mechanism { name: string; candidate: { stage: Stage; flags?: Partial<SnnFlags>; params?: Partial<SnnParams> }; baseline: { stage: Stage; flags?: Partial<SnnFlags>; params?: Partial<SnnParams> }; note: string }

/** The staging order and each stage's comparison (S0..S6, then the deferred mechanisms vs proxies). */
export const MECHANISMS: Mechanism[] = [
  { name: 'S0 reservoir vs raw logistic', candidate: { stage: 'S0' }, baseline: { stage: 'S0', flags: { rawReadout: true } }, note: 'frozen LIF reservoir + online readout vs plain online logistic regression on raw features' },
  { name: 'S1 tags + monotonicity', candidate: { stage: 'S1' }, baseline: { stage: 'S0' }, note: 'per-contract tags + proper-scoring readout + strike monotonicity vs decaying trace' },
  { name: 'S2 Poirazi dendrites', candidate: { stage: 'S2' }, baseline: { stage: 'S1' }, note: 'dendritic L1 vs point-LIF L1 with the same synapses (equal parameter count)' },
  { name: 'S3 synapse classes + ALIF', candidate: { stage: 'S3' }, baseline: { stage: 'S2' }, note: 'AMPA/NMDA/GABA classes + adaptation vs single tau' },
  { name: 'S4 predictive coding', candidate: { stage: 'S4' }, baseline: { stage: 'S3' }, note: 'PC + surprise-to-c; must also beat realized-vol-to-c' },
  { name: 'S5 lateral inhibition', candidate: { stage: 'S5' }, baseline: { stage: 'S4' }, note: 'salience ranking (shadow) vs ranking by readout edge' },
  { name: 'S6 online plasticity', candidate: { stage: 'S6' }, baseline: { stage: 'S5' }, note: 'triplet/BCM x NMDA gate x governor vs frozen weights' },
  { name: 'Wilson-Cowan regime', candidate: { stage: 'S5', flags: { wilsonCowan: true } }, baseline: { stage: 'S5', flags: { proxies: true } }, note: 'vs EWMA realized-vol regime proxy' },
  { name: 'gap junctions', candidate: { stage: 'S5', flags: { gapJunctions: true } }, baseline: { stage: 'S5', flags: { proxies: true } }, note: 'vs BTC-ETH correlation feature' },
  { name: 'Izhikevich CH', candidate: { stage: 'S5', flags: { izhikevichCH: true } }, baseline: { stage: 'S5', flags: { proxies: true } }, note: 'vs delta-spike burst counter' },
  { name: 'dCaAP units', candidate: { stage: 'S5', flags: { dcaap: true } }, baseline: { stage: 'S5' }, note: 'vs 2-branch Poirazi XOR' },
  { name: 'anchor band 40-60c', candidate: { stage: 'S5', params: { anchorMid: true, anchorBand: 0.1 } }, baseline: { stage: 'S5', params: { anchorMid: true } }, note: 'the anchored price departs from the mid only at 40-60c (picked on Oct 22-30; judge on later days only)' },
  { name: 'mid-anchored readout', candidate: { stage: 'S5', params: { anchorMid: true } }, baseline: { stage: 'S5' }, note: 'logit p = logit(mid) + w . phi, weights from zero, vs the readout that prices from scratch (SNN plan phase 1)' },
];

export const MAX_GRID = 20;

export interface RunSummary { config: string; overrides: Partial<SnnParams>; rows: number; events: number; brier: number; brierModel: number; calSlope: number; corrModel: number; p99Ms: number; frozenFrac: number; nanRestores: number }

export interface Verdict {
  mechanism: string; note: string; candidate: RunSummary; baseline: RunSummary; configsTried: RunSummary[];
  delta: { mean: number; lo: number; hi: number; events: number; days: number };
  blend: { alpha: number; mean: number; lo: number; hi: number };
  pnl: { blend: number; model: number; diff: number };
  /** Brier of the SNN alone minus the market's (the contract's mid, clipped like the anchor), per settlement window:
   *  below zero with its CI = the SNN beats the market. The SNN plan's phase 1 go/no-go reads the candidate's row. */
  vsMarket: { candidate: { mean: number; lo: number; hi: number; events: number; days: number }; baseline: { mean: number; lo: number; hi: number; events: number; days: number } };
  extra?: Record<string, unknown>;
  criteria: { a: boolean; b: boolean; c: boolean; d: boolean; e: boolean; f: boolean };
  accepted: boolean;
}

const key = (r: SnnRow) => `${r.ticker}@${r.ts}`;

/** Per-event paired difference f(candidate) - f(baseline) over rows present in both runs. */
export function pairedEvent(cand: SnnRow[], base: SnnRow[], f: (r: SnnRow) => number, iters = 2000) {
  const b = new Map(base.map((r) => [key(r), r]));
  const ev = new Map<string, { s: number; n: number; day: string }>();
  for (const r of cand) {
    const o = b.get(key(r));
    if (!o) continue;
    const e = ev.get(r.eventKey) ?? { s: 0, n: 0, day: r.day };
    e.s += f(r) - f(o); e.n++;
    ev.set(r.eventKey, e);
  }
  return dayBlockBootstrap([...ev.values()].map((e) => ({ day: e.day, x: e.s / e.n })), iters);
}

const clipMid = (m: number) => Math.min(0.98, Math.max(0.02, m));
/** The SNN alone against the market on the same rows: per-event mean of brier(p_snn) - brier(mid), day-block CI. */
export function vsMarket(rows: SnnRow[], iters = 2000) {
  return eventCi(rows, (r) => brier(r.pSnn, r.y) - brier(clipMid(r.mid), r.y), iters);
}

/** The audit of the SNN's correction to the market within a slice: its mean size (cents); its edge, the mean of
 *  sign(p_snn - mid) * (y - mid) in cents, which is what one contract bought at the mid in the direction of the
 *  correction would earn before fees (a share "pointing the right way" says little on a 0/1 outcome, since even the
 *  true probability points the right way about half the time); and its calibration slope, the least-squares b in
 *  (y - mid) = b (p_snn - mid): b near 1 = the right size, 0 < b < 1 = it overcorrects (shrinking it by b would
 *  help), b > 1 = it is too timid, b <= 0 = it points the wrong way. */
export function correctionStats(rows: SnnRow[]) {
  let sxy = 0, sxx = 0, size = 0, edge = 0, n = 0, moved = 0;
  for (const r of rows) {
    const m = Math.min(0.98, Math.max(0.02, r.mid)), x = r.pSnn - m, e = r.y - m;
    sxy += x * e; sxx += x * x; size += Math.abs(x); n++;
    if (x !== 0) { edge += Math.sign(x) * e; moved++; }
  }
  return { sizeCents: n ? (100 * size) / n : 0, edgeCents: moved ? (100 * edge) / moved : 0, slope: sxx > 0 ? sxy / sxx : NaN };
}

/** Where the SNN differs from the market: vsMarket within slices of the rows (column = asset x horizon, the mid's
 *  distance from 50 cents, the UTC hour block, the contract kind, the volatility regime). A slice with its CI below zero
 *  is a place the SNN beats the market; a slice too small for a CI says so. */
export function vsMarketBreakdown(rows: SnnRow[], iters = 1000, minEvents = 150) {
  const slicers: Record<string, (r: SnnRow) => string> = {
    column: (r) => r.column,
    mid: (r) => { const d = Math.abs(r.mid - 0.5); return d < 0.1 ? 'mid 40-60c' : d < 0.25 ? 'mid 25-40/60-75c' : d < 0.4 ? 'mid 10-25/75-90c' : 'mid <10/>90c'; },
    hourUtc: (r) => { const h = new Date(r.ts).getUTCHours(); const b = Math.floor(h / 4) * 4; return `${String(b).padStart(2, '0')}-${String(b + 4).padStart(2, '0')} UTC`; },
    kind: (r) => r.kind,
    vol: (r) => (r.volRatio < 0.8 ? 'vol low' : r.volRatio < 1.25 ? 'vol normal' : 'vol high'),
  };
  const out: { by: string; slice: string; events: number; mean: number; lo: number; hi: number; verdict: string; corr: ReturnType<typeof correctionStats> }[] = [];
  for (const [by, f] of Object.entries(slicers)) {
    const groups = new Map<string, SnnRow[]>();
    for (const r of rows) { const k = f(r); const g = groups.get(k); if (g) g.push(r); else groups.set(k, [r]); }
    for (const [slice, g] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      const events = new Set(g.map((r) => r.eventKey)).size;
      if (events < minEvents) { out.push({ by, slice, events, mean: NaN, lo: NaN, hi: NaN, verdict: 'too few', corr: correctionStats(g) }); continue; }
      const c = vsMarket(g, iters);
      out.push({ by, slice, events, mean: c.mean, lo: c.lo, hi: c.hi, verdict: c.hi < 0 ? 'BEATS the market' : c.lo > 0 ? 'worse' : 'undecided', corr: correctionStats(g) });
    }
  }
  return out;
}

/** Per-event mean of a per-row quantity, clustered and day-block bootstrapped. */
export function eventCi(rows: SnnRow[], f: (r: SnnRow) => number, iters = 2000) {
  const ev = new Map<string, { s: number; n: number; day: string }>();
  for (const r of rows) { const e = ev.get(r.eventKey) ?? { s: 0, n: 0, day: r.day }; e.s += f(r); e.n++; ev.set(r.eventKey, e); }
  return dayBlockBootstrap([...ev.values()].map((e) => ({ day: e.day, x: e.s / e.n })), iters);
}

const conf = (r: SnnRow, useSurprise: boolean) => (useSurprise ? surpriseConfidence(1, r.surprise0, r.surprise) : 1) * (1 - DEFAULT_SNN.govDeltaP * r.G);
const confVol = (r: SnnRow) => Math.min(1, 1 / Math.max(1e-9, r.volRatio)) * (1 - DEFAULT_SNN.govDeltaP * r.G);

/** Best alpha in [0, 0.25] for the blend, and its event-clustered paired CI vs p_model. */
export function blendGain(rows: SnnRow[], c: (r: SnnRow) => number) {
  let best = 0, bestB = Infinity;
  for (let k = 0; k <= 10; k++) {
    const a = k * 0.025;
    const b = rows.reduce((s, r) => s + brier(blend(r.pModel, r.pSnn, a, c(r)), r.y), 0);
    if (b < bestB - 1e-12) { bestB = b; best = a; }
  }
  const ci = eventCi(rows, (r) => brier(blend(r.pModel, r.pSnn, best, c(r)), r.y) - brier(r.pModel, r.y));
  return { alpha: best, mean: ci.mean, lo: ci.lo, hi: ci.hi };
}

/** Fee-aware paper P&L per contract: take the side whose edge beats the taker fee + half spread. */
export function paperPnl(rows: SnnRow[], p: (r: SnnRow) => number, halfSpread = 0.01): number {
  let pnl = 0;
  for (const r of rows) {
    const ask = Math.min(0.99, r.mid + halfSpread), bid = Math.max(0.01, r.mid - halfSpread);
    const q = p(r);
    if (q > ask + 0.07 * ask * (1 - ask)) pnl += r.y - ask - 0.07 * ask * (1 - ask);
    else if (q < bid - 0.07 * bid * (1 - bid)) pnl += bid - r.y - 0.07 * bid * (1 - bid);
  }
  return pnl;
}

export function summarize(config: string, overrides: Partial<SnnParams>, r: SnnReplayResult): RunSummary {
  const rows = r.rows;
  const s = [...r.stepMs].sort((a, b) => a - b);
  return {
    config, overrides, rows: rows.length, events: new Set(rows.map((x) => x.eventKey)).size,
    brier: rows.reduce((a, x) => a + brier(x.pSnn, x.y), 0) / Math.max(1, rows.length),
    brierModel: rows.reduce((a, x) => a + brier(x.pModel, x.y), 0) / Math.max(1, rows.length),
    calSlope: calibrationSlope(rows.map((x) => x.pSnn), rows.map((x) => x.y)),
    corrModel: correlation(rows.map((x) => x.pSnn), rows.map((x) => x.pModel)),
    p99Ms: s.length ? s[Math.min(s.length - 1, Math.floor(0.99 * s.length))] : 0,
    frozenFrac: r.steps ? r.frozenSteps / r.steps : 0,
    nanRestores: r.net.nanRestores,
  };
}

export function judge(m: Mechanism, cand: SnnReplayResult, base: SnnReplayResult, candSum: RunSummary, baseSum: RunSummary, tried: RunSummary[]): Verdict {
  const delta = pairedEvent(cand.rows, base.rows, (r) => brier(r.pSnn, r.y));
  const useS = Boolean(stageFlags(m.candidate.stage).surpriseToC);
  const bl = blendGain(cand.rows, (r) => conf(r, useS));
  const alpha = bl.alpha;
  const pnlBlend = paperPnl(cand.rows, (r) => blend(r.pModel, r.pSnn, alpha, conf(r, useS)));
  const pnlModel = paperPnl(cand.rows, (r) => r.pModel);
  const extra: Record<string, unknown> = {};
  if (m.candidate.stage === 'S4' && !m.candidate.flags) {
    // Surprise must beat realized volatility as the confidence signal.
    const sur = blendGain(cand.rows, (r) => conf(r, true)), vol = blendGain(cand.rows, confVol);
    const d = eventCi(cand.rows, (r) => brier(blend(r.pModel, r.pSnn, sur.alpha, conf(r, true)), r.y) - brier(blend(r.pModel, r.pSnn, vol.alpha, confVol(r)), r.y));
    extra.surpriseVsVol = { surprise: sur, realizedVol: vol, delta: d, beatsVol: d.hi < 0 };
  }
  if (m.candidate.stage === 'S5' && !m.candidate.flags) {
    const d = dayBlockBootstrap(cand.ranking.map((x) => ({ day: new Date(x.ts).toISOString().slice(0, 10), x: x.bySalience - x.byEdge })));
    extra.salienceVsEdgeRanking = { samples: cand.ranking.length, ...d, note: 'captured mispricing per pick; shadow only, the SNN never adds assets' };
  }
  const criteria = {
    a: delta.hi < 0,
    b: candSum.calSlope >= 0.9 && candSum.calSlope <= 1.1,
    c: candSum.corrModel < 0.7,
    d: bl.hi < 0,
    e: candSum.p99Ms < 150 && candSum.frozenFrac < 0.05 && candSum.nanRestores === 0,
    f: pnlBlend >= pnlModel,
  };
  if (extra.surpriseVsVol && !(extra.surpriseVsVol as { beatsVol: boolean }).beatsVol) criteria.a = false;
  return {
    mechanism: m.name, note: m.note, candidate: candSum, baseline: baseSum, configsTried: tried,
    delta, blend: bl, pnl: { blend: pnlBlend, model: pnlModel, diff: pnlBlend - pnlModel },
    vsMarket: { candidate: vsMarket(cand.rows), baseline: vsMarket(base.rows) }, extra,
    criteria, accepted: Object.values(criteria).every(Boolean),
  };
}

export async function snnAblationMain(argOf: (k: string, d: string) => string = cliArg, annotate: boolean = process.argv.includes('--annotate')) {
  const dir = argOf('recordings', 'data/recordings');
  const from = argOf('from', '') ? Date.parse(argOf('from', '')) : undefined, to = argOf('to', '') ? Date.parse(argOf('to', '')) : undefined;
  const modelPath = argOf('model', '');
  const model = modelPath && fs.existsSync(modelPath) ? MetaModel.load(modelPath) : undefined;
  const grid: Record<string, Partial<SnnParams>[]> = argOf('grid', '') ? JSON.parse(fs.readFileSync(argOf('grid', ''), 'utf8')) : {};
  const only = argOf('only', '');
  // --domain perps grades the perps network on its direction calls (perps never settle).
  const domain = argOf('domain', 'crypto') as 'crypto' | 'perps';
  const calendar = loadCalendar(path.resolve('params/calendar.json'));
  const cache = new Map<string, { res: SnnReplayResult; sum: RunSummary }>();
  const run = async (name: string, stage: Stage, flags: Partial<SnnFlags> | undefined, overrides: Partial<SnnParams>) => {
    const params: SnnParams = domainParams(domain, { ...DEFAULT_SNN, ...overrides, flags: { ...stageFlags(stage), ...(flags ?? {}) } });
    const k = JSON.stringify(params);
    if (!cache.has(k)) {
      process.stderr.write(`replaying ${name} ${JSON.stringify(overrides)}...\n`);
      const res = await replaySnn(dir, { params, model, from, to, calendar, domain });
      cache.set(k, { res, sum: summarize(name, overrides, res) });
    }
    return cache.get(k)!;
  };
  const verdicts: Verdict[] = [];
  const out = argOf('out', 'research/out/snn_ablation.json');
  // Split mode, for runs too long for one job: --side baseline|candidate replays one side of the first mechanism
  // matching --only and saves it (--save); --judge base.json,cand.json judges two saved sides. Same verdict.
  const side = argOf('side', ''), judgeFiles = argOf('judge', '');
  if (side || judgeFiles) {
    const m = MECHANISMS.find((x) => !only || x.name.startsWith(only));
    if (!m) throw new Error(`no mechanism starts with "${only}"`);
    if (side) {
      if (side !== 'baseline' && side !== 'candidate') throw new Error('--side is baseline or candidate');
      const spec = side === 'baseline' ? m.baseline : m.candidate;
      const r = await run(side === 'baseline' ? `${m.name} [baseline]` : m.name, spec.stage, spec.flags, { ...(spec.params ?? {}) });
      const save = argOf('save', `research/out/snn_ablation_${side}.json`);
      fs.mkdirSync(path.dirname(save), { recursive: true });
      fs.writeFileSync(save, JSON.stringify(savedSide(m.name, side, r.res, r.sum)));
      console.log(`saved ${side} of ${m.name}: ${r.sum.events} windows, ${r.sum.rows} rows -> ${save}`);
      return [];
    }
    const [bf, cf] = judgeFiles.split(',');
    const b = loadSide(bf, m.name, 'baseline'), c = loadSide(cf, m.name, 'candidate');
    const v = judge(m, c.res, b.res, c.sum, b.sum, [c.sum]);
    printVerdict(v);
    // --breakdown: where the candidate differs from the market (no new replay; seconds).
    if (argOf('breakdown', '') === 'true') {
      const bd = vsMarketBreakdown(c.res.rows);
      console.log('        where the candidate stands against the market (Brier SNN - mid per window, day-block 95% CI):');
      console.log('          (correction: mean size in cents, edge in cents per contract traded at the mid in its direction before fees, calibration slope b; b<1 overcorrects, b<=0 wrong way)');
      for (const x of bd) console.log(`          ${x.by.padEnd(8)} ${x.slice.padEnd(20)} ${String(x.events).padStart(5)} windows  ${Number.isFinite(x.mean) ? `${x.mean.toFixed(5)} [${x.lo.toFixed(5)}, ${x.hi.toFixed(5)}]` : ''.padEnd(29)}  ${x.verdict.padEnd(16)}  size ${x.corr.sizeCents.toFixed(2)}c  edge ${x.corr.edgeCents.toFixed(2)}c  b ${x.corr.slope.toFixed(2)}`);
      v.extra = { ...(v.extra ?? {}), vsMarketBreakdown: bd };
    }
    // --gain: the candidate priced through the learned correction gain (bot/snn/correctionGain.ts), replayed causally
    // over the saved rows. The gain does not feed back into the SNN's learning, so this is exactly what it would price.
    if (argOf('gain', '') === 'true') {
      // A small pre-registered grid (prior strength in windows x forgetting per window), all printed: picking the best
      // here is fitting to these days, so the pick is only confirmed on days recorded after them.
      const f5 = (x: { mean: number; lo: number; hi: number }) => `${x.mean.toFixed(5)} [${x.lo.toFixed(5)}, ${x.hi.toFixed(5)}]`;
      for (const prior of [30, 100, 300]) for (const forget of [0.998, 0.999, 0.9997]) {
        const vg = vsMarket(replayGain(c.res.rows, { prior, forget }));
        console.log(`        correction gain grid: prior ${String(prior).padStart(3)} windows, forget ${forget}: vs market ${f5(vg)}`);
      }
      for (const prior of [100, 400]) for (const forget of [0.9995, 0.9999]) {
        const vg = vsMarket(replayGain(c.res.rows, { prior, forget, perRow: true }));
        console.log(`        correction gain grid, per row: prior ${String(prior).padStart(3)}, forget ${forget}: vs market ${f5(vg)}`);
      }
      for (const k of [0.5, 1, 2]) {
        const vg = vsMarket(c.res.rows.map((r) => ({ ...r, pSnn: volScaled(r.mid, r.pSnn, r.volRatio, k) })));
        console.log(`        fixed vol sizing (correction / volRatio^${k} above normal vol): vs market ${f5(vg)}`);
      }
      const o: GainOpts = { prior: Number(argOf('gainPrior', '100')), forget: Number(argOf('gainForget', '0.999')), perRow: argOf('gainPerRow', '') === 'true' };
      const gained = replayGain(c.res.rows, o), raw = vsMarket(c.res.rows), vm = vsMarket(gained);
      const f = (x: { mean: number; lo: number; hi: number }) => `${x.mean.toFixed(5)} [${x.lo.toFixed(5)}, ${x.hi.toFixed(5)}]`;
      console.log(`        correction gain (prior ${o.prior} windows, forget ${o.forget}): vs market ${f(vm)} (SNN as is ${f(raw)}); ${vm.hi < 0 ? 'BEATS the market' : vm.lo > 0 ? 'worse' : 'undecided'}`);
      const before = new Map(vsMarketBreakdown(c.res.rows).map((x) => [`${x.by}|${x.slice}`, x]));
      for (const x of vsMarketBreakdown(gained)) {
        const b0 = before.get(`${x.by}|${x.slice}`);
        console.log(`          ${x.by.padEnd(8)} ${x.slice.padEnd(20)} ${String(x.events).padStart(5)} windows  ${Number.isFinite(x.mean) ? `${x.mean.toFixed(5)} [${x.lo.toFixed(5)}, ${x.hi.toFixed(5)}]` : ''.padEnd(29)}  ${x.verdict.padEnd(16)}  was ${b0 && Number.isFinite(b0.mean) ? b0.mean.toFixed(5) : '-'}  size ${x.corr.sizeCents.toFixed(2)}c  edge ${x.corr.edgeCents.toFixed(2)}c  b ${x.corr.slope.toFixed(2)}`);
      }
      v.extra = { ...(v.extra ?? {}), correctionGain: { opts: o, vsMarket: vm, raw } };
    }
    writeVerdicts(out, { domain, recordings: dir, from: from ?? null, to: to ?? null }, [v]);
    return [v];
  }
  for (const m of MECHANISMS) {
    if (only && !m.name.startsWith(only)) continue;
    const configs = grid[m.name] ?? [{}];
    if (configs.length > MAX_GRID) throw new Error(`${m.name}: ${configs.length} configs exceed the pre-registered cap of ${MAX_GRID}`);
    const base = await run(`${m.name} [baseline]`, m.baseline.stage, m.baseline.flags, { ...(m.baseline.params ?? {}) });
    const tried: { res: SnnReplayResult; sum: RunSummary }[] = [];
    for (const ov of configs) tried.push(await run(m.name, m.candidate.stage, m.candidate.flags, { ...(m.candidate.params ?? {}), ...ov }));
    const best = tried.sort((a, b) => a.sum.brier - b.sum.brier)[0];
    const v = judge(m, best.res, base.res, best.sum, base.sum, tried.map((t) => t.sum));
    verdicts.push(v);
    printVerdict(v);
  }
  writeVerdicts(out, { domain, recordings: dir, from: from ?? null, to: to ?? null }, verdicts);
  console.log(`wrote ${out} (${verdicts.filter((v) => v.accepted).length}/${verdicts.length} accepted; expect most to fail - that is the system working)`);
  return verdicts;
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) void snnAblationMain();

function printVerdict(v: Verdict) {
  console.log(`${v.accepted ? 'ACCEPT' : 'reject'}  ${v.mechanism}: dBrier ${v.delta.mean.toFixed(5)} [${v.delta.lo.toFixed(5)}, ${v.delta.hi.toFixed(5)}] over ${v.delta.events} events / ${v.delta.days} days; slope ${v.candidate.calSlope.toFixed(2)}; corr ${v.candidate.corrModel.toFixed(2)}; blend a=${v.blend.alpha} [${v.blend.lo.toFixed(5)}, ${v.blend.hi.toFixed(5)}]; p99 ${v.candidate.p99Ms.toFixed(1)} ms; ${JSON.stringify(v.criteria)}`);
  const vm = (x: Verdict['vsMarket']['candidate']) => `${x.mean.toFixed(5)} [${x.lo.toFixed(5)}, ${x.hi.toFixed(5)}]${x.hi < 0 ? ' BEATS the market' : x.lo > 0 ? ' worse than the market' : ' undecided'}`;
  console.log(`        vs market (Brier SNN - mid, per window): candidate ${vm(v.vsMarket.candidate)}; baseline ${vm(v.vsMarket.baseline)}`);
  // Criterion e's parts, so a failure names its cause in the log (the verdict file is not readable everywhere).
  const st = (x: RunSummary) => `Brier ${x.brier.toFixed(5)} (meta-model ${x.brierModel.toFixed(5)}), ${x.events} windows, learning frozen ${(100 * x.frozenFrac).toFixed(1)}%, NaN restores ${x.nanRestores}, p99 ${x.p99Ms.toFixed(1)} ms`;
  console.log(`        candidate: ${st(v.candidate)}`);
  console.log(`        baseline:  ${st(v.baseline)}`);
}

function writeVerdicts(out: string, meta: Record<string, unknown>, verdicts: Verdict[]) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), ...meta, verdicts }, null, 1));
}

/** One replayed side as the judge needs it: its rows, the S5 column rankings and its summary. */
export function savedSide(mechanism: string, side: string, res: SnnReplayResult, sum: RunSummary) {
  return { mechanism, side, sum, rows: res.rows, ranking: res.ranking };
}

export function loadSide(file: string, mechanism: string, side: string): { res: SnnReplayResult; sum: RunSummary } {
  const j = JSON.parse(fs.readFileSync(file, 'utf8')) as ReturnType<typeof savedSide>;
  if (j.mechanism !== mechanism || j.side !== side) throw new Error(`${file} holds the ${j.side} of "${j.mechanism}", not the ${side} of "${mechanism}"`);
  return { res: { rows: j.rows, ranking: j.ranking } as unknown as SnnReplayResult, sum: j.sum };
}

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }
