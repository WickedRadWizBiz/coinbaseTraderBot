const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

if (!code.includes("import * as tf from '@tensorflow/tfjs-node';")) {
    code = code.replace("import { unifiedDataHandler } from './unifiedDataHandler';", "import { unifiedDataHandler } from './unifiedDataHandler';\nimport * as tf from '@tensorflow/tfjs-node';");
}

const targetTrain = `const trainResult = candidateModel.train(bootstrappedDataset, labels, {`;
const replaceTrain = `const trainResult = await candidateModel.train(bootstrappedDataset, labels, {`;

code = code.replace(targetTrain, replaceTrain);

const classStart = code.indexOf("export class SecondaryMetaModel {");
const classEndStr = `    return {
      nominalKellyPct: parseFloat((nominalKelly * 100).toFixed(2)),
      constrainedRiskPct,
      positionUnits
    };
  }
}`;
const classEnd = code.indexOf(classEndStr, classStart) + classEndStr.length;

if (classStart !== -1 && classEnd !== -1 && classEnd > classStart) {
  const newClass = `export class SecondaryMetaModel {
  private model: tf.Sequential;
  private featureMeans: number[] = [];
  private featureStds: number[] = [];
  public indicatorEfficacies: any[] = [];
  
  constructor() {
    this.model = tf.sequential();
    
    // 1. Sequential Memory (LSTMs) - 5 time steps (historical window)
    this.model.add(tf.layers.lstm({
      units: 16,
      inputShape: [5, 13], 
      returnSequences: true
    }));
    
    // 2. Self-Attention (Transformers) - Emulated via Dense layers on temporal sequences
    this.model.add(tf.layers.dense({ units: 16, activation: 'relu' }));
    
    // Aggregate over the temporal dimension
    this.model.add(tf.layers.globalAveragePooling1d({}));
    
    // 3. Hidden Layers & Non-Linearity (MLP)
    this.model.add(tf.layers.dense({ 
      units: 16, 
      activation: 'relu', 
      kernelRegularizer: tf.regularizers.l2({ l2: 0.01 }) 
    }));
    
    this.model.add(tf.layers.dense({ units: 1, activation: 'sigmoid' }));
    
    this.model.compile({
      optimizer: tf.train.adam(0.005),
      loss: 'binaryCrossentropy',
      metrics: ['accuracy']
    });
  }

  private extractVector(f: EntryFeatures): number[] {
    return [
      f.rsi || 50, f.macd || 0, f.macdHist || 0, f.maSpread || 0,
      f.primaryConfidence || 0, f.primaryDirection || 0, f.atr || 0,
      f.bollingerBandWidth || 0, f.bidAskSpread || 0, f.orderbookImbalance || 1,
      f.volumeSurgeRatio || 1, f.stationarityFracDiff || 0, f.confluenceCount || 0
    ];
  }

  public predictProba(f: EntryFeatures, previousFeatures: EntryFeatures[] = []): number {
    const D = 13;
    if (this.featureMeans.length === 0) return 0.5; // Untrained fallback
    
    const v = this.extractVector(f);
    const zv = v.map((val, j) => (val - this.featureMeans[j]) / this.featureStds[j]);
    
    let seq = [];
    for (let i = 0; i < 4; i++) {
       if (previousFeatures && previousFeatures.length > i) {
           const pv = this.extractVector(previousFeatures[previousFeatures.length - 1 - i]);
           seq.push(pv.map((val, j) => (val - this.featureMeans[j]) / this.featureStds[j]));
       } else {
           seq.push(new Array(D).fill(0));
       }
    }
    seq.reverse();
    seq.push(zv);

    const tensor = tf.tensor3d([seq], [1, 5, 13]);
    const pred = this.model.predict(tensor) as tf.Tensor;
    const prob = pred.dataSync()[0];
    tf.dispose([tensor, pred]);
    return prob;
  }

  public async train(trades: any[], labels: number[], config: any): Promise<any> {
    const N = trades.length;
    const D = 13;
    const TIME_STEPS = 5;
    
    if (N < TIME_STEPS) return { accuracyPct: 50, initialLoss: 0.69, finalLoss: 0.69, convergenceRate: 0 };
    
    const X = trades.map(t => this.extractVector(t.entry_features));
    
    this.featureMeans = new Array(D).fill(0);
    this.featureStds = new Array(D).fill(1);
    for (let j = 0; j < D; j++) {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += X[i][j];
      const mean = sum / N;
      let sqDiffSum = 0;
      for (let i = 0; i < N; i++) sqDiffSum += Math.pow(X[i][j] - mean, 2);
      const std = Math.sqrt(sqDiffSum / Math.max(1, N - 1)) || 1.0;
      this.featureMeans[j] = mean;
      this.featureStds[j] = std;
    }

    const Z = X.map(row => row.map((val, j) => (val - this.featureMeans[j]) / this.featureStds[j]));
    
    const seqX = [];
    const seqY = [];
    const sampleWeights = [];
    
    // 4. Exponential Time-Decay Weighting
    const decayFactor = 0.995; 

    for (let i = TIME_STEPS - 1; i < N; i++) {
      const window = Z.slice(i - TIME_STEPS + 1, i + 1);
      seqX.push(window);
      seqY.push(labels[i]);
      const timeDecayWeight = Math.pow(decayFactor, (N - 1) - i); 
      sampleWeights.push(timeDecayWeight);
    }

    const xTensor = tf.tensor3d(seqX, [seqX.length, TIME_STEPS, D]);
    const yTensor = tf.tensor2d(seqY, [seqY.length, 1]);
    
    // We inject the time-decay weight into the loss via sampleWeight tensor
    const sampleWeightTensor = tf.tensor1d(sampleWeights);

    const initialEval = this.model.evaluate(xTensor, yTensor) as tf.Scalar[];
    const initialLoss = initialEval[0] ? initialEval[0].dataSync()[0] : 0.69;

    await this.model.fit(xTensor, yTensor, {
       epochs: config.epochs || 30,
       batchSize: config.batchSize || 32,
       shuffle: true,
       verbose: 0,
       sampleWeight: sampleWeightTensor
    });

    const finalEval = this.model.evaluate(xTensor, yTensor) as tf.Scalar[];
    const finalLoss = finalEval[0] ? finalEval[0].dataSync()[0] : 0.69;
    const accuracy = finalEval[1] ? finalEval[1].dataSync()[0] : 0.5;

    tf.dispose([xTensor, yTensor, sampleWeightTensor]);
    
    this.indicatorEfficacies = [{
      indicatorName: "LSTM_ATTENTION_META",
      category: "PATTERN",
      totalSignals: N,
      truePositives: Math.floor(N * accuracy),
      falsePositives: N - Math.floor(N * accuracy),
      precision: parseFloat(accuracy.toFixed(2)),
      discriminatingPowerScore: Math.round(accuracy * 100),
      recommendation: accuracy > 0.55 ? "STRONG_BOOST" : "NEUTRAL_KEEP"
    }];

    return {
      accuracyPct: parseFloat((accuracy * 100).toFixed(1)),
      initialLoss: parseFloat(initialLoss.toFixed(4)),
      finalLoss: parseFloat(finalLoss.toFixed(4)),
      convergenceRate: parseFloat((((initialLoss - finalLoss) / Math.max(0.001, initialLoss)) * 100).toFixed(1))
    };
  }

  public calculateRiskConstrainedKelly(p: number, payoffRatio = 1.8, maxAccountRiskCap = 0.02) {
    if (p < 0.50) return { nominalKellyPct: 0, constrainedRiskPct: 0, positionUnits: 0 };
    const b = Math.max(0.5, payoffRatio);
    const nominalKelly = (p * (b + 1) - 1) / b;
    const halfKelly = Math.max(0, nominalKelly * 0.50);
    const sigmoidMultiplier = 1 / (1 + Math.exp(-4 * (halfKelly - 0.25)));
    const constrainedRiskPct = parseFloat((maxAccountRiskCap * sigmoidMultiplier * 100).toFixed(2));
    const positionUnits = Math.round(50 * (1 + halfKelly * 2));
    return {
      nominalKellyPct: parseFloat((nominalKelly * 100).toFixed(2)),
      constrainedRiskPct,
      positionUnits
    };
  }
}`;
  code = code.substring(0, classStart) + newClass + code.substring(classEnd);
  fs.writeFileSync('metaLearningEngine.ts', code, 'utf8');
  console.log("Successfully replaced SecondaryMetaModel with TFJS");
} else {
  console.log("Could not find class bounds");
  console.log("classStart:", classStart, "classEnd:", classEnd);
}
