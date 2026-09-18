export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface SpotTAMetrics {
  pair: string;
  price: number;
  rsi: number;
  bbUpper: number;
  bbMiddle: number;
  bbLower: number;
  percentB: number;
  bandWidth: number;
  hurstExponent?: number;
  bbkcSqueezeActive?: boolean;
  ichimokuState: 'BULLISH_CLOUD' | 'BEARISH_CLOUD' | 'NEUTRAL_IN_CLOUD';
  tenkanSen: number;
  kijunSen: number;
  senkouSpanA: number;
  senkouSpanB: number;
  priceToTenkan?: number;
  priceToKijun?: number;
  tenkanKijunSpread?: number;
  cloudDistanceA?: number;
  cloudDistanceB?: number;
  ichimokuThickDist?: number;
  tenkanKijunCross: 'BULLISH_CROSS' | 'BEARISH_CROSS' | 'NEUTRAL';
  isDoji: boolean;
  dojiType: 'DRAGONFLY' | 'GRAVESTONE' | 'STANDARD_DOJI' | 'NONE';
  bodyRatio?: number;
  upperShadowRatio?: number;
  lowerShadowRatio?: number;
  volumeSurgeRatio: number;
  candleRangePct: number;
  adx: number;
  isChoppy: boolean;
  fractionalDiffValue: number; // [E] Fractional Differentiation for Feature Stationarity
  vwapDistancePct: number; // Percentage distance from rolling VWAP
  anchoredVwapDistancePct?: number; // Distance from Anchored VWAP
  anchoredVwapSlope?: number; // AVWAP 10-period rate of change
  relativeVolume?: number; // RVOL
  fvgDistanceAbove?: number; // Distance to nearest unmitigated bearish FVG
  fvgDistanceBelow?: number; // Distance to nearest unmitigated bullish FVG
  liquiditySweepActive?: number; // 1 for Bullish Sweep, -1 for Bearish Sweep, 0 None
  macdRatio?: number; // Normalized MACD r_{MACD}
  forceIndex?: number; // Normalized Force Index
  obvRoc?: number; // Rate of Change of On-Balance Volume
  tnRsi?: number; // Trend-Normalized RSI
  macdHist?: number;
  macd?: number;
}

function calculateEMA(prices: number[], period: number): number[] {
  if (prices.length === 0) return [];
  const k = 2 / (period + 1);
  const emaArray = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    emaArray.push(prices[i] * k + emaArray[i - 1] * (1 - k));
  }
  return emaArray;
}

function calculateFractionalDiff(prices: number[], d: number = 0.5, windowSize: number = 10): number {
  if (prices.length < windowSize) return 0;
  
  const w: number[] = [1];
  for (let k = 1; k < windowSize; k++) {
    w.push(-w[k - 1] * (d - k + 1) / k);
  }
  
  const targetPrices = prices.slice(-windowSize).reverse();
  let fracDiff = 0;
  for (let i = 0; i < windowSize; i++) {
    fracDiff += w[i] * targetPrices[i];
  }
  return fracDiff;
}

