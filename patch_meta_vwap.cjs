const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

const targetInterface = `  vwapDistancePct?: number; // Rolling VWAP distance`;

const newInterface = `  vwapDistancePct?: number; // Rolling VWAP distance
  anchoredVwapDistancePct?: number;
  anchoredVwapSlope?: number;
  relativeVolume?: number;`;

code = code.replace(targetInterface, newInterface);

const targetExtract = `      f.bodyRatio || 0, f.upperShadowRatio || 0, f.lowerShadowRatio || 0,
      f.bidAskSpread || 0, f.orderbookImbalance || 1,`;
      
const newExtract = `      f.bodyRatio || 0, f.upperShadowRatio || 0, f.lowerShadowRatio || 0,
      f.anchoredVwapDistancePct || 0, f.anchoredVwapSlope || 0, f.relativeVolume || 1,
      f.bidAskSpread || 0, f.orderbookImbalance || 1,`;

code = code.replace(targetExtract, newExtract);

code = code.replace(/const D = 45;/g, 'const D = 48;');
code = code.replace(/\[5, 45\]/g, '[5, 48]');
code = code.replace(/\[1, 5, 45\]/g, '[1, 5, 48]');
code = code.replace(/\[1,\s*5,\s*45\]/g, '[1, 5, 48]');

fs.writeFileSync('metaLearningEngine.ts', code, 'utf8');
