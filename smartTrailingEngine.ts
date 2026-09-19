/**
 * SMART TRAILING TAKE PROFIT ENGINE
 * 
 * Dynamically manages profit-taking on active positions. Adapts seamlessly to 
 * both large and small capital allocations, ensuring that profit peaks (such as $3-$10+ 
 * on smaller capital or $10-$50+ on larger capital) are successfully locked in and 
 * sold rather than surrendered on price pullbacks.
 */

export interface SmartTrailingState {
  isActive: boolean;
  tier: number; // 0 = Standby, 1 = Milestone 1, 2 = Milestone 2, 3 = Milestone 3, 4 = Max Ceiling
  tierLabel: string;
  trailingFloorRatio: number; // Guaranteed floor in PnL ratio (e.g. 0.08 = +8%)
  dynamicTargetRatio: number; // Dynamically expanded take profit target
  lockedProfitUsd: number; // Dollar profit guaranteed by the floor
  peakProfitUsd: number; // Highest dollar profit reached
  currentProfitUsd: number; // Current dollar profit
  targetDollarGoal: number; // Dollar goal for current tier
  statusMessage: string;
  lastTierChangeTime?: number;
}

export interface SmartTrailingEvaluationInput {
  pnlRatio: number;
  peakPnlRatio: number;
  entryPrice: number;
  size: number;
  side: 'YES' | 'NO';
  currentMarketPrice: number;
  baseDynamicTP: number;
  currentState?: Partial<SmartTrailingState>;
  minDollarTarget?: number;
  maxDollarTarget?: number;
  isPerpetual?: boolean;
  latencyAgilityFactor?: number;
  spotDataMetrics?: {
    directionalImpact: number;
    volSurge: number;
    rsi: number;
    isConsolidating: boolean;
  };
}

export interface SmartTrailingEvaluationResult {
  shouldClose: boolean;
  closeReason?: string;
  state: SmartTrailingState;
  newTierReached: boolean;
  isInitialActivation: boolean;
}

export class SmartTrailingEngine {
  private static readonly INITIAL_TP_FLOOR_RATIO = 0.08; // 8% initial profit threshold

