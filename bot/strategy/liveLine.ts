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
// x comes from the contract's own wiggles (the owner, Oct 24: "look back from the moment of the contract start to gain
// the range of volatile wiggles with which it will use for its x for 2 seconds amount over its normal wiggles ...
// almost like bollinger bands for the highs and lows of the wiggles"):
//   - a wiggle is the line minus the projection made look-ahead seconds ago for that second; the band is the wiggles'
//     mean +- k standard deviations (Bollinger's k = 2) over every second since the contract opened (at most its 15 or
//     60 minute window), the second being tested left out, once the window has bandMinSec seconds of them;
//   - the band's sd never drops below a tenth of the line's noise over the look-ahead (a frozen feed would make it 0).
// A held position reads the line in its side's terms (up = the side gains: YES on an up or above contract, NO on it ...):
//   - the break, the sell signal: the line outside the band against the side (under it for a side that gains as the
//     coin rises, over it for one that gains as it falls) for confirmSec seconds running;
//   - the heads-up: the line still rising for the side, its momentum down to half its best since the rise began, with
//     the projected top (where the momentum carries it before it decays). Nothing is sold on the heads-up: a predicted
//     top is touched by ordinary noise (the resting sell at the projected peak lost $113 against holding on Oct 23).
// A 2 sd band is touched by ordinary wiggles a few percent of the time (a normal curve is outside +-2 sd 4.6% of it).
// The engine adds what the contract needs: the sale clears the take-profit floor, and nothing in the last minutes.

export interface LiveLineParams {
  /** Look-ahead for 15-minute contracts (seconds); hourly contracts look three times as far. */
  aheadSec: number;
  /** k: the band's half-width in standard deviations of the wiggles since the contract opened. */
  bandK: number;
  /** Seconds of wiggles the band needs since the contract opened before it is used. */
  bandMinSec: number;
  /** Seconds the break must last. */
  confirmSec: number;
}

export const DEFAULT_LIVE_LINE: LiveLineParams = { aheadSec: 15, bandK: 2, bandMinSec: 60, confirmSec: 2 };

const KAPPA_15M = 0.05;
const KAPPA_1H = 0.02;
const MAX_GAP_SEC = 60;
/** Wiggles kept per filter: an hourly contract's whole window and some. */
const HISTORY_SEC = 3900;
/** The band's sd floor, as a share of the line's noise over the look-ahead (sigma x sqrt(h)). */
const SD_FLOOR = 0.1;
/** The longest break counted back (seconds). */
const MAX_RUN = 60;

/** The band for one second: the mean and sd of the wiggles before it in the window, and how many there were. */
interface Band { mean: number; sd: number; n: number }

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
  /** The wiggles a second at a time (the line minus its matured projection, log price), each second's sd floor, and
   *  running sums of the wiggles and their squares (s1[i] = wiggles 0..i) for the band. */
  private readonly secs: number[] = [];
  private readonly wig: number[] = [];
  private readonly floor: number[] = [];
  private readonly s1: number[] = [];
  private readonly s2: number[] = [];

  constructor(private readonly kappa: number, private readonly aheadSec: number) {}

  update(nowSec: number, y: number, sigma: number): void {
    const R = (0.5 * sigma) ** 2, qx = (0.5 * sigma) ** 2, qv = (0.05 * sigma) ** 2, k = this.kappa;
    if (this.last === undefined || nowSec - this.last > MAX_GAP_SEC) {
      this.x = y; this.v = 0;
      this.p00 = R; this.p01 = 0; this.p10 = 0; this.p11 = (0.5 * sigma) ** 2;
      this.pending.length = 0; this.matured = undefined; this.bestUp = 0; this.bestDown = 0;
      this.secs.length = 0; this.wig.length = 0; this.floor.length = 0; this.s1.length = 0; this.s2.length = 0;
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
    if (this.matured === undefined) return;
    const w = y - this.matured, n = this.secs.length;
    this.secs.push(nowSec); this.wig.push(w); this.floor.push(SD_FLOOR * sigma * Math.sqrt(this.aheadSec));
    this.s1.push((n ? this.s1[n - 1] : 0) + w); this.s2.push((n ? this.s2[n - 1] : 0) + w * w);
    if (this.secs.length > HISTORY_SEC + 600) {
      // Drop the oldest 600 seconds and restart the running sums from there (they stay small).
      const b1 = this.s1[599], b2 = this.s2[599];
      for (const a of [this.secs, this.wig, this.floor, this.s1, this.s2]) a.splice(0, 600);
      for (let i = 0; i < this.s1.length; i++) { this.s1[i] -= b1; this.s2[i] -= b2; }
    }
  }

  /** The band for the wiggle at index j: the wiggles from index i0 (the window's first second) up to j - 1. */
  private bandAt(j: number, i0: number, minN: number): Band | undefined {
    const n = j - i0;
    if (n < minN || n < 2) return undefined;
    const sum = this.s1[j - 1] - (i0 > 0 ? this.s1[i0 - 1] : 0);
    const sq = this.s2[j - 1] - (i0 > 0 ? this.s2[i0 - 1] : 0);
    const mean = sum / n;
    return { mean, sd: Math.max(Math.sqrt(Math.max(0, (sq - n * mean * mean) / (n - 1))), this.floor[j]), n };
  }

  /** The band since `startSec` for the latest second, where the line is in it for a side (+ = past the band's middle
   *  against the side, in sd), and how many seconds running it has been outside the band against the side. */
  band(startSec: number, orient: 1 | -1, k: number, minN: number): (Band & { against: number; run: number }) | undefined {
    const last = this.secs.length - 1;
    if (last < 0) return undefined;
    let lo = 0, hi = last + 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.secs[mid] < startSec) lo = mid + 1; else hi = mid; }
    const now = this.bandAt(last, lo, minN);
    if (!now) return undefined;
    let run = 0;
    for (let j = last; j > lo && run < MAX_RUN; j--) {
      if (j < last && this.secs[j + 1] - this.secs[j] !== 1) break;
      const b = j === last ? now : this.bandAt(j, lo, minN);
      if (!b || (orient * (b.mean - this.wig[j])) / b.sd < k) break;
      run++;
    }
    return { ...now, against: (orient * (now.mean - this.wig[last])) / now.sd, run };
  }

  get level(): number { return this.x; }
  get velocity(): number { return this.v; }
  /** Where the current momentum carries the line before it decays (log price). */
  get top(): number { return this.x + this.v / this.kappa; }
}

