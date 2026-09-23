/**
 * RateLimitManager
 * 
 * Asynchronous Token Bucket Rate Limiter and Traffic Governor.
 * 
 * Key Features:
 * - 4 Independent Buckets: PREDICTIONS_READ, PREDICTIONS_WRITE, PERPS_READ, PERPS_WRITE
 * - Asynchronous token acquisition with continuous millisecond refill
 * - Configurable burst capacities (1.0x Read capacity, 3.0x Write burst banking)
 * - Priority-aware load shedding and traffic reservation
 * - Exponential backoff circuit breaker for 429 (Too Many Requests) errors
 */

export type MarketType = 'PREDICTIONS' | 'PERPS';
export type OperationType = 'READ' | 'WRITE';

export type BucketKey = 
  | 'PREDICTIONS_READ' 
  | 'PREDICTIONS_WRITE' 
  | 'PERPS_READ' 
  | 'PERPS_WRITE';

export type RequestPriority = 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';

export type RateLimitTier = 
  | 'Basic' 
  | 'Advanced' 
  | 'Expert' 
  | 'Premier' 
  | 'Paragon' 
  | 'Prime' 
  | 'Prestige'
  | 'Custom';

export interface TierConfiguration {
  readBudgetPerSec: number;
  writeBudgetPerSec: number;
  readBurstMultiplier: number;
  writeBurstMultiplier: number;
}

export const RATE_LIMIT_TIERS: Record<Exclude<RateLimitTier, 'Custom'>, TierConfiguration> = {
  Basic: {
    readBudgetPerSec: 200,
    writeBudgetPerSec: 100,
    readBurstMultiplier: 1.0,
    writeBurstMultiplier: 1.0
  },
  Advanced: {
    readBudgetPerSec: 300,
    writeBudgetPerSec: 300,
    readBurstMultiplier: 1.0,
    writeBurstMultiplier: 3.0 // Banks up to 3 seconds of write budget
  },
  Expert: {
    readBudgetPerSec: 600,
    writeBudgetPerSec: 600,
    readBurstMultiplier: 1.0,
    writeBurstMultiplier: 3.0
  },
  Premier: {
    readBudgetPerSec: 1200,
    writeBudgetPerSec: 1200,
    readBurstMultiplier: 1.0,
    writeBurstMultiplier: 3.0
  },
  Paragon: {
    readBudgetPerSec: 2400,
    writeBudgetPerSec: 2400,
    readBurstMultiplier: 1.0,
    writeBurstMultiplier: 3.0
  },
  Prime: {
    readBudgetPerSec: 4800,
    writeBudgetPerSec: 4800,
    readBurstMultiplier: 1.0,
    writeBurstMultiplier: 3.0
  },
  Prestige: {
    readBudgetPerSec: 12000,
    writeBudgetPerSec: 9600,
    readBurstMultiplier: 1.0,
    writeBurstMultiplier: 3.0
  }
};

export type CircuitState = 'CLOSED' | 'HALF_OPEN' | 'OPEN';

export interface TokenBucketState {
  key: BucketKey;
  marketType: MarketType;
  operationType: OperationType;
  tokens: number;
  maxCapacity: number;
  refillRatePerSec: number;
  burstMultiplier: number;
  lastRefillTimestamp: number;
  totalTokensConsumed: number;
  totalRequestsServed: number;
  totalRequestsShed: number;
  total429s: number;
  consecutive429s: number;
  circuitState: CircuitState;
  backoffUntil: number;
}

export interface BucketStats {
  tokens: number;
  maxCapacity: number;
  fillPercentage: number;
  refillRatePerSec: number;
  burstMultiplier: number;
  status: 'OPTIMAL' | 'CONSTRAINED' | 'DRAINED' | 'CIRCUIT_OPEN';
  circuitState: CircuitState;
  backoffRemainingMs: number;
  totalTokensConsumed: number;
  totalRequestsServed: number;
  totalRequestsShed: number;
  total429s: number;
  consecutive429s: number;
}

