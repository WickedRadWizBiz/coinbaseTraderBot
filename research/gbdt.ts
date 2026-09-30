// Gradient-boosted trees for binary log loss, trained offline in TypeScript
// and evaluated live by bot/model/trees.ts. Training and serving share one
// language and one feature engine, so there is no ONNX export step and no
// train/serve parity gap to police.
//
// LightGBM-style essentials, sized for a few thousand to a few hundred thousand
// rows: quantile histograms (<= 32 bins per feature), second-order (Newton)
// leaf values with L2 regularization, a learned default direction for missing
// values, minimum leaf weight, feature and row subsampling, and early stopping
// on a validation fold. Rows carry weights (1 / snapshots per contract), and
// every row carries an initial margin (init_score): the fair-value log-odds,
// so the trees learn only the residual against the pricer.

import type { GbdtModel, TreeNode } from '../bot/model/trees';
import { gbdtLogit } from '../bot/model/trees';
import { sigmoid } from '../bot/util/num';
import { rng } from './stats';

export interface GbdtParams {
  nTrees: number;
  learningRate: number;
  maxDepth: number;
  /** Minimum summed row weight in a leaf. */
  minLeafWeight: number;
  lambda: number;
  featureFraction: number;
  baggingFraction: number;
  maxBins: number;
  patience: number;
  seed: number;
}

export const DEFAULT_GBDT: GbdtParams = {
  nTrees: 400, learningRate: 0.03, maxDepth: 3, minLeafWeight: 20, lambda: 5,
  featureFraction: 0.7, baggingFraction: 0.7, maxBins: 32, patience: 40, seed: 7,
};

interface Binned { cuts: number[][]; bins: Int16Array[] }

function binColumns(X: number[][], maxBins: number): Binned {
  const d = X[0]?.length ?? 0;
  const cuts: number[][] = [];
  const bins: Int16Array[] = [];
  for (let j = 0; j < d; j++) {
    const vals = X.map((x) => x[j]).filter(Number.isFinite).sort((a, b) => a - b);
    const c: number[] = [];
    for (let k = 1; k < maxBins; k++) {
      if (!vals.length) break;
      const v = vals[Math.min(vals.length - 1, Math.floor((k * vals.length) / maxBins))];
      if (!c.length || v > c[c.length - 1]) c.push(v);
    }
    if (c.length && c[c.length - 1] >= vals[vals.length - 1]) c.pop(); // last cut must split something
    cuts.push(c);
    const col = new Int16Array(X.length);
    for (let i = 0; i < X.length; i++) col[i] = binOf(X[i][j], c);
    bins.push(col);
  }
  return { cuts, bins };
}

/** -1 = missing; else first i with x <= cuts[i], or cuts.length. */
function binOf(x: number, c: number[]): number {
  if (!Number.isFinite(x)) return -1;
  let lo = 0, hi = c.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (x <= c[m]) hi = m; else lo = m + 1; }
  return lo;
}

interface Split { f: number; k: number; missLeft: boolean; gain: number }

function bestSplit(rows: number[], g: Float64Array, h: Float64Array, w: Float64Array, B: Binned, feats: number[], p: GbdtParams): Split | undefined {
  let G = 0, H = 0;
  for (const i of rows) { G += g[i]; H += h[i]; }
  const parent = (G * G) / (H + p.lambda);
  let best: Split | undefined;
  for (const f of feats) {
    const nb = B.cuts[f].length + 1;
    if (nb < 2) continue;
    const hg = new Float64Array(nb), hh = new Float64Array(nb), hw = new Float64Array(nb);
    let mg = 0, mh = 0, mw = 0;
    const col = B.bins[f];
    for (const i of rows) {
      const b = col[i];
      if (b < 0) { mg += g[i]; mh += h[i]; mw += w[i]; } else { hg[b] += g[i]; hh[b] += h[i]; hw[b] += w[i]; }
    }
    let lg = 0, lh = 0, lw = 0;
    let totW = mw;
    for (let b = 0; b < nb; b++) totW += hw[b];
    for (let k = 0; k < nb - 1; k++) {
      lg += hg[k]; lh += hh[k]; lw += hw[k];
      for (const missLeft of [false, true]) {
        const LG = lg + (missLeft ? mg : 0), LH = lh + (missLeft ? mh : 0), LW = lw + (missLeft ? mw : 0);
        const RG = G - LG, RH = H - LH, RW = totW - LW;
        if (LW < p.minLeafWeight || RW < p.minLeafWeight) continue;
        const gain = (LG * LG) / (LH + p.lambda) + (RG * RG) / (RH + p.lambda) - parent;
        if (gain > 1e-9 && (!best || gain > best.gain)) best = { f, k, missLeft, gain };
        if (mw === 0) break; // no missing rows: direction is irrelevant
      }
    }
  }
  return best;
}

