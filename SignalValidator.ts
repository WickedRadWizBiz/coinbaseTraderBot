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
  vpin: number;
  volatilityAtr: number;
  is15mPattern?: boolean;
}

export interface SignalValidationResult {
  approved: boolean;
  allowLongs: boolean;
  executionOrderType: 'MARKET_ORDER' | 'POST_ONLY_LIMIT';
  isToxicFlow: boolean;
  vaslStopLossPct: number;
  vaslTakeProfitPct: number;
  maxDrawdownLimitPct: number;
  code: 'APPROVED' | 'REGIME_BIAS_VETO' | 'USDT_DOMINANCE_LOCK' | 'BEARISH_CLOUD_VETO' | 'TOXIC_OFI_VETO';
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
    const usdtTrend = params.usdtDominanceTrend || (params.usdtDominanceSignal === 'UP' || (params.deltaUsdtD && params.deltaUsdtD > 0) ? 'EXPANDING' : 'NEUTRAL');

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
        vaslStopLossPct: -0.03,
        vaslTakeProfitPct: 0.08,
        maxDrawdownLimitPct: -0.03,
        code: usdtTrend === 'EXPANDING' ? 'USDT_DOMINANCE_LOCK' : 'REGIME_BIAS_VETO',
        reason: `[SIGNAL_VALIDATOR VETO] Blocked YES (Long) on ${sym}: ${reasonDetail}. Long positions prohibited in bearish macro regimes.`
      };
    }

    // 2. Toxic Flow & Adverse Selection Markout Guard
    // If orderBookImbalance > 2.0 AND vpin is elevated, switch to Post-Only Limit Orders
    const isElevatedVpin = params.vpin >= 0.15;
    const isHighImbalance = params.orderBookImbalance > 2.0;
    const isToxicFlow = isHighImbalance && isElevatedVpin;
    const executionOrderType = isToxicFlow ? 'POST_ONLY_LIMIT' : 'MARKET_ORDER';

    // 3. Volatility-Adjusted Stop Loss (VASL) & Drawdown Limits
    // SL = entryPrice - (volatilityAtr * 1.5), capped at 3% maximum drawdown for 15M patterns
    const atr = Math.max(0.005, params.volatilityAtr || 0.012);
    const rawVaslPct = -(atr * 1.5);
    // Hard-coded maximum drawdown limit of 3% (-0.03) for 15M prediction patterns
    const maxDrawdownLimitPct = -0.03;
    const vaslStopLossPct = params.is15mPattern 
      ? Math.max(maxDrawdownLimitPct, rawVaslPct) // e.g. Math.max(-0.03, -0.018) = -0.018, or Math.max(-0.03, -0.045) = -0.03
      : Math.max(-0.05, rawVaslPct);

    const vaslTakeProfitPct = Math.max(0.06, atr * 2.5);

    return {
      approved: true,
      allowLongs: allow_longs,
      executionOrderType,
      isToxicFlow,
      vaslStopLossPct,
      vaslTakeProfitPct,
      maxDrawdownLimitPct,
      code: 'APPROVED',
      reason: isToxicFlow 
        ? `[TOXIC FLOW DETECTED] OrderBook Imbalance (${params.orderBookImbalance.toFixed(2)} > 2.0) and VPIN (${params.vpin.toFixed(2)}) elevated. Enforcing Post-Only Limit Order to avoid adverse selection.`
        : undefined
    };
  }
}
