// Calibration metrics: Brier score, log loss, reliability buckets, and Platt
// scaling. Used offline for validation and online for monitoring.

import { logit, sigmoid } from '../util/num';

export function brier(preds: number[], outcomes: number[]): number {
  if (preds.length !== outcomes.length || preds.length === 0) return NaN;
  let s = 0;
  for (let i = 0; i < preds.length; i++) s += (preds[i] - outcomes[i]) ** 2;
  return s / preds.length;
}

export function logLoss(preds: number[], outcomes: number[]): number {
  let s = 0;
  for (let i = 0; i < preds.length; i++) {
    const p = Math.min(1 - 1e-9, Math.max(1e-9, preds[i]));
    s += outcomes[i] ? -Math.log(p) : -Math.log(1 - p);
  }
  return s / preds.length;
}

export interface ReliabilityBucket {
  lo: number;
  hi: number;
  n: number;
  meanPred: number;
  freq: number;
  /** |freq - meanPred| in percentage points. */
  errorPp: number;
}

export function reliability(preds: number[], outcomes: number[], edges = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0001]): ReliabilityBucket[] {
  const out: ReliabilityBucket[] = [];
  for (let b = 0; b < edges.length - 1; b++) {
    const lo = edges[b];
    const hi = edges[b + 1];
    let n = 0, sp = 0, so = 0;
    for (let i = 0; i < preds.length; i++) {
      if (preds[i] >= lo && preds[i] < hi) { n++; sp += preds[i]; so += outcomes[i]; }
    }
    if (n === 0) continue;
    out.push({ lo, hi: Math.min(1, hi), n, meanPred: sp / n, freq: so / n, errorPp: Math.abs(so / n - sp / n) * 100 });
  }
  return out;
}

/** Max bucket error (pp) over buckets with at least `minN` samples. */
export function maxCalibrationErrorPp(buckets: ReliabilityBucket[], minN = 30): number {
  const eligible = buckets.filter((b) => b.n >= minN);
  return eligible.length ? Math.max(...eligible.map((b) => b.errorPp)) : Infinity;
}

/** Fit Platt scaling p = sigmoid(a*z + b) on logits z by Newton's method. */
export function fitPlatt(logits: number[], outcomes: number[], iters = 50): { a: number; b: number } {
  let a = 1, b = 0;
  for (let k = 0; k < iters; k++) {
    let ga = 0, gb = 0, haa = 0, hab = 0, hbb = 0;
    for (let i = 0; i < logits.length; i++) {
      const p = sigmoid(a * logits[i] + b);
      const e = p - outcomes[i];
      const w = Math.max(1e-9, p * (1 - p));
      ga += e * logits[i];
      gb += e;
      haa += w * logits[i] * logits[i];
      hab += w * logits[i];
      hbb += w;
    }
    // Small ridge keeps the Hessian invertible on separable data.
    haa += 1e-6; hbb += 1e-6;
    const det = haa * hbb - hab * hab;
    if (Math.abs(det) < 1e-12) break;
    const da = (hbb * ga - hab * gb) / det;
    const db = (haa * gb - hab * ga) / det;
    a -= da; b -= db;
    if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }
  return { a, b };
}

export function applyPlatt(p: number, cal: { a: number; b: number }): number {
  return sigmoid(cal.a * logit(p) + cal.b);
}

// ---- Beta calibration (Kull, Silva Filho & Flach 2017) ----------------------
// p' = sigmoid(a*ln p - b*ln(1-p) + c). Handles the asymmetric, longshot-style
// miscalibration that Platt scaling (symmetric in log-odds) cannot. Used for
// (1) the model's output and (2) the market's own mid, which gives a model-free
// estimate of the series' favourite-longshot bias ("p_mkt_cal").

export interface BetaCal { a: number; b: number; c: number }

export const IDENTITY_BETA: BetaCal = { a: 1, b: 1, c: 0 };

export function applyBeta(p: number, cal: BetaCal): number {
  const q = Math.min(1 - 1e-4, Math.max(1e-4, p));
  return sigmoid(cal.a * Math.log(q) - cal.b * Math.log(1 - q) + cal.c);
}

