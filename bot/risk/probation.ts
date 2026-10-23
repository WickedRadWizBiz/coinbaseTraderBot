// Probation: models that have not passed their validation trade anyway (VALIDATION_GATES=monitor), and their
// book's realized results decide whether they may keep trading.
//
// A validation gate normally keeps a model out of trading until its backtest proves it (the Kalshi MLP's go-live
// gates, the take/skip head, the fill model, hunt mode in live, the perps model's full size, the setup types the
// setup model has not proven, the tennis model, the GP signals in live). In monitor mode each of those is used as
// soon as it exists, on probation: every settled Kalshi market, closed setup trade, closed perps position and settled
// tennis market of its book is one result. The book is benched (its unvalidated parts go back behind their gates,
// validated parts keep trading) when its results are unacceptable:
//   - a net loss beyond the loss limit at any time: PROBATION_MAX_LOSS_USD, or PROBATION_MAX_LOSS_PCT of the book's
//     break-even (its starting cash, moved by deposits and refills) when that is smaller, so the limit follows the
//     size of the account ($25, or 15% of a $41 account: $6.18), or
//   - after PROBATION_MIN_TRADES results, a negative net with t = mean / (sd / sqrt(n)) at or below -PROBATION_T
//     (losing by more than luck explains).
// A benched book gets a fresh probation when a new model for it is loaded (the trainer's next promotion), or from
// the dashboard. Only the most recent PROBATION_WINDOW results count. Inputs to other models (TA heads, Librarian,
// cross-asset graph and leads) are not gated here: the models that read them were trained with those gates.

import { readJson, writeJsonAtomic } from '../util/persist';

export type ProbationBook = 'kalshi' | 'perps' | 'setups' | 'tennis';
export const PROBATION_BOOKS: ProbationBook[] = ['kalshi', 'perps', 'setups', 'tennis'];

export interface ProbationParams {
  mode: 'monitor' | 'enforce';
  minTrades: number;
  /** Bench when losing with t at or below -this. */
  t: number;
  maxLossUsd: number;
  /** ...or this fraction of the book's break-even, when smaller. 0 = the dollar limit alone. */
  maxLossPct: number;
  window: number;
}

export const DEFAULT_PROBATION: ProbationParams = { mode: 'monitor', minTrades: 20, t: 1, maxLossUsd: 25, maxLossPct: 0.15, window: 200 };

interface BookState { results: number[]; since: number; benched?: { at: number; reason: string } }
type State = Record<ProbationBook, BookState>;

export interface ProbationBookStatus { trades: number; netUsd: number; t: number | null; since: number; benched: { at: number; reason: string } | null; open: boolean; maxLossUsd: number }

export class Probation {
  private st: State;
  private breakEvenOf?: (book: ProbationBook) => number | undefined;

  constructor(readonly p: ProbationParams = DEFAULT_PROBATION, private readonly file?: string, private readonly onBench?: (book: ProbationBook, reason: string) => void, now = Date.now()) {
    const saved = file ? readJson<Partial<State>>(file, { quarantine: true }) : undefined;
    this.st = Object.fromEntries(PROBATION_BOOKS.map((b) => [b, saved?.[b] ?? { results: [], since: now }])) as State;
  }

  /** Each book's break-even (main.ts: the Kalshi pool for kalshi and tennis, the perps margin for perps and setups). */
  setBreakEven(fn: (book: ProbationBook) => number | undefined): void { this.breakEvenOf = fn; }

  /** The net loss that benches the book: PROBATION_MAX_LOSS_USD, or PROBATION_MAX_LOSS_PCT of its break-even if smaller. */
  maxLoss(book: ProbationBook): number {
    const be = this.breakEvenOf?.(book);
    return this.p.maxLossPct > 0 && be !== undefined && be > 0 ? Math.min(this.p.maxLossUsd, this.p.maxLossPct * be) : this.p.maxLossUsd;
  }

  /** Apply the rules to every book still on probation: at start, once the loss limits are known, a book already past
   *  them is benched now rather than at its next result. */
  review(now = Date.now()): void {
    if (this.p.mode !== 'monitor') return;
    let changed = false;
    for (const book of PROBATION_BOOKS) {
      const b = this.st[book];
      const why = b.benched ? undefined : this.verdict(book, b.results);
      if (why) { b.benched = { at: now, reason: why }; this.onBench?.(book, why); changed = true; }
    }
    if (changed) this.save();
  }

  /** May an unvalidated part of this book trade? (A validated part always may.) */
  open(book: ProbationBook): boolean {
    return this.p.mode === 'monitor' && !this.st[book].benched;
  }

  /** Validated, or unvalidated and on an open probation. */
  passes(book: ProbationBook, validated: boolean): boolean {
    return validated || this.open(book);
  }

  /** One realized result of the book, in dollars. */
  record(book: ProbationBook, usd: number, now = Date.now()): void {
    if (this.p.mode !== 'monitor' || !Number.isFinite(usd)) return;
    const b = this.st[book];
    b.results.push(+usd.toFixed(4));
    if (b.results.length > this.p.window) b.results.splice(0, b.results.length - this.p.window);
    if (!b.benched) {
      const why = this.verdict(book, b.results);
      if (why) { b.benched = { at: now, reason: why }; this.onBench?.(book, why); }
    }
    this.save();
  }

  /** A fresh probation for the book (a new model for it, or the dashboard). */
  reset(book: ProbationBook, now = Date.now()): void {
    this.st[book] = { results: [], since: now };
    this.save();
  }

  status(): Record<ProbationBook, ProbationBookStatus> & { mode: string } {
    const out = { mode: this.p.mode } as Record<ProbationBook, ProbationBookStatus> & { mode: string };
    for (const k of PROBATION_BOOKS) {
      const b = this.st[k], s = stats(b.results);
      out[k] = { trades: b.results.length, netUsd: +s.sum.toFixed(2), t: s.t === null ? null : +s.t.toFixed(2), since: b.since, benched: b.benched ?? null, open: this.open(k), maxLossUsd: +this.maxLoss(k).toFixed(2) };
    }
    return out;
  }

  private verdict(book: ProbationBook, r: number[]): string | undefined {
    const s = stats(r);
    const cap = this.maxLoss(book);
    const limit = cap < this.p.maxLossUsd
      ? `PROBATION_MAX_LOSS_PCT (${+(this.p.maxLossPct * 100).toFixed(1)}% of the $${this.breakEvenOf!(book)!.toFixed(2)} break-even: $${cap.toFixed(2)})`
      : `PROBATION_MAX_LOSS_USD ($${this.p.maxLossUsd})`;
    if (s.sum <= -cap) return `net loss $${(-s.sum).toFixed(2)} over ${r.length} results reached ${limit}`;
    if (r.length >= this.p.minTrades && s.sum < 0 && s.t !== null && s.t <= -this.p.t) return `losing beyond luck: net $${s.sum.toFixed(2)} over ${r.length} results, t ${s.t.toFixed(2)}`;
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

// The process-wide probation (bot/main.ts sets it from the config). Unset (tests, research): enforce, the gates as before.
let active: Probation | undefined;
export function setProbation(p: Probation | undefined): void { active = p; }
export function probation(): Probation | undefined { return active; }
/** Validated, or unvalidated with this book on an open probation. */
export function gatePasses(book: ProbationBook, validated: boolean): boolean { return validated || Boolean(active?.open(book)); }
