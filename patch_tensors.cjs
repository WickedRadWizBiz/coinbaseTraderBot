const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

const targetVector = `private extractVector(f: EntryFeatures): number[] {
    return [
      f.rsi || 50, f.macd || 0, f.macdHist || 0, f.maSpread || 0,
      f.primaryConfidence || 0, f.primaryDirection || 0, f.atr || 0,
      f.bollingerBandWidth || 0, f.bidAskSpread || 0, f.orderbookImbalance || 1,
      f.volumeSurgeRatio || 1, f.stationarityFracDiff || 0, f.confluenceCount || 0,
      f.smartTrailingActive || 0, f.smartTrailingDistance || 0,
      f.macroGoalProgress || 0, f.macroTimeElapsedHours || 0, f.macroGoalGrade || 0
    ];
  }`;

const newVector = `private extractVector(f: EntryFeatures): number[] {
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
      (f.dayOfWeek === 0 || f.dayOfWeek === 6) ? 1 : 0 // Weekend illiquidity flag
    ];
  }`;
  
code = code.replace(targetVector, newVector);
code = code.replace(/const D = 18;/g, "const D = 26;");
code = code.replace(/\[1, 5, 18\]/g, "[1, 5, 26]");

fs.writeFileSync('metaLearningEngine.ts', code, 'utf8');
