const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

const targetInterface = `  anchoredVwapDistancePct?: number;`;

const newInterface = `  fvgDistanceAbove?: number;
  fvgDistanceBelow?: number;
  liquiditySweepActive?: number;
  anchoredVwapDistancePct?: number;`;

code = code.replace(targetInterface, newInterface);

const targetExtract = `      f.anchoredVwapDistancePct || 0,`;
      
const newExtract = `      f.fvgDistanceAbove || 0, f.fvgDistanceBelow || 0, f.liquiditySweepActive || 0,
      f.anchoredVwapDistancePct || 0,`;

code = code.replace(targetExtract, newExtract);

const targetExtract2 = `      f.vpin || 0, f.micropriceDrift || 0, f.queuePositionRatio || 0.5, f.cancelToFillRatio || 1,`;

const newExtract2 = `      f.vpin || 0, f.micropriceDrift || 0, f.queuePositionRatio || 0.5, f.cancelToFillRatio || 1,
      f.orderFlowImbalance || 0,`;

code = code.replace(targetExtract2, newExtract2);

code = code.replace(/const D = 52;/g, 'const D = 56;');
code = code.replace(/\[5, 52\]/g, '[5, 56]');
code = code.replace(/\[1, 5, 52\]/g, '[1, 5, 56]');
code = code.replace(/\[1,\s*5,\s*52\]/g, '[1, 5, 56]');

fs.writeFileSync('metaLearningEngine.ts', code, 'utf8');
