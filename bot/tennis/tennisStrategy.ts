// ATP tennis match-winner markets (KXATPMATCH): a rules-based, order-book
// driven strategy with hard budget caps.
//
// Phases per match (an event with one "Will <player> win?" market per player):
//
//   1. UNDERDOG BOUNCE. Just before or just after the start, if the market is
//      heavily skewed (underdog <= underdogMax, favorite >= 1 - underdogMax),
//      bid for the underdog as a maker. After a fill, rest a maker take-profit
//      at max(entry + takeProfitCents, entry x (1 + takeProfitPct)). This is a
//      VOLATILITY trade: early breaks move tennis prices a lot, and the plan is
//      to sell into that bounce. Research on tennis and Kalshi (favourite-
//      longshot bias: Lahvicka 2014; Burgi, Deng & Whelan) finds longshots win
//      LESS often than their price implies, so holding underdogs to settlement
//      is expected to lose. The take-profit is the point of the trade; an
//      optional stop exists (off by default: max loss is the entry price).
//   2. WAIT while tracking the match.
//   3. FAVORITE RE-ENTRY. Once the match is at least favMinProgress done and
//      one side leads clearly (price in [favMin, favMax]) and has been stable
//      (not down more than favStableCents over 5 minutes), bid for the leader
//      as a maker and hold to settlement (optional stop, off by default).
//      "Safer" means a high hit rate, not low risk: at 85c a win pays 15c and a
//      loss costs 85c.
//
// Match state without a score feed: the bot only sees Kalshi's books, so
//   - started = the published start time passed, or (without one) the first
//     mid move of liveMoveCents within 3 minutes (in-play prices move on
//     every point; pre-match prices barely move);
//   - progress = minutes since start / expected duration (best-of-5 at the
//     Grand Slams, else best-of-3). It is a proxy for "half the sets played".
// A licensed point-by-point feed would make both exact.
//
// Pure logic (no I/O): the engine turns plans into risk-checked orders.

import type { TennisConfig } from '../config';
import type { OrderBook } from '../marketdata/orderBook';
import { LiquidityRatchet } from '../strategy/exitPolicies';
import { floorToTick, round } from '../util/num';

export interface Quote { bid?: number; ask?: number; bidSize?: number; askSize?: number }

export interface MatchMarket {
  ticker: string; title?: string; quote: Quote; position: number; avgEntry?: number; book?: OrderBook;
  /** Signed taker flow on this market over the last minute: (YES-taker - NO-taker) / total, in [-1, 1]. */
  flow?: number;
}

export type MatchPhase = 'pre' | 'underdog_window' | 'live' | 'late' | 'done';

export interface MatchSnapshot {
  event: string;
  now: number;
  /** Published start time, if any. */
  startTime?: number;
  /** The two player markets (one is enough: the other side is 1 - p). */
  markets: MatchMarket[];
  closeTime: number;
}

export interface TennisPlan {
  ticker: string;
  side: 'bid' | 'ask';
  price: number;
  count: number;
  postOnly: boolean;
  reduceOnly: boolean;
  timeInForce: 'good_till_canceled' | 'immediate_or_cancel';
  leg: 'underdog_entry' | 'underdog_tp' | 'underdog_trail' | 'underdog_late' | 'underdog_cut' | 'underdog_stop' | 'fav_entry' | 'fav_trail' | 'fav_stop';
  why: string;
}

const GRAND_SLAMS = /(australian open|roland garros|french open|wimbledon|us open)/i;

const mid = (q: Quote) => (q.bid !== undefined && q.ask !== undefined && q.ask >= q.bid ? (q.bid + q.ask) / 2 : undefined);

/** Per-match state machine. */
export class MatchTracker {
  liveSince?: number;
  underdogTicker?: string;
  underdogEntered = false;
  underdogClosed = false;
  favEntered = false;
  /** Trailing stops (per held market): armed once the bid reached the target. */
  readonly armed = new Set<string>();
  readonly ratchets = new Map<string, LiquidityRatchet>();
  readonly stops = new Map<string, number>();
  /** When each trail armed, and the best bid seen since (conservative price hunt). */
  readonly armedAt = new Map<string, number>();
  readonly peak = new Map<string, number>();
  /** Last tennis-confluence reading per held market (dashboard). */
  readonly signals = new Map<string, { score: number; momentum: boolean; flow: boolean; depth: boolean; crossMarket: boolean }>();
  private history: Array<{ ts: number; p: number }> = [];
  private readonly mids = new Map<string, Array<{ ts: number; p: number }>>();

