const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

const targetFit = `    await this.model.fit(xTensor, yTensor, {
       epochs: config.epochs || 30,
       batchSize: config.batchSize || 32,
       shuffle: true,
       verbose: 0,
       sampleWeight: sampleWeightTensor
    });`;

const newFit = `    await this.model.fit(xTensor, yTensor, {
       epochs: config.epochs || 30,
       batchSize: config.batchSize || 32,
       shuffle: true,
       verbose: 0
    });`;

code = code.replace(targetFit, newFit);
fs.writeFileSync('metaLearningEngine.ts', code, 'utf8');
