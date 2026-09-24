/**
 * LATENCY ADAPTIVE ENGINE
 * 
 * Provides real-time exchange latency metering, timestamp drift / staleness gates,
 * and adaptive execution buffers that dynamically accommodate differing environments
 * (e.g., Preview VM vs. AWS Lightsail us-east-1).
 */

export interface LatencyProfile {
  lastPingTime: number;
  kalshiWsPingMs: number;
  kalshiRestPingMs: number;
  coinbaseWsPingMs?: number;
  kalshiDataLatencyMs: number;
  kalshiOrderLatencyMs: number;
  effectiveLatencyMs: number;
  isUltraLowLatency: boolean; // True on AWS Lightsail us-east-1 (< 25ms)
  executionEnvironment: 'AWS_LIGHTSAIL_FAST' | 'PREVIEW_SANDBOX_STANDARD';
  connectionMode: 'WEBSOCKET' | 'REST_KEEPALIVE';
  staleTickThresholdMs: number;
  slippageBufferPct: number;
  trailingStopAgilityFactor: number;
  sampleRate: string; // 'CONTINUOUS'
  sampleRateIntervalMs: number;
  isNeuralExitMonitorActive: boolean;
}

class LatencyAdaptiveEngine {
  private kalshiWsPingEma: number = 22; // default initial Kalshi WS latency
  private kalshiRestPingEma: number = 42;
  private coinbaseWsPingEma: number = 24; // Coinbase WS telemetry stream latency (recorded for NN feature correlation, strictly ignored by latency gates)
  private kalshiDataLatencyEma: number = 38;
  private kalshiOrderLatencyEma: number = 46;
  private lastMeasurementTime: number = 0;
  private isMeasuring: boolean = false;
  private isNeuralExitMonitorActive: boolean = false;
  private lastNeuralExitCheckTime: number = 0;
  private lastEvalTime: number = 0;
  private sampleRateIntervalEma: number = 32;
  private connectionMode: 'WEBSOCKET' | 'REST_KEEPALIVE' = 'REST_KEEPALIVE';

  // Maximum allowed age of order book quote before rejecting trade entry (Timestamp Drift Gate)
  private readonly DEFAULT_STALENESS_LIMIT_MS = 500;

  constructor() {
    this.startPeriodicHeartbeat();
  }

  /**
   * Sets the active market data connection transport mode
   */
  public setConnectionMode(mode: 'WEBSOCKET' | 'REST_KEEPALIVE') {
    this.connectionMode = mode;
  }

  public getConnectionMode(): 'WEBSOCKET' | 'REST_KEEPALIVE' {
    return this.connectionMode;
  }

  /**
   * Starts periodic background ping checks to Kalshi API and records round-trip time.
   */
  private startPeriodicHeartbeat() {
    // Initial check after 1 second
    setTimeout(() => {
      this.measurePing();
    }, 1000);

    // Periodic check every 10 seconds
    setInterval(() => {
      this.measurePing();
    }, 10000);
  }

  /**
   * Records Kalshi WebSocket message transit or heartbeat latency
   */
  public recordKalshiWsLatency(latencyMs: number) {
    if (latencyMs > 0 && latencyMs < 2000) {
      // Exponential moving average (alpha = 0.25)
      this.kalshiWsPingEma = Math.round(0.75 * this.kalshiWsPingEma + 0.25 * latencyMs);
    }
  }

  /**
   * Records Coinbase WebSocket ticker transit latency for Neural Network feature correlation.
   * NOTE: Strictly ignored for latency gates and execution thresholds.
   */
  public recordCoinbaseWsLatency(latencyMs: number) {
    if (latencyMs > 0 && latencyMs < 3000) {
      this.coinbaseWsPingEma = Math.round(0.75 * this.coinbaseWsPingEma + 0.25 * latencyMs);
    }
  }

  /**
   * Alias for recording Kalshi WebSocket latency (Coinbase is recorded separately for NN analysis)
   */
  public recordWsLatency(latencyMs: number) {
    this.recordKalshiWsLatency(latencyMs);
  }

  /**
   * Records round-trip latency of data arriving from Kalshi (orderbooks, markets, balance)
   */
  public recordKalshiDataLatency(latencyMs: number) {
    if (latencyMs > 0 && latencyMs < 5000) {
      this.kalshiDataLatencyEma = Math.round(0.7 * this.kalshiDataLatencyEma + 0.3 * latencyMs);
      this.lastMeasurementTime = Date.now();
    }
  }

