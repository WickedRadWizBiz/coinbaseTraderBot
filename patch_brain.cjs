const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const constructorTarget = `  geminiAmendments: GeminiStrategyAmendment[];
  topTierAlphaSignatures: any[];

  constructor(memoryFile = 'bot_memory.json') {`;
const constructorNew = `  geminiAmendments: GeminiStrategyAmendment[];
  topTierAlphaSignatures: any[];
  smartTrailingStats: { [pattern: string]: { totalActivations: number, failures: number, totalEfficiencySum: number } };

  constructor(memoryFile = 'bot_memory.json') {`;
code = code.replace(constructorTarget, constructorNew);

const initTarget = `this.geminiAmendments = [];
    this.topTierAlphaSignatures = [];
    this._loadMemory();`;
const initNew = `this.geminiAmendments = [];
    this.topTierAlphaSignatures = [];
    this.smartTrailingStats = {};
    this._loadMemory();`;
code = code.replace(initTarget, initNew);

const loadTarget = `      this.geminiAmendments = parsed.geminiAmendments || [];
      this.topTierAlphaSignatures = parsed.topTierAlphaSignatures || [];`;
const loadNew = `      this.geminiAmendments = parsed.geminiAmendments || [];
      this.topTierAlphaSignatures = parsed.topTierAlphaSignatures || [];
      this.smartTrailingStats = parsed.smartTrailingStats || {};`;
code = code.replace(loadTarget, loadNew);

const saveTarget = `      geminiAmendments: this.geminiAmendments,
      topTierAlphaSignatures: this.topTierAlphaSignatures`;
const saveNew = `      geminiAmendments: this.geminiAmendments,
      topTierAlphaSignatures: this.topTierAlphaSignatures,
      smartTrailingStats: this.smartTrailingStats`;
code = code.replace(saveTarget, saveNew);

const outcomeTarget = `const tradeReport = {
      id: pos.id || Date.now(),
      timestamp: new Date().toISOString(),`;
const outcomeNew = `let smartTrailingEfficiency = 0;
    let smartTrailingFailed = false;

    if (pos.smartTrailing && pos.smartTrailing.isActive && pos.smartTrailing.peakProfitUsd > 0) {
       const lockedUsd = pos.smartTrailing.lockedProfitUsd;
       const peakUsd = pos.smartTrailing.peakProfitUsd;
       const actualPnlUsd = pnlRatio * pos.size * (pos.entryPrice || 0.50);
       smartTrailingEfficiency = actualPnlUsd / peakUsd;
       
       if (closeReason.includes('Smart Trailing')) {
           const lowerBound = lockedUsd * 0.90;
           const upperBound = lockedUsd * 1.10;
           if (actualPnlUsd < lowerBound || actualPnlUsd > upperBound) {
               smartTrailingFailed = true;
           }
       }
       
       if (!this.smartTrailingStats[patternType]) {
          this.smartTrailingStats[patternType] = { totalActivations: 0, failures: 0, totalEfficiencySum: 0 };
       }
       this.smartTrailingStats[patternType].totalActivations += 1;
       if (smartTrailingFailed) this.smartTrailingStats[patternType].failures += 1;
       this.smartTrailingStats[patternType].totalEfficiencySum += smartTrailingEfficiency;
    }

    const tradeReport = {
      id: pos.id || Date.now(),
      timestamp: new Date().toISOString(),
      smartTrailingEfficiency,
      smartTrailingFailed,`;
code = code.replace(outcomeTarget, outcomeNew);

fs.writeFileSync('server.ts', code, 'utf8');
