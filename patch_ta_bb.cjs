const fs = require('fs');
let code = fs.readFileSync('spotTAEngine.ts', 'utf8');

const targetCalc = `  // 2. Calculate Ichimoku Cloud Indicators`;
const newCalc = `  // 1.5 Calculate Bollinger Bands & Keltner Channels
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

  // 2. Calculate Ichimoku Cloud Indicators`;

code = code.replace(targetCalc, newCalc);

const targetRet = `    rsi,
    ichimokuState,`;
const newRet = `    rsi,
    bbUpper,
    bbMiddle,
    bbLower,
    percentB,
    bandWidth,
    ichimokuState,`;
    
code = code.replace(targetRet, newRet);

fs.writeFileSync('spotTAEngine.ts', code, 'utf8');
