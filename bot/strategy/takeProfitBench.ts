// Take-profit bench (the owner, Oct 24: "Yes" to putting the trailing take-profit on the exit curve's scoreboard and
// bench). On Oct 23-24 the take-profit sold about 4,700 contracts at +5 to +8c a contract that settlement paid more
// for: $230 less than holding them, $205 of it on Oct 24 (deploy/pnl_report.py, exit fills by reason).
//
// Each crypto take-profit sale that fills (bot/strategy/fairValueStrategy.ts, the exits whose reason starts with
// 'take-profit') is remembered with its net price a contract (the side's price less the sale's fee), and a market's
// sales are scored together when it settles: (net sale price - payout) x contracts, the payout 1 if the side held won,
// else 0 (what holding to settlement paid instead). The scoreboard benches the take-profit under the exit curve's rule
// (bot/strategy/sinuousExit.ts): a net cost of PROBATION_MAX_LOSS_USD ($25), or after SINUOUS_BENCH_MIN_EXITS (30)
// scored markets a negative net with t <= -SINUOUS_BENCH_T (2). Benched, the take-profit stops selling (winners ride
// to the model exit, the ratchet stop or settlement) until a reset (the dashboard's Reset, POST /api/take-profit/reset).
// TAKE_PROFIT_BENCH=false keeps the scoreboard without ever benching. Paper and live alike, each book its own
// scoreboard (DATA_DIR and DATA_DIR/live); it starts empty.
//
// Since Oct 31 (Steven: "Anything benched needs to be reworked ... rather than bench them") the rule no longer benches: a
// rejected window makes the take-profit one LEVEL stricter (bot/strategy/levelLadder.ts), and a winning window at a raised
// level steps it back. From level 1 the take-profit sells only while the coin's spot fair value of the side is at most the
// net bid plus the level's margin (TP_FV_MARGINS, bot/strategy/fairValueStrategy.ts): the Oct 23-24 losses were winners
// sold at +5-8c that the coin said were worth far more. TAKE_PROFIT_BENCH=false holds the level at TP_LEVEL (0 unless set);
// TP_LEVEL pins it either way (the lab's arms). A bench saved before this comes back as level 1 with a fresh window.

import type { ProbationParams } from '../risk/probation';
import { readJson, writeJsonAtomic } from '../util/persist';
import { LevelLadder } from './levelLadder';
import { scoreStats } from './scoreStats';

/** A sale whose market has not settled this long after it (dropped from the scan) is forgotten. */
const SALE_MAX_AGE_MS = 3 * 3_600_000;

export interface TakeProfitBenchEvent { event: 'scored' | 'benched' | 'reset' | 'stricter' | 'looser'; ticker?: string; [k: string]: unknown }

interface Sale { ticker: string; sign: 1 | -1; exitNet: number; count: number; ts: number }
interface SavedState { results: number[]; since: number; level: number; benched?: { at: number; reason: string }; sales: Sale[] }

export interface TakeProfitBenchStatus {
  /** Benches itself when the rule trips (TAKE_PROFIT_BENCH); false = scores only. */
  enforce: boolean;
  /** Never set any more (a trip raises the level instead); kept for the dashboard. */
  benched: { at: number; reason: string } | null;
  /** The strictness level in force (0 = no fair-value confirm) and whether a setting pins it. */
  level: number;
  levelPinned: boolean;
  /** Scores only: the step it would have taken. */
  wouldBench: string | null;
  /** Markets scored, and what the sales made against holding to settlement in total. */
  scored: number;
  netUsd: number;
  t: number | null;
  since: number;
  /** Sales waiting for their market's result. */
  pending: number;
  benchRule: { t: number; minExits: number; maxLossUsd: number };
}

export class TakeProfitBench {
  private st: SavedState;
  private readonly ladder: LevelLadder;

