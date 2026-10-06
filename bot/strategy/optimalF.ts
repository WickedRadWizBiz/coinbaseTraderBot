// Optimal f (Vince) as a cap on Kelly-style sizing, from the trade history a strategy actually produced.
//
// A trade's R multiple is its net result in units of the amount risked (a stop-out is about -1R). Risking
// a fraction g of equity per R, equity grows by (1 + g r) per trade, and the growth-optimal g maximises
//
//   G(g) = sum_i w_i log(1 + g r_i)            0 <= g < 1 / |worst r|
//
// (Vince's optimal f is the same optimum expressed per biggest loss: f* = g* x |worst r|). G is concave,
// so g* is where its derivative crosses zero (bisection); g* = 0 when the weighted mean R is not positive.
//
// One history gives one g*, and it is noisy: a moving-block bootstrap (blocks keep streaks and regimes
// together) gives its distribution, and the cap is a low quantile of it (the 25th percentile by default):
// what the edge supports even in a weaker resampling of the same trades. Full g* is the growth-maximising
// bet and is known to bring deep drawdowns, so the cap only ever limits the Kelly size (min, never
// max), and never raises a size the strategy already chose.
//
// The same bootstrap gives the distribution of the worst run of losses in R (the max drawdown of the
// cumulative R over a horizon of trades): a live drawdown beyond its 95th percentile is outside what the
// history says is normal, and the size is halved until it recovers (see drawdownScale).
//
// Weights: trades carry a weight (recency decay, and live trades count more than backtested ones), so
// the cap follows the strategy as it is now while still standing on the long history.

export interface WeightedTrade { r: number; ts: number; w?: number }

export interface OptimalFReport {
  n: number;
  /** Effective sample size of the weights. */
  nEff: number;
  meanR: number;
  winRate: number;
  worstR: number;
  /** Growth-optimal risk fraction per R on the full history, and Vince's f* (= g* x |worst R|). */
  gStar: number;
  fStar: number;
  /** Bootstrap quantiles of g*. */
  gP25: number; gP50: number; gP75: number;
  /** The cap: risk per trade (fraction of equity at -1R) never above this. 0 = the history does not
   *  support risking anything. */
  cap: number;
  /** Bootstrap 95th percentile of the max drawdown of cumulative R over `horizon` trades (R units). */
  ddP95R: number;
  horizon: number;
  /** Shown when the history is too short for a cap (n < minTrades): no cap is applied. */
  note?: string;
}

export interface OptimalFOptions {
  quantile?: number;
  iters?: number;
  block?: number;
  minTrades?: number;
  /** Trades per drawdown path (default: the history's length, at most 250). */
  horizon?: number;
  seed?: number;
}

const DEFAULTS = { quantile: 0.25, iters: 400, minTrades: 50, seed: 11 };

/** Growth-optimal g for weighted R multiples (0 when the weighted mean is not positive). */
export function growthOptimalG(rs: ArrayLike<number>, ws?: ArrayLike<number>): number {
  const n = rs.length;
  if (!n) return 0;
  let worst = 0, mean = 0, W = 0;
  for (let i = 0; i < n; i++) { const w = ws ? ws[i] : 1; worst = Math.min(worst, rs[i]); mean += w * rs[i]; W += w; }
  if (!(W > 0) || !(mean / W > 0)) return 0;
  const gMax = worst < 0 ? 1 / -worst : 1;
  const d = (g: number) => { let s = 0; for (let i = 0; i < n; i++) s += (ws ? ws[i] : 1) * rs[i] / (1 + g * rs[i]); return s; };
  let lo = 0, hi = gMax * (1 - 1e-9);
  if (d(hi) > 0) return hi; // never a loss big enough to stop it: bounded by the worst loss
  for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; if (d(m) > 0) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

/** Max drawdown of the cumulative sum (R units). */
export function maxDrawdownR(rs: ArrayLike<number>): number {
  let s = 0, pk = 0, dd = 0;
  for (let i = 0; i < rs.length; i++) { s += rs[i]; if (s > pk) pk = s; if (pk - s > dd) dd = pk - s; }
  return dd;
}

function lcg(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1) + 1e-9)))] : NaN; };

