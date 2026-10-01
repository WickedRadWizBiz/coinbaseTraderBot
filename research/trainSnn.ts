// Offline SNN training on a walk-forward window (never live BPTT):
//   1. Predictive-coding pretraining: replay with the Rao-Ballard U-learning on (dense, self-supervised).
//   2. Truncated surrogate-gradient training of the L1 branch weights (e-prop style eligibility with
//      the fast-sigmoid surrogate, k = 25) through the L1-rate readout features, with settlement labels.
//   3. Readout fit: L2-regularised logistic regression of the settlement labels on the collected
//      per-contract feature snapshots, one readout per column.
// Exports frozen weights (params/snn_model.candidate.json) with the health reference measured on
// the training window. Evaluate out-of-sample on the NEXT window (--eval-from/--eval-to) before use.
//
//   npm run research:snn-train -- --recordings data/recordings --from 2026-06-01 --to 2026-06-22 --eval-from 2026-06-22 --eval-to 2026-06-29 [--stage S5] [--out params/snn_model.candidate.json]

import fs from 'fs';
import path from 'path';
import { loadCalendar } from '../bot/model/calendar';
import { MetaModel } from '../bot/model/metaModel';
import { brier, sigmoid } from '../bot/snn/formulas';
import { encodeArr, type SnnModelFile } from '../bot/snn/network';
import { DEFAULT_SNN, stageFlags, versionHash, withFlags, type SnnParams, type Stage } from '../bot/snn/params';
import { replaySnn } from './snnReplay';

/** L2-regularised logistic regression by gradient descent with backtracking (full batch). */
export function fitLogistic(X: Float64Array[], y: number[], w0: Float64Array, l2 = 1e-3, iters = 300): { w: Float64Array; loss: number } {
  const n = X.length, d = w0.length;
  let w = Float64Array.from(w0);
  const lossAt = (v: Float64Array) => {
    let s = 0;
    for (let i = 0; i < n; i++) { let z = 0; for (let j = 0; j < d; j++) z += v[j] * X[i][j]; const p = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(z))); s -= y[i] * Math.log(p) + (1 - y[i]) * Math.log(1 - p); }
    let r = 0; for (let j = 1; j < d; j++) r += v[j] * v[j];
    return s / Math.max(1, n) + 0.5 * l2 * r;
  };
  let loss = lossAt(w), lr = 1;
  for (let it = 0; it < iters && n; it++) {
    const g = new Float64Array(d);
    for (let i = 0; i < n; i++) { let z = 0; for (let j = 0; j < d; j++) z += w[j] * X[i][j]; const e = sigmoid(z) - y[i]; for (let j = 0; j < d; j++) g[j] += e * X[i][j]; }
    for (let j = 0; j < d; j++) g[j] = g[j] / n + (j ? l2 * w[j] : 0);
    let next: Float64Array, nl: number;
    for (;;) {
      next = Float64Array.from(w, (v, j) => v - lr * g[j]);
      nl = lossAt(next);
      if (nl <= loss || lr < 1e-6) break;
      lr *= 0.5;
    }
    if (loss - nl < 1e-10) { w = next; loss = nl; break; }
    w = next; loss = nl; lr *= 1.5;
  }
  return { w, loss };
}

export async function trainSnnMain(argOf: (k: string, d: string) => string = cliArg, annotate: boolean = process.argv.includes('--annotate')) {
  const dir = argOf('recordings', 'data/recordings');
  const date = (k: string) => (argOf(k, '') ? Date.parse(argOf(k, '')) : undefined);
  const stage = argOf('stage', 'S5') as Stage;
  const out = argOf('out', 'params/snn_model.candidate.json');
  const modelPath = argOf('model', '');
  const model = modelPath && fs.existsSync(modelPath) ? MetaModel.load(modelPath) : undefined;
  const calendar = loadCalendar(path.resolve('params/calendar.json'));
  const params: SnnParams = withFlags({ ...DEFAULT_SNN, seed: Number(argOf('seed', String(DEFAULT_SNN.seed))) }, stageFlags(stage));
  const win = { from: date('from'), to: date('to') };

  // 1. PC pretraining (U0, U1, precisions), only for stages with the PC pathway.
  let preset: SnnModelFile | undefined;
  if (params.flags.pc) {
    process.stderr.write('PC pretraining...\n');
    const pre = await replaySnn(dir, { params: withFlags(params, { pcLearn: true }), model, ...win, calendar });
    preset = { version: versionHash(params), params, columns: Object.fromEntries([...pre.net.columns].map(([k, c]) => [k, { U1: encodeArr(c.U1), U0: encodeArr(c.U0) }])) };
  }
  // 2. e-prop L1 training + feature collection for the readout.
  process.stderr.write('surrogate-gradient L1 training + readout data...\n');
  const tr = await replaySnn(dir, { params, model, snnModel: preset, ...win, calendar, training: { eprop: { eta: Number(argOf('eprop-eta', '1e-3')) }, collect: true } });
  // 3. Readout fit per column.
  const readouts: Record<string, number[]> = {};
  for (const [k, ro] of tr.net.readouts) {
    const data = tr.collected.filter((c) => c.column === k);
    if (data.length < 50) { readouts[k] = Array.from(ro.wf); continue; }
    const fit = fitLogistic(data.map((d) => d.phi), data.map((d) => d.y), ro.wf, Number(argOf('l2', '1e-3')));
    readouts[k] = Array.from(fit.w);
    console.log(`readout ${k}: ${data.length} labelled snapshots, log-loss ${fit.loss.toFixed(4)}`);
  }
  const trained = ['w1', 'w1s', 'theta1', 'alpha1', 'U1', 'U0'];
  const file: SnnModelFile = {
    version: versionHash(params), params, trainedAt: new Date().toISOString(),
    notes: `stage ${stage}; window ${win.from ? new Date(win.from).toISOString() : 'start'}..${win.to ? new Date(win.to).toISOString() : 'end'}`,
    columns: Object.fromEntries([...tr.net.columns].map(([k, c]) => [k, Object.fromEntries(trained.map((n) => [n, encodeArr(c.arrays()[n])]))])),
    readouts, healthRef: tr.net.health.ref,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(file));
  const b = (rows: { pSnn: number; pModel: number; y: 0 | 1 }[]) => ({ n: rows.length, snn: rows.reduce((a, r) => a + brier(r.pSnn, r.y), 0) / Math.max(1, rows.length), model: rows.reduce((a, r) => a + brier(r.pModel, r.y), 0) / Math.max(1, rows.length) });
  const trainStats = b(tr.rows);
  console.log('train window (in-sample, prequential):', trainStats);
  let evalStats: ReturnType<typeof b> | undefined;
  // Out-of-sample evaluation on the next window with the frozen export.
  const ev = { from: date('eval-from'), to: date('eval-to') };
  if (ev.from) {
    const res = await replaySnn(dir, { params, model, snnModel: file, ...ev, calendar });
    evalStats = b(res.rows);
    console.log('eval window (out-of-sample):', evalStats);
  }
  console.log(`wrote ${out} (version ${file.version}); copy to params/snn_model.json only after research:snn-ablation accepts the stage`);
  return { out, version: file.version, stage, train: trainStats, eval: evalStats };
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) void trainSnnMain();

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }
