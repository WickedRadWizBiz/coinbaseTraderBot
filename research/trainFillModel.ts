// Trains the fill / adverse-selection model (bot/tca/fillModel.ts) from the bot's own logged maker
// quotes (data/fills/fills-YYYY-MM-DD.jsonl, bot/tca/fillLog.ts).
//
// Readiness: at least 500 quotes and 100 fills; until then it throws "not ready" and the pipeline
// reports the step as skipped (collecting). Holdout = the last 20% of days (at least one). Validated
// when the P(fill) trees beat the base rate's log loss on the holdout AND the markout trees beat
// the mean markout's squared error on the holdout fills - then the pipeline promotes it and the
// engine starts quoting / crossing / skipping by expected value on its own.
//
//   npm run research:fill-train -- --fills data/fills [--out params/fill_model.json]

import fs from 'fs';
import path from 'path';
import { FILL_FEATURES, FILL_MIN_FILLS, FILL_MIN_QUOTES, type FillModelParams } from '../bot/tca/fillModel';
import { readFillLog, type FillLogRow } from '../bot/tca/fillLog';
import { gbdtLogit } from '../bot/model/trees';
import { trainGbdt } from './gbdt';

const vec = (r: FillLogRow) => FILL_FEATURES.map((k) => { const v = r.x?.[k]; return typeof v === 'number' && Number.isFinite(v) ? v : NaN; });
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const ll = (p: number, y: number) => { const q = Math.min(1 - 1e-9, Math.max(1e-9, p)); return -(y ? Math.log(q) : Math.log(1 - q)); };

export function trainFillModel(rows: FillLogRow[], seed = 7): FillModelParams {
  const fills = rows.filter((r) => r.filled).length;
  if (rows.length < FILL_MIN_QUOTES || fills < FILL_MIN_FILLS) throw new Error(`not ready: ${rows.length}/${FILL_MIN_QUOTES} quotes, ${fills}/${FILL_MIN_FILLS} fills logged`);
  const day = (r: FillLogRow) => new Date(r.t).toISOString().slice(0, 10);
  const days = [...new Set(rows.map(day))].sort();
  // With a single day, hold out its last 20% by time instead.
  const holdout = days.length >= 2 ? new Set(days.slice(-Math.max(1, Math.round(days.length * 0.2)))) : undefined;
  const cutT = rows[Math.floor(rows.length * 0.8)].t;
  const isHold = (r: FillLogRow) => (holdout ? holdout.has(day(r)) : r.t >= cutT);
  const dev = rows.filter((r) => !isHold(r)), ho = rows.filter(isHold);
  const vCut = dev[Math.floor(dev.length * 0.85)]?.t ?? Infinity;
  const tr = dev.filter((r) => r.t < vCut), va = dev.filter((r) => r.t >= vCut);
  const base = mean(tr.map((r) => r.filled));
  const logit = Math.log(Math.max(1e-4, base) / Math.max(1e-4, 1 - base));
  const ones = (n: number) => new Array(n).fill(1);
  const pf = trainGbdt(tr.map(vec), tr.map((r) => r.filled), ones(tr.length), new Array(tr.length).fill(logit), va.map(vec), va.map((r) => r.filled), ones(va.length), new Array(va.length).fill(logit),
    { nTrees: 300, learningRate: 0.05, maxDepth: 3, minLeafWeight: 20, seed });
  pf.model.baseScore = logit;
  const mkRows = (xs: FillLogRow[]) => xs.filter((r) => r.filled && typeof r.markout60 === 'number');
  const mtr = mkRows(tr), mva = mkRows(va), mho = mkRows(ho);
  const baseMk = mean(mtr.map((r) => r.markout60!));
  const mk = trainGbdt(mtr.map(vec), mtr.map((r) => r.markout60!), ones(mtr.length), new Array(mtr.length).fill(baseMk), mva.map(vec), mva.map((r) => r.markout60!), ones(mva.length), new Array(mva.length).fill(baseMk),
    { loss: 'squared', nTrees: 200, learningRate: 0.05, maxDepth: 2, minLeafWeight: 15, seed });
  mk.model.baseScore = baseMk;
  const sig = (z: number) => 1 / (1 + Math.exp(-z));
  const logLossBase = mean(ho.map((r) => ll(base, r.filled)));
  const logLossModel = mean(ho.map((r) => ll(sig(gbdtLogit(pf.model, vec(r))), r.filled)));
  const markoutMseBase = mean(mho.map((r) => (r.markout60! - baseMk) ** 2));
  const markoutMseModel = mean(mho.map((r) => (r.markout60! - gbdtLogit(mk.model, vec(r))) ** 2));
  const holdoutFills = ho.filter((r) => r.filled).length;
  return {
    version: `fill-${new Date().toISOString().slice(0, 10)}-${rows.length}q`,
    features: [...FILL_FEATURES], pFill: pf.model, markout: mk.model, baseRate: base, baseMarkout: baseMk,
    validation: {
      quotes: rows.length, fills, holdoutQuotes: ho.length, holdoutFills, logLossBase, logLossModel, markoutMseBase, markoutMseModel,
      // Both heads must beat their naive baselines out of sample (the markout head may tie when it
      // learned nothing: then it is just the mean, which is what the engine's buffer already uses).
      validated: ho.length >= 100 && holdoutFills >= 20 && logLossModel < logLossBase && (mk.trees === 0 || markoutMseModel <= markoutMseBase),
    },
    trainedAt: new Date().toISOString(),
  };
}

export async function trainFillMain(argOf: (k: string, d: string) => string = cliArg): Promise<FillModelParams> {
  const dir = argOf('fills', 'data/fills');
  const out = argOf('out', 'params/fill_model.json');
  const p = trainFillModel(readFillLog(dir));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(p));
  const v = p.validation;
  console.log(`fill model: ${v.quotes} quotes / ${v.fills} fills; holdout log loss ${v.logLossBase.toFixed(4)} -> ${v.logLossModel.toFixed(4)}, markout MSE ${v.markoutMseBase.toExponential(2)} -> ${v.markoutMseModel.toExponential(2)}; validated=${v.validated}; wrote ${out}`);
  return p;
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) void trainFillMain();

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }
