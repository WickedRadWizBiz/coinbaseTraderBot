/**
 * SignalValidator.ts
 * ==================
 * Institutional Pre-Trade Validation Engine (SR 11-7 Institutional Grade).
 * 
 * Enforces:
 * 1. USDT.D Macro-Regime Lock:
 *    Hard constraint: if (USDT_DOMINANCE.trend == 'EXPANDING' || marketRegime == 'TRENDING_BEARISH' || ichimokuCloudState == 'BEARISH_CLOUD') { allow_longs = false; }
 * 2. Toxic Order Flow & Markout Guard:
 *    If orderBookImbalance > 2.0 AND vpin is elevated, switch from Market Orders to Post-Only Limit Orders.
 * 3. Volatility-Adjusted Stop Loss (VASL):
 *    Calibrates SL = entryPrice - (volatilityAtr * 1.5) with a hard maximum drawdown limit of 3% for 15M prediction patterns.
 */

export interface SignalValidationParams {
  symbol: string;
  side: 'YES' | 'NO';
  marketRegime: string;
  ichimokuCloudState: string;
  usdtDominanceTrend?: 'EXPANDING' | 'CONTRACTING' | 'NEUTRAL';
  usdtDominanceSignal?: 'UP' | 'DOWN' | 'NEUTRAL';
  deltaUsdtD?: number;
  orderBookImbalance: number;
  orderFlowImbalance?: number;
  vpin: number;
  volatilityAtr: number;
  is15mPattern?: boolean;
  patternType?: string;
  executionDelayMs?: number;
}

export interface SignalValidationResult {
  approved: boolean;
  allowLongs: boolean;
  executionOrderType: 'MARKET_ORDER' | 'POST_ONLY_LIMIT';
  isToxicFlow: boolean;
  spreadWideningBps: number;
  vaslStopLossPct: number;
  vaslTakeProfitPct: number;
  maxDrawdownLimitPct: number;
  code: 'APPROVED' | 'REGIME_BIAS_VETO' | 'USDT_DOMINANCE_LOCK' | 'BEARISH_CLOUD_VETO' | 'TOXIC_OFI_VETO' | 'TOXIC_FLOW_VETO' | 'VPIN_RISK_REJECTION' | 'LATENCY_TTL_EXCEEDED_VETO' | 'REGIME_CONSTRAINT_VETO';
  reason?: string;
}

