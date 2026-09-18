const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

const targetVector = `      (f.dayOfWeek === 0 || f.dayOfWeek === 6) ? 1 : 0 // Weekend illiquidity flag
    ];`;

const newVector = `      (f.dayOfWeek === 0 || f.dayOfWeek === 6) ? 1 : 0, // Weekend illiquidity flag
      f.strategyTrailFailRate || 0,
      f.strategyTrailEfficiency || 1
    ];`;
    
code = code.replace(targetVector, newVector);
fs.writeFileSync('metaLearningEngine.ts', code, 'utf8');
