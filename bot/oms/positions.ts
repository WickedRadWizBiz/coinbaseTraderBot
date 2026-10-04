// Position and PnL book. Positions change ONLY when a fill is applied (or a
// market settles). Accounting uses signed YES contracts, which is how Kalshi
// reports positions: +n = long n YES, -n = long n NO.
//
// Cash-flow convention (equivalent to Kalshi's NO pricing):
//   bid fill (buy YES at p):          cash -= count * p
//   ask fill (sell YES / buy NO at p): cash += count * p
//   settlement pays position * (1 if YES else 0)
// All PnL figures are net of fees.

import type { BookSide } from '../kalshi/types';

export interface MarketPosition {
  ticker: string;
  /** Market close time; groups correlated markets into one risk window. */
  closeTs: number;
  asset: string;
  yes: number;
  netCash: number;
  fees: number;
  settled: boolean;
  result?: 'yes' | 'no';
  /** Realized PnL once settled (net of fees). */
  realized?: number;
  settledTs?: number;
}

export interface FillLike {
  ticker: string;
  side: BookSide;
  count: number;
  price: number;
  fee: number;
}

export class PositionBook {
  private readonly markets = new Map<string, MarketPosition>();

  constructor(initial?: MarketPosition[]) {
    for (const m of initial ?? []) this.markets.set(m.ticker, { ...m });
  }

  ensure(ticker: string, meta: { closeTs?: number; asset?: string } = {}): MarketPosition {
    let m = this.markets.get(ticker);
    if (!m) {
      m = { ticker, closeTs: meta.closeTs ?? 0, asset: meta.asset ?? '', yes: 0, netCash: 0, fees: 0, settled: false };
      this.markets.set(ticker, m);
    } else {
      if (meta.closeTs && !m.closeTs) m.closeTs = meta.closeTs;
      if (meta.asset && !m.asset) m.asset = meta.asset;
    }
    return m;
  }

  applyFill(f: FillLike, meta: { closeTs?: number; asset?: string } = {}): MarketPosition {
    const m = this.ensure(f.ticker, meta);
    if (m.settled) throw new Error(`fill on settled market ${f.ticker}`);
    const signed = f.side === 'bid' ? f.count : -f.count;
    m.yes = round2(m.yes + signed);
    m.netCash -= signed * f.price;
    m.fees += f.fee;
    return m;
  }

  settle(ticker: string, result: 'yes' | 'no', ts: number): MarketPosition | undefined {
    const m = this.markets.get(ticker);
    if (!m || m.settled) return m;
    const payout = result === 'yes' ? m.yes : 0;
    m.realized = m.netCash + payout - m.fees;
    m.result = result;
    m.settled = true;
    m.settledTs = ts;
    m.netCash += payout;
    m.yes = 0;
    return m;
  }

  get(ticker: string): MarketPosition | undefined {
    return this.markets.get(ticker);
  }

  position(ticker: string): number {
    return this.markets.get(ticker)?.yes ?? 0;
  }

  open(): MarketPosition[] {
    return [...this.markets.values()].filter((m) => !m.settled && Math.abs(m.yes) > 1e-9);
  }

  /** Unsettled markets, including flat ones that carry realized cash/fees. */
  unsettled(): MarketPosition[] {
    return [...this.markets.values()].filter((m) => !m.settled);
  }

  all(): MarketPosition[] {
    return [...this.markets.values()];
  }

  /** PnL if the market settles YES / NO (net of fees). */
  static scenario(m: MarketPosition): { ifYes: number; ifNo: number } {
    return { ifYes: m.netCash + m.yes - m.fees, ifNo: m.netCash - m.fees };
  }

  /** Worst-case loss (positive number) of the current position at settlement. */
  static maxLoss(m: MarketPosition): number {
    const s = PositionBook.scenario(m);
    return Math.max(0, -Math.min(s.ifYes, s.ifNo));
  }

  /** Mark-to-market PnL at a YES mark price (net of fees paid so far). */
  static markToMarket(m: MarketPosition, yesMark: number): number {
    return m.netCash + m.yes * yesMark - m.fees;
  }

  /** Drop settled markets older than `beforeTs` to bound state size. */
  prune(beforeTs: number): void {
    for (const [k, m] of this.markets) if (m.settled && (m.settledTs ?? 0) < beforeTs) this.markets.delete(k);
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
