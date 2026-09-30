// Train and validate the meta-model OFFLINE with purged walk-forward CV.
//   npm run research:train -- --data research/out/dataset.jsonl --out params/model.candidate.json
//        [--sets base,base+micro,base+momentum,base+spot,base+time,all] [--hidden 0,8,16] [--epochs 400]
//
// Protocol:
//  - Split by 15-minute WINDOW (all markets closing together), chronologically.
//  - The final 20% of windows is an untouched holdout used once for the report.
//  - On the first 80%, expanding-window folds with a 1-window embargo choose
//    the FEATURE SET (base vs base + candidate groups ported from the old
//    model), network width and L2. Every variant tried is counted for the
//    Deflated Sharpe, so a wide search raises the bar the model must clear.
//  - Candidate features missing in more than half the development rows are
//    dropped from a set before fitting; time-of-day features need 14+ days
//    of data (with less, hour-of-day aliases to the sample's regime).
//  - Platt scaling is fitted on pooled out-of-fold predictions only.
//  - Holdout permutation importance shows which features actually help.
//  - The candidate file is written for review; promoting it to
//    params/model.json is a reviewed commit, never an automatic step.

import fs from 'fs';
import path from 'path';
import { brier, fitPlatt, logLoss, maxCalibrationErrorPp, reliability } from '../bot/model/calibration';
import { FeatureGroup, featuresInGroups, FEATURES, vectorFor } from '../bot/model/featureEngine';
import { GO_LIVE_GATES, MetaModelParams } from '../bot/model/metaModel';
import { sigmoid } from '../bot/util/num';
import type { DatasetRow } from './buildDataset';
import { predictLogits, train, TrainOptions } from './mlp';
import { rng } from './stats';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

export const MIN_DAYS_FOR_TIME = 14;

export const DEFAULT_SETS = ['base', 'base+micro', 'base+momentum', 'base+spot', 'base+macro', 'base+macro+confluence', 'base+momentum+macro+confluence', 'base+session', 'base+session+macro+confluence', 'base+time', 'all'];

export function resolveSet(spec: string): string[] {
  const groups: FeatureGroup[] = spec === 'all' ? ['base', 'micro', 'momentum', 'spot', 'macro', 'confluence', 'session', 'time'] : (spec.split('+') as FeatureGroup[]);
  return featuresInGroups(groups);
}

export interface TrainReport {
  params: MetaModelParams;
  holdout: { nWindows: number; nRows: number; brierModel: number; brierMarket: number; brierFairValue: number; logLossModel: number; logLossMarket: number; maxCalErrPp: number };
  cv: Array<{ set: string; hidden: number; l2: number; features: number; oosLogLoss: number }>;
  dropped: Record<string, string[]>;
  importance: Array<{ feature: string; group: string; logLossIncrease: number }>;
}

export interface TrainOpts {
  folds?: number;
  seed?: number;
  maxEpochs?: number;
  sets?: string[];
  hidden?: number[];
  l2?: number[];
}

