// Overfitting-aware statistics for strategy validation.
//  - Bootstrap confidence intervals over independent WINDOWS (not trades:
//    BTC/ETH/SOL markets in the same 15-minute window are one observation).
//  - Probabilistic and Deflated Sharpe Ratio (Bailey & López de Prado, 2014),
//    correcting for the number of variants tried and non-normal returns.
//  - Probability of Backtest Overfitting via Combinatorially Symmetric
//    Cross-Validation (Bailey, Borwein, López de Prado, Zhu, 2015).

import { mean, normCdf, normInv, stdev } from '../bot/util/num';

export function rng(seed = 1): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Percentile bootstrap CI of the mean. */
export function bootstrapMeanCi(xs: number[], alpha = 0.05, iters = 5000, seed = 1): { mean: number; lo: number; hi: number } {
  if (!xs.length) return { mean: NaN, lo: NaN, hi: NaN };
  const r = rng(seed);
  const means: number[] = [];
  for (let b = 0; b < iters; b++) {
    let s = 0;
    for (let i = 0; i < xs.length; i++) s += xs[Math.floor(r() * xs.length)];
    means.push(s / xs.length);
  }
  means.sort((a, b) => a - b);
  return { mean: mean(xs), lo: means[Math.floor((alpha / 2) * iters)], hi: means[Math.ceil((1 - alpha / 2) * iters) - 1] };
}

export function sharpe(xs: number[]): number {
  const sd = stdev(xs);
  return sd > 0 ? mean(xs) / sd : 0;
}

function moments(xs: number[]): { skew: number; kurt: number } {
  const m = mean(xs);
  const n = xs.length;
  const m2 = xs.reduce((a, x) => a + (x - m) ** 2, 0) / n;
  const m3 = xs.reduce((a, x) => a + (x - m) ** 3, 0) / n;
  const m4 = xs.reduce((a, x) => a + (x - m) ** 4, 0) / n;
  return { skew: m2 > 0 ? m3 / m2 ** 1.5 : 0, kurt: m2 > 0 ? m4 / m2 ** 2 : 3 };
}

/** P(true Sharpe > benchmark) given the observed per-period Sharpe. */
export function probabilisticSharpe(xs: number[], benchmark = 0): number {
  const n = xs.length;
  if (n < 3) return NaN;
  const sr = sharpe(xs);
  const { skew, kurt } = moments(xs);
  const denom = Math.sqrt(Math.max(1e-12, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr));
  return normCdf(((sr - benchmark) * Math.sqrt(n - 1)) / denom);
}

/** Expected maximum Sharpe among `trials` independent zero-skill variants. */
export function expectedMaxSharpe(trials: number, srVariance: number): number {
  if (trials <= 1) return 0;
  const g = 0.5772156649;
  return Math.sqrt(srVariance) * ((1 - g) * normInv(1 - 1 / trials) + g * normInv(1 - 1 / (trials * Math.E)));
}

export interface DeflatedSharpe {
  sharpe: number;
  /** Expected max Sharpe from luck alone. */
  sr0: number;
  /** sharpe - sr0: must be > 0 to pass the gate. */
  excess: number;
  /** PSR against sr0 (the DSR probability). */
  probability: number;
}

/** Deflated Sharpe. `srVariance` defaults to the null variance 1/(n-1). */
export function deflatedSharpe(xs: number[], trials: number, srVariance?: number): DeflatedSharpe {
  const sr = sharpe(xs);
  const v = srVariance ?? 1 / Math.max(1, xs.length - 1);
  const sr0 = expectedMaxSharpe(trials, v);
  return { sharpe: sr, sr0, excess: sr - sr0, probability: probabilisticSharpe(xs, sr0) };
}

function* combinations(n: number, k: number, start = 0, acc: number[] = []): Generator<number[]> {
  if (acc.length === k) { yield acc.slice(); return; }
  for (let i = start; i <= n - (k - acc.length); i++) {
    acc.push(i);
    yield* combinations(n, k, i + 1, acc);
    acc.pop();
  }
}

/**
 * PBO via CSCV. `returns[t][m]` = return of variant m in period t.
 * Splits T into S blocks; for every half/half split, picks the in-sample best
 * variant and records its out-of-sample relative rank. PBO = share of splits
 * where the IS winner lands in the bottom half OOS.
 */
export function pbo(returns: number[][], S = 8): { pbo: number; splits: number } {
  const T = returns.length;
  const M = returns[0]?.length ?? 0;
  if (M < 2 || T < S * 2) return { pbo: NaN, splits: 0 };
  const blockSize = Math.floor(T / S);
  const blocks = Array.from({ length: S }, (_, s) => returns.slice(s * blockSize, (s + 1) * blockSize));
  const score = (rows: number[][], m: number) => sharpe(rows.map((r) => r[m]));
  let below = 0, splits = 0;
  for (const is of combinations(S, S / 2)) {
    const isSet = new Set(is);
    const isRows = blocks.filter((_, i) => isSet.has(i)).flat();
    const oosRows = blocks.filter((_, i) => !isSet.has(i)).flat();
    let best = 0, bestScore = -Infinity;
    for (let m = 0; m < M; m++) {
      const s = score(isRows, m);
      if (s > bestScore) { bestScore = s; best = m; }
    }
    const oos = Array.from({ length: M }, (_, m) => score(oosRows, m));
    const rank = oos.filter((x) => x < oos[best]).length + 1; // 1..M
    const w = rank / (M + 1);
    if (Math.log(w / (1 - w)) <= 0) below++;
    splits++;
  }
  return { pbo: below / splits, splits };
}
