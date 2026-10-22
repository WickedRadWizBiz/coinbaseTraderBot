// High-water marks for the take-profit (strategy/fairValueStrategy.ts): for each held binary contract, the best price
// its side could have been sold at (the YES bid for YES held, the NO bid = 1 - YES ask for NO held) since the position
// was opened, reversed or added to. A reduction keeps it, so a partly filled take-profit goes on selling the rest.
// Shared by the engine and the backtest; not persisted (after a restart the mark starts again at the current bid).

export class ProfitPeaks {
  private readonly m = new Map<string, { sign: number; size: number; peak: number }>();

  /** Record this tick and return the mark (undefined while flat). */
  update(ticker: string, position: number, sideBid: number | undefined): number | undefined {
    if (position === 0) { this.m.delete(ticker); return undefined; }
    const sign = Math.sign(position), size = Math.abs(position);
    const p = this.m.get(ticker);
    if (p && p.sign === sign && size <= p.size + 1e-9) {
      p.size = size;
      if (sideBid !== undefined && sideBid > p.peak) p.peak = sideBid;
      return p.peak;
    }
    if (sideBid === undefined) { this.m.delete(ticker); return undefined; }
    this.m.set(ticker, { sign, size, peak: sideBid });
    return sideBid;
  }

  forget(ticker: string): void { this.m.delete(ticker); }
}
