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

import { parsePriceRanges } from '../kalshi/priceGrid';
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
import { assetFromSeries, selectCryptoSeries } from './seriesDiscovery';
import { PerpFeed } from '../perps/perpFeed';
import type { CandleRow } from '../ta/candleStore';
import type { Timeframe } from '../ta/knowledge';
import { SpotCandleFeed } from './spotCandles';
import { TakerFlowFeed } from './takerFlow';
import { KalshiPerpsRest } from '../perps/perpRest';
import type { PerpSnapshot } from '../perps/perpData';
import { contractKind, type ContractTerms, type MarketKind } from '../model/fairValue';
import { DominanceService } from './dominance';
import { IndexBars, IndexStore } from './indexBars';
import { IndexTracker } from './indexTracker';
import { OrderBook } from './orderBook';

const log = logger('marketdata');

export interface ActiveMarket extends MarketInfo {
  asset: string;
  kind: MarketKind;
  strike?: number;
  cap?: number;
  strikeSource?: 'exchange' | 'computed';
  /** Recorded for research only: never priced, quoted or traded (RECORD_SERIES). */
  recordOnly?: boolean;
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
  /** Scheduled fee changes per series (GET /series/fee_changes), applied the moment they take effect. */
  private readonly feeChanges = new Map<string, Array<{ multiplier?: number; scheduledTs: number }>>();
  private pollTimer: NodeJS.Timeout | null = null;
  private indexTimer: NodeJS.Timeout | null = null;
  /** Hourly bars of USDT.D, BTC.D and BTCDOM from the dominance feed, appended to the history store. */
  readonly indexBars: IndexBars;
  /** Index series for the TA network (history store: TradingView, Binance BTCDOM, the bot's own bars). */
  readonly indexStore: IndexStore;
  private readonly tradeCursor = new Map<string, number>();
  private proxyWs: WebSocket | null = null;
  private candleFeed?: SpotCandleFeed;
  private takerFlow?: TakerFlowFeed;
  indexSource: 'kalshi' | 'proxy' | 'none' = 'none';
  wsConnected = false;

  constructor(
    private readonly cfg: Readonly<Config>,
    readonly rest: KalshiRest,
    private readonly ws: KalshiWs | undefined,
    private readonly recorder: Recorder,
  ) {
    super();
    const histDir = cfg.taNet?.enabled ? cfg.taNet.historyDir : undefined;
    this.indexBars = new IndexBars(histDir);
    this.indexStore = new IndexStore(histDir);
    this.indexBars.onClose = () => this.indexStore.invalidate();
    for (const s of cfg.strategy.series) this.series.set(s, cfg.seriesAssetMap[s]);
    this.addTennisSeries();
    // Track every asset that has a settlement index, so discovered series can be priced at once.
    const assets = new Set([...this.series.values(), ...(cfg.strategy.seriesAuto ? Object.values(cfg.indexIdMap) : [])]);
    for (const asset of assets) {
      if (!this.index.has(asset)) this.index.set(asset, new IndexTracker(asset, undefined, undefined, cfg.settlementAvg));
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
      this.ws.on('lifecycle', (e) => {
        // A market's price grid can change (price_level_structure_updated carries the new bands).
        if (e.priceRanges) { const m = this.markets.get(e.ticker); const r = parsePriceRanges(e.priceRanges); if (m && r) m.priceRanges = r; }
        this.recorder.write('lifecycle', e); this.emit('lifecycle', e);
      });
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
      // Continue the BTCDOM level where the stored history (Binance's index, or our own bars) ends.
      const last = this.cfg.taNet?.enabled ? IndexBars.lastStored(this.cfg.taNet.historyDir, 'BTCDOM') : undefined;
      if (last) this.dominance.btcdom.setAnchor(last);
      this.dominance.on('sample', (d: { usdtd: number; btcd: number; btcdom?: number; coveredShare: number; ts: number }) => this.onDominance(d));
      this.dominance.start();
      this.indexTimer = setInterval(() => this.indexBars.flush(Date.now()), 60_000);
    }
    if (this.cfg.taCandles) {
      // Live order flow (Coinbase public trades) so live candles carry taker-buy volume like the history.
      if (this.cfg.takerFlow) { this.takerFlow = new TakerFlowFeed([...this.index.keys()], this.cfg.coinbaseWsUrl); this.takerFlow.start(); }
      this.candleFeed = new SpotCandleFeed([...this.index.keys()], this.cfg.coinbaseRestUrl, fetch, Date.now, this.takerFlow);
      this.candleFeed.on('candles', (e: { asset: string; tf: Timeframe; rows: CandleRow[]; ts: number }) => {
        const fresh = this.features.onCandles(e.asset, e.tf, e.rows, e.ts);
        if (fresh.length) this.recorder.write('candles', { asset: e.asset, tf: e.tf, rows: fresh, ts: e.ts });
      });
      this.candleFeed.start();
    }
    if (this.cfg.perps.feed) {
      this.perpFeed = new PerpFeed(new KalshiPerpsRest(this.cfg.perps.restUrl), Object.values(this.cfg.indexIdMap), this.cfg.perps.pollMs);
      this.perpFeed.on('snapshot', (s: PerpSnapshot) => this.onPerp(s));
      this.perpFeed.start();
    }
  }

