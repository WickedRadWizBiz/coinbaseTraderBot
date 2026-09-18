const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

const regex = /\/\/ Intelligent domain priors[\s\S]*?this\.weights\[idx\] = priors\[key\] \|\| 0\.10;\n    \}\);/g;
code = code.replace(regex, "");

fs.writeFileSync('metaLearningEngine.ts', code, 'utf8');
console.log("Fixed init");
