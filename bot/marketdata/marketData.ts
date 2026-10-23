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
import type { FeeSchedule } from '../fees';
import { FeeBook, readPublishedSchedulePdf } from '../kalshi/feeSchedule';
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
import { fillTickerStrikes } from '../kalshi/wire';
import { DominanceService } from './dominance';
import { IndexBars, IndexStore } from './indexBars';
import { IndexTracker } from './indexTracker';
import { OrderBook } from './orderBook';
import { recordLatency } from '../util/latency';

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
  private closed = false;
  constructor(private readonly dir: string) { fs.mkdirSync(dir, { recursive: true }); }
  write(kind: string, data: Record<string, unknown>): void {
    // Sockets still draining at shutdown deliver messages after close(): dropped (writing to the ended
    // stream raised an unhandled 'error' and the bot exited with status 1 on every deploy).
    if (this.closed) return;
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.stream?.end();
      this.day = day;
      const file = path.join(this.dir, `md-${day}.jsonl`);
      this.stream = fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
      // Recording is best effort: a disk error is logged (once per file) instead of taking the bot down.
      let warned = false;
      this.stream.on('error', (e) => { if (!warned) { warned = true; log.warn('recording write failed', { file, error: String(e) }); } });
    }
    this.stream!.write(JSON.stringify({ t: now, k: kind, ...data }) + '\n');
  }
  close(): void { this.closed = true; this.stream?.end(); }
}

export class MarketData extends EventEmitter {
  readonly books = new Map<string, OrderBook>();
  readonly index = new Map<string, IndexTracker>();
  /** Coinbase spot per asset (feature input only; never the settlement price). */
  readonly spot = new Map<string, IndexTracker>();
  /** Binance USDT price per asset, sampled each second from the dominance stream (a paper-only pricing
   *  fallback when Coinbase prints are sparse; kept separate so sources never mix in one series). */
  readonly binance = new Map<string, IndexTracker>();
  /** INDEX_ID_MAP with upper-cased keys (the channel's casing is not guaranteed). */
  private idUpper?: Map<string, string>;
  private get indexIdUpper(): Map<string, string> { return (this.idUpper ??= new Map(Object.entries(this.cfg.indexIdMap).map(([k, v]) => [k.toUpperCase(), v]))); }
  /** USDT.D and BTC.D (percent), fed by the dominance service. */
  readonly usdtd = new IndexTracker('USDT.D', 90 * 60_000, 300);
  readonly btcd = new IndexTracker('BTC.D', 90 * 60_000, 300);
  dominance: DominanceService | undefined;
  /** Microstructure feature state, fed identically in production and replay. */
  readonly features = new FeatureHub();
  readonly markets = new Map<string, ActiveMarket>();
  /** Kalshi's fee schedule per series and event, checked against the published schedule and the live fills. */
  readonly feeBook: FeeBook;
  private eventFeesAt = 0;
  private publishedBusy = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private indexTimer: NodeJS.Timeout | null = null;
  private binanceTimer: NodeJS.Timeout | null = null;

