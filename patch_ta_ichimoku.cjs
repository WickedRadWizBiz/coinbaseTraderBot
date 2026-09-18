const fs = require('fs');
let code = fs.readFileSync('spotTAEngine.ts', 'utf8');

const targetCalc = `  // 2. Calculate Ichimoku Cloud Indicators
  // Tenkan-sen (9 period)
  const hl9 = getPeriodHighLow(9);
  const tenkanSen = Number(((hl9.high + hl9.low) / 2).toFixed(2));

  // Kijun-sen (26 period)
  const hl26 = getPeriodHighLow(26);
  const kijunSen = Number(((hl26.high + hl26.low) / 2).toFixed(2));

  // Senkou Span A
  const senkouSpanA = Number(((tenkanSen + kijunSen) / 2).toFixed(2));

  // Senkou Span B (52 period or max available)
  const hl52 = getPeriodHighLow(52);
  const senkouSpanB = Number(((hl52.high + hl52.low) / 2).toFixed(2));`;

const newCalc = `  // 2. Calculate Ichimoku Cloud Indicators
  // Tenkan-sen (9 period)
  const hl9 = getPeriodHighLow(9);
  const tenkanSen = Number(((hl9.high + hl9.low) / 2).toFixed(2));

  // Kijun-sen (26 period)
  const hl26 = getPeriodHighLow(26);
  const kijunSen = Number(((hl26.high + hl26.low) / 2).toFixed(2));

  // Senkou Span A
  const senkouSpanA = Number(((tenkanSen + kijunSen) / 2).toFixed(2));

  // Senkou Span B (52 period or max available)
  const hl52 = getPeriodHighLow(52);
  const senkouSpanB = Number(((hl52.high + hl52.low) / 2).toFixed(2));

  // Past Cloud Boundaries (Shifted 26 periods back) to find the cloud matching current price
  let senkouA_t26 = senkouSpanA;
  let senkouB_t26 = senkouSpanB;
  if (candles.length > 78) {
    const pastIdx = candles.length - 26;
    
    // Compute Tenkan-sen 26 periods ago
    const slice9 = candles.slice(pastIdx - 9, pastIdx);
    const hl9_past = { high: Math.max(...slice9.map(c=>c.high)), low: Math.min(...slice9.map(c=>c.low)) };
    const tenkan_past = (hl9_past.high + hl9_past.low) / 2;
    
    // Compute Kijun-sen 26 periods ago
    const slice26 = candles.slice(pastIdx - 26, pastIdx);
    const hl26_past = { high: Math.max(...slice26.map(c=>c.high)), low: Math.min(...slice26.map(c=>c.low)) };
    const kijun_past = (hl26_past.high + hl26_past.low) / 2;
    
    senkouA_t26 = (tenkan_past + kijun_past) / 2;
    
    // Compute Senkou B 26 periods ago (needs 52 periods back from pastIdx)
    const slice52 = candles.slice(pastIdx - 52, pastIdx);
    const hl52_past = { high: Math.max(...slice52.map(c=>c.high)), low: Math.min(...slice52.map(c=>c.low)) };
    senkouB_t26 = (hl52_past.high + hl52_past.low) / 2;
  }

  const priceToTenkan = tenkanSen !== 0 ? (price - tenkanSen) / tenkanSen : 0;
  const priceToKijun = kijunSen !== 0 ? (price - kijunSen) / kijunSen : 0;
  const tenkanKijunSpread = kijunSen !== 0 ? (tenkanSen - kijunSen) / kijunSen : 0;
  const cloudDistanceA = senkouA_t26 !== 0 ? (price - senkouA_t26) / senkouA_t26 : 0;
  const cloudDistanceB = senkouB_t26 !== 0 ? (price - senkouB_t26) / senkouB_t26 : 0;
  const ichimokuThickDist = senkouB_t26 !== 0 ? Math.abs(senkouA_t26 - senkouB_t26) / senkouB_t26 : 0;`;

code = code.replace(targetCalc, newCalc);

fs.writeFileSync('spotTAEngine.ts', code, 'utf8');
