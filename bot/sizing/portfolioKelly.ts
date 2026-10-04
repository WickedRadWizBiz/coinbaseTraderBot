// Portfolio-level numerical Kelly (Phase 1 of the evolutionary protocol), applied where it fits the
// current build: as a CAP on new binary orders. It can only shrink an order the per-contract sizing
// (kelly.ts) already chose, never enlarge it.
//
//   maximise E[ log(1 + sum_i f_i R_i) ]     over stake fractions f >= 0, sum f <= maxTotal
//
// solved numerically (projected gradient ascent on a fixed scenario set: the objective is concave),
// instead of the closed-form single-bet Kelly. What the closed form misses and this captures:
//   - correlation: contracts settling on the same asset at the same time (an hourly ladder, a
//     15-minute Up/Down next to a strike) are driven by ONE index move. They share a scenario
//     factor (comonotonic: YES above a strike wins in the high-index scenarios, NO in the low ones),
//     so stacking them is penalised the way it should be;
//   - capital already locked in open positions (binaries are illiquid until settlement);
//   - continuous positions (perps) with their own variance, inflated by the share of capital locked
//     in binaries (that capital cannot buffer margin calls).
// The result is then shrunk to 0.25-0.5 of the optimum (fractional Kelly) for estimation error.
// timeNormalizedEdge() puts binaries (edge / lock-up time) and perps (drift per day) on one scale.

export interface BinaryBet {
  id: string;
  /** Contracts settling on the same index at the same time share a group (comonotonic factor). */
  group?: string;
  /** +1: wins when the underlying ends high (YES on Up/Down or above-strike); -1: wins when low. */
  direction?: 1 | -1;
  /** Probability this side wins. */
  prob: number;
  /** All-in cost per contract (price + fee), in (0, 1). */
  cost: number;
  /** Seconds until settlement (capital lock-up). */
  lockSec: number;
}

export interface ContinuousBet {
  id: string;
  /** Expected return over the horizon, and its standard deviation (fractions). */
  mu: number;
  sigma: number;
  horizonSec: number;
}

export interface KellyOpts {
  /** Upper bound on the sum of stake fractions (1 = all capital). */
  maxTotal?: number;
  /** Perp volatility inflation per unit of capital locked in binaries (sigma x (1 + k x locked)). */
  lockedVolMult?: number;
  /** Fraction of capital locked in binaries / bets already (for the perp inflation). */
  lockedFrac?: number;
  scenarios?: number;
  seed?: number;
  iters?: number;
}

/** Per-unit-stake return of a binary in a scenario: (1 - cost) / cost if it wins, -1 if it loses. */
const binaryReturn = (b: BinaryBet, win: boolean) => (win ? (1 - b.cost) / b.cost : -1);

function rngOf(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
}