  /** Copy each asset's latest Binance price into its own series (new prints only). */
  pullBinance(): void {
    if (!this.dominance) return;
    for (const [asset, tr] of this.binance) {
      const q = this.dominance.priceOf(asset);
      const last = tr.latest();
      if (q && (!last || q.ts > last.ts)) tr.add(q.price, q.ts);
    }
  }
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
    this.feeBook = new FeeBook(cfg.kalshiBalancePrecision, cfg.dataDir ? path.join(cfg.dataDir, 'fee_schedule.json') : undefined);
    const histDir = cfg.taNet?.enabled ? cfg.taNet.historyDir : undefined;
    this.indexBars = new IndexBars(histDir);
    this.indexStore = new IndexStore(histDir);
    this.indexBars.onClose = () => this.indexStore.invalidate();
    for (const s of cfg.strategy.series) this.series.set(s, cfg.seriesAssetMap[s]);
    this.addTennisSeries();
    // Track every asset that has a settlement index, so discovered series can be priced at once.
    const assets = new Set([...this.series.values(), ...(cfg.strategy.seriesAuto ? Object.values(cfg.indexIdMap) : [])]);
    for (const asset of assets) {
      if (asset === 'TENNIS') continue; // match markets: no price index or spot feed
      if (!this.index.has(asset)) this.index.set(asset, new IndexTracker(asset, undefined, undefined, cfg.settlementAvg));
      if (!this.spot.has(asset)) this.spot.set(asset, new IndexTracker(asset));
      if (!this.binance.has(asset)) this.binance.set(asset, new IndexTracker(asset));
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
      // Kalshi sends book deltas only when a book changes; a quiet book on a live, gap-free sequenced feed
      // is still current. While the socket is live, mark every intact book alive (a gap or disconnect
      // invalidates books until their next snapshot, so a broken book never passes).
      this.aliveTimer = setInterval(() => {
        const now = Date.now();
        if (!this.wsConnected || !this.ws || now - this.ws.lastMessageTs > 12_000) return; // pings every 10 s
        for (const b of this.books.values()) b.markAlive(now);
      }, 1000);
      this.aliveTimer.unref();
    } else {
      this.pollTimer = setInterval(() => void this.poll(), 2000);
    }
    const proxy = this.cfg.allowProxyIndex && (!this.ws || this.cfg.mode === 'paper');
    if (proxy || this.cfg.spotFeed) this.startSpotFeed(proxy);
    if (this.cfg.dominanceFeed) {
      this.dominance = new DominanceService({ binanceWsUrl: this.cfg.binanceWsUrl, coingeckoUrl: this.cfg.coingeckoUrl, coingeckoApiKey: this.cfg.coingeckoApiKey, extraSymbols: [...this.index.keys()] });
      // Continue the BTCDOM level where the stored history (Binance's index, or our own bars) ends.
      const last = this.cfg.taNet?.enabled ? IndexBars.lastStored(this.cfg.taNet.historyDir, 'BTCDOM') : undefined;
      if (last) this.dominance.btcdom.setAnchor(last);
      this.dominance.on('sample', (d: { usdtd: number; btcd: number; btcdom?: number; coveredShare: number; ts: number }) => this.onDominance(d));
      this.dominance.start();
      this.indexTimer = setInterval(() => this.indexBars.flush(Date.now()), 60_000);
      this.binanceTimer = setInterval(() => this.pullBinance(), 1000);
      this.binanceTimer.unref();
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

  private aliveTimer?: NodeJS.Timeout;

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.aliveTimer) clearInterval(this.aliveTimer);
    if (this.indexTimer) clearInterval(this.indexTimer);
    if (this.binanceTimer) clearInterval(this.binanceTimer);
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

  /** The fee schedule a market's orders are priced with (bot/kalshi/feeSchedule.ts). */
  feesFor(ticker: string): FeeSchedule {
    const m = this.markets.get(ticker);
    return this.feeBook.feesFor(m?.seriesTicker ?? ticker.split('-')[0], m?.eventTicker ?? eventOf(ticker), Date.now());
  }

  hasVerifiedFees(series: string): boolean {
    return this.feeBook.verified(series).ok;
  }

  /** Why new entries in a market wait for its fee schedule, if they do (exits never wait). */
  feeBlock(ticker: string): string | undefined {
    const m = this.markets.get(ticker);
    const v = this.feeBook.verified(m?.seriesTicker ?? ticker.split('-')[0], m?.eventTicker ?? eventOf(ticker));
    return v.ok ? undefined : v.why;
  }

  /** The fee schedule check for the dashboard and diagnostics. */
  feeStatus() {
    return this.feeBook.status([...this.series.keys()]);
  }

