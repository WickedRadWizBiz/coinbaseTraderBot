// Spot USD order book for the dashboard's depth view (display only; never an
// input to pricing or trading). Coinbase Exchange public Level-2 book for the
// pair matching the contract's underlying, cached briefly per product.

import type { BookLevel } from '../kalshi/types';

export interface SpotBook {
  product: string;
  bids: BookLevel[];
  asks: BookLevel[];
  ts: number;
  /** Size resting in fixed-width bands out from the mid, over the whole book (bandBps wide; [0] = nearest band). */
  bands?: { bps: number; bids: number[]; asks: number[] };
}

/** Sums each side's size into `n` bands `bps` basis points wide, measured out from the mid; levels past the last band
 *  are left out. Lets a short recording line see walls well beyond the top levels (BTC's top 10 span a few dollars). */
export function bandDepth(bids: BookLevel[], asks: BookLevel[], bps: number, n: number): SpotBook['bands'] {
  if (!bids.length || !asks.length || bps <= 0 || n <= 0) return undefined;
  const mid = (bids[0].price + asks[0].price) / 2;
  const sum = (rows: BookLevel[]) => {
    const out = new Array<number>(n).fill(0);
    for (const l of rows) {
      const i = Math.floor((Math.abs(l.price - mid) / mid) * 10_000 / bps);
      if (i < n) out[i] += l.size;
    }
    return out.map((v) => Number(v.toPrecision(6)));
  };
  return { bps, bids: sum(bids), asks: sum(asks) };
}

export class SpotBookService {
  private readonly cache = new Map<string, { book: SpotBook; at: number }>();
  private readonly inflight = new Map<string, Promise<SpotBook>>();

  constructor(
    private readonly baseUrl = 'https://api.exchange.coinbase.com',
    private readonly ttlMs = 2000,
    private readonly depth = 50,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly band: { bps: number; n: number } = { bps: 0, n: 0 },
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
      (rows ?? [])
        .map((r) => ({ price: Number(r[0]), size: Number(r[1]) }))
        .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0);
    const bids = lv(data.bids), asks = lv(data.asks);
    const book: SpotBook = { product, bids: bids.slice(0, this.depth), asks: asks.slice(0, this.depth), ts: Date.now() };
    const bands = bandDepth(bids, asks, this.band.bps, this.band.n);
    if (bands) book.bands = bands;
    this.cache.set(product, { book, at: Date.now() });
    return book;
  }
}

/** Records the spot book (top `depth` levels a side) of each coin every `everyMs` as a 'spot_book' recording line
 *  ({asset, b: [[price, size]...], a: [...]}, best first). One request at a time, spread over the period (Coinbase's
 *  public limit is 10 a second); a product Coinbase does not list (404) is not asked again for an hour. */
export class SpotBookRecorder {
  private timer?: NodeJS.Timeout;
  private readonly skipUntil = new Map<string, number>();
  private running = false;

  constructor(
    private readonly assets: () => string[],
    private readonly write: (asset: string, book: SpotBook) => void,
    private readonly everyMs: number,
    private readonly books: SpotBookService,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.everyMs > 0 && !this.timer) { this.timer = setInterval(() => void this.round(), this.everyMs); this.timer.unref(); }
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  /** One pass over the coins (exposed for tests). */
  async round(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let n = 0;
    try {
      for (const asset of this.assets()) {
        if ((this.skipUntil.get(asset) ?? 0) > this.now()) continue;
        try {
          this.write(asset, await this.books.get(asset));
          n++;
        } catch (e) {
          if (String(e).includes('HTTP 404')) this.skipUntil.set(asset, this.now() + 3_600_000);
        }
      }
    } finally { this.running = false; }
    return n;
  }
}

/** A book as a compact recording line: [[price, size]...] per side, best first; with bands, `bw` (band width in bps)
 *  and `bb`/`ba` (size per band, nearest first). */
export function spotBookLine(asset: string, b: SpotBook): Record<string, unknown> {
  const line: Record<string, unknown> = { asset, b: b.bids.map((l) => [l.price, l.size]), a: b.asks.map((l) => [l.price, l.size]), ts: b.ts };
  if (b.bands) Object.assign(line, { bw: b.bands.bps, bb: b.bands.bids, ba: b.bands.asks });
  return line;
}
