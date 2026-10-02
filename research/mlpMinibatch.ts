// Mini-batch Adam MLP for large row counts (hundreds of thousands of rows), on a flat Float32Array
// matrix so memory stays ~4 bytes per value. One tanh hidden layer (or none = linear/logistic
// regression), logistic loss for binary targets or squared loss for regression, L2 on weights, early
// stopping on a validation set. Produces DenseLayer weights + normalisation in the same format the
// live code evaluates (bot/model/metaModel.ts forward, bot/ta/taNet.ts evalHead).

import type { DenseLayer } from '../bot/model/metaModel';
import { rng } from './stats';

export interface Matrix { data: Float32Array; rows: number; cols: number }

export interface MiniOpts {
  hidden: number;
  loss: 'logistic' | 'squared';
  lr?: number;
  l2?: number;
  batch?: number;
  maxEpochs?: number;
  patience?: number;
  seed?: number;
}

export interface MiniFit { layers: DenseLayer[]; norm: { mean: number[]; std: number[] }; valLoss: number; epochs: number }

export function fitNorm(X: Matrix, idx?: Int32Array | number[]): { mean: number[]; std: number[] } {
  const d = X.cols, mean = new Float64Array(d), m2 = new Float64Array(d), cnt = new Float64Array(d);
  const rows = idx ?? Array.from({ length: X.rows }, (_, i) => i);
  for (const i of rows) {
    const o = i * d;
    for (let j = 0; j < d; j++) {
      const v = X.data[o + j];
      if (!Number.isFinite(v)) continue;
      cnt[j]++;
      const dl = v - mean[j];
      mean[j] += dl / cnt[j];
      m2[j] += dl * (v - mean[j]);
    }
  }
  return { mean: [...mean], std: [...m2].map((v, j) => (cnt[j] > 1 ? Math.sqrt(v / cnt[j]) : 0) || 1) };
}

/** Normalised copy of the selected rows (missing -> 0 = the training mean). */
export function normalizeRows(X: Matrix, idx: Int32Array | number[], n: { mean: number[]; std: number[] }): Float32Array {
  const d = X.cols, out = new Float32Array(idx.length * d);
  for (let r = 0; r < idx.length; r++) {
    const o = idx[r] * d, p = r * d;
    for (let j = 0; j < d; j++) { const v = X.data[o + j]; out[p + j] = Number.isFinite(v) ? (v - n.mean[j]) / n.std[j] : 0; }
  }
  return out;
}

const sig = (z: number) => 1 / (1 + Math.exp(-z));

