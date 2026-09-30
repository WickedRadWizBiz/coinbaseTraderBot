// Train and validate the meta-model OFFLINE with purged walk-forward CV.
//   npm run research:train -- --data research/out/dataset.jsonl --out params/model.candidate.json
//        [--sets base,base+geometry+vol+kalshi,...,all] [--families mlp,gbdt] [--hidden 0,8] [--depths 2,3]
//        [--ensemble 5] [--epochs 400] [--cpcv 10]   (0 disables the CPCV report)
//
// Protocol (institutional blueprint 5-7, relaxed-cadence spec "Labels"):
//  - Rows are (contract, decision time) snapshots labelled with the settlement
//    outcome. Row weight = 1 / snapshots of that contract, and for hourly
//    events also / strikes sampled in the event (they share one outcome).
//  - Split chronologically by settlement WINDOW. The final 20% of windows is
//    an untouched holdout used once for the report.
//  - On the first 80%, expanding-window folds with a 1-hour embargo before
//    each validation fold choose the FEATURE SET, the MODEL FAMILY (residual
//    MLP or residual gradient-boosted trees, both with the fair-value log-odds
//    as init score, so they learn only where the market/pricer is wrong) and
//    its capacity. Selection uses the one-standard-error rule on per-window
//    out-of-fold log loss: the simplest configuration within 1 SE of the best
//    wins, so a feature group must earn its place (the ablation ledger).
//  - The pricer's Student-t degrees of freedom are chosen first on the dev
//    windows (Gaussian unless a fat-tailed nu is better by more than 1 SE),
//    and every row is re-priced with it so training inputs match live.
//  - The market's own favourite-longshot bias is estimated by beta calibration
//    of the mid on dev rows (p_mkt_cal): the benchmark the model must beat.
//  - The output layer is calibrated (Platt or beta) on pooled out-of-fold
//    predictions only, when there are >= 200 OOF windows and it helps.
//  - A deep ensemble (window-bootstrap members) supplies the uncertainty used
//    to veto trades and shrink size.
//  - Every variant tried is counted for the Deflated Sharpe.
//  - Holdout predictions go through the production MetaModel class itself, so
//    train/serve parity is by construction.
//  - The candidate file is written for review; promoting it to
//    params/model.json is a reviewed commit, never an automatic step.

import fs from 'fs';
import path from 'path';
import {
  applyBeta, brier, calibrationSlices, fitBeta, fitPlatt, maxCalibrationErrorPp, maxExcessCalibrationPp, reliability, weightedLogLoss, type BetaCal,
} from '../bot/model/calibration';
import { FeatureGroup, featuresInGroups, FEATURES, vectorFor, type FeatureTier } from '../bot/model/featureEngine';
import { priceContract } from '../bot/model/fairValue';
import { GO_LIVE_GATES, MetaModel, type EnsembleMember, type MetaModelParams } from '../bot/model/metaModel';
import { clamp, logit, sigmoid } from '../bot/util/num';
import type { DatasetRow } from './buildDataset';
import { eventOf } from './buildDataset';
import { predictGbdtLogits, trainGbdt } from './gbdt';
import { predictLogits, train } from './mlp';
import { dieboldMariano, rng } from './stats';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

export const MIN_DAYS_FOR_TIME = 14;
/** Embargo before each validation fold (relaxed spec: 1 hour). */
export const EMBARGO_MS = 3_600_000;
export const NU_CANDIDATES: Array<number | undefined> = [undefined, 10, 6, 4, 3];

const RELAXED = 'base+geometry+vol+kalshi';
export const DEFAULT_SETS = [
  'base', 'base+micro', 'base+momentum', 'base+spot', 'base+macro', 'base+macro+confluence', 'base+momentum+macro+confluence',
  'base+session', 'base+session+macro+confluence', 'base+time',
  // Relaxed-cadence catalog: T1 groups first, then the rest one at a time.
  RELAXED, `${RELAXED}+returns`, `${RELAXED}+returns+clock+calendar`, `${RELAXED}+returns+interaction`, `${RELAXED}+returns+ladder`, `${RELAXED}+returns+macro+confluence`,
  'all',
];

const ALL_GROUPS: FeatureGroup[] = ['base', 'micro', 'momentum', 'spot', 'macro', 'confluence', 'session', 'time', 'geometry', 'vol', 'kalshi', 'returns', 'clock', 'calendar', 'interaction', 'ladder'];

