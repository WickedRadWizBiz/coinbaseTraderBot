// Exit-in-profit curve ("sinuous line") for binary contracts: the second opinion a profit-taking exit needs.
//
// From the moment a position is open, its market's order book is followed as a smooth curve and projected a few
// seconds ahead. A profit-taking exit that the bot's own exit logic wants (the fair-value exit, a hunt's early profit
// take, a tennis take-profit) goes out only when the curve also says this is a good moment:
//   DEVIATION_SPIKE  the live micro-price jumped well above the curve: the latest observation's innovation z-score
//                    against the filter's prediction is at least z (a sweep in our favour, to sell into);
//   SINUOUS_CROSS    the curve rolled over: it is below where the projection made lookaheadSec ago said it would be
//                    now, and its velocity is at or below zero;
// and the exit clears the fees by at least minNetProfit a contract. Otherwise the profit exit waits for a later tick.
// Protective exits (stop losses, a broken trailing stop, a gap through the stop, cutting a loser, late-match salvage)
// and exits worth less than minNetProfit never wait. Resting take-profit quotes are not gated, only exits sent to
// cross the book.
//
// The curve, in the price of the side held (up is always profit):
//   1. micro-price = (bid size x ask + ask size x bid) / (bid size + ask size) from the top of the book (a YES ask is
//      1 - the best NO bid and carries that bid's size): the price the book's pressure points to;
//   2. logit x = ln(p / (1 - p)), p clamped to [0.5c, 99.5c]: bounded prices become unbounded and symmetric;
//   3. a Kalman filter on [x, v] (curve level and its velocity per second) whose velocity decays as e^(-kappa t)
//      (Ornstein-Uhlenbeck momentum): the curve without moving-average lag;
//   4. projection lookaheadSec ahead: x + v (1 - e^(-kappa h)) / kappa (the current momentum, decaying).
//
// Knobs. Baselines (look-ahead in seconds; the engine ticks every second):
//                 R (book noise)  kappa  z     look-ahead
//   crypto 15m    0.015           0.35   1.65  3
//   crypto 1h     0.030           0.15   2.10  6
//   tennis        0.065           0.08   1.80  2
// Shifted every tick by the market's state:
//   - spread: R x (1 + 0.25 x max(0, spread - 2c)^2), so a 6c spread is 5x the noise and a wide, flickering book does
//     not read as velocity;
//   - crypto, 60-180 s to close: z x 0.75 while the price is 35-65c (pin risk: take the profit sooner), kappa x 0.2
//     above 85c (the contract is locking toward settlement); last 60 s (the settlement average): z falls with the
//     time left toward 1.1 and kappa doubles;
//   - tennis with a live score: on a break point or in a tiebreak R x 0.5 (follow the jump) and z 1.6; otherwise
//     kappa 0.35 and z 1.4 (routine service games wiggle in a tight band).
//
// Scoreboard. Each profit exit the curve holds back is scored when the position finally exits: (exit price then -
// exit price when first held) x contracts, both net of the exit fee; a settlement counts at 1 or 0. Under the
// probation rules (bot/risk/probation.ts: a net loss beyond PROBATION_MAX_LOSS_USD, or after PROBATION_MIN_TRADES a
// negative net with t <= -PROBATION_T) the gate is benched and exits go out as before, until a reset.
//
// SINUOUS_EXIT=gate (default) holds profit exits for the curve; monitor computes and shows it without holding
// anything; off. SINUOUS_MIN_PROFIT_CENTS (default 1.5): the net profit a contract an exit must clear to count as a
// profit exit (smaller gains go out as before).

import type { BookLevel } from '../kalshi/types';
import type { ProbationParams } from '../risk/probation';
import { readJson, writeJsonAtomic } from '../util/persist';

export type CurveProfile = 'crypto_15m' | 'crypto_1h' | 'tennis';

export interface CurveKnobs { R: number; kappa: number; z: number }

