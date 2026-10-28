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
// The model exit and the ratchet stop (bot/strategy/exitPolicies.ts hunt mode) get the same scoreboard and bench each,
// one TakeProfitBench per kind under ExitBenches (EXIT_BENCH; the owner, Oct 28: every exit kind proves itself against
// holding, per trade). The exit curve's cross keeps its own bench (bot/strategy/sinuousExit.ts).

import type { ProbationParams } from '../risk/probation';
import { readJson, writeJsonAtomic } from '../util/persist';
import { scoreStats } from './sinuousExit';

/** A sale whose market has not settled this long after it (dropped from the scan) is forgotten. */
const SALE_MAX_AGE_MS = 3 * 3_600_000;

export interface TakeProfitBenchEvent { event: 'scored' | 'benched' | 'reset'; ticker?: string; [k: string]: unknown }

interface Sale { ticker: string; sign: 1 | -1; exitNet: number; count: number; ts: number }
interface SavedState { results: number[]; since: number; benched?: { at: number; reason: string }; sales: Sale[] }

/** The exit kinds with a scoreboard of their own, each scored against holding to settlement and benched on the same rule. */
export type ExitKind = 'take-profit' | 'model-exit' | 'ratchet-stop';
export const EXIT_KINDS: readonly ExitKind[] = ['take-profit', 'model-exit', 'ratchet-stop'];

/** The scored exit kind an exit order's reason names (bot/strategy/fairValueStrategy.ts; the engine's hunt plans), if any. */
export function scoredExitKind(why: string): ExitKind | undefined {
  if (why.startsWith('take-profit')) return 'take-profit';
  if (why.startsWith('confluence ratchet')) return 'ratchet-stop';
  if (why.includes(' - fee > q')) return 'model-exit';
  return undefined;
}

export interface TakeProfitBenchStatus {
  /** Which exit kind this scoreboard is for. */
  kind: ExitKind;
  /** Benches itself when the rule trips (TAKE_PROFIT_BENCH); false = scores only. */
  enforce: boolean;
  benched: { at: number; reason: string } | null;
  /** Scores only: the bench it would have called. */
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

  constructor(
    readonly enforce: boolean,
    private readonly bench: Pick<ProbationParams, 'minTrades' | 't' | 'maxLossUsd' | 'window'>,
    private readonly file?: string,
    private readonly onEvent?: (e: TakeProfitBenchEvent) => void,
    now = Date.now(),
    /** Which exit kind this scoreboard is for (the verdict and the status name it). */
    readonly kind: ExitKind = 'take-profit',
  ) {
    const saved = file ? readJson<SavedState>(file, { quarantine: true }) : undefined;
    this.st = saved && Array.isArray(saved.results) ? { ...saved, sales: Array.isArray(saved.sales) ? saved.sales : [] } : { results: [], since: now, sales: [] };
  }

  /** Why the take-profit is benched, or undefined while it sells. */
  get benched(): string | undefined {
    return this.enforce ? this.st.benched?.reason : undefined;
  }

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
    this.st.results.push(+usd.toFixed(4));
    if (this.st.results.length > this.bench.window) this.st.results.splice(0, this.st.results.length - this.bench.window);
    this.onEvent?.({ event: 'scored', ticker, usd: +usd.toFixed(4), result, sales: mine.length, contracts: +mine.reduce((a, x) => a + x.count, 0).toFixed(2) });
    if (this.enforce && !this.st.benched) {
      const why = this.verdict();
      if (why) {
        this.st.benched = { at: now, reason: why };
        this.onEvent?.({ event: 'benched', reason: why });
      }
    }
    this.save();
  }

  /** Clear the scoreboard and lift a bench; sales still waiting for their market's result stay. */
  reset(now = Date.now()): void {
    this.st = { results: [], since: now, sales: this.st.sales };
    this.save();
    this.onEvent?.({ event: 'reset' });
  }

  status(): TakeProfitBenchStatus {
    const s = scoreStats(this.st.results);
    return {
      kind: this.kind, enforce: this.enforce, benched: this.enforce ? this.st.benched ?? null : null, wouldBench: this.enforce ? null : this.verdict() ?? null,
      scored: this.st.results.length, netUsd: +s.sum.toFixed(2), t: s.t === null ? null : +s.t.toFixed(2), since: this.st.since,
      pending: this.st.sales.length, benchRule: { t: this.bench.t, minExits: this.bench.minTrades, maxLossUsd: this.bench.maxLossUsd },
    };
  }

  private verdict(): string | undefined {
    const r = this.st.results, s = scoreStats(r);
    if (s.sum <= -this.bench.maxLossUsd) return `${this.kind} sales cost $${(-s.sum).toFixed(2)} against holding to settlement over ${r.length} markets (limit $${this.bench.maxLossUsd})`;
    if (r.length >= this.bench.minTrades && s.sum < 0 && s.t !== null && s.t <= -this.bench.t) return `${this.kind} sales are losing beyond luck against holding to settlement: $${s.sum.toFixed(2)} over ${r.length} markets, t ${s.t.toFixed(2)}`;
    return undefined;
  }

  private save(): void {
    if (this.file) writeJsonAtomic(this.file, this.st);
  }
}

/** One scoreboard and bench per exit kind (EXIT_BENCH): the model exit's and the ratchet stop's beside the take-profit's. */
export class ExitBenches {
  private readonly by = new Map<ExitKind, TakeProfitBench>();

  constructor(benches: Iterable<TakeProfitBench>) {
    for (const b of benches) this.by.set(b.kind, b);
  }

  get(kind: ExitKind): TakeProfitBench | undefined { return this.by.get(kind); }
  kinds(): ExitKind[] { return [...this.by.keys()]; }

  /** Why `kind` is benched, or undefined while it sells (and when it has no scoreboard here). */
  benched(kind: ExitKind): string | undefined { return this.by.get(kind)?.benched; }

  filled(kind: ExitKind, ticker: string, sign: 1 | -1, sidePrice: number, count: number, exitFeePer: number, now: number): void {
    this.by.get(kind)?.filled(ticker, sign, sidePrice, count, exitFeePer, now);
  }

  /** The market settled: every kind scores its own sales in it. */
  settled(ticker: string, result: 'yes' | 'no', now: number): void {
    for (const b of this.by.values()) b.settled(ticker, result, now);
  }

  /** Clear one kind's scoreboard and lift its bench (every kind's without one); false when the kind has no scoreboard here. */
  reset(kind?: ExitKind, now = Date.now()): boolean {
    const list = kind ? [this.by.get(kind)].filter((b): b is TakeProfitBench => b !== undefined) : [...this.by.values()];
    for (const b of list) b.reset(now);
    return list.length > 0;
  }

  status(): Partial<Record<ExitKind, TakeProfitBenchStatus>> {
    const out: Partial<Record<ExitKind, TakeProfitBenchStatus>> = {};
    for (const [k, b] of this.by) out[k] = b.status();
    return out;
  }
}