export function resolveSet(spec: string, tiers: FeatureTier[] = ['T1', 'T2']): string[] {
  const groups: FeatureGroup[] = spec === 'all' ? ALL_GROUPS : (spec.split('+') as FeatureGroup[]);
  return featuresInGroups(groups).filter((n) => tiers.includes(FEATURES[n].tier ?? 'T1'));
}

export type ModelSpec = { family: 'mlp'; hidden: number; l2: number } | { family: 'gbdt'; depth: number; learningRate: number };

const specName = (m: ModelSpec) => (m.family === 'mlp' ? `mlp-h${m.hidden}-l2${m.l2}` : `gbdt-d${m.depth}`);
/** Capacity rank for the 1-SE rule (lower = simpler). */
const specRank = (m: ModelSpec) => (m.family === 'mlp' ? (m.hidden === 0 ? 0 : m.hidden / 4) : 2 * m.depth - 3);

export interface CvRow { set: string; model: string; features: number; oosLogLoss: number; se: number; windows: number }

export interface TrainReport {
  params: MetaModelParams;
  holdout: {
    nWindows: number; nRows: number; brierModel: number; brierMarket: number; brierFairValue: number;
    logLossModel: number; logLossMarket: number; logLossMarketCal: number; dm: ReturnType<typeof dieboldMariano>;
    maxCalErrPp: number; maxExcessCalPp: number;
  };
  cv: CvRow[];
  selected: { set: string; model: string; bestSet: string; bestModel: string; rule: string };
  nu: { chosen: number | null; table: Array<{ nu: number | null; logLoss: number }> };
  dropped: Record<string, string[]>;
  importance: Array<{ feature: string; group: string; logLossIncrease: number }>;
}

export interface TrainOpts {
  folds?: number;
  seed?: number;
  maxEpochs?: number;
  sets?: string[];
  families?: Array<'mlp' | 'gbdt'>;
  hidden?: number[];
  l2?: number[];
  depths?: number[];
  ensemble?: number;
  tiers?: FeatureTier[];
  /** Skip the Student-t search (keeps the dataset's Gaussian pricing). */
  fixedNu?: number | null;
  /** Combinatorial purged CV of the selected configuration (N groups, k held out); 0 disables. */
  cpcvGroups?: number;
  cpcvK?: number;
}

/**
 * Combinatorial purged CV (Lopez de Prado): split the dev windows into N
 * contiguous groups; for every choice of k test groups, train on the rest
 * (purging an embargo around each test group) and score the test groups.
 * Returns the per-split log-loss advantage over the calibrated market
 * (positive = model better), a distribution rather than one number.
 */
export function cpcvSplits(windows: number[], N: number, k: number): Array<{ test: Set<number>; groups: number[] }> {
  const size = Math.floor(windows.length / N);
  const groupOf = (i: number) => Math.min(N - 1, Math.floor(i / size));
  const out: Array<{ test: Set<number>; groups: number[] }> = [];
  const rec = (start: number, acc: number[]) => {
    if (acc.length === k) { out.push({ groups: acc.slice(), test: new Set(windows.filter((_, i) => acc.includes(groupOf(i)))) }); return; }
    for (let g = start; g < N; g++) rec(g + 1, [...acc, g]);
  };
  rec(0, []);
  return out;
}

/** 1 / snapshots per contract, and / strikes per event for hourly events; normalized to mean 1. */
export function rowWeights(rows: DatasetRow[]): number[] {
  const snaps = new Map<string, number>();
  const strikes = new Map<string, Set<string>>();
  for (const r of rows) {
    snaps.set(r.ticker, (snaps.get(r.ticker) ?? 0) + 1);
    const ev = eventOf(r.ticker, r.event);
    if (!strikes.has(ev)) strikes.set(ev, new Set());
    strikes.get(ev)!.add(r.ticker);
  }
  const w = rows.map((r) => {
    const k = (r.kind ?? 'updown') === 'updown' ? 1 : strikes.get(eventOf(r.ticker, r.event))!.size;
    return 1 / (snaps.get(r.ticker)! * k);
  });
  const m = w.reduce((a, b) => a + b, 0) / Math.max(1, w.length);
  return w.map((x) => x / m);
}