export const CURVE_PROFILES: Record<CurveProfile, CurveKnobs & { lookaheadSec: number }> = {
  crypto_15m: { R: 0.015, kappa: 0.35, z: 1.65, lookaheadSec: 3 },
  crypto_1h: { R: 0.03, kappa: 0.15, z: 2.1, lookaheadSec: 6 },
  tennis: { R: 0.065, kappa: 0.08, z: 1.8, lookaheadSec: 2 },
};

/** Process noise per second on the curve level and its velocity (logit units). */
const Q_X = 1e-4, Q_V = 1e-3;
const P0 = 0.1;
/** Prices are clamped to [0.5c, 99.5c] before the logit. */
const EDGE = 0.005;
/** A longer gap between observations restarts the curve (the market paused, or the book was unusable). */
const MAX_GAP_SEC = 60;

export const logit = (p: number): number => { const c = Math.min(1 - EDGE, Math.max(EDGE, p)); return Math.log(c / (1 - c)); };
export const fromLogit = (x: number): number => 1 / (1 + Math.exp(-x));

/** Volume-weighted micro-price of YES from the top of the book (the mid without sizes, the one side present alone). */
export function microPrice(bid?: BookLevel, ask?: BookLevel): number | undefined {
  if (!bid && !ask) return undefined;
  if (!bid) return ask!.price;
  if (!ask) return bid.price;
  const w = bid.size + ask.size;
  return w > 0 ? (bid.size * ask.price + ask.size * bid.price) / w : (bid.price + ask.price) / 2;
}

/** The knobs for this tick: the profile's baseline shifted by the spread, the time to close and the tennis score. */
export function dynamicKnobs(profile: CurveProfile, s: { spread: number; sidePrice: number; tauSec?: number; highLeverage?: boolean }): CurveKnobs {
  const b = CURVE_PROFILES[profile];
  let R = b.R * (1 + 0.25 * Math.max(0, s.spread * 100 - 2) ** 2);
  let kappa = b.kappa, z = b.z;
  const cents = s.sidePrice * 100;
  if (profile === 'tennis') {
    if (s.highLeverage === true) { R *= 0.5; z = 1.6; } else if (s.highLeverage === false) { kappa = 0.35; z = 1.4; }
  } else if (s.tauSec !== undefined) {
    if (s.tauSec <= 60) { z = Math.max(1.1, b.z * Math.max(0.2, s.tauSec / 60)); kappa = b.kappa * 2; } else if (s.tauSec <= 180) {
      if (cents >= 35 && cents <= 65) z *= 0.75;
      else if (cents > 85) kappa *= 0.2;
    }
  }
  return { R, kappa, z };
}

/** Tennis: a break point (the receiver one point from the game) or a tiebreak; undefined without a usable score. */
export function tennisHighLeverage(s?: { gamesA: number; gamesB: number; pointsA: number; pointsB: number; serverA?: boolean }): boolean | undefined {
  if (!s) return undefined;
  if (s.gamesA === 6 && s.gamesB === 6) return true;
  if (s.serverA === undefined) return undefined;
  const srv = s.serverA ? s.pointsA : s.pointsB, rcv = s.serverA ? s.pointsB : s.pointsA;
  return rcv >= 3 && rcv > srv;
}

/** Net profit a contract of selling the held side at `sidePrice`, after the entry and exit fees. */
export function netProfitPerContract(sidePrice: number, entrySidePrice: number, entryFeePer: number, exitFeePer: number): number {
  return sidePrice - entrySidePrice - entryFeePer - exitFeePer;
}

export interface CurveObservation {
  now: number;
  /** +1 holding YES, -1 holding NO. */
  sign: 1 | -1;
  /** Top of the book in YES terms (the ask is 1 - the best NO bid, with that bid's size). */
  bid?: BookLevel;
  ask?: BookLevel;
  /** Average price paid for the held side, and the entry fees a contract. */
  entrySidePrice: number;
  entryFeePer: number;
  /** Fee a contract to sell the held side at its bid now. */
  exitFeePer: number;
  /** Crypto: seconds to close. */
  tauSec?: number;
  /** Tennis: break point or tiebreak (undefined without a live score). */
  highLeverage?: boolean;
  minNetProfit: number;
}

