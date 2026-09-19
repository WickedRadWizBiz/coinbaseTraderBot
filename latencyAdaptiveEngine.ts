/**
 * LATENCY ADAPTIVE ENGINE
 * 
 * Provides real-time exchange latency metering, timestamp drift / staleness gates,
 * and adaptive execution buffers that dynamically accommodate differing environments
 * (e.g., Preview VM vs. AWS Lightsail us-east-1).
 */

export interface LatencyProfile {
  lastPingTime: number;
  coinbaseWsPingMs: number;
  kalshiRestPingMs: number;
  effectiveLatencyMs: number;
  isUltraLowLatency: boolean; // True on AWS Lightsail us-east-1 (< 25ms)
  executionEnvironment: 'AWS_LIGHTSAIL_FAST' | 'PREVIEW_SANDBOX_STANDARD';
  staleTickThresholdMs: number;
  slippageBufferPct: number;
  trailingStopAgilityFactor: number;
}

class LatencyAdaptiveEngine {
  private coinbaseWsPingEma: number = 45; // default initial preview assumption
  private kalshiRestPingEma: number = 60;
  private lastMeasurementTime: number = 0;
  private isMeasuring: boolean = false;

  // Maximum allowed age of order book quote before rejecting trade entry (Timestamp Drift Gate)
  private readonly DEFAULT_STALENESS_LIMIT_MS = 250;

  constructor() {
    this.startPeriodicHeartbeat();
  }

  /**
   * Starts periodic background ping checks to Kalshi API and records round-trip time.
   */
  private startPeriodicHeartbeat() {
    // Initial check after 3 seconds
    setTimeout(() => {
      this.measurePing();
    }, 3000);

    // Periodic check every 30 seconds
    setInterval(() => {
      this.measurePing();
    }, 30000);
  }

  /**
   * Records WebSocket message transit or heartbeat latency
   */
  public recordWsLatency(latencyMs: number) {
    if (latencyMs > 0 && latencyMs < 2000) {
      // Exponential moving average (alpha = 0.25)
      this.coinbaseWsPingEma = Math.round(0.75 * this.coinbaseWsPingEma + 0.25 * latencyMs);
    }
  }

  /**
   * Measures Kalshi REST API round trip time
   */
  public async measurePing(): Promise<void> {
    if (this.isMeasuring) return;
    this.isMeasuring = true;
    const start = Date.now();
    try {
      // Use lightweight endpoint
      const res = await fetch('https://api.elections.kalshi.com/trade-api/v2/exchange/status', {
        signal: AbortSignal.timeout(4000)
      });
      const elapsed = Date.now() - start;
      if (res.ok && elapsed > 0 && elapsed < 3000) {
        this.kalshiRestPingEma = Math.round(0.75 * this.kalshiRestPingEma + 0.25 * elapsed);
      }
    } catch {
      // If endpoint times out or errors, do not crash
    } finally {
      this.lastMeasurementTime = Date.now();
      this.isMeasuring = false;
    }
  }

  /**
   * Evaluates current latency environment profile
   */
  public getProfile(): LatencyProfile {
    const effectiveLatency = Math.round((this.coinbaseWsPingEma * 0.4) + (this.kalshiRestPingEma * 0.6));
    const isUltraLow = effectiveLatency < 25;

    return {
      lastPingTime: this.lastMeasurementTime,
      coinbaseWsPingMs: this.coinbaseWsPingEma,
      kalshiRestPingMs: this.kalshiRestPingEma,
      effectiveLatencyMs: effectiveLatency,
      isUltraLowLatency: isUltraLow,
      executionEnvironment: isUltraLow ? 'AWS_LIGHTSAIL_FAST' : 'PREVIEW_SANDBOX_STANDARD',
      // On ultra-low latency (Lightsail), quotes age out faster so tighten staleness gate to 150ms
      // In preview, allow up to 300ms
      staleTickThresholdMs: isUltraLow ? 150 : 300,
      // On Lightsail, slippage is tighter (0.001 - 0.002 = 0.1%-0.2%), on preview allow 0.5% buffer
      slippageBufferPct: isUltraLow ? 0.002 : 0.005,
      // Trailing stop responsiveness factor (1.15x faster reaction on Lightsail)
      trailingStopAgilityFactor: isUltraLow ? 1.15 : 1.0
    };
  }

  /**
   * [GATE C] Timestamp Drift & Staleness Verification
   * Rejects order candidates if market context timestamp is older than allowable limit.
   */
  public verifyQuoteFreshness(
    lastTickTimeMs?: number,
    symbol?: string
  ): { isFresh: boolean; ageMs: number; reason?: string } {
    if (!lastTickTimeMs) {
      return { isFresh: true, ageMs: 0 };
    }

    const now = Date.now();
    const ageMs = Math.max(0, now - lastTickTimeMs);
    const profile = this.getProfile();
    const limitMs = profile.staleTickThresholdMs;

    if (ageMs > limitMs) {
      return {
        isFresh: false,
        ageMs,
        reason: `[LATENCY GATE] Quote for ${symbol || 'contract'} is stale (Age: ${ageMs}ms > ${limitMs}ms limit on ${profile.executionEnvironment}). Entry skipped to avoid slippage.`
      };
    }

    return { isFresh: true, ageMs };
  }

  /**
   * [GATE B] Adaptive Slippage & Tolerance Buffer Calculator
   * Returns price adjustment multiplier based on measured environment latency.
   */
  public getAdaptivePriceTolerance(basePrice: number, side: 'YES' | 'NO', isPerp: boolean): {
    optimizedPrice: number;
    slippageBufferUsd: number;
    environment: string;
  } {
    const profile = this.getProfile();
    const buffer = profile.slippageBufferPct;

    let adjustedPrice = basePrice;
    if (isPerp) {
      // For perpetuals, adjust slightly towards aggressive fill without overpaying
      adjustedPrice = side === 'YES' ? basePrice * (1 + (buffer * 0.5)) : basePrice * (1 - (buffer * 0.5));
    } else {
      // For binary prediction contracts (0.01 - 0.99)
      // When on Lightsail (ultra-low latency), stick exactly to the tick to snipe resting orders
      // In preview, allow 1 tick elasticity
      if (profile.isUltraLowLatency) {
        adjustedPrice = basePrice; // Exact resting price snipe
      } else {
        adjustedPrice = side === 'YES' 
          ? Math.min(0.98, Number((basePrice + 0.01).toFixed(2)))
          : Math.max(0.02, Number((basePrice - 0.01).toFixed(2)));
      }
    }

    return {
      optimizedPrice: adjustedPrice,
      slippageBufferUsd: Math.abs(adjustedPrice - basePrice),
      environment: profile.executionEnvironment
    };
  }
}

export const latencyAdaptiveEngine = new LatencyAdaptiveEngine();
