/**
 * Avellaneda-Stoikov Market Making & Almgren-Chriss Market Impact Engine
 * Tailored for Binary Prediction Market Payoffs & Jump-Diffusion Microstructure.
 */

export interface AvellanedaStoikovParams {
  fairProbability: number; // p_t: Latent/theoretical fair price (0.01 to 0.99)
  currentInventory: number; // q: Current contract position (positive for long YES, negative for long NO)
  timeRemainingSec: number; // t_remaining
  gammaRiskAversion?: number; // \gamma: Absolute risk aversion (default 0.1)
  baseKappa?: number;        // \kappa: Baseline liquidity parameter (default 1.5)
  vpinToxicity: number;     // VPIN (0.0 to 1.0)
  tradeFlowImbalance: number;// TFI (-1.0 to 1.0)
}

export interface OptimalQuoteSkew {
  optimalBidPrice: number;   // In cents (e.g., 48)
  optimalAskPrice: number;   // In cents (e.g., 52)
  optimalBidProb: number;    // (0.01 to 0.99)
  optimalAskProb: number;
  reservationPrice: number;  // r(s, q, t)
  bidSpread: number;         // \delta^b
  askSpread: number;         // \delta^a
  effectiveKappa: number;    // Scaled adverse selection parameter
  isToxicWarning: boolean;   // True if informed trading surge detected
  recommendedAction: 'QUOTE_PASSIVE' | 'WIDEN_DEFENSIVELY' | 'ABSTAIN_TOXIC_FLOW';
}

export interface OrderBookLevel {
  price: number; // in dollars (e.g. 0.50)
  quantity: number;
}

export interface AlmgrenChrissImpactResult {
  blendedExecutionPrice: number;
  totalSlippageCostUsd: number;
  slippagePct: number;
  temporaryImpactCents: number;
  permanentImpactCents: number;
  recommendedSlices: number; // 1 = Direct Fill, >1 = Iceberg fragmentation
  isTradeViableNetOfImpact: boolean;
  abortReason?: string;
}

export class AvellanedaStoikovEngine {
  private defaultGamma = 0.15; // Risk aversion
  private defaultBaseKappa = 1.8;

  /**
   * Computes Avellaneda-Stoikov optimal bid/ask spreads for binary prediction markets
   */
  public computeOptimalQuotes(params: AvellanedaStoikovParams): OptimalQuoteSkew {
    const {
      fairProbability: s,
      currentInventory: q,
      timeRemainingSec: t,
      gammaRiskAversion: gamma = this.defaultGamma,
      baseKappa = this.defaultBaseKappa,
      vpinToxicity,
      tradeFlowImbalance
    } = params;

    // Scale kappa non-linearly based on order flow toxicity (VPIN & TFI)
    // Higher toxicity -> lower kappa -> wider spread to reject toxic fills
    const toxicityFactor = Math.max(0.01, vpinToxicity * (1 + Math.abs(tradeFlowImbalance)));
    const effectiveKappa = Math.max(0.2, baseKappa / (1 + toxicityFactor * 3.5));

    // Time horizon factor (tau in fraction of 15-minute horizon)
    const tau = Math.max(0.01, t / 900);

    // Reservation Price: r(s, q, t) = s - q * gamma * sigma^2 * (T - t)
    // In binary space, sigma^2 ~ s * (1 - s)
    const binaryVariance = Math.max(0.01, s * (1 - s));
    const inventoryPenalty = q * gamma * binaryVariance * tau;
    const reservationPrice = Math.max(0.01, Math.min(0.99, s - inventoryPenalty));

    // Optimal Spreads: \delta = (1 / gamma) * ln(1 + gamma / kappa)
    const baseHalfSpread = (1 / gamma) * Math.log(1 + gamma / effectiveKappa) * 0.05; // Normalizing constant
    const minSpread = 0.01; // 1 cent minimum Kalshi tick

    const bidSpread = Math.max(minSpread, baseHalfSpread + inventoryPenalty);
    const askSpread = Math.max(minSpread, baseHalfSpread - inventoryPenalty);

    let optimalBidProb = Math.max(0.01, Math.min(0.98, reservationPrice - bidSpread));
    let optimalAskProb = Math.max(optimalBidProb + 0.01, Math.min(0.99, reservationPrice + askSpread));

    const isToxicWarning = vpinToxicity > 0.65 || Math.abs(tradeFlowImbalance) > 0.70;
    let recommendedAction: 'QUOTE_PASSIVE' | 'WIDEN_DEFENSIVELY' | 'ABSTAIN_TOXIC_FLOW' = 'QUOTE_PASSIVE';

    if (vpinToxicity > 0.80) {
      recommendedAction = 'ABSTAIN_TOXIC_FLOW';
    } else if (isToxicWarning) {
      recommendedAction = 'WIDEN_DEFENSIVELY';
      // Widen spreads aggressively
      optimalBidProb = Math.max(0.01, optimalBidProb - 0.03);
      optimalAskProb = Math.min(0.99, optimalAskProb + 0.03);
    }

    return {
      optimalBidPrice: Math.round(optimalBidProb * 100),
      optimalAskPrice: Math.round(optimalAskProb * 100),
      optimalBidProb,
      optimalAskProb,
      reservationPrice,
      bidSpread,
      askSpread,
      effectiveKappa,
      isToxicWarning,
      recommendedAction
    };
  }

