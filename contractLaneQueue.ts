/**
 * CONTRACT LANE QUEUE SYSTEM
 * 
 * Implements a dual-tier Fast Lane and Slow Lane contract dispatch queue.
 * - FAST LANE: Contracts signaling for a faster resolution to target price (e.g. 15-minute price predictions,
 *   high OFI orderbook sweeps, rapid micro-scalps, volume surges). These resolve in minutes.
 * - SLOW LANE: Contracts requiring longer timeframes to resolve into profit (e.g. perpetual contracts,
 *   macro trend-following, multi-hour contracts).
 * 
 * Execution Rule: Fast Lane contracts take absolute priority over Slow Lane contracts when feeding
 * available trade slots.
 */

export type ContractExecutionLane = 'FAST_LANE' | 'SLOW_LANE';

export interface LaneContractCandidate {
  id: string;
  symbol: string;
  signalSide: 'YES' | 'NO';
  patternType: string;
  reason: string;
  lane: ContractExecutionLane;
  lanePriorityScore: number;
  estimatedResolutionMinutes: number;
  velocityScore: number;
  targetPrice?: number;
  distanceToTargetPct?: number;
  timeToExpiryMinutes?: number;
  isPerpetual: boolean;
  category: string;
  label: string;
  currentPrice: number;
  spread: number;
  confluenceCount: number;
  laneReason: string;
  queuedAt: number;
  candidate: any;
}

export interface QueueTelemetrySnapshot {
  fast_lane_queue: LaneContractCandidateSummary[];
  slow_lane_queue: LaneContractCandidateSummary[];
  active_fast_lane_count: number;
  active_slow_lane_count: number;
  total_fast_lane_dispatched: number;
  total_slow_lane_dispatched: number;
  last_updated: string;
  fast_lane_ratio: number;
}

export interface LaneContractCandidateSummary {
  id: string;
  symbol: string;
  signalSide: 'YES' | 'NO';
  patternType: string;
  lane: ContractExecutionLane;
  estimatedResolutionMinutes: number;
  velocityScore: number;
  targetPrice?: number;
  distanceToTargetPct?: number;
  lanePriorityScore: number;
  laneReason: string;
  label: string;
  currentPrice: number;
  spread: number;
  isPerpetual: boolean;
  queuedTimeAgoSec: number;
}

export class ContractLaneQueueManager {
  private fastLaneQueue: LaneContractCandidate[] = [];
  private slowLaneQueue: LaneContractCandidate[] = [];
  private totalFastDispatched: number = 0;
  private totalSlowDispatched: number = 0;
  private lastEvaluationTime: number = Date.now();
  private readonly QUEUE_TTL_MS = 45000; // 45 seconds sliding window

