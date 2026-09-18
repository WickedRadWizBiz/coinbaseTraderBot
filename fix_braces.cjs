const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const target = `  try {    
    for (const [strategyKey, count] of Object.entries(unTrainedTradeCountByStrategy)) {
       if (count >= 50) {
           unTrainedTradeCountByStrategy[strategyKey] = 0;
           // We don't check !metaModelManager.getIsTraining() here anymore, let the queue handle it.
           spotLogs.unshift({
             id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
             message: \`[AUTOMATED RETRAINING] Sufficient new trade data collected for strategy \${strategyKey} (50+ trades). Queueing Meta-Model Retraining Pipeline...\`
           });
              metaModelManager.runRetrainingPipeline(strategyKey).catch(e => console.error("Retraining err:", e));
           }
       }
    }
    
    if (unTrainedTradeCount >= 50) {
      unTrainedTradeCount = 0;
      spotLogs.unshift({
        id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
        message: \`[AUTOMATED RETRAINING] Sufficient new trade data collected (50+ trades). Queueing Meta-Model Retraining Pipeline...\`
      });
        metaModelManager.runRetrainingPipeline().catch(err => {
          console.error("[BACKGROUND TRAIN ERROR]", err);
        });
      }
    }
  } catch (e) {}
}`;
const replacement = `  try {    
    for (const [strategyKey, count] of Object.entries(unTrainedTradeCountByStrategy)) {
       if (count >= 50) {
           unTrainedTradeCountByStrategy[strategyKey] = 0;
           spotLogs.unshift({
             id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
             message: \`[AUTOMATED RETRAINING] Sufficient new trade data collected for strategy \${strategyKey} (50+ trades). Queueing Meta-Model Retraining Pipeline...\`
           });
           metaModelManager.runRetrainingPipeline(strategyKey).catch(e => console.error("Retraining err:", e));
       }
    }
    
    if (unTrainedTradeCount >= 50) {
      unTrainedTradeCount = 0;
      spotLogs.unshift({
        id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
        message: \`[AUTOMATED RETRAINING] Sufficient new trade data collected (50+ trades). Queueing Meta-Model Retraining Pipeline...\`
      });
      metaModelManager.runRetrainingPipeline().catch(err => {
        console.error("[BACKGROUND TRAIN ERROR]", err);
      });
    }
  } catch (e) {}
}`;

// Use index based replace to avoid regex issues
const startIndex = code.indexOf(`  // Job 5: Automated Retraining Pipeline (Every 50 completed trades)
  try {`);

const endIndex = code.indexOf(`const scalper = new RapidScalper();`);
if (startIndex > -1 && endIndex > -1) {
    const chunk = code.substring(startIndex, endIndex);
    const newChunk = `  // Job 5: Automated Retraining Pipeline (Every 50 completed trades)
  try {    
    for (const [strategyKey, count] of Object.entries(unTrainedTradeCountByStrategy)) {
       if (count >= 50) {
           unTrainedTradeCountByStrategy[strategyKey] = 0;
           spotLogs.unshift({
             id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
             message: \`[AUTOMATED RETRAINING] Sufficient new trade data collected for strategy \${strategyKey} (50+ trades). Queueing Meta-Model Retraining Pipeline...\`
           });
           metaModelManager.runRetrainingPipeline(strategyKey).catch(e => console.error("Retraining err:", e));
       }
    }
    
    if (unTrainedTradeCount >= 50) {
      unTrainedTradeCount = 0;
      spotLogs.unshift({
        id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
        message: \`[AUTOMATED RETRAINING] Sufficient new trade data collected (50+ trades). Queueing Meta-Model Retraining Pipeline...\`
      });
      metaModelManager.runRetrainingPipeline().catch(err => {
        console.error("[BACKGROUND TRAIN ERROR]", err);
      });
    }
  } catch (e) {}
}
\n`;
    code = code.substring(0, startIndex) + newChunk + code.substring(endIndex);
    fs.writeFileSync('server.ts', code, 'utf8');
}
