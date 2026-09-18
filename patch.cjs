const fs = require('fs');

function patchFile(filename) {
  let content = fs.readFileSync(filename, 'utf-8');
  content = content.replace(/if \(errMsg\.includes\('429'\)[^{]+{/g, 
    "if (errMsg.includes('429') || errMsg.toLowerCase().includes('resource_exhausted') || errMsg.toLowerCase().includes('quota') || errMsg.toLowerCase().includes('rate limit') || errMsg.includes('503') || errMsg.toLowerCase().includes('unavailable') || errMsg.toLowerCase().includes('high demand')) {");
  fs.writeFileSync(filename, content);
}

patchFile('geminiStrategyEngine.ts');
patchFile('server.ts');
