const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

const targetCall = `      const candidateModel = new SecondaryMetaModel();
      const trainResult = await candidateModel.train(bootstrappedDataset, labels, {`;

const newCall = `      const candidateModel = new SecondaryMetaModel();
      // Ensure we extract features from the bootstrapped dataset to compute feature means & stds
      const featureMatrix = bootstrappedDataset.map(t => {
          return candidateModel['extractVector'](t.entry_features || {}); // force extraction
      });
      // We pass the actual feature extraction logic to train
      const trainResult = await candidateModel.train(bootstrappedDataset, labels, {`;

code = code.replace(targetCall, newCall);
fs.writeFileSync('metaLearningEngine.ts', code, 'utf8');
