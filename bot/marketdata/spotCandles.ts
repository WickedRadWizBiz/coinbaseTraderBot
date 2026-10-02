// Coinbase Exchange public candles for the spot USD pair behind each contract (BTC-USD, ETH-USD,
// ...), on the TA library's timeframes: 1m, 5m, 15m, 1h, 1d (4h is built from 1h). Polled on a
// cadence matching each timeframe; every fetch emits the rows so MarketData can feed FeatureHub
// and record them (replay and training see the same candles, at the time they were known).
// Feature input only: never a pricing or settlement source.

import { EventEmitter } from 'events';
import type { CandleRow } from '../ta/candleStore';
import type { Timeframe } from '../ta/knowledge';
import { logger } from '../util/log';

const log = logger('spot-candles');

const GRANULARITY: Partial<Record<Timeframe, number>> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1d': 86400 };
const EVERY_MS: Partial<Record<Timeframe, number>> = { '1m': 60_000, '5m': 150_000, '15m': 300_000, '1h': 600_000, '1d': 3_600_000 };

export class SpotCandleFeed extends EventEmitter {
  private timer?: NodeJS.Timeout;
  private readonly next = new Map<string, number>();
  private readonly dead = new Set<string>();
  private busy = false;

  constructor(
    private readonly assets: string[],
    private readonly baseUrl = 'https://api.exchange.coinbase.com',
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    /** Live taker order flow; when it covered a whole bar the row carries its taker-buy volume. */
    private readonly flow?: { takerBuy(asset: string, ts: number, periodMs: number, volume: number): number | undefined },
  ) { super(); }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 5_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass: fetch every (asset, timeframe) that is due, sequentially (well inside public rate limits). */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const asset of this.assets) {
        if (this.dead.has(asset)) continue;
        for (const tf of Object.keys(GRANULARITY) as Timeframe[]) {
          const key = `${asset}:${tf}`;
          const now = this.now();
          if ((this.next.get(key) ?? 0) > now) continue;
          this.next.set(key, now + EVERY_MS[tf]!);
          try {
            const rows = this.withFlow(asset, tf, await this.fetchCandles(asset, tf));
            if (rows.length) this.emit('candles', { asset, tf, rows, ts: this.now() });
          } catch (e) {
            if ((e as Error).message.includes('HTTP 404')) { this.dead.add(asset); log.warn(`no Coinbase ${asset}-USD product: TA disabled for ${asset}`); break; }
            this.next.set(key, now + 30_000);
          }
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private withFlow(asset: string, tf: Timeframe, rows: CandleRow[]): CandleRow[] {
    const g = GRANULARITY[tf];
    if (!this.flow || !g || g < 900) return rows;
    return rows.map((r) => { const tb = this.flow!.takerBuy(asset, r[0] * 1000, g * 1000, r[5]); return tb === undefined ? r : [r[0], r[1], r[2], r[3], r[4], r[5], tb] as CandleRow; });
  }

  async fetchCandles(asset: string, tf: Timeframe): Promise<CandleRow[]> {
    const url = `${this.baseUrl}/products/${encodeURIComponent(`${asset}-USD`)}/candles?granularity=${GRANULARITY[tf]}`;
    const res = await this.fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': 'kalshi-bot-ta' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`candles ${asset} ${tf}: HTTP ${res.status}`);
    const data = (await res.json()) as unknown[];
    return (Array.isArray(data) ? data : [])
      .map((r) => (Array.isArray(r) ? r.map(Number) : []))
      .filter((r) => r.length >= 6 && r.every(Number.isFinite))
      .map((r) => [r[0], r[1], r[2], r[3], r[4], r[5]] as CandleRow);
  }
}
