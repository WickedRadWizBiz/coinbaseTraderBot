// Token-bucket limiter mirroring Kalshi's scheme (Basic tier: 200 read / 100
// write tokens per second, most requests cost 10). Callers await a token
// instead of discovering the limit through 429s.

export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly waiters: Array<{ cost: number; resolve: () => void }> = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly capacity: number, private readonly refillPerSec: number, private readonly now: () => number = Date.now) {
    this.tokens = capacity;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.refillPerSec);
    this.last = t;
  }

  tryTake(cost: number): boolean {
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