  /**
   * Classifies a candidate contract into Fast Lane or Slow Lane based on
   * signals indicating faster resolution to target price vs longer resolution runways.
   */
  public classifyCandidate(candidate: any): {
    lane: ContractExecutionLane;
    estimatedResolutionMinutes: number;
    velocityScore: number;
    targetPrice: number;
    distanceToTargetPct: number;
    laneReason: string;
    lanePriorityScore: number;
  } {
    const ctx = candidate.ctx || {};
    const spotTA = candidate.spotTA || {};
    const sym = candidate.symbol || '';
    const label = ctx.label || candidate.setup?.label || sym;
    const isPerp = Boolean(ctx.isPerpetual || sym.endsWith('PERP'));
    const is15m = sym.includes('15M') || (ctx.seriesTicker || '').includes('15M') || label.toLowerCase().includes('15m');
    const isHourly = (sym.includes('KX') || sym.includes('KXBTC') || sym.includes('KXETH')) && !is15m && !isPerp;

    // Time to expiration in minutes
    let timeToExpiryMin = Infinity;
    if (ctx.closeTime) {
      const msLeft = new Date(ctx.closeTime).getTime() - Date.now();
      timeToExpiryMin = Math.max(1, Math.round(msLeft / 60000));
    }

    // Velocity Metrics: Volume surge, OFI price impact, bid-ask depth imbalance
    const volSurge = spotTA.volumeSurgeRatio || 1.0;
    const bidVol = candidate.bidVol || (ctx.bids?.reduce((s: number, b: any) => s + (b.size || 0), 0) || 100);
    const askVol = candidate.askVol || (ctx.asks?.reduce((s: number, a: any) => s + (a.size || 0), 0) || 100);
    const depthImbalance = Math.max(bidVol / Math.max(1, askVol), askVol / Math.max(1, bidVol));
    const microVol = ctx.micropriceVolatility || 0.005;
    
    // Normalized velocity score from 1.0 to 10.0
    let velocityScore = 1.0;
    velocityScore += Math.min(3.5, (volSurge - 1.0) * 2.5);
    velocityScore += Math.min(3.0, (depthImbalance - 1.0) * 1.5);
    velocityScore += Math.min(2.5, microVol * 250);
    velocityScore = Number(Math.max(1.0, Math.min(10.0, velocityScore)).toFixed(1));

    // Calculate Target Price and Required Distance to Target
    const currentPrice = candidate.signalSide === 'YES' 
      ? (ctx.asks?.[0]?.price || ctx.currentPrice || 0.50)
      : (isPerp ? (ctx.bids?.[0]?.price || ctx.currentPrice || 0.50) : (1.0 - (ctx.bids?.[0]?.price || ctx.currentPrice || 0.50)));
    
    // Target price computation: Fast scalps aim for +8% to +10%, perps aim for +15% to +25%
    const targetMovePct = isPerp ? 0.15 : (is15m ? 0.08 : 0.10);
    const targetPrice = Number((currentPrice * (1 + targetMovePct)).toFixed(4));
    const distanceToTargetPct = Number((targetMovePct * 100).toFixed(1));

    const pattern = candidate.patternType || '';
    const isMicroScalp = pattern === 'RANGE_BOUND_MICRO_SCALP' || pattern === 'DOJI_EXHAUSTION_REVERSAL' || pattern === 'ALWAYS_ON_15M_PREDICTION';

    // Fast Lane Signaling Conditions:
    // 1. 15-Minute price prediction contract (resolves naturally within 15 minutes)
    // 2. High microstructure velocity or orderbook sweep where rapid order flow pushes price quickly to target
    // 3. Hourly contract entering the final resolution countdown (<= 25 minutes to expiry)
    // 4. Tight target distance (< 8%) combined with high volume surge (>= 1.4x)
    let lane: ContractExecutionLane = 'SLOW_LANE';
    let estimatedResolutionMinutes = 45;
    let laneReason = '';

    if (isPerp) {
      // Perpetual contracts are open-ended; rely on multi-percent macro moves
      lane = 'SLOW_LANE';
      estimatedResolutionMinutes = Math.round(35 + (10 - Math.min(9, velocityScore)) * 6); // 35 to 80 minutes
      laneReason = `Perpetual Contract (${ctx.leverage || 2}x): Open-ended horizon requiring larger macro trend expansion (~${estimatedResolutionMinutes}m target resolution).`;
    } else if (is15m) {
      // 15-Minute price prediction contracts resolve rapidly
      lane = 'FAST_LANE';
      estimatedResolutionMinutes = Math.min(14, Math.max(2, Math.round(Math.min(timeToExpiryMin, 15) / Math.max(1, velocityScore * 0.4))));
      laneReason = `15-Minute Price Prediction: Near-term expiration signaling rapid resolution (~${estimatedResolutionMinutes}m to target).`;
    } else if (isHourly && timeToExpiryMin <= 25) {
      // Hourly contract entering final expiration countdown
      lane = 'FAST_LANE';
      estimatedResolutionMinutes = Math.round(Math.max(3, timeToExpiryMin * 0.6));
      laneReason = `Hourly Contract Final Stretch: Only ${timeToExpiryMin}m remaining; rapid price resolution imminent (~${estimatedResolutionMinutes}m).`;
    } else if (isMicroScalp || velocityScore >= 6.0 || (depthImbalance >= 1.3 && volSurge >= 1.4)) {
      // High microstructure velocity or micro-scalp setup
      lane = 'FAST_LANE';
      estimatedResolutionMinutes = Math.round(Math.max(3, 16 / Math.max(1, velocityScore * 0.55)));
      laneReason = `High-Velocity Orderbook Sweep: Intense depth imbalance (${depthImbalance.toFixed(2)}x) and volume surge (${volSurge.toFixed(2)}x) signaling rapid resolution (~${estimatedResolutionMinutes}m).`;
    } else {
      // Standard hourly / event contract with moderate velocity
      lane = 'SLOW_LANE';
      estimatedResolutionMinutes = Math.round(Math.max(25, Math.min(75, timeToExpiryMin * 0.8)));
      laneReason = `Standard Event Setup: Extended resolution runway required to reach target profit (~${estimatedResolutionMinutes}m).`;
    }

    // Lane Priority Score Calculation:
    // Fast Lane candidates get an automatic +100 base score to strictly rank above Slow Lane candidates
    const confCount = candidate.recCheck?.confluenceCount || candidate.confluenceCount || 1;
    const adaptiveScore = candidate.adaptivePreference?.combinedScore || 1.0;
    
    let lanePriorityScore = 0;
    if (lane === 'FAST_LANE') {
      // Fast Lane Base 100 + confluence bonus + velocity score bonus + speed bonus (shorter resolution is higher priority)
      const speedBonus = Math.max(0, 20 - estimatedResolutionMinutes);
      lanePriorityScore = Number((100 + (confCount * 15) + (velocityScore * 8) + speedBonus + (adaptiveScore * 5)).toFixed(1));
    } else {
      // Slow Lane Base 20 + confluence bonus + adaptive score
      lanePriorityScore = Number((20 + (confCount * 10) + (velocityScore * 4) + (adaptiveScore * 5)).toFixed(1));
    }

    return {
      lane,
      estimatedResolutionMinutes,
      velocityScore,
      targetPrice,
      distanceToTargetPct,
      laneReason,
      lanePriorityScore
    };
  }

