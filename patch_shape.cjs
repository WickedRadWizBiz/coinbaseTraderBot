const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

code = code.replace(/\[1,\s*5,\s*33\]/g, '[1, 5, 36]');

fs.writeFileSync('metaLearningEngine.ts', code, 'utf8');
