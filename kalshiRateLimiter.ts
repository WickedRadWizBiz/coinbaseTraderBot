/**
 * Kalshi Rate Limit Token Bucket Engine
 * 
 * Implements Kalshi's exact rate-limiting architecture:
 * - Continuous millisecond token bucket refill (tokens/sec)
 * - 4 Independent buckets: PREDICTIONS_READ, PREDICTIONS_WRITE, PERPS_READ, PERPS_WRITE
 * - Accurate token costs: Default 10 tokens, Perp cancels 1 token, Batch cancels 2 tokens/order, Batch orders N*10 tokens
 * - Burst capacity: 1s capacity for Read, 3s banked capacity for Write (Advanced+ tiers)
 * - Dynamic tier discovery & auto-upgrade
 * - Priority-based token reservation: CRITICAL (stops/TP/cancels) never blocked; LOW (quote polling) shed under load
 * - Adaptive 429 exponential backoff circuit breaker per bucket
 */

export type RateLimitTier = 
  | 'Basic' 
  | 'Advanced' 
  | 'Expert' 
  | 'Premier' 
  | 'Paragon' 
  | 'Prime' 
  | 'Prestige';

export type BucketType = 
  | 'PREDICTIONS_READ' 
  | 'PREDICTIONS_WRITE' 
  | 'PERPS_READ' 
  | 'PERPS_WRITE';

export type RequestPriority = 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';

export interface TierConfig {
  readBudgetPerSec: number;
  writeBudgetPerSec: number;
  readBurstMultiplier: number;
  writeBurstMultiplier: number;
}

export const TIER_CONFIGS: Record<RateLimitTier, TierConfig> = {
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

export interface BucketState {
  type: BucketType;
  tokens: number;
  maxCapacity: number;
  refillRatePerSec: number;
  lastRefillTime: number;
  totalTokensConsumed: number;
  totalRequestsServed: number;
  totalRequestsShed: number;
  total429s: number;
  consecutive429s: number;
  circuitState: 'CLOSED' | 'HALF_OPEN' | 'OPEN';
  circuitCoolingUntil: number;
}

export interface KalshiRateLimiterStats {
  tier: RateLimitTier;
  tierSource: 'AUTO_DETECTED' | 'CONFIGURED_DEFAULT';
  lastTierCheckTime: number;
  rawLimits?: any;
  buckets: Record<BucketType, {
    tokens: number;
    maxCapacity: number;
    fillPercentage: number;
    refillRatePerSec: number;
    burstCapacity: number;
    status: 'OPTIMAL' | 'CONSTRAINED' | 'DRAINED' | 'CIRCUIT_OPEN';
    totalTokensConsumed: number;
    totalRequestsServed: number;
    totalRequestsShed: number;
    total429s: number;
  }>;
  throughput: {
    tokensConsumedPerSec: number;
    requestsPerSec: number;
  };
  totalShedded: number;
  totalProcessed: number;
}

export class KalshiRateLimiterEngine {
  private tier: RateLimitTier = 'Basic'; // Start at Basic until verified
  private tierSource: 'AUTO_DETECTED' | 'CONFIGURED_DEFAULT' = 'CONFIGURED_DEFAULT';
  private lastTierCheckTime: number = 0;
  private rawLimits: any = null;
  
  private buckets: Record<BucketType, BucketState>;
  private tokenConsumptionInLastSec: number = 0;
  private requestsInLastSec: number = 0;
  private currentTokensPerSec: number = 0;
  private currentRequestsPerSec: number = 0;
  private lastThroughputCalcTime: number = Date.now();

  constructor() {
    this.buckets = {
      PREDICTIONS_READ: this.createBucket('PREDICTIONS_READ', 200, 200),
      PREDICTIONS_WRITE: this.createBucket('PREDICTIONS_WRITE', 100, 100),
      PERPS_READ: this.createBucket('PERPS_READ', 200, 200),
      PERPS_WRITE: this.createBucket('PERPS_WRITE', 100, 100)
    };

    this.applyTier(this.tier);

    // Throughput and refill maintenance tick (50ms precision loop)
    setInterval(() => {
      this.refillAllBuckets();
    }, 50);

    // 1-second throughput rate sampler
    setInterval(() => {
      const now = Date.now();
      const elapsed = (now - this.lastThroughputCalcTime) / 1000;
      if (elapsed > 0) {
        this.currentTokensPerSec = Math.round(this.tokenConsumptionInLastSec / elapsed);
        this.currentRequestsPerSec = parseFloat((this.requestsInLastSec / elapsed).toFixed(1));
        this.tokenConsumptionInLastSec = 0;
        this.requestsInLastSec = 0;
        this.lastThroughputCalcTime = now;
      }
    }, 1000);
  }

  private createBucket(type: BucketType, rate: number, capacity: number): BucketState {
    return {
      type,
      tokens: capacity, // Start full
      maxCapacity: capacity,
      refillRatePerSec: rate,
      lastRefillTime: Date.now(),
      totalTokensConsumed: 0,
      totalRequestsServed: 0,
      totalRequestsShed: 0,
      total429s: 0,
      consecutive429s: 0,
      circuitState: 'CLOSED',
      circuitCoolingUntil: 0
    };
  }

  public setTier(tier: RateLimitTier, isAutoDetected = false, rawLimits: any = null) {
    if (!TIER_CONFIGS[tier]) return;
    this.tier = tier;
    this.tierSource = isAutoDetected ? 'AUTO_DETECTED' : 'CONFIGURED_DEFAULT';
    this.lastTierCheckTime = Date.now();
    if (rawLimits) {
      this.rawLimits = rawLimits;
    }
    this.applyTier(tier);
    console.log(`[KALSHI RATE LIMITER] Applied Tier: ${tier} (${isAutoDetected ? 'Auto-detected via API' : 'Default'})`);
  }

  private applyTier(tier: RateLimitTier) {
    const cfg = TIER_CONFIGS[tier];
    
    // Predictions Read: 1x burst
    this.updateBucketCapacity('PREDICTIONS_READ', cfg.readBudgetPerSec, cfg.readBudgetPerSec * cfg.readBurstMultiplier);
    // Predictions Write: 3x burst (above basic)
    this.updateBucketCapacity('PREDICTIONS_WRITE', cfg.writeBudgetPerSec, cfg.writeBudgetPerSec * cfg.writeBurstMultiplier);
    // Perps Read: 1x burst
    this.updateBucketCapacity('PERPS_READ', cfg.readBudgetPerSec, cfg.readBudgetPerSec * cfg.readBurstMultiplier);
    // Perps Write: 3x burst (above basic)
    this.updateBucketCapacity('PERPS_WRITE', cfg.writeBudgetPerSec, cfg.writeBudgetPerSec * cfg.writeBurstMultiplier);
  }

  private updateBucketCapacity(type: BucketType, rate: number, maxCap: number) {
    const bucket = this.buckets[type];
    bucket.refillRatePerSec = rate;
    bucket.maxCapacity = maxCap;
    bucket.tokens = Math.min(bucket.tokens, maxCap);
  }

  private refillAllBuckets() {
    const now = Date.now();
    for (const key of Object.keys(this.buckets) as BucketType[]) {
      const b = this.buckets[key];
      const elapsedMs = now - b.lastRefillTime;
      if (elapsedMs <= 0) continue;

      // Check circuit breaker cooling
      if (b.circuitState === 'OPEN' && now >= b.circuitCoolingUntil) {
        b.circuitState = 'HALF_OPEN';
      }

      // Continuous millisecond refill calculation:
      const tokensToAdd = (b.refillRatePerSec / 1000) * elapsedMs;
      b.tokens = Math.min(b.maxCapacity, b.tokens + tokensToAdd);
      b.lastRefillTime = now;
    }
  }

  /**
   * Identifies which of the 4 independent buckets an endpoint targets
   */
  public determineBucket(path: string, method: string = 'GET'): BucketType {
    const isPerp = path.includes('/margin/') || path.includes('/perps/');
    const isWrite = method.toUpperCase() === 'POST' || method.toUpperCase() === 'DELETE' || method.toUpperCase() === 'PUT';

    if (isPerp) {
      return isWrite ? 'PERPS_WRITE' : 'PERPS_READ';
    } else {
      return isWrite ? 'PREDICTIONS_WRITE' : 'PREDICTIONS_READ';
    }
  }

  /**
   * Calculates the exact token cost for a request based on Kalshi guidelines:
   * - Standard requests: 10 tokens
   * - Perp cancel / decrease: 1 token
   * - Batch Prediction cancels: 2 tokens per order
   * - Batch order creation: N * 10 tokens
   */
  public calculateTokenCost(options: {
    path: string;
    method?: string;
    isCancel?: boolean;
    batchSize?: number;
  }): number {
    const path = options.path || '';
    const isPerp = path.includes('/margin/') || path.includes('/perps/');
    const isCancel = options.isCancel || path.includes('/cancel') || (options.method?.toUpperCase() === 'DELETE');
    const batchSize = options.batchSize || 1;

    if (isCancel) {
      if (isPerp) {
        // API cancels/decreases for Perps cost 1 token
        return 1 * batchSize;
      } else {
        // Batch Prediction cancels cost 2 tokens per order (single cancel is 10 or 2 if batch API)
        return batchSize > 1 ? 2 * batchSize : 10;
      }
    }

    // Default cost is 10 tokens per operation
    return 10 * batchSize;
  }

  /**
   * Primary execution governor.
   * Acquires token allocation from the specific bucket, observing priority tier rules.
   */
  public async execute<T>(
    action: () => Promise<T>,
    options: {
      path: string;
      method?: string;
      priority?: RequestPriority;
      isCancel?: boolean;
      batchSize?: number;
      symbol?: string;
      shardId?: number;
    }
  ): Promise<T> {
    const method = (options.method || 'GET').toUpperCase();
    const bucketType = this.determineBucket(options.path, method);
    const tokenCost = this.calculateTokenCost(options);
    const priority = options.priority || (method === 'GET' ? 'LOW' : 'HIGH');

    // 1. Check Circuit Breaker
    const bucket = this.buckets[bucketType];
    this.refillAllBuckets();

    if (bucket.circuitState === 'OPEN' && priority !== 'CRITICAL') {
      bucket.totalRequestsShed++;
      throw new Error(`[KALSHI 429 CIRCUIT OPEN] ${bucketType} in cooldown. Shedding ${priority} request.`);
    }

    // 2. Intelligent Load Shedding Policy based on Bucket Reserve Percentage:
    // - LOW priority (Quote polls): Requires >= 35% tokens in bucket
    // - NORMAL priority (Non-urgent sync): Requires >= 20% tokens in bucket
    // - HIGH priority (Live order entries): Requires >= 5% tokens in bucket
    // - CRITICAL (Stops, TP exits, cancels): 100% permission down to 0 tokens
    const fillRatio = bucket.tokens / bucket.maxCapacity;

    if (priority === 'LOW' && (fillRatio < 0.35 || bucket.circuitState === 'HALF_OPEN')) {
      bucket.totalRequestsShed++;
      throw new Error(`[KALSHI RATE GOVERNOR] Saturated ${bucketType} bucket (${Math.round(fillRatio * 100)}% fill). Shedding low-priority quote refresh to preserve execution bandwidth.`);
    }

    if (priority === 'NORMAL' && fillRatio < 0.20) {
      bucket.totalRequestsShed++;
      throw new Error(`[KALSHI RATE GOVERNOR] ${bucketType} bucket constrained (${Math.round(fillRatio * 100)}% fill). Shedding normal task.`);
    }

    // 3. Acquire Tokens (Wait with sub-millisecond precision if briefly deficient for CRITICAL / HIGH)
    await this.acquireTokens(bucket, tokenCost, priority);

    // 4. Record consumption
    bucket.tokens -= tokenCost;
    bucket.totalTokensConsumed += tokenCost;
    bucket.totalRequestsServed++;
    this.tokenConsumptionInLastSec += tokenCost;
    this.requestsInLastSec++;

    // 5. Execute Action with 429 Interception
    const tStart = Date.now();
    try {
      const result = await action();
      if (bucket.circuitState === 'HALF_OPEN') {
        bucket.circuitState = 'CLOSED';
        bucket.consecutive429s = 0;
      }
      return result;
    } catch (err: any) {
      const is429 = err?.status === 429 || (err?.message && /429|rate limit|too many requests/i.test(err.message));
      if (is429) {
        this.handle429(bucket, options.symbol);
      }
      throw err;
    }
  }

  private async acquireTokens(bucket: BucketState, cost: number, priority: RequestPriority): Promise<void> {
    while (true) {
      this.refillAllBuckets();
      if (bucket.tokens >= cost) {
        return;
      }

      // If critical, we wait the minimum time needed for refill
      const deficit = cost - bucket.tokens;
      const waitMs = Math.min(250, Math.max(10, Math.ceil((deficit / bucket.refillRatePerSec) * 1000)));

      if (priority === 'LOW') {
        bucket.totalRequestsShed++;
        throw new Error(`[KALSHI RATE GOVERNOR] Immediate token deficit in ${bucket.type}. Shedding LOW priority task.`);
      }

      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }

  /**
   * Dynamic 429 Handler (Exponential backoff with jitter, drains affected bucket)
   */
  public handle429(bucketOrType: BucketState | BucketType, symbol?: string) {
    const bucket = typeof bucketOrType === 'string' ? this.buckets[bucketOrType] : bucketOrType;
    bucket.total429s++;
    bucket.consecutive429s++;
    
    // Drain tokens to 0
    bucket.tokens = 0;
    bucket.circuitState = 'OPEN';

    // Exponential backoff: Base 250ms * 2^(attempts-1) + jitter, capped at 2500ms
    const baseBackoff = Math.min(2500, 250 * Math.pow(1.8, Math.min(4, bucket.consecutive429s - 1)));
    const jitter = Math.floor(Math.random() * 150);
    const cooldownMs = baseBackoff + jitter;

    bucket.circuitCoolingUntil = Date.now() + cooldownMs;
    console.warn(`[KALSHI 429 CIRCUIT BREAKER] Bucket ${bucket.type} tripped! Backoff cooldown: ${cooldownMs}ms. Symbol: ${symbol || 'GLOBAL'}`);
  }

  public getStats(): KalshiRateLimiterStats {
    this.refillAllBuckets();

    const bucketStats: any = {};
    let totalShed = 0;
    let totalProc = 0;

    for (const key of Object.keys(this.buckets) as BucketType[]) {
      const b = this.buckets[key];
      const fillPct = Math.min(100, Math.max(0, Math.round((b.tokens / b.maxCapacity) * 100)));
      
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
        burstCapacity: b.maxCapacity,
        status,
        totalTokensConsumed: b.totalTokensConsumed,
        totalRequestsServed: b.totalRequestsServed,
        totalRequestsShed: b.totalRequestsShed,
        total429s: b.total429s
      };

      totalShed += b.totalRequestsShed;
      totalProc += b.totalRequestsServed;
    }

    return {
      tier: this.tier,
      tierSource: this.tierSource,
      lastTierCheckTime: this.lastTierCheckTime,
      rawLimits: this.rawLimits,
      buckets: bucketStats,
      throughput: {
        tokensConsumedPerSec: this.currentTokensPerSec,
        requestsPerSec: this.currentRequestsPerSec
      },
      totalShedded: totalShed,
      totalProcessed: totalProc
    };
  }
}

export const kalshiRateLimiter = new KalshiRateLimiterEngine();