  /** Mid change of one market over the last `ms` (undefined without enough history). */
  midChange(ticker: string, now: number, ms = 60_000): number | undefined {
    const h = this.mids.get(ticker);
    if (!h?.length) return undefined;
    const past = h.find((x) => x.ts >= now - ms);
    const last = h[h.length - 1];
    if (!past || last.ts - past.ts < ms / 2) return undefined;
    return last.p - past.p;
  }

  constructor(readonly event: string, private readonly cfg: TennisConfig) {}

  /** P(first market's player wins) from the book(s): average of market A and 1 - market B when both exist. */
  static probability(ms: MatchMarket[]): number | undefined {
    const a = ms[0] ? mid(ms[0].quote) : undefined;
    const b = ms[1] ? mid(ms[1].quote) : undefined;
    if (a !== undefined && b !== undefined) return (a + (1 - b)) / 2;
    return a ?? (b !== undefined ? 1 - b : undefined);
  }

  bestOf(ms: MatchMarket[]): 3 | 5 {
    return ms.some((m) => m.title && GRAND_SLAMS.test(m.title)) ? 5 : 3;
  }

  progress(now: number, ms: MatchMarket[]): number {
    if (this.liveSince === undefined) return 0;
    const dur = this.bestOf(ms) === 5 ? this.cfg.durationBo5Min : this.cfg.durationBo3Min;
    return (now - this.liveSince) / (dur * 60_000);
  }

  /** Update from a snapshot; returns the phase. */
  observe(s: MatchSnapshot): MatchPhase {
    const p = MatchTracker.probability(s.markets);
    if (p !== undefined) {
      this.history.push({ ts: s.now, p });
      while (this.history.length && this.history[0].ts < s.now - 15 * 60_000) this.history.shift();
    }
    for (const m of s.markets) {
      const mp = mid(m.quote);
      if (mp === undefined) continue;
      const h = this.mids.get(m.ticker) ?? [];
      h.push({ ts: s.now, p: mp });
      while (h.length && h[0].ts < s.now - 5 * 60_000) h.shift();
      this.mids.set(m.ticker, h);
    }
    if (this.liveSince === undefined) {
      if (s.startTime !== undefined && s.now >= s.startTime) this.liveSince = s.startTime;
      else if (s.startTime === undefined && p !== undefined) {
        const recent = this.history.filter((h) => h.ts >= s.now - 3 * 60_000);
        const moved = recent.length > 1 && Math.max(...recent.map((h) => h.p)) - Math.min(...recent.map((h) => h.p)) >= this.cfg.liveMoveCents - 1e-9;
        if (moved) this.liveSince = s.now;
      }
    }
    if (s.now >= s.closeTime) return 'done';
    if (this.liveSince === undefined) {
      const soon = s.startTime !== undefined && s.startTime - s.now <= this.cfg.preStartMin * 60_000;
      return soon ? 'underdog_window' : 'pre';
    }
    if (s.now - this.liveSince <= this.cfg.entryWindowMin * 60_000) return 'underdog_window';
    return this.progress(s.now, s.markets) >= this.cfg.favMinProgress ? 'late' : 'live';
  }

  /** Price change of a side over the last `ms` (positive = up). */
  change(side: 'a' | 'b', now: number, ms = 5 * 60_000): number | undefined {
    const past = this.history.find((h) => h.ts >= now - ms);
    const last = this.history[this.history.length - 1];
    if (!past || !last || last.ts - past.ts < ms / 2) return undefined;
    const d = last.p - past.p;
    return side === 'a' ? d : -d;
  }
}

/**
 * Tennis confluence: tennis has no macro factors, but the book and tape of the two player
 * markets give four independent confirmations that a move toward OUR player is real
 * (thresholds configurable; defaults over the last 60 s):
 *   momentum     our player's mid rose >= confMomentumCents (1c)
 *   flow         taker flow on our market favours our player (>= confFlow, +0.2)
 *   depth        top-3 book imbalance favours our player (bids heavier, >= confDepth, +0.2)
 *   crossMarket  the opponent's market fell >= confOpponentCents (1c): the move is not one
 *                noisy book
 * Used to enter (underdog, favorite) and to decide whether to keep hunting past the target.
 */
