// Live index series for the TA network: hourly bars of USDT.D, BTC.D and BTCDOM built from the
// dominance feed, appended to the history store (source bot-index) as each hour closes, and read back
// through the same splice / calibration as training (loadIndexSeries), so live inputs match history.

import type { Candle } from '../ta/indicators';
import { logger } from '../util/log';
import { loadIndexSeries, readSeries, seriesPath, upsertSeries, type HistTf } from './historyStore';

const log = logger('index-bars');
const H = 3_600_000;

/** Index series the TA network reads, and at which timeframe. */
export const TANET_INDEX_SERIES: Array<{ asset: string; tf: HistTf }> = [{ asset: 'BTCDOM', tf: '1h' }, { asset: 'BTC.D', tf: '1d' }, { asset: 'USDT.D', tf: '1d' },
  // Slow context from TradingView (refreshed daily by the pipeline): TOTAL3, OTHERS.D, US Russell 2000.
  { asset: 'TOTAL3', tf: '1d' }, { asset: 'OTHERS.D', tf: '1d' }, { asset: 'RTY', tf: '1d' }];

/** Hourly OHLC bars of live index values, written to <dir>/bot-index/<ASSET>/1h.csv when each hour ends. */
export class IndexBars {
  private readonly forming = new Map<string, Candle>();
  /** Called after a bar is written (e.g. to refresh an IndexStore). */
  onClose?: (asset: string, bar: Candle) => void;

  constructor(private readonly dir: string | undefined) {}

  add(asset: string, value: number | undefined, ts: number): void {
    if (!(value! > 0) || !Number.isFinite(ts)) return;
    const hour = Math.floor(ts / H) * H;
    let b = this.forming.get(asset);
    if (b && b.ts !== hour) { this.close(asset, b); b = undefined; }
    if (!b) this.forming.set(asset, { ts: hour, o: value!, h: value!, l: value!, c: value!, v: 0 });
    else { b.h = Math.max(b.h, value!); b.l = Math.min(b.l, value!); b.c = value!; }
  }

  /** Close every bar whose hour has ended (call periodically: a quiet feed still closes on time). */
  flush(now: number): void {
    for (const [asset, b] of this.forming) if (b.ts + H <= now) { this.forming.delete(asset); this.close(asset, b); }
  }

  private close(asset: string, b: Candle): void {
    if (this.dir) {
      try { upsertSeries(this.dir, 'bot-index', asset, '1h', [b]); } catch (e) { log.warn('could not store index bar', { asset, error: (e as Error).message }); }
    }
    this.onClose?.(asset, b);
  }

  /** Last stored value of a series from any source (to continue the live BTCDOM level). */
  static lastStored(dir: string, asset: string): number | undefined {
    let best: Candle | undefined;
    for (const source of ['bot-index', 'binance-index', 'tradingview']) {
      const cs = readSeries(seriesPath(dir, source, asset, '1h'));
      const last = cs[cs.length - 1];
      if (last && (!best || last.ts > best.ts)) best = last;
    }
    return best?.c;
  }
}

/** The index series the TA network reads, loaded from the history store and reloaded when a new
 *  live bar has been written (at most hourly), so they are spliced and calibrated exactly as in
 *  training. */
export class IndexStore {
  private series = new Map<string, Candle[]>();
  private loadedAt = 0;
  private stale = true;

  constructor(private readonly dir: string | undefined, private readonly now: () => number = Date.now) {}

  /** Mark for reload (a live bar was written). */
  invalidate(): void { this.stale = true; }

  get(asset: string, tf: HistTf): Candle[] | undefined {
    if (!this.dir) return undefined;
    if (this.stale || this.now() - this.loadedAt > H) this.reload();
    return this.series.get(`${asset}|${tf}`);
  }

  reload(): void {
    if (!this.dir) return;
    for (const { asset, tf } of TANET_INDEX_SERIES) {
      try { this.series.set(`${asset}|${tf}`, loadIndexSeries(this.dir, asset, tf).candles); } catch (e) { log.warn('could not load index series', { asset, tf, error: (e as Error).message }); }
    }
    this.loadedAt = this.now();
    this.stale = false;
  }
}
