const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

const targetVector = `      f.cancelToFillRatio || 1,       // Spoofing detection
      hourSin,`;

const newVector = `      f.cancelToFillRatio || 1,       // Spoofing detection
      f.micropriceDrift || 0,         // Microprice drift
      hourSin,`;

code = code.replace(targetVector, newVector);
fs.writeFileSync('metaLearningEngine.ts', code, 'utf8');
