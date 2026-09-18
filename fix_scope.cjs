const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

code = code.replace(/    const patternType = pos\.analysisMeta\?\.patternType \|\| 'GENERAL_ANALYSIS';\n    unTrainedTradeCountByStrategy\[patternType\] = \(unTrainedTradeCountByStrategy\[patternType\] \|\| 0\) \+ 1;/g, "    unTrainedTradeCountByStrategy[patternType] = (unTrainedTradeCountByStrategy[patternType] || 0) + 1;");

fs.writeFileSync('server.ts', code, 'utf8');
console.log('Fixed scope redeclaration');
