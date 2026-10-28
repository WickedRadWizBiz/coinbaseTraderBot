// Offline SNN training on a walk-forward window (never live BPTT):
//   1. Predictive-coding pretraining: replay with the Rao-Ballard U-learning on (dense, self-supervised).
//   2. Truncated surrogate-gradient training of the L1 branch weights (e-prop style eligibility with
//      the fast-sigmoid surrogate, k = 25) through the L1-rate readout features, with settlement labels.
//   3. Readout fit: L2-regularised logistic regression of the settlement labels on the collected
//      per-contract feature snapshots, one readout per column.
// Each pass keeps only what it uses (replaySnn's lean mode): the network, the Brier sums and, for the readout, at
// most --readout-max snapshots per column (an even random sample), so weeks of history fit in memory.
// One network at a time (--domain crypto|perps; tennis learns live). Exports frozen weights
// (params/snn_<domain>.candidate.json) with the health reference measured on
// the training window. Evaluate out-of-sample on the NEXT window (--eval-from/--eval-to) before use.
// --init <model file>: every pass goes on from a trained network's weights and readouts instead of from nothing (the
// history walk's best network, research/historyWalk.ts). --incumbent <model file>: the network in use is judged on
// the same out-of-sample window (research/pipeline.ts compares the two).
//
//   npm run research:snn-train -- --recordings data/recordings --from 2026-06-01 --to 2026-06-22 --eval-from 2026-06-22 --eval-to 2026-06-29 [--domain crypto|perps] [--stage S5] [--out params/snn_crypto.candidate.json] [--init models/work/history-walk/crypto/elite.json] [--incumbent models/snn_crypto.json]

import fs from 'fs';
import path from 'path';
import { loadCalendar } from '../bot/model/calendar';
import { MetaModel } from '../bot/model/metaModel';
import { sigmoid } from '../bot/snn/formulas';
import { encodeArr, type SnnModelFile } from '../bot/snn/network';
import { DEFAULT_SNN, domainParams, stageFlags, versionHash, withFlags, type SnnParams, type Stage } from '../bot/snn/params';
import { replaySnn, type SnnScore } from './snnReplay';
import { withSnnHyper } from '../bot/snn/population';

/** Readout snapshots kept per column (each is a ~200-number feature vector; 19 days of contracts are millions). */
export const READOUT_MAX = 20_000;

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
  const modelPath = argOf('model', '');
  const model = modelPath && fs.existsSync(modelPath) ? MetaModel.load(modelPath) : undefined;
  const calendar = loadCalendar(path.resolve('params/calendar.json'));
  // --domain crypto|perps: each network trains alone on its own inputs (never on the other's).
  const domain = argOf('domain', 'crypto') as 'crypto' | 'perps';
  if (domain !== 'crypto' && domain !== 'perps') throw new Error(`--domain ${domain}: only crypto and perps are replayable (tennis learns live)`);
  const out = argOf('out', `params/snn_${domain}.candidate.json`);
  // --hyper: knobs chosen by the population tournament (research/snnPbt.ts).
  const hyperArg = argOf('hyper', '');
  const params: SnnParams = withSnnHyper(domainParams(domain, withFlags({ ...DEFAULT_SNN, seed: Number(argOf('seed', String(DEFAULT_SNN.seed))) }, stageFlags(stage))), hyperArg ? JSON.parse(hyperArg) : undefined);
  // --skip-model true: p_model is the fair value (synthetic contracts of the history replay, where the
  // decision model's view of a market quoted at the fair value is moot).
  const win = { from: date('from'), to: date('to'), domain, skipModel: argOf('skip-model', '') === 'true' };
  // --init: the network every pass starts from, without its health reference (the training measures its own on the
  // training window).
  const initPath = argOf('init', '');
  const init: SnnModelFile | undefined = initPath ? { ...(JSON.parse(fs.readFileSync(initPath, 'utf8')) as SnnModelFile), healthRef: undefined } : undefined;

  // 1. PC pretraining (U0, U1, precisions), only for stages with the PC pathway.
  let preset: SnnModelFile | undefined;
  if (params.flags.pc) {
    process.stderr.write('PC pretraining...\n');
    const pre = await replaySnn(dir, { params: withFlags(params, { pcLearn: true }), model, snnModel: init, ...win, calendar, lean: true });
    // From --init: its other weights and readouts with the pretrained U0, U1.
    preset = {
      version: versionHash(params), params, ...(init ? { readouts: init.readouts, dirReadouts: init.dirReadouts } : {}),
      columns: Object.fromEntries([...pre.net.columns].map(([k, c]) => [k, { ...init?.columns?.[k], U1: encodeArr(c.U1), U0: encodeArr(c.U0) }])),
    };
  }
  // 2. e-prop L1 training + feature collection for the readout.
  process.stderr.write('surrogate-gradient L1 training + readout data...\n');
  const tr = await replaySnn(dir, { params, model, snnModel: preset ?? init, ...win, calendar, lean: true, training: { eprop: { eta: Number(argOf('eprop-eta', '1e-3')) }, collect: true, collectMax: Number(argOf('readout-max', String(READOUT_MAX))) } });
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
    notes: `${domain} stage ${stage}; window ${win.from ? new Date(win.from).toISOString() : 'start'}..${win.to ? new Date(win.to).toISOString() : 'end'}`,
    columns: Object.fromEntries([...tr.net.columns].map(([k, c]) => [k, Object.fromEntries(trained.map((n) => [n, encodeArr(c.arrays()[n])]))])),
    readouts, dirReadouts: tr.net.exportModel().dirReadouts, healthRef: tr.net.health.ref,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(file));
  const b = (s: SnnScore) => ({ n: s.n, snn: s.snn / Math.max(1, s.n), model: s.model / Math.max(1, s.n) });
  const trainStats = b(tr.score);
  console.log('train window (in-sample, prequential):', trainStats);
  let evalStats: ReturnType<typeof b> | undefined;
  // Out-of-sample evaluation on the next window with the frozen export.
  const ev = { from: date('eval-from'), to: date('eval-to'), domain, skipModel: win.skipModel };
  if (ev.from) {
    const res = await replaySnn(dir, { params, model, snnModel: file, ...ev, calendar, lean: true });
    evalStats = b(res.score);
    console.log('eval window (out-of-sample):', evalStats);
  }
  // --incumbent: the network in use on the same window, as it runs (its own settings and weights).
  const incPath = argOf('incumbent', '');
  let incumbentStats: ReturnType<typeof b> | undefined;
  if (ev.from && incPath && fs.existsSync(incPath)) {
    const inc = JSON.parse(fs.readFileSync(incPath, 'utf8')) as SnnModelFile;
    const res = await replaySnn(dir, { params: inc.params, model, snnModel: inc, ...ev, calendar, lean: true });
    incumbentStats = b(res.score);
    console.log('eval window, the network in use:', incumbentStats);
  }
  console.log(`wrote ${out} (version ${file.version}); copy to params/snn_${domain}.json only after research:snn-ablation --domain ${domain} accepts the stage`);
  return { out, version: file.version, stage, domain, train: trainStats, eval: evalStats, ...(incumbentStats ? { incumbent: incumbentStats } : {}), ...(init ? { init: initPath } : {}) };
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) void trainSnnMain();

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }
