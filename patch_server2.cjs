const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const targetObj = `    atr: (currentSpotTA?.candleRangePct / 100) || 0.012,
    bollingerBandWidth: currentSpotTA?.bollingerBandWidth || 0.03,
    bidAskSpread: 0.001,
    orderbookImbalance: bidVol / Math.max(1, askVol),
    volumeSurgeRatio: volumeSurge,
    stationarityFracDiff: currentSpotTA?.fractionalDiffValue || 0.0,`;

const newObj = `    atr: (currentSpotTA?.candleRangePct / 100) || 0.012,
    percentB: currentSpotTA?.percentB || 0.5,
    bandWidth: currentSpotTA?.bandWidth || 0.0,
    hurstExponent: currentSpotTA?.hurstExponent || 0.5,
    bbkcSqueezeActive: currentSpotTA?.bbkcSqueezeActive ? 1 : 0,
    priceToTenkan: currentSpotTA?.priceToTenkan || 0,
    priceToKijun: currentSpotTA?.priceToKijun || 0,
    tenkanKijunSpread: currentSpotTA?.tenkanKijunSpread || 0,
    cloudDistanceA: currentSpotTA?.cloudDistanceA || 0,
    cloudDistanceB: currentSpotTA?.cloudDistanceB || 0,
    ichimokuThickDist: currentSpotTA?.ichimokuThickDist || 0,
    bodyRatio: currentSpotTA?.bodyRatio || 0,
    upperShadowRatio: currentSpotTA?.upperShadowRatio || 0,
    lowerShadowRatio: currentSpotTA?.lowerShadowRatio || 0,
    bidAskSpread: 0.001,
    orderbookImbalance: bidVol / Math.max(1, askVol),
    volumeSurgeRatio: volumeSurge,
    stationarityFracDiff: currentSpotTA?.fractionalDiffValue || 0.0,`;

code = code.replace(targetObj, newObj);
fs.writeFileSync('server.ts', code, 'utf8');
