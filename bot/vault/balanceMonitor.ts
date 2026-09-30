// Withdrawal / deposit detection by balance reconciliation.
//
// Kalshi reports cash balance. The bot knows every cash movement its trading
// causes (fills under Kalshi's collateral model, fees, settlement payouts), so
//   unexplained = actual balance - expected balance
// is money moved in or out of the account. A negative unexplained amount is a
// withdrawal, positive a deposit. To avoid mistaking timing races (a fill or
// settlement landing between our reads) for transfers, a discrepancy is only
// booked when it is stable across two consecutive checks AND the book is
// quiet (no market awaiting settlement, no recent settlement).

export interface BalanceCheck { withdrawal?: number; deposit?: number }

export interface MonitorState { expected?: number; pendingDiff?: number }

/** Cash effect of a fill under Kalshi collateral rules (price = YES price). */
export function fillCashDelta(side: 'bid' | 'ask', count: number, price: number, fee: number, positionBefore: number): number {
  if (side === 'bid') {
    const closing = Math.min(count, Math.max(0, -positionBefore)); // closing NO frees (1 - p) each
    return closing * (1 - price) - (count - closing) * price - fee;
  }
  const closing = Math.min(count, Math.max(0, positionBefore));    // closing YES frees p each
  return closing * price - (count - closing) * (1 - price) - fee;
}

/** Settlement payout credited to the balance. */
export function settleCashDelta(positionBefore: number, result: 'yes' | 'no'): number {
  if (positionBefore > 0 && result === 'yes') return positionBefore;
  if (positionBefore < 0 && result === 'no') return -positionBefore;
  return 0;
}

export class BalanceMonitor {
  constructor(public state: MonitorState = {}, private readonly minUsd = 0.05) {}

  onCash(delta: number): void {
    if (this.state.expected !== undefined) this.state.expected = Math.round((this.state.expected + delta) * 1e6) / 1e6;
  }

  /** Compare an actual balance read. `quiet` = no settlement pending or just happened. */
  check(actual: number, quiet: boolean): BalanceCheck {
    if (this.state.expected === undefined) {
      this.state.expected = actual;
      return {};
    }
    const diff = Math.round((actual - this.state.expected) * 100) / 100;
    if (Math.abs(diff) < this.minUsd) {
      this.state.pendingDiff = undefined;
      return {};
    }
    const stable = this.state.pendingDiff !== undefined && Math.abs(this.state.pendingDiff - diff) < 0.01;
    this.state.pendingDiff = diff;
    if (!stable || !quiet) return {};
    this.state.expected = actual;
    this.state.pendingDiff = undefined;
    return diff < 0 ? { withdrawal: -diff } : { deposit: diff };
  }
}
