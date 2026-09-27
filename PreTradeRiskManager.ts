/**
 * PreTradeRiskManager.ts
 * ======================
 * Institutional Cross-Asset Risk & Gating Engine (SR 11-7 Compliance).
 * 
 * Enforces:
 * 1. Macro Regime Filter: Zero 'YES' (Long) altcoin positions permitted in 'TRENDING_BEARISH' regime.
 * 2. USDT Dominance Macro Veto: Prohibits altcoin Longs when USDT.D 1m delta > 0 (rising Tether dominance).
 * 3. Feature Pipeline Integrity: Rejects trades with insufficient candle depth (N < 50) or static defaults.
 * 4. Adverse Selection Circuit Breaker: Rejects blacklisted symbols with negative markout trajectories.
 * 5. Dynamic Volatility Stop-Loss bounds: Calibrates asymmetric 1.5x ATR stops in CHOPPY_SIDEWAYS.
 */

export interface PreTradeEvaluationParams {
  symbol: string;
  side: 'YES' | 'NO';
  marketRegime: string;
  deltaUsdtD: number;
  usdtDominanceSignal?: 'UP' | 'DOWN' | 'NEUTRAL';
  rsi: number;
  atr: number;
  vpin?: number;
  candleCount?: number;
  isBlacklisted?: boolean;
  blacklistRemainingSec?: number;
}

export interface PreTradeEvaluationResult {
  allowed: boolean;
  code: 'APPROVED' | 'REGIME_VETO' | 'USDT_DOMINANCE_VETO' | 'FEATURE_STASIS_VETO' | 'ADVERSE_SELECTION_VETO' | 'INSUFFICIENT_BUFFER_VETO';
  reason?: string;
  recommendedSL: number;
  recommendedTP: number;
}

export class PreTradeRiskManager {
  private static readonly ALTCOIN_IDENTIFIERS = [
    'SOL', 'KXSOL', 'XRP', 'KXXRP', 'DOGE', 'KXDOGE', 'HYPE', 'KXHYPE',
    'SHIB', 'KXSHIB', 'SUI', 'KXSUI', 'ADA', 'KXADA', 'LINK', 'KXLINK',
    'LTC', 'KXLTC', 'BCH', 'KXBCH', 'AAVE', 'KXAAVE', 'AVAX', 'KXAVAX',
    'ETH', 'KXETH', 'WLD', 'KXWLD'
  ];

  /**
   * Evaluates all pre-trade risk constraints.
   */
  public static evaluateTrade(params: PreTradeEvaluationParams): PreTradeEvaluationResult {
    const sym = (params.symbol || '').toUpperCase();
    const isAltcoin = this.ALTCOIN_IDENTIFIERS.some(alt => sym.includes(alt));
    const regime = params.marketRegime || 'CHOPPY_SIDEWAYS';
    const side = params.side;

    // 1. Adverse Selection Circuit Breaker Check
    if (params.isBlacklisted) {
      return {
        allowed: false,
        code: 'ADVERSE_SELECTION_VETO',
        reason: `[ADVERSE SELECTION REJECTION] Suppressed trade on ${params.symbol}. Symbol is blacklisted for toxic order flow harvesting (${params.blacklistRemainingSec || 3600}s remaining).`,
        recommendedSL: -0.02,
        recommendedTP: 0.10
      };
    }

    // 2. Candle Buffer Depth Warm-Up Check
    if (params.candleCount !== undefined && params.candleCount < 50) {
      return {
        allowed: false,
        code: 'INSUFFICIENT_BUFFER_VETO',
        reason: `[FEATURE BUFFER HALT] Suppressed trade on ${params.symbol}. Insufficient candle depth (${params.candleCount}/50 required). Ingestion warm-up in progress.`,
        recommendedSL: -0.02,
        recommendedTP: 0.10
      };
    }

    // 3. Feature Stasis & Static Default Check
    if (Math.abs(params.rsi - 50.0) < 1e-6 && Math.abs(params.atr - 0.001) < 1e-6) {
      return {
        allowed: false,
        code: 'FEATURE_STASIS_VETO',
        reason: `[FEATURE STASIS REJECTION] Suppressed trade on ${params.symbol}. Detected static placeholder defaults (RSI=50.0, ATR=0.001).`,
        recommendedSL: -0.02,
        recommendedTP: 0.10
      };
    }

    // 4. Macro Regime Constraint (TRENDING_BEARISH Lockout)
    if (regime === 'TRENDING_BEARISH' && side === 'YES') {
      if (isAltcoin) {
        return {
          allowed: false,
          code: 'REGIME_VETO',
          reason: `[REGIME FILTER REJECTION] Rejected YES (Long) trade on altcoin ${params.symbol}. Strict constraint: Zero YES (Long) altcoin positions permitted in TRENDING_BEARISH regime.`,
          recommendedSL: -0.02,
          recommendedTP: 0.10
        };
      } else {
        // BTC or non-altcoin: Only allow if VPIN < 0.10 (noise-driven exception)
        const vpin = params.vpin ?? 0.22;
        if (vpin >= 0.10) {
          return {
            allowed: false,
            code: 'REGIME_VETO',
            reason: `[REGIME GATE DISCARD] Discarded YES (Long) trade on ${params.symbol} in TRENDING_BEARISH regime (VPIN ${vpin.toFixed(4)} >= 0.10).`,
            recommendedSL: -0.02,
            recommendedTP: 0.10
          };
        }
      }
    }

    // 5. USDT Dominance Positive Delta Altcoin Long Veto
    if (isAltcoin && side === 'YES') {
      const deltaUsdt = params.deltaUsdtD || 0;
      if (deltaUsdt > 0.0 || params.usdtDominanceSignal === 'UP') {
        return {
          allowed: false,
          code: 'USDT_DOMINANCE_VETO',
          reason: `[USDT.D POSITIVE DELTA VETO] USDT.D 1m delta (+${deltaUsdt.toFixed(4)}%) > 0. Rejected YES (Long) altcoin trade on ${params.symbol} during rising Tether dominance.`,
          recommendedSL: -0.02,
          recommendedTP: 0.10
        };
      }
    }

    // 6. Dynamic Volatility-Based Stop-Loss & Take-Profit Calibration
    const liveAtr = Math.max(0.005, params.atr);
    let recommendedSL = -0.02;
    let recommendedTP = 0.10;

    if (regime === 'CHOPPY_SIDEWAYS') {
      // In choppy sideways: Cap SL at 1.5x ATR with a hard 5% maximum ceiling
      recommendedSL = -Math.max(0.02, Math.min(0.05, 1.5 * liveAtr));
      recommendedTP = Math.max(0.08, 2.0 * liveAtr);
    } else if (regime === 'TRENDING_BULLISH' || regime === 'TRENDING_BEARISH') {
      recommendedSL = -Math.max(0.025, Math.min(0.06, 2.0 * liveAtr));
      recommendedTP = Math.max(0.12, 3.0 * liveAtr);
    }

    return {
      allowed: true,
      code: 'APPROVED',
      recommendedSL,
      recommendedTP
    };
  }

  public static isAltcoinSymbol(symbol: string): boolean {
    const sym = (symbol || '').toUpperCase();
    return this.ALTCOIN_IDENTIFIERS.some(alt => sym.includes(alt));
  }
}