  /**
   * Records round-trip latency of sending order data to Kalshi (place, cancel)
   */
  public recordKalshiOrderLatency(latencyMs: number) {
    if (latencyMs > 0 && latencyMs < 5000) {
      this.kalshiOrderLatencyEma = Math.round(0.7 * this.kalshiOrderLatencyEma + 0.3 * latencyMs);
      this.lastMeasurementTime = Date.now();
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
        this.recordKalshiDataLatency(elapsed);
        if (this.kalshiOrderLatencyEma === 46) {
          this.kalshiOrderLatencyEma = Math.round(elapsed + 8);
        }
      }
    } catch {
      // If endpoint times out or errors, do not crash
    } finally {
      this.lastMeasurementTime = Date.now();
      this.isMeasuring = false;
    }
  }

  /**
   * Updates state of neural exit monitoring (active whenever contracts are entered)
   */
  public setIsNeuralExitMonitorActive(active: boolean) {
    this.isNeuralExitMonitorActive = active;
    if (active) {
      this.lastNeuralExitCheckTime = Date.now();
    }
  }

  public recordNeuralExitCheck() {
    this.lastNeuralExitCheckTime = Date.now();
    this.recordSampleEvaluation();
  }

  /**
   * Records high-frequency data refresh and evaluation intervals for meta-model telemetry.
   */
  public recordSampleEvaluation() {
    const now = Date.now();
    if (this.lastEvalTime > 0) {
      const delta = now - this.lastEvalTime;
      if (delta >= 1 && delta <= 3000) {
        // Smooth Exponential Moving Average (alpha = 0.12) to produce a smooth & consistent sample rate
        this.sampleRateIntervalEma = Math.round(0.88 * this.sampleRateIntervalEma + 0.12 * delta);
      }
    }
    this.lastEvalTime = now;
  }

  /**
   * Evaluates current latency environment profile
   */
  public getProfile(): LatencyProfile {
    const isWs = this.connectionMode === 'WEBSOCKET';
    // Latency logic is strictly calculated from Kalshi WebSocket and Kalshi REST API (Coinbase ignored)
    const effectiveLatency = isWs 
      ? Math.round((this.kalshiWsPingEma * 0.5) + (this.kalshiRestPingEma * 0.5))
      : this.kalshiRestPingEma;
    const isUltraLow = effectiveLatency < 25;
    const sampleMs = Math.max(12, Math.min(1000, this.sampleRateIntervalEma));

    // Scale stale tick threshold:
    // - WebSocket: 500ms (250ms on ultra-low latency Lightsail)
    // - REST Keep-Alive fallback: 1200ms (800ms on ultra-low latency Lightsail)
    const staleThreshold = isWs 
      ? (isUltraLow ? 250 : 500) 
      : (isUltraLow ? 800 : 1200);

    return {
      lastPingTime: this.lastMeasurementTime,
      kalshiWsPingMs: this.kalshiWsPingEma,
      kalshiRestPingMs: this.kalshiRestPingEma,
      coinbaseWsPingMs: this.coinbaseWsPingEma,
      kalshiDataLatencyMs: this.kalshiDataLatencyEma,
      kalshiOrderLatencyMs: this.kalshiOrderLatencyEma,
      effectiveLatencyMs: effectiveLatency,
      isUltraLowLatency: isUltraLow,
      executionEnvironment: isUltraLow ? 'AWS_LIGHTSAIL_FAST' : 'PREVIEW_SANDBOX_STANDARD',
      connectionMode: this.connectionMode,
      staleTickThresholdMs: staleThreshold,
      // On Lightsail, slippage is tighter (0.001 - 0.002 = 0.1%-0.2%), on preview allow 0.5% buffer
      slippageBufferPct: isUltraLow ? 0.002 : 0.005,
      // Trailing stop responsiveness factor (1.15x faster reaction on Lightsail)
      trailingStopAgilityFactor: isUltraLow ? 1.15 : 1.0,
      sampleRate: `${sampleMs}ms`,
      sampleRateIntervalMs: sampleMs,
      isNeuralExitMonitorActive: this.isNeuralExitMonitorActive
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
    const modeLabel = profile.connectionMode === 'WEBSOCKET' ? 'WEBSOCKET' : 'REST_KEEPALIVE';

    if (ageMs > limitMs) {
      return {
        isFresh: false,
        ageMs,
        reason: `[LATENCY GATE] Quote for ${symbol || 'contract'} is stale (Age: ${ageMs}ms > ${limitMs}ms limit on ${modeLabel} [${profile.executionEnvironment}]). Entry skipped to avoid slippage.`
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
