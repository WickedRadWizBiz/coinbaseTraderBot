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
import { FeatureHub } from '../model/featureEngine';
import { selectCryptoSeries } from './seriesDiscovery';
import { PerpFeed } from '../perps/perpFeed';
import { KalshiPerpsRest } from '../perps/perpRest';
import type { PerpSnapshot } from '../perps/perpData';
import { contractKind, type ContractTerms, type MarketKind } from '../model/fairValue';
import { DominanceService } from './dominance';
import { IndexTracker } from './indexTracker';
import { OrderBook } from './orderBook';

const log = logger('marketdata');

export interface ActiveMarket extends MarketInfo {
  asset: string;
  kind: MarketKind;
  strike?: number;
  cap?: number;
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
  /** Coinbase spot per asset (feature input only; never the settlement price). */
  readonly spot = new Map<string, IndexTracker>();
  /** USDT.D and BTC.D (percent), fed by the dominance service. */
  readonly usdtd = new IndexTracker('USDT.D', 90 * 60_000, 300);
  readonly btcd = new IndexTracker('BTC.D', 90 * 60_000, 300);
  dominance: DominanceService | undefined;
  /** Microstructure feature state, fed identically in production and replay. */
  readonly features = new FeatureHub();
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
    for (const s of cfg.strategy.series) this.series.set(s, cfg.seriesAssetMap[s]);
    // Track every asset that has a settlement index, so discovered series can be priced at once.
    const assets = new Set([...this.series.values(), ...(cfg.strategy.seriesAuto ? Object.values(cfg.indexIdMap) : [])]);
    for (const asset of assets) {
      if (!this.index.has(asset)) this.index.set(asset, new IndexTracker(asset));
      if (!this.spot.has(asset)) this.spot.set(asset, new IndexTracker(asset));
    }
  }

  start(): void {
    if (this.ws) {
      this.indexSource = 'kalshi';
      this.ws.on('book_snapshot', (e) => { const b = this.book(e.ticker); b.applySnapshot(e, e.ts); this.features.onBook(e.ticker, b, e.ts); this.recorder.write('book', e); });
      this.ws.on('book_delta', (e) => { const b = this.book(e.ticker); b.applyDelta(e.side, e.price, e.delta, e.ts); this.features.onBook(e.ticker, b, e.ts); this.recorder.write('delta', e); });
      this.ws.on('book_gap', (e) => { if (e.ticker) this.books.get(e.ticker)?.invalidate(); this.emit('gap', e); });
      this.ws.on('trade', (e) => { this.features.onTrade(e.ticker, e.count, e.takerSide, e.ts); this.recorder.write('trade', e); this.emit('trade', e); });
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
    const proxy = this.cfg.allowProxyIndex && (!this.ws || this.cfg.mode === 'paper');
    if (proxy || this.cfg.spotFeed) this.startSpotFeed(proxy);
    if (this.cfg.dominanceFeed) {
      this.dominance = new DominanceService({ binanceWsUrl: this.cfg.binanceWsUrl, coingeckoUrl: this.cfg.coingeckoUrl, coingeckoApiKey: this.cfg.coingeckoApiKey });
      this.dominance.on('sample', (d: { usdtd: number; btcd: number; coveredShare: number; ts: number }) => this.onDominance(d));
      this.dominance.start();
    }
    if (this.cfg.perps.feed) {
      this.perpFeed = new PerpFeed(new KalshiPerpsRest(this.cfg.perps.restUrl), Object.values(this.cfg.indexIdMap), this.cfg.perps.pollMs);
      this.perpFeed.on('snapshot', (s: PerpSnapshot) => this.onPerp(s));
      this.perpFeed.start();
    }
  }

  /** Kalshi perpetuals feed (features and hedging), when enabled. */
  perpFeed: PerpFeed | undefined;

  /** A perp market snapshot: feature state + research recording. */
  onPerp(s: PerpSnapshot): void {
    this.features.onPerp(s);
    this.recorder.write('perp', { ...s });
    this.emit('perp', s);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.ws?.close();
    this.proxyWs?.close();
    this.dominance?.stop();
    this.perpFeed?.stop();
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
    this.features.onIndex(asset, value, ts);
    this.recorder.write('index', { asset, value, ts, src: this.indexSource });
  }

  /** Series being traded: the configured list, or (STRATEGY_SERIES=auto) every priceable crypto
   * series discovered from the exchange, refreshed hourly. */
  readonly series = new Map<string, string>();
  private discoveredAt = 0;

  private async refreshSeries(now: number): Promise<void> {
    if (!this.cfg.strategy.seriesAuto) return;
    if (now - this.discoveredAt < 3_600_000 && this.series.size) return;
    try {
      const found = selectCryptoSeries(await this.rest.listSeries('Crypto'), new Set(Object.values(this.cfg.indexIdMap)));
      if (Object.keys(found).length) {
        // Discovery replaces the built-in fallback list.
        const before = new Set(this.discoveredAt ? this.series.keys() : []);
        this.series.clear();
        for (const [s, a] of Object.entries(found)) {
          if (!before.has(s)) log.info('discovered series', { series: s, asset: a });
          this.series.set(s, a);
        }
        this.discoveredAt = now;
      }
    } catch (e) {
      log.warn('series discovery failed; using the built-in list', { error: String(e) });
    }
  }

  /** Refresh the list of open markets for each configured series. */
  async refreshCatalog(now = Date.now()): Promise<void> {
    await this.refreshSeries(now);
    for (const [series, asset] of this.series) {
      try {
        if (now - (this.feesFetchedAt.get(series) ?? 0) > 3_600_000) {
          const f = await this.rest.getSeriesFees(series);
          if (f) this.fees.set(series, { takerMultiplier: f.takerMultiplier, makerMultiplier: f.makerMultiplier });
          this.feesFetchedAt.set(series, now);
        }
        const markets = await this.rest.getOpenMarkets(series);
        for (const m of markets) {
          if (m.closeTime <= now) continue;
          // Far-dated strikes (daily/weekly ladders) are never inside an entry window; skip them.
          if (m.closeTime > now + this.cfg.catalogHorizonMin * 60_000) continue;
          const kind = contractKind(series, m.strikeType);
          const prev = this.markets.get(m.ticker);
          if (!prev) this.recorder.write('market', { ticker: m.ticker, series, asset, openTime: m.openTime, closeTime: m.closeTime, strike: m.floorStrike, cap: m.capStrike, kind, event: m.eventTicker, tickSize: m.tickSize });
          const am: ActiveMarket = { ...m, seriesTicker: series, asset, kind, cap: m.capStrike, strike: prev?.strike, strikeSource: prev?.strikeSource };
          if (m.floorStrike) { am.strike = m.floorStrike; am.strikeSource = 'exchange'; }
          this.markets.set(m.ticker, am);
        }
      } catch (e) {
        log.warn('catalog refresh failed', { series, error: String(e) });
      }
    }
    for (const [t, m] of this.markets) {
      if (m.closeTime < now - 30 * 60_000) { this.markets.delete(t); this.books.delete(t); this.features.forget(t); }
    }
    this.ws?.setMarkets(this.activeMarkets(now).map((m) => m.ticker));
  }

  /** A USDT.D / BTC.D sample (from the dominance service). */
  onDominance(d: { usdtd: number; btcd: number; coveredShare?: number; ts: number }): void {
    this.usdtd.add(d.usdtd, d.ts);
    this.btcd.add(d.btcd, d.ts);
    this.recorder.write('dominance', { usdtd: d.usdtd, btcd: d.btcd, covered: d.coveredShare ?? null, ts: d.ts });
  }

  /** Record an official settlement result for research labels. */
  recordResult(ticker: string, result: 'yes' | 'no'): void {
    this.recorder.write('result', { ticker, result });
  }

  activeMarkets(now = Date.now()): ActiveMarket[] {
    return [...this.markets.values()].filter((m) => m.openTime <= now && now < m.closeTime);
  }

  /** Pricing terms: exchange-published strikes, else (Up/Down only) our own opening 60 s average. */
  termsFor(m: ActiveMarket): ContractTerms | undefined {
    if (m.kind === 'updown') {
      const k = this.strikeFor(m);
      return k ? { kind: 'updown', strike: k } : undefined;
    }
    if (m.kind === 'less') return m.cap ? { kind: 'less', cap: m.cap } : undefined;
    if (m.kind === 'between') return m.strike && m.cap ? { kind: 'between', strike: m.strike, cap: m.cap } : undefined;
    return m.strike ? { kind: 'greater', strike: m.strike } : undefined;
  }

  /** Strike: exchange-published, else (Up/Down) our own opening 60 s average if fully observed. */
  strikeFor(m: ActiveMarket): number | undefined {
    if (m.strike) return m.strike;
    if (m.kind !== 'updown') return undefined;
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
        const b = this.book(m.ticker);
        b.applySnapshot(snap, snap.ts);
        this.features.onBook(m.ticker, b, snap.ts);
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
      this.features.onTrade(ticker, count, e.takerSide, ts);
      this.recorder.write('trade', e);
      this.emit('trade', e);
      maxTs = Math.max(maxTs, ts);
    }
    this.tradeCursor.set(ticker, maxTs);
  }

  /** Coinbase public ticker: always recorded as `spot` (feature input); also
   * feeds the index when running on the paper-only proxy. */
  private startSpotFeed(feedIndex: boolean): void {
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
          if (!(value > 0)) return;
          this.spot.get(asset)?.add(value, ts);
          this.recorder.write('spot', { asset, value, ts });
          if (feedIndex) {
            this.index.get(asset)?.add(value, ts);
            this.features.onIndex(asset, value, ts);
            this.recorder.write('index', { asset, value, ts, src: 'proxy' });
          }
        } catch { /* ignore */ }
      });
      ws.on('close', () => setTimeout(connect, 3000));
      ws.on('error', () => undefined);
    };
    if (feedIndex) {
      if (this.indexSource === 'none') this.indexSource = 'proxy';
      log.warn('using Coinbase spot as an index PROXY (basis risk vs CF RTI; paper only)');
    }
    connect();
  }
}
