const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

code = code.replace(/const D = 26;/g, "const D = 28;");
code = code.replace(/const D = 18;/g, "const D = 28;");

fs.writeFileSync('metaLearningEngine.ts', code, 'utf8');
