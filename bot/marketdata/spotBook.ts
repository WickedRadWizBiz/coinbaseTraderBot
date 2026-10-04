// Spot USD order book for the dashboard's depth view (display only; never an
// input to pricing or trading). Coinbase Exchange public Level-2 book for the
// pair matching the contract's underlying, cached briefly per product.

import type { BookLevel } from '../kalshi/types';

export interface SpotBook {
  product: string;
  bids: BookLevel[];
  asks: BookLevel[];
  ts: number;
}

export class SpotBookService {
  private readonly cache = new Map<string, { book: SpotBook; at: number }>();
  private readonly inflight = new Map<string, Promise<SpotBook>>();

  constructor(
    private readonly baseUrl = 'https://api.exchange.coinbase.com',
    private readonly ttlMs = 2000,
    private readonly depth = 50,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async get(asset: string): Promise<SpotBook> {
    const product = `${asset.toUpperCase()}-USD`;
    const hit = this.cache.get(product);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.book;
    const pending = this.inflight.get(product);
    if (pending) return pending;
    const p = this.fetchBook(product).finally(() => this.inflight.delete(product));
    this.inflight.set(product, p);
    return p;
  }

  private async fetchBook(product: string): Promise<SpotBook> {
    const res = await this.fetchImpl(`${this.baseUrl}/products/${encodeURIComponent(product)}/book?level=2`, {
      headers: { Accept: 'application/json', 'User-Agent': 'kalshi-bot-dashboard' },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`spot book ${product}: HTTP ${res.status}`);
    const data = (await res.json()) as { bids?: unknown[][]; asks?: unknown[][] };
    const lv = (rows: unknown[][] | undefined) =>
      (rows ?? []).slice(0, this.depth)
        .map((r) => ({ price: Number(r[0]), size: Number(r[1]) }))
        .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0);
    const book: SpotBook = { product, bids: lv(data.bids), asks: lv(data.asks), ts: Date.now() };
    this.cache.set(product, { book, at: Date.now() });
    return book;
  }
}