/** A position's reading of its coin's line, in its side's terms. */
export interface LiveLineReading {
  /** The line now and the projection made look-ahead seconds ago for now (coin prices). */
  price: number;
  projected?: number;
  /** The wiggle band for now (coin prices): the projection plus the wiggles' mean -+ k sd since the contract opened,
   *  over `sec` seconds of wiggles. Missing while the window has too few. */
  band?: { lower: number; upper: number; k: number; sec: number };
  /** Where the line is in the band, in the wiggles' sd from its middle (+ = toward the side's losing edge). */
  underSd?: number;
  /** The line's slope for the side, in noise units a second (+ = moving the side's way). */
  slope: number;
  /** Seconds the line has been outside the band against the side (0 = inside it). */
  breakSec: number;
  /** The sell signal: outside the band against the side for confirmSec seconds. */
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
      c = { f15: new LineFilter(KAPPA_15M, this.p.aheadSec), f1h: new LineFilter(KAPPA_1H, 3 * this.p.aheadSec), price, sigma: sigmaPerSec, sec: 0 };
      this.coins.set(asset, c);
    }
    if (sec <= c.sec) return;
    const y = Math.log(price);
    c.f15.update(sec, y, sigmaPerSec);
    c.f1h.update(sec, y, sigmaPerSec);
    c.price = price; c.sigma = sigmaPerSec; c.sec = sec;
  }

  /** The line for a held position: `orient` +1 when the side gains as the coin rises, -1 when it gains as it falls;
   *  `sinceMs`, when the contract's window opened (the band's wiggles start there; default the last 15 or 60 minutes). */
  read(asset: string, orient: 1 | -1, hourly: boolean, nowMs: number, sinceMs?: number): LiveLineReading | undefined {
    const c = this.coins.get(asset);
    if (!c || Math.floor(nowMs / 1000) - c.sec > 5) return undefined;
    const f = hourly ? c.f1h : c.f15;
    const startSec = sinceMs === undefined ? c.sec - (hourly ? 3600 : 900) : Math.floor(sinceMs / 1000);
    // The break is counted on the line's own seconds, so it does not depend on how often a position reads it.
    const b = f.band(startSec, orient, this.p.bandK, this.p.bandMinSec);
    const v = orient * f.velocity;
    const best = orient > 0 ? f.bestUp : -f.bestDown;
    const fading = v > 0 && best > 0 && v <= 0.5 * best;
    const k = this.p.bandK;
    return {
      price: c.price,
      projected: f.matured === undefined ? undefined : +Math.exp(f.matured).toPrecision(10),
      ...(b && f.matured !== undefined ? {
        band: { lower: +Math.exp(f.matured + b.mean - k * b.sd).toPrecision(10), upper: +Math.exp(f.matured + b.mean + k * b.sd).toPrecision(10), k, sec: b.n },
        underSd: +b.against.toFixed(2),
      } : {}),
      slope: +(v / c.sigma).toFixed(3),
      breakSec: b?.run ?? 0,
      broke: (b?.run ?? 0) >= this.p.confirmSec,
      ...(fading ? { peak: { top: +Math.exp(f.top).toPrecision(10) } } : {}),
    };
  }
}
