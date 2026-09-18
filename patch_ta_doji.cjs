const fs = require('fs');
let code = fs.readFileSync('spotTAEngine.ts', 'utf8');

const targetDoji = `  // 3. Doji Candle Pattern Detection (Razor-thin body < 10% of total range)
  const bodyRange = Math.abs(latest.close - latest.open);
  const totalRange = Math.max(0.0001, latest.high - latest.low);
  const isDoji = (bodyRange / totalRange) < 0.10;

  let dojiType: 'DRAGONFLY' | 'GRAVESTONE' | 'STANDARD_DOJI' | 'NONE' = 'NONE';
  if (isDoji) {
    const lowerShadow = Math.min(latest.open, latest.close) - latest.low;
    const upperShadow = latest.high - Math.max(latest.open, latest.close);
    if (lowerShadow / totalRange > 0.65) dojiType = 'DRAGONFLY';
    else if (upperShadow / totalRange > 0.65) dojiType = 'GRAVESTONE';
    else dojiType = 'STANDARD_DOJI';
  }`;

const newDoji = `  // 3. Doji Candle Pattern Detection (Razor-thin body < 10% of total range)
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
  }`;

code = code.replace(targetDoji, newDoji);

const targetRet = `    tenkanSen,
    kijunSen,
    senkouSpanA,
    senkouSpanB,
    tenkanKijunCross,
    isDoji,
    dojiType,`;

const newRet = `    tenkanSen,
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
    lowerShadowRatio,`;

code = code.replace(targetRet, newRet);

fs.writeFileSync('spotTAEngine.ts', code, 'utf8');
