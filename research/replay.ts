// Replays recorded market data (data/recordings/md-YYYY-MM-DD.jsonl) in time
// order and maintains the same IndexTracker / OrderBook state production uses.
// Research code never imports the OMS or the Kalshi order client.

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { IndexTracker } from '../bot/marketdata/indexTracker';
import { OrderBook } from '../bot/marketdata/orderBook';

export interface RecMarket {
  ticker: string;
  series: string;
  asset: string;
  openTime: number;
  closeTime: number;
  strike?: number;
  tickSize: number;
}

export interface RecEvent { t: number; k: string; [key: string]: any }

export async function* readRecordings(dir: string): AsyncGenerator<RecEvent> {
  const files = fs.readdirSync(dir).filter((f) => /^md-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  for (const f of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, f)), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      try { yield JSON.parse(line) as RecEvent; } catch { /* torn line */ }
    }
  }
}

export class ReplayState {
  readonly markets = new Map<string, RecMarket>();
  readonly books = new Map<string, OrderBook>();
  readonly index = new Map<string, IndexTracker>();
  readonly results = new Map<string, 'yes' | 'no'>();
  now = 0;

  apply(e: RecEvent): void {
    this.now = e.t;
    switch (e.k) {
      case 'market':
        this.markets.set(e.ticker, { ticker: e.ticker, series: e.series, asset: e.asset, openTime: e.openTime, closeTime: e.closeTime, strike: e.strike, tickSize: e.tickSize ?? 0.01 });
        break;
      case 'index': {
        let tr = this.index.get(e.asset);
        if (!tr) { tr = new IndexTracker(e.asset, 30 * 60_000); this.index.set(e.asset, tr); }
        tr.add(e.value, e.ts ?? e.t);
        break;
      }
      case 'book':
        this.book(e.ticker).applySnapshot({ bids: e.bids ?? [], asks: e.asks ?? [] }, e.t);
        break;
      case 'delta':
        this.book(e.ticker).applyDelta(e.side, e.price, e.delta, e.t);
        break;
      case 'result':
        this.results.set(e.ticker, e.result);
        break;
      case 'lifecycle':
        if (e.result === 'yes' || e.result === 'no') this.results.set(e.ticker, e.result);
        break;
    }
  }

  book(t: string): OrderBook {
    let b = this.books.get(t);
    if (!b) { b = new OrderBook(t); this.books.set(t, b); }
    return b;
  }

  strike(m: RecMarket): number | undefined {
    if (m.strike) return m.strike;
    const a = this.index.get(m.asset)?.average(m.openTime - 60_000, m.openTime, 3000);
    if (a) m.strike = a.avg;
    return m.strike;
  }

  /** Official result if recorded, else computed from the recorded index. */
  outcome(m: RecMarket): { label: 0 | 1; source: 'official' | 'computed' } | undefined {
    const r = this.results.get(m.ticker);
    if (r) return { label: r === 'yes' ? 1 : 0, source: 'official' };
    const k = this.strike(m);
    const a = this.index.get(m.asset)?.average(m.closeTime - 60_000, m.closeTime, 3000);
    if (!k || !a) return undefined;
    return { label: a.avg >= k ? 1 : 0, source: 'computed' };
  }
}
