const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

const targetStr = "const fHist = this.reportHistories.get(strategyKey) || []; fHist.unshift(failedReport); this.reportHistories.set(strategyKey, fHist);\n      if (hist.length > 50) this.reportHistories.set(strategyKey, hist.slice(0, 50));";
const replacementStr = "const fHist = this.reportHistories.get(strategyKey) || []; fHist.unshift(failedReport); this.reportHistories.set(strategyKey, fHist);\n      if (fHist.length > 50) this.reportHistories.set(strategyKey, fHist.slice(0, 50));";
code = code.replace(targetStr, replacementStr);

fs.writeFileSync('metaLearningEngine.ts', code, 'utf8');
