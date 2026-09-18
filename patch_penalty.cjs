const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

code = code.replace(/const currentBlowoutCount = this\.currentModelBlowouts;/g, "const currentBlowoutCount = this.currentModelBlowouts.get(strategyKey) || 0;");
code = code.replace(/this\.atomicHotSwap\(candidateModel\);/g, "this.atomicHotSwap(candidateModel, strategyKey);");
code = code.replace(/this\.currentModelBlowouts = 0;/g, "this.currentModelBlowouts.set(strategyKey, 0);");

fs.writeFileSync('metaLearningEngine.ts', code, 'utf8');
console.log('Updated blowout penalty variables');
