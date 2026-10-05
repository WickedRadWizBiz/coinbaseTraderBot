// Tournament fitness, shared by the offline tournaments (research/pbt.ts, research/fitness.ts) and
// the live tennis population (bot/snn/population.ts):
//
//   Fitness = Sortino (annualised, net of costs) - ddWeight x max drawdown - costWeight x costs
//
// Trades that fire together (same group, within clusterMs) count as one independent interaction.

const DAY = 86_400_000;

/** One trade or position-period result: return as a fraction of capital, cost already subtracted. */
export interface Interaction {
  ts: number;
  ret: number;
  cost: number;
  /** Trades sharing a group (asset, event, column) and firing within clusterMs are one interaction. */
  group?: string;
}

/** Cluster trades into independent interactions (summed returns). Sorted by time. */
export function independentInteractions(xs: Interaction[], clusterMs: number): Interaction[] {
  const sorted = [...xs].sort((a, b) => a.ts - b.ts);
  const open = new Map<string, Interaction & { last: number }>();
  const out: Interaction[] = [];
  for (const x of sorted) {
    const g = x.group ?? '';
    const cur = open.get(g);
    if (cur && x.ts - cur.last <= clusterMs) { cur.ret += x.ret; cur.cost += x.cost; cur.last = x.ts; continue; }
    const c = { ts: x.ts, ret: x.ret, cost: x.cost, group: x.group, last: x.ts };
    open.set(g, c);
    out.push(c);
  }
  return out.map(({ ts, ret, cost, group }) => ({ ts, ret, cost, group }));
}

/** Sum of returns per UTC day (days with no trade count as 0 between first and last day). */
export function dailyReturns(xs: Interaction[], from?: number, to?: number): number[] {
  if (!xs.length && from === undefined) return [];
  const a = Math.floor((from ?? Math.min(...xs.map((x) => x.ts))) / DAY), b = Math.floor(((to ?? Math.max(...xs.map((x) => x.ts)) + 1) - 1) / DAY);
  const days = new Array(Math.max(0, b - a + 1)).fill(0);
  for (const x of xs) { const k = Math.floor(x.ts / DAY) - a; if (k >= 0 && k < days.length) days[k] += x.ret; }
  return days;
}

export function sortino(xs: number[], periodsPerYear = 365): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  const down = Math.sqrt(xs.reduce((s, x) => s + Math.min(0, x) ** 2, 0) / xs.length);
  if (down === 0) return m > 0 ? 10 : 0;
  return Math.max(-10, Math.min(10, (m / down) * Math.sqrt(periodsPerYear)));
}

/** Max drawdown (fraction) of the compounded equity curve of per-period returns. */
export function maxDrawdown(xs: number[]): number {
  let eq = 1, peak = 1, dd = 0;
  for (const r of xs) { eq *= Math.max(1e-9, 1 + r); peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); }
  return dd;
}

export interface FitnessWeights { ddWeight: number; costWeight: number }
export const DEFAULT_FITNESS: FitnessWeights = { ddWeight: 5, costWeight: 5 };

export interface FitnessReport {
  fitness: number;
  sortino: number;
  maxDrawdown: number;
  /** Total costs over the window (fraction of capital). */
  costs: number;
  netReturn: number;
  interactions: number;
  independent: number;
  days: number;
}

/** Fitness = Sortino - ddWeight x MaxDD - costWeight x costs, on daily net returns. */
export function fitnessOf(xs: Interaction[], o: { from?: number; to?: number; clusterMs: number; weights?: FitnessWeights }): FitnessReport {
  const w = o.weights ?? DEFAULT_FITNESS;
  const daily = dailyReturns(xs, o.from, o.to);
  const so = sortino(daily), dd = maxDrawdown(daily);
  const costs = xs.reduce((s, x) => s + x.cost, 0);
  const ind = independentInteractions(xs, o.clusterMs).length;
  // A network that never trades scores 0 (cash): better than any losing one, worse than any winner.
  const fitness = so - w.ddWeight * dd - w.costWeight * costs;
  return { fitness, sortino: so, maxDrawdown: dd, costs, netReturn: daily.reduce((s, r) => s + r, 0), interactions: xs.length, independent: ind, days: daily.length };
}


/**
 * Sitting out must not win a tournament. A member that takes fewer than `min` of its opportunities
 * scores at most 0 minus up to 10 (no trades = -10): otherwise, while every member's edge is still weak,
 * the ones that barely trade beat every one that trades and loses a little, and the population learns
 * to abstain instead of learning to predict.
 */
export function coverageFloor(rep: FitnessReport, taken: number, opportunities: number, min: number): FitnessReport {
  const cov = opportunities > 0 ? taken / opportunities : 0;
  if (cov >= min) return rep;
  return { ...rep, fitness: Math.min(rep.fitness, 0) - 10 * (1 - cov / min) };
}

// ---- Hyperparameter mutation (population-based training) ----------------------------------------

export type Hyper = Record<string, number>;
export interface MutationSpec { [knob: string]: { min: number; max: number; integer?: boolean } }

/** init: +/-10% around the base (three near-identical networks); explore: x0.8 or x1.25 per knob. */
export function perturb(h: Hyper, spec: MutationSpec, r: () => number, mode: 'init' | 'explore'): Hyper {
  const out: Hyper = { ...h };
  for (const [k, s] of Object.entries(spec)) {
    if (!(k in out)) continue;
    const f = mode === 'init' ? 0.9 + 0.2 * r() : r() < 0.5 ? 0.8 : 1.25;
    let v = Math.min(s.max, Math.max(s.min, out[k] * f));
    if (s.integer) v = Math.round(v);
    out[k] = v;
  }
  return out;
}

/** Simulated binary-contract bet (tournament grading): one entry when the network's probability beats
 *  the market mid by `edge`, quarter-Kelly sized net of the fee, capped; returns a fraction of capital. */
export function binaryBet(p: number, mid: number, y: 0 | 1, o: { edge?: number; shrink?: number; cap?: number; fee?: number } = {}): { ret: number; cost: number } | undefined {
  const edge = o.edge ?? 0.03, shrink = o.shrink ?? 0.25, cap = o.cap ?? 0.1, fee = o.fee ?? 0.02;
  if (!Number.isFinite(p) || !Number.isFinite(mid) || mid <= 0.01 || mid >= 0.99) return undefined;
  const yes = p - mid >= edge, no = mid - p >= edge;
  if (!yes && !no) return undefined;
  const c = yes ? mid : 1 - mid, q = yes ? p : 1 - p, win = yes ? y === 1 : y === 0;
  const kelly = (q - c - fee) / (1 - c - fee);
  if (!(kelly > 0)) return undefined;
  const f = Math.min(cap, shrink * kelly);
  return { ret: (f * ((win ? 1 : 0) - c - fee)) / (c + fee), cost: (f * fee) / (c + fee) };
}
