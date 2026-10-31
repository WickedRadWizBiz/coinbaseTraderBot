// Market state: one reading per coin, minute by minute, of what the market is doing now, shared by every module that
// adapts to it (phase 1 of the dynamic-scaling plan, Oct 28). The engine and the backtester feed it the same way from
// the same inputs (the settlement index and each Kalshi market's book and trades at every evaluation), so a replay
// reads exactly what the live bot read.
//
//   volatility   realized volatility of 1-minute index returns over 15 minutes, 1 hour and 6 hours (per sqrt second,
//                the pricer's unit), and their ratio: > 1 = volatility rising (HAR-style horizons: Corsi, 2009)
//   jump         the largest 1-minute move in the last 15 minutes, in 1-hour sigmas
//   change       the probability that the return process changed within the last 5 minutes: Bayesian online
//                change-point detection (Adams & MacKay, 2007) on 1-minute returns, normal model with unknown variance
//   liquidity    the median Kalshi spread and top-of-book depth over the coin's markets in the last 5 minutes
//   flow         taker order-flow imbalance on Kalshi over 5 minutes: (yes-taker - no-taker) / all, in [-1, 1] (an
//                order-flow toxicity reading in the spirit of VPIN: Easley, Lopez de Prado & O'Hara, 2012)
//   correlation  mean correlation of the coin's 1-minute returns with the other coins' over the last hour
//
// Nothing here trades. Readings are undefined until there is enough data (no reading is invented).

import type { IndexTracker } from './indexTracker';

const MIN = 60_000;
const KEEP_MIN = 360;

export interface MarketStateReading {
  asset: string;
  /** Minute the reading was taken at (ms, start of the minute). */
  minute: number;
  rv15m: number | null;
  rv1h: number | null;
  rv6h: number | null;
  /** rv15m / rv1h: > 1 volatility rising, < 1 calming. */
  volRatio: number | null;
  /** Largest |1-minute return| of the last 15 minutes, in 1-hour sigmas of a minute. */
  jump: number | null;
  /** P(change point within the last 5 minutes). */
  changeProb: number | null;
  /** Median Kalshi spread (dollars) and top-of-book depth (contracts, both sides) over the last 5 minutes. */
  spread: number | null;
  depth: number | null;
  /** Kalshi taker imbalance over 5 minutes, [-1, 1], and the contracts it is on. */
  flowImbalance: number | null;
  flowContracts: number;
  /** Mean 1-hour correlation of 1-minute returns with the other coins. */
  correlation: number | null;
}

interface Bar { minute: number; close: number }
interface Micro { ts: number; spread: number; depth: number }
interface Flow { ts: number; signed: number; count: number }

/** Bayesian online change-point detection, normal-inverse-gamma prior on (mean, variance), constant hazard. */
export class ChangePoint {
  private r: number[] = [1];
  private mu: number[];
  private kappa: number[];
  private alpha: number[];
  private beta: number[];

  constructor(private readonly hazard = 1 / 120, private readonly maxRun = KEEP_MIN, private readonly prior = { mu: 0, kappa: 1, alpha: 1, beta: 1 }) {
    this.mu = [prior.mu]; this.kappa = [prior.kappa]; this.alpha = [prior.alpha]; this.beta = [prior.beta];
  }

