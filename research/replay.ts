// Replays recorded market data (data/recordings/md-YYYY-MM-DD.jsonl) in time
// order and maintains the same IndexTracker / OrderBook state production uses.
// Research code never imports the OMS or the Kalshi order client.

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { IndexTracker } from '../bot/marketdata/indexTracker';
import { OrderBook } from '../bot/marketdata/orderBook';
import { FeatureHub } from '../bot/model/featureEngine';
import { contractKind, type ContractTerms, type MarketKind } from '../bot/model/fairValue';

export interface RecMarket {
  ticker: string;
  series: string;
  asset: string;
  openTime: number;
  closeTime: number;
  strike?: number;
  cap?: number;
  kind: MarketKind;
  event?: string;
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
  readonly spot = new Map<string, IndexTracker>();
  readonly usdtd = new IndexTracker('USDT.D', 90 * 60_000, 300);
  readonly btcd = new IndexTracker('BTC.D', 90 * 60_000, 300);
  /** Same feature state machine production uses (MarketData.features). */
  readonly features = new FeatureHub();
  now = 0;

  apply(e: RecEvent): void {
    this.now = e.t;
    switch (e.k) {
      case 'market':
        this.markets.set(e.ticker, {
          ticker: e.ticker, series: e.series, asset: e.asset, openTime: e.openTime, closeTime: e.closeTime, strike: e.strike ?? undefined, cap: e.cap ?? undefined,
          kind: e.kind ?? contractKind(e.series ?? ''), event: e.event ?? undefined, tickSize: e.tickSize ?? 0.01,
        });
        break;
      case 'index': {
        let tr = this.index.get(e.asset);
        if (!tr) { tr = new IndexTracker(e.asset); this.index.set(e.asset, tr); }
        tr.add(e.value, e.ts ?? e.t);
        this.features.onIndex(e.asset, e.value, e.ts ?? e.t);
        break;
      }
      case 'dominance':
        this.usdtd.add(e.usdtd, e.ts ?? e.t);
        this.btcd.add(e.btcd, e.ts ?? e.t);
        break;
      case 'spot': {
        let tr = this.spot.get(e.asset);
        if (!tr) { tr = new IndexTracker(e.asset); this.spot.set(e.asset, tr); }
        tr.add(e.value, e.ts ?? e.t);
        break;
      }
      case 'book': {
        const b = this.book(e.ticker);
        b.applySnapshot({ bids: e.bids ?? [], asks: e.asks ?? [] }, e.t);
        this.features.onBook(e.ticker, b, e.t);
        break;
      }
      case 'delta': {
        const b = this.book(e.ticker);
        b.applyDelta(e.side, e.price, e.delta, e.t);
        this.features.onBook(e.ticker, b, e.t);
        break;
      }
      case 'trade':
        this.features.onTrade(e.ticker, e.count, e.takerSide, e.ts ?? e.t);
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
    if (m.kind !== 'updown') return undefined;
    const a = this.index.get(m.asset)?.average(m.openTime - 60_000, m.openTime, 3000);
    if (a) m.strike = a.avg;
    return m.strike;
  }

  /** Pricing terms, mirroring MarketData.termsFor. */
  terms(m: RecMarket): ContractTerms | undefined {
    if (m.kind === 'updown') { const k = this.strike(m); return k ? { kind: 'updown', strike: k } : undefined; }
    if (m.kind === 'less') return m.cap ? { kind: 'less', cap: m.cap } : undefined;
    if (m.kind === 'between') return m.strike && m.cap ? { kind: 'between', strike: m.strike, cap: m.cap } : undefined;
    return m.strike ? { kind: 'greater', strike: m.strike } : undefined;
  }

  /** Official result if recorded, else computed from the recorded index. */
  outcome(m: RecMarket): { label: 0 | 1; source: 'official' | 'computed' } | undefined {
    const r = this.results.get(m.ticker);
    if (r) return { label: r === 'yes' ? 1 : 0, source: 'official' };
    const t = this.terms(m);
    const a = this.index.get(m.asset)?.average(m.closeTime - 60_000, m.closeTime, 3000);
    if (!t || !a) return undefined;
    const A = a.avg;
    const yes = t.kind === 'less' ? A < t.cap! : t.kind === 'between' ? A >= t.strike! && A < t.cap! : A >= t.strike!;
    return { label: yes ? 1 : 0, source: 'computed' };
  }
}
