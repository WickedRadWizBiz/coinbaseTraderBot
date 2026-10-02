// Live taker order flow from the Coinbase Exchange public trade feed ("matches" channel), bucketed
// into 15-minute bars of taker-buy volume. Coinbase REST candles carry total volume only; this feed
// supplies the split, so live candles have the same `tb` field as the Binance history the TA
// network trains on. A match's `side` is the MAKER's side: side = 'sell' means an aggressive buyer.
//
// A bucket is reported only if the feed was connected for the whole bar (any disconnect inside it
// marks it incomplete), so a partial count is never mistaken for real flow.

import WebSocket from 'ws';
import { logger } from '../util/log';

const log = logger('taker-flow');
const Q = 900_000;

interface Bucket { buy: number; total: number; complete: boolean }

export class TakerFlowFeed {
  private ws?: WebSocket;
  private readonly buckets = new Map<string, Map<number, Bucket>>();
  /** Start of the current uninterrupted connection (0 = disconnected). */
  private upSince = 0;
  private stopped = false;
  private retry = 1000;
  lastError?: string;

  constructor(
    private readonly assets: string[],
    private readonly url = 'wss://ws-feed.exchange.coinbase.com',
    private readonly now: () => number = Date.now,
    private readonly makeSocket: (url: string) => WebSocket = (u) => new WebSocket(u),
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = this.makeSocket(this.url);
    this.ws = ws;
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', product_ids: this.assets.map((a) => `${a}-USD`), channels: ['matches'] }));
      this.retry = 1000;
    });
    ws.on('message', (raw: WebSocket.RawData) => {
      try { this.onMessage(JSON.parse(String(raw))); } catch { /* ignore malformed */ }
    });
    ws.on('close', () => this.onDown('closed'));
    ws.on('error', (e: Error) => { this.lastError = e.message; this.onDown(e.message); });
  }

  private onDown(why: string): void {
    if (this.upSince) log.warn('Coinbase trade feed down; order-flow buckets marked incomplete', { why });
    this.markGap(this.now());
    this.upSince = 0;
    if (this.stopped) return;
    const wait = this.retry;
    this.retry = Math.min(60_000, this.retry * 2);
    setTimeout(() => this.connect(), wait).unref?.();
  }

  /** Every bucket overlapping the current time loses its completeness. */
  private markGap(t: number): void {
    const b = Math.floor(t / Q) * Q;
    for (const m of this.buckets.values()) { const x = m.get(b); if (x) x.complete = false; }
  }

  /** Feed one Coinbase message (exposed for tests and replay). */
  onMessage(m: { type?: string; product_id?: string; size?: string | number; side?: string; time?: string }): void {
    if (m.type === 'subscriptions') { if (!this.upSince) this.upSince = this.now(); return; }
    if (m.type !== 'match' && m.type !== 'last_match') return;
    if (!this.upSince) this.upSince = this.now();
    const asset = String(m.product_id ?? '').replace(/-USD$/, '');
    const size = Number(m.size);
    const t = m.time ? Date.parse(m.time) : this.now();
    if (!asset || !(size > 0) || !Number.isFinite(t)) return;
    let per = this.buckets.get(asset);
    if (!per) { per = new Map(); this.buckets.set(asset, per); }
    const b = Math.floor(t / Q) * Q;
    let x = per.get(b);
    // Complete only if the connection was already up when the bar opened.
    if (!x) { x = { buy: 0, total: 0, complete: this.upSince > 0 && this.upSince <= b }; per.set(b, x); }
    x.total += size;
    if (m.side === 'sell') x.buy += size;
    for (const k of per.keys()) if (k < b - 3 * 86_400_000) per.delete(k);
  }

  /** Taker-buy volume of the bar [ts, ts + periodMs), scaled to the candle's own volume, when the feed
   *  covered every 15-minute bucket of it; undefined otherwise. */
  takerBuy(asset: string, ts: number, periodMs: number, candleVolume: number): number | undefined {
    const per = this.buckets.get(asset);
    if (!per || ts + periodMs > this.now()) return undefined;
    let buy = 0, total = 0;
    for (let b = ts; b < ts + periodMs; b += Q) {
      const x = per.get(b);
      if (!x?.complete) return undefined;
      buy += x.buy; total += x.total;
    }
    return total > 0 ? candleVolume * (buy / total) : undefined;
  }
}
