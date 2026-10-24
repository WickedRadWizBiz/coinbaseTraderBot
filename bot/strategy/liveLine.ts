// The live-line curve for 15-minute and hourly crypto contracts (the owner, Oct 23: "the curve we're generating is meant
// to attempt to predict the live window of 15 minute and 1 hour crypto price prediction contracts ... give a heads up on
// a peak or a bottom. And then if the actual line from Kalshi crosses it by more than x amount then that would trigger a
// sell signal").
//
// The live line is the coin's settlement index (CF Benchmarks' real-time index on Kalshi's feed): the line the Kalshi
// app draws against the contract's target, one point a second. A contract's price is that line's distance to the target
// over the volatility left, plus the order book's noise (1-cent ticks, the spread, quotes coming and going), so the
// curve follows the line itself. One curve per coin, shared by every contract on it:
//   - the filter of the book curve (bot/strategy/sinuousExit.ts): a Kalman filter on the line's level and velocity,
//     the velocity decaying as e^(-kappa t) (kappa 0.05 a second for 15-minute contracts, 0.02 for hourly), on log price;
//   - its noise scaled to the coin's per-second volatility, so one setting fits every coin and every hour: observation
//     noise (0.5 sigma)^2, level noise (0.5 sigma)^2 and velocity noise (0.05 sigma)^2 a second;
//   - projections look-ahead seconds on (aheadSec for 15-minute contracts, three times that for hourly ones).
// A held position reads the line in its side's terms (up = the side gains: YES on an up or above contract, NO on it ...):
//   - the break, the sell signal: the line is below the projection made look-ahead seconds ago by at least x, x =
//     xSigmas of the line's noise over the look-ahead (xSigmas x sigma x sqrt(h)), for confirmSec seconds running;
//   - the heads-up: the line still rising for the side, its momentum down to half its best since the rise began, with
//     the projected top (where the momentum carries it before it decays). Nothing is sold on the heads-up: a predicted
//     top is touched by ordinary noise (the resting sell at the projected peak lost $113 against holding on Oct 23).
// The engine adds what the contract needs: the sale clears the take-profit floor, and nothing in the last minutes.

export interface LiveLineParams {
  /** Look-ahead for 15-minute contracts (seconds); hourly contracts look three times as far. */
  aheadSec: number;
  /** x: how far under the projection the line must be, in its noise over the look-ahead. */
  xSigmas: number;
  /** Seconds the break must last. */
  confirmSec: number;
}

export const DEFAULT_LIVE_LINE: LiveLineParams = { aheadSec: 15, xSigmas: 2, confirmSec: 2 };

const KAPPA_15M = 0.05;
const KAPPA_1H = 0.02;
const MAX_GAP_SEC = 60;

/** One coin's line through one filter (15-minute or hourly settings). */
class LineFilter {
  private x = 0; private v = 0;
  private p00 = 0; private p01 = 0; private p10 = 0; private p11 = 0;
  private last: number | undefined;
  private readonly pending: Array<{ due: number; x: number }> = [];
  /** The projection made look-ahead seconds ago, for now. */
  matured: number | undefined;
  /** The best velocity since the line began rising, each way (+ rising, - falling). */
  bestUp = 0; bestDown = 0;
  /** Seconds in a row the line has been under its projection by x (bad for a side that gains as the coin rises), and
   *  over it by x (bad for a side that gains as it falls). */
  runUnder = 0; runOver = 0;
  /** The line's distance from the projection for now, in its noise over the look-ahead (+ = under). */
  under: number | undefined;

  constructor(private readonly kappa: number, private readonly aheadSec: number, private readonly xSigmas: number) {}