export class SignalValidator {
  /**
   * Validates a trade signal against institutional macro and microstructure constraints.
   */
  public static validate(params: SignalValidationParams): SignalValidationResult {
    const sym = (params.symbol || '').toUpperCase();
    const regime = params.marketRegime || 'CHOPPY_SIDEWAYS';
    const ichimokuState = params.ichimokuCloudState || 'NEUTRAL_IN_CLOUD';
    const side = params.side;
    const ofi = params.orderFlowImbalance ?? 0.0;
    const pattern = params.patternType || '';
    const usdtTrend = params.usdtDominanceTrend || (params.usdtDominanceSignal === 'UP' || (params.deltaUsdtD && params.deltaUsdtD > 0) ? 'EXPANDING' : 'NEUTRAL');

    // 1. HARD BLOCK on MOMENTUM_REVERSAL_FLIP during MEAN_REVERTING market regimes
    if ((pattern === 'MOMENTUM_REVERSAL_FLIP' || pattern.includes('REVERSAL_FLIP')) && regime === 'MEAN_REVERTING') {
      return {
        approved: false,
        allowLongs: false,
        executionOrderType: 'POST_ONLY_LIMIT',
        isToxicFlow: false,
        spreadWideningBps: 0,
        vaslStopLossPct: -0.03,
        vaslTakeProfitPct: 0.08,
        maxDrawdownLimitPct: -0.03,
        code: 'REGIME_CONSTRAINT_VETO',
        reason: `[REGIME CONSTRAINT VETO] Blocked MOMENTUM_REVERSAL_FLIP on ${sym} during MEAN_REVERTING market regime. Counter-trend momentum flips prohibited in mean-reverting markets.`
      };
    }

    // 2. HARD VPIN TOXIC FLOW REJECTION (If VPIN >= 0.18 e.g. ID 594237 VPIN 0.1857 -> ABORT SIGNAL)
    if (params.vpin >= 0.18) {
      return {
        approved: false,
        allowLongs: false,
        executionOrderType: 'POST_ONLY_LIMIT',
        isToxicFlow: true,
        spreadWideningBps: Math.round((params.vpin - 0.15) * 200 + 15),
        vaslStopLossPct: -0.02,
        vaslTakeProfitPct: 0.08,
        maxDrawdownLimitPct: -0.03,
        code: 'VPIN_RISK_REJECTION',
        reason: `[VPIN RISK REJECTION] Aborted execution on ${sym}: VPIN (${params.vpin.toFixed(4)}) >= 0.18 indicates extreme order flow toxicity.`
      };
    }

    // 3. LATENCY TTL CHECK (If latency > 20ms in MEAN_REVERTING regime -> REJECT/RE-EVALUATE)
    const delay = params.executionDelayMs ?? 0;
    if (regime === 'MEAN_REVERTING' && delay > 20) {
      return {
        approved: false,
        allowLongs: true,
        executionOrderType: 'POST_ONLY_LIMIT',
        isToxicFlow: false,
        spreadWideningBps: 10,
        vaslStopLossPct: -0.02,
        vaslTakeProfitPct: 0.08,
        maxDrawdownLimitPct: -0.03,
        code: 'LATENCY_TTL_EXCEEDED_VETO',
        reason: `[LATENCY TTL EXCEEDED VETO] Aborted signal on ${sym}: Execution delay (${delay}ms > 20ms TTL limit) too high for MEAN_REVERTING regime.`
      };
    }

    // 1. USDT.D Macro-Regime Lock
    let allow_longs = true;
    if (usdtTrend === 'EXPANDING' || regime === 'TRENDING_BEARISH' || ichimokuState === 'BEARISH_CLOUD') {
      allow_longs = false;
    }

    if (side === 'YES' && !allow_longs) {
      const reasonDetail = usdtTrend === 'EXPANDING' 
        ? `USDT Dominance is EXPANDING (+${params.deltaUsdtD ? params.deltaUsdtD.toFixed(4) : '0.00'}%)`
        : regime === 'TRENDING_BEARISH'
          ? `Market Regime is ${regime}`
          : `Ichimoku Cloud is ${ichimokuState}`;

      return {
        approved: false,
        allowLongs: false,
        executionOrderType: 'POST_ONLY_LIMIT',
        isToxicFlow: false,
        spreadWideningBps: 0,
        vaslStopLossPct: -0.03,
        vaslTakeProfitPct: 0.08,
        maxDrawdownLimitPct: -0.03,
        code: usdtTrend === 'EXPANDING' ? 'USDT_DOMINANCE_LOCK' : 'REGIME_BIAS_VETO',
        reason: `[SIGNAL_VALIDATOR VETO] Blocked YES (Long) on ${sym}: ${reasonDetail}. Long positions prohibited in bearish macro regimes.`
      };
    }

    // 2. Extreme OFI Divergence Against Intended Side Check
    // Buying into collapsing bids (OFI < -0.10) or Selling into surging bids (OFI > 0.10)
    const isOfiCollapsingBid = (side === 'YES' && ofi < -0.10);
    const isOfiSurgingBid = (side === 'NO' && ofi > 0.10);
    if (isOfiCollapsingBid || isOfiSurgingBid) {
      return {
        approved: false,
        allowLongs: allow_longs,
        executionOrderType: 'POST_ONLY_LIMIT',
        isToxicFlow: true,
        spreadWideningBps: 25,
        vaslStopLossPct: -0.02,
        vaslTakeProfitPct: 0.08,
        maxDrawdownLimitPct: -0.03,
        code: 'TOXIC_OFI_VETO',
        reason: `[TOXIC OFI DIVERGENCE VETO] Inhibit ${side} on ${sym}: Order Flow Imbalance (${ofi.toFixed(4)}) strongly opposes intended direction.`
      };
    }

    // 3. Adaptive Toxic Flow & Adverse Selection Markout Guard
    // When VPIN >= 0.15, OFI diverges against signal direction, or orderBookImbalance > 2.0, enforce Post-Only Limit Orders with spread widening
    const isElevatedVpin = params.vpin >= 0.15;
    const isHighImbalance = params.orderBookImbalance > 2.0;
    const isOfiDiverging = (side === 'YES' && ofi < -0.04) || (side === 'NO' && ofi > 0.04);
    const isToxicFlow = isElevatedVpin || isHighImbalance || isOfiDiverging;
    const executionOrderType = isToxicFlow ? 'POST_ONLY_LIMIT' : 'MARKET_ORDER';
    const spreadWideningBps = isElevatedVpin 
      ? Math.round((params.vpin - 0.15) * 200 + 15) 
      : isOfiDiverging 
        ? 20 
        : (isHighImbalance ? 15 : 0);

    // 4. Volatility-Adjusted Stop Loss (VASL) & Drawdown Limits
    // SL = entryPrice - (volatilityAtr * 1.5), capped at 3% maximum drawdown for 15M patterns
    const atr = Math.max(0.005, params.volatilityAtr || 0.012);
    const rawVaslPct = -(atr * 1.5);
    // Hard-coded maximum drawdown limit of 3% (-0.03) for 15M prediction patterns
    const maxDrawdownLimitPct = -0.03;
    const vaslStopLossPct = params.is15mPattern 
      ? Math.max(maxDrawdownLimitPct, rawVaslPct)
      : Math.max(-0.05, rawVaslPct);

    const vaslTakeProfitPct = Math.max(0.06, atr * 2.5);

    return {
      approved: true,
      allowLongs: allow_longs,
      executionOrderType,
      isToxicFlow,
      spreadWideningBps,
      vaslStopLossPct,
      vaslTakeProfitPct,
      maxDrawdownLimitPct,
      code: 'APPROVED',
      reason: isToxicFlow 
        ? `[ADAPTIVE TOXIC FLOW GUARD] VPIN (${params.vpin.toFixed(4)}${isElevatedVpin ? ' >= 0.15' : ''}) or OB Imbalance (${params.orderBookImbalance.toFixed(2)}) elevated. Enforced Post-Only Limit with +${spreadWideningBps}bps spread widening.`
        : undefined
    };
  }
}