/** Re-price a row with Student-t nu and refresh every feature derived from the fair value. */
export function repriceRow(r: DatasetRow, nu: number | undefined): void {
  const kind = r.kind ?? 'updown';
  const terms = kind === 'less' ? { kind, cap: r.cap ?? r.strike } : kind === 'between' ? { kind, strike: r.strike, cap: r.cap } : { kind, strike: r.strike };
  const fv = priceContract(terms, { spot: r.spot, sigmaPerSqrtSec: r.sigmaPricing ?? r.sigma, tauSec: r.tauSec, observedAvg: r.observedAvg, nu });
  if (!fv) return;
  r.fv = fv.pYes;
  if ('logit_fv' in r.fx) r.fx.logit_fv = logit(fv.pYes);
  if ('fv_minus_mid' in r.fx) r.fx.fv_minus_mid = fv.pYes - r.mid;
  if ('logit_gap' in r.fx && !Number.isFinite(r.fx.p_analytic_t)) {
    r.fx.logit_gap = clamp(logit(r.mid) - logit(fv.pYes), -10, 10);
    if ('gap_x_spread' in r.fx) r.fx.gap_x_spread = clamp(r.fx.logit_gap * (r.ask - r.bid) * 100, -50, 50);
  }
}

const rowLoss = (p: number, y: number) => { const q = Math.min(1 - 1e-9, Math.max(1e-9, p)); return y ? -Math.log(q) : -Math.log(1 - q); };

/** Weighted mean loss per window, windows in chronological order. */
function perWindow(rows: DatasetRow[], w: number[], losses: number[]): Map<number, number> {
  const acc = new Map<number, { s: number; w: number }>();
  rows.forEach((r, i) => { const a = acc.get(r.window) ?? { s: 0, w: 0 }; a.s += losses[i] * w[i]; a.w += w[i]; acc.set(r.window, a); });
  return new Map([...acc.entries()].sort((a, b) => a[0] - b[0]).map(([k, a]) => [k, a.s / a.w]));
}

function meanSe(xs: number[]): { mean: number; se: number } {
  const n = xs.length;
  if (!n) return { mean: Infinity, se: Infinity };
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const v = n > 1 ? xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1) : 0;
  return { mean: m, se: Math.sqrt(v / n) };
}