export type CurveReason = 'DEVIATION_SPIKE' | 'SINUOUS_CROSS' | 'HOLD' | 'WARMING_UP' | 'BELOW_PROFIT_FLOOR' | 'NO_BOOK';

export interface CurveReading {
  /** The curve says this is a good moment to take the profit. */
  signal: boolean;
  reason: CurveReason;
  /** Side-terms prices: micro-price now, the curve, and the projection made look-ahead seconds ago for now. */
  micro?: number;
  curve?: number;
  projected?: number;
  /** Curve velocity, logit per second. */
  velocity?: number;
  /** Innovation z-score of this observation. */
  z?: number;
  /** Net profit a contract at the side's bid now. */
  netProfit?: number;
  knobs?: CurveKnobs;
  ts: number;
}

/** One position's curve: create it when the position opens, feed it every tick, drop it when flat. */
export class SinuousExitTracker {
  private x = 0;
  private v = 0;
  private p00 = P0; private p01 = 0; private p10 = 0; private p11 = P0;
  private last: number | undefined;
  /** Projections waiting for their time, and the latest whose time has come. */
  private readonly pending: Array<{ due: number; x: number }> = [];
  private matured: number | undefined;

  constructor(readonly profile: CurveProfile) {}

  /** The curve's slope in the side's price terms, per second (positive = rising): undefined while it warms up (no
   *  projection has matured yet). */
  slope(): number | undefined {
    if (this.last === undefined || this.matured === undefined) return undefined;
    const p = fromLogit(this.x);
    return this.v * p * (1 - p);
  }

  private restart(obs: number, now: number): void {
    this.x = obs; this.v = 0;
    this.p00 = P0; this.p01 = 0; this.p10 = 0; this.p11 = P0;
    this.last = now;
    this.pending.length = 0;
    this.matured = undefined;
  }

  update(o: CurveObservation): CurveReading {
    const micro = microPrice(o.bid, o.ask);
    if (micro === undefined) return { signal: false, reason: 'NO_BOOK', ts: o.now };
    const side = o.sign > 0 ? micro : 1 - micro;
    const sideBid = o.sign > 0 ? o.bid?.price : o.ask ? 1 - o.ask.price : undefined;
    // A one-sided book is treated as a wide one.
    const spread = o.bid && o.ask ? Math.max(0, o.ask.price - o.bid.price) : 0.1;
    const knobs = dynamicKnobs(this.profile, { spread, sidePrice: side, tauSec: o.tauSec, highLeverage: o.highLeverage });
    const obs = logit(side);
    const netProfit = sideBid === undefined ? undefined : netProfitPerContract(sideBid, o.entrySidePrice, o.entryFeePer, o.exitFeePer);
    const gap = this.last === undefined ? Infinity : (o.now - this.last) / 1000;
    let z = 0;
    if (!(gap > 0 && gap <= MAX_GAP_SEC)) {
      if (this.last === undefined || gap > MAX_GAP_SEC) this.restart(obs, o.now);
    } else {
      // Predict with F = [[1, dt], [0, e^(-kappa dt)]] and process noise Q dt; update with H = [1, 0].
      const dt = gap, d = Math.exp(-knobs.kappa * dt);
      const xp = this.x + dt * this.v, vp = d * this.v;
      const a00 = this.p00 + dt * (this.p10 + this.p01) + dt * dt * this.p11 + Q_X * dt;
      const a01 = d * (this.p01 + dt * this.p11);
      const a10 = d * (this.p10 + dt * this.p11);
      const a11 = d * d * this.p11 + Q_V * dt;
      const y = obs - xp, S = a00 + knobs.R;
      const k0 = a00 / S, k1 = a10 / S;
      this.x = xp + k0 * y;
      this.v = vp + k1 * y;
      this.p00 = (1 - k0) * a00; this.p01 = (1 - k0) * a01;
      this.p10 = a10 - k1 * a00; this.p11 = a11 - k1 * a01;
      this.last = o.now;
      z = y / Math.sqrt(S);
    }
    // Project look-ahead seconds on, and bring due projections to maturity.
    const h = CURVE_PROFILES[this.profile].lookaheadSec;
    this.pending.push({ due: o.now + h * 1000, x: this.x + (this.v * (1 - Math.exp(-knobs.kappa * h))) / knobs.kappa });
    while (this.pending.length && this.pending[0].due <= o.now) this.matured = this.pending.shift()!.x;

    const clears = netProfit !== undefined && netProfit >= o.minNetProfit - 1e-9;
    const spike = z >= knobs.z;
    const cross = this.matured !== undefined && this.x < this.matured && this.v <= 0;
    const reason: CurveReason = !clears ? 'BELOW_PROFIT_FLOOR' : spike ? 'DEVIATION_SPIKE' : cross ? 'SINUOUS_CROSS' : this.matured === undefined ? 'WARMING_UP' : 'HOLD';
    return {
      signal: clears && (spike || cross), reason,
      micro: +side.toFixed(4), curve: +fromLogit(this.x).toFixed(4),
      projected: this.matured === undefined ? undefined : +fromLogit(this.matured).toFixed(4),
      velocity: +this.v.toFixed(5), z: +z.toFixed(2), netProfit: netProfit === undefined ? undefined : +netProfit.toFixed(4),
      knobs: { R: +knobs.R.toFixed(4), kappa: +knobs.kappa.toFixed(3), z: +knobs.z.toFixed(2) }, ts: o.now,
    };
  }
}

