// Trains the tree-based volatility forecast (bot/model/volModel.ts) from recordings.
//
// Every minute per asset: the asset-level features and the EWMA sigma the pricer would use. For
// horizons of 5 / 15 / 30 / 60 minutes the label is log(sigma_realised / sigma_ewma), sigma_realised
// from the recorded 1 s index returns over [t, t + h] (same estimator as the EWMA: per-second
// squared log returns). Gradient-boosted trees with squared loss; early stopping on the last 15% of
// the development days. Validation on the last 20% of days: mean QLIKE of the variance forecast,
// EWMA alone vs EWMA x model, with a day-block bootstrap of the per-row improvement. Validated
// only when the bootstrap's lower bound is above zero.
//
//   npm run research:vol-model -- --recordings data/recordings [--out params/vol_model.json]

import fs from 'fs';
import path from 'path';
import { assetFeatureMap } from '../bot/model/featureEngine';
import { qlike, VOL_MODEL_ASSET_FEATURES, VOL_MODEL_FEATURES, VOL_MULT_MAX, VOL_MULT_MIN, volExtras, type VolModelParams } from '../bot/model/volModel';
import { gbdtLogit } from '../bot/model/trees';
import { dayBlockBootstrap } from '../bot/snn/blender';
import { trainGbdt } from './gbdt';
import { readRecordings, ReplayState } from './replay';

export const VOL_HORIZONS_MIN = [5, 15, 30, 60];

export interface VolRow { asset: string; t: number; day: string; tauSec: number; sigma: number; x: number[]; y: number; rvPerSec: number }

/** 1 s index grid per asset and day (NaN where no fresh print). */
class Grid {
  private readonly days = new Map<string, Float64Array>();
  set(asset: string, sec: number, v: number): void {
    const k = `${asset}|${Math.floor(sec / 86_400)}`;
    let a = this.days.get(k);
    if (!a) { a = new Float64Array(86_400).fill(NaN); this.days.set(k, a); }
    a[sec % 86_400] = v;
  }
  get(asset: string, sec: number): number {
    return this.days.get(`${asset}|${Math.floor(sec / 86_400)}`)?.[sec % 86_400] ?? NaN;
  }
  /** Realised variance per second over (sec0, sec0 + n]; NaN below 80% coverage. */
  rv(asset: string, sec0: number, n: number): number {
    let s = 0, k = 0, prev = this.get(asset, sec0);
    for (let i = 1; i <= n; i++) {
      const v = this.get(asset, sec0 + i);
      if (v > 0 && prev > 0) { const r = Math.log(v / prev); s += r * r; k++; }
      prev = v;
    }
    return k >= 0.8 * n ? s / k : NaN;
  }
}

export async function volRows(dir: string, opts: { everySec?: number; fromDay?: string; toDay?: string } = {}): Promise<VolRow[]> {
  const st = new ReplayState();
  const grid = new Grid();
  const every = (opts.everySec ?? 60) * 1000;
  const samples: { asset: string; t: number; sigma: number; f: Record<string, number> }[] = [];
  let curSec = 0, nextSample = 0;
  for await (const e of readRecordings(dir, '', opts.fromDay, opts.toDay)) {
    st.apply(e);
    const sec = Math.floor(st.now / 1000);
    if (sec > curSec) {
      // Mark every elapsed second with the last print at or before it (a print is good for 5 s).
      const from = curSec ? Math.max(curSec + 1, sec - 5) : sec;
      for (const [asset, idx] of st.index) {
        const p = idx.latest();
        if (!p) continue;
        for (let s = from; s <= sec; s++) if (s * 1000 - p.ts <= 5000 && s * 1000 >= p.ts) grid.set(asset, s, p.value);
      }
      curSec = sec;
    }
    if (st.now < nextSample) continue;
    nextSample = Math.floor(st.now / every) * every + every;
    for (const [asset, idx] of st.index) {
      const vol = idx.vol();
      if (!vol || !idx.fresh(st.now, 5000)) continue;
      const f = assetFeatureMap(asset, st.now, { index: idx, spot: st.spot.get(asset), bars: st.features.bars.get(asset), candles: st.features.candles.get(asset), usdtd: st.usdtd, btcd: st.btcd, perp: st.features.perps.get(asset) });
      samples.push({ asset, t: st.now, sigma: vol.sigmaPerSqrtSec, f });
    }
  }
  const rows: VolRow[] = [];
  for (const s of samples) {
    for (const h of VOL_HORIZONS_MIN) {
      const n = h * 60;
      const rv = grid.rv(s.asset, Math.floor(s.t / 1000), n);
      if (!(rv > 0) || !(s.sigma > 0)) continue;
      const f = { ...s.f, ...volExtras(s.t, s.sigma, n) };
      const y = Math.max(-1.5, Math.min(1.5, 0.5 * Math.log(rv / (s.sigma * s.sigma))));
      rows.push({ asset: s.asset, t: s.t, day: new Date(s.t).toISOString().slice(0, 10), tauSec: n, sigma: s.sigma, x: VOL_MODEL_FEATURES.map((k) => (Number.isFinite(f[k]) ? f[k] : NaN)), y, rvPerSec: rv });
    }
  }
  return rows;
}

