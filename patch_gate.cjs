const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

const targetGate = `  public evaluatePreTradeGate(features: EntryFeatures, marketRegime?: string): { approved: boolean, proba: number, reason: string } {
    const proba = this.predictProba(features);
    let approved = proba >= 0.38;
    let reason = approved ? "Setup approved by meta-model." : \`Model predicts low probability of success (<38%).\`;
    return { approved, proba, reason };
  }`;

const newGate = `  public evaluatePreTradeGate(features: EntryFeatures, marketRegime?: string): { approved: boolean, proba: number, kellyScaler: number, reason: string } {
    const proba = this.predictProba(features);
    let approved = proba >= 0.38;
    let reason = approved ? "Setup approved by meta-model." : \`Model predicts low probability of success (<38%).\`;
    let kellyScaler = 1.0;
    if (proba >= 0.60) kellyScaler = 1.5;
    else if (proba >= 0.50) kellyScaler = 1.25;
    else if (proba < 0.45) kellyScaler = 0.75;
    return { approved, proba, kellyScaler, reason };
  }`;

code = code.replace(targetGate, newGate);
fs.writeFileSync('metaLearningEngine.ts', code, 'utf8');
