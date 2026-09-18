const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

const targetInterface = `  relativeVolume?: number;`;

const newInterface = `  relativeVolume?: number;
  macdRatio?: number; // Normalized MACD r_{MACD}
  forceIndex?: number; // Normalized Force Index
  obvRoc?: number; // Rate of Change of On-Balance Volume
  tnRsi?: number; // Trend-Normalized RSI`;

code = code.replace(targetInterface, newInterface);

const targetExtract = `      f.anchoredVwapDistancePct || 0, f.anchoredVwapSlope || 0, f.relativeVolume || 1,`;
      
const newExtract = `      f.anchoredVwapDistancePct || 0, f.anchoredVwapSlope || 0, f.relativeVolume || 1,
      f.macdRatio || 0, f.forceIndex || 0, f.obvRoc || 0, f.tnRsi || 50,`;

code = code.replace(targetExtract, newExtract);

code = code.replace(/const D = 48;/g, 'const D = 52;');
code = code.replace(/\[5, 48\]/g, '[5, 52]');
code = code.replace(/\[1, 5, 48\]/g, '[1, 5, 52]');
code = code.replace(/\[1,\s*5,\s*48\]/g, '[1, 5, 52]');

fs.writeFileSync('metaLearningEngine.ts', code, 'utf8');