  /** Read Kalshi's published fee schedule (KALSHI_FEE_SCHEDULE_URL); 'fee_schedule' is emitted with the result. A
   *  failed read keeps the last good one. */
  async checkPublishedSchedule(fetchImpl: typeof fetch = fetch): Promise<void> {
    if (this.publishedBusy) return;
    this.publishedBusy = true;
    const now = Date.now();
    try {
      const res = await fetchImpl(this.cfg.feeSchedule.url, { headers: { Accept: 'application/pdf', 'User-Agent': 'Mozilla/5.0 (compatible; fee schedule check)' }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 20e6) throw new Error(`${(buf.length / 1e6).toFixed(1)} MB is too large for the fee schedule`);
      const p = readPublishedSchedulePdf(buf, now);
      if (!('error' in p)) { p.etag = res.headers.get('etag') ?? undefined; p.lastModified = res.headers.get('last-modified') ?? undefined; }
      const { changed } = this.feeBook.setPublished(p, now);
      this.emit('fee_schedule', { changed, error: 'error' in p ? p.error : undefined });
    } catch (e) {
      this.feeBook.setPublished({ error: String((e as Error).message ?? e) }, now);
      this.emit('fee_schedule', { changed: false, error: String((e as Error).message ?? e) });
    } finally {
      this.publishedBusy = false;
    }
  }

  /** How far behind real time Kalshi's data is reaching the bot (ms), undefined without a recent sample. */
  kalshiFeedLagMs(now = Date.now()): number | undefined {
    return this.ws?.feedLagMs(now);
  }

  /** What Kalshi's index channels delivered (counts per stage, ids seen, raw samples, acks). */
  indexFeedStats(): (import('../kalshi/ws').IndexFeedStats & { connected: boolean; lastMessageAgoMs: number | null }) | null {
    if (!this.ws) return null;
    return { ...this.ws.indexStats, connected: this.wsConnected, lastMessageAgoMs: this.ws.lastMessageTs ? Date.now() - this.ws.lastMessageTs : null };
  }

  private onIndex(indexId: string, value: number, ts: number): void {
    const asset = this.cfg.indexIdMap[indexId] ?? this.indexIdUpper.get(indexId.toUpperCase());
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
  private catalogBusy = false;
  /** Last catalog refresh: series that failed, the latest error, when (for the dashboard). */
  catalogHealth: { ts: number; series: number; failed: number; lastError?: string; durationMs?: number; tracked?: number; recordOnly?: number; open?: number; perSeries?: Record<string, { fetched: number; nearest: number; closed: number; farDated: number; notOpenYet: number; kept: number; sample?: string }> } = { ts: 0, series: 0, failed: 0 };

  private catalogRun = 0;
  private catalogBusySince = 0;

  async refreshCatalog(now = Date.now()): Promise<void> {
    // One refresh at a time: when the exchange is slow or rate limiting, a 20 s timer would otherwise
    // start new refreshes on top of unfinished ones and multiply the request rate. A refresh that has
    // not finished in CATALOG_STUCK_MS never blocks the next one (a single hung request must not stop
    // the market list from updating: markets would expire one by one until none are left).
    if (this.catalogBusy && Date.now() - this.catalogBusySince < CATALOG_STUCK_MS) return;
    if (this.catalogBusy) log.warn('catalog refresh still running after 3 min: starting a new one', { since: new Date(this.catalogBusySince).toISOString() });
    const run = ++this.catalogRun;
    this.catalogBusy = true;
    this.catalogBusySince = Date.now();
    try { await this.refreshCatalogOnce(now); } finally { if (run === this.catalogRun) this.catalogBusy = false; }
  }

  private async refreshCatalogOnce(now: number): Promise<void> {
    await this.refreshSeries(now);
    // Per-event fee overrides, hourly (one call for every event; kept for the series traded here).
    if (now - this.eventFeesAt > 3_600_000) {
      this.eventFeesAt = now;
      try { this.feeBook.setEventChanges(await this.rest.getEventFeeChanges(), (s) => this.series.has(s), now); } catch (e) { log.warn('event fee changes unavailable', { error: String(e) }); }
    }
    const entries: Array<[string, string, boolean]> = [...[...this.series].map(([s, a]) => [s, a, false] as [string, string, boolean]), ...this.recordSeriesList().map(([s, a]) => [s, a, true] as [string, string, boolean])];
    let recordCount = [...this.markets.values()].filter((m) => m.recordOnly && m.closeTime > now).length;
    let failed = 0, lastError: string | undefined;
    const perSeries: NonNullable<MarketData['catalogHealth']['perSeries']> = {};
    for (const [series, asset, recordOnly] of entries) {
      try {
        if (!recordOnly && now - this.feeBook.seriesFetchedAt(series) > 3_600_000) {
          this.feeBook.setSeries(series, await this.rest.getSeriesFees(series), now);
          try { this.feeBook.setSeriesChanges(series, await this.rest.getSeriesFeeChanges(series)); } catch { /* optional: keep the last list */ }
        }
        const fetched = fillTickerStrikes(await this.rest.getOpenMarkets(series));
        // Which strikes to track: the ones at the money by Kalshi's own prices (nearest 50c on a ladder, the
        // richest buckets on a range), else nearest Kalshi's index. Never an outside exchange's price.
        const markets = nearestStrikes(fetched, contractKind, series, this.index.get(asset)?.latest()?.value, this.cfg.catalogStrikesPerEvent, new Set(this.markets.keys()));
        // Where markets drop out, per series (dashboard / API diagnostics).
        const ps = { fetched: fetched.length, nearest: markets.length, closed: 0, farDated: 0, notOpenYet: 0, kept: 0, sample: fetched[0] ? `${fetched[0].ticker} open ${new Date(fetched[0].openTime).toISOString()} close ${new Date(fetched[0].closeTime).toISOString()}` : undefined };
        perSeries[series] = ps;
        for (const m of markets) {
          if (m.closeTime <= now) { ps.closed++; continue; }
          const kind = contractKind(series, m.strikeType);
          // Far-dated strikes (daily/weekly ladders) are never inside an entry window; skip them.
          const horizonMs = kind === 'match' ? this.cfg.tennis.horizonHours * 3_600_000 : this.cfg.catalogHorizonMin * 60_000;
          if (m.closeTime > now + horizonMs && !(kind === 'match' && m.startTime !== undefined && m.startTime < now + horizonMs)) { ps.farDated++; continue; }
          if (m.openTime > now) ps.notOpenYet++;
          ps.kept++;
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
        failed++; lastError = String(e);
        log.warn('catalog refresh failed', { series, error: String(e) });
      }
    }
    if (entries.length && failed === entries.length) log.error('catalog refresh failed for every series: no new markets are being added', { error: lastError });
    const all = [...this.markets.values()];
    this.catalogHealth = { ts: now, durationMs: Date.now() - now, series: entries.length, failed, lastError, perSeries, tracked: all.length, recordOnly: all.filter((m) => m.recordOnly).length, open: all.filter((m) => m.openTime <= now && now < m.closeTime).length } as MarketData['catalogHealth'];
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
    let avg = idx?.settlement(m.openTime, m.openTime);
    // Paper with PAPER_OUTSIDE_PRICE_FALLBACK=true only: when Kalshi's index misses the opening minute, the
    // Coinbase opening average stands in (contracts are otherwise priced on Kalshi data alone).
    if (!(avg && avg.n >= 60) && this.cfg.mode === 'paper' && this.cfg.strategy.outsidePriceFallback) avg = this.spot.get(m.asset)?.settlement(m.openTime, m.openTime, 60, 15_000);
    if (avg && avg.n >= 60) {
      m.strike = avg.avg;
      m.strikeSource = 'computed';
      return m.strike;
    }
    return undefined;
  }

  // ---- Unauthenticated fallback -------------------------------------------

  private pollBusy = false;

  private async poll(): Promise<void> {
    // One pass at a time (a pass over many markets can take longer than the 2 s timer).
    if (this.pollBusy) return;
    this.pollBusy = true;
    try { await this.pollOnce(); } finally { this.pollBusy = false; }
  }

  private async pollOnce(): Promise<void> {
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
          if (m.time) recordLatency('coinbase', Date.now() - ts);
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
/** A catalog refresh running longer than this no longer blocks the next one. */
export const CATALOG_STUCK_MS = 180_000;

export function nearestStrikes<M extends { ticker: string; eventTicker?: string; strikeType?: string; floorStrike?: number; capStrike?: number; yesMid?: number }>(
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
    // Kalshi's own prices first: at the money = YES nearest 50c (above / below ladders) or the richest
    // buckets (ranges). Needs a price on at least half the event's markets.
    const priced = ms.filter((m) => m.yesMid !== undefined);
    if (priced.length >= Math.max(2, ms.length / 2)) {
      const between = kindOf(series, ms[0].strikeType) === 'between';
      const score = (m: M) => (m.yesMid === undefined ? Infinity : between ? -m.yesMid : Math.abs(m.yesMid - 0.5));
      const keep = new Set([...ms].sort((a, b) => score(a) - score(b)).slice(0, n));
      for (const m of ms) if (keep.has(m) || tracked.has(m.ticker)) out.push(m);
      continue;
    }
    const refs = ms.map((m) => ref(m)!).sort((a, b) => a - b);
    const p = price ?? refs[Math.floor(refs.length / 2)];
    const keep = new Set([...ms].sort((a, b) => Math.abs(ref(a)! - p) - Math.abs(ref(b)! - p)).slice(0, n));
    for (const m of ms) if (keep.has(m) || tracked.has(m.ticker)) out.push(m);
  }
  return out;
}

/** A market ticker's event ticker (SERIES-EVENT-MARKET), when the market info did not carry one. */
function eventOf(ticker: string): string | undefined {
  const parts = ticker.split('-');
  return parts.length >= 3 ? parts.slice(0, -1).join('-') : undefined;
}
