const fs = require('fs');
let code = fs.readFileSync('spotTAEngine.ts', 'utf8');

const targetInterface = `  vwapDistancePct: number; // Percentage distance from rolling VWAP
}`;

const newInterface = `  vwapDistancePct: number; // Percentage distance from rolling VWAP
  anchoredVwapDistancePct?: number; // Distance from Anchored VWAP
  anchoredVwapSlope?: number; // AVWAP 10-period rate of change
  relativeVolume?: number; // RVOL
}`;

code = code.replace(targetInterface, newInterface);

const targetReturn1 = `      fractionalDiffValue: 0, // [E] Fractional Differentiation
      vwapDistancePct: 0
    };`;

const newReturn1 = `      fractionalDiffValue: 0, // [E] Fractional Differentiation
      vwapDistancePct: 0,
      anchoredVwapDistancePct: 0,
      anchoredVwapSlope: 0,
      relativeVolume: 1
    };`;

code = code.replace(targetReturn1, newReturn1);

const targetVwap = `  // 6. Compute rolling VWAP for the entire candle window (or slice)
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
  const vwapDistancePct = Number((((price - vwap) / vwap) * 100).toFixed(2));`;

const newVwap = `  // 6. Compute rolling VWAP for the entire candle window (or slice)
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
  }`;

code = code.replace(targetVwap, newVwap);

const targetRet2 = `    fractionalDiffValue,
    vwapDistancePct`;

const newRet2 = `    fractionalDiffValue,
    vwapDistancePct,
    anchoredVwapDistancePct,
    anchoredVwapSlope,
    relativeVolume`;

code = code.replace(targetRet2, newRet2);

fs.writeFileSync('spotTAEngine.ts', code, 'utf8');