export function trainMetaModel(rowsIn: DatasetRow[], opts: TrainOpts = {}): TrainReport {
  const rows = rowsIn.map((r) => ({ ...r, fx: { ...r.fx } }));
  const folds = opts.folds ?? 5;
  const windows = [...new Set(rows.map((r) => r.window))].sort((a, b) => a - b);
  if (windows.length < folds + 3) throw new Error(`need at least ${folds + 3} windows, have ${windows.length}`);
  const cut = windows[Math.floor(windows.length * 0.8)];
  const isDev = (r: DatasetRow) => r.window < cut;

  // ---- Student-t nu for the pricer (dev windows only), then re-price every row. ----
  const devRows0 = rows.filter(isDev);
  const w0 = rowWeights(devRows0);
  const nuTable: Array<{ nu: number | null; logLoss: number; perWin: number[] }> = [];
  let chosenNu: number | undefined = opts.fixedNu ?? undefined;
  if (opts.fixedNu === undefined) {
    for (const nu of NU_CANDIDATES) {
      const probe = devRows0.map((r) => ({ ...r, fx: {} as Record<string, number> }));
      probe.forEach((r) => repriceRow(r, nu));
      const pw = [...perWindow(probe, w0, probe.map((r) => rowLoss(r.fv, r.label))).values()];
      nuTable.push({ nu: nu ?? null, logLoss: meanSe(pw).mean, perWin: pw });
    }
    const gauss = nuTable[0];
    let best = gauss;
    for (const c of nuTable.slice(1)) {
      const diff = meanSe(c.perWin.map((x, i) => x - gauss.perWin[i]));
      if (diff.mean + diff.se < 0 && c.logLoss < best.logLoss) best = c;
    }
    chosenNu = best.nu ?? undefined;
  }
  if (chosenNu !== undefined) rows.forEach((r) => repriceRow(r, chosenNu));

  const dev = rows.filter(isDev);
  const hold = rows.filter((r) => !isDev(r));
  const wDev = rowWeights(dev);
  const wHold = rowWeights(hold);
  const wOf = new Map<DatasetRow, number>();
  dev.forEach((r, i) => wOf.set(r, wDev[i]));
  hold.forEach((r, i) => wOf.set(r, wHold[i]));
  const W = (rs: DatasetRow[]) => rs.map((r) => wOf.get(r)!);
  const devWindows = windows.filter((w) => w < cut);
  const blockSize = Math.floor(devWindows.length / (folds + 1));

  // ---- Feature sets (drop mostly-missing candidates; time/session need 14+ days). ----
  const dropped: Record<string, string[]> = {};
  const devDays = new Set(dev.map((r) => new Date(r.window).toISOString().slice(0, 10))).size;
  const sets = (opts.sets ?? DEFAULT_SETS).map((spec) => {
    const names = resolveSet(spec, opts.tiers).filter((n) => {
      if (FEATURES[n].group === 'base') return true;
      const g = FEATURES[n].group;
      if ((g === 'time' || g === 'session' || g === 'clock' || g === 'calendar') && devDays < MIN_DAYS_FOR_TIME) {
        (dropped[spec] ??= []).push(`${n} (needs ${MIN_DAYS_FOR_TIME}+ days, have ${devDays})`);
        return false;
      }
      const avail = dev.filter((r) => Number.isFinite(r.fx[n] as number)).length / Math.max(1, dev.length);
      // GBDTs route missing values natively, so sparse-but-informative features (e.g. geometry, missing
      // inside the averaging window) are kept down to 30% availability.
      if (avail < 0.3) { (dropped[spec] ??= []).push(`${n} (available in ${(avail * 100).toFixed(0)}% of rows)`); return false; }
      return true;
    });
    return { spec, names };
  }).filter((set, i, all) => all.findIndex((o) => o.names.join() === set.names.join()) === i);

  const families = opts.families ?? ['mlp', 'gbdt'];
  const models: ModelSpec[] = [];
  if (families.includes('mlp')) for (const hidden of opts.hidden ?? [0, 8]) for (const l2 of opts.l2 ?? (hidden === 0 ? [1e-3] : [1e-2])) models.push({ family: 'mlp', hidden, l2 });
  if (families.includes('gbdt')) for (const depth of opts.depths ?? [2, 3]) models.push({ family: 'gbdt', depth, learningRate: 0.03 });
  const grid: Array<{ set: typeof sets[number]; model: ModelSpec }> = [];
  for (const set of sets) for (const model of models) grid.push({ set, model });
  const seed = opts.seed ?? 7;
  const mlpBase = { lr: 0.01, maxEpochs: opts.maxEpochs ?? 400, patience: 60, seed };

  const foldSplit = (k: number) => {
    const valStart = devWindows[(k + 1) * blockSize];
    const valEnd = devWindows[Math.min(devWindows.length - 1, (k + 2) * blockSize)] ?? Infinity;
    const tr = dev.filter((r) => r.window < valStart - EMBARGO_MS);
    const va = dev.filter((r) => r.window >= valStart && (k === folds - 1 ? true : r.window < valEnd));
    return { tr, va };
  };
  const X = (rs: DatasetRow[], names: string[]) => rs.map((r) => vectorFor(names, r.fx));
  const Y = (rs: DatasetRow[]) => rs.map((r) => r.label);

  /** Fit one member; returns a logit predictor and the serializable member. */
  const fit = (model: ModelSpec, names: string[], tr: DatasetRow[], va: DatasetRow[], wTr: number[], s: number) => {
    const residual = names.indexOf('logit_fv');
    const Xtr = X(tr, names), Xva = X(va, names);
    if (model.family === 'gbdt') {
      const init = (xs: number[][]) => xs.map((x) => (residual >= 0 && Number.isFinite(x[residual]) ? x[residual] : 0));
      const g = trainGbdt(Xtr, Y(tr), wTr, init(Xtr), Xva, Y(va), W(va), init(Xva), { maxDepth: model.depth, learningRate: model.learningRate, seed: s });
      return { member: { gbdt: g.model } as EnsembleMember, logits: (xs: number[][]) => predictGbdtLogits(g.model, xs, residual), residual, size: g.trees };
    }
    const m = train(Xtr, Y(tr), Xva, Y(va), { ...mlpBase, hidden: model.hidden, l2: model.l2, residual, seed: s }, wTr, W(va));
    return { member: { normalization: m.norm, layers: m.layers } as EnsembleMember, logits: (xs: number[][]) => predictLogits(m.layers, m.norm, xs, residual), residual, size: m.epochs };
  };

  // ---- Purged walk-forward CV over the grid. ----
  const cv: CvRow[] = [];
  const results = grid.map((g) => {
    const oofRows: DatasetRow[] = [];
    const oofZ: number[] = [];
    for (let k = 0; k < folds; k++) {
      const { tr, va } = foldSplit(k);
      if (tr.length < 50 || va.length < 10) continue;
      const f = fit(g.model, g.set.names, tr, va, W(tr), seed);
      oofZ.push(...f.logits(X(va, g.set.names)));
      oofRows.push(...va);
    }
    const pw = [...perWindow(oofRows, W(oofRows), oofRows.map((r, i) => rowLoss(sigmoid(oofZ[i]), r.label))).values()];
    const ms = meanSe(pw);
    cv.push({ set: g.set.spec, model: specName(g.model), features: g.set.names.length, oosLogLoss: ms.mean, se: ms.se, windows: pw.length });
    return { g, oofRows, oofZ, ...ms };
  });
  const best = results.reduce((a, b) => (b.mean < a.mean ? b : a));
  // One-standard-error rule: the simplest configuration within 1 SE of the best.
  const within = results.filter((r) => r.mean <= best.mean + best.se);
  const chosen = within.reduce((a, b) => {
    const ca = a.g.set.names.length * 10 + specRank(a.g.model), cb = b.g.set.names.length * 10 + specRank(b.g.model);
    return cb < ca || (cb === ca && b.mean < a.mean) ? b : a;
  });
  const names = chosen.g.set.names;
  const model = chosen.g.model;

  // ---- Final fit (+ ensemble of window-bootstrap members), early-stopped on the last fold. ----
  const { va: lastVa } = foldSplit(folds - 1);
  const finalTrain = dev.filter((r) => r.window < (lastVa[0]?.window ?? cut) - EMBARGO_MS);
  const primary = fit(model, names, finalTrain, lastVa, W(finalTrain), seed);
  const extra: EnsembleMember[] = [];
  const nMembers = Math.max(1, opts.ensemble ?? 5);
  const trWindows = [...new Set(finalTrain.map((r) => r.window))];
  for (let k = 1; k < nMembers; k++) {
    const r = rng(seed * 31 + k);
    const counts = new Map<number, number>();
    for (let i = 0; i < trWindows.length; i++) { const wdw = trWindows[Math.floor(r() * trWindows.length)]; counts.set(wdw, (counts.get(wdw) ?? 0) + 1); }
    const bs = finalTrain.filter((x) => counts.has(x.window));
    const wBs = bs.map((x) => wOf.get(x)! * counts.get(x.window)!);
    extra.push(fit(model, names, bs, lastVa, wBs, seed + k).member);
  }

  // ---- Market calibration (favourite-longshot bias of the mid), dev rows only. ----
  const marketCalibration: BetaCal = fitBeta(dev.map((r) => r.mid), Y(dev), wDev);

  // ---- Output calibration on pooled OOF predictions (Platt or beta), if it helps. ----
  const oofY = chosen.oofRows.map((r) => r.label);
  const oofW = W(chosen.oofRows);
  const oofWindows = new Set(chosen.oofRows.map((r) => r.window)).size;
  let calibration: { a: number; b: number } | undefined;
  let betaCalibration: BetaCal | undefined;
  if (oofWindows >= 200) {
    const raw = weightedLogLoss(chosen.oofZ.map(sigmoid), oofY, oofW);
    const platt = fitPlatt(chosen.oofZ, oofY);
    const lp = weightedLogLoss(chosen.oofZ.map((z) => sigmoid(platt.a * z + platt.b)), oofY, oofW);
    const beta = fitBeta(chosen.oofZ.map(sigmoid), oofY, oofW);
    const lb = weightedLogLoss(chosen.oofZ.map((z) => applyBeta(sigmoid(z), beta)), oofY, oofW);
    if (Math.min(lp, lb) < raw - 1e-4) { if (lb < lp) betaCalibration = beta; else calibration = platt; }
  }

  // ---- CPCV distribution for the selected configuration (informational). ----
  let cpcv: { splits: number; medianAdvantage: number; shareBeatingMarket: number } | undefined;
  const N = opts.cpcvGroups ?? 0;
  if (N >= 3 && devWindows.length >= N * 3) {
    const adv: number[] = [];
    for (const sp of cpcvSplits(devWindows, N, opts.cpcvK ?? 2)) {
      const testW = [...sp.test];
      const nearTest = (w: number) => testW.some((t) => Math.abs(t - w) < EMBARGO_MS);
      const te = dev.filter((r) => sp.test.has(r.window));
      const tr = dev.filter((r) => !sp.test.has(r.window) && !nearTest(r.window));
      if (tr.length < 50 || te.length < 10) continue;
      const f = fit(model, names, tr, te, W(tr), seed);
      const pz = f.logits(X(te, names)).map(sigmoid);
      const pm = te.map((r) => applyBeta(r.mid, marketCalibration));
      const d = [...perWindow(te, W(te), te.map((r, i) => rowLoss(pm[i], r.label) - rowLoss(pz[i], r.label))).values()];
      adv.push(d.reduce((a, b) => a + b, 0) / d.length);
    }
    if (adv.length) {
      const sorted = adv.slice().sort((a, b) => a - b);
      cpcv = { splits: adv.length, medianAdvantage: sorted[Math.floor(sorted.length / 2)], shareBeatingMarket: adv.filter((x) => x > 0).length / adv.length };
    }
  }

  const referenceSigma = rows.reduce((s, r) => s + r.sigma, 0) / rows.length;
  const variantsTried = grid.length + (opts.fixedNu === undefined ? NU_CANDIDATES.length : 0);
  const params: MetaModelParams = {
    version: `meta-${model.family}-${new Date().toISOString().slice(0, 10)}-${chosen.g.set.spec}-${specName(model)}`,
    kind: model.family,
    features: names,
    ...(model.family === 'mlp' ? { normalization: primary.member.normalization, layers: primary.member.layers } : { gbdt: primary.member.gbdt }),
    ...(extra.length ? { ensemble: extra } : {}),
    residualFeature: primary.residual >= 0 ? primary.residual : undefined,
    ...(calibration ? { calibration } : {}),
    ...(betaCalibration ? { betaCalibration } : {}),
    marketCalibration,
    ...(chosenNu !== undefined ? { tNu: chosenNu } : {}),
    referenceSigma,
  };

  // ---- Holdout, predicted by the production class (parity by construction). ----
  const live = MetaModel.fromJson(JSON.stringify(params));
  const y = Y(hold);
  const predictRows = (rs: DatasetRow[], fxOf: (r: DatasetRow, i: number) => Record<string, number>) => rs.map((r, i) => live.predict(fxOf(r, i), r.fv));
  const pHold = predictRows(hold, (r) => r.fx);
  const pMktCal = hold.map((r) => live.marketProbability(r.mid));
  const brierModel = brier(pHold, y);
  const brierMarket = brier(hold.map((r) => r.mid), y);
  const brierFairValue = brier(hold.map((r) => r.fv), y);
  const logLossModel = weightedLogLoss(pHold, y, wHold);
  const logLossMarketCal = weightedLogLoss(pMktCal, y, wHold);
  const dmWin = perWindow(hold, wHold, hold.map((r, i) => rowLoss(pHold[i], r.label) - rowLoss(pMktCal[i], r.label)));
  const dm = dieboldMariano([...dmWin.values()]);
  const maxCalErrPp = maxCalibrationErrorPp(reliability(pHold, y));
  const maxExcessCalPp = maxExcessCalibrationPp(calibrationSlices(pHold, y, hold.map((r) => r.tauSec), hold.map((r) => r.window)));
  const nWindows = new Set(hold.map((r) => r.window)).size;

  // Permutation importance on the holdout (weighted log-loss increase when a column is shuffled).
  const r = rng(99);
  const importance = names.map((f) => {
    const col = hold.map((x) => x.fx[f]);
    for (let i = col.length - 1; i > 0; i--) { const k = Math.floor(r() * (i + 1)); [col[i], col[k]] = [col[k], col[i]]; }
    const p = predictRows(hold, (row, i) => ({ ...row.fx, [f]: col[i] }));
    return { feature: f, group: FEATURES[f].group, logLossIncrease: weightedLogLoss(p, y, wHold) - logLossModel };
  }).sort((a, b) => b.logLossIncrease - a.logLossIncrease);

  params.training = {
    rows: rows.length, devRows: dev.length, holdoutRows: hold.length, windows: windows.length,
    firstWindow: new Date(windows[0]).toISOString(), holdoutStart: new Date(cut).toISOString(),
    selected: { set: chosen.g.set.spec, model: specName(model), rule: '1-SE', bestSet: best.g.set.spec, bestModel: specName(best.g.model) },
    size: primary.size, ensembleMembers: 1 + extra.length,
    outputCalibration: betaCalibration ? 'beta' : calibration ? 'platt' : 'none',
    tNu: chosenNu ?? null, nuSearch: nuTable.map(({ nu, logLoss }) => ({ nu, logLoss })),
    variantsTried, folds, embargoMs: EMBARGO_MS, cpcv: cpcv ?? null, droppedFeatures: dropped, rowWeights: '1/snapshots per contract (/ strikes per hourly event)',
    officialLabelShare: rows.filter((x) => x.labelSource === 'official').length / rows.length,
    holdoutImportance: importance.slice(0, 15),
  };
  params.validation = {
    passed: nWindows >= GO_LIVE_GATES.minWindows && brierModel < brierMarket && maxCalErrPp <= GO_LIVE_GATES.maxCalibrationErrorPp
      && logLossModel < logLossMarketCal && dm.pValue < GO_LIVE_GATES.maxDmPValue && maxExcessCalPp <= GO_LIVE_GATES.maxExcessCalibrationPp,
    nWindows,
    brierModel,
    brierMarket,
    brierFairValue,
    maxCalibrationErrorPp: Number.isFinite(maxCalErrPp) ? maxCalErrPp : 100,
    logLossModel,
    logLossMarketCal,
    dmPValue: Number.isFinite(dm.pValue) ? dm.pValue : 1,
    maxExcessCalibrationPp: Number.isFinite(maxExcessCalPp) ? maxExcessCalPp : 100,
    variantsTried,
    evaluatedAt: new Date().toISOString(),
    notes: 'netEdgeCiLow, deflatedSharpe, dsrProbability and pbo are added by research:backtest --annotate',
  };
  return {
    params,
    holdout: { nWindows, nRows: hold.length, brierModel, brierMarket, brierFairValue, logLossModel, logLossMarket: weightedLogLoss(hold.map((x) => x.mid), y, wHold), logLossMarketCal, dm, maxCalErrPp, maxExcessCalPp },
    cv,
    selected: { set: chosen.g.set.spec, model: specName(model), bestSet: best.g.set.spec, bestModel: specName(best.g.model), rule: '1-SE' },
    nu: { chosen: chosenNu ?? null, table: nuTable.map(({ nu, logLoss }) => ({ nu, logLoss })) },
    dropped,
    importance,
  };
}

