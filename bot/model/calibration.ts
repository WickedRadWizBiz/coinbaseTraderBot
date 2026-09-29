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