  /**
   * Almgren-Chriss Market Impact Model for Order Book Sweeping & Iceberging
   */
  public calculateMarketImpact(
    targetContracts: number,
    orderBookLevels: OrderBookLevel[],
    side: 'BUY' | 'SELL',
    fairValue: number
  ): AlmgrenChrissImpactResult {
    if (!orderBookLevels || orderBookLevels.length === 0 || targetContracts <= 0) {
      return {
        blendedExecutionPrice: fairValue,
        totalSlippageCostUsd: 0,
        slippagePct: 0,
        temporaryImpactCents: 0,
        permanentImpactCents: 0,
        recommendedSlices: 1,
        isTradeViableNetOfImpact: false,
        abortReason: 'Empty order book'
      };
    }

    let remainingToFill = targetContracts;
    let totalSpentUsd = 0;
    let contractsFilled = 0;
    const topOfBookPrice = orderBookLevels[0].price;

    for (const level of orderBookLevels) {
      const fillAtLevel = Math.min(remainingToFill, level.quantity);
      totalSpentUsd += fillAtLevel * level.price;
      contractsFilled += fillAtLevel;
      remainingToFill -= fillAtLevel;

      if (remainingToFill <= 0) break;
    }

    if (contractsFilled === 0) {
      return {
        blendedExecutionPrice: topOfBookPrice,
        totalSlippageCostUsd: 0,
        slippagePct: 0,
        temporaryImpactCents: 0,
        permanentImpactCents: 0,
        recommendedSlices: 1,
        isTradeViableNetOfImpact: false,
        abortReason: 'Zero liquidity available'
      };
    }

    const blendedPrice = totalSpentUsd / contractsFilled;
    const slippageCostUsd = side === 'BUY'
      ? Math.max(0, (blendedPrice - topOfBookPrice) * contractsFilled)
      : Math.max(0, (topOfBookPrice - blendedPrice) * contractsFilled);

    const slippagePct = (Math.abs(blendedPrice - topOfBookPrice) / Math.max(0.01, topOfBookPrice)) * 100;
    const temporaryImpactCents = Math.round(Math.abs(blendedPrice - topOfBookPrice) * 100);
    const permanentImpactCents = Math.round(temporaryImpactCents * 0.4); // 40% permanent price displacement

    // Iceberg slice recommendation: If slippage exceeds 1.5%, recommend fragmenting
    let recommendedSlices = 1;
    if (slippagePct > 1.5 && contractsFilled > 10) {
      recommendedSlices = Math.min(5, Math.ceil(contractsFilled / Math.max(1, orderBookLevels[0].quantity)));
    }

    // Trade viability check: If slippage eats more than 3 cents of alpha, abort
    const alphaMargin = Math.abs(fairValue - topOfBookPrice);
    const isTradeViableNetOfImpact = (Math.abs(blendedPrice - topOfBookPrice)) < (alphaMargin * 0.6);

    return {
      blendedExecutionPrice: blendedPrice,
      totalSlippageCostUsd: slippageCostUsd,
      slippagePct,
      temporaryImpactCents,
      permanentImpactCents,
      recommendedSlices,
      isTradeViableNetOfImpact,
      abortReason: isTradeViableNetOfImpact ? undefined : `Market impact (${temporaryImpactCents}¢) erodes available theoretical edge (${Math.round(alphaMargin * 100)}¢)`
    };
  }
}

export const avellanedaStoikovEngine = new AvellanedaStoikovEngine();
