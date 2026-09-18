const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

const targetInterface = `  bbkcSqueezeActive?: number; // 1 if BB are inside Keltner Channels, else 0
  smartTrailingActive?: number;`;

const newInterface = `  bbkcSqueezeActive?: number; // 1 if BB are inside Keltner Channels, else 0
  priceToTenkan?: number;
  priceToKijun?: number;
  tenkanKijunSpread?: number;
  cloudDistanceA?: number;
  cloudDistanceB?: number;
  ichimokuThickDist?: number;
  bodyRatio?: number;
  upperShadowRatio?: number;
  lowerShadowRatio?: number;
  smartTrailingActive?: number;`;

code = code.replace(targetInterface, newInterface);

const targetExtract = `      f.percentB || 0.5, f.bandWidth || 0, f.hurstExponent || 0.5, f.bbkcSqueezeActive || 0,
      f.bidAskSpread || 0, f.orderbookImbalance || 1,`;
      
const newExtract = `      f.percentB || 0.5, f.bandWidth || 0, f.hurstExponent || 0.5, f.bbkcSqueezeActive || 0,
      f.priceToTenkan || 0, f.priceToKijun || 0, f.tenkanKijunSpread || 0,
      f.cloudDistanceA || 0, f.cloudDistanceB || 0, f.ichimokuThickDist || 0,
      f.bodyRatio || 0, f.upperShadowRatio || 0, f.lowerShadowRatio || 0,
      f.bidAskSpread || 0, f.orderbookImbalance || 1,`;

code = code.replace(targetExtract, newExtract);

code = code.replace(/const D = 36;/g, 'const D = 45;');
code = code.replace(/\[5, 36\]/g, '[5, 45]');
code = code.replace(/\[1, 5, 36\]/g, '[1, 5, 45]');
code = code.replace(/\[1,\s*5,\s*36\]/g, '[1, 5, 45]');

fs.writeFileSync('metaLearningEngine.ts', code, 'utf8');
