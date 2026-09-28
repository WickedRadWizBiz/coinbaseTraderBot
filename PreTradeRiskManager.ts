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

import { SignalValidator } from "./SignalValidator";

export interface PreTradeEvaluationParams {
  symbol: string;
  side: 'YES' | 'NO';
  marketRegime: string;
  ichimokuState?: string;
  ichimokuCloudState?: string;
  orderFlowImbalance?: number;
  orderBookImbalance?: number;
  deltaUsdtD: number;
  usdtDominanceSignal?: 'UP' | 'DOWN' | 'NEUTRAL';
  usdtDominanceTrend?: 'EXPANDING' | 'CONTRACTING' | 'NEUTRAL';
  rsi: number;
  atr: number;
  vpin?: number;
  candleCount?: number;
  isBlacklisted?: boolean;
  blacklistRemainingSec?: number;
  is15mPattern?: boolean;
  patternType?: string;
  executionDelayMs?: number;
}

export interface PreTradeEvaluationResult {
  allowed: boolean;
  code: 'APPROVED' | 'REGIME_VETO' | 'USDT_DOMINANCE_VETO' | 'FEATURE_STASIS_VETO' | 'ADVERSE_SELECTION_VETO' | 'INSUFFICIENT_BUFFER_VETO' | 'TOXIC_OFI_VETO' | 'VPIN_RISK_REJECTION' | 'LATENCY_TTL_EXCEEDED_VETO' | 'REGIME_CONSTRAINT_VETO';
  reason?: string;
  recommendedSL: number;
  recommendedTP: number;
  executionOrderType?: 'MARKET_ORDER' | 'POST_ONLY_LIMIT';
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
    const ichimokuState = params.ichimokuCloudState || params.ichimokuState || 'NEUTRAL_IN_CLOUD';
    const ichimokuCloudState = ichimokuState;
    const marketRegime = regime;
    const side = params.side;
    const ofi = params.orderFlowImbalance ?? 0.0;
    const obImbalance = params.orderBookImbalance ?? 1.0;
    const vpinVal = params.vpin ?? 0.05;
    const is15m = params.is15mPattern ?? (sym.includes('15M') || sym.includes('15m'));

    // 1. Adverse Selection Circuit Breaker Check (30s Back-Off)
    if (params.isBlacklisted) {
      return {
        allowed: false,
        code: 'ADVERSE_SELECTION_VETO',
        reason: `[ADVERSE SELECTION REJECTION] Suppressed trade on ${params.symbol}. Symbol is in toxic markout back-off (${params.blacklistRemainingSec || 30}s remaining).`,
        recommendedSL: -0.02,
        recommendedTP: 0.10
      };
    }

    // 2. SignalValidator Constraint Evaluation (USDT.D Lock & Hard Regime Gate)
    const validatorResult = SignalValidator.validate({
      symbol: params.symbol,
      side,
      marketRegime,
      ichimokuCloudState,
      usdtDominanceTrend: params.usdtDominanceTrend,
      usdtDominanceSignal: params.usdtDominanceSignal,
      deltaUsdtD: params.deltaUsdtD,
      orderBookImbalance: obImbalance,
      orderFlowImbalance: ofi,
      vpin: vpinVal,
      volatilityAtr: params.atr,
      is15mPattern: is15m,
      patternType: params.patternType,
      executionDelayMs: params.executionDelayMs
    });

    if (!validatorResult.approved) {
      return {
        allowed: false,
        code: validatorResult.code === 'USDT_DOMINANCE_LOCK' ? 'USDT_DOMINANCE_VETO' : 
              validatorResult.code === 'VPIN_RISK_REJECTION' ? 'VPIN_RISK_REJECTION' :
              validatorResult.code === 'LATENCY_TTL_EXCEEDED_VETO' ? 'LATENCY_TTL_EXCEEDED_VETO' :
              validatorResult.code === 'TOXIC_OFI_VETO' ? 'TOXIC_OFI_VETO' :
              validatorResult.code === 'REGIME_CONSTRAINT_VETO' ? 'REGIME_CONSTRAINT_VETO' : 'REGIME_VETO',
        reason: validatorResult.reason,
        recommendedSL: validatorResult.vaslStopLossPct,
        recommendedTP: validatorResult.vaslTakeProfitPct,
        executionOrderType: validatorResult.executionOrderType
      };
    }