export function trainVolModel(rows: VolRow[], seed = 7): VolModelParams {
  const days = [...new Set(rows.map((r) => r.day))].sort();
  if (rows.length < 2000 || days.length < 3) throw new Error(`need at least 2000 rows over 3 days, have ${rows.length} over ${days.length}`);
  const nHold = Math.max(1, Math.round(days.length * 0.2));
  const holdDays = new Set(days.slice(-nHold));
  const devDays = days.slice(0, -nHold);
  const valDays = new Set(devDays.slice(-Math.max(1, Math.round(devDays.length * 0.15))));
  const tr = rows.filter((r) => !holdDays.has(r.day) && !valDays.has(r.day)), va = rows.filter((r) => valDays.has(r.day)), ho = rows.filter((r) => holdDays.has(r.day));
  const ones = (n: number) => new Array(n).fill(1), zeros = (n: number) => new Array(n).fill(0);
  const fit = trainGbdt(tr.map((r) => r.x), tr.map((r) => r.y), ones(tr.length), zeros(tr.length), va.map((r) => r.x), va.map((r) => r.y), ones(va.length), zeros(va.length),
    { loss: 'squared', nTrees: 300, learningRate: 0.05, maxDepth: 3, minLeafWeight: 50, seed });
  const mult = (x: number[]) => Math.min(VOL_MULT_MAX, Math.max(VOL_MULT_MIN, Math.exp(gbdtLogit(fit.model, x))));
  const imp = ho.map((r) => {
    const R = r.rvPerSec, Fe = r.sigma * r.sigma, Fm = (r.sigma * mult(r.x)) ** 2;
    return { day: r.day, e: qlike(R, Fe), m: qlike(R, Fm) };
  });
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const bs = dayBlockBootstrap(imp.map((i) => ({ day: i.day, x: i.e - i.m })), 2000);
  return {
    version: `vol-${new Date().toISOString().slice(0, 10)}-${fit.trees}t`,
    features: [...VOL_MODEL_FEATURES], gbdt: fit.model, tauMin: [Math.min(...VOL_HORIZONS_MIN), Math.max(...VOL_HORIZONS_MIN)],
    validation: {
      rows: rows.length, holdoutRows: ho.length, holdoutDays: nHold,
      qlikeEwma: mean(imp.map((i) => i.e)), qlikeModel: mean(imp.map((i) => i.m)),
      improvement: { mean: bs.mean, lo: bs.lo, hi: bs.hi },
      validated: fit.trees > 0 && Number.isFinite(bs.lo) && bs.lo > 0,
    },
    trainedAt: new Date().toISOString(),
  };
}

export async function trainVolModelMain(argOf: (k: string, d: string) => string = cliArg): Promise<VolModelParams> {
  const dir = argOf('recordings', 'data/recordings');
  const out = argOf('out', 'params/vol_model.json');
  const rows = await volRows(dir);
  const p = trainVolModel(rows);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(p));
  const v = p.validation;
  console.log(`vol model: ${v.rows} rows, ${p.gbdt.trees.length} trees; holdout QLIKE ewma ${v.qlikeEwma.toFixed(4)} -> model ${v.qlikeModel.toFixed(4)} (improvement ${v.improvement.mean.toFixed(4)} [${v.improvement.lo.toFixed(4)}, ${v.improvement.hi.toFixed(4)}]); validated=${v.validated}`);
  console.log(`features: ${VOL_MODEL_ASSET_FEATURES.length} asset-level + horizon/clock extras; wrote ${out}`);
  return p;
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) void trainVolModelMain();

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }
