const fs = require('fs');
let content = fs.readFileSync('geminiStrategyEngine.ts', 'utf-8');
content = content.replace(/if \(errStr\.includes\('429'\)[^{]+{/g, 
  "if (errStr.includes('429') || errStr.toLowerCase().includes('resource_exhausted') || errStr.toLowerCase().includes('quota') || errStr.toLowerCase().includes('rate limit')) {");
fs.writeFileSync('geminiStrategyEngine.ts', content);