// ---- The gate and its scoreboard ------------------------------------------------------------------

export interface SinuousExitParams {
  mode: 'gate' | 'monitor' | 'off';
  /** Net profit a contract (dollars) an exit must clear to count as a profit exit. */
  minNetProfit: number;
  /** Paper bench rule in place of the probation's (the owner turned the curve back on on Oct 23 to see whether it
   *  pays): benched when holding loses beyond luck at t <= -paperBenchT after paperBenchMinExits held exits, or costs
   *  the probation's dollar limit. */
  paperBenchT?: number;
  paperBenchMinExits?: number;
}

export const DEFAULT_SINUOUS_EXIT: SinuousExitParams = { mode: 'gate', minNetProfit: 0.015 };

/** One exit the bot's own logic wants, in the held side's terms. */
export interface ExitCheck {
  sidePrice: number;
  count: number;
  exitFeePer: number;
  entrySidePrice: number;
  entryFeePer: number;
  /** A stop, a broken trailing stop, a gap, late-match salvage: never waits. */
  protective: boolean;
}

export interface CurveEvent {
  event: 'held' | 'released' | 'scored' | 'benched' | 'reset';
  ticker?: string;
  [k: string]: unknown;
}

interface Held { sign: 1 | -1; heldNet: number; count: number; ts: number }
interface SavedState { results: number[]; since: number; benched?: { at: number; reason: string }; restartTag?: string }

export interface SinuousExitStatus {
  mode: SinuousExitParams['mode'];
  minNetProfitCents: number;
  benched: { at: number; reason: string } | null;
  scored: number;
  netUsd: number;
  t: number | null;
  since: number;
  /** When it benches itself: t at or below -t after minExits held exits, or a net cost of maxLossUsd. */
  benchRule: { t: number; minExits: number; maxLossUsd: number };
  holding: string[];
  tracking: number;
}

/**
 * Curves for every held binary contract, the gate on their profit exits, and the scoreboard of what holding cost
 * or earned. The engine calls observe() for each held market every tick, check() for each exit it wants to send,
 * flat() when a position is gone and settled() when a market settles.
 */
export class SinuousExitGate {
  private readonly trackers = new Map<string, { t: SinuousExitTracker; sign: 1 | -1; seen: number; reading?: CurveReading; lastExitNet?: number }>();
  private readonly held = new Map<string, Held>();
  private st: SavedState;

