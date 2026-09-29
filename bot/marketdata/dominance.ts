// USDT.D and BTC.D, tracked in real time.
//
// Dominance = one coin's market cap / total crypto market cap. Binance does not
// publish it, so it is reconstructed:
//   - every few minutes, CoinGecko supplies circulating supply for the top
//     coins and the total market cap (the anchor);
//   - between anchors, Binance's live USDT-pair prices move each coin's cap
//     (supply x price), and the long tail not covered moves pro rata with the
//     covered non-stable basket.
// USDT's cap is effectively constant intraday, so USDT.D moves inversely with
// total crypto market cap ("risk-on" when it falls). BTC.D rises when BTC
// outperforms the rest of the market.
//
// These are feature inputs only. Missing or stale inputs produce no sample —
// never an invented value — and the features read NaN.

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { logger } from '../util/log';

const log = logger('dominance');

export interface CoinSnapshot {
  symbol: string;        // e.g. 'btc'
  price: number;         // USD at snapshot
  marketCap: number;     // USD at snapshot
}

export interface DominanceSample {
  usdtd: number;         // percent
  btcd: number;          // percent
  totalCap: number;      // USD
  coveredShare: number;  // share of total cap priced live from Binance
  ts: number;
}

const STABLES = new Set(['usdt', 'usdc', 'dai', 'fdusd', 'usde', 'tusd', 'usdd', 'pyusd', 'usds', 'busd', 'usd1']);

/** Pure dominance arithmetic (testable without network). */
export class DominanceCalculator {
  private supply = new Map<string, number>();   // SYM -> circulating supply (non-stables)
  private basePrice = new Map<string, number>(); // SYM -> price at anchor
  private stablesCap = 0;
  private usdtCap = 0;
  private othersCap0 = 0;
  private movingCap0 = 0;
  anchoredAt = 0;

  /** Anchor to a CoinGecko snapshot: top coins + total market cap. */
  setBaseline(coins: CoinSnapshot[], totalCap: number, livePrices: Map<string, number>, ts: number): void {
    const supply = new Map<string, number>();
    const basePrice = new Map<string, number>();
    let stables = 0, usdt = 0, moving = 0;
    for (const c of coins) {
      const sym = c.symbol.toUpperCase();
      if (!(c.marketCap > 0) || !(c.price > 0)) continue;
      if (STABLES.has(c.symbol.toLowerCase())) {
        stables += c.marketCap;
        if (c.symbol.toLowerCase() === 'usdt') usdt = c.marketCap;
        continue;
      }
      supply.set(sym, c.marketCap / c.price);
      const p = livePrices.get(sym) ?? c.price;
      basePrice.set(sym, p);
      moving += (c.marketCap / c.price) * p;
    }
    if (!(usdt > 0) || !supply.has('BTC') || !(totalCap > moving + stables)) {
      throw new Error('baseline missing USDT/BTC or inconsistent total market cap');
    }
    this.supply = supply;
    this.basePrice = basePrice;
    this.stablesCap = stables;
    this.usdtCap = usdt;
    this.movingCap0 = moving;
    this.othersCap0 = totalCap - moving - stables;
    this.anchoredAt = ts;
  }

  get ready(): boolean {
    return this.anchoredAt > 0;
  }

  /** Dominance at current live prices (falls back to anchor price per coin). */
  compute(livePrices: Map<string, number>, ts: number): DominanceSample | undefined {
    if (!this.ready) return undefined;
    let moving = 0, live = 0;
    for (const [sym, sup] of this.supply) {
      const lp = livePrices.get(sym);
      const cap = sup * (lp ?? this.basePrice.get(sym)!);
      moving += cap;
      if (lp !== undefined) live += cap;
    }
    const btcPrice = livePrices.get('BTC');
    if (btcPrice === undefined) return undefined; // BTC must be live
    const others = this.othersCap0 * (moving / this.movingCap0);
    const total = moving + this.stablesCap + others;
    return {
      usdtd: (100 * this.usdtCap) / total,
      btcd: (100 * this.supply.get('BTC')! * btcPrice) / total,
      totalCap: total,
      coveredShare: live / total,
      ts,
    };
  }
}

