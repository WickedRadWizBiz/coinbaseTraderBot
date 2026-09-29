// Train and validate the meta-model OFFLINE with purged walk-forward CV.
//   npm run research:train -- --data research/out/dataset.jsonl --out params/model.candidate.json
//
// Protocol:
//  - Split by 15-minute WINDOW (all markets closing together), chronologically.
//  - The final 20% of windows is an untouched holdout used once for the report.
//  - On the first 80%, expanding-window folds with a 1-window embargo choose
//    hyper-parameters (every variant tried is counted for the Deflated Sharpe).
//  - Platt scaling is fitted on pooled out-of-fold predictions only.
//  - The candidate file is written for review. Promoting it to
//    params/model.json is a reviewed commit, never an automatic step.

import fs from 'fs';
import path from 'path';
import { brier, fitPlatt, logLoss, maxCalibrationErrorPp, reliability } from '../bot/model/calibration';
import { FEATURE_NAMES } from '../bot/model/features';
import { GO_LIVE_GATES, MetaModelParams } from '../bot/model/metaModel';
import { sigmoid } from '../bot/util/num';
import type { DatasetRow } from './buildDataset';
import { predictLogits, train, TrainOptions } from './mlp';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const RESIDUAL = FEATURE_NAMES.indexOf('logit_fv');

export interface TrainReport {
  params: MetaModelParams;
  holdout: { nWindows: number; nRows: number; brierModel: number; brierMarket: number; brierFairValue: number; logLossModel: number; logLossMarket: number; maxCalErrPp: number };
  cv: Array<{ hidden: number; l2: number; oosLogLoss: number }>;
}