export interface RateLimitManagerStats {
  tier: RateLimitTier;
  tierSource: 'AUTO_DETECTED' | 'CONFIGURED_DEFAULT';
  lastTierCheckTime: number;
  buckets: Record<BucketKey, BucketStats>;
  throughput: {
    tokensConsumedPerSec: number;
    requestsPerSec: number;
  };
  totalShedded: number;
  totalProcessed: number;
  total429s: number;
}

export interface AcquireOptions {
  priority?: RequestPriority;
  timeoutMs?: number;
  symbol?: string;
  allowShedding?: boolean;
}

export interface ExecuteOptions extends AcquireOptions {
  path?: string;
  method?: string;
  isCancel?: boolean;
  batchSize?: number;
  maxRetries?: number;
  baseRetryDelayMs?: number;
}

export class RateLimitManager {
  private tier: RateLimitTier = 'Basic';
  private tierSource: 'AUTO_DETECTED' | 'CONFIGURED_DEFAULT' = 'CONFIGURED_DEFAULT';
  private lastTierCheckTime: number = 0;
  private customConfig: TierConfiguration | null = null;

  private buckets: Record<BucketKey, TokenBucketState>;
  private refillIntervalId: any = null;
  private throughputIntervalId: any = null;

  private tokenConsumptionInLastSec: number = 0;
  private requestsInLastSec: number = 0;
  private currentTokensPerSec: number = 0;
  private currentRequestsPerSec: number = 0;
  private lastThroughputCalcTime: number = Date.now();

  constructor(initialTier: RateLimitTier = 'Basic') {
    this.buckets = {
      PREDICTIONS_READ: this.createInitialBucket('PREDICTIONS_READ', 'PREDICTIONS', 'READ', 200, 1.0),
      PREDICTIONS_WRITE: this.createInitialBucket('PREDICTIONS_WRITE', 'PREDICTIONS', 'WRITE', 100, 1.0),
      PERPS_READ: this.createInitialBucket('PERPS_READ', 'PERPS', 'READ', 200, 1.0),
      PERPS_WRITE: this.createInitialBucket('PERPS_WRITE', 'PERPS', 'WRITE', 100, 1.0)
    };

    this.setTier(initialTier);
    this.startBackgroundRefill();
  }

  private createInitialBucket(
    key: BucketKey,
    marketType: MarketType,
    operationType: OperationType,
    rate: number,
    burstMult: number
  ): TokenBucketState {
    const maxCapacity = rate * burstMult;
    return {
      key,
      marketType,
      operationType,
      tokens: maxCapacity,
      maxCapacity,
      refillRatePerSec: rate,
      burstMultiplier: burstMult,
      lastRefillTimestamp: Date.now(),
      totalTokensConsumed: 0,
      totalRequestsServed: 0,
      totalRequestsShed: 0,
      total429s: 0,
      consecutive429s: 0,
      circuitState: 'CLOSED',
      backoffUntil: 0
    };
  }

  /**
   * Starts background interval for continuous refill and throughput tracking
   */
  private startBackgroundRefill() {
    if (this.refillIntervalId) clearInterval(this.refillIntervalId);
    if (this.throughputIntervalId) clearInterval(this.throughputIntervalId);

    // Continuous tick refill (50ms interval)
    this.refillIntervalId = setInterval(() => {
      this.refillAllBuckets();
    }, 50);

    // Throughput calculator (1-second window)
    this.throughputIntervalId = setInterval(() => {
      const now = Date.now();
      const elapsedSec = (now - this.lastThroughputCalcTime) / 1000;
      if (elapsedSec > 0) {
        this.currentTokensPerSec = Math.round(this.tokenConsumptionInLastSec / elapsedSec);
        this.currentRequestsPerSec = parseFloat((this.requestsInLastSec / elapsedSec).toFixed(1));
        this.tokenConsumptionInLastSec = 0;
        this.requestsInLastSec = 0;
        this.lastThroughputCalcTime = now;
      }
    }, 1000);
  }

  /**
   * Clean up background timers
   */
  public destroy() {
    if (this.refillIntervalId) clearInterval(this.refillIntervalId);
    if (this.throughputIntervalId) clearInterval(this.throughputIntervalId);
  }

  /**
   * Continuous millisecond refill for all buckets
   */
  public refillAllBuckets(): void {
    const now = Date.now();
    for (const key of Object.keys(this.buckets) as BucketKey[]) {
      const bucket = this.buckets[key];
      const elapsedMs = now - bucket.lastRefillTimestamp;
      if (elapsedMs <= 0) continue;

      // Handle circuit cooldown transition
      if (bucket.circuitState === 'OPEN' && now >= bucket.backoffUntil) {
        bucket.circuitState = 'HALF_OPEN';
      }

      const tokensToAdd = (bucket.refillRatePerSec / 1000) * elapsedMs;
      bucket.tokens = Math.min(bucket.maxCapacity, bucket.tokens + tokensToAdd);
      bucket.lastRefillTimestamp = now;
    }
  }

  /**
   * Refill a specific bucket and return its updated state
   */
  public refillBucket(key: BucketKey): TokenBucketState {
    const bucket = this.buckets[key];
    const now = Date.now();
    const elapsedMs = now - bucket.lastRefillTimestamp;
    if (elapsedMs > 0) {
      if (bucket.circuitState === 'OPEN' && now >= bucket.backoffUntil) {
        bucket.circuitState = 'HALF_OPEN';
      }
      const tokensToAdd = (bucket.refillRatePerSec / 1000) * elapsedMs;
      bucket.tokens = Math.min(bucket.maxCapacity, bucket.tokens + tokensToAdd);
      bucket.lastRefillTimestamp = now;
    }
    return bucket;
  }

  /**
   * Resolve BucketKey from market and operation types
   */
  public getBucketKey(marketType: MarketType, opType: OperationType): BucketKey {
    return `${marketType}_${opType}` as BucketKey;
  }

  /**
   * Determine target bucket from endpoint path and HTTP method
   */
  public determineBucket(path: string, method: string = 'GET'): BucketKey {
    const cleanPath = path.toLowerCase();
    const isPerp = cleanPath.includes('/margin/') || cleanPath.includes('/perps/') || cleanPath.includes('perp');
    const isWrite = ['POST', 'DELETE', 'PUT', 'PATCH'].includes(method.toUpperCase());

    const marketType: MarketType = isPerp ? 'PERPS' : 'PREDICTIONS';
    const opType: OperationType = isWrite ? 'WRITE' : 'READ';
    return this.getBucketKey(marketType, opType);
  }

  /**
   * Update Rate Limit Tier configuration
   */
  public setTier(tier: RateLimitTier, isAutoDetected = false, customConfig?: TierConfiguration) {
    this.tier = tier;
    this.tierSource = isAutoDetected ? 'AUTO_DETECTED' : 'CONFIGURED_DEFAULT';
    this.lastTierCheckTime = Date.now();

    let cfg: TierConfiguration;
    if (tier === 'Custom' && customConfig) {
      this.customConfig = customConfig;
      cfg = customConfig;
    } else {
      cfg = RATE_LIMIT_TIERS[tier as keyof typeof RATE_LIMIT_TIERS] || RATE_LIMIT_TIERS.Basic;
    }

    this.applyTierConfig(cfg);
  }

  private applyTierConfig(cfg: TierConfiguration) {
    this.updateBucketConfig('PREDICTIONS_READ', cfg.readBudgetPerSec, cfg.readBurstMultiplier);
    this.updateBucketConfig('PREDICTIONS_WRITE', cfg.writeBudgetPerSec, cfg.writeBurstMultiplier);
    this.updateBucketConfig('PERPS_READ', cfg.readBudgetPerSec, cfg.readBurstMultiplier);
    this.updateBucketConfig('PERPS_WRITE', cfg.writeBudgetPerSec, cfg.writeBurstMultiplier);
  }