export function tennisConfluence(t: MatchTracker, m: MatchMarket, other: MatchMarket | undefined, now: number, cfg: TennisConfig) {
  const w = cfg.confWindowSec * 1000;
  const mom = t.midChange(m.ticker, now, w);
  const oth = other ? t.midChange(other.ticker, now, w) : undefined;
  const momentum = mom !== undefined && mom >= cfg.confMomentumCents - 1e-9;
  const flow = m.flow !== undefined && m.flow >= cfg.confFlow - 1e-9;
  const depth = m.book !== undefined && m.book.imbalance(3) >= cfg.confDepth - 1e-9;
  const crossMarket = oth !== undefined && oth <= -cfg.confOpponentCents + 1e-9;
  return { score: [momentum, flow, depth, crossMarket].filter(Boolean).length, momentum, flow, depth, crossMarket };
}

/** Sell price that the visible bids can absorb for the whole position, never below `minPx`. */
function nextFillableExit(m: MatchMarket, minPx: number): number | undefined {
  const bid = m.quote.bid;
  if (bid === undefined) return undefined;
  let px = bid;
  if (m.book) {
    let cum = 0;
    for (const l of m.book.snapshot(20).bids) { cum += l.size; px = l.price; if (cum + 1e-9 >= m.position) break; }
  }
  const limit = Math.max(px, minPx);
  return bid >= minPx - 1e-9 ? limit : undefined;
}

/**
 * Conservative price hunt past the target, then the next available exit in profit.
 *  - Below the target: no exit order, the position rides.
 *  - At the target: hunt only if >= huntMinSignals tennis-confluence signals agree; otherwise take
 *    the profit right away.
 *  - While hunting: stop = max(target lock, order-book wall ratchet (levels that can fill the whole
 *    position), peak bid - huntTrailTicks). The hunt lasts at most huntMaxSec.
 *  - Exit (bid breaks the stop, signals fade, or time is up): sell reduce-only at the price the
 *    visible bids can absorb, never below entry + 1 tick. Below that, hold (optional hard stop).
 */
function huntExit(t: MatchTracker, m: MatchMarket, other: MatchMarket | undefined, entry: number, target: number, now: number, cfg: TennisConfig, tick: number, leg: 'underdog_trail' | 'fav_trail', notes: string[]): TennisPlan[] {
  const bid = m.quote.bid;
  const sig = tennisConfluence(t, m, other, now, cfg);
  t.signals.set(m.ticker, sig);
  if (!t.armed.has(m.ticker)) {
    if (bid === undefined || bid < target - 1e-9) {
      notes.push(`${leg}: holding, hunt starts at ${target.toFixed(2)} (bid ${bid ?? '—'})`);
      return [];
    }
    t.armed.add(m.ticker);
    t.armedAt.set(m.ticker, now);
  }
  const floorPx = round(entry + tick, 4);
  const sell = (why: string): TennisPlan[] => {
    const px = nextFillableExit(m, floorPx);
    if (px === undefined) { notes.push(`${leg}: exit wanted but bid ${bid} is not in profit; holding`); return []; }
    return [{ ticker: m.ticker, side: 'ask', price: round(px, 4), count: m.position, postOnly: false, reduceOnly: true, timeInForce: 'immediate_or_cancel', leg, why }];
  };
  const peak = Math.max(t.peak.get(m.ticker) ?? 0, bid ?? 0);
  t.peak.set(m.ticker, peak);
  let stop = Math.max(target, round(peak - cfg.huntTrailTicks * tick, 4));
  if (m.book) {
    let r = t.ratchets.get(m.ticker);
    if (!r) { r = new LiquidityRatchet({ minFillRatio: cfg.trailMinFillRatio, minWallAgeMs: cfg.trailMinWallAgeSec * 1000, slippageTicks: cfg.trailSlippageTicks }); t.ratchets.set(m.ticker, r); }
    const out = r.evaluate({ position: m.position, book: m.book, now, tick, fees: { takerMultiplier: 1, makerMultiplier: 1 }, floor: target });
    if (out.stop !== undefined) stop = Math.max(stop, out.stop);
  }
  t.stops.set(m.ticker, stop);
  const huntedSec = (now - (t.armedAt.get(m.ticker) ?? now)) / 1000;
  notes.push(`${leg}: hunting, stop ${stop.toFixed(2)}, confluence ${sig.score}/4, ${huntedSec.toFixed(0)}s`);
  if (bid !== undefined && bid < stop - 1e-9) return sell(`${leg}: bid ${bid} broke the stop ${stop.toFixed(2)}`);
  if (sig.score < cfg.huntMinSignals) return sell(`${leg}: only ${sig.score}/4 confluence signals: taking the profit`);
  if (huntedSec >= cfg.huntMaxSec) return sell(`${leg}: hunt time limit ${cfg.huntMaxSec}s: taking the profit`);
  return [];
}

/** Buy-side view of a market: price to bid (maker) for YES of this player. */
function makerBid(q: Quote, tick: number, maxSpread: number): number | undefined {
  if (q.bid === undefined || q.ask === undefined) return undefined;
  const spread = q.ask - q.bid;
  if (spread > maxSpread + 1e-9) return undefined;
  // Improve by one tick when the spread allows, else join.
  const px = spread >= 2 * tick - 1e-9 ? round(q.bid + tick, 4) : q.bid;
  return px < q.ask ? px : undefined;
}

export interface BudgetView {
  /** Working cash pool (tradable bankroll). */
  bankroll: number;
  /** Worst-case loss of all tennis positions + resting orders now. */
  tennisRisk: number;
  /** Worst-case loss already committed to this match. */
  matchRisk: number;
}

/** Contracts for a new entry within the per-order, per-match and 25% total caps. Tennis series
 * charge maker fees (multiplier 1: 0.0175 x P(1-P) per contract, rounded up per order), so the
 * fee and one cent of rounding are budgeted too. */
export function tennisSize(price: number, cfg: TennisConfig, b: BudgetView, makerMultiplier = 1): number {
  const room = Math.min(
    cfg.orderFrac * b.bankroll,
    cfg.maxMatchFrac * b.bankroll - b.matchRisk,
    cfg.maxTotalFrac * b.bankroll - b.tennisRisk,
  ) - 0.01;
  const cost = price + makerMultiplier * 0.0175 * price * (1 - price);
  if (!(room > 0) || !(price > 0)) return 0;
  return Math.floor((room / cost) * 100) / 100;
}

/**
 * Decide orders for one match. Returns the desired resting/IOC plans; the
 * caller cancels resting tennis orders that are not in the plan.
 */
