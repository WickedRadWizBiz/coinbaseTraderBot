// Local YES-side order book per market, rebuilt from snapshot + deltas.
// A book that has not been snapshotted, or has seen a sequence gap, is not
// usable: `isUsable` is false until a fresh snapshot arrives.

import type { BookLevel, BookSnapshot } from '../kalshi/types';

const key = (p: number) => Math.round(p * 10000);

export class OrderBook {
  private readonly bids = new Map<number, number>(); // yes price (1e-4 units) -> size
  private readonly asks = new Map<number, number>();
  private snapshotted = false;
  lastUpdateTs = 0;
  /** Last time the feed was known live with this book intact (a quiet book on a live feed is current). */
  private aliveTs = 0;

  constructor(readonly ticker: string) {}

  applySnapshot(s: { bids: BookLevel[]; asks: BookLevel[] }, ts: number): void {
    this.bids.clear();
    this.asks.clear();
    for (const l of s.bids) if (l.size > 0) this.bids.set(key(l.price), l.size);
    for (const l of s.asks) if (l.size > 0) this.asks.set(key(l.price), l.size);
    this.snapshotted = true;
    this.lastUpdateTs = ts;
  }

  /** Apply a delta on the YES bid ('bid') or YES ask ('ask') side. */
  applyDelta(side: 'bid' | 'ask', price: number, delta: number, ts: number): void {
    if (!this.snapshotted) return;
    const m = side === 'bid' ? this.bids : this.asks;
    const k = key(price);
    const next = (m.get(k) ?? 0) + delta;
    if (next <= 1e-9) m.delete(k);
    else m.set(k, next);
    this.lastUpdateTs = ts;
  }

  invalidate(): void {
    this.snapshotted = false;
  }

  /** The sequenced feed is live and this book has had no gap: it is current even without new deltas. */
  markAlive(ts: number): void {
    if (this.snapshotted) this.aliveTs = ts;
  }

  isUsable(now: number, maxAgeMs: number): boolean {
    return this.snapshotted && now - Math.max(this.lastUpdateTs, this.aliveTs) <= maxAgeMs && !this.isCrossed();
  }

  isCrossed(): boolean {
    const b = this.bestBid();
    const a = this.bestAsk();
    return b !== undefined && a !== undefined && b.price >= a.price;
  }

  bestBid(): BookLevel | undefined {
    let best: number | undefined;
    for (const k of this.bids.keys()) if (best === undefined || k > best) best = k;
    return best === undefined ? undefined : { price: best / 10000, size: this.bids.get(best)! };
  }

  bestAsk(): BookLevel | undefined {
    let best: number | undefined;
    for (const k of this.asks.keys()) if (best === undefined || k < best) best = k;
    return best === undefined ? undefined : { price: best / 10000, size: this.asks.get(best)! };
  }

  /** Size resting at an exact YES price on one side. */
  sizeAt(side: 'bid' | 'ask', price: number): number {
    return (side === 'bid' ? this.bids : this.asks).get(key(price)) ?? 0;
  }

  mid(): number | undefined {
    const b = this.bestBid();
    const a = this.bestAsk();
    if (!b || !a) return undefined;
    return (b.price + a.price) / 2;
  }

  /** Top-N depth imbalance in [-1, 1]; positive = more YES bid size. */
  imbalance(levels = 3): number {
    const top = (m: Map<number, number>, desc: boolean) =>
      [...m.entries()].sort((x, y) => (desc ? y[0] - x[0] : x[0] - y[0])).slice(0, levels).reduce((s, [, v]) => s + v, 0);
    const b = top(this.bids, true);
    const a = top(this.asks, false);
    return b + a > 0 ? (b - a) / (b + a) : 0;
  }

  snapshot(depth = 10): BookSnapshot {
    const lv = (m: Map<number, number>, desc: boolean) =>
      [...m.entries()].sort((x, y) => (desc ? y[0] - x[0] : x[0] - y[0])).slice(0, depth).map(([k, v]) => ({ price: k / 10000, size: v }));
    return { ticker: this.ticker, bids: lv(this.bids, true), asks: lv(this.asks, false), ts: this.lastUpdateTs };
  }
}
