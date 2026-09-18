const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

const targetInterface = `export interface EntryFeatures {
  smartTrailingActive?: number;`;

const newInterface = `export interface EntryFeatures {
  percentB?: number; // Spatial location in bands (0.0 to 1.0)
  bandWidth?: number; // Volatility compression measurement
  hurstExponent?: number; // 0 to 1 (trend vs mean-reversion classification)
  bbkcSqueezeActive?: number; // 1 if BB are inside Keltner Channels, else 0
  smartTrailingActive?: number;`;

code = code.replace(targetInterface, newInterface);

const targetExtract = `      f.bollingerBandWidth || 0, f.bidAskSpread || 0, f.orderbookImbalance || 1,`;
const newExtract = `      f.percentB || 0.5, f.bandWidth || 0, f.hurstExponent || 0.5, f.bbkcSqueezeActive || 0,
      f.bidAskSpread || 0, f.orderbookImbalance || 1,`;

code = code.replace(targetExtract, newExtract);

// Replace D = 33 with D = 36 to account for the 3 new features (percentB, hurst, bbkc, we replaced bollingerBandWidth with bandWidth)
code = code.replace(/const D = 33;/g, 'const D = 36;');
code = code.replace(/\[5, 33\]/g, '[5, 36]');

fs.writeFileSync('metaLearningEngine.ts', code, 'utf8');