  constructor(
    readonly p: SinuousExitParams,
    private readonly bench: Pick<ProbationParams, 'minTrades' | 't' | 'maxLossUsd' | 'window'>,
    private readonly file?: string,
    private readonly onEvent?: (e: CurveEvent) => void,
    now = Date.now(),
    /** A scoreboard saved under another tag starts over once (bench lifted): how a book is turned back on. */
    restartTag?: string,
  ) {
    const saved = file ? readJson<SavedState>(file, { quarantine: true }) : undefined;
    const usable = saved && Array.isArray(saved.results) ? saved : undefined;
    if (usable && (restartTag === undefined || usable.restartTag === restartTag)) this.st = usable;
    else {
      this.st = { results: [], since: now, ...(restartTag !== undefined ? { restartTag } : {}) };
      if (usable) {
        this.save();
        this.onEvent?.({ event: 'reset', reason: `started over (${restartTag})`, before: { scored: usable.results.length, benched: usable.benched?.reason ?? null } });
      }
    }
  }

  /** Holding exits now: gate mode and not benched. */
  get active(): boolean { return this.p.mode === 'gate' && !this.st.benched; }

  /** Feed one tick of a held market; a new or reversed position starts a fresh curve. */
  observe(ticker: string, profile: CurveProfile, o: Omit<CurveObservation, 'minNetProfit'>): CurveReading {
    let k = this.trackers.get(ticker);
    if (!k || k.sign !== o.sign || k.t.profile !== profile) {
      k = { t: new SinuousExitTracker(profile), sign: o.sign, seen: o.now };
      this.trackers.set(ticker, k);
    }
    k.seen = o.now;
    k.reading = k.t.update({ ...o, minNetProfit: this.p.minNetProfit });
    const sideBid = o.sign > 0 ? o.bid?.price : o.ask ? 1 - o.ask.price : undefined;
    if (sideBid !== undefined) k.lastExitNet = sideBid - o.exitFeePer;
    if (this.trackers.size > 64) for (const [t, x] of this.trackers) if (o.now - x.seen > 600_000) this.trackers.delete(t);
    return k.reading;
  }

  reading(ticker: string): CurveReading | undefined { return this.trackers.get(ticker)?.reading; }

  /** May this exit go out now? A profit exit waits for the curve's signal (gate mode); every other exit goes. */
  check(ticker: string, e: ExitCheck, now: number): { allow: boolean; note?: string } {
    const exitNet = e.sidePrice - e.exitFeePer;
    const net = netProfitPerContract(e.sidePrice, e.entrySidePrice, e.entryFeePer, e.exitFeePer);
    const profitExit = !e.protective && net >= this.p.minNetProfit - 1e-9;
    const r = this.reading(ticker);
    if (!profitExit) {
      this.score(ticker, exitNet, now, e.protective ? 'protective exit' : 'exit below the profit floor');
      return { allow: true };
    }
    const cents = `${(net * 100).toFixed(1)}c`;
    if (r?.signal) {
      const h = this.held.get(ticker);
      if (h) this.onEvent?.({ event: 'released', ticker, reason: r.reason, heldSec: Math.round((now - h.ts) / 1000), reading: r });
      this.score(ticker, exitNet, now, r.reason);
      return { allow: true, note: `curve ${r.reason}: profit exit at ${e.sidePrice} (net +${cents}) goes out` };
    }
    const why = r ? `${r.reason}${r.z !== undefined ? `, z ${r.z}` : ''}${r.projected !== undefined ? `, curve ${r.curve} vs projection ${r.projected}` : ''}` : 'no curve yet';
    if (!this.active) {
      return { allow: true, note: `curve (${this.st.benched ? 'benched' : this.p.mode}) would hold the profit exit at ${e.sidePrice}: ${why}` };
    }
    if (!this.held.has(ticker)) {
      const k = this.trackers.get(ticker);
      this.held.set(ticker, { sign: k?.sign ?? 1, heldNet: exitNet, count: e.count, ts: now });
      this.onEvent?.({ event: 'held', ticker, sidePrice: e.sidePrice, netProfit: +net.toFixed(4), count: e.count, reading: r });
    }
    return { allow: false, note: `curve: holding the profit exit at ${e.sidePrice} (net +${cents}) for a spike or roll-over (${why})` };
  }