export interface DominanceOptions {
  binanceWsUrl: string;
  coingeckoUrl: string;
  coingeckoApiKey?: string;
  refreshMs?: number;
  topN?: number;
  fetchImpl?: typeof fetch;
}

/** Streams Binance mini-tickers, anchors to CoinGecko, emits 1 Hz samples. */
export class DominanceService extends EventEmitter {
  readonly calc = new DominanceCalculator();
  readonly prices = new Map<string, number>();
  private readonly priceTs = new Map<string, number>();
  private ws: WebSocket | null = null;
  private timers: NodeJS.Timeout[] = [];
  private closed = false;
  latest: DominanceSample | undefined;
  lastError: string | undefined;

  constructor(private readonly o: DominanceOptions) {
    super();
  }

  start(): void {
    this.closed = false;
    void this.refreshBaseline();
    this.timers.push(setInterval(() => void this.refreshBaseline(), this.o.refreshMs ?? 5 * 60_000));
    this.timers.push(setInterval(() => this.tick(), 1000));
    this.connect();
  }

  stop(): void {
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    this.ws?.close();
  }

  /** Feed Binance !miniTicker@arr payloads (also used by tests). */
  onMiniTickers(rows: Array<{ s?: string; c?: string; E?: number }>): void {
    for (const r of rows) {
      if (!r.s || !r.s.endsWith('USDT')) continue;
      const p = Number(r.c);
      if (!(p > 0)) continue;
      const sym = r.s.slice(0, -4);
      this.prices.set(sym, p);
      this.priceTs.set(sym, r.E ?? Date.now());
    }
  }

  private livePrices(now: number): Map<string, number> {
    const out = new Map<string, number>();
    for (const [sym, p] of this.prices) if (now - (this.priceTs.get(sym) ?? 0) < 60_000) out.set(sym, p);
    return out;
  }

  tick(now = Date.now()): DominanceSample | undefined {
    const s = this.calc.compute(this.livePrices(now), now);
    if (s) {
      this.latest = s;
      this.emit('sample', s);
    }
    return s;
  }

  async refreshBaseline(): Promise<void> {
    const f = this.o.fetchImpl ?? fetch;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.o.coingeckoApiKey) headers['x-cg-demo-api-key'] = this.o.coingeckoApiKey;
    try {
      const base = this.o.coingeckoUrl.replace(/\/$/, '');
      const [g, m] = await Promise.all([
        f(`${base}/global`, { headers, signal: AbortSignal.timeout(8000) }),
        f(`${base}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${this.o.topN ?? 50}&page=1`, { headers, signal: AbortSignal.timeout(8000) }),
      ]);
      if (!g.ok || !m.ok) throw new Error(`CoinGecko HTTP ${g.status}/${m.status}`);
      const global = (await g.json()) as { data?: { total_market_cap?: { usd?: number } } };
      const markets = (await m.json()) as Array<{ symbol: string; current_price: number; market_cap: number }>;
      const total = Number(global.data?.total_market_cap?.usd);
      this.calc.setBaseline(
        markets.map((c) => ({ symbol: c.symbol, price: Number(c.current_price), marketCap: Number(c.market_cap) })),
        total,
        this.livePrices(Date.now()),
        Date.now(),
      );
      this.lastError = undefined;
    } catch (e) {
      this.lastError = `baseline: ${(e as Error).message}`;
      log.warn('dominance baseline refresh failed', { error: this.lastError });
    }
  }

  private connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.o.binanceWsUrl);
    this.ws = ws;
    ws.on('message', (buf) => {
      try {
        const msg = JSON.parse(buf.toString());
        const rows = Array.isArray(msg) ? msg : Array.isArray(msg?.data) ? msg.data : null;
        if (rows) this.onMiniTickers(rows);
      } catch { /* ignore */ }
    });
    ws.on('open', () => log.info('binance stream connected', { url: this.o.binanceWsUrl }));
    ws.on('close', () => { if (!this.closed) setTimeout(() => this.connect(), 5000); });
    ws.on('error', (e) => { this.lastError = `binance: ${String(e)}`; });
  }
}
