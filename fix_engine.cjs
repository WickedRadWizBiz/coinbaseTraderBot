const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

// 1. Add evaluatePreTradeGate and updateOnlineWeights to SecondaryMetaModel
const modelEndStr = `return {
      nominalKellyPct: parseFloat((nominalKelly * 100).toFixed(2)),
      constrainedRiskPct,
      positionUnits
    };
  }`;
const modelNewStr = `return {
      nominalKellyPct: parseFloat((nominalKelly * 100).toFixed(2)),
      constrainedRiskPct,
      positionUnits
    };
  }
  
  public evaluatePreTradeGate(features: EntryFeatures, marketRegime?: string): { approved: boolean, proba: number, reason: string } {
    const proba = this.predictProba(features);
    let approved = proba >= 0.38;
    let reason = approved ? "Setup approved by meta-model." : \`Model predicts low probability of success (<38%).\`;
    return { approved, proba, reason };
  }

  public updateOnlineWeights(features: EntryFeatures, label: number): void {
     const D = 18;
     if (this.featureMeans.length === 0) return;
     const v = this.extractVector(features);
     const zv = v.map((val, j) => (val - this.featureMeans[j]) / (this.featureStds[j] || 1));
     let seq = [];
     for(let i=0; i<4; i++) seq.push(new Array(D).fill(0));
     seq.push(zv);
     const xTensor = tf.tensor3d([seq], [1, 5, 18]);
     const yTensor = tf.tensor2d([label], [1, 1]);
     this.model.fit(xTensor, yTensor, { epochs: 1, verbose: 0 }).then(() => {
        tf.dispose([xTensor, yTensor]);
     }).catch(() => {
        tf.dispose([xTensor, yTensor]);
     });
  }`;
code = code.replace(modelEndStr, modelNewStr);

// 2. Add properties and methods to MetaModelManager
const managerStartStr = `export class MetaModelManager {
  private static instance: MetaModelManager;`;
const managerNewStartStr = `export class MetaModelManager {
  private static instance: MetaModelManager;
  public globalPrecisionPct: number = 0;
  private trainingQueue: string[] = [];`;
code = code.replace(managerStartStr, managerNewStartStr);

const managerGetTrainingStr = `public getIsTraining(): boolean {
    return this.isTraining;
  }`;
const managerNewGetTrainingStr = `public getIsTraining(): boolean {
    return this.isTraining;
  }
  
  public getGlobalPrecisionPct(): number {
    return this.globalPrecisionPct;
  }

  private processTrainingQueue() {
    if (this.trainingQueue.length > 0 && !this.isTraining) {
      const nextStrategy = this.trainingQueue.shift();
      if (nextStrategy) {
         setTimeout(() => {
            this.runRetrainingPipeline(nextStrategy).catch(console.error);
         }, 500);
      }
    }
  }`;
code = code.replace(managerGetTrainingStr, managerNewGetTrainingStr);


// 3. Update runRetrainingPipeline
const pipelineStartStr = `public async runRetrainingPipeline(strategyKey: string = 'GLOBAL'): Promise<RetrainingReport> {
    if (this.isTraining) {
      if (this.latestReports.has(strategyKey)) return this.latestReports.get(strategyKey)!;
      throw new Error("Retraining pipeline already running in background.");
    }`;
const pipelineNewStartStr = `public async runRetrainingPipeline(strategyKey: string = 'GLOBAL'): Promise<RetrainingReport | void> {
    if (this.isTraining) {
      if (!this.trainingQueue.includes(strategyKey)) {
        this.trainingQueue.push(strategyKey);
      }
      return this.latestReports.get(strategyKey) || undefined;
    }`;
code = code.replace(pipelineStartStr, pipelineNewStartStr);

const pipelineEndStr = `    this.isTraining = false;
    return report;
  }`;
const pipelineNewEndStr = `      let totalAcc = 0;
      let count = 0;
      this.latestReports.forEach(r => {
         if (r.modelAccuracyPct > 0) {
            totalAcc += r.modelAccuracyPct;
            count++;
         }
      });
      if (count > 0) this.globalPrecisionPct = parseFloat((totalAcc / count).toFixed(1));

      this.isTraining = false;
      this.processTrainingQueue();
      return report;
    } catch (err: any) {
      this.isTraining = false;
      this.processTrainingQueue();
      throw err;
    }
  }`;

// Find the last instance of `this.isTraining = false; \n return report; \n }` and replace it
const idx = code.lastIndexOf(`this.isTraining = false;\n    return report;\n  }`);
if (idx !== -1) {
    code = code.substring(0, idx) + pipelineNewEndStr + code.substring(idx + `this.isTraining = false;\n    return report;\n  }`.length);
} else {
    // maybe it has a catch block already? Let's check:
    const idx2 = code.lastIndexOf(`    this.isTraining = false;
    return report;
  }`);
    if(idx2 !== -1) {
       code = code.substring(0, idx2) + pipelineNewEndStr + code.substring(idx2 + `    this.isTraining = false;\n    return report;\n  }`.length);
    }
}

fs.writeFileSync('metaLearningEngine.ts', code, 'utf8');
