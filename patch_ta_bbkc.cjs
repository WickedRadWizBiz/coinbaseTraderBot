const fs = require('fs');
let code = fs.readFileSync('spotTAEngine.ts', 'utf8');

const targetInterface = `  bandWidth: number;
  ichimokuState: 'BULLISH_CLOUD' | 'BEARISH_CLOUD' | 'NEUTRAL_IN_CLOUD';`;

const newInterface = `  bandWidth: number;
  hurstExponent?: number;
  bbkcSqueezeActive?: boolean;
  ichimokuState: 'BULLISH_CLOUD' | 'BEARISH_CLOUD' | 'NEUTRAL_IN_CLOUD';`;

code = code.replace(targetInterface, newInterface);

const targetReturn1 = `      percentB: 0.5,
      bandWidth: 0,
      ichimokuState: 'NEUTRAL_IN_CLOUD',`;

const newReturn1 = `      percentB: 0.5,
      bandWidth: 0,
      hurstExponent: 0.5,
      bbkcSqueezeActive: false,
      ichimokuState: 'NEUTRAL_IN_CLOUD',`;

code = code.replace(targetReturn1, newReturn1);

const targetCalc = `    if (bbUpper !== bbLower) {
       percentB = Number(((price - bbLower) / (bbUpper - bbLower)).toFixed(4));
       bandWidth = Number(((bbUpper - bbLower) / bbMiddle).toFixed(4));
    }
  }

  // 2. Calculate Ichimoku Cloud Indicators`;

const newCalc = `    if (bbUpper !== bbLower) {
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

  // 2. Calculate Ichimoku Cloud Indicators`;

code = code.replace(targetCalc, newCalc);

const targetRet = `    percentB,
    bandWidth,
    ichimokuState,`;
    
const newRet = `    percentB,
    bandWidth,
    hurstExponent,
    bbkcSqueezeActive,
    ichimokuState,`;

code = code.replace(targetRet, newRet);

fs.writeFileSync('spotTAEngine.ts', code, 'utf8');
