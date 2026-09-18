const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const targetObj = `  const entryFeatures: EntryFeatures = {
    rsi: spotMetrics.rsi,
    macd: spotMetrics.macd || 0,
    macdHist: spotMetrics.macdHist || 0,
    maSpread: spotMetrics.maSpread || 0,
    primaryConfidence: prob,
    primaryDirection: side === 'YES' ? 1 : side === 'NO' ? -1 : 0,
    atr: spotMetrics.candleRangePct,
    bollingerBandWidth: 0,
    bidAskSpread: orderbookImbalance,
    orderbookImbalance: orderbookImbalance,
    volumeSurgeRatio: spotMetrics.volumeSurgeRatio,
    stationarityFracDiff: spotMetrics.fractionalDiffValue,
    hourOfDay: currentHour,
    dayOfWeek: currentDay,
    tradingSession: sessionType,
    patternType: params?.patternType || 'GENERAL_ANALYSIS',
    confluenceCount: taCheck.confluenceCount || 0,
    orderFlowImbalance: orderbookImbalance,
    tradeFlowImbalance: orderbookImbalance,
    vwapDistancePct: spotMetrics.vwapDistancePct,
    marketRegime: regimeStr,`;

const newObj = `  const entryFeatures: EntryFeatures = {
    rsi: spotMetrics.rsi,
    macd: spotMetrics.macd || 0,
    macdHist: spotMetrics.macdHist || 0,
    maSpread: spotMetrics.maSpread || 0,
    primaryConfidence: prob,
    primaryDirection: side === 'YES' ? 1 : side === 'NO' ? -1 : 0,
    atr: spotMetrics.candleRangePct,
    percentB: spotMetrics.percentB,
    bandWidth: spotMetrics.bandWidth,
    hurstExponent: spotMetrics.hurstExponent || 0.5,
    bbkcSqueezeActive: spotMetrics.bbkcSqueezeActive ? 1 : 0,
    bidAskSpread: orderbookImbalance,
    orderbookImbalance: orderbookImbalance,
    volumeSurgeRatio: spotMetrics.volumeSurgeRatio,
    stationarityFracDiff: spotMetrics.fractionalDiffValue,
    hourOfDay: currentHour,
    dayOfWeek: currentDay,
    tradingSession: sessionType,
    patternType: params?.patternType || 'GENERAL_ANALYSIS',
    confluenceCount: taCheck.confluenceCount || 0,
    orderFlowImbalance: orderbookImbalance,
    tradeFlowImbalance: orderbookImbalance,
    vwapDistancePct: spotMetrics.vwapDistancePct,
    marketRegime: regimeStr,`;

code = code.replace(targetObj, newObj);
fs.writeFileSync('server.ts', code, 'utf8');
