/**
 * Non-Linear Market Impact & Slippage Engine (SR 11-7 Institutional Grade)
 * 
 * Implements non-linear square-root market impact scaling:
 *   real_slippage = (Order_Size / Market_Depth_Level_1) ** 0.5 * Volatility_ATR
 * 
 * Computes Implementation Shortfall capturing the exact delta between signal mid-price 
 * (nanosecondsAtSignal) and final executed fill price, penalizing Order Flow Imbalance (OFI > 0.6).
 */

export interface MarketFillSimulation {
  fillPrice: number;
  slippageBps: number;
  slippageUsd: number;
  executionDelayMs: number;
  implementationShortfallUsd: number;
  marketDepthL1: number;
  volatilityAtr: number;
  ofiPenaltyApplied: boolean;
}

export class SlippageEngine {
  /**
   * Retrieves or estimates Level-1 Market Depth (contracts available at top of book)
   * Altcoins like KXHYPE, KXSHIB, XRP have substantially thinner L1 depth than BTC/ETH.
   */
  public static getMarketDepthL1(symbol: string): number {
    const sym = (symbol || '').toUpperCase();
    if (sym.includes('BTC')) return 120.0;
    if (sym.includes('ETH')) return 65.0;
    if (sym.includes('SOL')) return 40.0;
    if (sym.includes('ADA') || sym.includes('KXADA')) return 150.0;
    if (sym.includes('HYPE') || sym.includes('KXHYPE')) return 12.0;
    if (sym.includes('SHIB') || sym.includes('KXSHIB')) return 150.0;
    if (sym.includes('DOGE') || sym.includes('XRP')) return 60.0;
    if (sym.includes('WLD')) return 18.0;
    return 25.0; // Default generic prediction market depth
  }

  /**
   * Calculates non-linear market impact and implementation shortfall.
   */
  public static calculateFill({
    symbol,
    targetPrice,
    signalMidPrice,
    side,
    isEntry,
    isPerp = false,
    orderSize = 10,
    volatilityAtr = 0.012,
    orderFlowImbalance = 0.0,
    customDepthL1
  }: {
    symbol: string;
    targetPrice: number;
    signalMidPrice?: number;
    side: 'YES' | 'NO';
    isEntry: boolean;
    isPerp?: boolean;
    orderSize?: number;
    volatilityAtr?: number;
    orderFlowImbalance?: number;
    customDepthL1?: number;
  }): MarketFillSimulation {
    const depthL1 = Math.max(1.0, customDepthL1 || this.getMarketDepthL1(symbol));
    const atr = Math.max(0.001, volatilityAtr || 0.012);
    const size = Math.max(1, orderSize || 10);
    const midAtSignal = signalMidPrice && signalMidPrice > 0 ? signalMidPrice : targetPrice;

    // Non-linear square-root market impact:
    // real_slippage = (Order_Size / Market_Depth_Level_1) ** 0.5 * Volatility_ATR
    const rawSlippageFraction = Math.pow(size / depthL1, 0.5) * atr;

    // Baseline jitter and microsecond execution delay (lognormal distribution ~48ms)
    const u1 = Math.max(0.0001, Math.random());
    const u2 = Math.random();
    const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    const executionDelayMs = Math.round(Math.max(25, Math.min(180, Math.exp(3.85 + z0 * 0.32))));

    // Order Flow Imbalance (OFI) Penalty:
    // Toxic order flow / high imbalance (> 0.6) aggressively widens adverse fill
    const absOfi = Math.abs(orderFlowImbalance || 0);
    let ofiMultiplier = 1.0;
    let ofiPenaltyApplied = false;
    if (absOfi > 0.6) {
      ofiMultiplier = 1.0 + (absOfi - 0.6) * 3.0; // Rapidly penalize toxic OFI
      ofiPenaltyApplied = true;
    }

    const effectiveSlippageFraction = rawSlippageFraction * ofiMultiplier * (1 + (Math.random() * 0.25));

    let fillPrice = targetPrice;
    if (isPerp) {
      if (isEntry) {
        fillPrice = side === 'YES' ? targetPrice * (1 + effectiveSlippageFraction) : targetPrice * (1 - effectiveSlippageFraction);
      } else {
        fillPrice = side === 'YES' ? targetPrice * (1 - effectiveSlippageFraction) : targetPrice * (1 + effectiveSlippageFraction);
      }
      fillPrice = Math.max(0.0001, parseFloat(fillPrice.toFixed(4)));
    } else {
      if (isEntry) {
        fillPrice = side === 'YES' ? targetPrice * (1 + effectiveSlippageFraction) : targetPrice * (1 - effectiveSlippageFraction);
      } else {
        fillPrice = side === 'YES' ? targetPrice * (1 - effectiveSlippageFraction) : targetPrice * (1 + effectiveSlippageFraction);
      }
      fillPrice = Math.max(0.01, Math.min(0.99, parseFloat(fillPrice.toFixed(4))));
    }

    const slippageUsd = Math.max(0.0001, parseFloat(Math.abs(fillPrice - targetPrice).toFixed(4)));
    const slippageBps = parseFloat(((slippageUsd / Math.max(0.01, targetPrice)) * 10000).toFixed(2));

    // Institutional Implementation Shortfall equation normalized by order quantity & unit price:
    // IS_USD = OrderSize * ( |ExecutionPrice - ArrivalPriceMid| + HalfSpread + gamma * (Volatility_ATR * targetPrice) * sqrt(OrderSize / MarketDepth) ) * OFI_Multiplier
    const halfSpread = 0.0005 * Math.max(0.01, targetPrice);
    const gamma = 1.0;
    const depthImpact = gamma * (atr * targetPrice) * Math.sqrt(size / depthL1);
    const priceDelta = Math.abs(fillPrice - midAtSignal);
    const rawShortfallPerUnit = priceDelta + halfSpread + depthImpact;
    const totalNotional = size * targetPrice;
    const computedShortfall = size * rawShortfallPerUnit * ofiMultiplier;
    const implementationShortfallUsd = parseFloat(Math.min(totalNotional * 0.25, Math.max(0.0001, computedShortfall)).toFixed(4));

    return {
      fillPrice,
      slippageBps,
      slippageUsd,
      executionDelayMs,
      implementationShortfallUsd,
      marketDepthL1: depthL1,
      volatilityAtr: atr,
      ofiPenaltyApplied
    };
  }
}