  /**
   * Ingests and feeds candidates into the Fast Lane and Slow Lane queues.
   * Maintains a persistent sliding buffer so valid contracts are preserved across ticks.
   */
  public feedQueues(candidates: any[]): {
    fastLane: LaneContractCandidate[];
    slowLane: LaneContractCandidate[];
  } {
    this.lastEvaluationTime = Date.now();
    const now = Date.now();

    // 1. Filter out expired candidates from existing queues (TTL expiration or contract close)
    this.pruneExpiredQueueItems();

    // 2. Classify and merge new candidates
    for (const cand of candidates) {
      this.feedCandidate(cand);
    }

    // 3. Sort both queues descending by lane priority score
    this.fastLaneQueue.sort((a, b) => b.lanePriorityScore - a.lanePriorityScore);
    this.slowLaneQueue.sort((a, b) => b.lanePriorityScore - a.lanePriorityScore);

    return {
      fastLane: this.fastLaneQueue,
      slowLane: this.slowLaneQueue
    };
  }

  /**
   * Directly feeds a single candidate into the appropriate queue.
   */
  public feedCandidate(cand: any, forceLane?: ContractExecutionLane): LaneContractCandidate {
    const classification = this.classifyCandidate(cand);
    if (forceLane) {
      classification.lane = forceLane;
      if (forceLane === 'FAST_LANE' && classification.lanePriorityScore < 100) {
        classification.lanePriorityScore += 100;
      }
    }

    const ctx = cand.ctx || {};
    const bestBid = ctx.bids?.[0]?.price || 0;
    const bestAsk = ctx.asks?.[0]?.price || 1;
    const spread = Math.abs(bestAsk - bestBid);

    const entry: LaneContractCandidate = {
      id: `${cand.symbol}_${cand.signalSide}`,
      symbol: cand.symbol,
      signalSide: cand.signalSide,
      patternType: cand.patternType || 'ADAPTIVE_CONFLUENCE',
      reason: cand.reason || classification.laneReason,
      lane: classification.lane,
      lanePriorityScore: classification.lanePriorityScore,
      estimatedResolutionMinutes: classification.estimatedResolutionMinutes,
      velocityScore: classification.velocityScore,
      targetPrice: classification.targetPrice,
      distanceToTargetPct: classification.distanceToTargetPct,
      timeToExpiryMinutes: ctx.closeTime ? Math.max(1, Math.round((new Date(ctx.closeTime).getTime() - Date.now()) / 60000)) : undefined,
      isPerpetual: Boolean(ctx.isPerpetual || cand.symbol.endsWith('PERP')),
      category: ctx.category || 'crypto',
      label: ctx.label || cand.symbol,
      currentPrice: cand.signalSide === 'YES' ? (ctx.currentPrice || 0.5) : (ctx.isPerpetual ? (ctx.currentPrice || 0.5) : 1.0 - (ctx.currentPrice || 0.5)),
      spread: Number(spread.toFixed(4)),
      confluenceCount: cand.recCheck?.confluenceCount || cand.confluenceCount || 1,
      laneReason: classification.laneReason,
      queuedAt: Date.now(),
      candidate: cand
    };

    if (classification.lane === 'FAST_LANE') {
      const idx = this.fastLaneQueue.findIndex(q => q.symbol === entry.symbol && q.signalSide === entry.signalSide);
      if (idx !== -1) {
        this.fastLaneQueue[idx] = entry;
      } else {
        this.fastLaneQueue.push(entry);
      }
      this.fastLaneQueue.sort((a, b) => b.lanePriorityScore - a.lanePriorityScore);
    } else {
      const idx = this.slowLaneQueue.findIndex(q => q.symbol === entry.symbol && q.signalSide === entry.signalSide);
      if (idx !== -1) {
        this.slowLaneQueue[idx] = entry;
      } else {
        this.slowLaneQueue.push(entry);
      }
      this.slowLaneQueue.sort((a, b) => b.lanePriorityScore - a.lanePriorityScore);
    }

    return entry;
  }

