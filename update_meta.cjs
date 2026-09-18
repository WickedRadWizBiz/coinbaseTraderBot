const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

const replacement = `export class MetaModelManager {
  private static instance: MetaModelManager;
  private _activeModels = new Map<string, SecondaryMetaModel>();
  private isTraining = false;
  private latestReports = new Map<string, RetrainingReport>();
  private reportHistories = new Map<string, RetrainingReport[]>();
  private historyFilePath = path.join(process.cwd(), 'retraining_history.json');
  
  // Track consecutive blowouts per model generation
  private currentModelBlowouts = new Map<string, number>();
  private currentModelSevereDrawdowns = new Map<string, number>();

  private constructor() {
    this._activeModels.set('GLOBAL', new SecondaryMetaModel());
    this.loadHistoryFromDisk();
  }

  public recordBlowoutFailure(strategyKey: string = 'GLOBAL'): void {
    const blowouts = (this.currentModelBlowouts.get(strategyKey) || 0) + 1;
    this.currentModelBlowouts.set(strategyKey, blowouts);
    console.log(\`[META-MODEL] Drawdown Blowout recorded for \${strategyKey}! Current Model Blowouts: \${blowouts}\`);
  }

  public recordSevereDrawdown(strategyKey: string = 'GLOBAL'): void {
    const drawdowns = (this.currentModelSevereDrawdowns.get(strategyKey) || 0) + 1;
    this.currentModelSevereDrawdowns.set(strategyKey, drawdowns);
    console.log(\`[META-MODEL] Severe 50% Drawdown recorded for \${strategyKey}! Current Severe Drawdowns: \${drawdowns}\`);
  }

  private loadHistoryFromDisk(): void {
    try {
      if (fs.existsSync(this.historyFilePath)) {
        const data = fs.readFileSync(this.historyFilePath, 'utf8');
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed)) {
           this.reportHistories.set('GLOBAL', parsed);
           if (parsed.length > 0) this.latestReports.set('GLOBAL', parsed[0]);
        } else if (parsed && typeof parsed === 'object') {
           for (const [key, history] of Object.entries(parsed)) {
             this.reportHistories.set(key, history as RetrainingReport[]);
             if ((history as RetrainingReport[]).length > 0) {
               this.latestReports.set(key, (history as RetrainingReport[])[0]);
             }
           }
        }
      }
    } catch (e) {
      console.error("[META-MODEL] Failed loading retraining history from disk:", e);
    }
  }

  private _saveHistoryTimeout: NodeJS.Timeout | null = null;
  private saveHistoryToDisk(): void {
    if (this._saveHistoryTimeout) {
      clearTimeout(this._saveHistoryTimeout);
    }
    this._saveHistoryTimeout = setTimeout(() => {
      try {
        const payloadObj: Record<string, RetrainingReport[]> = {};
        for (const [key, history] of this.reportHistories.entries()) {
           payloadObj[key] = history;
        }
        const payload = JSON.stringify(payloadObj);
        fs.writeFile(this.historyFilePath, payload, 'utf-8', (err) => {
          if (err) console.error("[META-MODEL] Failed writing retraining history to disk:", err);
        });
      } catch (e) {
        console.error("[META-MODEL] Failed preparing retraining history to disk:", e);
      }
    }, 5000);
  }

  public static getInstance(): MetaModelManager {
    if (!MetaModelManager.instance) {
      MetaModelManager.instance = new MetaModelManager();
    }
    return MetaModelManager.instance;
  }

  public getModel(strategyKey: string = 'GLOBAL'): SecondaryMetaModel {
    if (!this._activeModels.has(strategyKey)) {
      this._activeModels.set(strategyKey, new SecondaryMetaModel());
    }
    return this._activeModels.get(strategyKey)!;
  }

  public get activeModel(): SecondaryMetaModel {
    return this.getModel('GLOBAL');
  }

  public getIsTraining(): boolean {
    return this.isTraining;
  }

  public getLatestReport(strategyKey: string = 'GLOBAL'): RetrainingReport | null {
    return this.latestReports.get(strategyKey) || null;
  }

  public getReportHistory(): RetrainingReport[] {
    let combined: RetrainingReport[] = [];
    for (const [key, history] of this.reportHistories.entries()) {
      combined = combined.concat(history.map(h => ({ ...h, targetStrategy: key })));
    }
    return combined.sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime());
  }

  /**
   * Safe Pre-Trade Gatekeeper query accessible throughout the application.
   */
  public evaluatePreTradeGate(features: EntryFeatures, marketRegime?: string, strategyKey?: string): {
    approved: boolean;
    proba: number;
    kellyScaler: number;
    reason: string;
  } {
    if (strategyKey && this._activeModels.has(strategyKey)) {
      const specificModel = this.getModel(strategyKey);
      const specEval = specificModel.evaluatePreTradeGate(features, marketRegime);
      if (!specEval.approved) return specEval; 
    }
    return this.getModel('GLOBAL').evaluatePreTradeGate(features, marketRegime);
  }

  /**
   * Thread-Safe Atomic Model Hot-Swap upon passing DSR verification.
   */
  public atomicHotSwap(newModel: SecondaryMetaModel, strategyKey: string = 'GLOBAL'): void {
    this._activeModels.set(strategyKey, newModel);
    console.log(\`[META-MODEL HOT-SWAP] Atomic pointer updated for \${strategyKey}. New mathematically optimized meta-model active in application memory with zero downtime.\`);
  }

  /**
   * Asynchronous Non-Blocking Retraining Protocol.
   */
  public async runRetrainingPipeline(strategyKey: string = 'GLOBAL'): Promise<RetrainingReport> {
    if (this.isTraining) {
      if (this.latestReports.has(strategyKey)) return this.latestReports.get(strategyKey)!;
      throw new Error("Retraining pipeline already running in background.");
    }

    this.isTraining = true;
    const jobId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const logMessages: string[] = [\`[JOB \${jobId.substring(0, 8)}] Counterfactual retraining protocol initiated for \${strategyKey}.\`];

    try {
      // Step 1: Pull trade logs from persistent database
      const rawTrades = strategyKey === 'GLOBAL' 
          ? await tradeDbManager.getAllTrades(500)
          : await tradeDbManager.getTradesByPatternType(strategyKey, 500);
`;

const startIndex = code.indexOf('export class MetaModelManager {');
const endIndex = code.indexOf('      // Convert raw trades to ExpandedTradeLog format with true feature hydration');

if (startIndex === -1 || endIndex === -1) {
  console.log('Could not find injection points');
  process.exit(1);
}

const newCode = code.substring(0, startIndex) + replacement + code.substring(endIndex);
fs.writeFileSync('metaLearningEngine.ts', newCode, 'utf8');
console.log('Updated metaLearningEngine.ts');
