const fs = require('fs');
let code = fs.readFileSync('spotTAEngine.ts', 'utf8');

const targetADX = `  // 5. ADX / Choppiness Index (Option 4A)
  let adx = 25;`;

const newADX = `  // 5. ADX / Choppiness Index (Option 4A)
  let adx = 25;`;

const insertAfterVwap = `    anchoredVwapDistancePct = Number(((price - avwapCurrent) / avwapCurrent).toFixed(4));
    anchoredVwapSlope = Number(((avwapCurrent - avwap10PeriodsAgo) / avwap10PeriodsAgo).toFixed(4));
  }`;

const newMetrics = `    anchoredVwapDistancePct = Number(((price - avwapCurrent) / avwapCurrent).toFixed(4));
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
  }`;

code = code.replace(insertAfterVwap, newMetrics);

const targetEmaHelper = `function calculateFractionalDiff`;
const newEmaHelper = `function calculateEMA(prices: number[], period: number): number[] {
  if (prices.length === 0) return [];
  const k = 2 / (period + 1);
  const emaArray = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    emaArray.push(prices[i] * k + emaArray[i - 1] * (1 - k));
  }
  return emaArray;
}

function calculateFractionalDiff`;

code = code.replace(targetEmaHelper, newEmaHelper);

const targetRet2 = `    anchoredVwapSlope,
    relativeVolume`;

const newRet2 = `    anchoredVwapSlope,
    relativeVolume,
    macdRatio,
    forceIndex,
    obvRoc,
    tnRsi,
    macdHist,
    macd`;

code = code.replace(targetRet2, newRet2);

fs.writeFileSync('spotTAEngine.ts', code, 'utf8');