  constructor(
    readonly enforce: boolean,
    private readonly bench: Pick<ProbationParams, 'minTrades' | 't' | 'maxLossUsd' | 'window'>,
    private readonly file?: string,
    private readonly onEvent?: (e: TakeProfitBenchEvent) => void,
    now = Date.now(),
    /** TP_LEVEL (a level >= 0 pins it; -1 or undefined: the ladder decides while enforcing, else 0), TP_LEVEL_MAX. */
    level: { pinned?: number; max?: number } = {},
  ) {
    const pinned = level.pinned !== undefined && level.pinned >= 0 ? level.pinned : enforce ? undefined : 0;
    this.ladder = new LevelLadder(bench, level.max ?? 4, pinned);
    const saved = file ? readJson<SavedState>(file, { quarantine: true }) : undefined;
    if (saved && Array.isArray(saved.results)) {
      const sales = Array.isArray(saved.sales) ? saved.sales : [];
      // A bench saved before the ladder: one level stricter, a fresh window.
      this.st = saved.benched ? { results: [], since: now, level: Math.max(1, saved.level || 0), sales } : { ...saved, level: saved.level || 0, sales };
      if (saved.benched) this.save();
    } else this.st = { results: [], since: now, level: 0, sales: [] };
  }

  /** Never benched any more (Oct 31): the take-profit always sells, at its level's strictness. */
  get benched(): string | undefined { return undefined; }

  /** The strictness level in force (bot/strategy/levelLadder.ts). */
  get level(): number { return this.ladder.level(this.st); }

  /** A take-profit sale filled: `count` contracts of the side held (`sign`: 1 YES, -1 NO) sold at `sidePrice`, paying
   *  `exitFeePer` a contract. Remembered (across restarts) until its market settles. */
  filled(ticker: string, sign: 1 | -1, sidePrice: number, count: number, exitFeePer: number, now: number): void {
    if (!(count > 0)) return;
    this.st.sales = this.st.sales.filter((x) => now - x.ts <= SALE_MAX_AGE_MS);
    this.st.sales.push({ ticker, sign, exitNet: +(sidePrice - exitFeePer).toFixed(6), count, ts: now });
    this.save();
  }

  /** The market settled: its sales are one result, what they made against holding to settlement. */
  settled(ticker: string, result: 'yes' | 'no', now: number): void {
    const mine = this.st.sales.filter((x) => x.ticker === ticker);
    if (!mine.length) return;
    this.st.sales = this.st.sales.filter((x) => x.ticker !== ticker);
    const usd = mine.reduce((a, x) => a + (x.exitNet - ((x.sign > 0) === (result === 'yes') ? 1 : 0)) * x.count, 0);
    this.onEvent?.({ event: 'scored', ticker, usd: +usd.toFixed(4), result, sales: mine.length, contracts: +mine.reduce((a, x) => a + x.count, 0).toFixed(2), level: this.level });
    const move = this.ladder.record(this.st, usd, now, 'take-profit sales (against holding to settlement)');
    if (move) this.onEvent?.({ ...move });
    this.save();
  }

  /** Clear the scoreboard and lift a bench; sales still waiting for their market's result stay. */
  reset(now = Date.now()): void {
    this.st = { results: [], since: now, level: 0, sales: this.st.sales };
    this.save();
    this.onEvent?.({ event: 'reset' });
  }

  status(): TakeProfitBenchStatus {
    const s = scoreStats(this.st.results);
    return {
      enforce: this.enforce, benched: null, level: this.level, levelPinned: this.ladder.pinned !== undefined,
      wouldBench: this.ladder.pinned !== undefined ? this.verdict() ?? null : null,
      scored: this.st.results.length, netUsd: +s.sum.toFixed(2), t: s.t === null ? null : +s.t.toFixed(2), since: this.st.since,
      pending: this.st.sales.length, benchRule: { t: this.bench.t, minExits: this.bench.minTrades, maxLossUsd: this.bench.maxLossUsd },
    };
  }

  private verdict(): string | undefined {
    return this.ladder.verdict(this.st.results, 'take-profit sales (against holding to settlement)');
  }

  private save(): void {
    if (this.file) writeJsonAtomic(this.file, this.st);
  }
}