  /**
   * Evaluates a position's profit state and updates dynamic trailing stop and dynamic target prices.
   * Targets $5-$10 without losing gains, scaling dynamically all the way up to $50 profit.
   */
  public static evaluate(input: SmartTrailingEvaluationInput): SmartTrailingEvaluationResult {
    const {
      pnlRatio,
      peakPnlRatio: rawPeakPnlRatio,
      entryPrice,
      size,
      side,
      currentMarketPrice,
      baseDynamicTP,
      currentState,
      minDollarTarget = 5.0,
      maxDollarTarget = 50.0,
      isPerpetual = false,
      latencyAgilityFactor = 1.0
    } = input;

    const currentCostPerContract = isPerpetual
      ? Math.max(1.0, entryPrice || 100.0)
      : Math.max(0.01, entryPrice || 0.50);
    const positionCapitalCost = size * currentCostPerContract;
    const currentProfitUsd = pnlRatio * positionCapitalCost;
    const peakPnlRatio = Math.max(pnlRatio, rawPeakPnlRatio || 0);
    const peakProfitUsd = peakPnlRatio * positionCapitalCost;

    const wasActive = Boolean(currentState?.isActive);
    const prevTier = currentState?.tier || 0;
    const prevFloor = currentState?.trailingFloorRatio || 0;

    // Smart Trailing activates as soon as profit hits $5.00 or initial profit milestone (+8% PnL)
    const isInitialTargetMet = peakProfitUsd >= minDollarTarget || (peakPnlRatio >= SmartTrailingEngine.INITIAL_TP_FLOOR_RATIO && peakProfitUsd >= 3.0);
    const isActive = wasActive || isInitialTargetMet;

    if (!isActive) {
      // Pre-activation stage: Even before $5, if position reaches a minor gain (>= $2.00 or +4% PnL),
      // ratchet stop loss to breakeven (+0.5% for fees) so the position cannot go negative.
      const isBreakevenSecured = peakProfitUsd >= 2.00 || peakPnlRatio >= 0.04;
      const preFloorRatio = isBreakevenSecured ? Math.max(0.005, prevFloor) : 0;
      const lockedUsd = preFloorRatio * positionCapitalCost;

      let shouldEarlyExit = false;
      let earlyExitReason: string | undefined;
      if (isBreakevenSecured && pnlRatio <= preFloorRatio && pnlRatio < peakPnlRatio - 0.02) {
        shouldEarlyExit = true;
        earlyExitReason = `Breakeven Profit Protection: Secured +$${Math.max(0, currentProfitUsd).toFixed(2)} (+${(pnlRatio * 100).toFixed(1)}%) after +$${peakProfitUsd.toFixed(2)} peak.`;
      }

      return {
        shouldClose: shouldEarlyExit,
        closeReason: earlyExitReason,
        newTierReached: false,
        isInitialActivation: false,
        state: {
          isActive: false,
          tier: 0,
          tierLabel: 'STANDBY_BUILDING_MOMENTUM',
          trailingFloorRatio: Number(preFloorRatio.toFixed(4)),
          dynamicTargetRatio: Math.max(SmartTrailingEngine.INITIAL_TP_FLOOR_RATIO, baseDynamicTP),
          lockedProfitUsd: Number(lockedUsd.toFixed(2)),
          peakProfitUsd: Number(peakProfitUsd.toFixed(2)),
          currentProfitUsd: Number(currentProfitUsd.toFixed(2)),
          targetDollarGoal: minDollarTarget,
          statusMessage: `Building momentum towards $5-$10 target (Current: +$${currentProfitUsd.toFixed(2)} / Peak: +$${peakProfitUsd.toFixed(2)})`
        }
      };
    }

    const isInitialActivation = !wasActive && isActive;

    // --- DYNAMIC SCALING TIERS: $5-$10 BASE -> $15-$25 MOMENTUM -> $35-$50 CLIMAX RUNNER ---
    let tier = 1;
    let tierLabel = 'TIER_1_INITIAL_GAIN_LOCK';
    let targetDollarGoal = 10.0;
    
    // TIER 1 ($5 - $10 Target Zone):
    // As soon as $5 is touched, NEVER lose gains:
    // Lock in at least $3.50 guaranteed floor, ratcheting up to $8.00 at $10 profit.
    let lockedFloorDollars = Math.max(3.50, peakProfitUsd * 0.75);
    let dynamicTargetRatio = Math.max(baseDynamicTP, peakPnlRatio + 0.08, 10.0 / Math.max(1, positionCapitalCost));

    if (peakProfitUsd >= maxDollarTarget || peakPnlRatio >= 0.50) {
      // TIER 4 / CLIMAX CEILING: $50+ Profit
      tier = 4;
      tierLabel = 'TIER_4_MAX_PROFIT_CEILING';
      targetDollarGoal = maxDollarTarget;
      dynamicTargetRatio = Math.max(baseDynamicTP, peakPnlRatio + 0.10);
      lockedFloorDollars = Math.max(42.0, peakProfitUsd * 0.88);
    } else if (peakProfitUsd >= 25.0 || peakPnlRatio >= 0.35) {
      // TIER 3: $25 - $50 Scaling Runner
      tier = 3;
      tierLabel = 'TIER_3_RUNNER_SCALING_50';
      targetDollarGoal = 50.0;
      dynamicTargetRatio = Math.max(baseDynamicTP, peakPnlRatio + 0.12, 50.0 / Math.max(1, positionCapitalCost));
      lockedFloorDollars = Math.max(20.0, peakProfitUsd * 0.82);
    } else if (peakProfitUsd >= 10.0 || peakPnlRatio >= 0.18) {
      // TIER 2: $10 - $25 Momentum Expansion
      tier = 2;
      tierLabel = 'TIER_2_MOMENTUM_EXPANSION_25';
      targetDollarGoal = 25.0;
      dynamicTargetRatio = Math.max(baseDynamicTP, peakPnlRatio + 0.10, 25.0 / Math.max(1, positionCapitalCost));
      lockedFloorDollars = Math.max(7.80, peakProfitUsd * 0.78);
    }

    // --- SPOT DATA WEIGHTING ---
    // Spot data does not trigger exits directly. Instead, it informs the smart trailing weights.
    // If spot data indicates strong favorable momentum, we give the runner more breathing room (looser floor) and stretch the target.
    // If spot data indicates consolidation or unfavorable conditions, we tighten the trailing floor to lock in gains faster.
    if (input.spotDataMetrics) {
      const { rsi, volSurge, isConsolidating } = input.spotDataMetrics;
      const isRsiTrending = side === 'YES' ? rsi >= 55 : rsi <= 45;
      const isRsiReversing = side === 'YES' ? rsi < 45 : rsi > 55;
      
      if (volSurge >= 1.15 && isRsiTrending && !isConsolidating) {
         // High momentum trend: Stretch target and loosen floor
         lockedFloorDollars = lockedFloorDollars * 0.85; // Give 15% more breathing room
         dynamicTargetRatio = dynamicTargetRatio * 1.15; // Stretch target
      } else if (isConsolidating || isRsiReversing) {
         // Weakening momentum or consolidation: Tighten floor to aggressively lock in gains
         lockedFloorDollars = lockedFloorDollars * 1.15; // Tighten floor 15% higher
      }
      
      // Ensure floor doesn't exceed peak profit
      lockedFloorDollars = Math.min(lockedFloorDollars, peakProfitUsd * 0.95);
    }

    // Convert locked dollars to trailing floor ratio
    let calculatedFloorRatio = (lockedFloorDollars * Math.max(0.9, Math.min(1.25, latencyAgilityFactor))) / Math.max(1, positionCapitalCost);
    // Floor ratio must never be negative or lower than 3% once active
    calculatedFloorRatio = Math.max(0.03, calculatedFloorRatio);

    // Strictly monotonic ratchet rule: trailing floor can NEVER move downward
    const finalFloorRatio = Math.max(calculatedFloorRatio, prevFloor);
    // Net locked profit accounts for the 2% round-trip exchange fee and spread friction
    const netFloorRatio = Math.max(0, finalFloorRatio - 0.02);
    const finalLockedProfitUsd = netFloorRatio * positionCapitalCost;

    const newTierReached = tier > prevTier;

    // --- EVALUATE EXIT CONDITIONS ---
    let shouldClose = false;
    let closeReason: string | undefined;

    const isBinaryMarketCapped = !isPerpetual && ((side === 'YES' && currentMarketPrice >= 0.96) || (side === 'NO' && currentMarketPrice <= 0.04));
    const isFullGoalReached = currentProfitUsd >= maxDollarTarget;

    // --- PERPETUAL FAST-TRACK EXIT HEURISTIC ---
    // Perpetuals tie up capital and move slower. If a Perpetual reaches $10+ profit, 
    // we use a highly sensitive heuristic to lock it in quickly rather than giving it standard breathing room.
    let isPerpetualFastExit = false;
    if (isPerpetual && currentProfitUsd >= 10.0) {
      const dropFromPeak = peakProfitUsd - currentProfitUsd;
      
      // If we have spot data, use it for a momentum-based fast exit
      if (input.spotDataMetrics) {
        const { rsi, isConsolidating, volSurge } = input.spotDataMetrics;
        const isRsiReversing = side === 'YES' ? rsi < 50 : rsi > 50;
        
        // Fast-Exit Heuristics:
        // 1. Weakening momentum (consolidating or RSI crossing midline against us)
        // 2. Volume drying up (< 0.85)
        // 3. Very tight trailing tolerance: Any $1.00 pullback from the peak
        if (isConsolidating || isRsiReversing || volSurge < 0.85 || dropFromPeak >= 1.00) {
          isPerpetualFastExit = true;
        }
      } else {
        // Fallback if no spot metrics: Tight $1.50 trailing stop for $10+ perpetuals
        if (dropFromPeak >= 1.50) {
          isPerpetualFastExit = true;
        }
      }
    }

    if (isFullGoalReached) {
      shouldClose = true;
      closeReason = `Smart Trailing TP: Full $50 Scaled Target Reached (+${(pnlRatio * 100).toFixed(1)}% | +$${currentProfitUsd.toFixed(2)} Captured)`;
    } else if (isPerpetualFastExit) {
      shouldClose = true;
      closeReason = `Perpetual Velocity Heuristic: Accelerated exit secured +$${currentProfitUsd.toFixed(2)} before momentum decay (Peak: +$${peakProfitUsd.toFixed(2)})`;
    } else if (isBinaryMarketCapped && currentProfitUsd >= minDollarTarget) {
      shouldClose = true;
      closeReason = `Smart Trailing TP: Prediction Contract Payoff Ceiling reached at ${(currentMarketPrice * 100).toFixed(0)}¢ (Secured +$${currentProfitUsd.toFixed(2)})`;
    } else if (pnlRatio <= finalFloorRatio) {
      shouldClose = true;
      closeReason = `Smart Trailing Stop Triggered: Secured +$${finalLockedProfitUsd.toFixed(2)} floor without losing gains (Floor: +${(finalFloorRatio * 100).toFixed(1)}% | Peak: +$${peakProfitUsd.toFixed(2)})`;
    }

    const state: SmartTrailingState = {
      isActive: true,
      tier,
      tierLabel,
      trailingFloorRatio: Number(finalFloorRatio.toFixed(4)),
      dynamicTargetRatio: Number(dynamicTargetRatio.toFixed(4)),
      lockedProfitUsd: Number(finalLockedProfitUsd.toFixed(2)),
      peakProfitUsd: Number(peakProfitUsd.toFixed(2)),
      currentProfitUsd: Number(currentProfitUsd.toFixed(2)),
      targetDollarGoal,
      statusMessage: `Tier ${tier} (${tierLabel}): Trailing floor locked at +$${finalLockedProfitUsd.toFixed(2)} (+${(finalFloorRatio * 100).toFixed(1)}%). Scaling target: $${targetDollarGoal.toFixed(0)} Goal (+${(dynamicTargetRatio * 100).toFixed(1)}%).`,
      lastTierChangeTime: newTierReached ? Date.now() : currentState?.lastTierChangeTime
    };

    return {
      shouldClose,
      closeReason,
      state,
      newTierReached,
      isInitialActivation
    };
  }
}
