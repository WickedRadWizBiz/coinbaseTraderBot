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
import { floorToTick, round } from '../util/num';

export interface Quote { bid?: number; ask?: number; bidSize?: number; askSize?: number }

export interface MatchMarket { ticker: string; title?: string; quote: Quote; position: number; avgEntry?: number }

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
  leg: 'underdog_entry' | 'underdog_tp' | 'underdog_stop' | 'fav_entry' | 'fav_stop';
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
  private history: Array<{ ts: number; p: number }> = [];

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
    if (ud.quote.bid !== undefined && ud.quote.bid >= tpPx - 1e-9) {
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
      const px = makerBid(m.quote, tick, cfg.maxSpread);
      const n = px ? tennisSize(px, cfg, budget) : 0;
      if (!px) notes.push('underdog book too wide or one-sided');
      else if (n <= 0) notes.push('tennis budget exhausted');
      else {
        t.underdogTicker = m.ticker;
        plans.push({ ticker: m.ticker, side: 'bid', price: px, count: n, postOnly: true, reduceOnly: false, timeInForce: 'good_till_canceled', leg: 'underdog_entry', why: `underdog ${pU.toFixed(2)} vs favorite ${(1 - pU).toFixed(2)}` });
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
    if (cfg.favStopCents > 0 && fav.avgEntry !== undefined && fav.quote.bid !== undefined && fav.quote.bid <= fav.avgEntry - cfg.favStopCents) {
      plans.push({ ticker: fav.ticker, side: 'ask', price: fav.quote.bid, count: fav.position, postOnly: false, reduceOnly: true, timeInForce: 'immediate_or_cancel', leg: 'fav_stop', why: `favorite stop ${fav.quote.bid}` });
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
      const px = makerBid(m.quote, tick, cfg.maxSpread);
      const n = px ? tennisSize(px, cfg, budget) : 0;
      if (!px) notes.push('leader book too wide or one-sided');
      else if (n <= 0) notes.push('tennis budget exhausted');
      else plans.push({ ticker: m.ticker, side: 'bid', price: px, count: n, postOnly: true, reduceOnly: false, timeInForce: 'good_till_canceled', leg: 'fav_entry', why: `leader ${pL.toFixed(2)} at ${(t.progress(s.now, s.markets) * 100).toFixed(0)}% of the match` });
    }
  }
  return { phase, plans, notes };
}
