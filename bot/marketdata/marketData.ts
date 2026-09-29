// Market data service: discovers the active 15-minute markets, maintains order
// books and the settlement index per asset, records everything to disk for
// research, and exposes freshness so the risk gateway can block on stale data.
//
// Sources:
//  - Authenticated Kalshi WebSocket (shadow/live, or paper with auth):
//    books, trades, lifecycle, fills/orders, and the CF Benchmarks index.
//  - Unauthenticated fallback (paper): REST polling of books and public
//    trades; the index then comes from the Coinbase proxy feed, which has
//    basis risk vs the RTI and is refused in live mode by config validation.

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import type { Config } from '../config';
import { DEFAULT_FEES, type FeeSchedule } from '../fees';
import type { KalshiRest } from '../kalshi/rest';
import type { KalshiWs } from '../kalshi/ws';
import type { MarketInfo } from '../kalshi/types';
import { yesPrice } from '../kalshi/wire';
import { logger } from '../util/log';
import { parseCount } from '../util/num';
import { IndexTracker } from './indexTracker';
import { OrderBook } from './orderBook';

const log = logger('marketdata');

export interface ActiveMarket extends MarketInfo {
  asset: string;
  strike?: number;
  strikeSource?: 'exchange' | 'computed';
}

export class Recorder {
  private day = '';
  private stream: fs.WriteStream | null = null;
  constructor(private readonly dir: string) { fs.mkdirSync(dir, { recursive: true }); }
  write(kind: string, data: Record<string, unknown>): void {
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.stream?.end();
      this.day = day;
      this.stream = fs.createWriteStream(path.join(this.dir, `md-${day}.jsonl`), { flags: 'a', mode: 0o600 });
    }
    this.stream!.write(JSON.stringify({ t: now, k: kind, ...data }) + '\n');
  }
  close(): void { this.stream?.end(); }
}

export class MarketData extends EventEmitter {
  readonly books = new Map<string, OrderBook>();
  readonly index = new Map<string, IndexTracker>();
  readonly markets = new Map<string, ActiveMarket>();
  private readonly fees = new Map<string, FeeSchedule>();
  private readonly feesFetchedAt = new Map<string, number>();
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly tradeCursor = new Map<string, number>();
  private proxyWs: WebSocket | null = null;
  indexSource: 'kalshi' | 'proxy' | 'none' = 'none';
  wsConnected = false;

  constructor(
    private readonly cfg: Readonly<Config>,
    private readonly rest: KalshiRest,
    private readonly ws: KalshiWs | undefined,
    private readonly recorder: Recorder,
  ) {
    super();
    for (const s of cfg.strategy.series) {
      const asset = cfg.seriesAssetMap[s];
      if (!this.index.has(asset)) this.index.set(asset, new IndexTracker(asset));
    }
  }

  start(): void {
    if (this.ws) {
      this.indexSource = 'kalshi';
      this.ws.on('book_snapshot', (e) => { this.book(e.ticker).applySnapshot(e, e.ts); this.recorder.write('book', e); });
      this.ws.on('book_delta', (e) => { this.book(e.ticker).applyDelta(e.side, e.price, e.delta, e.ts); this.recorder.write('delta', e); });
      this.ws.on('book_gap', (e) => { if (e.ticker) this.books.get(e.ticker)?.invalidate(); this.emit('gap', e); });
      this.ws.on('trade', (e) => { this.recorder.write('trade', e); this.emit('trade', e); });
      this.ws.on('index', (e) => this.onIndex(e.indexId, e.value, e.ts));
      this.ws.on('lifecycle', (e) => { this.recorder.write('lifecycle', e); this.emit('lifecycle', e); });
      this.ws.on('connected', () => { this.wsConnected = true; });
      this.ws.on('reconnected', () => { this.wsConnected = true; this.emit('reconnected'); });
      this.ws.on('disconnected', () => {
        this.wsConnected = false;
        for (const b of this.books.values()) b.invalidate();
        this.emit('disconnected');
      });
      this.ws.connect();
    } else {
      this.pollTimer = setInterval(() => void this.poll(), 2000);
    }
    if (this.cfg.allowProxyIndex && (!this.ws || this.cfg.mode === 'paper')) this.startProxyIndex();
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.ws?.close();
    this.proxyWs?.close();
    this.recorder.close();
  }

  book(ticker: string): OrderBook {
    let b = this.books.get(ticker);
    if (!b) { b = new OrderBook(ticker); this.books.set(ticker, b); }
    return b;
  }

  feesFor(ticker: string): FeeSchedule {
    const m = this.markets.get(ticker);
    const series = m?.seriesTicker ?? ticker.split('-')[0];
    return this.fees.get(series) ?? DEFAULT_FEES;
  }

  hasVerifiedFees(series: string): boolean {
    return this.fees.has(series);
  }

