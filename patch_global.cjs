const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

const targetMethod = `public getIsTraining() { return this.isTraining; }`;
const newMethod = `public getIsTraining() { return this.isTraining; }
  public getGlobalPrecisionPct() { return this.globalPrecisionPct; }`;
code = code.replace(targetMethod, newMethod);

fs.writeFileSync('metaLearningEngine.ts', code, 'utf8');

let serverCode = fs.readFileSync('server.ts', 'utf8');
const targetServer = `isTraining: metaModelManager.getIsTraining(),`;
const newServer = `isTraining: metaModelManager.getIsTraining(),
    globalPrecisionPct: metaModelManager.getGlobalPrecisionPct(),`;
serverCode = serverCode.replace(targetServer, newServer);
fs.writeFileSync('server.ts', serverCode, 'utf8');
console.log('Patched global precision');
