/**
 * macroRegime.ts
 * ==============
 * Contextual Macro Regime Transitions & Multi-Timeframe Regime Engine (SR 11-7 Institutional Grade).
 * 
 * Prevents rigid TRENDING_BULLISH lockouts by computing rolling multi-timeframe BTC.D,
 * USDT.D, and local oscillator regime shifts (RSI exhaustion, Bollinger bandwidth compression,
 * Bearish Divergences, and altcoin relief rallies).
 */

export interface MacroRegimeParams {
  symbol?: string;
  baseRegime?: string;
  rsi?: number;
  atr?: number;
  bandWidth?: number;
  ichimokuState?: string;
  deltaUsdtD?: number;
  usdtDominanceSignal?: string;
  patternType?: string;
  btcDominanceSignal?: string;
  deltaBtcD?: number;
}

export function computeDynamicMarketRegime({
  symbol,
  baseRegime = 'CHOPPY_SIDEWAYS',
  rsi,
  atr,
  bandWidth,
  ichimokuState,
  deltaUsdtD,
  usdtDominanceSignal,
  patternType,
  btcDominanceSignal,
  deltaBtcD
}: MacroRegimeParams): string {
  const isRisingUsdt = (usdtDominanceSignal === 'UP') || (deltaUsdtD !== undefined && deltaUsdtD > 0);
  const isRisingBtcD = (btcDominanceSignal === 'UP') || (deltaBtcD !== undefined && deltaBtcD > 0.01);
  const isFallingBtcD = (btcDominanceSignal === 'DOWN') || (deltaBtcD !== undefined && deltaBtcD < -0.01);
  const currentRsi = rsi ?? 50.0;
  const currentAtr = atr ?? 0.012;
  const currentBbWidth = bandWidth ?? 0.03;
  const cloud = ichimokuState ?? 'NEUTRAL_IN_CLOUD';
  const sym = (symbol || '').toUpperCase();
  const isAltcoin = !sym.includes('BTC');

  // 1. Extreme overbought momentum (RSI >= 70 / 77.4) or Bearish Divergence or Bearish Cloud with expanding Tether dominance
  if (currentRsi >= 70 || patternType === 'STRONG_BEARISH_DIVERGENCE' || cloud === 'BEARISH_CLOUD' || (isRisingUsdt && (sym.includes('SOL') || sym.includes('HYPE') || sym.includes('XRP') || sym.includes('ADA') || sym.includes('DOGE') || sym.includes('NEAR') || sym.includes('SHIB')))) {
    if (currentRsi >= 75 || cloud === 'BEARISH_CLOUD' || patternType === 'STRONG_BEARISH_DIVERGENCE') {
      return 'TRENDING_BEARISH';
    }
    return 'MEAN_REVERTING';
  }

  // 2. Extreme oversold momentum (RSI <= 30) or Bullish Divergence or Bullish Cloud with contracting Tether dominance
  if (currentRsi <= 30 || patternType === 'STRONG_BULLISH_DIVERGENCE' || (cloud === 'BULLISH_CLOUD' && !isRisingUsdt)) {
    if (cloud === 'BULLISH_CLOUD' && !isRisingUsdt) {
      return 'TRENDING_BULLISH';
    }
    return 'MEAN_REVERTING';
  }

  // 3. Multi-timeframe BTC.D & USDT.D Regime shifts:
  // When BTC dominance is contracting (falling BTC.D) and USDT is not expanding, altcoins experience relief flow
  if (isAltcoin && isFallingBtcD && !isRisingUsdt && currentRsi > 45 && currentRsi < 65) {
    return 'TRENDING_BULLISH';
  }

  // When BTC dominance is surging, altcoins suffer liquidity drain: prevent rigid TRENDING_BULLISH on altcoins
  if (isAltcoin && isRisingBtcD && baseRegime === 'TRENDING_BULLISH') {
    return 'MEAN_REVERTING';
  }

  // 4. Low volatility / compression
  if (currentBbWidth <= 0.025 && currentAtr <= 0.008) {
    return 'CHOPPY_SIDEWAYS';
  }

  // 5. Prevent rigid TRENDING_BULLISH lockouts when local oscillators show exhaustion (RSI >= 65) or Tether dominance expands
  if (baseRegime === 'TRENDING_BULLISH' && (currentRsi >= 65 || isRisingUsdt || isRisingBtcD)) {
    return 'MEAN_REVERTING';
  }

  return baseRegime || 'CHOPPY_SIDEWAYS';
}