  private updateBucketConfig(key: BucketKey, rate: number, burstMultiplier: number) {
    const bucket = this.buckets[key];
    const newMaxCapacity = rate * burstMultiplier;
    bucket.refillRatePerSec = rate;
    bucket.burstMultiplier = burstMultiplier;
    bucket.maxCapacity = newMaxCapacity;
    bucket.tokens = Math.min(bucket.tokens, newMaxCapacity);
  }

  /**
   * Calculates token cost based on API standard policies:
   * - Standard call: 10 tokens
   * - Perp cancel/decrease: 1 token
   * - Batch cancel: 2 tokens per item (or 10 if single)
   * - Batch creation: N * 10 tokens
   */
  public calculateTokenCost(options: {
    path?: string;
    method?: string;
    isCancel?: boolean;
    batchSize?: number;
    marketType?: MarketType;
  }): number {
    const path = (options.path || '').toLowerCase();
    const isPerp = options.marketType === 'PERPS' || path.includes('/margin/') || path.includes('/perps/') || path.includes('perp');
    const isCancel = options.isCancel || path.includes('/cancel') || (options.method?.toUpperCase() === 'DELETE');
    const batchSize = Math.max(1, options.batchSize || 1);

    if (isCancel) {
      if (isPerp) {
        return 1 * batchSize;
      }
      return batchSize > 1 ? 2 * batchSize : 10;
    }

    return 10 * batchSize;
  }

  /**
   * Check non-blocking whether tokens can be consumed immediately
   */
  public canExecute(marketType: MarketType, opType: OperationType, tokenCost: number = 10): boolean {
    const key = this.getBucketKey(marketType, opType);
    const bucket = this.refillBucket(key);
    if (bucket.circuitState === 'OPEN' && Date.now() < bucket.backoffUntil) {
      return false;
    }
    return bucket.tokens >= tokenCost;
  }

  /**
   * Direct synchronous token consumption
   */
  public consume(marketType: MarketType, opType: OperationType, count: number = 10): boolean {
    const key = this.getBucketKey(marketType, opType);
    const bucket = this.refillBucket(key);
    if (bucket.tokens >= count) {
      bucket.tokens -= count;
      bucket.totalTokensConsumed += count;
      bucket.totalRequestsServed++;
      this.tokenConsumptionInLastSec += count;
      this.requestsInLastSec++;
      return true;
    }
    return false;
  }