  /**
   * Continuous Market Feeder:
   * Scans attached spotContexts to populate the Fast Lane and Slow Lane queues with
   * candidate contracts signaling for fast resolution vs macro slow runway.
   */
  public feedFromMarketContexts(spotContexts: Record<string, any>, activePositions: any[]) {
    this.pruneExpiredQueueItems();
    const symbols = Object.keys(spotContexts);
    const now = Date.now();

    for (const sym of symbols) {
      const c = spotContexts[sym];
      if (!c || !c.currentPrice || c.isOrderBookStale || c.isExpired) continue;
      if (!c.bids || c.bids.length === 0 || !c.asks || c.asks.length === 0) continue;

      const isPerp = Boolean(c.isPerpetual || sym.endsWith('PERP'));
      const is15m = sym.includes('15M') || (c.seriesTicker || '').includes('15M') || (c.label || '').toLowerCase().includes('15m');
      const isHourly = (sym.includes('KX') || sym.includes('KXBTC') || sym.includes('KXETH')) && !is15m && !isPerp;

      const timeToExpiryMs = c.closeTime ? (new Date(c.closeTime).getTime() - now) : Infinity;
      if (timeToExpiryMs < 75 * 1000) continue; // Skip contracts expiring in < 75s

      const bestBid = c.bids[0]?.price || 0;
      const bestAsk = c.asks[0]?.price || 1;
      const spread = Math.abs(bestAsk - bestBid);
      if (!isPerp && spread > 0.08) continue;
      if (isPerp && (spread / Math.max(0.001, bestBid)) > 0.02) continue;

      const bidVol = c.bids.reduce((s: number, b: any) => s + (b.size || 0), 0);
      const askVol = c.asks.reduce((s: number, a: any) => s + (a.size || 0), 0);

      // Determine signal direction based on depth and momentum
      const signalSide: 'YES' | 'NO' = bidVol >= askVol ? 'YES' : 'NO';

      const candidateObj = {
        symbol: sym,
        signalSide,
        patternType: is15m ? 'ALWAYS_ON_15M_PREDICTION' : isPerp ? 'PERPETUAL_TREND_FOLLOWING' : 'HOURLY_PRICE_PREDICTION',
        reason: is15m ? 'Rapid 15M Price Prediction' : isPerp ? 'Macro Perpetual Trend' : 'Hourly Strike Prediction',
        ctx: c,
        spotTA: {
          volumeSurgeRatio: Math.min(3.0, (bidVol + askVol) / 1000),
          tenkanKijunCross: bidVol >= askVol ? 'BULLISH_CROSS' : 'BEARISH_CROSS',
          pair: sym.split('-')[0] + '-USD',
          price: c.currentPrice
        },
        bidVol,
        askVol,
        recCheck: { confluenceCount: 2, allowed: true, activeTools: ['Orderbook Depth', 'Volume Surge'] },
        adaptivePreference: {
          combinedScore: 5.0,
          shrunkKellyMultiplier: 1.0,
          isFavored: is15m,
          reason: 'Continuous Market Feeder Alignment'
        }
      };

      this.feedCandidate(candidateObj);
    }
  }