  /** Add one observation (scaled to about unit variance by the caller); returns P(run length < `recent`). */
  update(x: number, recent = 5): number {
    const n = this.r.length;
    const pred = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      // Student-t predictive with 2 alpha degrees of freedom.
      const nu = 2 * this.alpha[i], scale2 = (this.beta[i] * (this.kappa[i] + 1)) / (this.alpha[i] * this.kappa[i]);
      const z = (x - this.mu[i]) ** 2 / (nu * scale2);
      pred[i] = Math.exp(lgamma((nu + 1) / 2) - lgamma(nu / 2) - 0.5 * Math.log(nu * Math.PI * scale2) - ((nu + 1) / 2) * Math.log1p(z));
    }
    const grow = new Array<number>(Math.min(n + 1, this.maxRun));
    let cp = 0;
    for (let i = 0; i < n; i++) {
      const w = this.r[i] * pred[i];
      cp += w * this.hazard;
      if (i + 1 < grow.length) grow[i + 1] = w * (1 - this.hazard);
    }
    grow[0] = cp;
    let s = 0;
    for (let i = 0; i < grow.length; i++) s += grow[i] ?? 0;
    if (!(s > 0)) { this.reset(); return 1; }
    const r = grow.map((v) => (v ?? 0) / s);
    // Posterior parameters: run length 0 starts from the prior; run length i + 1 extends run length i with x.
    const mu = [this.prior.mu], kappa = [this.prior.kappa], alpha = [this.prior.alpha], beta = [this.prior.beta];
    for (let i = 0; i + 1 < r.length; i++) {
      kappa.push(this.kappa[i] + 1);
      mu.push((this.kappa[i] * this.mu[i] + x) / (this.kappa[i] + 1));
      alpha.push(this.alpha[i] + 0.5);
      beta.push(this.beta[i] + (this.kappa[i] * (x - this.mu[i]) ** 2) / (2 * (this.kappa[i] + 1)));
    }
    this.r = r; this.mu = mu; this.kappa = kappa; this.alpha = alpha; this.beta = beta;
    let p = 0;
    for (let i = 0; i < Math.min(recent, r.length); i++) p += r[i];
    return p;
  }

  private reset(): void {
    this.r = [1]; this.mu = [this.prior.mu]; this.kappa = [this.prior.kappa]; this.alpha = [this.prior.alpha]; this.beta = [this.prior.beta];
  }
}