function normInv(p: number): number {
  // Acklam's rational approximation.
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const q = Math.min(1 - 1e-12, Math.max(1e-12, p));
  if (q < 0.02425) { const r = Math.sqrt(-2 * Math.log(q)); return (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1); }
  if (q > 1 - 0.02425) { const r = Math.sqrt(-2 * Math.log(1 - q)); return -(((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1); }
  const r = q - 0.5, t = r * r;
  return (((((a[0] * t + a[1]) * t + a[2]) * t + a[3]) * t + a[4]) * t + a[5]) * r / (((((b[0] * t + b[1]) * t + b[2]) * t + b[3]) * t + b[4]) * t + 1);
}

/** Scenario matrix: R[s][i] = return per unit stake of bet i in scenario s. Grouped binaries share a
 *  uniform factor; every other bet has its own (independent); perps are normal with inflated sigma. */
export function scenarios(binaries: BinaryBet[], perps: ContinuousBet[], o: KellyOpts = {}): number[][] {
  const n = o.scenarios ?? 4000;
  const r = rngOf(o.seed ?? 12345);
  const groups = new Map<string, number>();
  let factors = 0;
  const factorOf = binaries.map((b) => { if (b.group) { if (!groups.has(b.group)) groups.set(b.group, factors++); return groups.get(b.group)!; } return factors++; });
  const pf = perps.map(() => factors++);
  const infl = 1 + (o.lockedVolMult ?? 1) * Math.max(0, o.lockedFrac ?? 0);
  const out: number[][] = [];
  for (let s = 0; s < n; s++) {
    const u = Array.from({ length: factors }, () => r());
    const row: number[] = [];
    binaries.forEach((b, i) => {
      const x = u[factorOf[i]];
      // Comonotonic within a group: "wins high" bets win for x >= 1 - p, "wins low" bets for x < p.
      const win = b.group ? ((b.direction ?? 1) > 0 ? x >= 1 - b.prob : x < b.prob) : x < b.prob;
      row.push(binaryReturn(b, win));
    });
    perps.forEach((p, k) => row.push(Math.max(-0.99, p.mu + p.sigma * infl * normInv(u[pf[k]]))));
    out.push(row);
  }
  return out;
}

/** Euclidean projection onto { f >= 0, sum f <= cap }. */
function project(f: number[], cap: number): number[] {
  const g = f.map((x) => Math.max(0, x));
  const s = g.reduce((a, b) => a + b, 0);
  if (s <= cap) return g;
  // Project onto the simplex sum = cap (Duchi et al.).
  const u = [...f].sort((a, b) => b - a);
  let css = 0, rho = 0, theta = 0;
  for (let j = 0; j < u.length; j++) { css += u[j]; const t = (css - cap) / (j + 1); if (u[j] - t > 0) { rho = j; theta = t; } }
  void rho;
  return f.map((x) => Math.max(0, x - theta));
}

const growth = (R: number[][], f: number[], fixed: number[] = []) => {
  let s = 0;
  for (const row of R) {
    let w = 1;
    for (let i = 0; i < f.length; i++) w += f[i] * row[i];
    for (let j = 0; j < fixed.length; j++) w += fixed[j] * row[f.length + j];
    s += Math.log(Math.max(1e-12, w));
  }
  return s / R.length;
};

export interface KellySolution {
  /** Optimal stake fraction per bet id (full Kelly; multiply by your shrink). */
  f: Record<string, number>;
  /** Expected log growth at the optimum. */
  growth: number;
  edgePerDay: Record<string, number>;
}

/** Joint numerical Kelly over every bet (none fixed). */
export function solveKelly(binaries: BinaryBet[], perps: ContinuousBet[] = [], o: KellyOpts = {}): KellySolution {
  const R = scenarios(binaries, perps, o);
  const m = binaries.length + perps.length;
  const cap = o.maxTotal ?? 0.95;
  let f = new Array(m).fill(0);
  let step = 0.5;
  let cur = growth(R, f);
  for (let it = 0; it < (o.iters ?? 300); it++) {
    const g = new Array(m).fill(0);
    for (const row of R) {
      let w = 1;
      for (let i = 0; i < m; i++) w += f[i] * row[i];
      const inv = 1 / Math.max(1e-9, w);
      for (let i = 0; i < m; i++) g[i] += row[i] * inv;
    }
    for (let i = 0; i < m; i++) g[i] /= R.length;
    // Backtracking line search on the projected step (the objective is concave).
    let next = project(f.map((x, i) => x + step * g[i]), cap), val = growth(R, next);
    while (val < cur - 1e-15 && step > 1e-8) { step *= 0.5; next = project(f.map((x, i) => x + step * g[i]), cap); val = growth(R, next); }
    if (Math.abs(val - cur) < 1e-12 && it > 5) { f = next; cur = val; break; }
    f = next; cur = val; step = Math.min(1, step * 1.5);
  }
  const ids = [...binaries.map((b) => b.id), ...perps.map((p) => p.id)];
  return { f: Object.fromEntries(ids.map((id, i) => [id, f[i]])), growth: cur, edgePerDay: Object.fromEntries([...binaries.map((b) => [b.id, timeNormalizedEdge(b)]), ...perps.map((p) => [p.id, (p.mu / Math.max(60, p.horizonSec)) * 86_400])]) };
}

/** Optimal stake for ONE new bet given positions already held (their fractions fixed): 1-D concave
 *  maximisation by golden-section search on [0, cap - held]. */
export function marginalKelly(candidate: BinaryBet, held: Array<BinaryBet & { frac: number }>, perps: Array<ContinuousBet & { frac: number }> = [], o: KellyOpts = {}): number {
  const R = scenarios([candidate, ...held], perps, o);
  const fixed = [...held.map((h) => h.frac), ...perps.map((p) => p.frac)];
  const room = Math.max(0, (o.maxTotal ?? 0.95) - held.reduce((a, h) => a + h.frac, 0));
  if (room <= 0) return 0;
  const gr = (x: number) => growth(R, [x], fixed);
  let a = 0, b = room;
  const phi = (Math.sqrt(5) - 1) / 2;
  let c = b - phi * (b - a), d = a + phi * (b - a), fc = gr(c), fd = gr(d);
  for (let it = 0; it < 60 && b - a > 1e-6; it++) {
    if (fc > fd) { b = d; d = c; fd = fc; c = b - phi * (b - a); fc = gr(c); } else { a = c; c = d; fc = fd; d = a + phi * (b - a); fd = gr(d); }
  }
  const x = (a + b) / 2;
  return gr(x) > gr(0) ? x : 0;
}

/** Expected value per unit staked, divided by the lock-up time (per day): binaries and perp drift on
 *  one scale. E[x] = p b - q with b = (1 - c) / c the net odds. */
export function timeNormalizedEdge(b: BinaryBet): number {
  const odds = (1 - b.cost) / b.cost;
  return ((b.prob * odds - (1 - b.prob)) / Math.max(60, b.lockSec)) * 86_400;
}