/** Optimal f with its bootstrap distribution and the drawdown band, from a time-ordered trade history. */
export function optimalF(trades: WeightedTrade[], o: OptimalFOptions = {}): OptimalFReport {
  const q = o.quantile ?? DEFAULTS.quantile, iters = o.iters ?? DEFAULTS.iters, minTrades = o.minTrades ?? DEFAULTS.minTrades;
  const sorted = trades.filter((t) => Number.isFinite(t.r) && Number.isFinite(t.ts) && (t.w ?? 1) > 0).sort((a, b) => a.ts - b.ts);
  const n = sorted.length;
  const rs = Float64Array.from(sorted, (t) => t.r), ws = Float64Array.from(sorted, (t) => t.w ?? 1);
  const W = ws.reduce((a, b) => a + b, 0), W2 = ws.reduce((a, b) => a + b * b, 0);
  const meanR = W > 0 ? rs.reduce((a, r, i) => a + ws[i] * r, 0) / W : NaN;
  const winRate = W > 0 ? rs.reduce((a, r, i) => a + (r > 0 ? ws[i] : 0), 0) / W : NaN;
  const worstR = n ? Math.min(...rs) : NaN;
  const gStar = growthOptimalG(rs, ws);
  const horizon = Math.max(1, Math.min(o.horizon ?? Math.min(250, n), 10_000));
  const base = { n, nEff: W2 > 0 ? (W * W) / W2 : 0, meanR, winRate, worstR, gStar, fStar: gStar * Math.abs(Math.min(0, worstR || 0)), horizon };
  if (n < minTrades) return { ...base, gP25: NaN, gP50: NaN, gP75: NaN, cap: Infinity, ddP95R: NaN, note: `${n} trades (need ${minTrades}): no cap` };
  // Moving-block bootstrap: blocks of ~sqrt(n) consecutive trades, a block's start drawn in proportion to
  // the weight of its first trade (recent / live trades are drawn more often).
  const b = Math.max(1, Math.min(n, o.block ?? Math.round(Math.sqrt(n))));
  const starts = n - b + 1;
  const cum = new Float64Array(starts);
  for (let i = 0, s = 0; i < starts; i++) { s += ws[i]; cum[i] = s; }
  const pick = (u: number) => { const x = u * cum[starts - 1]; let lo = 0, hi = starts - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < x) lo = m + 1; else hi = m; } return lo; };
  const rnd = lcg(o.seed ?? DEFAULTS.seed);
  const gs: number[] = [], dds: number[] = [];
  const sample = new Float64Array(n), path = new Float64Array(horizon);
  for (let it = 0; it < iters; it++) {
    for (let k = 0; k < n;) { const s = pick(rnd()); for (let j = 0; j < b && k < n; j++, k++) sample[k] = rs[s + j]; }
    gs.push(growthOptimalG(sample));
    for (let k = 0; k < horizon;) { const s = pick(rnd()); for (let j = 0; j < b && k < horizon; j++, k++) path[k] = rs[s + j]; }
    dds.push(maxDrawdownR(path));
  }
  const gP25 = quantile(gs, 0.25), gP50 = quantile(gs, 0.5), gP75 = quantile(gs, 0.75);
  return { ...base, gP25, gP50, gP75, cap: Math.max(0, quantile(gs, q)), ddP95R: quantile(dds, 0.95) };
}

/** Recency weights: half-life in days, times `liveMult` for live trades. */
export function recencyWeight(ts: number, now: number, halfLifeDays: number, liveMult = 1): number {
  const age = Math.max(0, now - ts) / 86_400_000;
  return liveMult * Math.pow(0.5, age / Math.max(1e-6, halfLifeDays));
}

/** Size multiplier from the live drawdown in R against the history's 95th percentile: 1 inside the band,
 *  0.5 beyond it (held until the drawdown is back under half the band). */
export function drawdownScale(liveDdR: number, ddP95R: number, wasCut: boolean): { scale: number; cut: boolean } {
  if (!(ddP95R > 0) || !Number.isFinite(liveDdR)) return { scale: 1, cut: false };
  const cut = wasCut ? liveDdR > 0.5 * ddP95R : liveDdR > ddP95R;
  return { scale: cut ? 0.5 : 1, cut };
}

/** Cap a risk fraction (equity lost at -1R) by the report: min(Kelly-style risk, cap). */
export function capRisk(risk: number, rep: Pick<OptimalFReport, 'cap'> | undefined): number {
  if (!rep || !Number.isFinite(rep.cap)) return risk;
  return Math.min(risk, rep.cap);
}

/** Kalshi entries (the engine's trades.jsonl rows) -> one trade per settled market: the stake is what the
 *  contracts cost plus Kalshi's taker fee (0.07 x c x (1 - c) per contract, conservative for makers), the
 *  payout $1 per winning contract, R = (payout - stake) / stake (-1 = the whole stake lost). */
export function binaryTrades(rows: Array<{ ts: number; ticker: string; cost: number; count: number; won: boolean; book?: string }>, book?: string): WeightedTrade[] {
  const by = new Map<string, { ts: number; stake: number; payout: number }>();
  for (const x of rows) {
    if (book && x.book !== book) continue;
    if (!(x.cost > 0 && x.cost < 1) || !(x.count > 0) || !Number.isFinite(x.ts)) continue;
    const t = by.get(x.ticker) ?? { ts: 0, stake: 0, payout: 0 };
    t.ts = Math.max(t.ts, x.ts);
    t.stake += x.count * (x.cost + 0.07 * x.cost * (1 - x.cost));
    t.payout += x.won ? x.count : 0;
    by.set(x.ticker, t);
  }
  return [...by.values()].filter((t) => t.stake > 0).map((t) => ({ ts: t.ts, r: (t.payout - t.stake) / t.stake })).sort((a, b) => a.ts - b.ts);
}