async function main() {
  const data = arg('data', 'research/out/dataset.jsonl');
  const out = arg('out', 'params/model.candidate.json');
  const rows = fs.readFileSync(data, 'utf8').split('\n').filter(Boolean).map((l) => {
    const r = JSON.parse(l) as DatasetRow;
    for (const k of Object.keys(r.fx)) if (r.fx[k] === null) r.fx[k] = NaN;
    return r;
  });
  const rep = trainMetaModel(rows, {
    maxEpochs: Number(arg('epochs', '400')),
    sets: arg('sets', DEFAULT_SETS.join(',')).split(','),
    families: arg('families', 'mlp,gbdt').split(',') as Array<'mlp' | 'gbdt'>,
    hidden: arg('hidden', '0,8').split(',').map(Number),
    depths: arg('depths', '2,3').split(',').map(Number),
    ensemble: Number(arg('ensemble', '5')),
    cpcvGroups: Number(arg('cpcv', '10')),
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(rep.params, null, 2) + '\n');
  console.table(rep.cv);
  console.log('selected (1-SE rule):', rep.selected);
  console.log('Student-t nu search (dev):', rep.nu);
  if (Object.keys(rep.dropped).length) console.log('dropped:', rep.dropped);
  console.log('holdout:', rep.holdout);
  console.log('holdout permutation importance (top 15):');
  console.table(rep.importance.slice(0, 15));
  console.log(`selected ${rep.params.version}; validation.passed=${rep.params.validation!.passed}; wrote ${out}`);
  console.log('Next: npm run research:backtest -- --model', out, '--annotate');
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) void main();
