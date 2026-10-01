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

export interface Mechanism { name: string; candidate: { stage: Stage; flags?: Partial<SnnFlags> }; baseline: { stage: Stage; flags?: Partial<SnnFlags> }; note: string }

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
];

export const MAX_GRID = 20;

export interface RunSummary { config: string; overrides: Partial<SnnParams>; rows: number; events: number; brier: number; brierModel: number; calSlope: number; corrModel: number; p99Ms: number; frozenFrac: number; nanRestores: number }

export interface Verdict {
  mechanism: string; note: string; candidate: RunSummary; baseline: RunSummary; configsTried: RunSummary[];
  delta: { mean: number; lo: number; hi: number; events: number; days: number };
  blend: { alpha: number; mean: number; lo: number; hi: number };
  pnl: { blend: number; model: number; diff: number };
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
    delta, blend: bl, pnl: { blend: pnlBlend, model: pnlModel, diff: pnlBlend - pnlModel }, extra,
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
  for (const m of MECHANISMS) {
    if (only && !m.name.startsWith(only)) continue;
    const configs = grid[m.name] ?? [{}];
    if (configs.length > MAX_GRID) throw new Error(`${m.name}: ${configs.length} configs exceed the pre-registered cap of ${MAX_GRID}`);
    const base = await run(`${m.name} [baseline]`, m.baseline.stage, m.baseline.flags, {});
    const tried: { res: SnnReplayResult; sum: RunSummary }[] = [];
    for (const ov of configs) tried.push(await run(m.name, m.candidate.stage, m.candidate.flags, ov));
    const best = tried.sort((a, b) => a.sum.brier - b.sum.brier)[0];
    const v = judge(m, best.res, base.res, best.sum, base.sum, tried.map((t) => t.sum));
    verdicts.push(v);
    console.log(`${v.accepted ? 'ACCEPT' : 'reject'}  ${m.name}: dBrier ${v.delta.mean.toFixed(5)} [${v.delta.lo.toFixed(5)}, ${v.delta.hi.toFixed(5)}] over ${v.delta.events} events / ${v.delta.days} days; slope ${v.candidate.calSlope.toFixed(2)}; corr ${v.candidate.corrModel.toFixed(2)}; blend a=${v.blend.alpha} [${v.blend.lo.toFixed(5)}, ${v.blend.hi.toFixed(5)}]; p99 ${v.candidate.p99Ms.toFixed(1)} ms; ${JSON.stringify(v.criteria)}`);
  }
  const out = argOf('out', 'research/out/snn_ablation.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), domain, recordings: dir, from: from ?? null, to: to ?? null, verdicts }, null, 1));
  console.log(`wrote ${out} (${verdicts.filter((v) => v.accepted).length}/${verdicts.length} accepted; expect most to fail - that is the system working)`);
  return verdicts;
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) void snnAblationMain();

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }
