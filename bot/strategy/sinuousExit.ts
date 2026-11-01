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
// negative net with t <= -PROBATION_T) the cross used to be benched. Since Oct 31 (Steven: rework, never bench) a rejected
// window makes it one level stricter instead (bot/strategy/levelLadder.ts): from level 1 the cross also needs the coin's
// spot fair value of the side to be at most the net bid plus the level's margin (SINUOUS_CROSS_FV_MARGINS), and its fee
// margin grows with the level; a winning window at a raised level steps it back.
//
// SINUOUS_EXIT=gate (default) holds profit exits for the curve; monitor computes and shows it without holding
// anything; rest places the exit instead of holding it (below); off. SINUOUS_MIN_PROFIT_CENTS (default 1.5): the net
// profit a contract an exit must clear to count as a profit exit (smaller gains go out as before).
//
// Rest mode (paper by default, SINUOUS_EXIT_PAPER=rest; the owner's choice on Oct 23: the curve should give a place to
// exit, not hold exits): nothing is held. The held side rests a sell at the curve's estimate of where the current swing
// tops out: the level its momentum carries it to before it decays, x + max(0, v) / kappa in logit, plus
// SINUOUS_REST_BAND_SIGMAS (0.5) of the book's noise, never below the take-profit floor (the strategy places it, in
// place of the opposite-side maker quote, and moves it as the curve moves). A resting sell pays no fee on these markets.
// Stops, the take-profit give-back and the model exit still cross the book at once (and cancel the resting sell first).
//
// The cross (rest mode; the owner's option #1 after the Oct 23 exit research): the resting sell is the place to exit
// while the swing still rises; once the curve has rolled over, the position is sold at the bid at once when
//   - the curve is below the projection made look-ahead seconds ago by at least SINUOUS_CROSS_FEE_MARGIN (0.5) x the
//     taker fee a contract, its velocity at or below zero (hysteresis: a wiggle smaller than the fee does not count);
//   - the coin's price has turned against the side held over the fast-move window (the contract follows spot; a book
//     that dips while spot does not is not a reversal);
//   - the sale clears the take-profit floor net of every fee.
// No resting sell and no cross in the last SINUOUS_REST_STAND_DOWN_SEC (120) seconds: a binary's swings grow as the
// close nears (12-16c for a 1-sigma 10 s move in the last two minutes at the money) and the curve cannot keep up; the
// take-profit and the model exit carry on. The engine also pulls the resting sell during a fast index move (gap risk:
// a resting sell is lifted exactly when the contract is suddenly worth more). Scoreboard in rest mode: each cross exit
// against holding to settlement, (net exit price - payout) x contracts; benched under the same rules (the resting
// sells keep going, the cross stops until a reset).
//
// Cross mode (the default in paper and live since Oct 24, SINUOUS_EXIT=cross; the owner on Oct 23: "The resting at peak
// should go", and "It can't just be paper mode. When I take it out of paper mode into live it needs to behave
// identical"): the cross without the resting sell. The curve watches every held position and sells it at the bid on a
// confirmed roll-over (above); nothing rests at the swing top and nothing is held, so the ratchet stop, the take-profit
// and the model exit run exactly as without the curve. On Oct 23 the resting sells made +5.2c a contract but -$113 against
// holding: the swing-top estimate sat a few cents above the market and filled on ordinary upticks, selling winners.
// The scoreboard counts the cross's fills (crossFilled): a cross whose order does not fill sold nothing. Before Oct 24
// a cross was counted when it was called, so an unfilled one was scored as a sale it never made.

import type { BookLevel } from '../kalshi/types';
import type { LiveLineParams, LiveLineReading } from './liveLine';
import { LevelLadder, levelMargin } from './levelLadder';
import type { ProbationParams } from '../risk/probation';
import { readJson, writeJsonAtomic } from '../util/persist';
import { scoreStats } from './scoreStats';

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
  private knobs: CurveKnobs | undefined;

  constructor(readonly profile: CurveProfile) {}

  /** Where the current swing tops out, in the side's price terms: the level the curve's momentum carries it to before
   *  it decays (x + max(0, v) / kappa in logit), plus `bandSigmas` of the book's noise. Undefined while it warms up. */
  swingTop(bandSigmas: number): number | undefined {
    if (this.last === undefined || this.matured === undefined || !this.knobs) return undefined;
    return fromLogit(this.x + Math.max(0, this.v) / this.knobs.kappa + bandSigmas * Math.sqrt(this.knobs.R));
  }

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
    this.knobs = knobs;
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
  /** The same in paper and live (SINUOUS_EXIT, cross by default). */
  mode: 'gate' | 'monitor' | 'rest' | 'cross' | 'off';
  /** Net profit a contract (dollars) an exit must clear to count as a profit exit. */
  minNetProfit: number;
  /** Bench rule in place of the probation's, paper and live alike (SINUOUS_BENCH_T, SINUOUS_BENCH_MIN_EXITS): benched
   *  when its results lose beyond luck at t <= -benchT after benchMinExits scored exits, or cost the probation's dollar
   *  limit. */
  benchT?: number;
  benchMinExits?: number;
  /** Rest mode: how far above the swing-top estimate the sell rests, in the book's noise standard deviations. */
  restBandSigmas?: number;
  /** Rest mode: sell at once on a confirmed roll-over (the cross; default on). */
  cross?: boolean;
  /** Rest mode: how far below its projection the curve must be for the cross, as a share of the taker fee a contract. */
  crossFeeMargin?: number;
  /** Rest mode: no resting sell and no cross in the last this many seconds before the close. */
  restStandDownSec?: number;
  /** What the cross watches (SINUOUS_CROSS_SOURCE): 'line', Kalshi's live line for the coin (bot/strategy/liveLine.ts;
   *  the owner's description, Oct 23), or 'book', the contract's own order-book curve confirmed by the coin's turn. */
  crossSource?: 'line' | 'book';
  /** The live line's look-ahead, wiggle band and confirmation (LIVE_LINE_AHEAD_SEC, LIVE_LINE_BAND_K,
   *  LIVE_LINE_BAND_MIN_SEC, LIVE_LINE_CONFIRM_SEC). */
  line?: LiveLineParams;
  /** The cross's strictness ladder (bot/strategy/levelLadder.ts; Steven, Oct 31: rework, never bench): the fair-value
   *  confirm a level asks for (SINUOUS_CROSS_FV_MARGINS, index 0 = level 1): the cross sells only while the coin's spot
   *  fair value of the side is at most the net bid plus that margin; each level also multiplies the fee margin by
   *  (1 + level). SINUOUS_CROSS_LEVEL pins a level (-1: the ladder decides), SINUOUS_CROSS_LEVEL_MAX caps it. */
  crossFvMargins?: number[];
  crossLevel?: number;
  crossLevelMax?: number;
  /** The dip buy (Steven, Nov 1: turn what we get wrong into profit). The cross sold winners on book dips that recovered
   *  (Oct 29-30 replay: 524 contracts sold for $200 that later bid $366): the book rolling over while the coin's fair value
   *  of the side stays above the ask is noise in the book, not a reversal. So on that reading the position is ADDED to:
   *  bought at the side's ask when the fair value is at least the ask plus the taker fee plus dipMargin (SINUOUS_DIP_BUY,
   *  SINUOUS_DIP_MARGIN, SINUOUS_DIP_FRAC of the position, at most SINUOUS_DIP_MAX adds a market, SINUOUS_DIP_COOLDOWN_SEC
   *  apart). The cross still sells when the coin agrees with the dip (its fair-value confirm). */
  dipBuy?: boolean;
  dipMargin?: number;
  dipFrac?: number;
  dipMax?: number;
  dipCooldownSec?: number;
}

/** The cross needs the coin's price to have turned against the side held: 'against', 'with' it, or 'flat' (within
 *  noise, or no reading). */
export type SpotTurn = 'against' | 'with' | 'flat';

/** A cross exit the curve may call, in the held side's terms. */
export interface CrossCheck {
  sidePrice: number;
  count: number;
  exitFeePer: number;
  entrySidePrice: number;
  entryFeePer: number;
  /** The take-profit floor (net a contract) the sale has to clear. */
  floor: number;
  tauSec: number;
  spot: SpotTurn;
  /** The position's reading of its coin's live line (the 'line' source). */
  line?: LiveLineReading;
  /** The coin's spot fair value of the side held (MarketView.pFair), for the level's fair-value confirm. */
  fvSide?: number;
}

const DEFAULT_REST_STAND_DOWN_SEC = 120;
/** A cross exit whose market never settles in view is forgotten after this long. */
const CROSS_MAX_AGE_MS = 3 * 3_600_000;

/** The cross's fair-value confirm by level (1, 2, 3, 4...): the coin's value of the side may sit at most this far above the
 *  net bid. */
export const DEFAULT_CROSS_FV_MARGINS = [0.04, 0.02, 0.01, 0];

export const DEFAULT_SINUOUS_EXIT: SinuousExitParams = { mode: 'cross', minNetProfit: 0.015 };

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
  event: 'held' | 'released' | 'scored' | 'benched' | 'reset' | 'stricter' | 'looser';
  ticker?: string;
  [k: string]: unknown;
}

interface Held { sign: 1 | -1; heldNet: number; count: number; ts: number }
/** A cross exit waiting for its market's result: the net price a contract it sold at. */
interface Crossed { ticker: string; sign: 1 | -1; exitNet: number; count: number; ts: number }
interface SavedState { results: number[]; since: number; level: number; benched?: { at: number; reason: string }; restartTag?: string; crosses?: Crossed[] }

export interface SinuousExitStatus {
  mode: SinuousExitParams['mode'];
  minNetProfitCents: number;
  /** Never set any more (a trip makes the cross stricter instead); kept for the dashboard. */
  benched: { at: number; reason: string } | null;
  /** The strictness level in force (0 = as before any trip) and whether a setting pins it. */
  level: number;
  levelPinned: boolean;
  scored: number;
  netUsd: number;
  t: number | null;
  since: number;
  /** When it benches itself: t at or below -t after minExits held exits, or a net cost of maxLossUsd. */
  benchRule: { t: number; minExits: number; maxLossUsd: number };
  holding: string[];
  tracking: number;
  /** Rest mode: whether the cross is on, and its exits still waiting for their market's result. */
  cross: boolean;
  crossesPending: number;
  /** What the cross watches: the coin's live line, or the contract's book; the live line's settings. */
  crossSource: 'line' | 'book';
  line?: LiveLineParams;
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
  private readonly ladder: LevelLadder;

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
    this.ladder = new LevelLadder(bench, p.crossLevelMax ?? 4, p.crossLevel !== undefined && p.crossLevel >= 0 ? p.crossLevel : undefined);
    if (usable && (restartTag === undefined || usable.restartTag === restartTag)) {
      // A bench saved before the ladder: the cross comes back one level stricter, with a fresh window.
      this.st = usable.benched ? { ...usable, results: [], since: now, level: Math.max(1, usable.level || 0), benched: undefined } : { ...usable, level: usable.level || 0 };
    } else {
      this.st = { results: [], since: now, level: 0, ...(restartTag !== undefined ? { restartTag } : {}) };
      if (usable) {
        this.save();
        this.onEvent?.({ event: 'reset', reason: `started over (${restartTag})`, before: { scored: usable.results.length, benched: usable.benched?.reason ?? null, level: usable.level ?? 0 } });
      }
    }
  }

  /** Holding exits now: gate mode. */
  get active(): boolean { return this.p.mode === 'gate'; }

  /** The cross's strictness level in force. */
  get level(): number { return this.ladder.level(this.st); }

  /** The level's fair-value confirm: undefined when it passes (level 0, or the coin's value of the side is at most the net
   *  bid plus the level's margin), else why the cross waits. */
  private fvHold(e: CrossCheck): string | undefined {
    const m = levelMargin(this.p.crossFvMargins ?? DEFAULT_CROSS_FV_MARGINS, this.level);
    if (m === undefined || e.fvSide === undefined) return undefined;
    const netBid = e.sidePrice - e.exitFeePer;
    return e.fvSide <= netBid + m + 1e-9 ? undefined : `the coin's fair value ${e.fvSide.toFixed(3)} is above the net bid ${netBid.toFixed(3)} + ${m} (level ${this.level})`;
  }

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

  /** Rest mode: the side price to rest the held position's sell at (the swing-top estimate), or undefined (another mode,
   *  no curve yet, still warming up, or inside the stand-down before the close). */
  restTarget(ticker: string, tauSec?: number): number | undefined {
    if (this.p.mode !== 'rest' || (tauSec !== undefined && tauSec <= this.standDownSec)) return undefined;
    return this.trackers.get(ticker)?.t.swingTop(this.p.restBandSigmas ?? 0.5);
  }

  private get standDownSec(): number { return this.p.restStandDownSec ?? DEFAULT_REST_STAND_DOWN_SEC; }

  /** Rest and cross modes sell on the cross and never hold an exit. */
  get crossing(): boolean { return this.p.mode === 'rest' || this.p.mode === 'cross'; }

  /** Rest and cross modes: sell the position at the bid now? On a confirmed roll-over (see the header) that clears the
   *  take-profit floor. What the order fills is scored (crossFilled), not the call. */
  /** The dip buy (see SinuousExitParams.dipBuy): add to the position now? `sideAsk` is what one more contract of the side
   *  costs, `takerFeePer` its fee. Uses the book curve whatever the cross watches. */
  dip(ticker: string, e: { sideAsk: number; takerFeePer: number; fvSide?: number; tauSec: number; position: number; exitFeePer: number }, now: number): { buy: number; why?: string } {
    if (!this.p.dipBuy || e.fvSide === undefined || e.tauSec <= this.standDownSec) return { buy: 0 };
    const k = this.trackers.get(ticker);
    const r = k?.reading;
    if (!k || !r || r.curve === undefined || r.projected === undefined || r.velocity === undefined) return { buy: 0 };
    const depth = r.projected - r.curve;
    if (!(r.velocity <= 0 && depth > 0 && depth >= (this.p.crossFeeMargin ?? 0.5) * e.exitFeePer - 1e-9)) return { buy: 0 };
    const margin = this.p.dipMargin ?? 0.04;
    if (!(e.fvSide >= e.sideAsk + e.takerFeePer + margin - 1e-9)) return { buy: 0 };
    const d = this.dips.get(ticker) ?? { n: 0, last: -Infinity, sign: k.sign };
    if (d.sign !== k.sign) { d.n = 0; d.last = -Infinity; d.sign = k.sign; }
    if (d.n >= (this.p.dipMax ?? 2) || now - d.last < (this.p.dipCooldownSec ?? 60) * 1000) return { buy: 0 };
    const n = Math.floor(Math.abs(e.position) * (this.p.dipFrac ?? 0.5));
    if (!(n >= 1)) return { buy: 0 };
    d.n++; d.last = now; this.dips.set(ticker, d);
    if (this.dips.size > 256) for (const [t, x] of this.dips) if (now - x.last > 3_600_000) this.dips.delete(t);
    return { buy: n, why: `exit curve: dip buy${k.sign < 0 ? ' NO' : ''} ${e.sideAsk} (book rolled over ${depth.toFixed(3)} under its projection, the coin's fair value ${e.fvSide.toFixed(3)} >= ask + fee + ${margin})` };
  }
  private readonly dips = new Map<string, { n: number; last: number; sign: 1 | -1 }>();

  cross(ticker: string, e: CrossCheck, now: number): { sell: boolean; why?: string; note?: string } {
    if (!this.crossing || this.p.cross === false || e.tauSec <= this.standDownSec) return { sell: false };
    if (this.p.crossSource === 'line') return this.lineCross(ticker, e);
    const k = this.trackers.get(ticker);
    const r = k?.reading;
    if (!k || !r || r.curve === undefined || r.projected === undefined || r.velocity === undefined) return { sell: false };
    const net = netProfitPerContract(e.sidePrice, e.entrySidePrice, e.entryFeePer, e.exitFeePer);
    const depth = r.projected - r.curve;
    if (!(net >= e.floor - 1e-9 && r.velocity <= 0 && depth > 0 && depth >= (this.p.crossFeeMargin ?? 0.5) * (1 + this.level) * e.exitFeePer - 1e-9)) return { sell: false };
    const curve = `curve ${r.curve} under projection ${r.projected}`;
    const fv = this.fvHold(e);
    if (fv) return { sell: false, note: `exit curve: crossed (${curve}) but ${fv}` };
    if (e.spot !== 'against') return { sell: false, note: `exit curve: crossed (${curve}) but spot has not turned (${e.spot})` };
    return { sell: true, why: `exit curve: cross${k.sign < 0 ? ' NO' : ''} ${e.sidePrice} (+${net.toFixed(3)} a contract net, ${curve}, spot against)` };
  }

  /** The live-line cross: the coin's line outside its wiggle band against the side for the confirmation seconds, and the
   *  sale clears the take-profit floor. */
  private lineCross(ticker: string, e: CrossCheck): { sell: boolean; why?: string; note?: string } {
    const l = e.line;
    if (!l?.broke) return { sell: false };
    const net = netProfitPerContract(e.sidePrice, e.entrySidePrice, e.entryFeePer, e.exitFeePer);
    if (!(net >= e.floor - 1e-9)) return { sell: false };
    const k = this.trackers.get(ticker);
    const no = (k?.sign ?? 1) < 0 ? ' NO' : '';
    const line = `live line outside its wiggle band for ${l.breakSec} s (${l.underSd} sd${l.band ? `, band +-${l.band.k} sd of ${l.band.sec} s since the open` : ''})`;
    const fv = this.fvHold(e);
    if (fv) return { sell: false, note: `exit curve: ${line} but ${fv}` };
    return { sell: true, why: `exit curve: cross${no} ${e.sidePrice} (+${net.toFixed(3)} a contract net, ${line})` };
  }

  /** A cross exit filled: `count` contracts of the side held (`sign`) sold at `sidePrice`, paying `exitFeePer` a
   *  contract. Remembered (across restarts) and scored against holding to settlement when the market settles. */
  crossFilled(ticker: string, sign: 1 | -1, sidePrice: number, count: number, exitFeePer: number, now: number): void {
    if (!(count > 0)) return;
    this.prune(now);
    (this.st.crosses ??= []).push({ ticker, sign, exitNet: +(sidePrice - exitFeePer).toFixed(6), count, ts: now });
    this.save();
  }

  private prune(now: number): void {
    if (this.st.crosses?.length) this.st.crosses = this.st.crosses.filter((c) => now - c.ts <= CROSS_MAX_AGE_MS);
  }

  /** May this exit go out now? A profit exit waits for the curve's signal (gate mode); every other exit goes. */
  check(ticker: string, e: ExitCheck, now: number): { allow: boolean; note?: string } {
    // Rest and cross modes place exits instead of holding them: every exit goes.
    if (this.crossing) return { allow: true };
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
      return { allow: true, note: `curve (${this.p.mode}) would hold the profit exit at ${e.sidePrice}: ${why}` };
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

  /** The market settled: a held exit is scored at the payout (1 if the side held won, else 0; no settlement fee), and
   *  each cross exit in it against that payout (what holding to settlement would have paid instead). */
  settled(ticker: string, result: 'yes' | 'no', now: number): void {
    const payout = (sign: 1 | -1) => ((sign > 0) === (result === 'yes') ? 1 : 0);
    const h = this.held.get(ticker);
    if (h) this.score(ticker, payout(h.sign), now, `settled ${result.toUpperCase()}`);
    const mine = this.st.crosses?.filter((c) => c.ticker === ticker) ?? [];
    if (mine.length) {
      this.st.crosses = this.st.crosses!.filter((c) => c.ticker !== ticker);
      for (const c of mine) this.record(ticker, (c.exitNet - payout(c.sign)) * c.count, now, `cross vs settled ${result.toUpperCase()}`, { heldSec: 0 });
    }
    this.trackers.delete(ticker);
  }

  reset(now = Date.now()): void {
    this.st = { results: [], since: now, level: 0, ...(this.st.restartTag !== undefined ? { restartTag: this.st.restartTag } : {}), ...(this.st.crosses?.length ? { crosses: this.st.crosses } : {}) };
    this.held.clear();
    this.save();
    this.onEvent?.({ event: 'reset' });
  }

  status(): SinuousExitStatus {
    const s = scoreStats(this.st.results);
    return {
      mode: this.p.mode, minNetProfitCents: +(this.p.minNetProfit * 100).toFixed(2), benched: null, level: this.level, levelPinned: this.ladder.pinned !== undefined,
      scored: this.st.results.length, netUsd: +s.sum.toFixed(2), t: s.t === null ? null : +s.t.toFixed(2), since: this.st.since,
      benchRule: { t: this.bench.t, minExits: this.bench.minTrades, maxLossUsd: this.bench.maxLossUsd },
      holding: [...this.held.keys()], tracking: this.trackers.size,
      cross: this.crossing && this.p.cross !== false, crossesPending: this.st.crosses?.length ?? 0,
      crossSource: this.p.crossSource ?? 'book', ...(this.p.crossSource === 'line' && this.p.line ? { line: this.p.line } : {}),
    };
  }

  /** Score a held exit (if any) against the exit price it finally got. */
  private score(ticker: string, exitNet: number, now: number, how: string): void {
    const h = this.held.get(ticker);
    if (!h) return;
    this.held.delete(ticker);
    this.record(ticker, (exitNet - h.heldNet) * h.count, now, how, { heldSec: Math.round((now - h.ts) / 1000) });
  }

  /** One scoreboard result in dollars; a window the old bench rule rejects makes the cross one level stricter, a winning
   *  one at a raised level one looser (bot/strategy/levelLadder.ts). Never benched. */
  private record(ticker: string, usd: number, now: number, how: string, extra: Record<string, unknown>): void {
    this.onEvent?.({ event: 'scored', ticker, usd: +usd.toFixed(4), how, ...extra });
    const what = this.crossing ? 'selling on the cross (against holding to settlement)' : 'holding profit exits';
    const move = this.ladder.record(this.st, usd, now, what);
    if (move) this.onEvent?.({ ...move });
    this.save();
  }

  private save(): void {
    if (this.file) writeJsonAtomic(this.file, this.st);
  }
}

export { scoreStats } from './scoreStats';