/** Fit by weighted logistic regression on [ln p, -ln(1-p), 1] (Newton with a small ridge toward identity). */
export function fitBeta(preds: number[], outcomes: number[], weights?: number[], iters = 50): BetaCal {
  let th = [1, 1, 0];
  const ridge = 1e-3;
  const x = preds.map((p) => { const q = Math.min(1 - 1e-4, Math.max(1e-4, p)); return [Math.log(q), -Math.log(1 - q), 1]; });
  for (let k = 0; k < iters; k++) {
    const g = [0, 0, 0];
    const H = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < x.length; i++) {
      const w = weights?.[i] ?? 1;
      const z = th[0] * x[i][0] + th[1] * x[i][1] + th[2] * x[i][2];
      const p = sigmoid(z);
      const e = (p - outcomes[i]) * w;
      const h = Math.max(1e-9, p * (1 - p)) * w;
      for (let r = 0; r < 3; r++) {
        g[r] += e * x[i][r];
        for (let c = 0; c < 3; c++) H[r][c] += h * x[i][r] * x[i][c];
      }
    }
    const prior = [1, 1, 0];
    for (let r = 0; r < 3; r++) { g[r] += ridge * (th[r] - prior[r]); H[r][r] += ridge; }
    const d = solve3(H, g);
    if (!d) break;
    th = th.map((t, r) => t - d[r]);
    if (Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) < 1e-9) break;
  }
  return { a: th[0], b: th[1], c: th[2] };
}

function solve3(A: number[][], b: number[]): number[] | undefined {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return undefined;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}

export function weightedLogLoss(preds: number[], outcomes: number[], weights?: number[]): number {
  let s = 0, wsum = 0;
  for (let i = 0; i < preds.length; i++) {
    const w = weights?.[i] ?? 1;
    const p = Math.min(1 - 1e-9, Math.max(1e-9, preds[i]));
    s += w * (outcomes[i] ? -Math.log(p) : -Math.log(1 - p));
    wsum += w;
  }
  return wsum > 0 ? s / wsum : NaN;
}

// ---- Calibration gate sliced by price and time-to-close ---------------------

export interface CalibrationSlice { slice: string; n: number; windows: number; meanPred: number; freq: number; errorPp: number; excessPp: number }

/**
 * Reliability by equal-mass price buckets and by time-to-close buckets.
 * `excessPp` = |freq - meanPred| minus 1.96 standard errors (using the number of
 * distinct settlement windows as the effective sample size, since snapshots in a
 * window share one outcome), floored at 0. A bucket "fails" only when its error
 * exceeds the tolerance by more than sampling noise explains.
 */
export function calibrationSlices(preds: number[], outcomes: number[], tauSec: number[], windows: number[], priceBins = 10, tauEdges = [0, 120, 300, 600, 900, 1800, 3600, Infinity]): CalibrationSlice[] {
  const idx = preds.map((_, i) => i);
  const out: CalibrationSlice[] = [];
  const add = (slice: string, members: number[]) => {
    if (!members.length) return;
    const n = members.length;
    const mp = members.reduce((s, i) => s + preds[i], 0) / n;
    const fr = members.reduce((s, i) => s + outcomes[i], 0) / n;
    const nw = new Set(members.map((i) => windows[i])).size;
    const se = Math.sqrt(Math.max(1e-6, mp * (1 - mp)) / Math.max(1, nw));
    const err = Math.abs(fr - mp) * 100;
    out.push({ slice, n, windows: nw, meanPred: mp, freq: fr, errorPp: err, excessPp: Math.max(0, err - 196 * se) });
  };
  const sorted = idx.slice().sort((a, b) => preds[a] - preds[b]);
  for (let b = 0; b < priceBins; b++) {
    const members = sorted.slice(Math.floor((b * sorted.length) / priceBins), Math.floor(((b + 1) * sorted.length) / priceBins));
    if (members.length) add(`price ${preds[members[0]].toFixed(2)}-${preds[members[members.length - 1]].toFixed(2)}`, members);
  }
  for (let b = 0; b < tauEdges.length - 1; b++) add(`tau ${tauEdges[b]}-${tauEdges[b + 1]}s`, idx.filter((i) => tauSec[i] >= tauEdges[b] && tauSec[i] < tauEdges[b + 1]));
  return out;
}

/** Largest error beyond sampling noise across slices with at least `minWindows` windows. */
export function maxExcessCalibrationPp(slices: CalibrationSlice[], minWindows = 30): number {
  const s = slices.filter((x) => x.windows >= minWindows);
  return s.length ? Math.max(...s.map((x) => x.excessPp)) : Infinity;
}