export function trainMetaModel(rows: DatasetRow[], opts: { folds?: number; seed?: number; maxEpochs?: number } = {}): TrainReport {
  const folds = opts.folds ?? 5;
  const windows = [...new Set(rows.map((r) => r.window))].sort((a, b) => a - b);
  if (windows.length < folds + 3) throw new Error(`need at least ${folds + 3} windows, have ${windows.length}`);
  const cut = windows[Math.floor(windows.length * 0.8)];
  const dev = rows.filter((r) => r.window < cut);
  const hold = rows.filter((r) => r.window >= cut);
  const devWindows = windows.filter((w) => w < cut);
  const blockSize = Math.floor(devWindows.length / (folds + 1));

  const grid: Array<Pick<TrainOptions, 'hidden' | 'l2'>> = [];
  for (const hidden of [0, 4, 8]) for (const l2 of [1e-3, 1e-2]) grid.push({ hidden, l2 });
  const base = { lr: 0.01, maxEpochs: opts.maxEpochs ?? 400, patience: 60, seed: opts.seed ?? 7, residual: RESIDUAL };

  const foldSplit = (k: number) => {
    const valStart = devWindows[(k + 1) * blockSize];
    const valEnd = devWindows[Math.min(devWindows.length - 1, (k + 2) * blockSize)] ?? Infinity;
    const embargoEnd = devWindows[Math.max(0, (k + 1) * blockSize - 1)]; // drop the window adjacent to validation
    const tr = dev.filter((r) => r.window < embargoEnd);
    const va = dev.filter((r) => r.window >= valStart && (k === folds - 1 ? true : r.window < valEnd));
    return { tr, va };
  };

  const cv: TrainReport['cv'] = [];
  let bestCfg = grid[0], bestLoss = Infinity;
  const oofByCfg = new Map<string, { z: number[]; y: number[]; oofWindows: number }>();
  for (const g of grid) {
    let total = 0, n = 0;
    const oof = { z: [] as number[], y: [] as number[], oofWindows: 0 };
    const seen = new Set<number>();
    for (let k = 0; k < folds; k++) {
      const { tr, va } = foldSplit(k);
      if (tr.length < 50 || va.length < 10) continue;
      const m = train(tr.map((r) => r.features), tr.map((r) => r.label), va.map((r) => r.features), va.map((r) => r.label), { ...base, ...g });
      const z = predictLogits(m.layers, m.norm, va.map((r) => r.features), RESIDUAL);
      total += logLoss(z.map(sigmoid), va.map((r) => r.label)) * va.length;
      n += va.length;
      oof.z.push(...z);
      oof.y.push(...va.map((r) => r.label));
      for (const r of va) seen.add(r.window);
    }
    oof.oofWindows = seen.size;
    const l = n ? total / n : Infinity;
    cv.push({ ...g, oosLogLoss: l });
    oofByCfg.set(JSON.stringify(g), oof);
    if (l < bestLoss) { bestLoss = l; bestCfg = g; }
  }

  // Final fit on all development data; early-stop on the last fold's block.
  const { va: lastVa } = foldSplit(folds - 1);
  const finalTrain = dev.filter((r) => r.window < (lastVa[0]?.window ?? cut));
  const fit = train(finalTrain.map((r) => r.features), finalTrain.map((r) => r.label), lastVa.map((r) => r.features), lastVa.map((r) => r.label), { ...base, ...bestCfg });
  // Platt scaling only when out-of-fold data spans enough independent windows
  // AND it improves out-of-fold log loss; otherwise it overfits (rows within a
  // window are highly correlated) and the residual model's calibration stands.
  const oof = oofByCfg.get(JSON.stringify(bestCfg))!;
  let cal = { a: 1, b: 0 };
  if (oof.oofWindows >= 200) {
    const cand = fitPlatt(oof.z, oof.y);
    if (logLoss(oof.z.map((z) => sigmoid(cand.a * z + cand.b)), oof.y) < logLoss(oof.z.map(sigmoid), oof.y) - 1e-4) cal = cand;
  }

  const zHold = predictLogits(fit.layers, fit.norm, hold.map((r) => r.features), RESIDUAL);
  const pHold = zHold.map((z) => sigmoid(cal.a * z + cal.b));
  const y = hold.map((r) => r.label);
  const brierModel = brier(pHold, y);
  const brierMarket = brier(hold.map((r) => r.mid), y);
  const brierFairValue = brier(hold.map((r) => r.fv), y);
  const maxCalErrPp = maxCalibrationErrorPp(reliability(pHold, y));
  const nWindows = new Set(hold.map((r) => r.window)).size;
  const referenceSigma = rows.reduce((s, r) => s + r.sigma, 0) / rows.length;

  const params: MetaModelParams = {
    version: `meta-mlp-${new Date().toISOString().slice(0, 10)}-h${bestCfg.hidden}`,
    kind: 'mlp',
    features: [...FEATURE_NAMES],
    normalization: fit.norm,
    layers: fit.layers,
    residualFeature: RESIDUAL,
    calibration: cal,
    referenceSigma,
    training: {
      rows: rows.length, devRows: dev.length, holdoutRows: hold.length, windows: windows.length,
      firstWindow: new Date(windows[0]).toISOString(), holdoutStart: new Date(cut).toISOString(),
      selected: bestCfg, epochs: fit.epochs, plattApplied: cal.a !== 1 || cal.b !== 0, variantsTried: grid.length, folds, embargoWindows: 1,
      officialLabelShare: rows.filter((r) => r.labelSource === 'official').length / rows.length,
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
    holdout: { nWindows, nRows: hold.length, brierModel, brierMarket, brierFairValue, logLossModel: logLoss(pHold, y), logLossMarket: logLoss(hold.map((r) => r.mid), y), maxCalErrPp },
    cv,
  };
}

async function main() {
  const data = arg('data', 'research/out/dataset.jsonl');
  const out = arg('out', 'params/model.candidate.json');
  const rows = fs.readFileSync(data, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as DatasetRow);
  const rep = trainMetaModel(rows, { maxEpochs: Number(arg('epochs', '400')) });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(rep.params, null, 2) + '\n');
  console.table(rep.cv);
  console.log('holdout:', rep.holdout);
  console.log(`validation.passed=${rep.params.validation!.passed}; wrote ${out}`);
  console.log('Next: npm run research:backtest -- --model', out, '--annotate');
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) void main();
