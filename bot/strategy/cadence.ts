// Relaxed decision cadence (relaxed-cadence spec). Entries and quote changes
// are decided on each 1-minute bar close of the index, or earlier when fair
// value moves >= evalFvMove since the last evaluation, the book moves through
// a resting quote, the entry window opens/closes, or a resting quote is due
// for its re-price. Never more than once per contract per minIntervalSec
// (except when the entry window closes, which must pull quotes at once).
// Exits are checked every tick regardless: a cadence is for entries, not for
// risk reduction. Shared by the engine and the backtester.

export interface CadenceParams {
  cadence: 'relaxed' | 'continuous';
  evalBarSec: number;
  evalFvMove: number;
  repriceSec: number;
  minEvalIntervalSec: number;
}

export interface CadenceInput {
  now: number;
  fairValue: number;
  entryWindowOpen: boolean;
  /** A resting quote exists. */
  hasResting: boolean;
  /** The book has moved through a resting quote's re-price bounds. */
  bookThroughQuote: boolean;
  /** Position changed since the last evaluation (a fill): re-evaluate now so a take-profit rests at once. */
  positionChanged?: boolean;
}

export type CadenceReason = 'first' | 'bar' | 'fv_move' | 'window' | 'position' | 'book' | 'reprice' | 'continuous';

interface Last { ts: number; fv: number; bar: number; window: boolean }

export class CadenceGate {
  private readonly last = new Map<string, Last>();
  constructor(private readonly p: CadenceParams) {}

  /** Whether to run a full (entry + quote) evaluation now, and why. */
  check(ticker: string, i: CadenceInput): CadenceReason | undefined {
    const bar = Math.floor(i.now / (this.p.evalBarSec * 1000));
    const l = this.last.get(ticker);
    const reason = ((): CadenceReason | undefined => {
      if (this.p.cadence === 'continuous') return 'continuous';
      if (!l) return 'first';
      if (l.window !== i.entryWindowOpen) return 'window';
      if (i.positionChanged) return 'position';
      if (i.now - l.ts < this.p.minEvalIntervalSec * 1000) return undefined;
      if (bar > l.bar) return 'bar';
      if (Math.abs(i.fairValue - l.fv) >= this.p.evalFvMove - 1e-12) return 'fv_move';
      if (i.bookThroughQuote) return 'book';
      if (i.hasResting && i.now - l.ts >= this.p.repriceSec * 1000) return 'reprice';
      return undefined;
    })();
    if (reason) this.last.set(ticker, { ts: i.now, fv: i.fairValue, bar, window: i.entryWindowOpen });
    return reason;
  }

  forget(ticker: string): void { this.last.delete(ticker); }
}

/** Entry window by contract kind: [earliest, latest] seconds before close. */
export function inEntryWindow(kind: string, tauSec: number, w15: [number, number], wHourly: [number, number]): boolean {
  const [earliest, latest] = kind === 'updown' ? w15 : wHourly;
  return tauSec <= earliest && tauSec >= latest;
}