  update(nowSec: number, y: number, sigma: number): void {
    const R = (0.5 * sigma) ** 2, qx = (0.5 * sigma) ** 2, qv = (0.05 * sigma) ** 2, k = this.kappa;
    if (this.last === undefined || nowSec - this.last > MAX_GAP_SEC) {
      this.x = y; this.v = 0;
      this.p00 = R; this.p01 = 0; this.p10 = 0; this.p11 = (0.5 * sigma) ** 2;
      this.pending.length = 0; this.matured = undefined; this.bestUp = 0; this.bestDown = 0; this.runUnder = 0; this.runOver = 0;
    } else if (nowSec > this.last) {
      const dt = nowSec - this.last, d = Math.exp(-k * dt);
      const xp = this.x + dt * this.v, vp = d * this.v;
      const a00 = this.p00 + dt * (this.p10 + this.p01) + dt * dt * this.p11 + qx * dt;
      const a01 = d * (this.p01 + dt * this.p11);
      const a10 = d * (this.p10 + dt * this.p11);
      const a11 = d * d * this.p11 + qv * dt;
      const S = a00 + R, k0 = a00 / S, k1 = a10 / S, e = y - xp;
      this.x = xp + k0 * e; this.v = vp + k1 * e;
      this.p00 = (1 - k0) * a00; this.p01 = (1 - k0) * a01;
      this.p10 = a10 - k1 * a00; this.p11 = a11 - k1 * a01;
    } else return;
    this.last = nowSec;
    this.bestUp = this.v > 0 ? Math.max(this.bestUp, this.v) : 0;
    this.bestDown = this.v < 0 ? Math.min(this.bestDown, this.v) : 0;
    this.pending.push({ due: nowSec + this.aheadSec, x: this.x + (this.v * (1 - Math.exp(-k * this.aheadSec))) / k });
    while (this.pending.length && this.pending[0].due <= nowSec) this.matured = this.pending.shift()!.x;
    this.under = this.matured === undefined ? undefined : (this.matured - y) / (sigma * Math.sqrt(this.aheadSec));
    this.runUnder = this.under !== undefined && this.under >= this.xSigmas ? this.runUnder + 1 : 0;
    this.runOver = this.under !== undefined && -this.under >= this.xSigmas ? this.runOver + 1 : 0;
  }

  get level(): number { return this.x; }
  get velocity(): number { return this.v; }
  /** Where the current momentum carries the line before it decays (log price). */
  get top(): number { return this.x + this.v / this.kappa; }
}

/** A position's reading of its coin's line, in its side's terms. */
export interface LiveLineReading {
  /** The line now, the projection made look-ahead seconds ago for now, and how far under it the line is in noise units
   *  over the look-ahead (+ = under, against the side). Prices are the coin's. */
  price: number;
  projected?: number;
  underSigmas?: number;
  /** The line's slope for the side, in noise units a second (+ = moving the side's way). */
  slope: number;
  /** Seconds the break has lasted (0 = no break). */
  breakSec: number;
  /** The sell signal: under the projection by at least x for confirmSec seconds. */
  broke: boolean;
  /** The heads-up: still moving the side's way, momentum down to half its best; the projected top (coin price). */
  peak?: { top: number };
}

/** The live line of every coin (two filters each: 15-minute and hourly settings). */
export class LiveLines {
  private readonly coins = new Map<string, { f15: LineFilter; f1h: LineFilter; price: number; sigma: number; sec: number }>();

  constructor(readonly p: LiveLineParams = DEFAULT_LIVE_LINE) {}

  /** One point of a coin's line (called every engine tick; one update a second is kept). */
  observe(asset: string, nowMs: number, price: number, sigmaPerSec: number): void {
    if (!(price > 0) || !(sigmaPerSec > 0)) return;
    const sec = Math.floor(nowMs / 1000);
    let c = this.coins.get(asset);
    if (!c) {
      c = { f15: new LineFilter(KAPPA_15M, this.p.aheadSec, this.p.xSigmas), f1h: new LineFilter(KAPPA_1H, 3 * this.p.aheadSec, this.p.xSigmas), price, sigma: sigmaPerSec, sec: 0 };
      this.coins.set(asset, c);
    }
    if (sec <= c.sec) return;
    const y = Math.log(price);
    c.f15.update(sec, y, sigmaPerSec);
    c.f1h.update(sec, y, sigmaPerSec);
    c.price = price; c.sigma = sigmaPerSec; c.sec = sec;
  }

  /** The line for a held position: `orient` +1 when the side gains as the coin rises, -1 when it gains as it falls. */
  read(asset: string, orient: 1 | -1, hourly: boolean, nowMs: number): LiveLineReading | undefined {
    const c = this.coins.get(asset);
    if (!c || Math.floor(nowMs / 1000) - c.sec > 5) return undefined;
    const f = hourly ? c.f1h : c.f15;
    const under = f.under === undefined ? undefined : orient * f.under;
    // The break is the line's own (counted as it updates), so it does not depend on how often a position reads it.
    const n = orient > 0 ? f.runUnder : f.runOver;
    const v = orient * f.velocity;
    const best = orient > 0 ? f.bestUp : -f.bestDown;
    const fading = v > 0 && best > 0 && v <= 0.5 * best;
    return {
      price: c.price,
      projected: f.matured === undefined ? undefined : +Math.exp(f.matured).toPrecision(10),
      underSigmas: under === undefined ? undefined : +under.toFixed(2),
      slope: +(v / c.sigma).toFixed(3),
      breakSec: n,
      broke: n >= this.p.confirmSec,
      ...(fading ? { peak: { top: +Math.exp(f.top).toPrecision(10) } } : {}),
    };
  }
}
