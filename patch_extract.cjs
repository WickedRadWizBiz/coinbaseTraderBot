const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

const targetExtract = `  private extractVector(f: EntryFeatures): number[] {
    // Convert cyclical time features to continuous sine/cosine waves for Neural Net stability
    const hour = f.hourOfDay || new Date().getUTCHours();
    const hourSin = Math.sin((hour * Math.PI) / 12);
    const hourCos = Math.cos((hour * Math.PI) / 12);
    
    return [
      f.rsi || 50, f.macd || 0, f.macdHist || 0, f.maSpread || 0,
      f.primaryConfidence || 0, f.primaryDirection || 0, f.atr || 0,
      f.bollingerBandWidth || 0, f.bidAskSpread || 0, f.orderbookImbalance || 1,
      f.volumeSurgeRatio || 1, f.stationarityFracDiff || 0, f.confluenceCount || 0,
      f.smartTrailingActive || 0, f.smartTrailingDistance || 0,
      f.macroGoalProgress || 0, f.macroTimeElapsedHours || 0, f.macroGoalGrade || 0,
      // ---- NEW HIGH-IMPACT INSTITUTIONAL METRICS ----
      f.vpin || 0.5,                  // Order Flow Toxicity
      f.orderFlowImbalance || 0,      // Resting Liquidity Imbalance (Icebergs)
      f.vwapDistancePct || 0,         // Mean Reversion gravity
      f.fundingRate || 0,             // Squeeze probability (over-leveraged shorts/longs)
      f.cancelToFillRatio || 1,       // Spoofing detection
      hourSin,                        // Temporal Context (Asian vs London vs NY)
      hourCos,                        // Temporal Context
      (f.dayOfWeek === 0 || f.dayOfWeek === 6) ? 1 : 0, // Weekend illiquidity flag
      f.strategyTrailFailRate || 0,
      f.strategyTrailEfficiency || 1
    ];
  }`;

const newExtract = `  private extractVector(f: EntryFeatures): number[] {
    // Convert cyclical time features to continuous sine/cosine waves for Neural Net stability
    const hour = f.hourOfDay || new Date().getUTCHours();
    const hourSin = Math.sin((hour * Math.PI) / 12);
    const hourCos = Math.cos((hour * Math.PI) / 12);
    
    // Convert day of week to cyclical variables (0-6)
    const day = f.dayOfWeek || new Date().getUTCDay();
    const daySin = Math.sin((day * Math.PI) / 3.5);
    const dayCos = Math.cos((day * Math.PI) / 3.5);

    // One-hot encoding for trading session
    const session = f.tradingSession || 'OVERLAP';
    const isAsian = session === 'ASIAN' ? 1 : 0;
    const isLondon = session === 'LONDON' ? 1 : 0;
    const isNY = session === 'NEW_YORK' ? 1 : 0;
    const isOverlap = session === 'OVERLAP' ? 1 : 0;

    return [
      f.rsi || 50, f.macd || 0, f.macdHist || 0, f.maSpread || 0,
      f.primaryConfidence || 0, f.primaryDirection || 0, f.atr || 0,
      f.bollingerBandWidth || 0, f.bidAskSpread || 0, f.orderbookImbalance || 1,
      f.volumeSurgeRatio || 1, f.stationarityFracDiff || 0, f.confluenceCount || 0,
      f.smartTrailingActive || 0, f.smartTrailingDistance || 0,
      f.macroGoalProgress || 0, f.macroTimeElapsedHours || 0, f.macroGoalGrade || 0,
      // ---- NEW HIGH-IMPACT INSTITUTIONAL METRICS ----
      f.vpin || 0.5,                  // Order Flow Toxicity
      f.orderFlowImbalance || 0,      // Resting Liquidity Imbalance (Icebergs)
      f.vwapDistancePct || 0,         // Mean Reversion gravity
      f.fundingRate || 0,             // Squeeze probability (over-leveraged shorts/longs)
      f.cancelToFillRatio || 1,       // Spoofing detection
      hourSin,                        // Temporal Context (Asian vs London vs NY)
      hourCos,                        // Temporal Context
      daySin,                         // Day of the week cyclic encoding
      dayCos,
      isAsian,                        // Asian market session active
      isLondon,                       // London market session active
      isNY,                           // NY market session active
      isOverlap,                      // Overlap session (usually most volatile)
      f.strategyTrailFailRate || 0,
      f.strategyTrailEfficiency || 1
    ];
  }`;

// Apply the extractVector replacement
code = code.replace(targetExtract, newExtract);

// Replace all instances of [5, 28] with [5, 33] and 'const D = 28;' with 'const D = 33;'
code = code.replace(/inputShape: \[5, 28\]/g, 'inputShape: [5, 33]');
code = code.replace(/const D = 28;/g, 'const D = 33;');
code = code.replace(/\[1, 5, 28\]/g, '[1, 5, 33]');

fs.writeFileSync('metaLearningEngine.ts', code, 'utf8');