export function computeSpotTAMetrics(pair: string, candles: Candle[]): SpotTAMetrics {
  if (!candles || candles.length === 0) {
    return {
      pair,
      price: 0,
      rsi: 50,
      bbUpper: 0,
      bbMiddle: 0,
      bbLower: 0,
      percentB: 0.5,
      bandWidth: 0,
      hurstExponent: 0.5,
      bbkcSqueezeActive: false,
      ichimokuState: 'NEUTRAL_IN_CLOUD',
      tenkanSen: 0,
      kijunSen: 0,
      senkouSpanA: 0,
      senkouSpanB: 0,
      priceToTenkan: 0,
      priceToKijun: 0,
      tenkanKijunSpread: 0,
      cloudDistanceA: 0,
      cloudDistanceB: 0,
      ichimokuThickDist: 0,
      tenkanKijunCross: 'NEUTRAL',
      isDoji: false,
      dojiType: 'NONE',
      bodyRatio: 0,
      upperShadowRatio: 0,
      lowerShadowRatio: 0,
      volumeSurgeRatio: 1.0,
      candleRangePct: 0.1,
      adx: 25,
      isChoppy: false,
      fractionalDiffValue: 0, // [E] Fractional Differentiation
      vwapDistancePct: 0,
      anchoredVwapDistancePct: 0,
      anchoredVwapSlope: 0,
      relativeVolume: 1,
      fvgDistanceAbove: 0,
      fvgDistanceBelow: 0,
      liquiditySweepActive: 0,
      macdRatio: 0,
      forceIndex: 0,
      obvRoc: 0,
      tnRsi: 50,
      macdHist: 0,
      macd: 0
    };
  }

  const latest = candles[candles.length - 1];
  const price = latest.close;

  // 1. Calculate RSI (14 period)
  let rsi = 50;
  const rsiPeriod = 14;
  if (candles.length > rsiPeriod) {
    let gains = 0;
    let losses = 0;
    for (let i = candles.length - rsiPeriod; i < candles.length; i++) {
      const diff = candles[i].close - candles[i - 1].close;
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    const avgGain = gains / rsiPeriod;
    const avgLoss = losses / rsiPeriod;
    const rs = avgGain / (avgLoss || 1e-10);
    rsi = Number((100 - (100 / (1 + rs))).toFixed(1));
  }

  // Helper for period high/low
  const getPeriodHighLow = (period: number) => {
    const slice = candles.slice(-Math.min(period, candles.length));
    let high = -Infinity;
    let low = Infinity;
    for (const c of slice) {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
    }
    return { high, low };
  };

  // 1.5 Calculate Bollinger Bands & Keltner Channels
  const bbPeriod = 20;
  const bbSlice = candles.slice(-Math.min(bbPeriod, candles.length));
  
  let bbMiddle = price;
  let bbUpper = price;
  let bbLower = price;
  let percentB = 0.5;
  let bandWidth = 0;
  
  if (bbSlice.length > 0) {
    let sum = 0;
    for (const c of bbSlice) sum += c.close;
    bbMiddle = sum / bbSlice.length;

    let sqDiffSum = 0;
    for (const c of bbSlice) sqDiffSum += Math.pow(c.close - bbMiddle, 2);
    const stdDev = Math.sqrt(sqDiffSum / bbSlice.length);
    
    bbUpper = Number((bbMiddle + (2 * stdDev)).toFixed(2));
    bbLower = Number((bbMiddle - (2 * stdDev)).toFixed(2));
    bbMiddle = Number(bbMiddle.toFixed(2));
    
    if (bbUpper !== bbLower) {
       percentB = Number(((price - bbLower) / (bbUpper - bbLower)).toFixed(4));
       bandWidth = Number(((bbUpper - bbLower) / bbMiddle).toFixed(4));
    }
  }

  // 1.75 Calculate Keltner Channels & Squeeze
  let bbkcSqueezeActive = false;
  if (bbSlice.length > 0) {
    let trSum = 0;
    for (let i = 1; i < bbSlice.length; i++) {
       const high = bbSlice[i].high;
       const low = bbSlice[i].low;
       const prevClose = bbSlice[i-1].close;
       const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
       trSum += tr;
    }
    const atr = trSum / Math.max(1, bbSlice.length - 1);
    
    // Keltner Channels (EMA 20 + 1.5 * ATR)
    // For performance we substitute EMA with SMA (bbMiddle)
    const kcUpper = bbMiddle + (1.5 * atr);
    const kcLower = bbMiddle - (1.5 * atr);
    
    // Squeeze is active if Bollinger Bands contract strictly inside Keltner Channels
    if (bbUpper < kcUpper && bbLower > kcLower) {
       bbkcSqueezeActive = true;
    }
  }

  // Calculate Hurst Exponent Approximation (using volatility scaling heuristic for speed)
  let hurstExponent = 0.5; // Default random walk
  if (candles.length > 60) {
     const p60 = candles[candles.length - 60].close;
     const drift = Math.abs(price - p60) / p60;
     const localVol = bandWidth * 1.5;
     if (drift > localVol) hurstExponent = 0.7; // Persistent trending
     else if (drift < localVol * 0.3) hurstExponent = 0.3; // Mean reverting
  }

  // 2. Calculate Ichimoku Cloud Indicators
  // Tenkan-sen (9 period)
  const hl9 = getPeriodHighLow(9);
  const tenkanSen = Number(((hl9.high + hl9.low) / 2).toFixed(2));

  // Kijun-sen (26 period)
  const hl26 = getPeriodHighLow(26);
  const kijunSen = Number(((hl26.high + hl26.low) / 2).toFixed(2));

  // Senkou Span A
  const senkouSpanA = Number(((tenkanSen + kijunSen) / 2).toFixed(2));

  // Senkou Span B (52 period or max available)
  const hl52 = getPeriodHighLow(52);
  const senkouSpanB = Number(((hl52.high + hl52.low) / 2).toFixed(2));

  // Past Cloud Boundaries (Shifted 26 periods back) to find the cloud matching current price
  let senkouA_t26 = senkouSpanA;
  let senkouB_t26 = senkouSpanB;
  if (candles.length > 78) {
    const pastIdx = candles.length - 26;
    
    // Compute Tenkan-sen 26 periods ago
    const slice9 = candles.slice(pastIdx - 9, pastIdx);
    const hl9_past = { high: Math.max(...slice9.map(c=>c.high)), low: Math.min(...slice9.map(c=>c.low)) };
    const tenkan_past = (hl9_past.high + hl9_past.low) / 2;
    
    // Compute Kijun-sen 26 periods ago
    const slice26 = candles.slice(pastIdx - 26, pastIdx);
    const hl26_past = { high: Math.max(...slice26.map(c=>c.high)), low: Math.min(...slice26.map(c=>c.low)) };
    const kijun_past = (hl26_past.high + hl26_past.low) / 2;
    
    senkouA_t26 = (tenkan_past + kijun_past) / 2;
    
    // Compute Senkou B 26 periods ago (needs 52 periods back from pastIdx)
    const slice52 = candles.slice(pastIdx - 52, pastIdx);
    const hl52_past = { high: Math.max(...slice52.map(c=>c.high)), low: Math.min(...slice52.map(c=>c.low)) };
    senkouB_t26 = (hl52_past.high + hl52_past.low) / 2;
  }

  const priceToTenkan = tenkanSen !== 0 ? (price - tenkanSen) / tenkanSen : 0;
  const priceToKijun = kijunSen !== 0 ? (price - kijunSen) / kijunSen : 0;
  const tenkanKijunSpread = kijunSen !== 0 ? (tenkanSen - kijunSen) / kijunSen : 0;
  const cloudDistanceA = senkouA_t26 !== 0 ? (price - senkouA_t26) / senkouA_t26 : 0;
  const cloudDistanceB = senkouB_t26 !== 0 ? (price - senkouB_t26) / senkouB_t26 : 0;
  const ichimokuThickDist = senkouB_t26 !== 0 ? Math.abs(senkouA_t26 - senkouB_t26) / senkouB_t26 : 0;

  // Ichimoku State Determination
  let ichimokuState: 'BULLISH_CLOUD' | 'BEARISH_CLOUD' | 'NEUTRAL_IN_CLOUD' = 'NEUTRAL_IN_CLOUD';
  if (price > Math.max(senkouSpanA, senkouSpanB) && tenkanSen >= kijunSen) {
    ichimokuState = 'BULLISH_CLOUD';
  } else if (price < Math.min(senkouSpanA, senkouSpanB) && tenkanSen <= kijunSen) {
    ichimokuState = 'BEARISH_CLOUD';
  }

  // Tenkan / Kijun Cross
  let tenkanKijunCross: 'BULLISH_CROSS' | 'BEARISH_CROSS' | 'NEUTRAL' = 'NEUTRAL';
  if (tenkanSen > kijunSen) tenkanKijunCross = 'BULLISH_CROSS';
  else if (tenkanSen < kijunSen) tenkanKijunCross = 'BEARISH_CROSS';

  // 3. Doji Candle Pattern Detection (Razor-thin body < 10% of total range)
  const bodyRange = Math.abs(latest.close - latest.open);
  const totalRange = Math.max(0.000001, latest.high - latest.low); // epsilon
  const bodyRatio = bodyRange / totalRange;
  const isDoji = bodyRatio < 0.10;

  let dojiType: 'DRAGONFLY' | 'GRAVESTONE' | 'STANDARD_DOJI' | 'NONE' = 'NONE';
  const lowerShadow = Math.min(latest.open, latest.close) - latest.low;
  const upperShadow = latest.high - Math.max(latest.open, latest.close);
  const upperShadowRatio = upperShadow / totalRange;
  const lowerShadowRatio = lowerShadow / totalRange;

  if (isDoji) {
    if (lowerShadowRatio > 0.65) dojiType = 'DRAGONFLY';
    else if (upperShadowRatio > 0.65) dojiType = 'GRAVESTONE';
    else dojiType = 'STANDARD_DOJI';
  }

  // 4. Volume & Volatility
  const candleRangePct = Number((((latest.high - latest.low) / (latest.open || 1)) * 100).toFixed(2));
  let volumeSurgeRatio = 1.0;
  if (latest.volume && candles.length >= 10) {
    const recentVols = candles.slice(-10).map(c => c.volume || 1);
    const avgVol = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
    volumeSurgeRatio = Number(((latest.volume || 1) / (avgVol || 1)).toFixed(2));
  }

  // 5. ADX / Choppiness Index (Option 4A)
  let adx = 25;
  if (candles.length >= 10) {
    let trSum = 0;
    let plusDMSum = 0;
    let minusDMSum = 0;
    const p = Math.min(14, candles.length - 1);
    for (let i = candles.length - p; i < candles.length; i++) {
      const curr = candles[i];
      const prev = candles[i - 1];
      const tr = Math.max(
        curr.high - curr.low,
        Math.abs(curr.high - prev.close),
        Math.abs(curr.low - prev.close)
      );
      const upMove = curr.high - prev.high;
      const downMove = prev.low - curr.low;
      const plusDM = (upMove > downMove && upMove > 0) ? upMove : 0;
      const minusDM = (downMove > upMove && downMove > 0) ? downMove : 0;
      trSum += tr;
      plusDMSum += plusDM;
      minusDMSum += minusDM;
    }
    const plusDI = (plusDMSum / (trSum || 1e-10)) * 100;
    const minusDI = (minusDMSum / (trSum || 1e-10)) * 100;
    const dx = (Math.abs(plusDI - minusDI) / ((plusDI + minusDI) || 1e-10)) * 100;
    adx = Number(dx.toFixed(1));
  }
  const isChoppy = adx < 20.0;

  // [E] Fractional Differentiation for Feature Stationarity
  // Extracts memory from price series while achieving stationarity
  const prices = candles.map(c => c.close);
  const fractionalDiffValue = calculateFractionalDiff(prices, 0.4, 15);

  // 6. Compute rolling VWAP for the entire candle window (or slice)
  let vwap = price;
  let cumulativeVP = 0;
  let cumulativeVol = 0;
  for (let i = Math.max(0, candles.length - 1440); i < candles.length; i++) {
    const c = candles[i];
    const typicalPrice = (c.high + c.low + c.close) / 3;
    const vol = c.volume || 1;
    cumulativeVP += typicalPrice * vol;
    cumulativeVol += vol;
  }
  if (cumulativeVol > 0) {
    vwap = cumulativeVP / cumulativeVol;
  }
  const vwapDistancePct = Number((((price - vwap) / vwap) * 100).toFixed(2));

  // 7. Anchored VWAP (AVWAP) and Volumetric Distribution
  let anchoredVwapDistancePct = 0;
  let anchoredVwapSlope = 0;
  let relativeVolume = 1.0;
  
  if (candles.length > 20) {
    const recentVols = candles.slice(-20).map(c => c.volume || 1);
    const avgVol = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
    relativeVolume = Number(((latest.volume || 1) / (avgVol || 1)).toFixed(2));

    // Find Anchor Point: Highest volume candle in the last 200 periods
    const searchWindow = Math.max(0, candles.length - 200);
    let maxVol = 0;
    let anchorIdx = searchWindow;
    for (let i = searchWindow; i < candles.length - 5; i++) {
      if ((candles[i].volume || 0) > maxVol) {
        maxVol = candles[i].volume || 0;
        anchorIdx = i;
      }
    }

    // Calculate AVWAP from Anchor Index
    let avwapVP = 0;
    let avwapVol = 0;
    let avwapCurrent = price;
    let avwap10PeriodsAgo = price;

    for (let i = anchorIdx; i < candles.length; i++) {
      const c = candles[i];
      const typP = (c.high + c.low + c.close) / 3;
      const v = c.volume || 1;
      avwapVP += typP * v;
      avwapVol += v;
      if (i === candles.length - 11 && avwapVol > 0) {
         avwap10PeriodsAgo = avwapVP / avwapVol;
      }
    }
    
    if (avwapVol > 0) {
      avwapCurrent = avwapVP / avwapVol;
    }
    
    anchoredVwapDistancePct = Number(((price - avwapCurrent) / avwapCurrent).toFixed(4));
    anchoredVwapSlope = Number(((avwapCurrent - avwap10PeriodsAgo) / avwap10PeriodsAgo).toFixed(4));
  }

  // 8. Advanced MACD Ratio, Force Index, OBV ROC, and TN-RSI
  let macdRatio = 0;
  let forceIndex = 0;
  let obvRoc = 0;
  let tnRsi = 50;
  let macd = 0;
  let macdHist = 0;
  
  if (candles.length > 30) {
    // Basic MACD EMA calculation
    const closePrices = candles.map(c => c.close);
    const ema12 = calculateEMA(closePrices, 12);
    const ema26 = calculateEMA(closePrices, 26);
    macd = ema12[ema12.length - 1] - ema26[ema26.length - 1];
    
    // We need the MACD series to calculate the Signal line (9-period EMA of MACD)
    const macdSeries = [];
    for (let i = 26; i < closePrices.length; i++) {
        const temp12 = calculateEMA(closePrices.slice(0, i + 1), 12);
        const temp26 = calculateEMA(closePrices.slice(0, i + 1), 26);
        macdSeries.push(temp12[temp12.length - 1] - temp26[temp26.length - 1]);
    }
    const signalSeries = calculateEMA(macdSeries, 9);
    const macdSignal = signalSeries[signalSeries.length - 1] || 0;
    macdHist = macd - macdSignal;
    
    // r_{MACD} = (MACD - SIG) / (0.5 * (|MACD| + |SIG|))
    const denominator = 0.5 * (Math.abs(macd) + Math.abs(macdSignal));
    macdRatio = denominator === 0 ? 0 : Number((macdHist / denominator).toFixed(4));

    // Force Index = ((C_t - C_{t-1}) / C_{t-1}) * V_t normalized
    const prevClose = candles[candles.length - 2].close;
    const currentVol = latest.volume || 1;
    const recentVols = candles.slice(-20).map(c => c.volume || 1);
    const avgVol = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
    forceIndex = prevClose !== 0 ? ((price - prevClose) / prevClose) * (currentVol / avgVol) : 0;
    forceIndex = Number(forceIndex.toFixed(4));

    // OBV ROC
    let obv = 0;
    const obvSeries = [0];
    for (let i = 1; i < candles.length; i++) {
        const cClose = candles[i].close;
        const pClose = candles[i - 1].close;
        const cVol = candles[i].volume || 1;
        if (cClose > pClose) obv += cVol;
        else if (cClose < pClose) obv -= cVol;
        obvSeries.push(obv);
    }
    const currentOBV = obvSeries[obvSeries.length - 1];
    const obv5PeriodsAgo = obvSeries[obvSeries.length - 6] || obvSeries[0];
    
    // Normalize OBV ROC by recent total volume to keep it bounded
    const recent5VolSum = candles.slice(-5).reduce((sum, c) => sum + (c.volume || 1), 0);
    obvRoc = recent5VolSum > 0 ? (currentOBV - obv5PeriodsAgo) / recent5VolSum : 0;
    obvRoc = Number(obvRoc.toFixed(4));

    // Trend-Normalized RSI (TN-RSI) - Detrending price with SMA50
    if (candles.length > 65) {
        const detrendedPrices = [];
        for (let i = 50; i < candles.length; i++) {
            const sma50Slice = candles.slice(i - 50, i).map(c => c.close);
            const sma50 = sma50Slice.reduce((a, b) => a + b, 0) / 50;
            detrendedPrices.push(candles[i].close - sma50);
        }
        
        // Calculate RSI on detrended prices (14 period)
        let tnGains = 0;
        let tnLosses = 0;
        for (let i = detrendedPrices.length - 14; i < detrendedPrices.length; i++) {
            const diff = detrendedPrices[i] - detrendedPrices[i - 1];
            if (diff >= 0) tnGains += diff;
            else tnLosses -= diff;
        }
        const avgTnGain = tnGains / 14;
        const avgTnLoss = tnLosses / 14;
        const tnRs = avgTnGain / (avgTnLoss || 1e-10);
        tnRsi = Number((100 - (100 / (1 + tnRs))).toFixed(1));
    }
  }

  // 9. Advanced Geometric Chart Patterns: Fair Value Gaps (FVG) and Liquidity Sweeps
  let fvgDistanceAbove = 0;
  let fvgDistanceBelow = 0;
  let liquiditySweepActive = 0;

  if (candles.length > 50) {
      let fvgAbove = Infinity;
      let fvgBelow = -Infinity;

      // Scan backwards for Unmitigated FVGs
      for (let i = candles.length - 3; i >= Math.max(0, candles.length - 50); i--) {
          // Check Bearish FVG (Resistance above): c1.low > c3.high
          if (candles[i].low > candles[i+2].high) {
              let mitigated = false;
              for (let j = i + 3; j < candles.length; j++) {
                  if (candles[j].high >= candles[i].low) { mitigated = true; break; }
              }
              if (!mitigated) {
                  fvgAbove = Math.min(fvgAbove, candles[i].low);
              }
          }
          // Check Bullish FVG (Support below): c1.high < c3.low
          if (candles[i].high < candles[i+2].low) {
              let mitigated = false;
              for (let j = i + 3; j < candles.length; j++) {
                  if (candles[j].low <= candles[i].high) { mitigated = true; break; }
              }
              if (!mitigated) {
                  fvgBelow = Math.max(fvgBelow, candles[i].high);
              }
          }
      }

      fvgDistanceAbove = fvgAbove !== Infinity ? Number(((fvgAbove - price) / price).toFixed(4)) : 0;
      fvgDistanceBelow = fvgBelow !== -Infinity ? Number(((price - fvgBelow) / price).toFixed(4)) : 0;

      // Liquidity Sweeps (Stop Hunts)
      const lookback = candles.slice(-21, -1);
      const highestHigh = Math.max(...lookback.map(c => c.high));
      const lowestLow = Math.min(...lookback.map(c => c.low));
      
      const wickThresh = 0.5;
      const cRange = latest.high - latest.low;

      if (cRange > 0) {
          // Bearish Sweep (Upthrust)
          if (latest.high > highestHigh && latest.close < highestHigh) {
              const upperWick = latest.high - Math.max(latest.open, latest.close);
              if (upperWick / cRange > wickThresh) {
                  liquiditySweepActive = -1;
              }
          }
          // Bullish Sweep (Spring)
          if (latest.low < lowestLow && latest.close > lowestLow) {
              const lowerWick = Math.min(latest.open, latest.close) - latest.low;
              if (lowerWick / cRange > wickThresh) {
                  liquiditySweepActive = 1;
              }
          }
      }
  }

  return {
    pair,
    price,
    rsi,
    bbUpper,
    bbMiddle,
    bbLower,
    percentB,
    bandWidth,
    hurstExponent,
    bbkcSqueezeActive,
    ichimokuState,
    tenkanSen,
    kijunSen,
    senkouSpanA,
    senkouSpanB,
    priceToTenkan,
    priceToKijun,
    tenkanKijunSpread,
    cloudDistanceA,
    cloudDistanceB,
    ichimokuThickDist,
    tenkanKijunCross,
    isDoji,
    dojiType,
    bodyRatio,
    upperShadowRatio,
    lowerShadowRatio,
    volumeSurgeRatio,
    candleRangePct,
    adx,
    isChoppy,
    fractionalDiffValue,
    vwapDistancePct,
    anchoredVwapDistancePct,
    anchoredVwapSlope,
    relativeVolume,
    fvgDistanceAbove,
    fvgDistanceBelow,
    liquiditySweepActive,
    macdRatio,
    forceIndex,
    obvRoc,
    tnRsi,
    macdHist,
    macd
  };
}

export function evaluateIndicatorConfluence(
  side: 'YES' | 'NO',
  spotTA: SpotTAMetrics,
  bidVol?: number,
  askVol?: number,
  overrideConfluence?: boolean
): { allowed: boolean; reason: string; confluenceCount: number; activeTools: string[] } {
  const activeTools: string[] = [];

  if (side === 'YES') {
    // Tool 1: Orderbook Depth Imbalance (Bids > Asks) + Volume Surge Filter
    if (bidVol !== undefined && askVol !== undefined && bidVol >= askVol * 1.15) {
      if (spotTA.volumeSurgeRatio >= 1.15 || bidVol >= askVol * 1.25) {
        activeTools.push(`Orderbook Depth + OFI Sweep (${bidVol.toFixed(0)} bids > ${askVol.toFixed(0)} asks)`);
      }
    }

    // Tool 2: Ichimoku Cloud / TK Cross Alignment
    if (spotTA.ichimokuState === 'BULLISH_CLOUD' || spotTA.tenkanKijunCross === 'BULLISH_CROSS') {
      activeTools.push(`Bullish Ichimoku Cloud (${spotTA.ichimokuState})`);
    }

    // Tool 3: RSI Momentum / Reversion Zone
    if (spotTA.rsi <= 48) {
      activeTools.push(`Oversold RSI (${spotTA.rsi})`);
    }

    // Tool 6: Bollinger Band Lower Touch (Mean Reversion) or Band Walk
    if (spotTA.percentB <= 0.05) {
       activeTools.push(`Bollinger Lower Band Touch/Breach (${spotTA.percentB.toFixed(2)} %B)`);
    } else if (spotTA.percentB >= 0.95 && spotTA.bandWidth > 0.05) {
       activeTools.push(`Bollinger Band Walk Uptrend (Squeeze Breakout)`);
    }

    // Tool 4: Volume Surge Standalone
    if (spotTA.volumeSurgeRatio >= 1.15) {
      activeTools.push(`Volume Surge (${spotTA.volumeSurgeRatio}x)`);
    }

    // Tool 5: Doji Reversals and Wildcards
    if (spotTA.isDoji && spotTA.dojiType === 'STANDARD_DOJI') {
      activeTools.push(`Wildcard Indecision Doji`);
    } else if (spotTA.isDoji && spotTA.dojiType === 'DRAGONFLY') {
      activeTools.push(`Dragonfly Doji Reversal`);
    }

    // Tool 7: Anchored VWAP Mean Reversion & Support Bounce
    if (spotTA.anchoredVwapDistancePct !== undefined && spotTA.anchoredVwapDistancePct < 0.01 && spotTA.anchoredVwapDistancePct > -0.01) {
       activeTools.push(`Anchored VWAP Support Bounce (${(spotTA.anchoredVwapDistancePct*100).toFixed(2)}% proximity)`);
    }
  } else if (side === 'NO') {
    // Wyckoff Upthrust (Liquidity Sweep + FVG Resistance)
    if (spotTA.liquiditySweepActive === -1 && spotTA.fvgDistanceAbove !== undefined && spotTA.fvgDistanceAbove > 0 && spotTA.fvgDistanceAbove < 0.02) {
        activeTools.push(`Wyckoff Upthrust Liquidity Sweep (Rejected off FVG resistance + Cancel/Fill anomaly)`);
    }

    // Systemic Momentum Cascade (Session Logic + BB < 0 + VWAP)
    if (spotTA.percentB < 0 && spotTA.vwapDistancePct < 0 && spotTA.rsi < 40) {
        activeTools.push(`Systemic Momentum Cascade (BB% < 0 + Below VWAP + Fast RSI Deceleration)`);
    }

    // Fading Euphoria (FOMO Exhaustion)
    if (spotTA.rsi > 85 && spotTA.volumeSurgeRatio > 2 && spotTA.macdHist && spotTA.macdHist > 0) {
        activeTools.push(`FOMO Herding Exhaustion (RSI > 85 + Vol Surge + Expanding MACD)`);
    }

    // Tool 1: Orderbook Depth Imbalance (Asks > Bids) + Volume Surge Filter
    if (bidVol !== undefined && askVol !== undefined && askVol >= bidVol * 1.15) {
      if (spotTA.volumeSurgeRatio >= 1.15 || askVol >= bidVol * 1.25) {
        activeTools.push(`Orderbook Depth + OFI Sweep (${askVol.toFixed(0)} asks > ${bidVol.toFixed(0)} bids)`);
      }
    }

    // Tool 2: Ichimoku Cloud / TK Cross Alignment
    if (spotTA.ichimokuState === 'BEARISH_CLOUD' || spotTA.tenkanKijunCross === 'BEARISH_CROSS') {
      activeTools.push(`Bearish Ichimoku Cloud (${spotTA.ichimokuState})`);
    }

    // Tool 3: RSI Momentum / Reversion Zone
    if (spotTA.rsi >= 52) {
      activeTools.push(`Overbought RSI (${spotTA.rsi})`);
    }

    // Tool 6: Bollinger Band Upper Touch (Mean Reversion) or Band Walk
    if (spotTA.percentB >= 0.95) {
       activeTools.push(`Bollinger Upper Band Touch/Breach (${spotTA.percentB.toFixed(2)} %B)`);
    } else if (spotTA.percentB <= 0.05 && spotTA.bandWidth > 0.05) {
       activeTools.push(`Bollinger Band Walk Downtrend (Squeeze Breakout)`);
    }

    // Tool 4: Volume Surge Standalone
    if (spotTA.volumeSurgeRatio >= 1.15) {
      activeTools.push(`Volume Surge (${spotTA.volumeSurgeRatio}x)`);
    }

    // Tool 5: Doji Reversals and Wildcards
    if (spotTA.isDoji && spotTA.dojiType === 'STANDARD_DOJI') {
      activeTools.push(`Wildcard Indecision Doji`);
    } else if (spotTA.isDoji && spotTA.dojiType === 'GRAVESTONE') {
      activeTools.push(`Gravestone Doji Reversal`);
    }

    // Wyckoff Spring (Liquidity Sweep + FVG Support)
    if (spotTA.liquiditySweepActive === 1 && spotTA.fvgDistanceBelow !== undefined && spotTA.fvgDistanceBelow > 0 && spotTA.fvgDistanceBelow < 0.02) {
        activeTools.push(`Wyckoff Spring Liquidity Sweep (Bounced off FVG support + Cancel/Fill anomaly)`);
    }

    // Tripartite Confluence (RSI, MACD Flip, Anchored VWAP)
    if (spotTA.anchoredVwapDistancePct !== undefined && spotTA.anchoredVwapDistancePct < 0.02 && spotTA.anchoredVwapDistancePct > -0.02) {
       if (spotTA.rsi < 40 && spotTA.macdHist && spotTA.macdHist > 0) {
           activeTools.push(`Tripartite Confluence (AVWAP Support + RSI < 40 + MACD Flip)`);
       }
    }
    
    // Fading Capitulation V-Bottom
    if (spotTA.rsi < 15 && spotTA.percentB < -0.1 && spotTA.forceIndex !== undefined && spotTA.forceIndex < -0.05) {
       activeTools.push(`Panic Capitulation V-Bottom (Force Index spike + BB < -0.1 + RSI < 15)`);
    }

    // Tool 7: Anchored VWAP Resistance Rejection
    if (spotTA.anchoredVwapDistancePct !== undefined && spotTA.anchoredVwapDistancePct < 0.01 && spotTA.anchoredVwapDistancePct > -0.01) {
       activeTools.push(`Anchored VWAP Resistance Rejection (${(spotTA.anchoredVwapDistancePct*100).toFixed(2)}% proximity)`);
    }
  }

  const confluenceCount = activeTools.length;
  const isOFISweep = (side === 'YES' && bidVol !== undefined && askVol !== undefined && bidVol >= askVol * 1.25) ||
                     (side === 'NO' && bidVol !== undefined && askVol !== undefined && askVol >= bidVol * 1.25);

  if (overrideConfluence) {
    return {
      allowed: true,
      confluenceCount: Math.max(confluenceCount, 2),
      activeTools,
      reason: `[CONFLUENCE OVERRIDE ENGAGED] All confluence rules bypassed (${confluenceCount} tools present: ${activeTools.join(' + ') || 'None'}).`
    };
  }

  // Confluence no longer stops trades from happening; it prioritizes candidate setups.
  return {
    allowed: true,
    confluenceCount,
    activeTools,
    reason: isOFISweep 
      ? `[OFI HIGH-CONVICTION SWEEP PRIORITIZED (${confluenceCount} Tool(s))] Rapid sweep entry: ${activeTools.join(' + ')}`
      : `[CONFLUENCE PRIORITIZED (${confluenceCount} Tools)] ${activeTools.length > 0 ? activeTools.join(' + ') : 'Baseline market setup (0 tools)'}`
  };
}

export function isTradeAllowedBySpotTAAndRecovery(
  side: 'YES' | 'NO',
  category: string,
  spotTA: SpotTAMetrics,
  recoveryRules?: { lossAvoidanceRules?: string[]; winSelectionRules?: string[] },
  bidVol?: number,
  askVol?: number,
  overrideConfluence?: boolean
): { allowed: boolean; reason?: string; confluenceCount?: number; activeTools?: string[] } {
  // USER MANDATE: "Override Confluence slider should override all Confluence rules."
  if (overrideConfluence) {
    const confluence = evaluateIndicatorConfluence(side, spotTA, bidVol, askVol, true);
    return {
      allowed: true,
      confluenceCount: Math.max(confluence.confluenceCount, 3),
      activeTools: confluence.activeTools,
      reason: `[OVERRIDE CONFLUENCE ACTIVE] All confluence rules, directional checks, and chop filters overridden.`
    };
  }

  if (category === 'crypto' && spotTA) {
    const isOFISweep = (side === 'YES' && bidVol !== undefined && askVol !== undefined && bidVol >= askVol * 1.25) ||
                       (side === 'NO' && bidVol !== undefined && askVol !== undefined && askVol >= bidVol * 1.25);

    // Option 4A: Choppiness / ADX Filter for BTC & ETH (bypassed if OFI sweep is active)
    if ((spotTA.pair.includes('BTC') || spotTA.pair.includes('ETH')) && spotTA.isChoppy && !overrideConfluence && !isOFISweep) {
      return {
        allowed: false,
        reason: `[RANGEBOUND CHOP FILTER] Rangebound consolidation on ${spotTA.pair} (ADX ${spotTA.adx} < 20). Trading paused until directional momentum establishes.`
      };
    }

    // 1. Doji Candle Indecision & Directional Reversal Avoidance
    if (spotTA.isDoji) {
      if (side === 'NO' && spotTA.dojiType === 'DRAGONFLY') {
        return {
          allowed: false,
          reason: `Counter-trend NO trade rejected: Bullish Dragonfly Doji lower price rejection on spot ${spotTA.pair}.`
        };
      }
      if (side === 'YES' && spotTA.dojiType === 'GRAVESTONE') {
        return {
          allowed: false,
          reason: `Counter-trend YES trade rejected: Bearish Gravestone Doji upper price rejection on spot ${spotTA.pair}.`
        };
      }
      if (spotTA.dojiType !== 'STANDARD_DOJI' && recoveryRules?.lossAvoidanceRules?.includes('AVOID_DOJI_INDECISION_CANDLES') && !overrideConfluence) {
        return {
          allowed: false,
          reason: `Doji indecision candlestick (${spotTA.dojiType}) on spot ${spotTA.pair}. Trade rejected for risk preservation.`
        };
      }
    }

    // 2. Ichimoku Cloud Trend Alignment (Option 2A)
    if (side === 'YES' && spotTA.ichimokuState === 'BEARISH_CLOUD') {
      return {
        allowed: false,
        reason: `Counter-trend YES trade rejected: Spot ${spotTA.pair} is under Bearish Ichimoku Cloud.`
      };
    }

    if (side === 'NO' && spotTA.ichimokuState === 'BULLISH_CLOUD') {
      return {
        allowed: false,
        reason: `Counter-trend NO trade rejected: Spot ${spotTA.pair} is above Bullish Ichimoku Cloud.`
      };
    }

    // 3. Mandatory Multi-Tool Confluence Rule Check
    const confluence = evaluateIndicatorConfluence(side, spotTA, bidVol, askVol, overrideConfluence);
    if (!confluence.allowed && !overrideConfluence) {
      return {
        allowed: false,
        reason: confluence.reason,
        confluenceCount: confluence.confluenceCount,
        activeTools: confluence.activeTools
      };
    }

    return {
      allowed: true,
      confluenceCount: confluence.confluenceCount,
      activeTools: confluence.activeTools,
      reason: confluence.reason
    };
  }

  return { allowed: true };
}

