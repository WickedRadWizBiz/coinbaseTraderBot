// Entry curve: the order-book curve the profit exits use (bot/strategy/sinuousExit.ts), followed for every crypto
// market the bot quotes, so a resting maker bid is not left where the market is about to run through it.
//
// A resting bid fills when the price moves through it, so the fills that come fastest are the ones the market is
// moving against: a minute after a maker fill the market sat about 1.5c below the price paid (Oct 20-22). The curve
// (a Kalman / Ornstein-Uhlenbeck filter on the YES micro-price, in logit terms) has a slope. A bid for YES is against
// the curve when it falls faster than SINUOUS_ENTRY_SLOPE_CENTS a 10 seconds (0.5c); a bid for NO (a YES ask) when it
// rises faster. Slower, or while the curve warms up, nothing is against it. The filter damps its slope against book
// noise: a steady slide of 1c a 10 s reads about 0.4c on a 15-minute contract and 0.6c on an hourly one.
//
// SINUOUS_ENTRY=monitor (default) blocks nothing. Every maker fill that adds to a position is tagged with the curve's
// slope at that moment and scored by its 60 s markout (the mid then, in the side's terms, minus the price paid): the
// fills the gate would have blocked against the ones it would have kept, at the configured slope and a few others, so
// the threshold can be chosen from live results before the gate blocks anything. gate: a quote that adds to a position
// is not placed while the curve is against its side, and a resting one is pulled. off.

import type { BookLevel } from '../kalshi/types';
import { readJson, writeJsonAtomic } from '../util/persist';
import { SinuousExitTracker, type CurveProfile } from './sinuousExit';

export interface SinuousEntryParams {
  mode: 'gate' | 'monitor' | 'off';
  /** Curve slope against the side (dollars a 10 seconds) that counts as against it. */
  slope: number;
}

export const DEFAULT_SINUOUS_ENTRY: SinuousEntryParams = { mode: 'monitor', slope: 0.005 };

/** Seconds after a fill its markout is read. */
const MARKOUT_SEC = 60;
/** A markout is read from a book seen at most this long ago; a fill whose market goes unseen for STALE_MS after its
 *  markout fell due is dropped unscored (the market closed or left the catalog). */
const FRESH_MS = 5000;
const STALE_MS = 5 * 60_000;
/** Fills waiting for their markout, at most. */
const MAX_PENDING = 500;
/** Scored fills kept (most recent). */
const WINDOW = 2000;
/** Slopes (cents a 10 s) the scoreboard also reports, to choose SINUOUS_ENTRY_SLOPE_CENTS from. */
const SLOPES_CENTS = [0.25, 0.5, 1, 2];

export interface EntryVerdict {
  /** The curve's slope in the terms of the side being bought, dollars a 10 seconds (negative = against it). */
  slope?: number;
  against: boolean;
}

/** One scored fill: the curve's slope for the side at the fill (cents a 10 s, side terms), its 60 s markout a contract
 *  (dollars, side terms) and its contracts. */
interface Scored { d: number; m: number; c: number }
interface Pending { ticker: string; side: 'bid' | 'ask'; price: number; count: number; d: number | undefined; ts: number }
interface SavedState { results: Scored[]; since: number }

export interface EntryGroup { fills: number; contracts: number; markoutCents: number | null }

export interface SinuousEntryStatus {
  mode: SinuousEntryParams['mode'];
  slopeCents: number;
  /** At the configured slope: maker entry fills it would have blocked vs kept, with their average 60 s markout. */
  blocked: EntryGroup;
  kept: EntryGroup;
  /** The same split at other slopes. */
  bySlope: Array<{ slopeCents: number; blocked: EntryGroup; kept: EntryGroup }>;
  /** Fills scored without a curve reading (warming up). */
  unread: number;
  pending: number;
  since: number;
  tracking: number;
}

/** YES-terms slope, turned into the terms of the side a bid buys: a YES bid buys YES, a YES ask buys NO. */
const sideSlope = (yesSlope: number, side: 'bid' | 'ask') => (side === 'bid' ? yesSlope : -yesSlope);

export class SinuousEntryGate {
  private readonly trackers = new Map<string, { t: SinuousExitTracker; seen: number; mid?: number }>();
  private readonly pending: Pending[] = [];
  private unread = 0;
  private st: SavedState;