export function decideMatch(t: MatchTracker, s: MatchSnapshot, cfg: TennisConfig, budget: BudgetView, tick = 0.01): { phase: MatchPhase; plans: TennisPlan[]; notes: string[] } {
  const phase = t.observe(s);
  const plans: TennisPlan[] = [];
  const notes: string[] = [];
  const pA = MatchTracker.probability(s.markets);
  if (pA === undefined || s.markets.length === 0) return { phase, plans, notes: ['no two-sided book'] };

  // Map "side" -> market to buy YES on (use the player's own market when listed).
  const marketFor = (side: 'a' | 'b'): MatchMarket | undefined => (side === 'a' ? s.markets[0] : s.markets[1]);
  const pSide = (side: 'a' | 'b') => (side === 'a' ? pA : 1 - pA);
  const held = s.markets.filter((m) => m.position > 0);

  // A flat market has no trail (a later leg on the same player starts a fresh one).
  for (const m of s.markets) if (m.position <= 0) { t.armed.delete(m.ticker); t.ratchets.delete(m.ticker); t.stops.delete(m.ticker); t.armedAt.delete(m.ticker); t.peak.delete(m.ticker); t.signals.delete(m.ticker); }

  // After a restart the tracker is fresh: a held position bought cheap is the underdog trade.
  if (!t.underdogTicker && !t.underdogEntered && !t.favEntered && held.length) {
    const h = held[0];
    if ((h.avgEntry ?? 1) <= cfg.underdogMax + 0.05) t.underdogTicker = h.ticker;
  }

  // ---- Open underdog position: take-profit (and optional stop) ------------------
  const ud = t.underdogTicker ? s.markets.find((m) => m.ticker === t.underdogTicker) : undefined;
  if (ud && ud.position > 0 && !t.underdogClosed) {
    t.underdogEntered = true;
    const entry = ud.avgEntry ?? ud.quote.bid ?? 0;
    const target = Math.min(0.99, Math.max(entry + cfg.takeProfitCents, entry * (1 + cfg.takeProfitPct)));
    const tpPx = floorToTick(target + tick - 1e-9, tick); // target rounded up to the tick
    const prog = t.progress(s.now, s.markets);
    const other = s.markets.find((x) => x.ticker !== ud.ticker);
    if (cfg.underdogCutProgress > 0 && prog >= cfg.underdogCutProgress && ud.quote.bid !== undefined) {
      // Underdogs usually lose late: salvage what the position is still worth.
      plans.push({ ticker: ud.ticker, side: 'ask', price: ud.quote.bid, count: ud.position, postOnly: false, reduceOnly: true, timeInForce: 'immediate_or_cancel', leg: 'underdog_cut', why: `match ${(prog * 100).toFixed(0)}% done: underdogs usually lose late, selling at ${ud.quote.bid}` });
      return { phase, plans, notes };
    }
    if (prog >= cfg.underdogLateProgress && ud.quote.bid !== undefined && ud.quote.bid >= entry + tick - 1e-9) {
      // Past the early phase: no more hunting, take the next available exit in profit.
      const px = nextFillableExit(ud, round(entry + tick, 4));
      if (px !== undefined) {
        plans.push({ ticker: ud.ticker, side: 'ask', price: round(px, 4), count: ud.position, postOnly: false, reduceOnly: true, timeInForce: 'immediate_or_cancel', leg: 'underdog_late', why: `match ${(prog * 100).toFixed(0)}% done: taking the profit while the underdog is still ahead` });
        return { phase, plans, notes };
      }
    }
    if (cfg.trail) {
      // Ratcheting trail from the target: no fixed exit; the stop starts at the target and climbs
      // to order-book walls the price moves past.
      plans.push(...huntExit(t, ud, other, entry, tpPx, s.now, cfg, tick, 'underdog_trail', notes));
    } else if (ud.quote.bid !== undefined && ud.quote.bid >= tpPx - 1e-9) {
      // The bounce already went past the target: take the profit at the bid now.
      plans.push({ ticker: ud.ticker, side: 'ask', price: ud.quote.bid, count: ud.position, postOnly: false, reduceOnly: true, timeInForce: 'immediate_or_cancel', leg: 'underdog_tp', why: `underdog bid ${ud.quote.bid} >= take-profit ${round(tpPx, 2)} (entry ${round(entry, 3)})` });
    } else {
      plans.push({ ticker: ud.ticker, side: 'ask', price: round(tpPx, 4), count: ud.position, postOnly: true, reduceOnly: false, timeInForce: 'good_till_canceled', leg: 'underdog_tp', why: `underdog take-profit ${round(tpPx, 2)} (entry ${round(entry, 3)})` });
    }
    if (cfg.underdogStopCents > 0 && ud.quote.bid !== undefined && ud.quote.bid <= entry - cfg.underdogStopCents) {
      plans.length = 0;
      plans.push({ ticker: ud.ticker, side: 'ask', price: ud.quote.bid, count: ud.position, postOnly: false, reduceOnly: true, timeInForce: 'immediate_or_cancel', leg: 'underdog_stop', why: `underdog stop ${ud.quote.bid}` });
    }
    return { phase, plans, notes };
  }
  if (t.underdogEntered && (!ud || ud.position <= 0)) t.underdogClosed = true;

  // ---- Underdog entry ---------------------------------------------------------
  if (phase === 'underdog_window' && !t.underdogEntered && held.length === 0) {
    const side: 'a' | 'b' = pA < 0.5 ? 'a' : 'b';
    const pU = pSide(side);
    const m = marketFor(side);
    if (pU > cfg.underdogMax) notes.push(`not skewed enough: underdog ${pU.toFixed(2)} > ${cfg.underdogMax}`);
    else if (pU < cfg.underdogMin) notes.push(`underdog ${pU.toFixed(2)} below ${cfg.underdogMin}: too long a shot`);
    else if (!m) notes.push('underdog market not listed');
    else {
      // Entry confirmation: the tennis confluence must be leaning toward the underdog.
      const pre = t.liveSince === undefined;
      const sig = tennisConfluence(t, m, s.markets.find((x) => x.ticker !== m.ticker), s.now, cfg);
      t.signals.set(m.ticker, sig);
      const need = pre ? cfg.entryMinSignalsPre : cfg.entryMinSignalsLive;
      // Early is what matters: full size before the start and in the first minutes, tapering after.
      const minIn = pre ? 0 : (s.now - t.liveSince!) / 60_000;
      const span = Math.max(1e-9, cfg.entryWindowMin - cfg.earlyFullSizeMin);
      const early = minIn <= cfg.earlyFullSizeMin ? 1 : Math.max(0.5, 1 - (0.5 * (minIn - cfg.earlyFullSizeMin)) / span);
      const px = makerBid(m.quote, tick, cfg.maxSpread);
      const n = px ? Math.floor(tennisSize(px, cfg, budget) * early * 100) / 100 : 0;
      if (sig.score < need) notes.push(`underdog entry waits for confluence: ${sig.score}/4 < ${need} (${pre ? 'pre-match' : 'live'})`);
      else if (!px) notes.push('underdog book too wide or one-sided');
      else if (n <= 0) notes.push('tennis budget exhausted');
      else {
        t.underdogTicker = m.ticker;
        plans.push({ ticker: m.ticker, side: 'bid', price: px, count: n, postOnly: true, reduceOnly: false, timeInForce: 'good_till_canceled', leg: 'underdog_entry', why: `underdog ${pU.toFixed(2)} vs favorite ${(1 - pU).toFixed(2)}, confluence ${sig.score}/4, ${pre ? 'pre-match' : `${minIn.toFixed(0)} min in`}${early < 1 ? `, size x${early.toFixed(2)}` : ''}` });
      }
    }
    return { phase, plans, notes };
  }

  // ---- Favorite: open position (optional stop) ----------------------------------
  // Any position held after the underdog trade is closed is the favorite trade (possibly on the
  // same player, if the underdog became the leader).
  const fav = held.find((m) => t.underdogClosed || m.ticker !== t.underdogTicker);
  if (fav) {
    t.favEntered = true;
    if (cfg.favStopCents > 0 && fav.avgEntry !== undefined && fav.quote.bid !== undefined && fav.quote.bid <= fav.avgEntry - cfg.favStopCents && !t.armed.has(fav.ticker)) {
      plans.push({ ticker: fav.ticker, side: 'ask', price: fav.quote.bid, count: fav.position, postOnly: false, reduceOnly: true, timeInForce: 'immediate_or_cancel', leg: 'fav_stop', why: `favorite stop ${fav.quote.bid}` });
    } else if (cfg.trail && fav.avgEntry !== undefined) {
      const target = floorToTick(Math.min(cfg.favTrailCap, fav.avgEntry + cfg.favTrailCents) + tick - 1e-9, tick);
      plans.push(...huntExit(t, fav, s.markets.find((x) => x.ticker !== fav.ticker), fav.avgEntry, target, s.now, cfg, tick, 'fav_trail', notes));
    }
    return { phase, plans, notes };
  }

  // ---- Favorite re-entry after half the match ------------------------------------
  if (phase === 'late' && !t.favEntered && held.length === 0) {
    const side: 'a' | 'b' = pA >= 0.5 ? 'a' : 'b';
    const pL = pSide(side);
    const m = marketFor(side);
    const chg = t.change(side, s.now);
    if (pL < cfg.favMin || pL > cfg.favMax) notes.push(`leader ${pL.toFixed(2)} outside [${cfg.favMin}, ${cfg.favMax}]`);
    else if (chg === undefined) notes.push('leader stability unknown (need 5 min of prices)');
    else if (chg < -cfg.favStableCents) notes.push(`leader slipping ${(chg * 100).toFixed(1)}c over 5 min`);
    else if (!m) notes.push('leader market not listed');
    else {
      const sig = tennisConfluence(t, m, s.markets.find((x) => x.ticker !== m.ticker), s.now, cfg);
      t.signals.set(m.ticker, sig);
      const px = makerBid(m.quote, tick, cfg.maxSpread);
      const n = px ? tennisSize(px, cfg, budget) : 0;
      if (sig.score < cfg.favEntryMinSignals) notes.push(`favorite entry waits for confluence: ${sig.score}/4 < ${cfg.favEntryMinSignals}`);
      else if (!px) notes.push('leader book too wide or one-sided');
      else if (n <= 0) notes.push('tennis budget exhausted');
      else plans.push({ ticker: m.ticker, side: 'bid', price: px, count: n, postOnly: true, reduceOnly: false, timeInForce: 'good_till_canceled', leg: 'fav_entry', why: `leader ${pL.toFixed(2)} at ${(t.progress(s.now, s.markets) * 100).toFixed(0)}% of the match` });
    }
  }
  return { phase, plans, notes };
}