  /** ATP match-winner series (books, trades and lifecycle for bot/tennis). */
  private addTennisSeries(): void {
    if (this.cfg.tennis?.enabled) for (const s of this.cfg.tennis.series) this.series.set(s, 'TENNIS');
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
    if (this.indexTimer) clearInterval(this.indexTimer);
    this.ws?.close();
    this.proxyWs?.close();
    this.dominance?.stop();
    this.perpFeed?.stop();
    this.candleFeed?.stop();
    this.takerFlow?.stop();
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
    const base = this.fees.get(series) ?? DEFAULT_FEES;
    // A scheduled change that has taken effect since the series fees were fetched overrides the taker multiplier.
    const fetched = this.feesFetchedAt.get(series) ?? 0, now = Date.now();
    const ch = this.feeChanges.get(series)?.filter((c) => c.scheduledTs > fetched && c.scheduledTs <= now && c.multiplier !== undefined).pop();
    return ch ? { ...base, takerMultiplier: ch.multiplier! } : base;
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
        this.addTennisSeries();
        this.discoveredAt = now;
      }
    } catch (e) {
      log.warn('series discovery failed; using the built-in list', { error: String(e) });
    }
  }

  /** Record-only series (RECORD_SERIES) that are not already traded, with their asset when it names one. */
  private recordSeriesList(): Array<[string, string]> {
    return this.cfg.strategy.recordSeries.filter((s) => !this.series.has(s)).map((s) => [s, assetFromSeries(s, Object.values(this.cfg.indexIdMap)) ?? 'REC']);
  }

  private readonly resultChecked = new Set<string>();

  /** Refresh the list of open markets for each configured series (traded first, then record-only). */
  async refreshCatalog(now = Date.now()): Promise<void> {
    await this.refreshSeries(now);
    const entries: Array<[string, string, boolean]> = [...[...this.series].map(([s, a]) => [s, a, false] as [string, string, boolean]), ...this.recordSeriesList().map(([s, a]) => [s, a, true] as [string, string, boolean])];
    let recordCount = [...this.markets.values()].filter((m) => m.recordOnly && m.closeTime > now).length;
    for (const [series, asset, recordOnly] of entries) {
      try {
        if (!recordOnly && now - (this.feesFetchedAt.get(series) ?? 0) > 3_600_000) {
          const f = await this.rest.getSeriesFees(series);
          if (f) this.fees.set(series, { takerMultiplier: f.takerMultiplier, makerMultiplier: f.makerMultiplier });
          this.feesFetchedAt.set(series, now);
          try { this.feeChanges.set(series, (await this.rest.getSeriesFeeChanges(series)).sort((a, b) => a.scheduledTs - b.scheduledTs)); } catch { /* optional: keep the last list */ }
        }
        const markets = nearestStrikes(await this.rest.getOpenMarkets(series), contractKind, series, this.index.get(asset)?.latest()?.value, this.cfg.catalogStrikesPerEvent, new Set(this.markets.keys()));
        for (const m of markets) {
          if (m.closeTime <= now) continue;
          const kind = contractKind(series, m.strikeType);
          // Far-dated strikes (daily/weekly ladders) are never inside an entry window; skip them.
          const horizonMs = kind === 'match' ? this.cfg.tennis.horizonHours * 3_600_000 : this.cfg.catalogHorizonMin * 60_000;
          if (m.closeTime > now + horizonMs && !(kind === 'match' && m.startTime !== undefined && m.startTime < now + horizonMs)) continue;
          const prev = this.markets.get(m.ticker);
          if (recordOnly && !prev) {
            if (recordCount >= this.cfg.strategy.recordMaxMarkets) continue;
            recordCount++;
          }
          if (!prev) this.recorder.write('market', { ticker: m.ticker, series, asset, openTime: m.openTime, closeTime: m.closeTime, strike: m.floorStrike, cap: m.capStrike, kind, event: m.eventTicker, tickSize: m.tickSize, title: m.title, startTime: m.startTime, recordOnly: recordOnly || undefined });
          const am: ActiveMarket = { ...m, seriesTicker: series, asset, kind, cap: m.capStrike, strike: prev?.strike, strikeSource: prev?.strikeSource, recordOnly: recordOnly || undefined };
          if (m.floorStrike) { am.strike = m.floorStrike; am.strikeSource = 'exchange'; }
          this.markets.set(m.ticker, am);
        }
      } catch (e) {
        log.warn('catalog refresh failed', { series, error: String(e) });
      }
    }
    // Record-only markets have no position to settle, so fetch their official result once they close.
    let looked = 0;
    for (const m of this.markets.values()) {
      if (!m.recordOnly || m.closeTime > now - 30_000 || this.resultChecked.has(m.ticker) || looked >= 10) continue;
      looked++;
      try {
        const info = await this.rest.getMarket(m.ticker);
        if (info?.result === 'yes' || info?.result === 'no') { this.recordResult(m.ticker, info.result); this.resultChecked.add(m.ticker); }
        else if (now - m.closeTime > 3_600_000) this.resultChecked.add(m.ticker); // give up after an hour
      } catch { /* retry at the next refresh */ }
    }
    for (const [t, m] of this.markets) {
      if (m.closeTime < now - 30 * 60_000 && (!m.recordOnly || this.resultChecked.has(t) || m.closeTime < now - 70 * 60_000)) { this.markets.delete(t); this.books.delete(t); this.features.forget(t); this.resultChecked.delete(t); }
    }
    this.ws?.setMarkets(this.recordedMarkets(now).map((m) => m.ticker));
  }

  /** A USDT.D / BTC.D sample (from the dominance service). */
  onDominance(d: { usdtd: number; btcd: number; btcdom?: number; coveredShare?: number; ts: number }): void {
    this.indexBars.add('USDT.D', d.usdtd, d.ts);
    this.indexBars.add('BTC.D', d.btcd, d.ts);
    this.indexBars.add('BTCDOM', d.btcdom, d.ts);
    this.usdtd.add(d.usdtd, d.ts);
    this.btcd.add(d.btcd, d.ts);
    this.recorder.write('dominance', { usdtd: d.usdtd, btcd: d.btcd, btcdom: d.btcdom ?? null, covered: d.coveredShare ?? null, ts: d.ts });
  }

  /** Write any event to the research recordings (SNN outputs, tennis scores, ...). */
  record(kind: string, data: Record<string, unknown>): void {
    this.recorder.write(kind, data);
  }

  /** Record an official settlement result for research labels. */
  recordResult(ticker: string, result: 'yes' | 'no'): void {
    this.recorder.write('result', { ticker, result });
    this.emit('result', { ticker, result });
  }

  /** Open markets the bot may price and trade (record-only markets excluded). */
  activeMarkets(now = Date.now()): ActiveMarket[] {
    return [...this.markets.values()].filter((m) => !m.recordOnly && m.openTime <= now && now < m.closeTime);
  }

  /** Every open market that is being recorded, traded or not (subscriptions, dashboard). */
  recordedMarkets(now = Date.now()): ActiveMarket[] {
    return [...this.markets.values()].filter((m) => m.openTime <= now && now < m.closeTime);
  }

  /** Pricing terms: exchange-published strikes, else (Up/Down only) our own opening 60 s average. */
  termsFor(m: ActiveMarket): ContractTerms | undefined {
    if (m.kind === 'match') return undefined;
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
    const avg = idx?.settlement(m.openTime, m.openTime);
    if (avg && avg.n >= 60) {
      m.strike = avg.avg;
      m.strikeSource = 'computed';
      return m.strike;
    }
    return undefined;
  }

  // ---- Unauthenticated fallback -------------------------------------------

  private async poll(): Promise<void> {
    const now = Date.now();
    for (const m of this.recordedMarkets(now)) {
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

/** Strike ladders and range brackets: the `n` strikes nearest the price in each event (all when n = 0).
 *  Markets already tracked are kept (open positions stay managed). Without a price yet, the event's median
 *  strike stands in for it (Kalshi centres its ladders on the price). */
export function nearestStrikes<M extends { ticker: string; eventTicker?: string; strikeType?: string; floorStrike?: number; capStrike?: number }>(
  markets: M[], kindOf: (series: string, strikeType?: string) => string, series: string, price: number | undefined, n: number, tracked: Set<string>,
): M[] {
  if (!n) return markets;
  const ref = (m: M) => (m.floorStrike !== undefined && m.capStrike !== undefined ? (m.floorStrike + m.capStrike) / 2 : m.floorStrike ?? m.capStrike);
  const byEvent = new Map<string, M[]>();
  const out: M[] = [];
  for (const m of markets) {
    const k = kindOf(series, m.strikeType);
    if (k === 'updown' || k === 'match' || ref(m) === undefined) { out.push(m); continue; }
    const e = m.eventTicker ?? series;
    (byEvent.get(e) ?? byEvent.set(e, []).get(e)!).push(m);
  }
  for (const ms of byEvent.values()) {
    const refs = ms.map((m) => ref(m)!).sort((a, b) => a - b);
    const p = price ?? refs[Math.floor(refs.length / 2)];
    const keep = new Set([...ms].sort((a, b) => Math.abs(ref(a)! - p) - Math.abs(ref(b)! - p)).slice(0, n));
    for (const m of ms) if (keep.has(m) || tracked.has(m.ticker)) out.push(m);
  }
  return out;
}