  constructor(readonly p: SinuousEntryParams, private readonly file?: string, now = Date.now()) {
    const saved = file ? readJson<SavedState>(file, { quarantine: true }) : undefined;
    this.st = saved && Array.isArray(saved.results) ? saved : { results: [], since: now };
  }

  /** Blocking quotes now (gate mode). */
  get active(): boolean { return this.p.mode === 'gate'; }

  /** Feed one tick of a market's book (YES terms); scores the fills whose markout is due. */
  observe(ticker: string, profile: CurveProfile, o: { now: number; bid?: BookLevel; ask?: BookLevel; tauSec?: number }): void {
    let k = this.trackers.get(ticker);
    if (!k || k.t.profile !== profile) {
      k = { t: new SinuousExitTracker(profile), seen: o.now };
      this.trackers.set(ticker, k);
    }
    k.seen = o.now;
    k.t.update({ now: o.now, sign: 1, bid: o.bid, ask: o.ask, entrySidePrice: 0, entryFeePer: 0, exitFeePer: 0, tauSec: o.tauSec, minNetProfit: 0 });
    k.mid = o.bid && o.ask ? (o.bid.price + o.ask.price) / 2 : undefined;
    this.score(o.now);
    if (this.trackers.size > 256) for (const [t, x] of this.trackers) if (o.now - x.seen > 600_000) this.trackers.delete(t);
  }

  /** Is the curve against buying this side now? */
  verdict(ticker: string, side: 'bid' | 'ask'): EntryVerdict {
    const yes = this.trackers.get(ticker)?.t.slope();
    if (yes === undefined) return { against: false };
    const slope = sideSlope(yes, side) * 10;
    return { slope, against: slope <= -this.p.slope + 1e-12 };
  }

  /** A maker fill that added to a position: remembered with the curve's projection, scored once its markout is due. */
  onEntryFill(f: { ticker: string; side: 'bid' | 'ask'; price: number; count: number; ts: number }): void {
    if (this.p.mode === 'off' || !(f.count > 0)) return;
    const v = this.verdict(f.ticker, f.side);
    this.pending.push({ ...f, d: v.slope === undefined ? undefined : v.slope * 100 });
    if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
  }

  status(): SinuousEntryStatus {
    const r = this.st.results;
    const split = (slopeCents: number) => {
      const b = r.filter((x) => x.d <= -slopeCents + 1e-9), k = r.filter((x) => x.d > -slopeCents + 1e-9);
      return { slopeCents, blocked: group(b), kept: group(k) };
    };
    const at = split(+(this.p.slope * 100).toFixed(4));
    return {
      mode: this.p.mode, slopeCents: at.slopeCents, blocked: at.blocked, kept: at.kept, bySlope: SLOPES_CENTS.map(split),
      unread: this.unread, pending: this.pending.length, since: this.st.since, tracking: this.trackers.size,
    };
  }

  reset(now = Date.now()): void {
    this.st = { results: [], since: now };
    this.unread = 0;
    this.save();
  }

  /** Score each pending fill whose 60 s are up, at its market's latest mid. */
  private score(now: number): void {
    let changed = false;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const f = this.pending[i];
      if (now - f.ts < MARKOUT_SEC * 1000) continue;
      const k = this.trackers.get(f.ticker);
      if (!k || k.mid === undefined || now - k.seen > FRESH_MS) {
        if (now - f.ts > MARKOUT_SEC * 1000 + STALE_MS) this.pending.splice(i, 1);
        continue;
      }
      this.pending.splice(i, 1);
      if (f.d === undefined) { this.unread++; continue; }
      const m = f.side === 'bid' ? k.mid - f.price : f.price - k.mid;
      this.st.results.push({ d: +f.d.toFixed(3), m: +m.toFixed(4), c: f.count });
      changed = true;
    }
    if (!changed) return;
    if (this.st.results.length > WINDOW) this.st.results.splice(0, this.st.results.length - WINDOW);
    this.save();
  }

  private save(): void {
    if (this.file) writeJsonAtomic(this.file, this.st);
  }
}

function group(xs: Scored[]): EntryGroup {
  const contracts = xs.reduce((a, x) => a + x.c, 0);
  return { fills: xs.length, contracts: +contracts.toFixed(2), markoutCents: contracts > 0 ? +((xs.reduce((a, x) => a + x.m * x.c, 0) / contracts) * 100).toFixed(3) : null };
}
