import { computeSpotTAMetrics, SpotTAMetrics, Candle } from './spotTAEngine';

export interface ContractSpotCorrelation {
  contractSymbol: string;
  contractLabel: string;
  category: string;
  correlatedSpotPair: string;
  isCryptoSpot: boolean;
}

export interface ValidationResult {
  isValid: boolean;
  correlatedSpotPair: string;
  isCryptoSpot: boolean;
  reason?: string;
}

export class UnifiedDataHandler {
  /**
   * Strictly maps derivative prediction contract symbols/labels to their corresponding spot USD pair.
   */
  public resolveCorrelatedSpotPair(symbol: string, label?: string, category?: string): ContractSpotCorrelation {
    const symUpper = (symbol || '').toUpperCase();
    const lblUpper = (label || '').toUpperCase();
    const catLower = (category || '').toLowerCase();

    let correlatedSpotPair = 'NONE';
    let isCryptoSpot = false;

    // Prioritize non-crypto sports/tennis detection
    if (catLower === 'sports' || symUpper.includes('ATP') || symUpper.includes('TENNIS') || lblUpper.includes('TENNIS') || lblUpper.includes('ATP')) {
      return {
        contractSymbol: symbol,
        contractLabel: label || symbol,
        category: 'sports',
        correlatedSpotPair: 'NON_CRYPTO_SPORTS',
        isCryptoSpot: false
      };
    }

    if (symUpper.includes('ETH') || lblUpper.includes('ETH')) {
      correlatedSpotPair = 'ETH-USD';
      isCryptoSpot = true;
    } else if (symUpper.includes('SOL') || lblUpper.includes('SOL')) {
      correlatedSpotPair = 'SOL-USD';
      isCryptoSpot = true;
    } else if (symUpper.includes('DOGE') || lblUpper.includes('DOGE')) {
      correlatedSpotPair = 'DOGE-USD';
      isCryptoSpot = true;
    } else if (symUpper.includes('XRP') || lblUpper.includes('XRP')) {
      correlatedSpotPair = 'XRP-USD';
      isCryptoSpot = true;
    } else if (symUpper.includes('HYPE') || lblUpper.includes('HYPE')) {
      correlatedSpotPair = 'HYPE-USD';
      isCryptoSpot = true;
    } else if (symUpper.includes('SUI') || lblUpper.includes('SUI')) {
      correlatedSpotPair = 'SUI-USD';
      isCryptoSpot = true;
    } else if (symUpper.includes('LINK') || lblUpper.includes('LINK')) {
      correlatedSpotPair = 'LINK-USD';
      isCryptoSpot = true;
    } else if (symUpper.includes('ADA') || lblUpper.includes('ADA')) {
      correlatedSpotPair = 'ADA-USD';
      isCryptoSpot = true;
    } else if (symUpper.includes('LTC') || lblUpper.includes('LTC')) {
      correlatedSpotPair = 'LTC-USD';
      isCryptoSpot = true;
    } else if (symUpper.includes('BCH') || lblUpper.includes('BCH')) {
      correlatedSpotPair = 'BCH-USD';
      isCryptoSpot = true;
    } else if (symUpper.includes('AAVE') || lblUpper.includes('AAVE')) {
      correlatedSpotPair = 'AAVE-USD';
      isCryptoSpot = true;
    } else if (symUpper.includes('AVAX') || lblUpper.includes('AVAX')) {
      correlatedSpotPair = 'AVAX-USD';
      isCryptoSpot = true;
    } else if (symUpper.includes('BTC') || lblUpper.includes('BTC')) {
      correlatedSpotPair = 'BTC-USD';
      isCryptoSpot = true;
    } else if (catLower === 'crypto' || symUpper.startsWith('KX') || symUpper.endsWith('PERP')) {
      correlatedSpotPair = 'BTC-USD';
      isCryptoSpot = true;
    } else {
      correlatedSpotPair = 'NON_CRYPTO_SPORTS';
      isCryptoSpot = false;
    }

    return {
      contractSymbol: symbol,
      contractLabel: label || symbol,
      category: category || 'crypto',
      correlatedSpotPair,
      isCryptoSpot
    };
  }

  /**
   * Extracts historical spot indicators (Ichimoku, RSI, Volume) for the strictly mapped spot USD pair.
   */
  public getSpotIndicatorsForContract(
    symbol: string,
    label: string,
    category: string,
    candlesMap: { [pair: string]: Candle[] }
  ): SpotTAMetrics {
    const mapping = this.resolveCorrelatedSpotPair(symbol, label, category);
    if (!mapping.isCryptoSpot) {
      return {
        pair: 'NON_CRYPTO',
        price: 0,
        rsi: 50,
        ichimokuState: 'NEUTRAL_IN_CLOUD',
        tenkanSen: 0,
        kijunSen: 0,
        senkouSpanA: 0,
        senkouSpanB: 0,
        tenkanKijunCross: 'NEUTRAL',
        isDoji: false,
        dojiType: 'NONE',
        volumeSurgeRatio: 1.0,
        candleRangePct: 0.1,
        adx: 25,
        isChoppy: false,
        fractionalDiffValue: 0,
        vwapDistancePct: 0,
        bbUpper: 0,
        bbMiddle: 0,
        bbLower: 0,
        percentB: 0.5,
        bandWidth: 0
      };
    }

    const candles = candlesMap[mapping.correlatedSpotPair] || [];
    return computeSpotTAMetrics(mapping.correlatedSpotPair, candles);
  }

  /**
   * Validation check for the training loop:
   * Verifies that the data being learned is derived exclusively from the spot pair that correlates to the prediction contract.
   */
  public validateTradeSpotCorrelation(
    symbol: string,
    category: string,
    spotTA: any,
    label?: string
  ): ValidationResult {
    const mapping = this.resolveCorrelatedSpotPair(symbol, label, category);

    if (!mapping.isCryptoSpot) {
      if (spotTA && spotTA.pair && spotTA.pair !== 'NON_CRYPTO' && spotTA.pair !== 'NONE') {
        return {
          isValid: false,
          correlatedSpotPair: mapping.correlatedSpotPair,
          isCryptoSpot: false,
          reason: `Non-crypto/Sports contract ${symbol} received crypto spot TA (${spotTA.pair}). Cross-asset learning rejected.`
        };
      }
      return {
        isValid: true,
        correlatedSpotPair: mapping.correlatedSpotPair,
        isCryptoSpot: false
      };
    }

    if (!spotTA || !spotTA.pair) {
      return {
        isValid: false,
        correlatedSpotPair: mapping.correlatedSpotPair,
        isCryptoSpot: true,
        reason: `Missing spot TA payload for crypto contract ${symbol} (expected ${mapping.correlatedSpotPair}).`
      };
    }

    if (spotTA.pair !== mapping.correlatedSpotPair) {
      return {
        isValid: false,
        correlatedSpotPair: mapping.correlatedSpotPair,
        isCryptoSpot: true,
        reason: `Spot pair mismatch: Derivative contract ${symbol} maps to ${mapping.correlatedSpotPair}, but received TA for ${spotTA.pair}. Learning discarded to maintain pair correlation purity.`
      };
    }

    return {
      isValid: true,
      correlatedSpotPair: mapping.correlatedSpotPair,
      isCryptoSpot: true
    };
  }
}

export const unifiedDataHandler = new UnifiedDataHandler();