export function trainMinibatch(X: Matrix, y: ArrayLike<number>, trainIdx: Int32Array | number[], valIdx: Int32Array | number[], o: MiniOpts): MiniFit {
  const d = X.cols, H = o.hidden;
  const lr = o.lr ?? 1e-3, l2 = o.l2 ?? 1e-4, B = o.batch ?? 256, maxEpochs = o.maxEpochs ?? 30, patience = o.patience ?? 3;
  const r = rng(o.seed ?? 7);
  const norm = fitNorm(X, trainIdx);
  const Xt = normalizeRows(X, trainIdx, norm), Xv = normalizeRows(X, valIdx, norm);
  const yt = Float32Array.from(trainIdx as ArrayLike<number>, (i) => y[i]), yv = Float32Array.from(valIdx as ArrayLike<number>, (i) => y[i]);
  const nT = yt.length, nV = yv.length;
  const ybar = yt.reduce((a, b) => a + b, 0) / Math.max(1, nT);
  const b0 = o.loss === 'logistic' ? Math.log(Math.max(1e-4, ybar) / Math.max(1e-4, 1 - ybar)) : ybar;
  // Parameters: hidden layer W1 (H x d), b1 (H); output w2 (H, or d when H = 0), b2.
  const W1 = new Float64Array(H * d), b1 = new Float64Array(H);
  for (let k = 0; k < W1.length; k++) W1[k] = (r() * 2 - 1) / Math.sqrt(d);
  const nOut = H || d;
  const w2 = new Float64Array(nOut);
  let b2 = b0;
  const params = [W1, b1, w2];
  const m = params.map((p) => new Float64Array(p.length)), v = params.map((p) => new Float64Array(p.length));
  let mb2 = 0, vb2 = 0, step = 0;
  const g = params.map((p) => new Float64Array(p.length));
  const h = new Float64Array(H);

  const out = (X_: Float32Array, i: number): number => {
    const o_ = i * d;
    if (!H) { let z = b2; for (let j = 0; j < d; j++) z += w2[j] * X_[o_ + j]; return z; }
    let z = b2;
    for (let k = 0; k < H; k++) {
      let a = b1[k];
      const wk = k * d;
      for (let j = 0; j < d; j++) a += W1[wk + j] * X_[o_ + j];
      const t = Math.tanh(a);
      h[k] = t;
      z += w2[k] * t;
    }
    return z;
  };
  const lossOf = (z: number, yy: number) => (o.loss === 'logistic' ? -(yy ? Math.log(Math.max(1e-12, sig(z))) : Math.log(Math.max(1e-12, 1 - sig(z)))) : 0.5 * (z - yy) ** 2);
  const valLoss = () => { let s = 0; for (let i = 0; i < nV; i++) s += lossOf(out(Xv, i), yv[i]); return s / Math.max(1, nV); };

  const snapshot = () => ({ W1: W1.slice(), b1: b1.slice(), w2: w2.slice(), b2 });
  let best = { loss: valLoss(), epoch: 0, p: snapshot() };
  const order = Int32Array.from({ length: nT }, (_, i) => i);
  const b1c = 0.9, b2c = 0.999, eps = 1e-8;
  for (let epoch = 1; epoch <= maxEpochs; epoch++) {
    for (let i = nT - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = order[i]; order[i] = order[j]; order[j] = t; }
    for (let s = 0; s < nT; s += B) {
      const e = Math.min(nT, s + B), nb = e - s;
      for (const gg of g) gg.fill(0);
      let gb2 = 0;
      for (let q = s; q < e; q++) {
        const i = order[q];
        const z = out(Xt, i);
        const dz = (o.loss === 'logistic' ? sig(z) - yt[i] : z - yt[i]) / nb;
        gb2 += dz;
        const o_ = i * d;
        if (!H) { for (let j = 0; j < d; j++) g[2][j] += dz * Xt[o_ + j]; continue; }
        for (let k = 0; k < H; k++) {
          g[2][k] += dz * h[k];
          const da = dz * w2[k] * (1 - h[k] * h[k]);
          if (da === 0) continue;
          g[1][k] += da;
          const wk = k * d;
          for (let j = 0; j < d; j++) g[0][wk + j] += da * Xt[o_ + j];
        }
      }
      step++;
      const c1 = 1 - b1c ** step, c2 = 1 - b2c ** step;
      for (let pi = 0; pi < params.length; pi++) {
        const p = params[pi], gp = g[pi], mp = m[pi], vp = v[pi];
        const reg = pi === 1 ? 0 : l2;
        for (let k = 0; k < p.length; k++) {
          const gr = gp[k] + reg * p[k];
          mp[k] = b1c * mp[k] + (1 - b1c) * gr;
          vp[k] = b2c * vp[k] + (1 - b2c) * gr * gr;
          p[k] -= (lr * (mp[k] / c1)) / (Math.sqrt(vp[k] / c2) + eps);
        }
      }
      mb2 = b1c * mb2 + (1 - b1c) * gb2;
      vb2 = b2c * vb2 + (1 - b2c) * gb2 * gb2;
      b2 -= (lr * (mb2 / c1)) / (Math.sqrt(vb2 / c2) + eps);
    }
    const vl = valLoss();
    if (vl < best.loss - 1e-7) best = { loss: vl, epoch, p: snapshot() };
    else if (epoch - best.epoch >= patience) break;
  }
  const P = best.p;
  const layers: DenseLayer[] = H
    ? [
      { weights: Array.from({ length: H }, (_, k) => Array.from(P.W1.subarray(k * d, (k + 1) * d))), bias: Array.from(P.b1), activation: 'tanh' },
      { weights: [Array.from(P.w2)], bias: [P.b2], activation: 'linear' },
    ]
    : [{ weights: [Array.from(P.w2)], bias: [P.b2], activation: 'linear' }];
  return { layers, norm, valLoss: best.loss, epochs: best.epoch };
}