  private pruneExpiredQueueItems() {
    const now = Date.now();
    const isLive = (item: LaneContractCandidate) => {
      // Prune if queued for longer than TTL
      if (now - item.queuedAt > this.QUEUE_TTL_MS) return false;
      // Prune if contract has expired
      if (item.candidate?.ctx?.closeTime) {
        const msLeft = new Date(item.candidate.ctx.closeTime).getTime() - now;
        if (msLeft < 60 * 1000) return false;
      }
      return true;
    };

    this.fastLaneQueue = this.fastLaneQueue.filter(isLive);
    this.slowLaneQueue = this.slowLaneQueue.filter(isLive);
  }

  /**
   * Prioritized Execution Dispatcher:
   * Returns candidates in strict priority order:
   * ALL eligible Fast Lane candidates are returned FIRST, followed by Slow Lane candidates.
   */
  public getPrioritizedCandidates(): LaneContractCandidate[] {
    this.pruneExpiredQueueItems();
    return [...this.fastLaneQueue, ...this.slowLaneQueue];
  }

  public recordDispatch(lane: ContractExecutionLane) {
    if (lane === 'FAST_LANE') {
      this.totalFastDispatched++;
    } else {
      this.totalSlowDispatched++;
    }
  }

  public getFastLaneQueue(): LaneContractCandidate[] {
    this.pruneExpiredQueueItems();
    return this.fastLaneQueue;
  }

  public getSlowLaneQueue(): LaneContractCandidate[] {
    this.pruneExpiredQueueItems();
    return this.slowLaneQueue;
  }

  /**
   * Generates telemetry snapshot for frontend and API consumers.
   */
  public getTelemetrySnapshot(activePositions: any[]): QueueTelemetrySnapshot {
    this.pruneExpiredQueueItems();
    const activeFast = activePositions.filter(p => p.executionLane === 'FAST_LANE' || (!p.isPerpetual && p.category === 'crypto')).length;
    const activeSlow = activePositions.filter(p => p.executionLane === 'SLOW_LANE' || p.isPerpetual).length;
    const totalDispatched = this.totalFastDispatched + this.totalSlowDispatched;
    const fastRatio = totalDispatched > 0 ? Number((this.totalFastDispatched / totalDispatched).toFixed(2)) : 0.75;
    const now = Date.now();

    const toSummary = (c: LaneContractCandidate): LaneContractCandidateSummary => ({
      id: c.id,
      symbol: c.symbol,
      signalSide: c.signalSide,
      patternType: c.patternType,
      lane: c.lane,
      estimatedResolutionMinutes: c.estimatedResolutionMinutes,
      velocityScore: c.velocityScore,
      targetPrice: c.targetPrice,
      distanceToTargetPct: c.distanceToTargetPct,
      lanePriorityScore: c.lanePriorityScore,
      laneReason: c.laneReason,
      label: c.label,
      currentPrice: c.currentPrice,
      spread: c.spread,
      isPerpetual: c.isPerpetual,
      queuedTimeAgoSec: Math.max(0, Math.round((now - c.queuedAt) / 1000))
    });

    return {
      fast_lane_queue: this.fastLaneQueue.slice(0, 8).map(toSummary),
      slow_lane_queue: this.slowLaneQueue.slice(0, 8).map(toSummary),
      active_fast_lane_count: activeFast,
      active_slow_lane_count: activeSlow,
      total_fast_lane_dispatched: this.totalFastDispatched,
      total_slow_lane_dispatched: this.totalSlowDispatched,
      last_updated: new Date(this.lastEvaluationTime).toISOString(),
      fast_lane_ratio: fastRatio
    };
  }
}

export const contractLaneQueueManager = new ContractLaneQueueManager();

