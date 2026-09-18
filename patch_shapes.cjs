const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

code = code.replace(/inputShape: \[5, 18\],/g, "inputShape: [5, 28],");
code = code.replace(/\[1, 5, 26\]/g, "[1, 5, 28]");
code = code.replace(/\[1, 5, 18\]/g, "[1, 5, 28]");

fs.writeFileSync('metaLearningEngine.ts', code, 'utf8');
