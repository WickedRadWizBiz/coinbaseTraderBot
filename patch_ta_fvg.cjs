const fs = require('fs');
let code = fs.readFileSync('spotTAEngine.ts', 'utf8');

const targetInterface = `  anchoredVwapSlope?: number; // AVWAP 10-period rate of change
  relativeVolume?: number; // RVOL`;

const newInterface = `  anchoredVwapSlope?: number; // AVWAP 10-period rate of change
  relativeVolume?: number; // RVOL
  fvgDistanceAbove?: number; // Distance to nearest unmitigated bearish FVG
  fvgDistanceBelow?: number; // Distance to nearest unmitigated bullish FVG
  liquiditySweepActive?: number; // 1 for Bullish Sweep, -1 for Bearish Sweep, 0 None`;

code = code.replace(targetInterface, newInterface);

const targetReturn1 = `      anchoredVwapSlope: 0,
      relativeVolume: 1,`;

const newReturn1 = `      anchoredVwapSlope: 0,
      relativeVolume: 1,
      fvgDistanceAbove: 0,
      fvgDistanceBelow: 0,
      liquiditySweepActive: 0,`;

code = code.replace(targetReturn1, newReturn1);

const insertAfterAdv = `    const tnRs = avgTnGain / (avgTnLoss || 1e-10);
        tnRsi = Number((100 - (100 / (1 + tnRs))).toFixed(1));
    }
  }`;

const newGeom = `    const tnRs = avgTnGain / (avgTnLoss || 1e-10);
        tnRsi = Number((100 - (100 / (1 + tnRs))).toFixed(1));
    }
  }

  // 9. Advanced Geometric Chart Patterns: Fair Value Gaps (FVG) and Liquidity Sweeps
  let fvgDistanceAbove = 0;
  let fvgDistanceBelow = 0;
  let liquiditySweepActive = 0;

  if (candles.length > 50) {
      let fvgAbove = Infinity;
      let fvgBelow = -Infinity;

      // Scan backwards for Unmitigated FVGs
      for (let i = candles.length - 3; i >= Math.max(0, candles.length - 50); i--) {
          // Check Bearish FVG (Resistance above): c1.low > c3.high
          if (candles[i].low > candles[i+2].high) {
              let mitigated = false;
              for (let j = i + 3; j < candles.length; j++) {
                  if (candles[j].high >= candles[i].low) { mitigated = true; break; }
              }
              if (!mitigated) {
                  fvgAbove = Math.min(fvgAbove, candles[i].low);
              }
          }
          // Check Bullish FVG (Support below): c1.high < c3.low
          if (candles[i].high < candles[i+2].low) {
              let mitigated = false;
              for (let j = i + 3; j < candles.length; j++) {
                  if (candles[j].low <= candles[i].high) { mitigated = true; break; }
              }
              if (!mitigated) {
                  fvgBelow = Math.max(fvgBelow, candles[i].high);
              }
          }
      }

      fvgDistanceAbove = fvgAbove !== Infinity ? Number(((fvgAbove - price) / price).toFixed(4)) : 0;
      fvgDistanceBelow = fvgBelow !== -Infinity ? Number(((price - fvgBelow) / price).toFixed(4)) : 0;

      // Liquidity Sweeps (Stop Hunts)
      const lookback = candles.slice(-21, -1);
      const highestHigh = Math.max(...lookback.map(c => c.high));
      const lowestLow = Math.min(...lookback.map(c => c.low));
      
      const wickThresh = 0.5;
      const cRange = latest.high - latest.low;

      if (cRange > 0) {
          // Bearish Sweep (Upthrust)
          if (latest.high > highestHigh && latest.close < highestHigh) {
              const upperWick = latest.high - Math.max(latest.open, latest.close);
              if (upperWick / cRange > wickThresh) {
                  liquiditySweepActive = -1;
              }
          }
          // Bullish Sweep (Spring)
          if (latest.low < lowestLow && latest.close > lowestLow) {
              const lowerWick = Math.min(latest.open, latest.close) - latest.low;
              if (lowerWick / cRange > wickThresh) {
                  liquiditySweepActive = 1;
              }
          }
      }
  }`;

code = code.replace(insertAfterAdv, newGeom);

const targetRet2 = `    anchoredVwapSlope,
    relativeVolume,`;

const newRet2 = `    anchoredVwapSlope,
    relativeVolume,
    fvgDistanceAbove,
    fvgDistanceBelow,
    liquiditySweepActive,`;

code = code.replace(targetRet2, newRet2);

const targetConf1 = `    // Tripartite Confluence (RSI, MACD Flip, Anchored VWAP)`;

const newConf1 = `    // Wyckoff Spring (Liquidity Sweep + FVG Support)
    if (spotTA.liquiditySweepActive === 1 && spotTA.fvgDistanceBelow !== undefined && spotTA.fvgDistanceBelow > 0 && spotTA.fvgDistanceBelow < 0.02) {
        activeTools.push(\`Wyckoff Spring Liquidity Sweep (Bounced off FVG support + Cancel/Fill anomaly)\`);
    }

    // Tripartite Confluence (RSI, MACD Flip, Anchored VWAP)`;

code = code.replace(targetConf1, newConf1);

const targetConf2 = `    // Systemic Momentum Cascade (Session Logic + BB < 0 + VWAP)`;

const newConf2 = `    // Wyckoff Upthrust (Liquidity Sweep + FVG Resistance)
    if (spotTA.liquiditySweepActive === -1 && spotTA.fvgDistanceAbove !== undefined && spotTA.fvgDistanceAbove > 0 && spotTA.fvgDistanceAbove < 0.02) {
        activeTools.push(\`Wyckoff Upthrust Liquidity Sweep (Rejected off FVG resistance + Cancel/Fill anomaly)\`);
    }

    // Systemic Momentum Cascade (Session Logic + BB < 0 + VWAP)`;

code = code.replace(targetConf2, newConf2);


fs.writeFileSync('spotTAEngine.ts', code, 'utf8');
