// Token-bucket limiter mirroring Kalshi's scheme (Basic tier: 200 read / 100
// write tokens per second, most requests cost 10). Callers await a token
// instead of discovering the limit through 429s.

export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly waiters: Array<{ cost: number; resolve: () => void }> = [];
  private timer: NodeJS.Timeout | null = null;
  /** No tokens are handed out before this time (set after a 429, so every caller backs off together). */
  private pausedUntil = 0;
  private strikes = 0;

  constructor(private readonly capacity: number, private readonly refillPerSec: number, private readonly now: () => number = Date.now) {
    this.tokens = capacity;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    if (t < this.last) return;
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.refillPerSec);
    this.last = t;
  }

  /**
   * The exchange answered 429: the real limit is lower than this bucket thinks (another client on the
   * same IP or account, or a stricter tier). Pause all callers, doubling per consecutive 429
   * (1 s, 2 s, 4 s ... 30 s), at least `minMs` (the server's Retry-After), and empty the bucket so the
   * restart is gradual.
   */
  rateLimited(minMs = 0): number {
    const ms = Math.max(Math.min(minMs, 120_000), Math.min(30_000, 1000 * 2 ** Math.min(this.strikes, 5)));
    this.strikes++;
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
    this.tokens = 0;
    this.last = this.pausedUntil;
    return ms;
  }

  /** A request succeeded: the back-off resets. */
  ok(): void { this.strikes = 0; }

  /** Callers waiting for a token (a growing queue means requests arrive faster than the limit). */
  get queued(): number { return this.waiters.length; }

  tryTake(cost: number): boolean {
    if (this.now() < this.pausedUntil) return false;
    this.refill();
    if (this.waiters.length === 0 && this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  take(cost: number): Promise<void> {
    if (this.tryTake(cost)) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.push({ cost, resolve });
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.now() < this.pausedUntil) { this.schedule(); return; }
      this.refill();
      while (this.waiters.length && this.tokens >= this.waiters[0].cost) {
        const w = this.waiters.shift()!;
        this.tokens -= w.cost;
        w.resolve();
      }
      if (this.waiters.length) this.schedule();
    }, 20);
  }
}

export const REQUEST_COST = 10;

export class KalshiRateLimiter {
  readonly read: TokenBucket;
  readonly write: TokenBucket;
  constructor(readPerSec = 200, writePerSec = 100) {
    this.read = new TokenBucket(readPerSec, readPerSec);
    this.write = new TokenBucket(writePerSec, writePerSec);
  }
}