function lgamma(x: number): number {
  // Lanczos approximation (g = 7), accurate to ~1e-15 for x > 0.
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function rv(rets: number[]): number | null {
  if (rets.length < 5) return null;
  let ss = 0;
  for (const r of rets) ss += r * r;
  return Math.sqrt(ss / rets.length / 60);
}

function corr(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 20) return null;
  const x = a.slice(-n), y = b.slice(-n);
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

export class MarketState {
  private readonly bars = new Map<string, Bar[]>();
  private readonly cps = new Map<string, { cp: ChangePoint; p: number | null }>();
  private readonly micro = new Map<string, Micro[]>();
  private readonly flows = new Map<string, Flow[]>();
  private readonly seenTrades = new Map<string, { ts: number; n: number }>();
  private readonly cache = new Map<string, MarketStateReading>();

  /** The coin's index, sampled once a minute (the last print of each finished minute). Cheap to call every evaluation. */
  observeIndex(asset: string, idx: IndexTracker, now: number): void {
    const p = idx.latest();
    if (!p) return;
    const minute = Math.floor(now / MIN) * MIN;
    const bars = this.bars.get(asset) ?? [];
    const last = bars[bars.length - 1];
    if (last && last.minute >= minute) { last.close = p.value; return; }
    // A new minute: the previous bar is final, so its return feeds the change-point model.
    if (last && bars.length >= 2) this.feedChange(asset, bars);
    bars.push({ minute, close: p.value });
    while (bars.length > KEEP_MIN + 1) bars.shift();
    this.bars.set(asset, bars);
    this.cache.delete(asset);
  }

  /** One Kalshi market of the coin at an evaluation: its spread and top-of-book depth. */
  observeBook(asset: string, spread: number, depth: number, now: number): void {
    if (!(spread >= 0) || !(depth >= 0)) return;
    const xs = this.micro.get(asset) ?? [];
    // One sample a second a coin is plenty for a 5-minute median, and keeps the median cheap at every evaluation.
    if (xs.length && now - xs[xs.length - 1].ts < 1000) return;
    xs.push({ ts: now, spread, depth });
    while (xs.length && xs[0].ts < now - 5 * MIN) xs.shift();
    this.micro.set(asset, xs);
  }

  /** Kalshi trades of a coin's market, given as the market's recent trades (each trade counted once, in time order). */
  observeTrades(asset: string, ticker: string, trades: Array<{ ts: number; signed: number; count: number }>, now: number): void {
    // Trades at the newest time already taken are skipped by how many were taken there (several can share a millisecond).
    const seen = this.seenTrades.get(ticker) ?? { ts: 0, n: 0 };
    const xs = this.flows.get(asset) ?? [];
    let ts = seen.ts, n = seen.n, atSeen = 0;
    for (const t of trades) {
      if (t.ts < seen.ts) continue;
      if (t.ts === seen.ts && atSeen++ < seen.n) continue;
      xs.push({ ts: t.ts, signed: t.signed, count: t.count });
      if (t.ts > ts) { ts = t.ts; n = 1; } else if (t.ts === ts) n++;
    }
    this.seenTrades.set(ticker, { ts, n });
    while (xs.length && xs[0].ts < now - 5 * MIN) xs.shift();
    this.flows.set(asset, xs);
  }

  forgetMarket(ticker: string): void { this.seenTrades.delete(ticker); }

  private returns(asset: string, n: number): number[] {
    const bars = this.bars.get(asset) ?? [];
    // Finished minutes only: the last bar is still forming.
    const done = bars.slice(0, -1).slice(-(n + 1));
    const out: number[] = [];
    for (let i = 1; i < done.length; i++) if (done[i].minute - done[i - 1].minute === MIN) out.push(Math.log(done[i].close / done[i - 1].close));
    return out;
  }

  private feedChange(asset: string, bars: Bar[]): void {
    const a = bars[bars.length - 2], b = bars[bars.length - 1];
    if (b.minute - a.minute !== MIN) return;
    const r = Math.log(b.close / a.close);
    const scale = rv(this.returns(asset, 60));
    const c = this.cps.get(asset) ?? { cp: new ChangePoint(), p: null };
    if (scale && scale > 0) c.p = c.cp.update(r / (scale * Math.sqrt(60)));
    this.cps.set(asset, c);
  }

  reading(asset: string, now: number): MarketStateReading {
    const minute = Math.floor(now / MIN) * MIN;
    const hit = this.cache.get(asset);
    const micro = this.micro.get(asset) ?? [], flow = this.flows.get(asset) ?? [];
    const liq = { spread: median(micro.filter((m) => m.ts >= now - 5 * MIN).map((m) => m.spread)), depth: median(micro.filter((m) => m.ts >= now - 5 * MIN).map((m) => m.depth)) };
    const f = flow.filter((x) => x.ts >= now - 5 * MIN);
    const tot = f.reduce((s, x) => s + x.count, 0), signed = f.reduce((s, x) => s + x.signed, 0);
    const live = { ...liq, flowImbalance: tot > 0 ? signed / tot : null, flowContracts: tot };
    if (hit && hit.minute === minute) return { ...hit, ...live };
    const r15 = this.returns(asset, 15), r60 = this.returns(asset, 60), r360 = this.returns(asset, 360);
    const rv15m = rv(r15), rv1h = rv(r60), rv6h = rv(r360);
    let c: number | null = null, k = 0, sum = 0;
    for (const other of this.bars.keys()) {
      if (other === asset) continue;
      const x = corr(r60, this.returns(other, 60));
      if (x !== null) { sum += x; k++; }
    }
    if (k) c = sum / k;
    const base: MarketStateReading = {
      asset, minute, rv15m, rv1h, rv6h,
      volRatio: rv15m !== null && rv1h ? rv15m / rv1h : null,
      jump: rv1h && r15.length ? Math.max(...r15.map(Math.abs)) / (rv1h * Math.sqrt(60)) : null,
      changeProb: this.cps.get(asset)?.p ?? null,
      correlation: c,
      ...live,
    };
    this.cache.set(asset, base);
    return base;
  }

  assets(): string[] { return [...this.bars.keys()]; }
}

/** What the engine and the backtester feed at each market evaluation: one call, so both read the same state. */
export function observeMarket(ms: MarketState, x: {
  asset: string; ticker: string; index: IndexTracker; now: number;
  bid?: { price: number; size: number }; ask?: { price: number; size: number };
  trades?: Array<{ ts: number; signed: number; count: number }>;
}): MarketStateReading {
  ms.observeIndex(x.asset, x.index, x.now);
  if (x.bid && x.ask) ms.observeBook(x.asset, x.ask.price - x.bid.price, x.bid.size + x.ask.size, x.now);
  if (x.trades) ms.observeTrades(x.asset, x.ticker, x.trades, x.now);
  return ms.reading(x.asset, x.now);
}

/** The reading rounded for the decision audit and the API. */
export function compactReading(r: MarketStateReading): Record<string, number | null> {
  const f = (v: number | null, d: number) => (v === null || !Number.isFinite(v) ? null : +v.toFixed(d));
  return { rv15m: f(r.rv15m, 7), rv1h: f(r.rv1h, 7), rv6h: f(r.rv6h, 7), volRatio: f(r.volRatio, 3), jump: f(r.jump, 2), changeProb: f(r.changeProb, 3), spread: f(r.spread, 4), depth: f(r.depth, 0), flow: f(r.flowImbalance, 3), flowN: r.flowContracts, corr: f(r.correlation, 3) };
}