export function trainMetaModel(rows: DatasetRow[], opts: TrainOpts = {}): TrainReport {
  const folds = opts.folds ?? 5;
  const windows = [...new Set(rows.map((r) => r.window))].sort((a, b) => a - b);
  if (windows.length < folds + 3) throw new Error(`need at least ${folds + 3} windows, have ${windows.length}`);
  const cut = windows[Math.floor(windows.length * 0.8)];
  const dev = rows.filter((r) => r.window < cut);
  const hold = rows.filter((r) => r.window >= cut);
  const devWindows = windows.filter((w) => w < cut);
  const blockSize = Math.floor(devWindows.length / (folds + 1));

  // Resolve feature sets, dropping mostly-missing candidates (base is never dropped).
  const dropped: Record<string, string[]> = {};
  // Time-of-day features alias to "which part of the sample" until the data
  // covers many days; they are only eligible with >= MIN_DAYS_FOR_TIME days.
  const devDays = new Set(dev.map((r) => new Date(r.window).toISOString().slice(0, 10))).size;
  const sets = (opts.sets ?? DEFAULT_SETS).map((spec) => {
    const names = resolveSet(spec).filter((n) => {
      if (FEATURES[n].group === 'base') return true;
      // Session and time-of-day features alias to "which part of the sample" until
      // the data spans many days (every session recurring many times).
      if ((FEATURES[n].group === 'time' || FEATURES[n].group === 'session') && devDays < MIN_DAYS_FOR_TIME) {
        (dropped[spec] ??= []).push(`${n} (needs ${MIN_DAYS_FOR_TIME}+ days, have ${devDays})`);
        return false;
      }
      const avail = dev.filter((r) => Number.isFinite(r.fx[n] as number)).length / Math.max(1, dev.length);
      if (avail < 0.5) { (dropped[spec] ??= []).push(`${n} (available in ${(avail * 100).toFixed(0)}% of rows)`); return false; }
      return true;
    });
    return { spec, names };
  }).filter((set, i, all) => all.findIndex((o) => o.names.join() === set.names.join()) === i);

  const grid: Array<{ set: typeof sets[number] } & Pick<TrainOptions, 'hidden' | 'l2'>> = [];
  for (const set of sets) for (const hidden of opts.hidden ?? [0, 8, 16]) for (const l2 of opts.l2 ?? [1e-3, 1e-2]) grid.push({ set, hidden, l2 });
  const base = { lr: 0.01, maxEpochs: opts.maxEpochs ?? 400, patience: 60, seed: opts.seed ?? 7 };

  const foldSplit = (k: number) => {
    const valStart = devWindows[(k + 1) * blockSize];
    const valEnd = devWindows[Math.min(devWindows.length - 1, (k + 2) * blockSize)] ?? Infinity;
    const embargoEnd = devWindows[Math.max(0, (k + 1) * blockSize - 1)]; // drop the window adjacent to validation
    const tr = dev.filter((r) => r.window < embargoEnd);
    const va = dev.filter((r) => r.window >= valStart && (k === folds - 1 ? true : r.window < valEnd));
    return { tr, va };
  };
  const X = (rs: DatasetRow[], names: string[]) => rs.map((r) => vectorFor(names, r.fx));
  const Y = (rs: DatasetRow[]) => rs.map((r) => r.label);

  const cv: TrainReport['cv'] = [];
  let best = grid[0], bestLoss = Infinity;
  const oofByCfg = new Map<typeof grid[number], { z: number[]; y: number[]; oofWindows: number }>();
  for (const g of grid) {
    const residual = g.set.names.indexOf('logit_fv');
    let total = 0, n = 0;
    const oof = { z: [] as number[], y: [] as number[], oofWindows: 0 };
    const seen = new Set<number>();
    for (let k = 0; k < folds; k++) {
      const { tr, va } = foldSplit(k);
      if (tr.length < 50 || va.length < 10) continue;
      const m = train(X(tr, g.set.names), Y(tr), X(va, g.set.names), Y(va), { ...base, hidden: g.hidden, l2: g.l2, residual });
      const z = predictLogits(m.layers, m.norm, X(va, g.set.names), residual);
      total += logLoss(z.map(sigmoid), Y(va)) * va.length;
      n += va.length;
      oof.z.push(...z);
      oof.y.push(...Y(va));
      for (const r of va) seen.add(r.window);
    }
    oof.oofWindows = seen.size;
    const l = n ? total / n : Infinity;
    cv.push({ set: g.set.spec, hidden: g.hidden, l2: g.l2, features: g.set.names.length, oosLogLoss: l });
    oofByCfg.set(g, oof);
    if (l < bestLoss) { bestLoss = l; best = g; }
  }

  const names = best.set.names;
  const residual = names.indexOf('logit_fv');
  const { va: lastVa } = foldSplit(folds - 1);
  const finalTrain = dev.filter((r) => r.window < (lastVa[0]?.window ?? cut));
  const fit = train(X(finalTrain, names), Y(finalTrain), X(lastVa, names), Y(lastVa), { ...base, hidden: best.hidden, l2: best.l2, residual });

  // Platt only with enough independent out-of-fold windows AND if it helps OOF.
  const oof = oofByCfg.get(best)!;
  let cal = { a: 1, b: 0 };
  if (oof.oofWindows >= 200) {
    const cand = fitPlatt(oof.z, oof.y);
    if (logLoss(oof.z.map((z) => sigmoid(cand.a * z + cand.b)), oof.y) < logLoss(oof.z.map(sigmoid), oof.y) - 1e-4) cal = cand;
  }

  const Xh = X(hold, names);
  const y = Y(hold);
  const predict = (Xm: number[][]) => predictLogits(fit.layers, fit.norm, Xm, residual).map((z) => sigmoid(cal.a * z + cal.b));
  const pHold = predict(Xh);
  const brierModel = brier(pHold, y);
  const brierMarket = brier(hold.map((r) => r.mid), y);
  const brierFairValue = brier(hold.map((r) => r.fv), y);
  const maxCalErrPp = maxCalibrationErrorPp(reliability(pHold, y));
  const nWindows = new Set(hold.map((r) => r.window)).size;
  const referenceSigma = rows.reduce((s, r) => s + r.sigma, 0) / rows.length;

  // Permutation importance on the holdout (log-loss increase when a column is shuffled).
  const baseLoss = logLoss(pHold, y);
  const r = rng(99);
  const importance = names.map((f, j) => {
    const col = Xh.map((x) => x[j]);
    for (let i = col.length - 1; i > 0; i--) { const k = Math.floor(r() * (i + 1)); [col[i], col[k]] = [col[k], col[i]]; }
    const shuffled = Xh.map((x, i) => { const c = x.slice(); c[j] = col[i]; return c; });
    return { feature: f, group: FEATURES[f].group, logLossIncrease: logLoss(predict(shuffled), y) - baseLoss };
  }).sort((a, b) => b.logLossIncrease - a.logLossIncrease);

  const params: MetaModelParams = {
    version: `meta-mlp-${new Date().toISOString().slice(0, 10)}-${best.set.spec}-h${best.hidden}`,
    kind: 'mlp',
    features: names,
    normalization: fit.norm,
    layers: fit.layers,
    residualFeature: residual,
    calibration: cal,
    referenceSigma,
    training: {
      rows: rows.length, devRows: dev.length, holdoutRows: hold.length, windows: windows.length,
      firstWindow: new Date(windows[0]).toISOString(), holdoutStart: new Date(cut).toISOString(),
      selected: { set: best.set.spec, hidden: best.hidden, l2: best.l2 }, epochs: fit.epochs, plattApplied: cal.a !== 1 || cal.b !== 0,
      variantsTried: grid.length, folds, embargoWindows: 1, droppedFeatures: dropped,
      officialLabelShare: rows.filter((x) => x.labelSource === 'official').length / rows.length,
      holdoutImportance: importance.slice(0, 15),
    },
    validation: {
      passed: nWindows >= GO_LIVE_GATES.minWindows && brierModel < brierMarket && maxCalErrPp <= GO_LIVE_GATES.maxCalibrationErrorPp,
      nWindows,
      brierModel,
      brierMarket,
      brierFairValue,
      maxCalibrationErrorPp: Number.isFinite(maxCalErrPp) ? maxCalErrPp : 100,
      variantsTried: grid.length,
      evaluatedAt: new Date().toISOString(),
      notes: 'netEdgeCiLow and deflatedSharpe are added by research:backtest --annotate',
    },
  };
  return {
    params,
    holdout: { nWindows, nRows: hold.length, brierModel, brierMarket, brierFairValue, logLossModel: baseLoss, logLossMarket: logLoss(hold.map((x) => x.mid), y), maxCalErrPp },
    cv,
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
    hidden: arg('hidden', '0,8,16').split(',').map(Number),
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(rep.params, null, 2) + '\n');
  console.table(rep.cv);
  if (Object.keys(rep.dropped).length) console.log('dropped (mostly missing):', rep.dropped);
  console.log('holdout:', rep.holdout);
  console.log('holdout permutation importance (top 15):');
  console.table(rep.importance.slice(0, 15));
  console.log(`selected ${rep.params.version}; validation.passed=${rep.params.validation!.passed}; wrote ${out}`);
  console.log('Next: npm run research:backtest -- --model', out, '--annotate');
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) void main();