  private onIndex(indexId: string, value: number, ts: number): void {
    const asset = this.cfg.indexIdMap[indexId];
    if (!asset) return;
    this.index.get(asset)?.add(value, ts);
    this.recorder.write('index', { asset, value, ts, src: this.indexSource });
  }

  /** Refresh the list of open markets for each configured series. */
  async refreshCatalog(now = Date.now()): Promise<void> {
    for (const series of this.cfg.strategy.series) {
      const asset = this.cfg.seriesAssetMap[series];
      try {
        if (now - (this.feesFetchedAt.get(series) ?? 0) > 3_600_000) {
          const f = await this.rest.getSeriesFees(series);
          if (f) this.fees.set(series, { takerMultiplier: f.takerMultiplier, makerMultiplier: f.makerMultiplier });
          this.feesFetchedAt.set(series, now);
        }
        const markets = await this.rest.getOpenMarkets(series);
        for (const m of markets) {
          if (m.closeTime <= now) continue;
          const prev = this.markets.get(m.ticker);
          if (!prev) this.recorder.write('market', { ticker: m.ticker, series, asset, openTime: m.openTime, closeTime: m.closeTime, strike: m.floorStrike, tickSize: m.tickSize });
          const am: ActiveMarket = { ...m, seriesTicker: series, asset, strike: prev?.strike, strikeSource: prev?.strikeSource };
          if (m.floorStrike) { am.strike = m.floorStrike; am.strikeSource = 'exchange'; }
          this.markets.set(m.ticker, am);
        }
      } catch (e) {
        log.warn('catalog refresh failed', { series, error: String(e) });
      }
    }
    for (const [t, m] of this.markets) {
      if (m.closeTime < now - 30 * 60_000) { this.markets.delete(t); this.books.delete(t); }
    }
    this.ws?.setMarkets(this.activeMarkets(now).map((m) => m.ticker));
  }

  /** Record an official settlement result for research labels. */
  recordResult(ticker: string, result: 'yes' | 'no'): void {
    this.recorder.write('result', { ticker, result });
  }

  activeMarkets(now = Date.now()): ActiveMarket[] {
    return [...this.markets.values()].filter((m) => m.openTime <= now && now < m.closeTime);
  }

  /** Strike: exchange-published, else our own opening 60 s average if fully observed. */
  strikeFor(m: ActiveMarket): number | undefined {
    if (m.strike) return m.strike;
    const idx = this.index.get(m.asset);
    const avg = idx?.average(m.openTime - 60_000, m.openTime, 3000);
    if (avg) {
      m.strike = avg.avg;
      m.strikeSource = 'computed';
      return m.strike;
    }
    return undefined;
  }

  // ---- Unauthenticated fallback -------------------------------------------

  private async poll(): Promise<void> {
    const now = Date.now();
    for (const m of this.activeMarkets(now)) {
      try {
        const snap = await this.rest.getOrderbook(m.ticker);
        this.book(m.ticker).applySnapshot(snap, snap.ts);
        this.recorder.write('book', snap as unknown as Record<string, unknown>);
        await this.pollTrades(m.ticker);
      } catch (e) {
        this.books.get(m.ticker)?.invalidate();
        log.debug('poll failed', { ticker: m.ticker, error: String(e) });
      }
    }
  }

  private async pollTrades(ticker: string): Promise<void> {
    const since = this.tradeCursor.get(ticker) ?? Date.now() - 5000;
    let maxTs = since;
    const rows = (await this.rest.getRecentTrades(ticker, since)).slice().reverse();
    for (const t of rows) {
      const ts = Date.parse(t.created_time);
      if (!(ts > since)) continue;
      const price = yesPrice(t);
      const count = parseCount(t.count_fp) ?? parseCount(t.count);
      if (price === undefined || count === undefined) continue;
      const e = { ticker, price, count, takerSide: t.taker_side, ts };
      this.recorder.write('trade', e);
      this.emit('trade', e);
      maxTs = Math.max(maxTs, ts);
    }
    this.tradeCursor.set(ticker, maxTs);
  }

  private startProxyIndex(): void {
    const products = [...this.index.keys()].map((a) => `${a}-USD`);
    const connect = () => {
      const ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
      this.proxyWs = ws;
      ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', product_ids: products, channels: ['ticker'] })));
      ws.on('message', (buf) => {
        try {
          const m = JSON.parse(buf.toString());
          if (m.type !== 'ticker') return;
          const asset = String(m.product_id).split('-')[0];
          const value = Number(m.price);
          const ts = Date.parse(m.time) || Date.now();
          this.index.get(asset)?.add(value, ts);
          this.recorder.write('index', { asset, value, ts, src: 'proxy' });
        } catch { /* ignore */ }
      });
      ws.on('close', () => setTimeout(connect, 3000));
      ws.on('error', () => undefined);
    };
    if (this.indexSource === 'none') this.indexSource = 'proxy';
    log.warn('using Coinbase spot as an index PROXY (basis risk vs CF RTI; paper only)');
    connect();
  }
}