function buildTree(rows: number[], g: Float64Array, h: Float64Array, w: Float64Array, B: Binned, feats: number[], p: GbdtParams): TreeNode[] {
  const nodes: TreeNode[] = [];
  const leaf = (rs: number[]): TreeNode => {
    let G = 0, H = 0;
    for (const i of rs) { G += g[i]; H += h[i]; }
    return { f: -1, t: 0, l: 0, r: 0, ml: false, v: (-G / (H + p.lambda)) * p.learningRate };
  };
  const grow = (rs: number[], depth: number): number => {
    const id = nodes.length;
    nodes.push(leaf(rs));
    if (depth >= p.maxDepth) return id;
    const s = bestSplit(rs, g, h, w, B, feats, p);
    if (!s) return id;
    const col = B.bins[s.f];
    const L: number[] = [], R: number[] = [];
    for (const i of rs) {
      const b = col[i];
      if (b < 0 ? s.missLeft : b <= s.k) L.push(i); else R.push(i);
    }
    const l = grow(L, depth + 1);
    const r = grow(R, depth + 1);
    nodes[id] = { f: s.f, t: B.cuts[s.f][s.k], l, r, ml: s.missLeft, v: 0 };
    return id;
  };
  grow(rows, 0);
  return nodes;
}

function weightedLoss(margins: number[], y: number[], w: number[]): number {
  let s = 0, ws = 0;
  for (let i = 0; i < y.length; i++) {
    const p = Math.min(1 - 1e-9, Math.max(1e-9, sigmoid(margins[i])));
    s += w[i] * (y[i] ? -Math.log(p) : -Math.log(1 - p));
    ws += w[i];
  }
  return ws > 0 ? s / ws : NaN;
}

export interface GbdtFit { model: GbdtModel; valLoss: number; trees: number }

/**
 * Train with init margins (`init[i]` is added to every prediction: the residual
 * base). Early stopping on the validation set; the returned model keeps the
 * best iteration. Live: logit = baseScore + sum(trees(x)) + residual feature.
 */
export function trainGbdt(
  X: number[][], y: number[], w: number[], init: number[],
  Xv: number[][], yv: number[], wv: number[], initv: number[],
  params: Partial<GbdtParams> = {},
): GbdtFit {
  const p = { ...DEFAULT_GBDT, ...params };
  const B = binColumns(X, p.maxBins);
  const d = X[0].length;
  const r = rng(p.seed);
  const n = X.length;
  const margin = init.slice();
  const vMargin = initv.slice();
  const g = new Float64Array(n), h = new Float64Array(n), wa = Float64Array.from(w);
  const trees: TreeNode[][] = [];
  let best = { val: weightedLoss(vMargin, yv, wv), n: 0 };
  for (let t = 0; t < p.nTrees; t++) {
    for (let i = 0; i < n; i++) {
      const pr = sigmoid(margin[i]);
      g[i] = w[i] * (pr - y[i]);
      h[i] = w[i] * Math.max(1e-6, pr * (1 - pr));
    }
    const rows: number[] = [];
    for (let i = 0; i < n; i++) if (p.baggingFraction >= 1 || r() < p.baggingFraction) rows.push(i);
    const feats: number[] = [];
    for (let j = 0; j < d; j++) if (p.featureFraction >= 1 || r() < p.featureFraction) feats.push(j);
    if (!feats.length) feats.push(Math.floor(r() * d));
    const tree = buildTree(rows, g, h, wa, B, feats, p);
    trees.push(tree);
    const one: GbdtModel = { trees: [tree], baseScore: 0 };
    for (let i = 0; i < n; i++) margin[i] += gbdtLogit(one, X[i]);
    for (let i = 0; i < Xv.length; i++) vMargin[i] += gbdtLogit(one, Xv[i]);
    const val = weightedLoss(vMargin, yv, wv);
    if (val < best.val - 1e-7) best = { val, n: t + 1 };
    else if (t + 1 - best.n > p.patience) break;
  }
  return { model: { trees: trees.slice(0, best.n), baseScore: 0 }, valLoss: best.val, trees: best.n };
}

export function predictGbdtLogits(m: GbdtModel, X: number[][], residual: number): number[] {
  return X.map((x) => gbdtLogit(m, x) + (residual >= 0 && Number.isFinite(x[residual]) ? x[residual] : 0));
}
