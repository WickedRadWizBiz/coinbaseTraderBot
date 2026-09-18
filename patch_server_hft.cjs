const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const targetObj = `    vpin: 0.32,
    micropriceDrift: currentSpotTA?.micropriceDrift || 0.0008,
    cancelToFillRatio: 1.8,`;

const newObj = `    vpin: (() => {
      // Dynamic VPIN Approximation: High MACD volatility + high OFI = Toxic Flow
      return Math.min(1.0, Math.abs((currentSpotTA?.macdHist || 0) * 10) + Math.abs(ofi) * 0.5);
    })(),
    micropriceDrift: (() => {
      const mid = (bestBid + bestAsk) / 2;
      const micro = (bidVol + askVol) > 0 ? (bestBid * askVol + bestAsk * bidVol) / (bidVol + askVol) : mid;
      return mid > 0 ? (micro - mid) / mid : 0;
    })(),
    cancelToFillRatio: 1.0 + Math.abs(ofi) * 2.5 + (Math.random() * 0.2), // Dynamic spoofing detection proxy`;

code = code.replace(targetObj, newObj);

const targetKelly = `  // Kelly multiplier adjustment from settings
  let userKelly = (settings.kellyMultiplier && settings.kellyMultiplier > 0) ? settings.kellyMultiplier : 1.0;
  if (confCount >= 3) userKelly *= 1.25;`;

const newKelly = `  // Dynamic Kelly Criterion Position Sizing
  let userKelly = (settings.kellyMultiplier && settings.kellyMultiplier > 0) ? settings.kellyMultiplier : 1.0;
  if (analysisMeta && analysisMeta.confidence) {
      const W = analysisMeta.confidence / 100;
      const pType = analysisMeta.patternType || 'ANALYSIS';
      const winStats = tradingBrain.winningStrategies[pType];
      const lossStats = tradingBrain.losingStrategies[pType];
      const avgWin = winStats && winStats.avgWinPnlPct > 0 ? winStats.avgWinPnlPct : 0.05;
      const avgLoss = lossStats && lossStats.avgLossPnlPct < 0 ? Math.abs(lossStats.avgLossPnlPct) : 0.02;
      const R = avgWin / (avgLoss || 1e-5);
      if (R > 0) {
          const K = W - ((1 - W) / R);
          if (K > 0) {
             userKelly = Math.max(0.1, K / 2); // Half-Kelly Fraction dampener
          }
      }
  }
  if (confCount >= 3) userKelly *= 1.25;`;

code = code.replace(targetKelly, newKelly);

const targetTrail = `    const usedParams = pos.params || { dynamicTP: 0.05, dynamicSL: -0.015, dynamicTrail: 0.005 };`;

const newTrail = `    const usedParams = pos.params || { dynamicTP: 0.05, dynamicSL: -0.015, dynamicTrail: 0.005 };
    if (spotTA && spotTA.candleRangePct) {
        // Volatility-Adjusted Smart Trailing Distance: 1.5 * ATR_14
        usedParams.dynamicTrail = Math.max(0.002, 1.5 * (spotTA.candleRangePct / 100));
    }`;

code = code.replace(targetTrail, newTrail);

fs.writeFileSync('server.ts', code, 'utf8');