  /** The position is gone without an exit this gate saw: drop its curve; a held exit is scored at the last bid seen. */
  flat(ticker: string, now: number): void {
    const last = this.trackers.get(ticker)?.lastExitNet;
    if (this.held.has(ticker)) {
      if (last !== undefined) this.score(ticker, last, now, 'position closed');
      else this.held.delete(ticker);
    }
    this.trackers.delete(ticker);
  }

  /** The market settled: a held exit is scored at the payout (1 if the side held won, else 0; no settlement fee). */
  settled(ticker: string, result: 'yes' | 'no', now: number): void {
    const h = this.held.get(ticker);
    if (h) this.score(ticker, (h.sign > 0) === (result === 'yes') ? 1 : 0, now, `settled ${result.toUpperCase()}`);
    this.trackers.delete(ticker);
  }

  reset(now = Date.now()): void {
    this.st = { results: [], since: now, ...(this.st.restartTag !== undefined ? { restartTag: this.st.restartTag } : {}) };
    this.held.clear();
    this.save();
    this.onEvent?.({ event: 'reset' });
  }

  status(): SinuousExitStatus {
    const s = stats(this.st.results);
    return {
      mode: this.p.mode, minNetProfitCents: +(this.p.minNetProfit * 100).toFixed(2), benched: this.st.benched ?? null,
      scored: this.st.results.length, netUsd: +s.sum.toFixed(2), t: s.t === null ? null : +s.t.toFixed(2), since: this.st.since,
      benchRule: { t: this.bench.t, minExits: this.bench.minTrades, maxLossUsd: this.bench.maxLossUsd },
      holding: [...this.held.keys()], tracking: this.trackers.size,
    };
  }

  /** Score a held exit (if any) against the exit price it finally got. */
  private score(ticker: string, exitNet: number, now: number, how: string): void {
    const h = this.held.get(ticker);
    if (!h) return;
    this.held.delete(ticker);
    const usd = (exitNet - h.heldNet) * h.count;
    this.st.results.push(+usd.toFixed(4));
    if (this.st.results.length > this.bench.window) this.st.results.splice(0, this.st.results.length - this.bench.window);
    this.onEvent?.({ event: 'scored', ticker, usd: +usd.toFixed(4), how, heldSec: Math.round((now - h.ts) / 1000) });
    if (!this.st.benched) {
      const why = this.verdict();
      if (why) { this.st.benched = { at: now, reason: why }; this.onEvent?.({ event: 'benched', reason: why }); }
    }
    this.save();
  }

  private verdict(): string | undefined {
    const r = this.st.results, s = stats(r);
    if (s.sum <= -this.bench.maxLossUsd) return `holding profit exits cost $${(-s.sum).toFixed(2)} over ${r.length} exits (limit $${this.bench.maxLossUsd})`;
    if (r.length >= this.bench.minTrades && s.sum < 0 && s.t !== null && s.t <= -this.bench.t) return `holding profit exits is losing beyond luck: $${s.sum.toFixed(2)} over ${r.length} exits, t ${s.t.toFixed(2)}`;
    return undefined;
  }

  private save(): void {
    if (this.file) writeJsonAtomic(this.file, this.st);
  }
}

function stats(r: number[]): { sum: number; t: number | null } {
  const n = r.length, sum = r.reduce((a, v) => a + v, 0);
  if (n < 2) return { sum, t: null };
  const m = sum / n, sd = Math.sqrt(r.reduce((a, v) => a + (v - m) ** 2, 0) / (n - 1));
  return { sum, t: sd > 0 ? m / (sd / Math.sqrt(n)) : m < 0 ? -Infinity : m > 0 ? Infinity : 0 };
}