  /**
   * Asynchronous token acquisition with priority reservation and load shedding
   */
  public async acquire(
    marketType: MarketType,
    opType: OperationType,
    tokenCost: number = 10,
    options: AcquireOptions = {}
  ): Promise<void> {
    const key = this.getBucketKey(marketType, opType);
    const bucket = this.buckets[key];
    const priority = options.priority || (opType === 'READ' ? 'LOW' : 'HIGH');
    const timeoutMs = options.timeoutMs ?? 5000;
    const allowShedding = options.allowShedding ?? true;
    const startTime = Date.now();

    while (true) {
      this.refillBucket(key);

      const now = Date.now();

      // Check Circuit Breaker State
      if (bucket.circuitState === 'OPEN') {
        if (now < bucket.backoffUntil) {
          if (priority !== 'CRITICAL') {
            bucket.totalRequestsShed++;
            throw new Error(`[RATE_LIMIT_CIRCUIT_OPEN] ${key} in 429 backoff cooldown. Shedding ${priority} request.`);
          }
        } else {
          bucket.circuitState = 'HALF_OPEN';
        }
      }

      // Priority Reserve & Load Shedding Thresholds:
      // LOW: requires >= 35% tokens in bucket
      // NORMAL: requires >= 20% tokens in bucket
      // HIGH: requires >= 5% tokens in bucket
      // CRITICAL: 100% permission down to 0 tokens
      const fillRatio = bucket.tokens / bucket.maxCapacity;

      if (allowShedding && priority === 'LOW' && (fillRatio < 0.35 || bucket.circuitState === 'HALF_OPEN')) {
        bucket.totalRequestsShed++;
        throw new Error(`[RATE_LIMIT_LOAD_SHED] Bucket ${key} constrained (${Math.round(fillRatio * 100)}% fill). Shedding LOW priority task.`);
      }

      if (allowShedding && priority === 'NORMAL' && fillRatio < 0.20) {
        bucket.totalRequestsShed++;
        throw new Error(`[RATE_LIMIT_LOAD_SHED] Bucket ${key} constrained (${Math.round(fillRatio * 100)}% fill). Shedding NORMAL priority task.`);
      }

      // Tokens available
      if (bucket.tokens >= tokenCost) {
        bucket.tokens -= tokenCost;
        bucket.totalTokensConsumed += tokenCost;
        bucket.totalRequestsServed++;
        this.tokenConsumptionInLastSec += tokenCost;
        this.requestsInLastSec++;

        if (bucket.circuitState === 'HALF_OPEN') {
          bucket.circuitState = 'CLOSED';
          bucket.consecutive429s = 0;
        }
        return;
      }

      // Deficit handling
      if (allowShedding && priority === 'LOW') {
        bucket.totalRequestsShed++;
        throw new Error(`[RATE_LIMIT_LOAD_SHED] Immediate token deficit in ${key}. Shedding LOW priority request.`);
      }

      if (now - startTime >= timeoutMs) {
        bucket.totalRequestsShed++;
        throw new Error(`[RATE_LIMIT_TIMEOUT] Timed out waiting for ${tokenCost} tokens in ${key} after ${timeoutMs}ms.`);
      }

      // Wait minimum time required for token replenishment
      const deficit = tokenCost - bucket.tokens;
      const waitMs = Math.min(250, Math.max(10, Math.ceil((deficit / bucket.refillRatePerSec) * 1000)));
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }

  /**
   * Handles 429 Too Many Requests errors using exponential backoff with full jitter
   * Drains the affected bucket and opens the circuit breaker.
   */
  public handle429(bucketOrKey: BucketKey | TokenBucketState, options: { symbol?: string; reason?: string } = {}): number {
    const bucket = typeof bucketOrKey === 'string' ? this.buckets[bucketOrKey] : bucketOrKey;
    bucket.total429s++;
    bucket.consecutive429s++;

    // Drain tokens immediately
    bucket.tokens = 0;
    bucket.circuitState = 'OPEN';

    // Exponential backoff: Base 250ms * (1.8 ^ (consecutive429s - 1)) + Jitter (0-150ms), capped at 5000ms
    const baseBackoff = Math.min(5000, 250 * Math.pow(1.8, Math.min(5, bucket.consecutive429s - 1)));
    const jitter = Math.floor(Math.random() * 150);
    const backoffDurationMs = baseBackoff + jitter;

    bucket.backoffUntil = Date.now() + backoffDurationMs;

    console.warn(
      `[RATE_LIMIT_429_BACKOFF] Bucket ${bucket.key} tripped! ` +
      `Consecutive 429s: ${bucket.consecutive429s} | Backoff: ${backoffDurationMs}ms | Target: ${options.symbol || 'GLOBAL'}`
    );

    return backoffDurationMs;
  }

  /**
   * Executes an asynchronous task wrapped with token acquisition and automatic 429 backoff handling
   */
  public async execute<T>(
    task: () => Promise<T>,
    options: ExecuteOptions = {}
  ): Promise<T> {
    const path = options.path || '';
    const method = (options.method || 'GET').toUpperCase();
    const bucketKey = this.determineBucket(path, method);
    const bucket = this.buckets[bucketKey];
    const tokenCost = this.calculateTokenCost({ ...options, marketType: bucket.marketType });
    const priority = options.priority || (method === 'GET' ? 'LOW' : 'HIGH');

    // Acquire tokens
    await this.acquire(bucket.marketType, bucket.operationType, tokenCost, {
      ...options,
      priority
    });

    try {
      const result = await task();
      if (bucket.circuitState === 'HALF_OPEN') {
        bucket.circuitState = 'CLOSED';
        bucket.consecutive429s = 0;
      }
      return result;
    } catch (err: any) {
      const is429 = err?.status === 429 || (err?.message && /429|rate limit|too many requests/i.test(err.message));
      if (is429) {
        this.handle429(bucket, { symbol: options.symbol });
      }
      throw err;
    }
  }

  /**
   * Executes an asynchronous task with automated retries and exponential backoff on 429s
   */
  public async executeWithRetry<T>(
    task: () => Promise<T>,
    options: ExecuteOptions = {}
  ): Promise<T> {
    const maxRetries = options.maxRetries ?? 3;
    let attempt = 0;

    while (attempt <= maxRetries) {
      attempt++;
      try {
        return await this.execute(task, options);
      } catch (err: any) {
        const is429 = err?.status === 429 || (err?.message && /429|rate limit|too many requests/i.test(err.message));
        if (is429 && attempt <= maxRetries) {
          const path = options.path || '';
          const method = (options.method || 'GET').toUpperCase();
          const bucketKey = this.determineBucket(path, method);
          const bucket = this.buckets[bucketKey];
          const remainingBackoff = Math.max(50, bucket.backoffUntil - Date.now());
          await new Promise(r => setTimeout(r, remainingBackoff));
          continue;
        }
        throw err;
      }
    }
    throw new Error(`[RATE_LIMIT_RETRIES_EXHAUSTED] Task failed after ${maxRetries} attempts.`);
  }

  /**
   * Reset all bucket statistics and tokens
   */
  public reset(): void {
    const now = Date.now();
    for (const key of Object.keys(this.buckets) as BucketKey[]) {
      const b = this.buckets[key];
      b.tokens = b.maxCapacity;
      b.lastRefillTimestamp = now;
      b.totalTokensConsumed = 0;
      b.totalRequestsServed = 0;
      b.totalRequestsShed = 0;
      b.total429s = 0;
      b.consecutive429s = 0;
      b.circuitState = 'CLOSED';
      b.backoffUntil = 0;
    }
  }

  /**
   * Snapshot of full system statistics
   */
  public getStats(): RateLimitManagerStats {
    this.refillAllBuckets();
    const now = Date.now();

    const bucketStats: Record<BucketKey, BucketStats> = {} as any;
    let totalShed = 0;
    let totalProc = 0;
    let total429s = 0;

    for (const key of Object.keys(this.buckets) as BucketKey[]) {
      const b = this.buckets[key];
      const fillPct = Math.min(100, Math.max(0, Math.round((b.tokens / b.maxCapacity) * 100)));
      const backoffRemaining = Math.max(0, b.backoffUntil - now);

      let status: 'OPTIMAL' | 'CONSTRAINED' | 'DRAINED' | 'CIRCUIT_OPEN' = 'OPTIMAL';
      if (b.circuitState === 'OPEN') {
        status = 'CIRCUIT_OPEN';
      } else if (fillPct < 15) {
        status = 'DRAINED';
      } else if (fillPct < 40) {
        status = 'CONSTRAINED';
      }

      bucketStats[key] = {
        tokens: Math.round(b.tokens),
        maxCapacity: b.maxCapacity,
        fillPercentage: fillPct,
        refillRatePerSec: b.refillRatePerSec,
        burstMultiplier: b.burstMultiplier,
        status,
        circuitState: b.circuitState,
        backoffRemainingMs: backoffRemaining,
        totalTokensConsumed: b.totalTokensConsumed,
        totalRequestsServed: b.totalRequestsServed,
        totalRequestsShed: b.totalRequestsShed,
        total429s: b.total429s,
        consecutive429s: b.consecutive429s
      };

      totalShed += b.totalRequestsShed;
      totalProc += b.totalRequestsServed;
      total429s += b.total429s;
    }

    return {
      tier: this.tier,
      tierSource: this.tierSource,
      lastTierCheckTime: this.lastTierCheckTime,
      buckets: bucketStats,
      throughput: {
        tokensConsumedPerSec: this.currentTokensPerSec,
        requestsPerSec: this.currentRequestsPerSec
      },
      totalShedded: totalShed,
      totalProcessed: totalProc,
      total429s
    };
  }
}

// Global default singleton instance
export const rateLimitManager = new RateLimitManager('Basic');