    // 3. Toxic Order Flow Imbalance (OFI) Threshold Gate
    // If orderFlowImbalance < -0.10, inhibit buy / YES orders (collapsing bid)
    if (side === 'YES' && ofi < -0.10) {
      return {
        allowed: false,
        code: 'TOXIC_OFI_VETO',
        reason: `[TOXIC OFI COLLAPSE VETO] Inhibit BUY on ${params.symbol}: Order Flow Imbalance (${ofi.toFixed(4)}) < -0.10 indicates collapsing bid depth.`,
        recommendedSL: validatorResult.vaslStopLossPct,
        recommendedTP: validatorResult.vaslTakeProfitPct,
        executionOrderType: validatorResult.executionOrderType
      };
    }
    // If orderFlowImbalance > +0.10, inhibit sell / NO orders (surging buy pressure)
    if (side === 'NO' && ofi > 0.10) {
      return {
        allowed: false,
        code: 'TOXIC_OFI_VETO',
        reason: `[TOXIC OFI SURGE VETO] Inhibit SELL on ${params.symbol}: Order Flow Imbalance (${ofi.toFixed(4)}) > +0.10 indicates surging buy book.`,
        recommendedSL: validatorResult.vaslStopLossPct,
        recommendedTP: validatorResult.vaslTakeProfitPct,
        executionOrderType: validatorResult.executionOrderType
      };
    }

    // 4. Candle Buffer Depth Warm-Up Check
    if (params.candleCount !== undefined && params.candleCount < 50) {
      return {
        allowed: false,
        code: 'INSUFFICIENT_BUFFER_VETO',
        reason: `[FEATURE BUFFER HALT] Suppressed trade on ${params.symbol}. Insufficient candle depth (${params.candleCount}/50 required). Ingestion warm-up in progress.`,
        recommendedSL: validatorResult.vaslStopLossPct,
        recommendedTP: validatorResult.vaslTakeProfitPct
      };
    }

    // 5. Feature Stasis & Static Default Check
    if (Math.abs(params.rsi - 50.0) < 1e-6 && Math.abs(params.atr - 0.001) < 1e-6) {
      return {
        allowed: false,
        code: 'FEATURE_STASIS_VETO',
        reason: `[FEATURE STASIS REJECTION] Suppressed trade on ${params.symbol}. Detected static placeholder defaults (RSI=50.0, ATR=0.001).`,
        recommendedSL: validatorResult.vaslStopLossPct,
        recommendedTP: validatorResult.vaslTakeProfitPct
      };
    }

    // 6. HARD REGIME LOGIC GATE (Macro Alignment):
    // Zero 'YES' (Long) trades permitted in TRENDING_BEARISH or BEARISH_CLOUD across all assets
    if (side === 'YES') {
      let allowLong = true;
      if (marketRegime === 'TRENDING_BEARISH' || ichimokuCloudState === 'BEARISH_CLOUD') {
        allowLong = false;
      }
      if (!allowLong) {
        return {
          allowed: false,
          code: 'REGIME_VETO',
          reason: `[HARD REGIME GATE VETO] Prohibited YES (Long) on ${params.symbol}: Strict constraint active in ${marketRegime} / ${ichimokuCloudState}. Must exit cloud and confirm bullish cross.`,
          recommendedSL: validatorResult.vaslStopLossPct,
          recommendedTP: validatorResult.vaslTakeProfitPct
        };
      }
    }

    // 7. USDT Dominance Positive Delta Altcoin Long Veto
    if (isAltcoin && side === 'YES') {
      const deltaUsdt = params.deltaUsdtD || 0;
      if (deltaUsdt > 0.0 || params.usdtDominanceSignal === 'UP') {
        return {
          allowed: false,
          code: 'USDT_DOMINANCE_VETO',
          reason: `[USDT.D POSITIVE DELTA VETO] USDT.D 1m delta (+${deltaUsdt.toFixed(4)}%) > 0. Rejected YES (Long) altcoin trade on ${params.symbol} during rising Tether dominance.`,
          recommendedSL: validatorResult.vaslStopLossPct,
          recommendedTP: validatorResult.vaslTakeProfitPct
        };
      }
    }

    // 8. Volatility-Adjusted Stop Loss (VASL) & TP Calibration
    const recommendedSL = validatorResult.vaslStopLossPct;
    const recommendedTP = validatorResult.vaslTakeProfitPct;

    return {
      allowed: true,
      code: 'APPROVED',
      recommendedSL,
      recommendedTP,
      executionOrderType: validatorResult.executionOrderType
    };
  }

  public static isAltcoinSymbol(symbol: string): boolean {
    const sym = (symbol || '').toUpperCase();
    return this.ALTCOIN_IDENTIFIERS.some(alt => sym.includes(alt));
  }
}
