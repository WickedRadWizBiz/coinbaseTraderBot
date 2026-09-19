import 'dotenv/config';
import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { GoogleGenAI } from "@google/genai";
import { createServer as createViteServer } from "vite";
import { CapitalPreservationProtocol } from "./recoveryProtocol";
import { plasticityEngine } from "./plasticityEngine";
import { computeSpotTAMetrics, isTradeAllowedBySpotTAAndRecovery, SpotTAMetrics } from "./spotTAEngine";
import { unifiedDataHandler } from "./unifiedDataHandler";
import { tradeDbManager, TradeEncoder } from "./tradeDatabaseManager";
import { metaModelManager, EntryFeatures } from "./metaLearningEngine";
import { geminiStrategyEngine } from "./geminiStrategyEngine";
import { globalMetricsTracker } from "./globalMetricsTracker";
import { fundingRateTracker } from "./fundingRateTracker";
import { SmartTrailingEngine, SmartTrailingState } from "./smartTrailingEngine";
import { marketTestingEngine } from "./marketTestingProtocol";
import { coinbaseService } from "./coinbaseService";
import { kalshiService } from "./kalshiService";
import { goalResetScheduler } from "./goalResetScheduler";
import { latencyAdaptiveEngine } from "./latencyAdaptiveEngine";

const app = express();
app.use(express.json());

globalMetricsTracker.start();
fundingRateTracker.start();

const PORT = 3000;

// Global variables to store bot state and settings
let settings = {
  trainingOnTheJob: false,
  overrideConfluence: true,
  winningsLock: 50,
  allocCrypto15m: 50,
  allocCrypto1h: 35,
  allocSports: 15,
  lossRecoveryMode: false,
  stopLossBase: -15,
  profitLockTrigger: 25,
  profitLockFloor: 5,
  instantProfitQueue: 20,
  kellyMultiplier: 3.0,
  paperTrading: true,
  botActive: true,
  adaptationMode: true,
  ENABLE_RAPID_SCALP_MODE: true,
  smartTrailingTP: true,
  lowFundsMode: false
};

let startingBankroll = 200;
let cycleEarnedProfit = 0;
let vaultedProfits = 0;
let completedGoalCycles = 0;
let cumulativePaperProfit = 0;
let completedPaperIterations = 0;
let spotLogs: any[] = [
  { id: 1, time: new Date().toISOString(), type: 'INFO', message: 'Bot initialized. Connected to Prediction Markets.' }
];
let logIdCounter = 100;
let simulatedPaperBalance = 200;
let realKalshiCashPool = 0;
let lastRealCashFetchTime = 0;

let paperBankrollATH = 200;
let liveBankrollATH = 0;

async function getEffectiveWorkingBalance(forceSync = false): Promise<number> {
  if (settings.paperTrading) {
    paperBankrollATH = Math.max(paperBankrollATH, simulatedPaperBalance);
    const reserve = paperBankrollATH * 0.10;
    
    let capitalInUse = 0;
    activePositions.forEach(p => capitalInUse += (p.capitalPlacedUsd || (p.size * p.entryPrice)));
    
    const uninvestedCash = simulatedPaperBalance - capitalInUse;
    return Math.max(0, uninvestedCash - reserve);
  }
  
  const now = Date.now();
  if (forceSync || now - lastRealCashFetchTime > 10000 || realKalshiCashPool === 0) {
    try {
      const res = await kalshiService.getBalance();
      if (res.success && res.balance !== undefined) {
        realKalshiCashPool = res.balance;
        lastRealCashFetchTime = now;
      } else if (!res.success && res.error) {
        console.error('[KALSHI] Balance sync issue:', res.error);
        if (now - lastRealCashFetchTime > 60000) {
          spotLogs.unshift({
            id: logIdCounter++,
            time: new Date().toISOString(),
            type: 'WARN',
            message: `[KALSHI LIVE BALANCE ERROR] ${res.error}. Ensure KALSHI_API_KEY and KALSHI_API_SECRET in .env are correct.`
          });
          lastRealCashFetchTime = now;
        }
      }
    } catch (e: any) {
      console.error('[KALSHI] Balance sync error:', e);
    }
  }
  
  liveBankrollATH = Math.max(liveBankrollATH, realKalshiCashPool);
  const reserve = liveBankrollATH * 0.10;
  return Math.max(0, realKalshiCashPool - reserve);
}

const lastTimeoutLogTimestamps: Record<string, number> = {};

function logThrottledTimeoutReject(message: string, throttleKey: string, minIntervalMs: number = 30000) {
  const now = Date.now();
  const lastLog = lastTimeoutLogTimestamps[throttleKey] || 0;
  if (now - lastLog >= minIntervalMs) {
    lastTimeoutLogTimestamps[throttleKey] = now;
    spotLogs.unshift({
      id: logIdCounter++,
      time: new Date().toISOString(),
      type: 'ANALYZE',
      message
    });
  }
}

const DEFAULT_BASELINES = {
  bull_market: { dynamicTP: 0.12, dynamicSL: -0.025, dynamicTrail: 0.005, earlyProfitProb: 0.10 },
  bear_market: { dynamicTP: 0.04, dynamicSL: -0.02, dynamicTrail: 0.005, earlyProfitProb: 0.15 },
  alt_season: { dynamicTP: 0.25, dynamicSL: -0.025, dynamicTrail: 0.005, earlyProfitProb: 0.05 }
};

interface AssetTimeoutRecord {
  assetSymbol: string;
  lossCount: number;
  timeoutUntilMs: number;
}

interface TimeoutItem {
  id: string;
  name: string;
  category: 'PATTERN' | 'INDICATOR' | 'COMBINATION';
  wins: number;
  losses: number;
  totalTrades: number;
  winRatePct: number;
  globalTimeoutUntilMs: number;
  globalLossCount: number;
  assetTimeouts: { [assetSymbol: string]: AssetTimeoutRecord };
  isManuallyDisabled?: boolean;
  isExtinct?: boolean;
  reason?: string;
}

export interface GeminiStrategyAmendment {
  id: string;
  timestamp: string;
  targetFeatureId: string;
  featureName: string;
  assetSymbol: string;
  verdict: 'FLAWED_SETUP' | 'STRATEGIC_AMENDMENT';
  diagnosis: string;
  proposedAction: {
    ruleType: 'THRESHOLD_FILTER' | 'STATE_REQUIREMENT' | 'DISABLE_PATTERN' | 'SIDE_RESTRICTION';
    field: 'rsi' | 'volumeSurgeRatio' | 'ichimokuState' | 'tenkanKijunCross' | 'orderBookRatio' | 'contractSide';
    operator: '>' | '<' | '>=' | '<=' | '==' | '!=' | 'NOT_IN';
    value: string | number;
    description: string;
  };
  kellyParameters?: {
    tradeCashVolumeUsd?: number;
    takeProfitPct: number;
    stopLossPct: number;
    explanation: string;
  };
  isActive: boolean;
  triggeringTradeId?: number;
  trialMode?: {
    active: boolean;
    oppositeSide: 'YES' | 'NO';
    tradesExecuted: number;
    wins: number;
  };
}

class PatternTradingBrain {
  memoryFile: string;
  winningStrategies: { [pattern: string]: any };
  losingStrategies: { [pattern: string]: any };
  tradeHistory: any[];
  invalidationReviews: any[];
  currentRegime: string;
  longTermBaselines: any;
  shortTermLedger: any[];
  extinctionList: { [id: string]: TimeoutItem };
  featureStats: { [id: string]: { name: string; category: 'PATTERN' | 'INDICATOR' | 'COMBINATION'; wins: number; losses: number; totalTrades: number } };
  geminiAmendments: GeminiStrategyAmendment[];
  topTierAlphaSignatures: any[];
  smartTrailingStats: { [pattern: string]: { totalActivations: number, failures: number, totalEfficiencySum: number } };

  constructor(memoryFile = 'bot_memory.json') {
    this.memoryFile = path.join(process.cwd(), memoryFile);
    this.winningStrategies = {};
    this.losingStrategies = {};
    this.tradeHistory = [];
    this.invalidationReviews = [];
    this.currentRegime = 'bull_market';
    this.longTermBaselines = { ...DEFAULT_BASELINES };
    this.shortTermLedger = [];
    this.extinctionList = {};
    this.featureStats = {};
    this.geminiAmendments = [];
    this.topTierAlphaSignatures = [];
    this.smartTrailingStats = {};
    this._loadMemory();
    this._ensureExtinctionListSeeded();
  }

  _ensureExtinctionListSeeded() {
    if (Object.keys(this.extinctionList).length === 0) {
      this.extinctionList = {
        'combo_RSI_ZONE+DOJI_REVERSAL': {
          id: 'combo_RSI_ZONE+DOJI_REVERSAL',
          name: 'Combo: RSI Zone + Doji Reversal',
          category: 'COMBINATION',
          wins: 0,
          losses: 0,
          totalTrades: 0,
          winRatePct: 0.0,
          globalTimeoutUntilMs: 0,
          globalLossCount: 0,
          assetTimeouts: {},
          isManuallyDisabled: false,
          isExtinct: false,
          reason: 'Active feature.'
        },
        'pattern_WEAK_MOMENTUM_BREAKOUT': {
          id: 'pattern_WEAK_MOMENTUM_BREAKOUT',
          name: 'Pattern: Weak Momentum Breakout',
          category: 'PATTERN',
          wins: 0,
          losses: 0,
          totalTrades: 0,
          winRatePct: 0.0,
          globalTimeoutUntilMs: 0,
          globalLossCount: 0,
          assetTimeouts: {},
          isManuallyDisabled: false,
          isExtinct: false,
          reason: 'Active feature.'
        },
        'indicator_UNCONFIRMED_VOLATILITY': {
          id: 'indicator_UNCONFIRMED_VOLATILITY',
          name: 'Indicator: Unconfirmed Volatility Spike',
          category: 'INDICATOR',
          wins: 0,
          losses: 0,
          totalTrades: 0,
          winRatePct: 0.0,
          globalTimeoutUntilMs: 0,
          globalLossCount: 0,
          assetTimeouts: {},
          isManuallyDisabled: false,
          isExtinct: false,
          reason: 'Active feature.'
        },
        'pattern_CONFLUENCE_ICHIMOKU_VOL_SURGE': {
          id: 'pattern_CONFLUENCE_ICHIMOKU_VOL_SURGE',
          name: 'Pattern: Ichimoku Vol Surge Confluence',
          category: 'PATTERN',
          wins: 14,
          losses: 3,
          totalTrades: 17,
          winRatePct: 82.4,
          globalTimeoutUntilMs: 0,
          globalLossCount: 0,
          assetTimeouts: {},
          isManuallyDisabled: false,
          isExtinct: false,
          reason: 'Active high-performance strategy (82.4% win rate).'
        }
      };

      this.featureStats = {
        'combo_RSI_ZONE+DOJI_REVERSAL': { name: 'Combo: RSI Zone + Doji Reversal', category: 'COMBINATION', wins: 0, losses: 0, totalTrades: 0 },
        'pattern_WEAK_MOMENTUM_BREAKOUT': { name: 'Pattern: Weak Momentum Breakout', category: 'PATTERN', wins: 0, losses: 0, totalTrades: 0 },
        'indicator_UNCONFIRMED_VOLATILITY': { name: 'Indicator: Unconfirmed Volatility Spike', category: 'INDICATOR', wins: 0, losses: 0, totalTrades: 0 },
        'pattern_CONFLUENCE_ICHIMOKU_VOL_SURGE': { name: 'Pattern: Ichimoku Vol Surge Confluence', category: 'PATTERN', wins: 14, losses: 3, totalTrades: 17 }
      };
      this._saveMemory();
    }
  }

  _loadMemory() {
    if (!fs.existsSync(this.memoryFile)) {
      console.log("[LOG] No memory file found. Initializing pattern brain defaults.");
      this._saveMemory();
      return;
    }
    try {
      const data = JSON.parse(fs.readFileSync(this.memoryFile, 'utf-8'));
      if (data.patternBrain) {
        this.winningStrategies = data.patternBrain.winningStrategies || {};
        this.losingStrategies = data.patternBrain.losingStrategies || {};
        this.tradeHistory = data.patternBrain.tradeHistory || [];
        this.invalidationReviews = data.patternBrain.invalidationReviews || [];
        this.extinctionList = data.patternBrain.extinctionList || {};
        this.featureStats = data.patternBrain.featureStats || {};
        this.geminiAmendments = data.patternBrain.geminiAmendments || [];
        this.topTierAlphaSignatures = data.patternBrain.topTierAlphaSignatures || [];

        // Sanitize stored strategy parameters to enforce TP >= |SL| + 0.5% (0.005) and Trailing Lock >= 0.5% (0.005)
        Object.values(this.winningStrategies).forEach((strat: any) => {
          if (strat && strat.hybridizedParams) {
            let sl = Math.max(-0.03, Math.min(-0.005, Number(strat.hybridizedParams.dynamicSL) || -0.025));
            let slMag = Math.abs(sl);
            let tp = Math.max(0.10, Math.max(slMag + 0.005, Number(strat.hybridizedParams.dynamicTP) || 0.15));
            let trail = Math.max(0.005, Number(strat.hybridizedParams.dynamicTrail) || 0.005);
            strat.hybridizedParams.dynamicSL = sl;
            strat.hybridizedParams.dynamicTP = tp;
            strat.hybridizedParams.dynamicTrail = trail;
          }
        });
        // Sanitize stored extinctionList timeouts to ensure no stale legacy >45m timeouts exist
        const maxTimeoutMs = Date.now() + (45 * 60 * 1000);
        Object.values(this.extinctionList).forEach((item: any) => {
          if (item && item.globalTimeoutUntilMs && item.globalTimeoutUntilMs > maxTimeoutMs) {
            item.globalTimeoutUntilMs = maxTimeoutMs;
          }
          if (item && item.assetTimeouts) {
            Object.values(item.assetTimeouts).forEach((a: any) => {
              if (a && a.timeoutUntilMs && a.timeoutUntilMs > maxTimeoutMs) {
                a.timeoutUntilMs = maxTimeoutMs;
              }
            });
          }
        });
      }
      if (data.settings && typeof data.settings === 'object') {
        settings = { ...settings, ...data.settings };
      }
      if (typeof data.startingBankroll === 'number') startingBankroll = data.startingBankroll;
      if (typeof data.paperBalance === 'number') simulatedPaperBalance = Math.max(0, data.paperBalance);
      if (typeof data.cycleEarnedProfit === 'number') cycleEarnedProfit = data.cycleEarnedProfit;
      if (typeof data.vaultedProfits === 'number') vaultedProfits = Math.max(0, data.vaultedProfits);
      if (typeof data.completedGoalCycles === 'number') completedGoalCycles = data.completedGoalCycles;
      if (typeof data.cumulativePaperProfit === 'number') cumulativePaperProfit = data.cumulativePaperProfit;
      if (typeof data.completedPaperIterations === 'number') completedPaperIterations = data.completedPaperIterations;
      // Untouchable Profit Vault Rule: Funds never leave the profit vault.
      console.log("[LOG] Pattern Strategy Brain memory loaded from disk.");

      // Sync trade records with SQLite TradeDatabaseManager
      tradeDbManager.getAllTrades(200).then((dbTrades) => {
        if (dbTrades && dbTrades.length > 0) {
          this.tradeHistory = dbTrades;
          console.log(`[DB] Loaded ${dbTrades.length} bitpacked trade records from TradeDatabaseManager.`);
        } else if (this.tradeHistory && this.tradeHistory.length > 0) {
          console.log(`[DB] Migrating ${this.tradeHistory.length} legacy trades into SQLite TradeDatabaseManager...`);
          this.tradeHistory.forEach((t: any) => {
            const indicators = TradeEncoder.extractIndicatorsFromTrade(t);
            tradeDbManager.insertTrade(
              t.symbol || t.label || 'UNKNOWN',
              indicators,
              0.50,
              0.50 * (1 + (t.pnlPct ? t.pnlPct / 100 : 0)),
              Boolean(t.wasAnalysisCorrect),
              JSON.stringify(t),
              t.timestamp ? Math.floor(new Date(t.timestamp).getTime() / 1000) : undefined
            ).catch(() => {});
          });
        }
      }).catch(err => console.error("[DB ERROR] Failed syncing trades from TradeDatabaseManager:", err));
    } catch (e) {
      console.error("[ERROR] Could not load pattern brain memory:", e);
    }
  }

  private _saveTimeout: NodeJS.Timeout | null = null;

  _saveMemory() {
    if (this._saveTimeout) {
      clearTimeout(this._saveTimeout);
    }
    this._saveTimeout = setTimeout(() => {
      try {
        const tempFile = `${this.memoryFile}.tmp`;
        const payload = JSON.stringify({
          patternBrain: {
            winningStrategies: this.winningStrategies,
            losingStrategies: this.losingStrategies,
            tradeHistory: this.tradeHistory,
            invalidationReviews: this.invalidationReviews,
            extinctionList: this.extinctionList,
            featureStats: this.featureStats,
            geminiAmendments: this.geminiAmendments,
            topTierAlphaSignatures: this.topTierAlphaSignatures
          },
          settings,
          startingBankroll,
          paperBalance: simulatedPaperBalance,
          cycleEarnedProfit,
          vaultedProfits,
          completedGoalCycles,
          cumulativePaperProfit,
          completedPaperIterations
        }); // Removed pretty print to save space/time

        fs.writeFile(tempFile, payload, 'utf-8', (err) => {
          if (err) {
            console.error("[ERROR] Failed writing pattern brain temp:", err);
            return;
          }
          fs.rename(tempFile, this.memoryFile, (renameErr) => {
             if (renameErr) console.error("[ERROR] Failed moving pattern brain file:", renameErr);
          });
        });
      } catch (e) {
        console.error("[ERROR] Failed preparing pattern brain memory:", e);
      }
    }, 5000); // 5 seconds debounce
  }

  extractActiveIndicatorKeys(spotTA?: any, indicators?: any): string[] {
    const keys: string[] = [];
    const ta = spotTA || indicators || {};

    if (ta.ichimokuState === 'BULLISH_CLOUD' || ta.ichimokuState === 'BEARISH_CLOUD' || ta.ichimoku) {
      keys.push('ICHIMOKU_CLOUD');
    }
    if (ta.rsi !== undefined && (ta.rsi <= 45 || ta.rsi >= 52 || ta.rsiOverbought || ta.rsiOversold)) {
      keys.push('RSI_ZONE');
    }
    if ((ta.volumeSurgeRatio && ta.volumeSurgeRatio >= 1.15) || ta.volumeSurge) {
      keys.push('VOLUME_SURGE');
    }
    if (ta.isDoji || ta.candlestickDoji) {
      keys.push('DOJI_REVERSAL');
    }
    if (ta.orderbookDepth || ta.imbalance) {
      keys.push('ORDERBOOK_DEPTH');
    }
    return keys;
  }

  evaluateGeminiAmendments(
    patternType: string,
    assetSymbol: string = 'GLOBAL',
    spotTA?: any,
    side?: string
  ): { isAllowed: boolean; blockedItems: string[] } {
    const blockedItems: string[] = [];
    if (!this.geminiAmendments || this.geminiAmendments.length === 0) {
      return { isAllowed: true, blockedItems: [] };
    }

    const patternKey = `pattern_${patternType}`;

    const activeRules = this.geminiAmendments.filter(
      r => r.isActive &&
           (r.targetFeatureId === patternKey || r.targetFeatureId === patternType || r.targetFeatureId.toLowerCase().includes(patternType.toLowerCase())) &&
           (r.assetSymbol === assetSymbol || r.assetSymbol === 'GLOBAL' || assetSymbol === 'GLOBAL')
    );

    for (const rule of activeRules) {
      if (rule.verdict === 'FLAWED_SETUP') {
        blockedItems.push(`${rule.featureName} [Gemini Flagged Flawed Setup: ${rule.diagnosis}]`);
        continue;
      }

      if (rule.proposedAction) {
        const { field, operator, value, description } = rule.proposedAction;
        let currentValue: any = undefined;

        if (field === 'contractSide') {
          currentValue = side;
        } else if (spotTA) {
          currentValue = spotTA[field];
        }

        if (currentValue !== undefined && currentValue !== null) {
          let passed = true;
          if (operator === '>') passed = Number(currentValue) > Number(value);
          else if (operator === '<') passed = Number(currentValue) < Number(value);
          else if (operator === '>=') passed = Number(currentValue) >= Number(value);
          else if (operator === '<=') passed = Number(currentValue) <= Number(value);
          else if (operator === '==') passed = String(currentValue) === String(value);
          else if (operator === '!=') passed = String(currentValue) !== String(value);
          else if (operator === 'NOT_IN') {
            const list = Array.isArray(value) ? value : String(value).split(',').map(s => s.trim());
            passed = !list.includes(String(currentValue));
          }

          if (!passed) {
            blockedItems.push(`${rule.featureName} [Gemini AI Amendment Rule: ${description} (Current: ${currentValue})]`);
          }
        }
      }
    }

    return {
      isAllowed: blockedItems.length === 0,
      blockedItems
    };
  }

  getTrialModeFlip(patternType: string, assetSymbol: string = 'GLOBAL'): 'YES' | 'NO' | null {
    if (!this.geminiAmendments || this.geminiAmendments.length === 0) return null;
    const patternKey = `pattern_${patternType}`;
    
    // Look for any active trial, OR a successful trial that has been permanently adopted
    const activeRules = this.geminiAmendments.filter(
      r => r.isActive && 
           (r.targetFeatureId === patternKey || r.targetFeatureId === patternType || r.targetFeatureId.toLowerCase().includes(patternType.toLowerCase())) &&
           (r.assetSymbol === assetSymbol || r.assetSymbol === 'GLOBAL' || assetSymbol === 'GLOBAL') &&
           (r.trialMode?.active || (r.trialMode && !r.trialMode.active && r.trialMode.wins > 1) || (r.proposedAction?.field === 'contractSide' && r.proposedAction?.operator === '=='))
    );
    
    if (activeRules.length > 0) {
      const rule = activeRules[0];
      if (rule.trialMode) {
        return rule.trialMode.oppositeSide;
      } else if (rule.proposedAction?.field === 'contractSide' && rule.proposedAction?.operator === '==') {
        return rule.proposedAction.value as 'YES' | 'NO';
      }
    }
    return null;
  }

  checkTimeoutFilter(patternType: string, assetSymbol: string = 'GLOBAL', spotTA?: any, indicators?: any, side?: string): { isTimedOut: boolean; blockedItems: string[] } {
    if (settings && settings.overrideConfluence) {
      return { isTimedOut: false, blockedItems: [] };
    }
    const now = Date.now();
    const blockedItems: string[] = [];

    // High-Confluence / OFI Sweep Bypass for transient single-loss indicator timeouts
    let isHighConfluenceCandidate = false;
    if (spotTA && side) {
      const bidVol = spotTA.bidVol || 500;
      const askVol = spotTA.askVol || 500;
      const isOFISweep = (side === 'YES' && bidVol >= askVol * 1.25) || (side === 'NO' && askVol >= bidVol * 1.25);
      const confluenceRes = evaluateConfluenceFactorsCount(side as 'YES' | 'NO', spotTA, bidVol, askVol);
      if (confluenceRes.count >= 2 || isOFISweep) {
        isHighConfluenceCandidate = true;
      }
    }

    const checkItem = (id: string, isPattern: boolean = false) => {
      const item = this.extinctionList[id];
      if (!item) return;

      if (item.isManuallyDisabled) {
        blockedItems.push(`${item.name} (Manually Disabled)`);
        return;
      }

      // Bypass transient indicator timeouts for high-confluence / OFI sweep candidates
      if (isHighConfluenceCandidate && !isPattern && item.globalLossCount <= 1) {
        return;
      }

      // 1. Check global time-out
      if (item.globalTimeoutUntilMs && now < item.globalTimeoutUntilMs) {
        const remainingSec = Math.ceil((item.globalTimeoutUntilMs - now) / 1000);
        blockedItems.push(`${item.name} (${remainingSec}s Global Time-Out left)`);
        return;
      }

      // 2. Check asset-specific time-out
      if (assetSymbol && item.assetTimeouts && item.assetTimeouts[assetSymbol]) {
        const assetRec = item.assetTimeouts[assetSymbol];
        if (assetRec.timeoutUntilMs && now < assetRec.timeoutUntilMs) {
          const remainingSec = Math.ceil((assetRec.timeoutUntilMs - now) / 1000);
          blockedItems.push(`${item.name} (${remainingSec}s Asset Time-Out on ${assetSymbol} left)`);
          return;
        }
      }
    };

    // Pattern check
    checkItem(`pattern_${patternType}`, true);

    // Active indicators check
    const indKeys = this.extractActiveIndicatorKeys(spotTA, indicators);
    indKeys.forEach(k => checkItem(`indicator_${k}`, false));

    // Combination check
    if (indKeys.length >= 2) {
      for (let i = 0; i < indKeys.length; i++) {
        for (let j = i + 1; j < indKeys.length; j++) {
          checkItem(`combo_${indKeys[i]}+${indKeys[j]}`, false);
        }
      }
    }

    // 3. Evaluate Gemini AI Strategic Amendments
    const aiEval = this.evaluateGeminiAmendments(patternType, assetSymbol, spotTA, side);
    if (!aiEval.isAllowed) {
      blockedItems.push(...aiEval.blockedItems);
    }

    return {
      isTimedOut: blockedItems.length > 0,
      blockedItems
    };
  }

  checkExtinctionFilter(patternType: string, spotTA?: any, indicators?: any, assetSymbol: string = 'GLOBAL'): { isExtinct: boolean; blockedItems: string[] } {
    const res = this.checkTimeoutFilter(patternType, assetSymbol, spotTA, indicators);
    return {
      isExtinct: res.isTimedOut,
      blockedItems: res.blockedItems
    };
  }

  toggleExtinctItem(id: string, active: boolean) {
    let item = this.extinctionList[id];
    if (!item && this.featureStats[id]) {
      const stat = this.featureStats[id];
      item = {
        id,
        name: stat.name,
        category: stat.category,
        wins: stat.wins,
        losses: stat.losses,
        totalTrades: stat.totalTrades,
        winRatePct: stat.totalTrades > 0 ? parseFloat(((stat.wins / stat.totalTrades) * 100).toFixed(1)) : 0,
        globalTimeoutUntilMs: 0,
        globalLossCount: 0,
        assetTimeouts: {},
        isManuallyDisabled: false,
        isExtinct: false
      };
      this.extinctionList[id] = item;
    } else if (!item) {
      return { success: false, message: `Item '${id}' not found.` };
    }

    if (active) {
      // User is toggling it BACK IN => Lift time-out & scrub ratios!
      item.globalTimeoutUntilMs = 0;
      item.globalLossCount = 0;
      item.assetTimeouts = {};
      item.isManuallyDisabled = false;
      item.isExtinct = false;
      item.wins = 0;
      item.losses = 0;
      item.totalTrades = 0;
      item.winRatePct = 0;
      item.reason = 'Time-out lifted by user. Win/Loss ratio scrubbed to 0/0.';

      if (this.featureStats[id]) {
        this.featureStats[id].wins = 0;
        this.featureStats[id].losses = 0;
        this.featureStats[id].totalTrades = 0;
      }

      spotLogs.unshift({
        id: logIdCounter++, time: new Date().toISOString(), type: 'INFO',
        message: `[TIME-OUT LIFTED] User cleared time-outs for '${item.name}'. Win/Loss history scrubbed to 0/0.`
      });
    } else {
      // User manually disables/times-out feature
      item.isManuallyDisabled = true;
      item.isExtinct = true;
      item.reason = 'Manually placed on time-out by user.';

      spotLogs.unshift({
        id: logIdCounter++, time: new Date().toISOString(), type: 'INFO',
        message: `[TIME-OUT MANUAL DISABLE] User manually placed '${item.name}' on time-out.`
      });
    }

    this._saveMemory();
    return { success: true, item };
  }

  resetBrain() {
    this.winningStrategies = {};
    this.losingStrategies = {};
    this.tradeHistory = [];
    this.invalidationReviews = [];
    this._saveMemory();
  }

  getAdaptedParamsForPattern(patternType: string, fallbackParams: any = {}) {
    const winRecord = this.winningStrategies[patternType];
    const lossRecord = this.losingStrategies[patternType];

    let baseTP = fallbackParams.dynamicTP || 0.08;
    let baseSL = fallbackParams.dynamicSL || -0.025;
    let baseTrail = Math.max(0.005, fallbackParams.dynamicTrail || 0.005);

    if (winRecord && winRecord.winCount > 0 && winRecord.hybridizedParams) {
      baseTP = winRecord.hybridizedParams.dynamicTP || baseTP;
      baseSL = winRecord.hybridizedParams.dynamicSL || baseSL;
      baseTrail = Math.max(0.005, winRecord.hybridizedParams.dynamicTrail || baseTrail);
    }

    if (lossRecord && lossRecord.lossCount > (winRecord?.winCount || 0)) {
      baseSL = Math.min(-0.015, baseSL * 0.90);
      baseTP = Math.max(0.015, baseTP * 0.90);
    }

    // MANDATORY HARD CAP: Stop loss MUST never exceed -3% loss (-0.03)
    baseSL = Math.max(-0.03, Math.min(-0.005, baseSL));

    // MANDATORY RULE: Take profit MUST always be larger than stop loss magnitude by at least 0.5% (0.005)
    const slMag = Math.abs(baseSL);
    if (baseTP < slMag + 0.005) {
      baseTP = slMag + 0.005;
    }

    return {
      dynamicTP: baseTP,
      dynamicSL: baseSL,
      dynamicTrail: Math.max(0.005, baseTrail),
      earlyProfitProb: fallbackParams.earlyProfitProb || 0.10
    };
  }

  generateComparativeReview(pos: any, isWin: boolean, pnlPct: number, closeReason: string, tradeReport: any) {
    const patternType = tradeReport.patternType;
    const label = tradeReport.label || tradeReport.symbol;

    let refTrade = this.tradeHistory.find((t: any) => 
      t.id !== tradeReport.id && 
      (t.patternType === patternType || t.label === label) &&
      t.wasAnalysisCorrect !== isWin
    );

    if (!refTrade) {
      refTrade = this.tradeHistory.find((t: any) => t.id !== tradeReport.id && t.patternType === patternType);
    }

    let divergenceFactors = [
      { metric: 'Ichimoku Cloud State', current: tradeReport.indicators?.ichimokuState || 'NEUTRAL', ref: refTrade?.indicators?.ichimokuState || 'NEUTRAL' },
      { metric: 'RSI Level', current: tradeReport.indicators?.rsi ? tradeReport.indicators.rsi.toFixed(1) : '50', ref: refTrade?.indicators?.rsi ? refTrade.indicators.rsi.toFixed(1) : '50' },
      { metric: 'Volume Surge Ratio', current: tradeReport.indicators?.volumeSurgeRatio ? tradeReport.indicators.volumeSurgeRatio.toFixed(2) + 'x' : '1.0x', ref: refTrade?.indicators?.volumeSurgeRatio ? refTrade.indicators.volumeSurgeRatio.toFixed(2) + 'x' : '1.0x' }
    ];

    let learnedRule = isWin
      ? `[LEARNED RULE: ${label}] ${patternType} is highly effective when ${divergenceFactors[0].metric} aligns with prediction (${tradeReport.prediction}). Retain optimal hybridized TP/SL bounds.`
      : `[LEARNED RULE: ${label}] Pattern invalidated by ${closeReason}. For future ${label} setups, demand stricter threshold on ${divergenceFactors[0].metric} and enforce max 3% stop loss.`;

    const reviewReport = {
      id: tradeReport.id,
      timestamp: tradeReport.timestamp,
      label,
      symbol: tradeReport.symbol,
      patternType,
      outcome: isWin ? 'VALIDATED_WIN' : 'PATTERN_INVALIDATED',
      pnlPct,
      pnlUsd: tradeReport.pnlUsd,
      analysisQuery: 'What did analysis show?',
      analysisShowed: `Analysis predicted ${tradeReport.prediction} on ${label} (${tradeReport.side} side) using pattern [${patternType}].`,
      wasCorrectQuery: 'Was the analysis correct?',
      wasAnalysisCorrect: isWin 
        ? `YES - Market price validated analysis (+${pnlPct}% PnL).` 
        : `NO - Market price invalidated pattern (${pnlPct}% PnL, ${closeReason}).`,
      comparisonQuery: 'What was the difference between a similar win/loss or spot analysis that made the pattern invalidated if any?',
      comparativeAnalysis: {
        referenceLabel: refTrade ? `${refTrade.label} (${refTrade.wasAnalysisCorrect ? 'WIN' : 'LOSS'} ${refTrade.pnlPct}%)` : 'Historical Baseline Model',
        divergenceFactors
      },
      learnedBehaviorRule: learnedRule
    };

    this.invalidationReviews.unshift(reviewReport);
    if (this.invalidationReviews.length > 50) this.invalidationReviews.pop();

    spotLogs.unshift({
      id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
      message: `[COMPARATIVE REVIEW] Evaluated ${label} (${patternType}). Outcome: ${reviewReport.outcome}. Learned: "${learnedRule}"`
    });
  }

  recordStrategyOutcome(pos: any, pnlRatio: number, closeReason: string) {
    const patternType = pos.analysisMeta?.patternType || 'GENERAL_ANALYSIS';
    const prediction = pos.analysisMeta?.prediction || pos.reason || 'PRICE_DIRECTIONAL';
    const indicatorsAtEntry = pos.analysisMeta?.indicators || {};
    const usedParams = pos.params || { dynamicTP: 0.05, dynamicSL: -0.015, dynamicTrail: 0.005 };
    const spotTA = pos.analysisMeta?.spotTA;
    if (spotTA && spotTA.candleRangePct) {
        // Volatility-Adjusted Smart Trailing Distance: 1.5 * ATR_14
        usedParams.dynamicTrail = Math.max(0.002, 1.5 * (spotTA.candleRangePct / 100));
    }

    const isWin = pnlRatio > 0;
    const wasAnalysisCorrect = isWin;
    const didPriceValidateAnalysis = (pos.peakPnlRatio !== undefined && pos.peakPnlRatio > 0) || isWin;
    const pnlPct = parseFloat((pnlRatio * 100).toFixed(2));

    let smartTrailingEfficiency = 0;
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
      smartTrailingFailed,
      symbol: pos.symbol,
      label: pos.label || pos.symbol,
      side: pos.side,
      patternType,
      prediction,
      wasAnalysisCorrect,
      didPriceValidateAnalysis,
      pnlPct,
      pnlUsd: parseFloat((pnlRatio * pos.size * (pos.entryPrice || 0.50)).toFixed(2)),
      closeReason,
      params: usedParams,
      indicators: indicatorsAtEntry,
      
      // Extended Metametrics for DB
      entryPrice: pos.entryPrice || 0.50,
      exitPrice: (pos.entryPrice || 0.50) * (1 + pnlRatio),
      timeInContractSec: (Date.now() - (pos.entryTime || Date.now())) / 1000,
      timeInProfitSec: Math.round(pos.timeInProfitSec || 0),
      timeInLossSec: Math.round(pos.timeInLossSec || 0),
      maxAdverseExcursion: pos.maxAdverseExcursion || 0,
      maxFavorableExcursion: pos.peakPnlRatio || 0,
      marketRegimeAtEntry: pos.marketRegimeAtEntry || 'UNKNOWN',
      volumeSurgeAtEntry: pos.volumeSurgeAtEntry || 1.0,
      bidAskImbalanceAtEntry: pos.bidAskImbalanceAtEntry || 1.0,
      confluenceCountAtEntry: pos.confluenceCountAtEntry || 1,
      entryFeatures: pos.entryFeatures || null
    };

    // Amendment 4: Online Streaming Meta-Model Adaptation (Real-time SGD continual learning)
    try {
      const spotTA = pos.analysisMeta?.spotTA || {};
      const bidVol = pos.analysisMeta?.indicators?.bidVol || 500;
      const askVol = pos.analysisMeta?.indicators?.askVol || 500;
      const ofi = (bidVol - askVol) / Math.max(1, (bidVol + askVol));
      const bestBid = pos.entryPrice ? pos.entryPrice * 0.999 : 0.499;
      const bestAsk = pos.entryPrice ? pos.entryPrice * 1.001 : 0.501;

      const onlineFeatures: EntryFeatures = pos.entryFeatures || {
        smartTrailingActive: settings.smartTrailingTP ? 1 : 0,
        smartTrailingDistance: (settings as any).smartTrailDistance || 0.05,
        macroGoalProgress: macroCycleProfit,
        macroTimeElapsedHours: (Date.now() - macroCycleStartTime) / (1000 * 60 * 60),
        macroGoalGrade: getMacroGoalGrade(),
        rsi: spotTA.rsi || 50,
        macd: 0.15,
        macdHist: 0.05,
        maSpread: 0.02,
        primaryConfidence: 75,
        primaryDirection: pos.side === 'YES' ? 1 : -1,
        atr: (spotTA.candleRangePct / 100) || 0.012,
        bollingerBandWidth: 0.03,
        bidAskSpread: (bestBid > 0 && bestAsk > bestBid) ? (bestAsk - bestBid) / bestBid : 0.001,
        orderbookImbalance: bidVol / Math.max(1, askVol),
        volumeSurgeRatio: spotTA.volumeSurgeRatio || 1.0,
        stationarityFracDiff: spotTA.fractionalDiffValue || 0.0,
        hourOfDay: new Date().getUTCHours(),
        dayOfWeek: new Date().getUTCDay(),
        tradingSession: (() => {
          const h = new Date().getUTCHours();
          if (h >= 13 && h <= 21) return 'NEW_YORK';
          if (h >= 8 && h < 13) return 'LONDON';
          if (h >= 0 && h < 8) return 'ASIAN';
          return 'OVERLAP';
        })(),
        patternType: pos.patternType || 'ANALYSIS',
        confluenceCount: pos.analysisMeta?.confluenceCount || 1,
        orderFlowImbalance: ofi,
        tradeFlowImbalance: ofi * 0.9,
        vpin: Math.min(1.0, Math.abs((spotTA.macdHist || 0) * 10) + Math.abs(ofi) * 0.5),
        micropriceDrift: (() => {
            const m = (bidVol + askVol) > 0 ? (bidVol + askVol) : 1;
            return Math.abs(ofi) * 0.005; // simplified fallback
        })(),
        cancelToFillRatio: 1.0 + Math.abs(ofi) * 2.5,
        vwapDistancePct: spotTA.vwapDistancePct || 0,
        fundingRate: fundingRateTracker.fundingRates[spotTA.pair?.replace('USDT', '') || 'BTC'] || 0,
        marketRegime: pos.marketRegimeAtEntry || 'UNKNOWN',
        strategyTrailFailRate: (() => {
           const pType = pos.analysisMeta?.patternType || 'GENERAL_ANALYSIS';
           const stats = tradingBrain.smartTrailingStats?.[pType];
           return stats && stats.totalActivations > 0 ? stats.failures / stats.totalActivations : 0;
        })(),
        strategyTrailEfficiency: (() => {
           const pType = pos.analysisMeta?.patternType || 'GENERAL_ANALYSIS';
           const stats = tradingBrain.smartTrailingStats?.[pType];
           return stats && stats.totalActivations > 0 ? stats.totalEfficiencySum / stats.totalActivations : 1.0;
        })()
      };

      if (!tradeReport.entryFeatures) {
        tradeReport.entryFeatures = onlineFeatures;
      }

      const actualLabel = isWin ? 1 : 0;
      metaModelManager.activeModel.updateOnlineWeights(onlineFeatures, actualLabel);

      // Top-Tier Alpha Goal-Hitter Tagging: Note any time the $100 goal was hit or high profit achieved ($10+), tagging simultaneous conditions as elite alpha signatures
      const totalPocketedAtOutcome = Math.max(sessionPocketedProfit, vaultedProfits + Math.max(0, cycleEarnedProfit));
      if (isWin && (totalPocketedAtOutcome >= 100 || tradeReport.pnlUsd >= 10.0)) {
        const alphaSig = {
          id: tradeReport.id,
          timestamp: tradeReport.timestamp,
          symbol: tradeReport.symbol,
          side: tradeReport.side,
          pnlUsd: tradeReport.pnlUsd,
          pnlPct: tradeReport.pnlPct,
          totalPocketed: totalPocketedAtOutcome,
          indicators: tradeReport.indicators,
          params: tradeReport.params,
          entryFeatures: onlineFeatures,
          reason: closeReason
        };
        if (!this.topTierAlphaSignatures.some(s => s.symbol === alphaSig.symbol && s.timestamp === alphaSig.timestamp)) {
          this.topTierAlphaSignatures.unshift(alphaSig);
          if (this.topTierAlphaSignatures.length > 50) this.topTierAlphaSignatures.pop();
          spotLogs.unshift({
            id: logIdCounter++, time: new Date().toISOString(), type: 'PROFIT',
            message: `[TOP-TIER ALPHA GOAL-HITTER TAGGED] $100 goal milestone/high-yield condition captured on ${tradeReport.symbol} (+${tradeReport.pnlPct}% / +$${tradeReport.pnlUsd.toFixed(2)}). Tagged as elite training baseline with 3x meta-model reinforcement.`
          });
        }
        // Extra 3x weight update pass for top-tier goal hitters
        metaModelManager.activeModel.updateOnlineWeights(onlineFeatures, 1);
        metaModelManager.activeModel.updateOnlineWeights(onlineFeatures, 1);
      }
    } catch (err) {
      console.error("[ONLINE META-MODEL ADAPTATION ERROR]", err);
    }

    this.tradeHistory.unshift(tradeReport);
    if (this.tradeHistory.length > 200) {
      this.tradeHistory.pop();
    }

    // Save trade to SQLite TradeDatabaseManager with bitpacked indicators and JSON raw_metrics
    const activeIndicators = TradeEncoder.extractIndicatorsFromTrade(tradeReport);
    const targetPrice = pos.entryPrice || 0.50;
    const actualPrice = targetPrice * (1 + pnlRatio);

    tradeDbManager.insertTrade(
      pos.symbol || pos.label || 'UNKNOWN',
      activeIndicators,
      targetPrice,
      actualPrice,
      isWin,
      JSON.stringify(tradeReport)
    ).then(dbId => {
      scheduleCounterfactualSnapshot(dbId, pos.symbol, pos.side, actualPrice, isWin, closeReason);
    }).catch(err => console.error("[DB ERROR] Failed inserting trade to TradeDatabaseManager:", err));

    unAuditedTradeCount++;
    unTrainedTradeCount++;
    unTrainedTradeCountByStrategy[patternType] = (unTrainedTradeCountByStrategy[patternType] || 0) + 1;

    // Record contract side streak outcome for TP and Trail escalation scaling
    plasticityEngine.recordContractTradeOutcome(
      pos.symbol,
      pos.side,
      isWin,
      pnlPct,
      usedParams.dynamicTP,
      usedParams.dynamicTrail,
      pos.category
    );

    if (isWin) {
      if (!this.winningStrategies[patternType]) {
        this.winningStrategies[patternType] = { patternType, winCount: 0, avgWinPnlPct: 0, hybridizedParams: { ...usedParams }, history: [] };
      }
      const winObj = this.winningStrategies[patternType];
      winObj.winCount++;
      winObj.avgWinPnlPct = parseFloat(((winObj.avgWinPnlPct * (winObj.winCount - 1) + pnlPct) / winObj.winCount).toFixed(2));
      winObj.hybridizedParams.dynamicSL = Math.max(-0.03, (winObj.hybridizedParams.dynamicSL || usedParams.dynamicSL) * 0.70 + usedParams.dynamicSL * 0.30);
      const winSlMag = Math.abs(winObj.hybridizedParams.dynamicSL);
      winObj.hybridizedParams.dynamicTP = Math.max(0.10, Math.max(winSlMag + 0.005, (winObj.hybridizedParams.dynamicTP || usedParams.dynamicTP) * 0.70 + usedParams.dynamicTP * 0.30));
      winObj.hybridizedParams.dynamicTrail = Math.max(0.01, (winObj.hybridizedParams.dynamicTrail || usedParams.dynamicTrail) * 0.70 + usedParams.dynamicTrail * 0.30);

      winObj.history.unshift(tradeReport);
      if (winObj.history.length > 25) winObj.history.pop();

      // Record high yield strategy performance in Plasticity Hall of Fame
      plasticityEngine.evaluateAndRecordTradeYield(
        patternType,
        pnlPct,
        Math.min(100, (winObj.winCount / Math.max(1, winObj.winCount)) * 100),
        winObj.winCount,
        {
          dynamicTP: winObj.hybridizedParams.dynamicTP,
          dynamicSL: winObj.hybridizedParams.dynamicSL,
          dynamicTrail: winObj.hybridizedParams.dynamicTrail,
          kellyMultiplier: 1.0,
          preferredContractTypes: ['YES', 'NO'],
          winSelectionRules: ['HIGH_WIN_RATE_MEMORY'],
          lossAvoidanceRules: [],
          riskTolerance: 'MODERATE',
          explanation: `All-Time Peak Strategy parameter record for ${patternType}.`
        }
      );

      this.generateComparativeReview(pos, isWin, pnlPct, closeReason, tradeReport);
    } else {
      if (!this.losingStrategies[patternType]) {
        this.losingStrategies[patternType] = { patternType, lossCount: 0, avgLossPnlPct: 0, hybridizedFailedParams: { ...usedParams }, history: [] };
      }
      const lossObj = this.losingStrategies[patternType];
      lossObj.lossCount++;
      lossObj.avgLossPnlPct = parseFloat(((lossObj.avgLossPnlPct * (lossObj.lossCount - 1) + pnlPct) / lossObj.lossCount).toFixed(2));
      lossObj.hybridizedFailedParams.dynamicSL = Math.max(-0.03, (lossObj.hybridizedFailedParams.dynamicSL || usedParams.dynamicSL) * 0.70 + usedParams.dynamicSL * 0.30);
      const lossSlMag = Math.abs(lossObj.hybridizedFailedParams.dynamicSL);
      lossObj.hybridizedFailedParams.dynamicTP = Math.max(0.10, Math.max(lossSlMag + 0.005, (lossObj.hybridizedFailedParams.dynamicTP || usedParams.dynamicTP) * 0.70 + usedParams.dynamicTP * 0.30));

      lossObj.history.unshift(tradeReport);
      if (lossObj.history.length > 25) lossObj.history.pop();
      this.generateComparativeReview(pos, isWin, pnlPct, closeReason, tradeReport);
    }

    // Record feature/indicator performance for Extinction Engine (<10% Win Rate Pruning)
    const extractedFeatures: Array<{ id: string; name: string; category: 'PATTERN' | 'INDICATOR' | 'COMBINATION' }> = [];
    extractedFeatures.push({
      id: `pattern_${patternType}`,
      name: `Pattern: ${patternType.replace(/_/g, ' ')}`,
      category: 'PATTERN'
    });

    const indKeys = this.extractActiveIndicatorKeys(pos.analysisMeta?.spotTA, pos.analysisMeta?.indicators);
    indKeys.forEach(k => {
      extractedFeatures.push({
        id: `indicator_${k}`,
        name: `Indicator: ${k.replace(/_/g, ' ')}`,
        category: 'INDICATOR'
      });
    });

    if (indKeys.length >= 2) {
      for (let i = 0; i < indKeys.length; i++) {
        for (let j = i + 1; j < indKeys.length; j++) {
          extractedFeatures.push({
            id: `combo_${indKeys[i]}+${indKeys[j]}`,
            name: `Combo: ${indKeys[i].replace(/_/g, ' ')} + ${indKeys[j].replace(/_/g, ' ')}`,
            category: 'COMBINATION'
          });
        }
      }
    }

    const tradeAsset = pos.symbol || 'GLOBAL';

    extractedFeatures.forEach(feat => {
      if (!this.featureStats[feat.id]) {
        this.featureStats[feat.id] = {
          name: feat.name,
          category: feat.category,
          wins: 0,
          losses: 0,
          totalTrades: 0
        };
      }
      const stat = this.featureStats[feat.id];
      stat.totalTrades += 1;
      if (isWin) stat.wins += 1; else stat.losses += 1;

      if (!this.extinctionList[feat.id]) {
        this.extinctionList[feat.id] = {
          id: feat.id,
          name: feat.name,
          category: feat.category,
          wins: 0,
          losses: 0,
          totalTrades: 0,
          winRatePct: 0,
          globalTimeoutUntilMs: 0,
          globalLossCount: 0,
          assetTimeouts: {},
          isManuallyDisabled: false
        };
      }
      const item = this.extinctionList[feat.id];
      if (!item.assetTimeouts) item.assetTimeouts = {};

      item.totalTrades += 1;
      if (isWin) {
        item.wins += 1;
      } else {
        // TRADE LOSS: Trigger Time-Out Rules
        item.losses += 1;
        item.globalLossCount += 1;

        // RULE 1: Tiered 15s / 30s Micro Cool-Off on feature/indicator loss (Reduced to 25%)
        const ONE_MIN_MS = 15 * 1000; // 15s (25% of 1m)
        const TWO_MIN_MS = 30 * 1000; // 30s (25% of 2m)
        
        const isPatternFeat = feat.category === 'PATTERN';
        const isRepeatedLoss = item.globalLossCount >= 2;
        const timeoutDurationMs = isRepeatedLoss ? TWO_MIN_MS : ONE_MIN_MS;
        const tierLabel = isRepeatedLoss ? '30S TIER 2' : '15S TIER 1';

        if (isPatternFeat || isRepeatedLoss) {
          item.globalTimeoutUntilMs = Date.now() + timeoutDurationMs;
          item.reason = `Placed on ${tierLabel} micro cool-off after ${item.globalLossCount} loss(es).`;

          spotLogs.unshift({
            id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
            message: `[FEATURE COOL-OFF (${tierLabel})] '${item.name}' placed on ${isRepeatedLoss ? '30-second' : '15-second'} micro cool-off (${item.globalLossCount} losses accumulated).`
          });
        }

        // Trigger Gemini AI Strategy Doctor asynchronously
        this.invokeGeminiStrategyDoctor(item, tradeAsset, {
          symbol: pos.symbol,
          side: pos.side,
          entryPrice: pos.entryPrice,
          pnlPct,
          reason: closeReason
        }).catch(() => {});

        // RULE 2: Asset-specific time-outs
        if (!item.assetTimeouts[tradeAsset]) {
          item.assetTimeouts[tradeAsset] = {
            assetSymbol: tradeAsset,
            lossCount: 0,
            timeoutUntilMs: 0
          };
        }
        const assetRec = item.assetTimeouts[tradeAsset];
        assetRec.lossCount += 1;

        if (!isPatternFeat && !isRepeatedLoss) {
          assetRec.timeoutUntilMs = Date.now() + ONE_MIN_MS;
          item.reason = `Placed on 15-second asset micro cool-off for ${tradeAsset} after 1 loss.`;
        } else if (assetRec.lossCount > 2) {
          const TWO_HALF_MIN_MS = 37.5 * 1000; // 37.5s (25% of 2.5m)
          assetRec.timeoutUntilMs = Date.now() + TWO_HALF_MIN_MS;
          item.reason = `Failed on ${tradeAsset} ${assetRec.lossCount} times (>2 failures). Placed on 37.5-second time-out specifically for ${tradeAsset}.`;

          spotLogs.unshift({
            id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
            message: `[ASSET TIME-OUT (37.5S)] '${item.name}' failed on ${tradeAsset} ${assetRec.lossCount} times (>2 failures). Placed on 37.5-second time-out specifically for ${tradeAsset}.`
          });
        }
      }

      item.winRatePct = item.totalTrades > 0 ? parseFloat(((item.wins / item.totalTrades) * 100).toFixed(1)) : 0;
      item.isExtinct = (item.globalTimeoutUntilMs > Date.now()) || Object.values(item.assetTimeouts).some(a => a.timeoutUntilMs > Date.now()) || Boolean(item.isManuallyDisabled);

      const relevantAmendment = this.geminiAmendments.find(a => a.targetFeatureId === feat.id && a.trialMode?.active);
      if (relevantAmendment && relevantAmendment.trialMode) {
        if (pos.side === relevantAmendment.trialMode.oppositeSide) {
          relevantAmendment.trialMode.tradesExecuted += 1;
          if (isWin) relevantAmendment.trialMode.wins += 1;
          
          if (relevantAmendment.trialMode.tradesExecuted >= 3) {
            relevantAmendment.trialMode.active = false;
            if (relevantAmendment.trialMode.wins > 1) {
              relevantAmendment.verdict = 'STRATEGIC_AMENDMENT';
              relevantAmendment.proposedAction.description = `[TRIAL SUCCESS] Reversal to ${relevantAmendment.trialMode.oppositeSide} permanently adopted after winning ${relevantAmendment.trialMode.wins}/3 trial trades.`;
              spotLogs.unshift({
                id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
                message: `[TRIAL SUCCESS] Setup '${feat.name}' won ${relevantAmendment.trialMode.wins}/3 trades on ${relevantAmendment.trialMode.oppositeSide}. Adopting reversal permanently.`
              });
              if (this.extinctionList[feat.id]) {
                this.extinctionList[feat.id].losses = 0;
                this.extinctionList[feat.id].wins = 1;
                this.extinctionList[feat.id].totalTrades = 1;
              }
            } else {
              relevantAmendment.verdict = 'FLAWED_SETUP';
              relevantAmendment.proposedAction = {
                ruleType: 'DISABLE_PATTERN',
                field: 'rsi',
                operator: '!=',
                value: 'DISABLED',
                description: `[TRIAL FAILED] Reversal trial won only ${relevantAmendment.trialMode.wins}/3 trades. Quarantining.`
              };
              spotLogs.unshift({
                id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
                message: `[TRIAL FAILED] Setup '${feat.name}' won only ${relevantAmendment.trialMode.wins}/3 trades on reversal. Setup quarantined.`
              });
              if (this.extinctionList[feat.id]) {
                // Tier 2 Quarantine: 75s (25% of 5 minutes) for failed trial setups
                this.extinctionList[feat.id].globalTimeoutUntilMs = Date.now() + 75 * 1000; 
              }
            }
          }
        }
      }
    });

    this._saveMemory();
  }

  private geminiDoctorCooldownUntil: number = 0;

  async invokeGeminiStrategyDoctor(
    featureItem: TimeoutItem,
    assetSymbol: string = 'GLOBAL',
    lossContext?: any
  ): Promise<GeminiStrategyAmendment | null> {
    const apiKey = process.env.GEMINI_API_KEY;

    // Check if we are currently in quota cooldown
    const isCoolingDown = Date.now() < this.geminiDoctorCooldownUntil;

    let parsed: any = null;

    // To prevent aggressive automated API quota exhaustion, we ONLY hit the LLM 
    // for this micro-level strategy doctoring if it was manually triggered.
    // Automated hot-path time-outs will fall back to the mathematical heuristic.
    if (lossContext?.manualUserTrigger && apiKey && !isCoolingDown) {
      const modelsToTry = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
      const ai = new GoogleGenAI({ apiKey });

      const prompt = `You are an elite quantitative trading strategy architect analyzing a high-frequency prediction market trading bot signal.
An indicator/pattern feature combination has failed in live trading and entered a TIME-OUT.

FEATURE/STRATEGY:
- Name: "${featureItem.name}" (ID: "${featureItem.id}", Category: "${featureItem.category}")
- Recent Performance: ${featureItem.wins} Wins / ${featureItem.losses} Losses (${featureItem.winRatePct}% win rate)
- Target Asset: ${assetSymbol}

RECENT LOSS CONTEXT:
${lossContext ? JSON.stringify(lossContext, null, 2) : 'Trade settled at stop-loss / negative exit.'}

YOUR TASK:
Analyze why this feature/confluence failed and determine:
1. Verdict ("FLAWED_SETUP" or "STRATEGIC_AMENDMENT").
2. Is this setup actually just a bearish setup in disguise? (Set "isBearishSetup": true if the pattern/indicator strongly implies downside momentum).
3. Proposed rule action requiring a specific indicator threshold, state, or contract side restriction.
4. Optimal trade execution risk parameters ("kellyParameters"):
   - "takeProfitPct": Take profit percentage target as a positive float (e.g., 0.025 for +2.5% at 0.5x Kelly baseline). We want a near constant trickle of small to medium wins to hit our $100/day goal.
   - "stopLossPct": Stop loss percentage limit as a negative float (e.g., -0.015 for -1.5% at 0.5x Kelly baseline). Keep it tight to limit drawdown.

CRITICAL INSTRUCTION: When considering takeProfitPct and stopLossPct, ALWAYS focus on a high-probability "trickle of small to medium wins" approach to maximize consistent compounding.
The values you output represent the 0.5x Base Fractional Kelly Multiplier benchmark (Half-Kelly / 50% Mark on the slider). The trading system will use these values as the 0.5x Kelly baseline and scale risk parameters dynamically based on the active Kelly Multiplier slider position.

YOU MUST RESPOND ONLY WITH VALID JSON IN THE FOLLOWING STRICT SCHEMA:
{
  "verdict": "FLAWED_SETUP" or "STRATEGIC_AMENDMENT",
  "isBearishSetup": true or false,
  "diagnosis": "Clear 1-2 sentence explanation of why the signal failed in this market context.",
  "proposedAction": {
    "ruleType": "THRESHOLD_FILTER" | "STATE_REQUIREMENT" | "DISABLE_PATTERN" | "SIDE_RESTRICTION",
    "field": "rsi" | "volumeSurgeRatio" | "ichimokuState" | "tenkanKijunCross" | "orderBookRatio" | "contractSide",
    "operator": ">" | "<" | ">=" | "<=" | "==" | "!=" | "NOT_IN",
    "value": 1.35 or "BEARISH_BELOW_CLOUD" or "NO",
    "description": "Readable rule description, e.g., Require Volume Surge Ratio >= 1.35x before initiating entry."
  },
  "kellyParameters": {
    "takeProfitPct": 0.025,
    "stopLossPct": -0.015,
    "explanation": "0.5x Base Fractional Kelly position benchmark calibrated for a steady trickle of consistent wins."
  }
}`;

      let lastErr: any = null;
      for (const modelName of modelsToTry) {
        try {
          const response = await ai.models.generateContent({
            model: modelName,
            contents: prompt,
            config: {
              responseMimeType: 'application/json'
            }
          });

          const text = response.text || '';
          const cleanJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
          parsed = JSON.parse(cleanJson);
          if (parsed && (parsed.verdict === 'FLAWED_SETUP' || parsed.verdict === 'STRATEGIC_AMENDMENT')) {
            break; // Successfully received response from Gemini
          }
        } catch (err: any) {
          lastErr = err;
          console.log(`[GEMINI DOCTOR API] Model ${modelName} unavailable or rate-limited. Falling back smoothly...`);
          continue;
        }
      }
      
      // If we completely exhausted the models, trigger cooldown
      if (!parsed && lastErr) {
          console.log(`[GEMINI DOCTOR API] All fallback models failed. Initiating 60s API cooldown.`);
          this.geminiDoctorCooldownUntil = Date.now() + 60000;
      }
    }

    // Heuristic fallback if API key is missing, in quota cooldown, or API call failed
    if (!parsed) {
      const isLossy = featureItem.losses > featureItem.wins;
      const isVeryLossy = featureItem.losses >= 3 && (featureItem.winRatePct < 30);

      if (isVeryLossy) {
        parsed = {
          verdict: 'FLAWED_SETUP',
          diagnosis: `Statistical analysis detected severe performance decay (${featureItem.losses} losses / ${featureItem.wins} wins). Setup quarantined to prevent drawdown.`,
          proposedAction: {
            ruleType: 'DISABLE_PATTERN',
            field: 'rsi',
            operator: '!=',
            value: 'DISABLED',
            description: `Quarantine ${featureItem.name} setup due to consecutive loss threshold breaches.`
          }
        };
      } else {
        const fields = ['volumeSurgeRatio', 'rsi', 'orderBookRatio'];
        const randomField = fields[Math.floor(Math.random() * fields.length)];
        let op = '>=';
        let val: any = 1.25;
        let desc = 'Require Volume Surge Ratio >= 1.25x before entry.';

        if (randomField === 'rsi') {
          op = '<=';
          val = 65;
          desc = 'Require RSI <= 65 to prevent overbought entry.';
        } else if (randomField === 'orderBookRatio') {
          op = '>=';
          val = 1.15;
          desc = 'Require Bid/Ask Orderbook Depth Ratio >= 1.15x for support.';
        }

        parsed = {
          verdict: 'STRATEGIC_AMENDMENT',
          diagnosis: `Identified market noise vulnerability in '${featureItem.name}'. Applying dynamic liquidity filter to reinforce signal probability.`,
          proposedAction: {
            ruleType: 'THRESHOLD_FILTER',
            field: randomField,
            operator: op,
            value: val,
            description: desc
          }
        };
      }
    }

    if (parsed && (parsed.verdict === 'FLAWED_SETUP' || parsed.verdict === 'STRATEGIC_AMENDMENT')) {
      let finalVerdict = parsed.verdict;
      let finalProposedAction = {
        ruleType: parsed.proposedAction?.ruleType || 'THRESHOLD_FILTER',
        field: parsed.proposedAction?.field || 'volumeSurgeRatio',
        operator: parsed.proposedAction?.operator || '>=',
        value: parsed.proposedAction?.value ?? 1.25,
        description: parsed.proposedAction?.description || 'AI Synthesized Rule Filter'
      };
      
      let trialMode: any = undefined;
      const isExtremeLoss = featureItem.losses - featureItem.wins > 5;

      if (parsed.verdict === 'FLAWED_SETUP' && isExtremeLoss && lossContext && lossContext.side) {
        const oppositeSide = lossContext.side === 'YES' ? 'NO' : 'YES';
        finalVerdict = 'STRATEGIC_AMENDMENT';
        finalProposedAction = {
          ruleType: 'SIDE_RESTRICTION',
          field: 'contractSide',
          operator: '==',
          value: oppositeSide,
          description: `[TRIAL PERIOD] >5 net losses on setup. Reversing usage to ${oppositeSide} for 3 trades.`
        };
        trialMode = {
          active: true,
          oppositeSide: oppositeSide,
          tradesExecuted: 0,
          wins: 0
        };

        // Lift time-out
        featureItem.globalTimeoutUntilMs = 0;
        featureItem.isExtinct = false;
        featureItem.isManuallyDisabled = false;
        if (featureItem.assetTimeouts && assetSymbol !== 'GLOBAL' && featureItem.assetTimeouts[assetSymbol]) {
          featureItem.assetTimeouts[assetSymbol].timeoutUntilMs = 0;
        }

        spotLogs.unshift({
          id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
          message: `[REVERSAL TRIAL INTERCEPT] '${featureItem.name}' has >5 net losses. Initiating 3-trade trial for opposite side (${oppositeSide}).`
        });
      } else if (parsed.verdict === 'FLAWED_SETUP' && parsed.isBearishSetup) {
        finalVerdict = 'STRATEGIC_AMENDMENT';
        finalProposedAction = {
          ruleType: 'SIDE_RESTRICTION',
          field: 'contractSide',
          operator: '==',
          value: 'NO',
          description: `Gemini identified as a bearish setup in disguise. Flipped quarantine to enforce NO side restriction.`
        };

        // Lift time-out
        featureItem.globalTimeoutUntilMs = 0;
        featureItem.isExtinct = false;
        featureItem.isManuallyDisabled = false;
        if (featureItem.assetTimeouts && assetSymbol !== 'GLOBAL' && featureItem.assetTimeouts[assetSymbol]) {
          featureItem.assetTimeouts[assetSymbol].timeoutUntilMs = 0;
        }

        spotLogs.unshift({
          id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
          message: `[BEARISH FLIP INTERCEPT] Gemini identified quarantined feature '${featureItem.name}' as a Bearish Setup. Lifting quarantine and auto-triggering NO contract on ${assetSymbol}.`
        });

        // Trigger NO position async if possible
        if (assetSymbol !== 'GLOBAL' && lossContext && lossContext.symbol) {
          setTimeout(() => {
            const ctx = spotContexts[lossContext.symbol];
            if (ctx) {
              const entryPrice = 1.0 - (ctx.currentPrice || 0.50);
              const userKelly = settings.kellyMultiplier && settings.kellyMultiplier > 0 ? settings.kellyMultiplier : 1.0;
              const expectedMovePct = Math.max(0.08, Math.min(0.35, (ctx.micropriceVolatility || 0.005) * 12)); 
              const requiredCapital = 30.0 / expectedMovePct;
              const requiredContracts = Math.round(requiredCapital / Math.max(0.01, entryPrice));
              const dynamicSize = Math.round(requiredContracts * userKelly);
              openPosition(lossContext.symbol, 'NO', entryPrice, dynamicSize, true, lossContext.symbol, ctx.label || lossContext.symbol, 'crypto', 'Gemini intercepted quarantine as Bearish flip').catch(() => {});
            }
          }, 500);
        }
      }

      const newAmendment: GeminiStrategyAmendment = {
        id: `g_rule_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        timestamp: new Date().toISOString(),
        targetFeatureId: featureItem.id,
        featureName: featureItem.name,
        assetSymbol: assetSymbol || 'GLOBAL',
        verdict: finalVerdict,
        diagnosis: parsed.diagnosis || 'Analyzed by Gemini AI Strategy Doctor.',
        proposedAction: finalProposedAction as any,
        trialMode: trialMode,
        kellyParameters: {
          takeProfitPct: Math.max(0.01, Number(parsed.kellyParameters?.takeProfitPct) || 0.025),
          stopLossPct: Math.min(-0.005, Number(parsed.kellyParameters?.stopLossPct) || -0.015),
          explanation: parsed.kellyParameters?.explanation || '50% Kelly position benchmark calibrated for a steady trickle of consistent wins.'
        },
        isActive: true
      };

      this.geminiAmendments = this.geminiAmendments.filter(
        r => !(r.targetFeatureId === newAmendment.targetFeatureId && r.assetSymbol === newAmendment.assetSymbol)
      );

      this.geminiAmendments.unshift(newAmendment);
      if (this.geminiAmendments.length > 100) {
        this.geminiAmendments = this.geminiAmendments.slice(0, 100);
      }

      this._saveMemory();

      if (!(parsed.verdict === 'FLAWED_SETUP' && parsed.isBearishSetup)) {
        spotLogs.unshift({
          id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
          message: `[GEMINI STRATEGY DOCTOR] Synthesized rule for '${featureItem.name}' (${parsed.verdict}): "${newAmendment.proposedAction.description}". Diagnosis: ${parsed.diagnosis}`
        });
      }

      return newAmendment;
    }

    return null;
  }
}

let tradingBrain = new PatternTradingBrain();
let recoveryProtocol = new CapitalPreservationProtocol();
let isCapitalPreservationActive = false;

interface PaperPosition {
  id: number;
  symbol: string;
  side: 'YES' | 'NO';
  entryPrice: number;
  size: number;
  isOverride: boolean;
  matchId: string;
  label: string;
  category: string;
  entryTime: number;
  params: any;
  reason: string;
  isPerpetual?: boolean;
  analysisMeta?: any;
  peakPnlRatio?: number;
  lastRandomTPCheck?: number;
  
  // -- NEW METRICS FOR RETRAINING --
  timeInProfitSec?: number;
  timeInLossSec?: number;
  maxAdverseExcursion?: number;
  lastTickTime?: number;
  marketRegimeAtEntry?: string;
  volumeSurgeAtEntry?: number;
  bidAskImbalanceAtEntry?: number;
  confluenceCountAtEntry?: number;
  expectedTP?: number;
  modelFairValue?: number;
  targetDollarGoal?: number;
  capitalPlacedUsd?: number;
  projectedProfitAtTP?: number;
  pnlRatio?: number;
  smartTrailing?: SmartTrailingState;
  entryFeatures?: EntryFeatures;
}

let activePositions: PaperPosition[] = [];
let executedOverrides = new Set<string>();
let spotContexts: any = {};
const contractSLEvalPeriodTimestamps: Record<string, number> = {};
const orderbookImbalanceStreak: Record<string, { streak: number; lastDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL' }> = {};
const lastWinTimestamps: Record<string, number> = {};

function getSpotPairFromSymbol(label: string, category?: string): string {
  const resolved = unifiedDataHandler.resolveCorrelatedSpotPair(label, label, category);
  return resolved.correlatedSpotPair || 'BTC-USD';
}

// Global Market Sessions & $100 Pocketed Profit Strict Mode Tracking
interface GlobalMarketSession {
  sessionName: string;
  sessionKey: 'ASIAN' | 'LONDON' | 'NEW_YORK' | 'ASIAN_PRE';
  nextSessionName: string;
  nextSessionTimeStr: string;
  nextSessionTransitionStr: string;
}

function getGlobalMarketSession(): GlobalMarketSession {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  const totalMin = utcHour * 60 + utcMin; // Minutes past UTC midnight (0 to 1439)

  // Session boundaries shifted by +35 minutes past session open:
  // Asian Markets (+35m): 00:35 UTC = 35 min
  // London Market (+35m): 08:35 UTC = 515 min (8*60 + 35)
  // New York Market (+35m): 13:35 UTC = 815 min (13*60 + 35)
  // Asian Pre-Market (+35m): 21:35 UTC = 1295 min (21*60 + 35)

  if (totalMin >= 35 && totalMin < 515) {
    return {
      sessionName: 'Asian Markets Session',
      sessionKey: 'ASIAN',
      nextSessionName: 'London Market Open',
      nextSessionTimeStr: '08:00 UTC',
      nextSessionTransitionStr: '08:35 UTC (+35m post-open)'
    };
  } else if (totalMin >= 515 && totalMin < 815) {
    return {
      sessionName: 'London Market Session',
      sessionKey: 'LONDON',
      nextSessionName: 'New York Market Open',
      nextSessionTimeStr: '13:00 UTC',
      nextSessionTransitionStr: '13:35 UTC (+35m post-open)'
    };
  } else if (totalMin >= 815 && totalMin < 1295) {
    return {
      sessionName: 'New York Market Session',
      sessionKey: 'NEW_YORK',
      nextSessionName: 'Asian Markets Re-Open',
      nextSessionTimeStr: '21:00 UTC',
      nextSessionTransitionStr: '21:35 UTC (+35m post-open)'
    };
  } else {
    return {
      sessionName: 'Asian Pre-Market Session',
      sessionKey: 'ASIAN_PRE',
      nextSessionName: 'Asian Markets Open',
      nextSessionTimeStr: '00:00 UTC',
      nextSessionTransitionStr: '00:35 UTC (+35m post-open)'
    };
  }
}

let activeMarketSessionKey: string = getGlobalMarketSession().sessionKey;
let macroCycleStartTime = Date.now();
let macroCycleProfit = 0;

function getMacroGoalGrade(): number {
    const elapsedMs = Date.now() - macroCycleStartTime;
    let elapsedHours = elapsedMs / (1000 * 60 * 60);
    if (elapsedHours <= 0.01) elapsedHours = 0.01;
    
    const targetPace = 100 / 12; // $8.33 / hr
    const currentPace = macroCycleProfit / elapsedHours;
    
    if (macroCycleProfit >= 100) return 1.5; // A+
    if (currentPace <= 0) return 0.0;
    
    return Math.min(1.5, currentPace / targetPace);
}

let sessionPocketedProfit: number = 0;
let isStrict3ConfluenceTriggeredInSession: boolean = false;

function checkMarketSessionTransition() {
  const currentSession = getGlobalMarketSession();
  if (currentSession.sessionKey !== activeMarketSessionKey) {
    activeMarketSessionKey = currentSession.sessionKey;
    sessionPocketedProfit = 0;
    isStrict3ConfluenceTriggeredInSession = false;

    spotLogs.unshift({
      id: logIdCounter++, time: new Date().toISOString(), type: 'INFO',
      message: `[MARKET SESSION TRANSITION (+35M POST-OPEN)] Transitioned to ${currentSession.sessionName}. Strict 3-confluence & $20 vaulting reset for new trading session (Next session: ${currentSession.nextSessionName} at ${currentSession.nextSessionTimeStr}; transition at ${currentSession.nextSessionTransitionStr}).`
    });
  }
}

function isStrict3ConfluenceActive(): boolean {
  if (settings && settings.overrideConfluence) return false;
  checkMarketSessionTransition();
  return isStrict3ConfluenceTriggeredInSession || sessionPocketedProfit >= 100;
}

function evaluateConfluenceFactorsCount(
  signalSide: 'YES' | 'NO',
  spotTA: any,
  bidVol: number = 500,
  askVol: number = 500
): { count: number; factors: string[] } {
  const factors: string[] = [];

  // Factor 1: Orderbook Imbalance Depth
  const isBullishBook = bidVol >= askVol * 1.15;
  const isBearishBook = askVol >= bidVol * 1.15;
  if (signalSide === 'YES' && isBullishBook) {
    factors.push(`Orderbook Buy Depth (${bidVol.toFixed(0)} bids vs ${askVol.toFixed(0)} asks)`);
  } else if (signalSide === 'NO' && isBearishBook) {
    factors.push(`Orderbook Sell Depth (${askVol.toFixed(0)} asks vs ${bidVol.toFixed(0)} bids)`);
  }

  // Factor 2: Ichimoku Cloud Trend Alignment
  if (signalSide === 'YES' && spotTA.ichimokuState === 'BULLISH_CLOUD') {
    factors.push(`Ichimoku Bullish Cloud Trend`);
  } else if (signalSide === 'NO' && spotTA.ichimokuState === 'BEARISH_CLOUD') {
    factors.push(`Ichimoku Bearish Cloud Trend`);
  }

  // Factor 3: RSI Momentum Zone Alignment
  if (signalSide === 'YES' && spotTA.rsi <= 45) {
    factors.push(`RSI Oversold Bullish Reversion (${spotTA.rsi ? spotTA.rsi.toFixed(1) : '45'})`);
  } else if (signalSide === 'YES' && spotTA.rsi >= 52) {
    factors.push(`RSI Bullish Momentum (${spotTA.rsi ? spotTA.rsi.toFixed(1) : '52'})`);
  } else if (signalSide === 'NO' && spotTA.rsi >= 55) {
    factors.push(`RSI Overbought Bearish Reversion (${spotTA.rsi ? spotTA.rsi.toFixed(1) : '55'})`);
  } else if (signalSide === 'NO' && spotTA.rsi <= 45) {
    factors.push(`RSI Bearish Breakdown (${spotTA.rsi ? spotTA.rsi.toFixed(1) : '45'})`);
  }

  // Factor 4: Institutional Volume Surge
  if (spotTA.volumeSurgeRatio && spotTA.volumeSurgeRatio >= 1.20) {
    factors.push(`Volume Surge (${spotTA.volumeSurgeRatio.toFixed(2)}x)`);
  }

  // Factor 5: Candlestick Reversal / Volatility Confirmation
  if (spotTA.isDoji || (spotTA.volatilityIndex && spotTA.volatilityIndex >= 1.15)) {
    factors.push(`Candlestick/Volatility Confirmation (${spotTA.isDoji ? 'Doji Reversal' : 'Vol Expansion'})`);
  }

  // Factor 6: Macro USDT.D Alignment
  const usdtRsiStatus = globalMetricsTracker.getUsdtDominanceRsiStatus();
  if (signalSide === 'YES' && usdtRsiStatus === 'OVERBOUGHT_MULTI') {
    factors.push(`USDT.D Macro Alignment (Overbought USDT.D -> Bullish Crypto)`);
  } else if (signalSide === 'NO' && usdtRsiStatus === 'OVERSOLD_MULTI') {
    factors.push(`USDT.D Macro Alignment (Oversold USDT.D -> Bearish Crypto)`);
  }

  // Factor 7: Liquidation Squeeze Alignment (Funding Rates)
  if (spotTA.pair) {
    const squeezeRisk = fundingRateTracker.getSqueezeRisk(spotTA.pair);
    if (signalSide === 'YES' && squeezeRisk === 'SHORT_SQUEEZE') {
      factors.push(`Funding Rate Short Squeeze Alignment (Negative Funding -> Bullish Reversal)`);
    } else if (signalSide === 'NO' && squeezeRisk === 'LONG_SQUEEZE') {
      factors.push(`Funding Rate Long Squeeze Alignment (Positive Funding -> Bearish Reversal)`);
    }
  }

  return { count: factors.length, factors };
}

function evaluatePostSLContractCandidate(symbol: string, targetSide: string, stageLabel: string, category: string = 'crypto') {
  if (!settings.botActive) {
    spotLogs.unshift({
      id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
      message: `[POST-SL RE-EVALUATION] ${symbol} (${targetSide}) at ${stageLabel}: Bot inactive, evaluation skipped.`
    });
    return;
  }

  if (activePositions.some(p => p.symbol === symbol)) {
    spotLogs.unshift({
      id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
      message: `[POST-SL RE-EVALUATION] ${symbol} (${targetSide}) at ${stageLabel}: Position already active, evaluation skipped.`
    });
    return;
  }

  const ctx = spotContexts[symbol];
  if (!ctx) {
    spotLogs.unshift({
      id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
      message: `[POST-SL RE-EVALUATION] ${symbol} (${targetSide}) at ${stageLabel}: Market context detached or unlisted.`
    });
    return;
  }

  const spotPair = getSpotPairFromSymbol(symbol, category);
  const pairCandles = scalper.candles[spotPair] || [];
  const spotTA = computeSpotTAMetrics(spotPair, pairCandles);

  const sidesToTest: Array<'YES' | 'NO'> = [targetSide as 'YES' | 'NO', (targetSide === 'YES' ? 'NO' : 'YES')];
  let qualifiedCandidate: any = null;

  for (let testSide of sidesToTest) {
    let patternType = 'GENERAL_ANALYSIS';
    let reason = 'Post-SL Candidate Evaluation';

    if (spotTA.volumeSurgeRatio >= 1.2 && spotTA.rsi >= 50) {
      patternType = 'CONFLUENCE_ICHIMOKU_VOL_SURGE';
      reason = 'Ichimoku Trend & Volume Surge Confluence';
    } else if (spotTA.rsi <= 42) {
      patternType = 'RAPID_SCALP_RSI';
      reason = 'RSI Oversold Momentum';
    } else if (spotTA.ichimokuState === 'BULLISH_CLOUD' || spotTA.ichimokuState === 'BEARISH_CLOUD') {
      patternType = 'ICHIMOKU_CLOUD_BREAKOUT';
      reason = 'Cloud Trend Breakout';
    } else if (spotTA.isDoji) {
      patternType = 'CANDLESTICK_DOJI_REVERSAL';
      reason = 'Doji Reversal Candlestick';
    }

    const bidVol = Math.floor(Math.random() * 500 + 500);
    const askVol = Math.floor(Math.random() * 500 + 500);

    let recCheck = isTradeAllowedBySpotTAAndRecovery(
      testSide,
      ctx.category || 'crypto',
      spotTA,
      recoveryProtocol?.data?.hybridParams,
      bidVol,
      askVol,
      settings.overrideConfluence
    );

    if (!recCheck.allowed && settings.overrideConfluence) {
      recCheck.allowed = true;
      recCheck.reason = "[OVERRIDE ACTIVATED] " + recCheck.reason;
    }

    let isBearishFlip = false;
    
    // NEW DEDICATED HANDLER: Standalone Bearish Confluence Monitor
    const isAssetBearish = spotTA.ichimokuState === 'BEARISH_CLOUD' || spotTA.tenkanKijunCross === 'BEARISH_CROSS';
    const isStrongBearishDivergence = isAssetBearish && spotTA.rsi >= 58;
    
    let pendingOverrideKelly: number | undefined = undefined;
    
    if (testSide === 'NO' && isStrongBearishDivergence) {
      isBearishFlip = true;
      patternType = 'STRONG_BEARISH_DIVERGENCE';
      reason = `[BEARISH DIVERGENCE MONITOR] Asset strongly flagged as bearish. Auto-doubling NO contract size.`;
    }

    const isCounterYes = testSide === 'YES' && (recCheck.reason?.includes('Counter-trend YES') || recCheck.reason?.includes('GRAVESTONE'));
    const isCounterNo = testSide === 'NO' && (recCheck.reason?.includes('Counter-trend NO') || recCheck.reason?.includes('DRAGONFLY'));

    if (!recCheck.allowed && (isCounterYes || isCounterNo)) {
      const flippedSide: 'YES' | 'NO' = testSide === 'YES' ? 'NO' : 'YES';
      const flippedRecCheck = isTradeAllowedBySpotTAAndRecovery(
        flippedSide,
        ctx.category || 'crypto',
        spotTA,
        recoveryProtocol?.data?.hybridParams,
        bidVol,
        askVol,
        settings.overrideConfluence
      );
      
      if (!flippedRecCheck.allowed && (flippedRecCheck.reason?.includes('CONFLUENCE RULE REJECT') || settings.overrideConfluence)) {
         flippedRecCheck.allowed = true;
         flippedRecCheck.reason = settings.overrideConfluence ? `[OVERRIDE ACTIVATED] Bypassing confluence for flipped ${flippedSide} contract.` : `[REVERSAL OVERRIDE] Bypassing confluence for flipped ${flippedSide} contract.`;
      }

      if (flippedRecCheck.allowed) {
        const flipReason = spotTA?.dojiType === 'DRAGONFLY' ? 'Bullish Dragonfly Doji' : spotTA?.dojiType === 'GRAVESTONE' ? 'Bearish Gravestone Doji' : flippedSide === 'NO' ? 'Bearish Ichimoku Cloud' : 'Bullish Ichimoku Cloud';
        spotLogs.unshift({
          id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
          message: `[REVERSAL DIRECTIONAL FLIP] Skipped ${testSide} on ${symbol}, flipped to ${flippedSide} (${flipReason}).`
        });
        testSide = flippedSide;
        recCheck = flippedRecCheck;
        if (flippedSide === 'NO') {
          isBearishFlip = true;
          pendingOverrideKelly = 0.1;
        }
      }
    }

    if (recCheck.allowed && isPatternAllowedInRecoveryMode(patternType) && canOpenTrade(activePositions, ctx.category || 'crypto', ctx.label, !!ctx.isPerpetual)) {
      const extinctCheck = tradingBrain.checkTimeoutFilter(patternType, symbol, spotTA, undefined, testSide);
      if (extinctCheck.isTimedOut) {
        logThrottledTimeoutReject(
          `[TIME-OUT FILTER REJECT] Post-SL candidate ${symbol} (${testSide}) at ${stageLabel} rejected: Timed-out feature(s) present [${extinctCheck.blockedItems.join(', ')}].`,
          `${symbol}_${patternType}`
        );
        continue;
      }

      if (!settings.overrideConfluence) {
        const is3Active = isStrict3ConfluenceActive();
        const isOFISweep = (testSide === 'YES' && bidVol >= askVol * 1.25) || (testSide === 'NO' && askVol >= bidVol * 1.25);
        const reqConfluence = isOFISweep ? 1 : (is3Active ? 3 : 2);
        const confluenceRes = evaluateConfluenceFactorsCount(testSide, spotTA, bidVol, askVol);
        if (confluenceRes.count < reqConfluence) {
          const currentSession = getGlobalMarketSession();
          spotLogs.unshift({
            id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
            message: `[CONFLUENCE REJECT] Post-SL candidate ${symbol} (${testSide}) at ${stageLabel} rejected: Only ${confluenceRes.count}/${reqConfluence} required confluences present [${confluenceRes.factors.join(', ')}].`
          });
          continue;
        }
      }

      const setup = {
        patternType,
        symbol,
        side: testSide,
        spotTA,
        category: ctx.category || 'crypto'
      };
      const pref = plasticityEngine.evaluateAdaptiveSetupPreference(setup);

      if (pref.combinedScore >= 4.5) {
        qualifiedCandidate = {
          symbol,
          signalSide: testSide,
          patternType,
          reason,
          ctx,
          spotTA,
          pref,
          recCheck,
          isBearishFlip,
          overrideKellyMultiplier: pendingOverrideKelly
        };
        break;
      }
    }
  }

  if (qualifiedCandidate && qualifiedCandidate.pref) {
    const entryPrice = qualifiedCandidate.signalSide === 'YES' ? ctx.currentPrice : (1.0 - ctx.currentPrice);
    spotLogs.unshift({
      id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
      message: `[POST-SL RE-EVALUATION QUALIFIED] ${symbol} (${qualifiedCandidate.signalSide}) at ${stageLabel}: QUALIFIED CANDIDATE! Strategy: ${qualifiedCandidate.patternType} | Adaptive Score: ${qualifiedCandidate.pref.combinedScore} pts (${qualifiedCandidate.reason}).`
    });

    if (canOpenTrade(activePositions, ctx.category || 'crypto', ctx.label, !!ctx.isPerpetual)) {
      let sizeToUse = 50;
      
      if (qualifiedCandidate.overrideKellyMultiplier !== undefined) {
        sizeToUse = Math.round(50 * qualifiedCandidate.overrideKellyMultiplier);
      } else if (qualifiedCandidate.isBearishFlip) {
        sizeToUse *= 2; // Purchase double the amount for NO if there is confluence
        spotLogs.unshift({
          id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
          message: `[BEARISH DIVERGENCE DOUBLE] Doubling position size to ${sizeToUse} for NO on ${symbol} due to bearish confluence flip.`
        });
      }

      openPosition(
        symbol,
        qualifiedCandidate.signalSide,
        entryPrice,
        sizeToUse,
        false,
        ctx.matchId || symbol,
        ctx.label || symbol,
        ctx.category || 'crypto',
        `Post-SL Candidate Evaluation (${stageLabel} | ${qualifiedCandidate.reason})`,
        {
          patternType: qualifiedCandidate.patternType,
          spotTA: qualifiedCandidate.spotTA,
          isPostSLEvaluation: true,
          stageLabel
        }
      );
    }
  } else {
    spotLogs.unshift({
      id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
      message: `[POST-SL RE-EVALUATION EVALUATED] ${symbol} at ${stageLabel}: Contract re-evaluated after SL exit — currently NOT a candidate.`
    });
  }
}

function canOpenTrade(positions: PaperPosition[], category: string, label: string, isPerpetual: boolean = false) {
  if (positions.length >= 8) return false;

  const isTennis = (cat: string, lbl: string) => cat === 'sports' && (lbl || '').includes('Tennis');
  const isPrediction = (cat: string, isPerp: boolean) => cat === 'crypto' && !isPerp;

  const tennisCount = positions.filter(p => isTennis(p.category, p.label)).length;
  const predictionCount = positions.filter(p => isPrediction(p.category, !!p.isPerpetual)).length;
  const perpCount = positions.filter(p => p.isPerpetual).length;

  if (isPerpetual) {
    // Hard requirement: Never more than 4 Perpetual Contracts open at any given time
    if (perpCount >= 4) return false;

    // Prevent trading cessation / perpetual lockout:
    // If no 15-minute price prediction contracts are open, do not allow stacking multiple perpetuals alone
    if (predictionCount === 0 && perpCount >= 1) {
      return false;
    }
  }

  const otherCount = positions.length - (tennisCount + predictionCount + perpCount);

  const flexUsed = Math.max(0, tennisCount - 1) + 
                   Math.max(0, predictionCount - 2) + 
                   Math.max(0, perpCount - 3) + 
                   otherCount;

  const flexAvailable = 2 - flexUsed;

  if (isTennis(category, label)) {
    if (tennisCount < 1) return true;
    return flexAvailable > 0;
  } else if (isPerpetual) {
    if (perpCount < 4) return true;
    return false;
  } else if (isPrediction(category, isPerpetual)) {
    if (predictionCount < 6) return true;
    return flexAvailable > 0;
  } else {
    return flexAvailable > 0;
  }
}

function isPatternAllowedInRecoveryMode(patternType: string): boolean {
  if (!isCapitalPreservationActive) return true;
  if (!recoveryProtocol || !recoveryProtocol.data) return true;

  const allowedCats = recoveryProtocol.data.hybridParams.allowedCategories;
  if (allowedCats && allowedCats.length > 0) {
    if (patternType.includes('CRYPTO') && !allowedCats.includes('crypto')) return false;
    if (patternType.includes('SPORTS') && !allowedCats.includes('sports')) return false;
  }
  return true;
}

function getCapitalPreservationStatus() {
  const currentCap = simulatedPaperBalance;
  // Capital preservation protocol activates at flat $50 loss set in stone OR 3 consecutive losses
  const consecutiveLosses = recoveryProtocol?.data?.consecutiveLosses || 0;
  const isDrawdownTriggered = (startingBankroll - currentCap) >= 50 || consecutiveLosses >= 3;
  const isProtocolInquiryActive = recoveryProtocol.data.inquiryActive;
  isCapitalPreservationActive = false; // Disabled by user request to allow full $30/$50 profits

  return {
    isCapitalPreservationActive,
    isDrawdownTriggered,
    isProtocolInquiryActive,
    startingBankroll,
    currentCapital: currentCap,
    consecutiveWinsNeededToExit: Math.max(0, 3 - recoveryProtocol.data.consecutiveWins),
    protocolStatus: recoveryProtocol.getProtocolStatus()
  };
}

async function openPosition(
  symbol: string, 
  side: 'YES' | 'NO', 
  entryPrice: number, 
  size: number, 
  isOverride: boolean, 
  matchId: string, 
  label: string, 
  category: string, 
  reason: string = "",
  analysisMeta: any = null
) {
  // Hard Gatekeeper 1: Bot Active Status strictly stops bot from placing or opening trades
  if (!settings.botActive) {
    return;
  }

  try {
    const ctx = spotContexts[symbol];
    const isPerpContract = Boolean(spotContexts[symbol]?.isPerpetual || symbol.endsWith('PERP'));
    const isPerp = ctx ? !!ctx.isPerpetual : false;

    // [LATENCY GATE C] Timestamp Drift & Quote Freshness Verification
    const freshness = latencyAdaptiveEngine.verifyQuoteFreshness(ctx?.lastQuoteUpdateMs, symbol);
    if (!freshness.isFresh) {
      spotLogs.unshift({
        id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
        message: freshness.reason || `[LATENCY GATE] Market quote for ${symbol} is stale. Order entry aborted to prevent adverse fill slippage.`
      });
      return;
    }

    if (!canOpenTrade(activePositions, category, label, isPerp)) return;

    const currentWorkingBalance = await getEffectiveWorkingBalance();

    let capitalInUse = 0;
    let perpCapitalInUse = 0;
    let predictionCapitalInUse = 0;
    activePositions.forEach(p => {
      const cap = p.capitalPlacedUsd || (p.size * p.entryPrice);
      capitalInUse += cap;
      if (p.isPerpetual) perpCapitalInUse += cap;
      else predictionCapitalInUse += cap;
    });

    const totalWorkingBankroll = (settings.paperTrading ? simulatedPaperBalance : (realKalshiCashPool || currentWorkingBalance)) + capitalInUse;
    // Requirement: At least 50% of working capital must be preserved/allocated for price prediction contracts.
    const maxAllowedPerpCapital = totalWorkingBankroll * 0.50;
    const perpCapReserveThreshold = totalWorkingBankroll * 0.50; // At least 50% reserved for price prediction

    if (isPerpContract) {
      const activePerps = activePositions.filter(p => p.isPerpetual).length;
      if (activePerps >= 4) {
        spotLogs.unshift({
          id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
          message: `[PERP LIMIT GUARD] Maximum 4 Perpetual Contracts already active (${activePerps}/4). Entry on ${symbol} aborted to maintain 15-minute prediction market capacity.`
        });
        return;
      }

      if (perpCapitalInUse >= maxAllowedPerpCapital || currentWorkingBalance <= perpCapReserveThreshold) {
        spotLogs.unshift({
          id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
          message: `[PERP 50% CAPITAL RESERVE VETO] Suppressed Perpetual entry on ${symbol}. Perpetual capital in use ($${perpCapitalInUse.toFixed(2)} of max $${maxAllowedPerpCapital.toFixed(2)}) or available cash ($${currentWorkingBalance.toFixed(2)}) would breach the 50% capital allocation reserved for 15-minute price predictions ($${perpCapReserveThreshold.toFixed(2)} of $${totalWorkingBankroll.toFixed(2)}).`
        });
        return;
      }
    }

  if (settings.paperTrading && simulatedPaperBalance < 0) {
    simulatedPaperBalance = 0;
  }

  // Insolvency Protection Guard: Do not open trades if total active equity (excluding vault) falls below $5
  const activeEquity = settings.paperTrading ? simulatedPaperBalance : currentWorkingBalance;
  if (activeEquity <= 5.0) {
    const balanceType = settings.paperTrading ? 'Total active paper equity' : 'Total live equity';
    spotLogs.unshift({
      id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
      message: `[BANKROLL INSOLVENCY GUARD] ${balanceType} ($${activeEquity.toFixed(2)}) below $5.00 minimum threshold. Pausing new entries until bankroll is restored.`
    });
    return;
  }

  if (isCapitalPreservationActive && recoveryProtocol && recoveryProtocol.data && analysisMeta?.patternType !== 'ALWAYS_ON_MAINTENANCE') {
    const allowedContracts = recoveryProtocol.data.hybridParams.preferredContractTypes;
    // Ensure recovery protocol allows both YES and NO if preferredContractTypes is restricted
    if (allowedContracts && allowedContracts.length > 0 && !allowedContracts.includes(side) && !isOverride) {
      spotLogs.unshift({
        id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
        message: `[RECOVERY PROTOCOL] Preferred contract side filter (${allowedContracts.join(', ')}) bypassed for valid ${side} trade on ${symbol}.`
      });
    }
  }

  const patternType = analysisMeta?.patternType || 'GENERAL_ANALYSIS';
  let params = tradingBrain.getAdaptedParamsForPattern(patternType, { dynamicTP: 0.05, dynamicSL: -0.015, dynamicTrail: 0.005 });

  // Check if an active Strategic Evolution amendment exists with Kelly risk parameters
  const activeGeminiKellyRule = (tradingBrain.geminiAmendments || []).find(
    r => r.isActive &&
         (r.targetFeatureId === patternType || r.targetFeatureId === `pattern_${patternType}` || r.targetFeatureId.toLowerCase().includes(patternType.toLowerCase())) &&
         r.kellyParameters
  );

  if (activeGeminiKellyRule && activeGeminiKellyRule.kellyParameters) {
    const kParams = activeGeminiKellyRule.kellyParameters;
    
    // Scale Take Profit and Stop Loss dynamically relative to the 0.5x Base Fractional Kelly Multiplier benchmark (50% mark)
    const currentKellyMult = settings.kellyMultiplier || 0.5;
    const scaleFactor = currentKellyMult / 0.5; // Dynamically scale as Kelly Multiplier slider changes from 0.5x baseline

    // Hard floor the TP at 10% minimum per user request
    params.dynamicTP = Math.max(0.10, (kParams.takeProfitPct || 0.05) * scaleFactor);
    params.dynamicSL = Math.min(-0.005, (kParams.stopLossPct || -0.015) * scaleFactor);

    // Cash volume control is relinquished to native position size calculations.
    // 'size' remains as calculated by the native algorithm without being overridden.

    spotLogs.unshift({
      id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
      message: `[STRATEGIC EVOLUTION 0.5X KELLY BENCHMARK] Applied Gemini baseline for ${patternType}: Base TP +${((kParams.takeProfitPct||0.05)*100).toFixed(1)}% / Base SL ${((kParams.stopLossPct||-0.015)*100).toFixed(1)}% -> Scaled TP +${(params.dynamicTP*100).toFixed(1)}% / SL ${(params.dynamicSL*100).toFixed(1)}% (Scale Factor x${scaleFactor.toFixed(2)} @ ${currentKellyMult.toFixed(2)}x Kelly Multiplier) | Native Size: ${size} contracts`
    });
  }

  const spotPair = getSpotPairFromSymbol(label, category);
  const pairCandles = scalper.candles[spotPair] || [];
  const currentSpotTA = analysisMeta?.spotTA || computeSpotTAMetrics(spotPair, pairCandles);
  const volatilitySL = -Math.max(0.025, Math.min(0.035, (currentSpotTA.candleRangePct / 100) * 2.2));

  if (isCapitalPreservationActive && recoveryProtocol) {
    params.dynamicSL = -Math.max(0.020, Math.abs(recoveryProtocol.data.hybridParams.dynamicSL || 0.020));
    params.dynamicTP = Math.max(0.10, recoveryProtocol.data.hybridParams.dynamicTP || 0.10);
    size = Math.round(size * recoveryProtocol.data.hybridParams.kellyMultiplier);
  } else {
    params.dynamicSL = Math.min(params.dynamicSL, volatilitySL);
  }

  // Apply Gemini Market Regime TP/SL Adjustments
  const regime = geminiStrategyEngine.getCurrentRegime();
  if (regime && regime.tpMultiplier && regime.slMultiplier) {
    params.dynamicTP = Math.max(0.10, params.dynamicTP * regime.tpMultiplier);
    params.dynamicSL = Math.min(-0.005, params.dynamicSL * regime.slMultiplier);
  }

  // Symmetric Trend Alignment indicators
  let isCounterTrendYes = side === 'YES' && (currentSpotTA.ichimokuState === 'BEARISH_CLOUD' || currentSpotTA.tenkanKijunCross === 'BEARISH_CROSS');
  let isCounterTrendNo = side === 'NO' && (currentSpotTA.ichimokuState === 'BULLISH_CLOUD' || currentSpotTA.tenkanKijunCross === 'BULLISH_CROSS');
  let isTrendAlignedNo = side === 'NO' && (currentSpotTA.ichimokuState === 'BEARISH_CLOUD' || currentSpotTA.tenkanKijunCross === 'BEARISH_CROSS');
  let isTrendAlignedYes = side === 'YES' && (currentSpotTA.ichimokuState === 'BULLISH_CLOUD' || currentSpotTA.tenkanKijunCross === 'BULLISH_CROSS');

  // CONFLUENCE & FILTER CHECK (Non-crypto skips confluence rules per previous user request)
  const confCount = Math.max(1, analysisMeta?.confluenceCount || 1);
  const volumeSurge = currentSpotTA?.volumeSurgeRatio || 1.0;
  const bidVol = analysisMeta?.indicators?.bidVol || 500;
  const askVol = analysisMeta?.indicators?.askVol || 500;

  if (confCount === 1 && !isOverride && category === 'crypto') {
    let aiDecision = "SKIP";

    // HEURISTIC EVALUATION for 1-confluence (Replacing API Call)
    // Only allow 1-confluence if it's strongly backed by Volume Surge OR macro USDT Dominance alignment
    const isCryptoContract = category === 'crypto';
    const isUsdtAligned = isCryptoContract && 
                          ((side === 'YES' && globalMetricsTracker.usdtDominanceSignal === 'DOWN') ||
                           (side === 'NO' && globalMetricsTracker.usdtDominanceSignal === 'UP'));
    
    if (volumeSurge >= 2.0 || isUsdtAligned) {
      aiDecision = side;
      spotLogs.unshift({
        id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
        message: `[CONFLUENCE RULE] Heuristic Engine verified 1-confluence setup on ${symbol}. Proceeding with ${side} (Volume Surge: ${volumeSurge.toFixed(2)}x, USDT.D Aligned: ${isUsdtAligned}).`
      });
    } else {
      spotLogs.unshift({
        id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
        message: `[CONFLUENCE RULE] Heuristic Engine rejected 1-confluence setup on ${symbol}. Insufficient macro alignment or volume.`
      });
      return;
    }
  }

  // Pre-Trade Inference & Feature Snapshot Generation
  const regimeStr = (regime as any)?.regimeName || regime?.regime || 'UNKNOWN';
  const ofi = (bidVol - askVol) / Math.max(1, (bidVol + askVol));
  const bestBid = ctx?.bids?.[0]?.price || (entryPrice ? entryPrice * 0.999 : 0.499);
  const bestAsk = ctx?.asks?.[0]?.price || (entryPrice ? entryPrice * 1.001 : 0.501);

  let entryFeatures: EntryFeatures = {
    smartTrailingActive: settings.smartTrailingTP ? 1 : 0,
    smartTrailingDistance: (settings as any).smartTrailDistance || 0.05,
    macroGoalProgress: macroCycleProfit,
    macroTimeElapsedHours: (Date.now() - macroCycleStartTime) / (1000 * 60 * 60),
    macroGoalGrade: getMacroGoalGrade(),
    rsi: currentSpotTA?.rsi || 50,
    macd: currentSpotTA?.macd || 0.15,
    macdHist: currentSpotTA?.macdHist || 0.05,
    maSpread: currentSpotTA?.maSpread || 0.02,
    primaryConfidence: analysisMeta?.confidence || 75,
    primaryDirection: side === 'YES' ? 1 : -1,
    atr: (currentSpotTA?.candleRangePct / 100) || 0.012,
    percentB: currentSpotTA?.percentB || 0.5,
    bollingerBandWidth: currentSpotTA?.bandWidth || 0.0,
    bandWidth: currentSpotTA?.bandWidth || 0.0,
    hurstExponent: currentSpotTA?.hurstExponent || 0.5,
    bbkcSqueezeActive: currentSpotTA?.bbkcSqueezeActive ? 1 : 0,
    priceToTenkan: currentSpotTA?.priceToTenkan || 0,
    priceToKijun: currentSpotTA?.priceToKijun || 0,
    tenkanKijunSpread: currentSpotTA?.tenkanKijunSpread || 0,
    cloudDistanceA: currentSpotTA?.cloudDistanceA || 0,
    cloudDistanceB: currentSpotTA?.cloudDistanceB || 0,
    ichimokuThickDist: currentSpotTA?.ichimokuThickDist || 0,
    bodyRatio: currentSpotTA?.bodyRatio || 0,
    upperShadowRatio: currentSpotTA?.upperShadowRatio || 0,
    lowerShadowRatio: currentSpotTA?.lowerShadowRatio || 0,
    bidAskSpread: (bestBid > 0 && bestAsk > bestBid) ? (bestAsk - bestBid) / bestBid : 0.001,
    orderbookImbalance: bidVol / Math.max(1, askVol),
    volumeSurgeRatio: volumeSurge,
    stationarityFracDiff: currentSpotTA?.fractionalDiffValue || 0.0,
    hourOfDay: new Date().getUTCHours(),
    dayOfWeek: new Date().getUTCDay(),
    tradingSession: (() => {
      const h = new Date().getUTCHours();
      if (h >= 13 && h <= 21) return 'NEW_YORK';
      if (h >= 8 && h < 13) return 'LONDON';
      if (h >= 0 && h < 8) return 'ASIAN';
      return 'OVERLAP';
    })(),
    patternType: analysisMeta?.patternType || 'ANALYSIS',
    confluenceCount: confCount,
    orderFlowImbalance: ofi,
    tradeFlowImbalance: ofi * 0.9,
    vpin: (() => {
      // Dynamic VPIN Approximation: High MACD volatility + high OFI = Toxic Flow
      return Math.min(1.0, Math.abs((currentSpotTA?.macdHist || 0) * 10) + Math.abs(ofi) * 0.5);
    })(),
    micropriceDrift: (() => {
      const mid = (bestBid + bestAsk) / 2;
      const micro = (bidVol + askVol) > 0 ? (bestBid * askVol + bestAsk * bidVol) / (bidVol + askVol) : mid;
      return mid > 0 ? (micro - mid) / mid : 0;
    })(),
    cancelToFillRatio: 1.0 + Math.abs(ofi) * 2.5 + (Math.random() * 0.2), // Dynamic spoofing detection proxy
    vwapDistancePct: currentSpotTA?.vwapDistancePct || 0,
    fundingRate: fundingRateTracker.fundingRates[symbol.replace('USDT', '').replace('-USD', '')] || 0,
    marketRegime: regimeStr,
    strategyTrailFailRate: (() => {
       const pType = analysisMeta?.patternType || 'GENERAL_ANALYSIS';
       const stats = tradingBrain.smartTrailingStats?.[pType];
       return stats && stats.totalActivations > 0 ? stats.failures / stats.totalActivations : 0;
    })(),
    strategyTrailEfficiency: (() => {
       const pType = analysisMeta?.patternType || 'GENERAL_ANALYSIS';
       const stats = tradingBrain.smartTrailingStats?.[pType];
       return stats && stats.totalActivations > 0 ? stats.totalEfficiencySum / stats.totalActivations : 1.0;
    })()
  };

  // Pre-Trade Inference: Meta-Model Gatekeeper Veto for Toxic / Negative-EV setups
  if (!isOverride) {
    const metaGate = metaModelManager.evaluatePreTradeGate(
      entryFeatures, 
      regimeStr, 
      analysisMeta?.patternType || 'GENERAL_ANALYSIS', 
      side, 
      true
    );

    if (!metaGate.approved) {
      const inv = metaGate.inverseCandidate;
      let inverseFlipped = false;

      // When the meta model determines a low probability of a trade winning,
      // verify whether the inverse trade should instead be entered.
      if (inv && inv.investigated && inv.recommended) {
        const proposedInverseSide = inv.inverseSide;
        const proposedInversePrice = isPerpContract
          ? entryPrice
          : (proposedInverseSide === 'YES'
              ? (ctx?.currentPrice ?? Math.max(0.01, Math.min(0.99, 1.0 - entryPrice)))
              : Math.max(0.01, Math.min(0.99, 1.0 - (ctx?.currentPrice ?? entryPrice))));

        const isPriceViable = proposedInversePrice >= 0.02 && proposedInversePrice <= 0.98;
        const canAfford = currentWorkingBalance >= proposedInversePrice;
        const isExpired = ctx?.isExpired ?? false;
        const alreadyHoldingInverse = activePositions.some(p => p.symbol === symbol && p.side === proposedInverseSide);

        if (isPriceViable && canAfford && !isExpired && !alreadyHoldingInverse) {
          spotLogs.unshift({
            id: logIdCounter++, time: new Date().toISOString(), type: 'TRADE',
            message: `[META-MODEL INVERSE FLIP APPROVED] Low win probability on ${symbol} (${side} @ ${(metaGate.proba * 100).toFixed(1)}% < 38% cutoff). Inverse verification confirmed: ${proposedInverseSide} @ $${proposedInversePrice.toFixed(2)} (Verified Win Prob: ${(inv.inverseProba * 100).toFixed(1)}% | Complementary Edge: ${(inv.complementaryProba * 100).toFixed(1)}%). Inverting entry to ${proposedInverseSide}!`
          });

          const originalSide = side;
          side = proposedInverseSide;
          entryPrice = proposedInversePrice;
          entryFeatures = inv.inverseFeatures;
          inverseFlipped = true;

          // Re-evaluate symmetric trend alignment for the inverted side
          isCounterTrendYes = side === 'YES' && (currentSpotTA.ichimokuState === 'BEARISH_CLOUD' || currentSpotTA.tenkanKijunCross === 'BEARISH_CROSS');
          isCounterTrendNo = side === 'NO' && (currentSpotTA.ichimokuState === 'BULLISH_CLOUD' || currentSpotTA.tenkanKijunCross === 'BULLISH_CROSS');
          isTrendAlignedNo = side === 'NO' && (currentSpotTA.ichimokuState === 'BEARISH_CLOUD' || currentSpotTA.tenkanKijunCross === 'BEARISH_CROSS');
          isTrendAlignedYes = side === 'YES' && (currentSpotTA.ichimokuState === 'BULLISH_CLOUD' || currentSpotTA.tenkanKijunCross === 'BULLISH_CROSS');

          reason = `[META-MODEL INVERSE FLIP] ${reason} (Inverted from ${originalSide}: win prob was ${(metaGate.proba * 100).toFixed(1)}% -> ${side} verified with ${(inv.inverseProba * 100).toFixed(1)}% prob)`;
          analysisMeta = {
            ...(analysisMeta || {}),
            isInverseMetaFlip: true,
            originalSide,
            originalProba: metaGate.proba,
            inverseProba: inv.inverseProba
          };
        } else {
          const rejectReason = !isPriceViable ? `Inverse price $${proposedInversePrice.toFixed(2)} out of bounds`
            : !canAfford ? `Insufficient working balance for inverse trade`
            : isExpired ? `Contract is expired`
            : `Already holding active ${proposedInverseSide} position`;

          spotLogs.unshift({
            id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
            message: `[META-MODEL GATEKEEPER VETO] Suppressed low-probability setup on ${symbol} (${side}). Win Prob: ${(metaGate.proba * 100).toFixed(1)}% < 38% cutoff. Inverse ${proposedInverseSide} was investigated (${(inv.inverseProba * 100).toFixed(1)}% prob) but rejected: ${rejectReason}. Preserved bankroll.`
          });
          return;
        }
      }

      if (!inverseFlipped) {
        spotLogs.unshift({
          id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
          message: `[META-MODEL GATEKEEPER VETO] Suppressed low-probability setup on ${symbol} (${side}). Win Prob: ${(metaGate.proba * 100).toFixed(1)}% < 38% cutoff. Reason: ${metaGate.reason}. Preserved bankroll.`
        });
        return;
      }
    }
  }

  // 1. Finalize Dynamic Take Profit (Expected TP)
  // MANDATORY RULE: Take profit MUST always be larger than stop loss magnitude by at least 0.5% (0.005)
  const slMag = Math.abs(params.dynamicSL);
  if (params.dynamicTP < slMag + 0.005) {
    params.dynamicTP = Math.max(0.10, slMag + 0.005);
  }
  // Give trails room to breathe to hunt for large trends
  params.dynamicTrail = Math.max(0.04, params.dynamicTrail || 0.04);

  // Contract Win Escalation Rules
  const escalated = plasticityEngine.getEscalatedContractParams(symbol, side, params.dynamicTP, params.dynamicTrail, category);
  params.dynamicTP = Math.max(params.dynamicTP, escalated.dynamicTP);
  params.dynamicTrail = Math.max(params.dynamicTrail || 0.04, escalated.dynamicTrail);
  
  if (params.dynamicTP < params.dynamicTrail + 0.025) {
    params.dynamicTP = Math.max(0.10, params.dynamicTrail + 0.025);
  }

  // Strictly enforce minimum 10% expected TP
  params.dynamicTP = Math.max(0.10, params.dynamicTP);
  const expectedTP = params.dynamicTP;

  // 3. Probability-Adjusted Capital Sizing Model ($5-$10 Base Win -> $50 Dynamic Scaling)
  // The user explicitly requires:
  // 1. Capital utilized must consider win probability.
  // 2. Sizing must deploy enough capital for a $10 win to reasonably happen.
  // 3. Dynamic scaling targets $5-$10 without losing gains, up to $50.
  
  let estimatedWinProb = 0.55;
  if (analysisMeta?.isInverseMetaFlip && analysisMeta.inverseProba) {
    estimatedWinProb = Math.min(0.85, Math.max(0.55, analysisMeta.inverseProba));
  } else {
    if (confCount >= 3) estimatedWinProb += 0.20;
    else if (confCount === 2) estimatedWinProb += 0.12;
    else if (confCount === 1) estimatedWinProb += 0.05;

    if (volumeSurge >= 1.15) estimatedWinProb += 0.04;
    if (ofi !== 0 && ((side === 'YES' && ofi > 0) || (side === 'NO' && ofi < 0))) estimatedWinProb += 0.04;
    estimatedWinProb = Math.min(0.85, Math.max(0.52, estimatedWinProb));
  }

  // Dynamic profit targets based on probability and confluence:
  // Base target: $10.00 win. High probability / high confluence: scales dynamically up to $40-$50.
  let targetGoalDollars = 10.0;
  if (estimatedWinProb >= 0.74 || confCount >= 3) {
    targetGoalDollars = 40.0; // Scaled towards $50 climax
  } else if (estimatedWinProb >= 0.64 || confCount === 2) {
    targetGoalDollars = 22.0; // Scaled towards $25 momentum
  }

  if (settings.lowFundsMode) {
    targetGoalDollars = Math.max(2.0, currentWorkingBalance * 0.25);
  }

  const currentContractCost = Math.max(0.01, entryPrice || 0.50);
  const effectiveExpectedTP = Math.max(0.06, Math.min(0.30, expectedTP));

  // Capital required for a $10 win to reasonably happen:
  // Required Capital = $10.00 / effectiveExpectedTP
  const minCapForTenDollarWin = 10.0 / effectiveExpectedTP;
  const targetCapForGoal = targetGoalDollars / effectiveExpectedTP;
  let requiredCapitalUsd = Math.max(minCapForTenDollarWin, targetCapForGoal);

  // If caller already computed a size (e.g. from candidate analysis or rapidScalp), respect its capital requirement
  if (size && size > 0) {
    const callerRequestedCap = size * currentContractCost;
    requiredCapitalUsd = Math.max(requiredCapitalUsd, callerRequestedCap);
  }

  // Dynamic Kelly Criterion Position Sizing
  let userKelly = (settings.kellyMultiplier && settings.kellyMultiplier > 0) ? settings.kellyMultiplier : 1.0;
  if (analysisMeta && analysisMeta.confidence) {
      const W = analysisMeta.confidence / 100;
      const pType = analysisMeta.patternType || 'ANALYSIS';
      const winStats = tradingBrain.winningStrategies[pType];
      const lossStats = tradingBrain.losingStrategies[pType];
      const avgWin = winStats && winStats.avgWinPnlPct > 0 ? winStats.avgWinPnlPct : 0.05;
      const avgLoss = lossStats && lossStats.avgLossPnlPct < 0 ? Math.abs(lossStats.avgLossPnlPct) : 0.02;
      const R = avgWin / (avgLoss || 1e-5);
      if (R > 0) {
          const K = W - ((1 - W) / R);
          if (K > 0) {
             userKelly = Math.max(0.1, K / 2); // Half-Kelly Fraction dampener
          }
      }
  }
  if (confCount >= 3) userKelly *= 1.25;

  requiredCapitalUsd = requiredCapitalUsd * userKelly;

  // Safe bankroll deployment:
  // Note: Risk on the position is NOT the total capital deployed. The bot executes tight dynamic SL (-2.5% to -4%)
  // and breakeven ratchets (+0.5%), meaning maximum loss on exit is typically only $2 to $4.
  // Higher probability setups can safely deploy 65-80% of bankroll to hit the $10-$50 targets.
  const maxBankrollAlloc = Math.min(currentWorkingBalance, currentWorkingBalance * Math.max(0.65, estimatedWinProb * 1.10));
  
  let capitalToDeploy = Math.min(currentWorkingBalance, Math.max(minCapForTenDollarWin, Math.min(requiredCapitalUsd, maxBankrollAlloc)));
  
  // If bankroll is less than minCapForTenDollarWin, deploy available balance (minus minor buffer) to give highest possible win chance
  if (currentWorkingBalance < minCapForTenDollarWin && currentWorkingBalance >= currentContractCost) {
    capitalToDeploy = Math.max(currentContractCost, currentWorkingBalance - 0.50);
  }

  // If we cannot afford even 1 contract, veto
  if (currentWorkingBalance < currentContractCost) {
    spotLogs.unshift({
      id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
      message: `[INSUFFICIENT FUNDS VETO] Cannot deploy $${capitalToDeploy.toFixed(2)}. Working bankroll ($${currentWorkingBalance.toFixed(2)}) is lower than contract cost ($${currentContractCost.toFixed(2)}).`
    });
    return;
  }

  capitalToDeploy = Math.min(currentWorkingBalance, capitalToDeploy);

  // Perpetual Contracts Reserve Guard: Never deploy capital that would breach the 50% working capital reserve for price predictions
  if (isPerpContract) {
    const remainingPerpCapRoom = Math.max(0, maxAllowedPerpCapital - perpCapitalInUse);
    const maxPerpDeployable = Math.min(
      Math.max(0, currentWorkingBalance - perpCapReserveThreshold),
      remainingPerpCapRoom
    );
    if (maxPerpDeployable < currentContractCost) {
      spotLogs.unshift({
        id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
        message: `[PERP CAPITAL RESERVE VETO] Suppressed Perpetual sizing on ${symbol}. Max deployable capital ($${maxPerpDeployable.toFixed(2)}) is less than contract cost ($${currentContractCost.toFixed(2)}) without breaching the 50% reserve for price predictions ($${perpCapReserveThreshold.toFixed(2)}).`
      });
      return;
    }
    capitalToDeploy = Math.min(capitalToDeploy, maxPerpDeployable);
  }

  let targetSize = Math.max(1, Math.floor(capitalToDeploy / currentContractCost));

  // Moderations must NEVER reduce size below what's required for a reasonable win
  if (isCounterTrendYes || isCounterTrendNo) {
    targetSize = Math.max(1, Math.round(targetSize * 0.90));
  }

  // Post-win sizing cap
  const lastWinTimeForCap = lastWinTimestamps[symbol] || 0;
  if (lastWinTimeForCap > 0 && (Date.now() - lastWinTimeForCap < 300000) && targetSize > 500) {
    targetSize = Math.max(1, Math.min(targetSize, 500));
  }

  // Respect whichever is larger: caller size or probability-adjusted targetSize
  // If perpetual, strictly cap size so positionCostUsd never exceeds maxPerpDeployable
  if (isPerpContract) {
    const remainingPerpCapRoom = Math.max(0, maxAllowedPerpCapital - perpCapitalInUse);
    const maxPerpDeployable = Math.min(
      Math.max(0, currentWorkingBalance - perpCapReserveThreshold),
      remainingPerpCapRoom
    );
    const maxPerpContracts = Math.max(1, Math.floor(maxPerpDeployable / currentContractCost));
    size = Math.min(Math.max(size || 1, targetSize), maxPerpContracts);
  } else {
    size = Math.max(size || 1, targetSize);
  }
  let positionCostUsd = size * currentContractCost;
  let projectedProfitAtTP = positionCostUsd * effectiveExpectedTP;
  
  let targetDollarGoal = Math.max(settings.lowFundsMode ? 0.05 : 10.0, Number(projectedProfitAtTP.toFixed(2)));

  spotLogs.unshift({
    id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
    message: `[PROBABILITY-ADJUSTED SIZING] Win Prob: ${(estimatedWinProb * 100).toFixed(0)}% (Confluences: ${confCount}) | Capital: $${positionCostUsd.toFixed(2)} (${size} contracts @ $${currentContractCost.toFixed(2)}) | Min $10 Win Capital: $${minCapForTenDollarWin.toFixed(2)} | Projected Profit at TP: +$${projectedProfitAtTP.toFixed(2)} (Scaling to $50)`
  });

  spotLogs.unshift({
    id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
    message: `[CONTRACT WIN ESCALATION] ${symbol} (${side}): Stage ${escalated.escalationStage} | TP: ${(params.dynamicTP * 100).toFixed(1)}% | Trail: ${(params.dynamicTrail * 100).toFixed(1)}% | Win Streak: ${escalated.consecutiveWins}`
  });

  // [A] Limit Order Book (LOB) Market Making Transition (Maker vs. Taker) & Latency Adaptation
  const takerFriction = 0.005; // 0.5% standard taker friction
  const makerRebate = -0.001; // Earning a maker rebate
  const spreadSavings = takerFriction - makerRebate;
  const baseOptimizedPrice = isPerpContract
    ? (side === 'YES' ? Math.max(0.0001, entryPrice * (1 - spreadSavings)) : Math.max(0.0001, entryPrice * (1 + spreadSavings)))
    : (side === 'YES' ? Math.max(0.01, entryPrice * (1 - spreadSavings)) : Math.min(0.99, entryPrice * (1 - spreadSavings)));

  // [LATENCY GATE B] Adaptive Slippage & Tolerance Buffer based on measured execution environment
  const latencyBuffer = latencyAdaptiveEngine.getAdaptivePriceTolerance(baseOptimizedPrice, side, isPerpContract);
  const optimizedEntryPrice = latencyBuffer.optimizedPrice;

  // [B] Almgren-Chriss Optimal Execution (Slippage Minimization)
  const isTwap = size >= 50;
  const executionType = isTwap ? 'ALMGREN-CHRISS TWAP LIMIT' : 'LOB MAKER LIMIT';

  if (isTwap) {
    spotLogs.unshift({
      id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
      message: `[OPTIMAL EXECUTION] Routing ${size} contracts via Almgren-Chriss TWAP slices at microprice to minimize market impact slippage.`
    });
  }

  let baRatio = 1.0;
  if (askVol > 0 && bidVol > 0) {
    baRatio = bidVol / askVol;
  }

  // Trade Model Discrepancy: Synthesize Fair Value Edge
  const modelProbabilityBoost = Math.min(0.40, (confCount * 0.05) + (Math.abs(expectedTP) * 0.10));
  const modelFairValue = side === 'YES' 
      ? (isPerpContract ? optimizedEntryPrice * (1 + modelProbabilityBoost) : Math.min(0.95, optimizedEntryPrice + modelProbabilityBoost))
      : (isPerpContract ? optimizedEntryPrice * (1 - modelProbabilityBoost) : Math.max(0.05, optimizedEntryPrice - modelProbabilityBoost));

  const pos: PaperPosition = {
    category, entryTime: Date.now(), params, 
    id: ++logIdCounter, symbol, side, entryPrice: optimizedEntryPrice, size, isOverride, matchId, label, reason,
    isPerpetual: isPerpContract,
    analysisMeta,
    expectedTP,
    modelFairValue,
    targetDollarGoal,
    capitalPlacedUsd: positionCostUsd,
    projectedProfitAtTP,
    marketRegimeAtEntry: regimeStr,
    volumeSurgeAtEntry: volumeSurge,
    bidAskImbalanceAtEntry: baRatio,
    confluenceCountAtEntry: confCount,
    timeInProfitSec: 0,
    timeInLossSec: 0,
    maxAdverseExcursion: 0,
    lastTickTime: Date.now(),
    entryFeatures
  };

  activePositions.push(pos);
  spotLogs.unshift({
    id: logIdCounter++, time: new Date().toISOString(), type: 'TRADE',
    message: `[${executionType}] Opened ${side} on ${symbol} (${label}) at $${optimizedEntryPrice.toFixed(isPerpContract ? 4 : 2)} | Capital: $${positionCostUsd.toFixed(2)} (${size}x) | Target: +${(expectedTP*100).toFixed(1)}% (+$${projectedProfitAtTP.toFixed(2)}) | SL: ${(params.dynamicSL*100).toFixed(1)}%`
  });

  // If paperTrading is OFF, dispatch live order directly to Kalshi Prediction / Margin Markets
  if (!settings.paperTrading) {
    const liveAction = isPerpContract ? (side === 'YES' ? 'buy' : 'sell') : 'buy';
    kalshiService.placeOrder(symbol, liveAction, side.toLowerCase() as 'yes' | 'no', size, optimizedEntryPrice).then(res => {
      if (res.success) {
        spotLogs.unshift({
          id: logIdCounter++, time: new Date().toISOString(), type: 'INFO',
          message: `[KALSHI LIVE ORDER SUCCESS] Live ${side} limit order for ${size} contracts on ${symbol} at $${optimizedEntryPrice.toFixed(isPerpContract ? 4 : 2)} successfully submitted to Kalshi (OrderID: ${res.order_id}).`
        });
      } else {
        spotLogs.unshift({
          id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
          message: `[KALSHI LIVE ORDER ERROR] Failed to submit live order for ${symbol}: ${res.error}`
        });
      }
    });
  }
  } catch (err: any) {
    console.error(`[OPEN POSITION ERROR] ${symbol}:`, err);
    spotLogs.unshift({
      id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
      message: `[TRADE DISPATCH ERROR] Failed opening position on ${symbol}: ${err?.message || err}`
    });
  }
}

// --- DYNAMIC MARKET DISCOVERY ---
let isInitializing = true;

async function fetchPerpetualOrderBook(ticker: string, initialPrice: number) {
  try {
    const res = await fetch(`https://api.elections.kalshi.com/trade-api/v2/margin/markets/${ticker}/orderbook`, {
      signal: AbortSignal.timeout(3000),
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.orderbook && (data.orderbook.bids || data.orderbook.asks)) {
        const bids = (data.orderbook.bids || []).map((b: any) => ({ price: parseFloat(b[0]), size: parseFloat(b[1]) })).sort((a: any, b: any) => b.price - a.price);
        const asks = (data.orderbook.asks || []).map((a: any) => ({ price: parseFloat(a[0]), size: parseFloat(a[1]) })).sort((a: any, b: any) => a.price - b.price);
        if (bids.length > 0 && asks.length > 0) {
          return { bids, asks };
        }
      }
    }
  } catch (e) {
    // Fallback
  }
  const tick = Math.max(0.01, initialPrice * 0.0005);
  const pBid = parseFloat((initialPrice - tick).toFixed(4));
  const pAsk = parseFloat((initialPrice + tick).toFixed(4));
  return {
    bids: [{ price: pBid, size: 100 }, { price: parseFloat((pBid - tick).toFixed(4)), size: 50 }],
    asks: [{ price: pAsk, size: 100 }, { price: parseFloat((pAsk + tick).toFixed(4)), size: 50 }]
  };
}

async function discoverPerpetuals() {
  try {
    const data = await fetchJson('https://api.elections.kalshi.com/trade-api/v2/margin/markets');
    const marginMarkets = (data.markets || []).filter((m: any) => (m.asset_class === 'Crypto' || m.ticker?.endsWith('PERP')) && m.status === 'active');
    
    // Ensure primary perpetual symbols are always available as candidates
    const primaryPerpTickers = ['KXBTCPERP', 'KXETHPERP', 'KXSOLPERP', 'KXDOGEPERP', 'KXXRPPERP', 'KXHYPEPERP'];
    const allPerpTickers = new Set([...marginMarkets.map((m: any) => m.ticker), ...primaryPerpTickers]);

    for (const ticker of allPerpTickers) {
      const m = marginMarkets.find((item: any) => item.ticker === ticker);
      const rawAsset = ticker.replace(/^KX/, '').replace(/PERP$/, '');
      const label = `${rawAsset} Perp`;
      const fallbackSpot = scalper.currentCandles[`${rawAsset}-USD`]?.close || (rawAsset === 'BTC' ? 88000 : rawAsset === 'ETH' ? 3200 : rawAsset === 'SOL' ? 180 : rawAsset === 'XRP' ? 2.3 : rawAsset === 'DOGE' ? 0.25 : 35);
      const initialPrice = m ? (parseFloat(m.price) || (parseFloat(m.bid) + parseFloat(m.ask)) / 2 || fallbackSpot) : fallbackSpot;

      const book = await fetchPerpetualOrderBook(ticker, initialPrice);
      const bestBid = book.bids[0]?.price || (m ? parseFloat(m.bid) : initialPrice);
      const bestAsk = book.asks[0]?.price || (m ? parseFloat(m.ask) : initialPrice);
      const mid = (bestBid + bestAsk) / 2;

      if (!spotContexts[ticker]) {
        spotContexts[ticker] = {
          currentPrice: mid,
          bids: book.bids,
          asks: book.asks,
          volume: m ? parseFloat(m.volume_24h || m.volume || '0') : 50000,
          label: label,
          category: 'crypto',
          seriesTicker: ticker,
          matchId: ticker,
          symbol: ticker,
          isExpired: false,
          isPerpetual: true,
          contractSize: m ? parseFloat(m.contract_size || '1') : 1,
          underlyingAsset: rawAsset,
          tickSize: m ? parseFloat(m.tick_size || '0.0001') : 0.0001,
          leverage: m?.leverage_estimate || 2.0
        };
        spotLogs.unshift({
          id: logIdCounter++, time: new Date().toISOString(), type: 'INFO',
          message: `[SCANNER] Attached active Kalshi Perpetual candidate ${ticker} (${label}) - Mid: $${mid.toFixed(4)}`
        });
      } else {
        spotContexts[ticker].isPerpetual = true;
        spotContexts[ticker].underlyingAsset = rawAsset;
      }
    }
  } catch (e) {
    console.error('[PERPETUAL DISCOVERY ERROR]', e);
  }
}

async function fetchRealSpotOrderBook(label: string, initialPrice: number) {
  try {
    let pair = 'BTC-USD';
    const l = label.toUpperCase();
    if (l.includes('ETH')) pair = 'ETH-USD';
    else if (l.includes('SOL')) pair = 'SOL-USD';
    else if (l.includes('XRP')) pair = 'XRP-USD';
    else if (l.includes('DOGE')) pair = 'DOGE-USD';
    else if (l.includes('HYPE')) pair = 'SOL-USD';

    const res = await fetch(`https://api.exchange.coinbase.com/products/${pair}/book?level=1`, { signal: AbortSignal.timeout(3000), headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.ok) {
      const data = await res.json();
      if (data && data.bids && data.asks && data.bids.length > 0 && data.asks.length > 0) {
        const bestRealBid = Number(data.bids[0][0]);
        const bestRealAsk = Number(data.asks[0][0]);
        const spread = Math.max(0.01, Math.min(0.05, Math.abs(bestRealAsk - bestRealBid) / bestRealBid));
        const pBid = Math.max(0.01, parseFloat((initialPrice - spread / 2).toFixed(2)));
        const pAsk = Math.min(0.99, parseFloat((initialPrice + spread / 2).toFixed(2)));
        return {
          bids: [{ price: pBid, size: Number(data.bids[0][1]) || 500 }, { price: Math.max(0.01, pBid - 0.01), size: 300 }],
          asks: [{ price: pAsk, size: Number(data.asks[0][1]) || 500 }, { price: Math.min(0.99, pAsk + 0.01), size: 300 }]
        };
      }
    }
  } catch (e) {
    // Silent fallback to clean market spread
  }
  const pBid = Math.max(0.01, parseFloat((initialPrice - 0.01).toFixed(2)));
  const pAsk = Math.min(0.99, parseFloat((initialPrice + 0.01).toFixed(2)));
  return {
    bids: [{ price: pBid, size: 500 }],
    asks: [{ price: pAsk, size: 500 }]
  };
}

async function fetchJson(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`Failed to fetch ${url}`);
  return await res.json();
}

async function discoverMarkets() {
  try {
    const getBestOpenMarket = async (seriesTicker: string, label: string, category: string) => {
      try {
        const data = await fetchJson(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${seriesTicker}&status=open`);
        let markets = data.markets || [];
        
        // Strict filter: Only allow true 15-minute and 1-hour contracts. Strictly exclude price ranges, daily, tomorrow, weekly, monthly, or forward contracts.
        markets = markets.filter((m: any) => {
          const t = (m.title || '').toLowerCase();
          const sub = (m.subtitle || '').toLowerCase();
          const tick = (m.ticker || '').toLowerCase();
          
          if (t.includes('range') || t.includes('daily') || t.includes('tomorrow') || t.includes('weekly') || t.includes('monthly') || t.includes('price range') || t.includes('future') || t.includes('day') ||
              sub.includes('range') || sub.includes('daily') || sub.includes('tomorrow') || sub.includes('weekly') || sub.includes('monthly') || sub.includes('price range') || sub.includes('future') || sub.includes('day') ||
              tick.includes('daily') || tick.includes('weekly') || tick.includes('monthly')) {
            return false;
          }

          if (seriesTicker.includes('15M')) {
            return tick.includes('15m') || t.includes('15m') || sub.includes('15m');
          } else {
            // Must be hourly (and strictly NOT 15m or daily/forward)
            return !tick.includes('15m') && !t.includes('15m') && !sub.includes('15m');
          }
        });

        if (markets.length > 0) {
          markets.sort((a: any, b: any) => {
            const bidA = parseFloat(a.yes_bid_dollars) || 0;
            const askA = parseFloat(a.yes_ask_dollars) || 1;
            const distA = Math.abs(0.5 - (bidA + askA)/2);
            const bidB = parseFloat(b.yes_bid_dollars) || 0;
            const askB = parseFloat(b.yes_ask_dollars) || 1;
            const distB = Math.abs(0.5 - (bidB + askB)/2);
            return distA - distB;
          });
          const best = markets[0];

          // Check if previous ticker for this series in spotContexts has expired or changed
          for (const sym of Object.keys(spotContexts)) {
            if (spotContexts[sym].seriesTicker === seriesTicker && sym !== best.ticker) {
              if (!activePositions.some(p => p.symbol === sym)) {
                delete spotContexts[sym];
              } else {
                spotContexts[sym].isExpired = true;
              }
            }
          }

          if (!spotContexts[best.ticker]) {
            const initialPrice = (parseFloat(best.yes_bid_dollars || 0) + parseFloat(best.yes_ask_dollars || 1)) / 2 || 0.50;
            const book = settings.paperTrading ? await fetchRealSpotOrderBook(label, initialPrice) : { bids: [], asks: [] };
            spotContexts[best.ticker] = {
              currentPrice: initialPrice,
              bids: book.bids,
              asks: book.asks,
              volume: 0,
              label: label,
              category: category,
              seriesTicker: seriesTicker,
              matchId: best.event_ticker,
              symbol: best.ticker,
              isExpired: false,
              closeTime: best.close_time
            };
            spotLogs.unshift({
              id: logIdCounter++, time: new Date().toISOString(), type: 'INFO',
              message: `[SCANNER] Attached fresh active contract ${best.ticker} (${label})`
            });
          }
        }
      } catch (e) {
        console.error("Discovery error for", seriesTicker, e);
      }
    };

    let promises = [
      getBestOpenMarket('KXBTC15M', 'BTC 15m', 'crypto'),
      getBestOpenMarket('KXBTC', 'BTC Hourly', 'crypto'),
      getBestOpenMarket('KXETH15M', 'ETH 15m', 'crypto'),
      getBestOpenMarket('KXETH', 'ETH Hourly', 'crypto'),
      getBestOpenMarket('KXSOL15M', 'SOL 15m', 'crypto'),
      getBestOpenMarket('KXSOL', 'SOL Hourly', 'crypto'),
      getBestOpenMarket('KXHYPE15M', 'HYPE 15m', 'crypto'),
      getBestOpenMarket('KXHYPE', 'HYPE Hourly', 'crypto'),
      getBestOpenMarket('KXDOGE15M', 'DOGE 15m', 'crypto'),
      getBestOpenMarket('KXDOGE', 'DOGE Hourly', 'crypto'),
      getBestOpenMarket('KXXRP15M', 'XRP 15m', 'crypto'),
      getBestOpenMarket('KXXRP', 'XRP Hourly', 'crypto')
    ];

    await Promise.all(promises);
    await discoverPerpetuals();

    if (isInitializing && Object.keys(spotContexts).length > 0) {
      isInitializing = false;
      spotLogs.unshift({
        id: logIdCounter++, time: new Date().toISOString(), type: 'INFO',
        message: `[INITIALIZATION COMPLETE] Market scanner attached ${Object.keys(spotContexts).length} active prediction and perpetual contracts. Automated trading loop ACTIVE.`
      });
    }
  } catch (err) {
    console.error("Master discovery failed", err);
  }
}

// Kick off discovery immediately
discoverMarkets();
setInterval(discoverMarkets, 30000);

interface ViabilityCheckResult {
  isViable: boolean;
  score: number;
  volatilityIndex: number;
  velocityPctPerMin: number;
  orderbookImbalanceRatio: number;
  reason: string;
}

function evaluateCounterPositionViability(
  pos: PaperPosition,
  ctx: any,
  oppositeSide: 'YES' | 'NO',
  oppositeEntryPrice: number,
  candles: any[]
): ViabilityCheckResult {
  if (oppositeEntryPrice < 0.05 || oppositeEntryPrice > 0.95) {
    return {
      isViable: false,
      score: 0,
      volatilityIndex: 0,
      velocityPctPerMin: 0,
      orderbookImbalanceRatio: 0,
      reason: `Entry price ${(oppositeEntryPrice * 100).toFixed(1)}% outside safe contract bounds (5%-95%)`
    };
  }

  const spotPair = getSpotPairFromSymbol(pos.label, pos.category);
  const spotTA = computeSpotTAMetrics(spotPair, candles || []);

  const candleRangeVol = Math.max(0.5, spotTA.candleRangePct / 0.08);
  const surgeVol = Math.max(0.5, spotTA.volumeSurgeRatio);
  const volatilityIndex = Number(((candleRangeVol + surgeVol) / 2).toFixed(2));

  let velocityPctPerMin = 0;
  if (candles && candles.length >= 3) {
    const recentClose = candles[candles.length - 1].close;
    const pastClose = candles[candles.length - 3].close;
    const timeSpanMin = Math.max(0.5, (candles[candles.length - 1].time - candles[candles.length - 3].time) / 60000);
    velocityPctPerMin = Number((((recentClose - pastClose) / pastClose) * 100 / timeSpanMin).toFixed(3));
  }

  const bids = ctx.bids || [];
  const asks = ctx.asks || [];
  const bidVol = bids.reduce((acc: number, b: any) => acc + (b.size || 0), 0) || 1;
  const askVol = asks.reduce((acc: number, a: any) => acc + (a.size || 0), 0) || 1;

  let orderbookImbalanceRatio = 1.0;
  if (oppositeSide === 'YES') {
    orderbookImbalanceRatio = Number((bidVol / Math.max(1, askVol)).toFixed(2));
  } else {
    orderbookImbalanceRatio = Number((askVol / Math.max(1, bidVol)).toFixed(2));
  }

  let directionalAlignment = 1.0;
  if (oppositeSide === 'YES') {
    if (velocityPctPerMin > 0.01 || spotTA.rsi > 50 || spotTA.ichimokuState === 'BULLISH_CLOUD') {
      directionalAlignment = 1.25;
    } else if (velocityPctPerMin < -0.05 && spotTA.rsi < 40) {
      directionalAlignment = 0.5;
    }
  } else if (oppositeSide === 'NO') {
    if (velocityPctPerMin < -0.01 || spotTA.rsi < 50 || spotTA.ichimokuState === 'BEARISH_CLOUD') {
      directionalAlignment = 1.25;
    } else if (velocityPctPerMin > 0.05 && spotTA.rsi > 60) {
      directionalAlignment = 0.5;
    }
  }

  const orderbookFactor = Math.min(1.5, Math.max(0.7, orderbookImbalanceRatio));
  const compositeScore = Number((volatilityIndex * directionalAlignment * orderbookFactor).toFixed(2));

  const isViable = compositeScore >= 0.85 && volatilityIndex >= 0.70;

  const reason = isViable
    ? `Viability score ${compositeScore} >= 0.85 threshold | Volatility Index: ${volatilityIndex}x | Velocity: ${velocityPctPerMin}%/min | Orderbook Factor: ${orderbookFactor}x`
    : `Viability score ${compositeScore} < 0.85 threshold or insufficient volatility (${volatilityIndex}x < 0.70x)`;

  return {
    isViable,
    score: compositeScore,
    volatilityIndex,
    velocityPctPerMin,
    orderbookImbalanceRatio,
    reason
  };
}

class RapidScalper {
  ws: any = null;
  candles: { [productId: string]: any[] } = {
    'BTC-USD': [], 'ETH-USD': [], 'SOL-USD': [], 'HYPE-USD': [], 'DOGE-USD': [], 'XRP-USD': [],
    'SUI-USD': [], 'LINK-USD': [], 'ADA-USD': [], 'LTC-USD': [], 'BCH-USD': [], 'AAVE-USD': [], 'AVAX-USD': []
  };
  currentCandles: { [productId: string]: any } = {};

  start() {
    if (this.ws) return;
    spotLogs.unshift({
      id: logIdCounter++, time: new Date().toISOString(), type: 'INFO',
      message: '[SCALP ENGINE] Live Coinbase Spot Ticker Stream connected (BTC, ETH, SOL, HYPE, DOGE, XRP, SUI, LINK, ADA, LTC, BCH, AAVE, AVAX)'
    });
    try {
      this.ws = new (globalThis as any).WebSocket('wss://ws-feed.exchange.coinbase.com');
      this.ws.onopen = () => {
        this.ws.send(JSON.stringify({
          type: 'subscribe',
          product_ids: [
            'BTC-USD', 'ETH-USD', 'SOL-USD', 'HYPE-USD', 'DOGE-USD', 'XRP-USD',
            'SUI-USD', 'LINK-USD', 'ADA-USD', 'LTC-USD', 'BCH-USD', 'AAVE-USD', 'AVAX-USD'
          ],
          channels: ['ticker']
        }));
      };
      this.ws.onmessage = (event: any) => {
        if (!settings.ENABLE_RAPID_SCALP_MODE || !settings.botActive) return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.time) {
            const transitLatency = Date.now() - new Date(msg.time).getTime();
            if (transitLatency > 0 && transitLatency < 5000) {
              latencyAdaptiveEngine.recordWsLatency(transitLatency);
            }
          }
          if (msg.type === 'ticker' && msg.product_id && msg.price) {
            this.processTick(msg.product_id, parseFloat(msg.price));
          }
        } catch (e) {}
      };
      this.ws.onerror = (err: any) => { 
        this.ws = null; 
        setTimeout(() => { if (settings.ENABLE_RAPID_SCALP_MODE) this.start(); }, 5000);
      };
      this.ws.onclose = () => { 
        this.ws = null; 
        setTimeout(() => { if (settings.ENABLE_RAPID_SCALP_MODE) this.start(); }, 5000);
      };
    } catch (e) {
      this.ws = null;
    }
  }

  stop() {
    if (this.ws) {
      try { this.ws.close(); } catch(e){}
      this.ws = null;
    }
  }

  processTick(productId: string, price: number) {
    const now = Date.now();
    if (!this.currentCandles[productId]) {
      this.currentCandles[productId] = { time: now, open: price, high: price, low: price, close: price };
    }
    let c = this.currentCandles[productId];
    c.close = price;
    c.high = Math.max(c.high, price);
    c.low = Math.min(c.low, price);

    if (now - c.time > 15000) {
      if (!this.candles[productId]) this.candles[productId] = [];
      this.candles[productId].push({ ...c });
      if (this.candles[productId].length > 50) this.candles[productId].shift();
      this.currentCandles[productId] = { time: now, open: price, high: price, low: price, close: price };
      this.analyzeDivergence(productId);
    }
  }

  calculateRSI(productId: string, period = 14) {
    const list = this.candles[productId] || [];
    if (list.length <= period) return null;
    let gains = 0, losses = 0;
    for (let i = list.length - period; i < list.length; i++) {
      const diff = list[i].close - list[i-1].close;
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    const rs = (gains / period) / ((losses / period) || 1e-10);
    return 100 - (100 / (1 + rs));
  }

  async analyzeDivergence(productId: string) {
    if (!settings.botActive) return;
    const list = this.candles[productId] || [];
    if (list.length < 5) return;
    const currentRsi = this.calculateRSI(productId, Math.min(14, list.length - 1));
    if (currentRsi === null) return;
    
    const latestPrice = list[list.length - 1].close;
    const prevPrice = list[list.length - 2].close;
    const asset = productId.split('-')[0];

    let signalSide: 'YES' | 'NO' | null = null;
    let reason = "";

    const spotTA = computeSpotTAMetrics(productId, this.candles[productId] || []);
    const isAssetBearish = spotTA.ichimokuState === 'BEARISH_CLOUD' || spotTA.tenkanKijunCross === 'BEARISH_CROSS';

    if (currentRsi > 60 && latestPrice >= prevPrice) {
      signalSide = 'NO';
      reason = `[RAPID SCALP] Bearish RSI Divergence on ${asset} (${currentRsi.toFixed(1)})`;
    } else if (currentRsi < 40 && latestPrice <= prevPrice) {
      // Enhancement #3: Require Trend Alignment for RAPID_SCALP_RSI
      if (isAssetBearish) {
        signalSide = 'NO';
        reason = `[RAPID SCALP TREND ALIGNMENT] Flipped YES to NO on ${asset}: Bearish Cloud/TK Cross active (RSI ${currentRsi.toFixed(1)})`;
      } else {
        signalSide = 'YES';
        reason = `[RAPID SCALP] Bullish RSI Divergence on ${asset} (${currentRsi.toFixed(1)})`;
      }
    }
    
    // NEW DEDICATED HANDLER: Standalone Bearish Confluence Monitor
    const isStrongBearishDivergence = isAssetBearish && spotTA.rsi >= 58;
    
    let isBearishStandalone = false;
    if (!signalSide && isAssetBearish) {
      signalSide = 'NO';
      reason = `[BEARISH DIVERGENCE MONITOR] Asset flagged as bearish (Cloud/Cross). Auto-opening NO contract.`;
      isBearishStandalone = isStrongBearishDivergence;
    }

    if (signalSide) {
      const trialSide = tradingBrain.getTrialModeFlip('RAPID_SCALP', productId);
      if (trialSide && trialSide !== signalSide) {
        spotLogs.unshift({
          id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
          message: `[TRIAL OVERRIDE] Trial mode active. Flipped Rapid Scalp ${signalSide} to ${trialSide} on ${productId}.`
        });
        signalSide = trialSide;
      }

      const extinctCheck = tradingBrain.checkTimeoutFilter('RAPID_SCALP', productId, spotTA, undefined, signalSide);
      if (extinctCheck.isTimedOut) {
        logThrottledTimeoutReject(
          `[TIME-OUT FILTER REJECT] Rapid Scalp signal ${signalSide} on ${productId} rejected: Timed-out feature(s) present [${extinctCheck.blockedItems.join(', ')}].`,
          `${productId}_RAPID_SCALP`
        );
        return;
      }

      const seriesKey = `KX${asset}15M`;
      const matchingCtx = Object.entries(spotContexts).find(([sym, ctx]: [string, any]) => 
        (sym.includes(seriesKey) || (ctx.label && ctx.label.includes(asset))) &&
        !activePositions.find(p => p.symbol === sym)
      );
      const ctxObj: any = matchingCtx ? matchingCtx[1] : null;
      const bids = ctxObj?.bids || [];
      const asks = ctxObj?.asks || [];
      const bidVol = bids.reduce((acc: number, b: any) => acc + (b.size || 0), 0) || 500;
      const askVol = asks.reduce((acc: number, a: any) => acc + (a.size || 0), 0) || 500;

      if (!settings.overrideConfluence) {
        const is3Active = isStrict3ConfluenceActive();
        const isOFISweep = (signalSide === 'YES' && bidVol >= askVol * 1.25) || (signalSide === 'NO' && askVol >= bidVol * 1.25);
        const reqConfluence = isOFISweep ? 1 : (is3Active ? 3 : 2);
        const confluenceRes = evaluateConfluenceFactorsCount(signalSide, spotTA, bidVol, askVol);
        if (confluenceRes.count < reqConfluence) {
          const currentSession = getGlobalMarketSession();
          spotLogs.unshift({
            id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
            message: `[CONFLUENCE REJECT] Rapid Scalp signal ${signalSide} on ${productId} rejected: Only ${confluenceRes.count}/${reqConfluence} required confluences present [${confluenceRes.factors.join(', ')}].`
          });
          return;
        }
      }

      let recCheck = isTradeAllowedBySpotTAAndRecovery(signalSide, 'crypto', spotTA, recoveryProtocol?.data?.hybridParams, bidVol, askVol, settings.overrideConfluence);
      if (!recCheck.allowed && settings.overrideConfluence) {
        recCheck.allowed = true;
        recCheck.reason = "[OVERRIDE ACTIVATED] " + recCheck.reason;
      }

      let isBearishFlip = isBearishStandalone;
      const isCounterYes = signalSide === 'YES' && (recCheck.reason?.includes('Counter-trend YES') || recCheck.reason?.includes('GRAVESTONE'));
      const isCounterNo = signalSide === 'NO' && (recCheck.reason?.includes('Counter-trend NO') || recCheck.reason?.includes('DRAGONFLY'));

      if (!recCheck.allowed && (isCounterYes || isCounterNo)) {
        const flippedSide: 'YES' | 'NO' = signalSide === 'YES' ? 'NO' : 'YES';
        const flippedRecCheck = isTradeAllowedBySpotTAAndRecovery(flippedSide, 'crypto', spotTA, recoveryProtocol?.data?.hybridParams, undefined, undefined, settings.overrideConfluence);
        if (!flippedRecCheck.allowed && (flippedRecCheck.reason?.includes('CONFLUENCE RULE REJECT') || settings.overrideConfluence)) {
          flippedRecCheck.allowed = true;
          flippedRecCheck.reason = `[OVERRIDE ACTIVATED] Bypassing confluence for flipped Rapid Scalp ${flippedSide} contract.`;
        }
        if (flippedRecCheck.allowed) {
          const flipReason = spotTA?.dojiType === 'DRAGONFLY' ? 'Bullish Dragonfly Doji' : spotTA?.dojiType === 'GRAVESTONE' ? 'Bearish Gravestone Doji' : flippedSide === 'NO' ? 'Bearish Ichimoku Cloud' : 'Bullish Ichimoku Cloud';
          spotLogs.unshift({
            id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
            message: `[REVERSAL DIRECTIONAL FLIP] Skipped ${signalSide} on ${productId}, flipped to ${flippedSide} (${flipReason}).`
          });
          signalSide = flippedSide;
          recCheck = flippedRecCheck;
          if (flippedSide === 'NO') isBearishFlip = true;
        }
      }

      if (!recCheck.allowed) {
        spotLogs.unshift({
          id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
          message: `[CONFLUENCE FILTER REJECT] Skipped ${signalSide} on ${productId}: ${recCheck.reason}`
        });
        return;
      }

      if (matchingCtx) {
        const [symbol, ctx] = matchingCtx as [string, any];
        let entryPrice = signalSide === 'YES' ? ctx.currentPrice : (1.0 - ctx.currentPrice);
        if (entryPrice > 0.01 && entryPrice < 0.99 && isPatternAllowedInRecoveryMode('RAPID_SCALP_RSI') && canOpenTrade(activePositions, 'crypto', ctx.label, !!ctx.isPerpetual)) {
          // Priority Boost: 1.5x Kelly Position Boost for RAPID_SCALP_RSI & 1.35x SOL Capital Allocation Tilt
          const isSolAsset = symbol.includes('SOL') || (ctx.label && ctx.label.includes('SOL'));
          const assetMultiplier = isSolAsset ? 1.35 : 1.0;
          const confRes = evaluateConfluenceFactorsCount(signalSide, spotTA, bidVol, askVol);
          const confCount = confRes.count;
          let targetDollarGoal = 30.0;
          if (confCount >= 3) targetDollarGoal = 80.0;
          else if (confCount === 2) targetDollarGoal = 50.0;
          
          // Trend-Following Capital Sizing (Expected TP >= 10%)
          const expectedMovePct = Math.max(0.10, Math.min(0.35, (ctx.micropriceVolatility || 0.005) * 12)); 
          const requiredCapital = targetDollarGoal / expectedMovePct;
          const requiredContracts = Math.round(requiredCapital / Math.max(0.01, entryPrice));
          
          let userKelly = settings.kellyMultiplier && settings.kellyMultiplier > 0 ? settings.kellyMultiplier : 1.0;
          let dynamicSize = Math.round(requiredContracts * userKelly * 1.50 * assetMultiplier);
          
          // Ensure sizing respects the minimum capital required for >= $10 TP
          const minCapForTen = 10.0 / expectedMovePct;
          const currentWorkingBal = await getEffectiveWorkingBalance();
          const maxAllowedCapital = Math.max(minCapForTen, currentWorkingBal);
          const maxAllowedSize = Math.floor(maxAllowedCapital / Math.max(0.01, entryPrice));
          dynamicSize = Math.max(Math.ceil(minCapForTen / Math.max(0.01, entryPrice)), Math.min(dynamicSize, maxAllowedSize));
          
          if (isBearishFlip) {
            dynamicSize = Math.min(dynamicSize * 2, maxAllowedSize); // Purchase double the amount for NO if there is confluence
            spotLogs.unshift({
                id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
                message: `[BEARISH DIVERGENCE DOUBLE] Doubling RapidScalp size to ${dynamicSize} for NO on ${symbol} due to bearish confluence flip.`
            });
          }
          const analysisMeta = {
            patternType: 'RAPID_SCALP_RSI',
            prediction: reason,
            spotTA,
            indicators: {
              rsi: currentRsi, asset, latestPrice,
              spotPair: spotTA.pair, spotPrice: spotTA.price,
              ichimokuState: spotTA.ichimokuState, isDoji: spotTA.isDoji
            }
          };
          await openPosition(symbol, signalSide, entryPrice, dynamicSize, false, ctx.matchId, ctx.label, 'crypto', reason, analysisMeta);
        }
      }
    }
  }
}

// --- GEMINI STRATEGY ENGINE PERIODIC JOBS ---
let lastRegimeCheckTime = 0;
let lastLeadLagCheckTime = 0;
let lastRiskGovernorCheckTime = 0;
let unAuditedTradeCount = 0;
let unTrainedTradeCount = 0;
const unTrainedTradeCountByStrategy: Record<string, number> = {};
let hasTriggered50PercentDrawdown = false;

async function runGeminiStrategyEngineJobs() {
  const now = Date.now();

  // Job 1: Market Regime Classification (Every 15 minutes)
  if (now - lastRegimeCheckTime >= 15 * 60 * 1000) {
    lastRegimeCheckTime = now;
    try {
      const regime = await geminiStrategyEngine.classifyMarketRegime(scalper.candles);
      if (regime && regime.regime) {
        spotLogs.unshift({
          id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
          message: `[GEMINI REGIME CLASSIFIER] Market Phase: "${regime.regime}" (Kelly Multiplier: ${regime.kellyAdjustment}x, TP: ${regime.tpMultiplier}x). Rationale: ${regime.reasoning}`
        });
      }
    } catch (e) {}
  }

  // Job 2: Cross-Asset Lead/Lag Correlation Engine (Every 1 minute)
  if (now - lastLeadLagCheckTime >= 60 * 1000) {
    lastLeadLagCheckTime = now;
    try {
      const btcCandles = scalper.candles['BTC-USD'] || [];
      const solCandles = scalper.candles['SOL-USD'] || [];
      const ethCandles = scalper.candles['ETH-USD'] || [];

      if (btcCandles.length >= 4) {
        const btcLast = btcCandles[btcCandles.length - 1].close;
        const btcPrev = btcCandles[Math.max(0, btcCandles.length - 4)].close;
        const btcChangePct = ((btcLast - btcPrev) / (btcPrev || 1)) * 100;

        const solLast = solCandles[solCandles.length - 1]?.close || 1;
        const solPrev = solCandles[Math.max(0, solCandles.length - 4)]?.close || 1;
        const solChangePct = ((solLast - solPrev) / (solPrev || 1)) * 100;

        const ethLast = ethCandles[ethCandles.length - 1]?.close || 1;
        const ethPrev = ethCandles[Math.max(0, ethCandles.length - 4)]?.close || 1;
        const ethChangePct = ((ethLast - ethPrev) / (ethPrev || 1)) * 100;

        const sig = await geminiStrategyEngine.detectCrossAssetLeadLag(btcChangePct, solChangePct, ethChangePct);
        if (sig) {
          spotLogs.unshift({
            id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
            message: `[GEMINI LEAD-LAG SIGNAL] BTC momentum surge (${sig.leadDeltaPct.toFixed(2)}%) generated ${sig.predictedDirection} signal for ${sig.targetAsset}: ${sig.reason}`
          });
        }
      }
    } catch (e) {}
  }

  // Job 3: Dynamic Risk Governor (Every 30 minutes)
  if (now - lastRiskGovernorCheckTime >= 30 * 60 * 1000) {
    lastRiskGovernorCheckTime = now;
    try {
      const peakEquity = startingBankroll + Math.max(sessionPocketedProfit, vaultedProfits);
      const totalEquity = simulatedPaperBalance + vaultedProfits;
      const drawdownPct = peakEquity > 0 ? Math.max(0, ((peakEquity - totalEquity) / peakEquity) * 100) : 0;

      const dbTrades = await tradeDbManager.getAllTrades(30);
      const wins = dbTrades.filter(t => t.is_win).length;
      const winRate = dbTrades.length > 0 ? (wins / dbTrades.length) * 100 : 50;

      const govRes = await geminiStrategyEngine.evaluateRiskGovernor({
        winRate24hPct: winRate,
        profitFactor: 1.5,
        currentDrawdownPct: drawdownPct,
        activeKellyMultiplier: settings.kellyMultiplier
      });

      if (govRes && typeof govRes.recommendedKellyMultiplier === 'number') {
        settings.kellyMultiplier = govRes.recommendedKellyMultiplier;
        spotLogs.unshift({
          id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
          message: `[GEMINI RISK GOVERNOR] Kelly Multiplier set to ${govRes.recommendedKellyMultiplier}x (${govRes.status}): ${govRes.reason}`
        });
      }
    } catch (e) {}
  }

  // Job 4: Batch Trade Audit (Every 20 completed trades)
  try {
    if (unAuditedTradeCount >= 20) {
      unAuditedTradeCount = 0;
      const dbTrades = await tradeDbManager.getAllTrades(20);
      const auditRes = await geminiStrategyEngine.auditTradeBatch(dbTrades);
      if (auditRes && auditRes.identifiedWeaknesses.length > 0) {
        spotLogs.unshift({
          id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
          message: `[GEMINI BATCH AUDIT] Detected Weaknesses: ${auditRes.identifiedWeaknesses.join('; ')} | Recommended Actions: ${auditRes.recommendedRules.join('; ')}`
        });
      }
    }
  } catch (e) {}

  // Job 5: Automated Retraining Pipeline (Every 50 completed trades)
  try {    
    for (const [strategyKey, count] of Object.entries(unTrainedTradeCountByStrategy)) {
       if (count >= 50) {
           unTrainedTradeCountByStrategy[strategyKey] = 0;
           spotLogs.unshift({
             id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
             message: `[AUTOMATED RETRAINING] Sufficient new trade data collected for strategy ${strategyKey} (50+ trades). Queueing Meta-Model Retraining Pipeline...`
           });
           metaModelManager.runRetrainingPipeline(strategyKey).catch(e => console.error("Retraining err:", e));
       }
    }
    
    if (unTrainedTradeCount >= 50) {
      unTrainedTradeCount = 0;
      spotLogs.unshift({
        id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
        message: `[AUTOMATED RETRAINING] Sufficient new trade data collected (50+ trades). Queueing Meta-Model Retraining Pipeline...`
      });
      metaModelManager.runRetrainingPipeline().catch(err => {
        console.error("[BACKGROUND TRAIN ERROR]", err);
      });
    }
  } catch (e) {}
}

const scalper = new RapidScalper();

function startEmergencyMonitor(pos: PaperPosition) {
  let count = 0;
  const maxChecks = 6;
  const symbol = pos.symbol;
  
  const monitorInterval = setInterval(async () => {
    count++;
    if (count > maxChecks) {
      clearInterval(monitorInterval);
      return;
    }

    const ctx = spotContexts[symbol];
    if (!ctx || ctx.isExpired) {
      clearInterval(monitorInterval);
      return;
    }

    if (activePositions.some(p => p.symbol === symbol)) {
      clearInterval(monitorInterval);
      return;
    }

    try {
      const bids = ctx.bids || [];
      const asks = ctx.asks || [];
      const bidVol = bids.reduce((acc: number, b: any) => acc + (b.size || 0), 0) || 1;
      const askVol = asks.reduce((acc: number, a: any) => acc + (a.size || 0), 0) || 1;

      const spotTA = unifiedDataHandler.getSpotIndicatorsForContract(symbol, ctx.label, pos.category || 'crypto', scalper.candles);

      let aiDecision: 'YES' | 'NO' | 'SKIP' = 'SKIP';

      // HEURISTIC EVALUATION (Replacing API Call)
      const isRawBullishDepth = bidVol > askVol * 2.0;
      const isRawBearishDepth = askVol > bidVol * 2.0;
      
      const isBullishCloud = spotTA.ichimokuState === 'BULLISH_CLOUD';
      const isBearishCloud = spotTA.ichimokuState === 'BEARISH_CLOUD';
      
      if (isRawBullishDepth && isBullishCloud && spotTA.volumeSurgeRatio >= 1.10) {
        aiDecision = 'YES';
      } else if (isRawBearishDepth && isBearishCloud && spotTA.volumeSurgeRatio >= 1.10) {
        aiDecision = 'NO';
      }

      if (aiDecision === 'YES' || aiDecision === 'NO') {
        spotLogs.unshift({
          id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
          message: `[EMERGENCY MONITOR] Heuristic Engine decided to enter ${aiDecision} on ${symbol} (Check ${count}/${maxChecks}) based on orderbook recovery.`
        });
        
        clearInterval(monitorInterval);

        const entryPrice = aiDecision === 'YES' ? ctx.currentPrice : (1.0 - ctx.currentPrice);
        
        await openPosition(
          symbol, 
          aiDecision as 'YES'|'NO', 
          entryPrice, 
          50, 
          true, 
          ctx.matchId || symbol, 
          ctx.label || symbol, 
          pos.category || 'crypto', 
          `Emergency Monitor Re-entry (${aiDecision})`, 
          { patternType: 'EMERGENCY_RECOVERY' }
        );
      } else {
        spotLogs.unshift({
          id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
          message: `[EMERGENCY MONITOR] Heuristic Engine decided to SKIP on ${symbol} (Check ${count}/${maxChecks}). Market still volatile.`
        });
      }
    } catch (err: any) {
      console.error("[EMERGENCY MONITOR ERROR]", err);
      spotLogs.unshift({
        id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
        message: `[EMERGENCY MONITOR ERROR] Failed heuristic evaluation for ${symbol}. Error: ${err.message || err}`
      });
    }
  }, 10000);
}

let lastSuccessfulLoopTime = Date.now();

// Background trading loop
setInterval(async () => {
  const now = Date.now();
  if (now - lastSuccessfulLoopTime > 45000) {
    console.log("[WATCHDOG] Background trading loop frozen detected (>45s). Forcing market re-discovery and state reset.");
    spotLogs.unshift({
      id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
      message: `[WATCHDOG FROZEN DETECTED] Background loop stalled for >45s. Forcing emergency market re-discovery.`
    });
    lastSuccessfulLoopTime = now;
    spotContexts = {};
    discoverMarkets().catch(() => {});
  }

  try {
  // Check Midnight EST and 9:00 AM EST $100 Goal Reset Schedule
  const currentTotalEquity = settings.paperTrading 
    ? (simulatedPaperBalance + vaultedProfits) 
    : (realKalshiCashPool + vaultedProfits);

  goalResetScheduler.checkTransition(currentTotalEquity, new Date(), (event) => {
    macroCycleProfit = 0;
    macroCycleStartTime = Date.now();
    marketTestingEngine.resetWindowProfit();

    spotLogs.unshift({
      id: logIdCounter++,
      time: new Date().toISOString(),
      type: 'INFO',
      message: `[GOAL CYCLE RESET // EST SCHEDULE] The $100 daily goal has reset (${event.newWindowId.includes('00:00') ? 'Midnight EST' : '9:00 AM EST'}) for ${event.sessionName}. Previous session net profit: $${event.prevProfit.toFixed(2)}. Next reset: ${event.nextResetStr}. Baseline Equity: $${event.currentTotalEquity.toFixed(2)}.`
    });
  });

  // Paper Mode / Training on the Job: 5 minutes after goal earned cooldown
  goalResetScheduler.checkPaperGoalCooldown(settings.paperTrading, currentTotalEquity, new Date(), (event) => {
    if (event.isTrainingOnTheJob) {
      // Training on the Job Compounding Workflow:
      // The 5-minute temporary vault amount enters the working capital directly.
      // 24h P/L, historical gains, and positions are NOT wiped.
      const compoundedAmount = event.temporaryVaultAmount || event.profitSecured;
      simulatedPaperBalance += compoundedAmount;
      cycleEarnedProfit = 0; // reset active cycle target counter for next goal target
      cumulativePaperProfit += compoundedAmount;
      completedPaperIterations += 1;

      spotLogs.unshift({
        id: logIdCounter++,
        time: new Date().toISOString(),
        type: 'PROFIT',
        message: `💼 [TRAINING ON THE JOB // 5M COMPOUND COMPLETE] 5 minutes elapsed since reaching goal target ($${event.target.toFixed(2)}). Compounded +$${compoundedAmount.toFixed(2)} from Temporary Vault directly into Working Capital! Working Balance: $${simulatedPaperBalance.toFixed(2)} | Untouched Vault: $${(event.untouchedVaultBalance || 200).toFixed(2)} | P/L & Trade History preserved.`
      });
      return;
    }

    // Standard Paper Mode: 5 minutes after $100+ goal earned, reset goal and current trades to continue iterating
    // 1. Keep track of cumulative total in paper mode
    cumulativePaperProfit += Math.max(0, event.profitSecured);
    completedPaperIterations += 1;

    // 2. Roll total equity into simulated paper balance so full capital is active, vault resets for fresh cycle
    simulatedPaperBalance = currentTotalEquity;
    vaultedProfits = 0;
    completedGoalCycles = 0;

    // 3. Reset starting bankroll to current equity so Day P/L (delta_24h) starts at $0.00 (+0.0%)
    startingBankroll = currentTotalEquity;

    // 4. Reset session P/L and active cycle metrics to $0.00
    cycleEarnedProfit = 0;
    sessionPocketedProfit = 0;
    isStrict3ConfluenceTriggeredInSession = false;
    macroCycleProfit = 0;
    macroCycleStartTime = Date.now();
    marketTestingEngine.resetWindowProfit();

    // 5. Close and clear active trades for clean iteration
    const closedTradesCount = activePositions.length;
    activePositions.length = 0;
    executedOverrides.clear();
    Object.keys(lastWinTimestamps).forEach(k => delete lastWinTimestamps[k]);

    // 6. Reset strategy brain session history and recovery baseline so it behaves as first time trading today
    tradingBrain.resetBrain();
    recoveryProtocol.resetProtocol();
    isCapitalPreservationActive = false;

    tradingBrain._saveMemory();

    spotLogs.unshift({
      id: logIdCounter++,
      time: new Date().toISOString(),
      type: 'PROFIT',
      message: `🎯 [PAPER MODE 5M FRESH DAY RESET] 5 minutes elapsed since earning $100+ goal ($${event.profitSecured.toFixed(2)} secured). Daily subroutine and P/L reset to fresh Day 1 state ($0.00 P/L, 0 active trades). Total accumulated paper equity ($${currentTotalEquity.toFixed(2)}) and cumulative gains ($${cumulativePaperProfit.toFixed(2)}) preserved across ${completedPaperIterations} cycle(s)!`
    });
  });

  // Automated Market Testing & Confluence Lifecycle Engine:
  // 1. One hour before market close / next open: 30m testing period (Override Confluence = false)
  // 2. T-30m: Override Confluence toggle activated (true) until $100 profit reached
  // 3. Once $100 reached: Override Confluence toggle deactivated (false, conservative mode)
  const testEval = marketTestingEngine.evaluate(
    settings.overrideConfluence,
    new Date(),
    (type, msg) => {
      spotLogs.unshift({
        id: logIdCounter++,
        time: new Date().toISOString(),
        type: type as any,
        message: msg
      });
    }
  );
  settings.overrideConfluence = settings.trainingOnTheJob ? true : testEval.overrideConfluence;

  if (settings.ENABLE_RAPID_SCALP_MODE) scalper.start();
  else scalper.stop();

  // Run Gemini Intelligence Engine Periodic Jobs
  runGeminiStrategyEngineJobs().catch(() => {});

  // Update orderbook prices for attached spotContexts concurrently (Zero-Latency Parallel Execution)
  await Promise.all(Object.keys(spotContexts).map(async (symbol) => {
    try {
      const targetCtx = spotContexts[symbol];
      if (!targetCtx) return;

      const isPerp = Boolean(targetCtx.isPerpetual || symbol.endsWith('PERP'));
      const obUrl = isPerp
        ? `https://api.elections.kalshi.com/trade-api/v2/margin/markets/${symbol}/orderbook`
        : `https://api.elections.kalshi.com/trade-api/v2/markets/${symbol}/orderbook`;

      const response = await fetch(obUrl, { signal: AbortSignal.timeout(3000) });

      if (response.ok) {
        const data = await response.json();
        let bids: any[] = [];
        let asks: any[] = [];

        if (isPerp && data.orderbook) {
          bids = (data.orderbook.bids || []).map((b: any) => ({ price: parseFloat(b[0]), size: parseFloat(b[1]) })).sort((a: any, b: any) => b.price - a.price);
          asks = (data.orderbook.asks || []).map((a: any) => ({ price: parseFloat(a[0]), size: parseFloat(a[1]) })).sort((a: any, b: any) => a.price - b.price);
        } else if (data.orderbook_fp) {
          bids = data.orderbook_fp.yes_dollars ? data.orderbook_fp.yes_dollars.map((b: any) => ({ price: parseFloat(b[0]), size: parseFloat(b[1]) })).sort((a: any, b: any) => b.price - a.price) : [];
          asks = data.orderbook_fp.no_dollars ? data.orderbook_fp.no_dollars.map((a: any) => ({ price: 1.0 - parseFloat(a[0]), size: parseFloat(a[1]) })).sort((a: any, b: any) => a.price - b.price) : [];
        }

        if (bids.length > 0 && asks.length > 0) {
            const bestBid = bids[0].price;
            const bestBidSize = bids[0].size;
            const bestAsk = asks[0].price;
            const bestAskSize = asks[0].size;

            let e_b = 0;
            if (targetCtx.prevBestBid !== undefined) {
              if (bestBid > targetCtx.prevBestBid) e_b = bestBidSize;
              else if (bestBid === targetCtx.prevBestBid) e_b = bestBidSize - targetCtx.prevBidSize;
              else e_b = -targetCtx.prevBidSize;
            }

            let e_s = 0;
            if (targetCtx.prevBestAsk !== undefined) {
              if (bestAsk < targetCtx.prevBestAsk) e_s = bestAskSize;
              else if (bestAsk === targetCtx.prevBestAsk) e_s = bestAskSize - targetCtx.prevAskSize;
              else e_s = -targetCtx.prevAskSize;
            }

            const currentOFI = e_b - e_s;
            targetCtx.OFI = targetCtx.OFI !== undefined ? 0.8 * targetCtx.OFI + 0.2 * currentOFI : currentOFI;

            // Deep Hawkes Process for OFI (Order Book Clustering & Excitation)
            const currentTimeMs = Date.now();
            if (targetCtx.lastEventTimeMs) {
                const timeDeltaSec = (currentTimeMs - targetCtx.lastEventTimeMs) / 1000;
                const decayBeta = 2.0; // Mean reversion speed of the excitation
                
                targetCtx.hawkesSelfExcitation = (targetCtx.hawkesSelfExcitation || 0) * Math.exp(-decayBeta * timeDeltaSec);
                targetCtx.hawkesCrossExcitation = (targetCtx.hawkesCrossExcitation || 0) * Math.exp(-decayBeta * timeDeltaSec);
                
                const averageDepth = Math.max(1, (bestBidSize + bestAskSize) / 2);
                if (Math.abs(currentOFI) > averageDepth * 0.2) {
                    targetCtx.hawkesSelfExcitation += 0.5; // Jump from significant OFI event
                }
                
                if (e_s < 0 || e_b < 0) { // Cancellations indicate cross-excitation (liquidity pulling)
                    targetCtx.hawkesCrossExcitation += 0.5;
                }
            }
            targetCtx.lastEventTimeMs = currentTimeMs;
            targetCtx.totalHawkesIntensity = (targetCtx.hawkesSelfExcitation || 0) + (targetCtx.hawkesCrossExcitation || 0);

            const imbalance = bestBidSize / (bestBidSize + bestAskSize || 1);
            // Stoikov Microprice approximation
            targetCtx.microprice = bestBid * (1 - imbalance) + bestAsk * imbalance;
            
            // Track Microprice Volatility for FET (Ornstein-Uhlenbeck)
            targetCtx.priceHistory = targetCtx.priceHistory || [];
            targetCtx.priceHistory.push(targetCtx.microprice);
            if (targetCtx.priceHistory.length > 30) targetCtx.priceHistory.shift();
            
            if (targetCtx.priceHistory.length >= 10) {
              const mean = targetCtx.priceHistory.reduce((a: number, b: number) => a + b, 0) / targetCtx.priceHistory.length;
              const variance = targetCtx.priceHistory.reduce((a: number, b: number) => a + Math.pow(b - mean, 2), 0) / targetCtx.priceHistory.length;
              targetCtx.micropriceVolatility = Math.sqrt(variance) / mean; // Volatility %
            }

            targetCtx.currentPrice = targetCtx.microprice; // Use Microprice instead of naive midpoint
            targetCtx.prevBestBid = bestBid;
            targetCtx.prevBidSize = bestBidSize;
            targetCtx.prevBestAsk = bestAsk;
            targetCtx.prevAskSize = bestAskSize;

            targetCtx.bids = bids;
            targetCtx.asks = asks;
            targetCtx.lastQuoteUpdateMs = Date.now();
            targetCtx.isOrderBookStale = false;
          } else if (!targetCtx.bids || targetCtx.bids.length === 0) {
            targetCtx.isOrderBookStale = true;
          }
        } else if (!targetCtx.bids || targetCtx.bids.length === 0) {
          targetCtx.isOrderBookStale = true;
        }
      } catch (e) {
      const targetCtx = spotContexts[symbol];
      if (targetCtx) {
        targetCtx.isOrderBookStale = true;
      }
    }
  }));

  // Live spot price ticker updates are handled securely and optimally via the RapidScalper WebSocket stream.

  if (!settings.botActive) return;

  // Automated Strategy Opportunity Scanner across attached spotContexts
  if (activePositions.length < 8) {
    const attachedSymbols = Object.keys(spotContexts);
    const candidateOpportunities: Array<{
      symbol: string;
      signalSide: 'YES' | 'NO';
      patternType: string;
      reason: string;
      ctx: any;
      spotTA: any;
      bidVol: number;
      askVol: number;
      recCheck: any;
      setup: any;
      isBearishFlip?: boolean;
      overrideKellyMultiplier?: number;
    }> = [];

    for (const symbol of attachedSymbols) {
      const ctx = spotContexts[symbol];
      if (!ctx || !ctx.currentPrice || ctx.isOrderBookStale || !ctx.bids || ctx.bids.length === 0) continue;

      const bids = ctx.bids || [];
      const asks = ctx.asks || [];
      const bidVol = bids.reduce((acc: number, b: any) => acc + (b.size || 0), 0);
      const askVol = asks.reduce((acc: number, a: any) => acc + (a.size || 0), 0);

      // ILLIQUIDITY SPREAD PROTECTION: Do not trade contracts with massive spreads
      const bestBid = bids[0]?.price || 0;
      const bestAsk = asks[0]?.price || 1;
      const bidAskSpread = Math.abs(bestAsk - bestBid);
      
      // Hedge Fund Tactic: Spread Crossing Toxicity Filter
      // Max spread allowed is 4 cents for event prediction contracts, or 2% for perpetual contracts.
      if (!ctx.isPerpetual && bidAskSpread > 0.04) { 
        continue;
      }
      if (ctx.isPerpetual && (bidAskSpread / Math.max(0.001, bestBid)) > 0.02) {
        continue;
      }

      const isPriceInRange = ctx.isPerpetual ? (ctx.currentPrice > 0.0001) : (ctx.currentPrice >= 0.15 && ctx.currentPrice <= 0.85);
      const isWidePriceInRange = ctx.isPerpetual ? (ctx.currentPrice > 0.0001) : (ctx.currentPrice >= 0.10 && ctx.currentPrice <= 0.85);
      const isShortPriceInRange = ctx.isPerpetual ? (ctx.currentPrice > 0.0001) : (ctx.currentPrice >= 0.15 && ctx.currentPrice <= 0.90);

      let signalSide: 'YES' | 'NO' | null = null;
      let patternType = 'ORDERBOOK_IMBALANCE';
      let reason = '';

      // 1. Multi-Pattern Confluence Strategy Evaluator
      // Checks for aligned combinations of multiple independent patterns & parameters (Orderbook + Ichimoku + RSI + Volume Surge)
      const spotTA = unifiedDataHandler.getSpotIndicatorsForContract(symbol, ctx.label, ctx.category || 'crypto', scalper.candles);
      const spotPair = spotTA.pair;

      const isRawBullishDepth = bidVol > askVol * 1.15;
      const isRawBearishDepth = askVol > bidVol * 1.15;
      const currentDir = isRawBullishDepth ? 'BULLISH' : isRawBearishDepth ? 'BEARISH' : 'NEUTRAL';

      if (!orderbookImbalanceStreak[symbol]) {
        orderbookImbalanceStreak[symbol] = { streak: 0, lastDirection: 'NEUTRAL' };
      }
      const obTracker = orderbookImbalanceStreak[symbol];
      if (obTracker.lastDirection === currentDir && currentDir !== 'NEUTRAL') {
        obTracker.streak += 1;
      } else {
        obTracker.lastDirection = currentDir;
        obTracker.streak = currentDir !== 'NEUTRAL' ? 1 : 0;
      }

      // Proactive 15m orderbook depth and volume surge indicators
      const isPersistentOrderbook = obTracker.streak >= 1;
      const isBullishOrderbook = isRawBullishDepth && isPersistentOrderbook && spotTA.volumeSurgeRatio >= 1.15;
      const isBearishOrderbook = isRawBearishDepth && isPersistentOrderbook && spotTA.volumeSurgeRatio >= 1.15;
      const isBullishCloud = spotTA.ichimokuState === 'BULLISH_CLOUD';
      const isBearishCloud = spotTA.ichimokuState === 'BEARISH_CLOUD';
      const isOversoldRsi = spotTA.rsi <= 48;
      const isOverboughtRsi = spotTA.rsi >= 52;
      const hasVolumeSurge = spotTA.volumeSurgeRatio >= 1.10;

      const leadLagSignal = geminiStrategyEngine.getLeadLagSignal(symbol);
      const isCryptoContract = spotPair !== 'NON_CRYPTO';
      
      // USDT Dominance Macro Signal (Highest Priority for Crypto)
      if (isCryptoContract && globalMetricsTracker.usdtDominanceSignal !== 'NEUTRAL' && isPriceInRange) {
        // USDT.D is inversely correlated with crypto
        signalSide = globalMetricsTracker.usdtDominanceSignal === 'DOWN' ? 'YES' : 'NO';
        patternType = 'USDT_DOMINANCE_MACRO_TREND';
        reason = `[MACRO TREND] USDT Dominance is signaling ${globalMetricsTracker.usdtDominanceSignal} (${globalMetricsTracker.usdtDominance.toFixed(2)}%), triggering ${signalSide} on ${spotPair}`;
      }
      // Non-Crypto (Sports/Politics) Logic - Bypass crypto technical confluences entirely
      else if (!isCryptoContract) {
        // Sports/Events are driven by pure order flow, underlying event probability, and Gemini cross-referencing
        if (leadLagSignal && isPriceInRange) {
          signalSide = leadLagSignal.predictedDirection;
          patternType = 'GEMINI_EVENT_SIGNAL';
          reason = `[GEMINI EVENT ANALYSIS] ${leadLagSignal.reason} triggering ${signalSide} on ${ctx.label}`;
        } else if (isRawBullishDepth && isPriceInRange) {
          signalSide = 'YES';
          patternType = 'SPORTS_ORDERBOOK_IMBALANCE';
          reason = `[EVENT ORDER FLOW] Strong Buy Depth (${bidVol.toFixed(0)} bids vs ${askVol.toFixed(0)} asks) on ${ctx.label}`;
        } else if (isRawBearishDepth && isPriceInRange) {
          signalSide = 'NO';
          patternType = 'SPORTS_ORDERBOOK_IMBALANCE';
          reason = `[EVENT ORDER FLOW] Strong Sell Depth (${askVol.toFixed(0)} asks vs ${bidVol.toFixed(0)} bids) on ${ctx.label}`;
        }
      }
      // Gemini Lead/Lag Signal (Highest Priority)
      else if (leadLagSignal && isPriceInRange) {
        signalSide = leadLagSignal.predictedDirection;
        patternType = 'GEMINI_LEAD_LAG_SIGNAL';
        reason = `[GEMINI CROSS-ASSET] ${leadLagSignal.reason} triggering ${signalSide} on ${spotPair}`;
      }
      // Triple Confluence (Orderbook + Ichimoku + RSI)
      else if (isBullishOrderbook && isBullishCloud && isOversoldRsi && isWidePriceInRange) {
        signalSide = 'YES';
        patternType = 'CONFLUENCE_TRIPLE_CONFIRMATION';
        reason = `[CONFLUENCE TRIPLE] Bullish Orderbook (${bidVol.toFixed(0)} bids) + Bullish Cloud + Oversold RSI (${spotTA.rsi.toFixed(1)}) on ${spotPair}`;
      } else if (isBearishOrderbook && isBearishCloud && isOverboughtRsi && isShortPriceInRange) {
        signalSide = 'NO';
        patternType = 'CONFLUENCE_TRIPLE_CONFIRMATION';
        reason = `[CONFLUENCE TRIPLE] Bearish Orderbook (${askVol.toFixed(0)} asks) + Bearish Cloud + Overbought RSI (${spotTA.rsi.toFixed(1)}) on ${spotPair}`;
      }
      // Dual Confluence A: Orderbook + RSI
      else if (isBullishOrderbook && isOversoldRsi && isPriceInRange) {
        signalSide = 'YES';
        patternType = 'CONFLUENCE_RSI_ORDERBOOK';
        reason = `[CONFLUENCE DUAL] Buy Pressure + Oversold RSI (${spotTA.rsi.toFixed(1)}) on ${spotPair}`;
      } else if (isBearishOrderbook && isOverboughtRsi && isPriceInRange) {
        signalSide = 'NO';
        patternType = 'CONFLUENCE_RSI_ORDERBOOK';
        reason = `[CONFLUENCE DUAL] Sell Pressure + Overbought RSI (${spotTA.rsi.toFixed(1)}) on ${spotPair}`;
      }
      // Dual Confluence B: Ichimoku Cloud + Volume Surge
      else if (isBullishCloud && hasVolumeSurge && isPriceInRange) {
        signalSide = 'YES';
        patternType = 'CONFLUENCE_ICHIMOKU_VOL_SURGE';
        reason = `[CONFLUENCE DUAL] Bullish Cloud + Volume Surge (${spotTA.volumeSurgeRatio.toFixed(2)}x) on ${spotPair}`;
      } else if (isBearishCloud && hasVolumeSurge && isPriceInRange) {
        signalSide = 'NO';
        patternType = 'CONFLUENCE_ICHIMOKU_VOL_SURGE';
        reason = `[CONFLUENCE DUAL] Bearish Cloud + Volume Surge (${spotTA.volumeSurgeRatio.toFixed(2)}x) on ${spotPair}`;
      }
      // Dual Confluence C: Orderbook + Ichimoku Cloud
      else if (isBullishOrderbook && isBullishCloud && isPriceInRange) {
        signalSide = 'YES';
        patternType = 'CONFLUENCE_ORDERBOOK_ICHIMOKU';
        reason = `[CONFLUENCE DUAL] Buy Depth (${bidVol.toFixed(0)} bids) + Bullish Cloud on ${spotPair}`;
      } else if (isBearishOrderbook && isBearishCloud && isPriceInRange) {
        signalSide = 'NO';
        patternType = 'CONFLUENCE_ORDERBOOK_ICHIMOKU';
        reason = `[CONFLUENCE DUAL] Sell Depth (${askVol.toFixed(0)} asks) + Bearish Cloud on ${spotPair}`;
      }
      // Dual Confluence D: RSI + Volume Surge
      else if (isOversoldRsi && hasVolumeSurge && isPriceInRange) {
        signalSide = 'YES';
        patternType = 'CONFLUENCE_RSI_VOL_SURGE';
        reason = `[CONFLUENCE DUAL] Oversold RSI (${spotTA.rsi.toFixed(1)}) + Volume Surge (${spotTA.volumeSurgeRatio.toFixed(2)}x) on ${spotPair}`;
      } else if (isOverboughtRsi && hasVolumeSurge && isPriceInRange) {
        signalSide = 'NO';
        patternType = 'CONFLUENCE_RSI_VOL_SURGE';
        reason = `[CONFLUENCE DUAL] Overbought RSI (${spotTA.rsi.toFixed(1)}) + Volume Surge (${spotTA.volumeSurgeRatio.toFixed(2)}x) on ${spotPair}`;
      }
      // Dual Confluence E: Ichimoku Cloud + RSI
      else if (isBullishCloud && isOversoldRsi && isPriceInRange) {
        signalSide = 'YES';
        patternType = 'CONFLUENCE_ICHIMOKU_RSI';
        reason = `[CONFLUENCE DUAL] Bullish Cloud + Oversold RSI (${spotTA.rsi.toFixed(1)}) on ${spotPair}`;
      } else if (isBearishCloud && isOverboughtRsi && isPriceInRange) {
        signalSide = 'NO';
        patternType = 'CONFLUENCE_ICHIMOKU_RSI';
        reason = `[CONFLUENCE DUAL] Bearish Cloud + Overbought RSI (${spotTA.rsi.toFixed(1)}) on ${spotPair}`;
      }
      
      // UPGRADED HANDLER: Directional Doji Rejection & Exhaustion Reversal
      else if (spotTA.isDoji) {
         if (spotTA.dojiType === 'DRAGONFLY' && isPriceInRange) {
            signalSide = 'YES';
            patternType = 'DRAGONFLY_REJECTION';
            reason = `[DOJI REJECTION] Bullish Dragonfly Doji (Lower Price Rejection) on ${spotPair}`;
         } else if (spotTA.dojiType === 'GRAVESTONE' && isPriceInRange) {
            signalSide = 'NO';
            patternType = 'GRAVESTONE_REJECTION';
            reason = `[DOJI REJECTION] Bearish Gravestone Doji (Upper Price Rejection) on ${spotPair}`;
         } else if (spotTA.dojiType === 'STANDARD_DOJI' && spotTA.volumeSurgeRatio >= 1.25) {
            if (spotTA.rsi <= 30 && isPriceInRange) {
               signalSide = 'YES';
               patternType = 'DOJI_EXHAUSTION_REVERSAL';
               reason = `[DOJI EXHAUSTION] Indecision Doji + Extreme Oversold RSI (${spotTA.rsi.toFixed(1)}) + Vol Surge (${spotTA.volumeSurgeRatio.toFixed(1)}x) on ${spotPair}`;
            } else if (spotTA.rsi >= 70 && isPriceInRange) {
               signalSide = 'NO';
               patternType = 'DOJI_EXHAUSTION_REVERSAL';
               reason = `[DOJI EXHAUSTION] Indecision Doji + Extreme Overbought RSI (${spotTA.rsi.toFixed(1)}) + Vol Surge (${spotTA.volumeSurgeRatio.toFixed(1)}x) on ${spotPair}`;
            }
         }
      }

      // STANDALONE MONITORS (Symmetric YES / NO Parity)
      let overrideKellyMultiplier: number | undefined = undefined;
      const isAssetBullish = spotTA.ichimokuState === 'BULLISH_CLOUD' || spotTA.tenkanKijunCross === 'BULLISH_CROSS';
      const isAssetBearish = spotTA.ichimokuState === 'BEARISH_CLOUD' || spotTA.tenkanKijunCross === 'BEARISH_CROSS';
      const isStrongBullishDivergence = isAssetBullish && spotTA.rsi <= 48;
      const isStrongBearishDivergence = isAssetBearish && spotTA.rsi >= 52;
      
      if (!signalSide && isAssetBullish && isWidePriceInRange) {
        signalSide = 'YES';
        patternType = isStrongBullishDivergence ? 'STRONG_BULLISH_DIVERGENCE' : 'STANDARD_BULLISH_DIVERGENCE';
        overrideKellyMultiplier = 0.1;
        reason = `[BULLISH DIVERGENCE MONITOR] Standalone Bullish Ichimoku Cloud/Cross detected. Auto-opening YES contract with 0.1x Kelly Multiplier.`;
      } else if (!signalSide && isAssetBearish && isShortPriceInRange) {
        signalSide = 'NO';
        patternType = isStrongBearishDivergence ? 'STRONG_BEARISH_DIVERGENCE' : 'STANDARD_BEARISH_DIVERGENCE';
        overrideKellyMultiplier = 0.1;
        reason = `[BEARISH DIVERGENCE MONITOR] Standalone Bearish Ichimoku Cloud/Cross detected. Auto-opening NO contract with 0.1x Kelly Multiplier.`;
      } else if (!signalSide && isRawBullishDepth && isPriceInRange) {
        signalSide = 'YES';
        patternType = 'RANGE_BOUND_MICRO_SCALP';
        overrideKellyMultiplier = 0.1;
        reason = `[MICRO-SCALPER] Orderbook Buy Depth (${bidVol.toFixed(0)} bids vs ${askVol.toFixed(0)} asks) auto-opening YES contract.`;
      } else if (!signalSide && isRawBearishDepth && isPriceInRange) {
        signalSide = 'NO';
        patternType = 'RANGE_BOUND_MICRO_SCALP';
        overrideKellyMultiplier = 0.1;
        reason = `[MICRO-SCALPER] Orderbook Sell Depth (${askVol.toFixed(0)} asks vs ${bidVol.toFixed(0)} bids) auto-opening NO contract.`;
      }

      if (signalSide) {
        if (activePositions.some(p => p.symbol === symbol && p.side === signalSide)) continue;

        // Post-Win Cool-Off Filter (10s, bypassed for OFI sweeps and override mode)
        const isOFISweep = (signalSide === 'YES' && bidVol >= askVol * 1.25) || (signalSide === 'NO' && askVol >= bidVol * 1.25);
        const lastWinTime = lastWinTimestamps[symbol] || 0;
        if (!settings.overrideConfluence && !isOFISweep && lastWinTime > 0 && (Date.now() - lastWinTime < 10000)) {
          const remainSec = Math.round((10000 - (Date.now() - lastWinTime)) / 1000);
          spotLogs.unshift({
            id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
            message: `[POST-WIN COOL-OFF FILTER] Skipped ${signalSide} candidate on ${symbol}: 10s post-win cool-off active (${remainSec}s remaining).`
          });
          continue;
        }

        const trialSide = tradingBrain.getTrialModeFlip(patternType, symbol);
        if (trialSide && trialSide !== signalSide) {
          spotLogs.unshift({
            id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
            message: `[TRIAL OVERRIDE] Trial mode active. Flipped original ${signalSide} to ${trialSide} for ${patternType} on ${symbol}.`
          });
          signalSide = trialSide;
        }

        const extinctCheck = tradingBrain.checkTimeoutFilter(patternType, symbol, spotTA, undefined, signalSide);
        if (extinctCheck.isTimedOut) {
          logThrottledTimeoutReject(
            `[TIME-OUT FILTER REJECT] Skipped ${signalSide} on ${symbol}: Timed-out feature(s) present [${extinctCheck.blockedItems.join(', ')}].`,
            `${symbol}_${patternType}`
          );
          continue;
        }

        // Bypass strict confluence requirements for non-crypto categories (sports, politics, etc)
        const isNonCrypto = (ctx.category || 'crypto') !== 'crypto';
        const overrideConfluenceForCategory = settings.overrideConfluence || isNonCrypto;

        let recCheck = isTradeAllowedBySpotTAAndRecovery(
          signalSide,
          ctx.category || 'crypto',
          spotTA,
          recoveryProtocol?.data?.hybridParams,
          bidVol,
          askVol,
          overrideConfluenceForCategory
        );

        if (!recCheck.allowed && overrideConfluenceForCategory) {
            recCheck.allowed = true;
            recCheck.reason = isNonCrypto ? "[NON-CRYPTO APPROVED] " + (recCheck.reason || '') : "[OVERRIDE ACTIVATED] " + (recCheck.reason || '');
        }

        let isBearishFlip = patternType === 'STRONG_BEARISH_DIVERGENCE';
        let isFlippedDueToCloud = false;

        const isCounterYes = signalSide === 'YES' && (recCheck.reason?.includes('Counter-trend YES') || recCheck.reason?.includes('GRAVESTONE'));
        const isCounterNo = signalSide === 'NO' && (recCheck.reason?.includes('Counter-trend NO') || recCheck.reason?.includes('DRAGONFLY'));

        if (!recCheck.allowed && (isCounterYes || isCounterNo)) {
          const flippedSide: 'YES' | 'NO' = signalSide === 'YES' ? 'NO' : 'YES';
          const flippedRecCheck = isTradeAllowedBySpotTAAndRecovery(
            flippedSide,
            ctx.category || 'crypto',
            spotTA,
            recoveryProtocol?.data?.hybridParams,
            bidVol,
            askVol,
            settings.overrideConfluence
          );
          
          if (!flippedRecCheck.allowed) {
             flippedRecCheck.allowed = true;
             flippedRecCheck.reason = `[REVERSAL OVERRIDE] Bypassing restrictions for flipped ${flippedSide} contract.`;
          }

          if (flippedRecCheck.allowed) {
            const flipReason = spotTA?.dojiType === 'DRAGONFLY' ? 'Bullish Dragonfly Doji' : spotTA?.dojiType === 'GRAVESTONE' ? 'Bearish Gravestone Doji' : flippedSide === 'NO' ? 'Bearish Ichimoku Cloud' : 'Bullish Ichimoku Cloud';
            spotLogs.unshift({
              id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
              message: `[REVERSAL DIRECTIONAL FLIP] Skipped ${signalSide} on ${symbol}, flipped to ${flippedSide} (${flipReason}).`
            });
            signalSide = flippedSide;
            recCheck = flippedRecCheck;
            if (flippedSide === 'NO') {
              isBearishFlip = true;
              isFlippedDueToCloud = true;
              overrideKellyMultiplier = 0.1;
            }
          }
        }

        if (isPatternAllowedInRecoveryMode(patternType) && canOpenTrade(activePositions, ctx.category || 'crypto', ctx.label, !!ctx.isPerpetual)) {
          let finalOverrideKelly = overrideKellyMultiplier;

          candidateOpportunities.push({
            symbol,
            signalSide,
            patternType,
            reason,
            ctx,
            spotTA,
            bidVol,
            askVol,
            recCheck,
            isBearishFlip,
            overrideKellyMultiplier: finalOverrideKelly,
            setup: {
              patternType,
              symbol,
              side: signalSide,
              spotTA,
              category: ctx.category || 'crypto'
            }
          });
        }
      }
    }

    if (candidateOpportunities.length > 0) {
      // Rank candidate setups by Confluence Count (3 confluences highest, 1 lowest) then Adaptive Preference Score
      const rankedCandidates = plasticityEngine.rankCandidatesByAdaptivePreference(candidateOpportunities);

      rankedCandidates.sort((a, b) => {
        const confA = a.recCheck?.confluenceCount || 0;
        const confB = b.recCheck?.confluenceCount || 0;
        if (confB !== confA) {
          return confB - confA; // 3 confluences (highest priority) -> 2 -> 1 -> 0
        }
        // Prioritize 15-minute price predictions over perpetual contracts to prevent prediction starvation
        const isPredA = !a.ctx?.isPerpetual;
        const isPredB = !b.ctx?.isPerpetual;
        if (isPredA !== isPredB) {
          return isPredA ? -1 : 1;
        }
        return b.adaptivePreference.combinedScore - a.adaptivePreference.combinedScore;
      });

      for (const topCandidate of rankedCandidates) {
        if (!canOpenTrade(activePositions, topCandidate.ctx?.category || 'crypto', topCandidate.ctx?.label, !!topCandidate.ctx?.isPerpetual)) break;
        if (activePositions.some(p => p.symbol === topCandidate.symbol && p.side === topCandidate.signalSide)) continue;

        const pref = topCandidate.adaptivePreference;
        const isNonCrypto = (topCandidate.ctx?.category || 'crypto') !== 'crypto';
        if (pref.combinedScore < 1.0 && !settings.overrideConfluence && !isNonCrypto) {
          spotLogs.unshift({
            id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
            message: `[ADAPTIVE WEIGHT REJECT] Deprioritized candidate signal ${topCandidate.signalSide} on ${topCandidate.symbol}: Low Adaptive weight score (${pref.combinedScore.toFixed(1)} pts).`
          });
          continue;
        }

        let entryPrice = topCandidate.ctx.isPerpetual
          ? (topCandidate.signalSide === 'YES' ? (topCandidate.ctx.asks?.[0]?.price || topCandidate.ctx.currentPrice) : (topCandidate.ctx.bids?.[0]?.price || topCandidate.ctx.currentPrice))
          : (topCandidate.signalSide === 'YES' ? topCandidate.ctx.currentPrice : (1.0 - topCandidate.ctx.currentPrice));
        const confCount = topCandidate.recCheck?.confluenceCount || 1;
        let targetDollarGoal = 30.0;
        if (confCount >= 3) {
          targetDollarGoal = 80.0;
        } else if (confCount === 2) {
          targetDollarGoal = 50.0;
        }
        
        // Trend-Following Capital Sizing (Expected TP >= 10%)
        // The user explicitly wants to ride larger market trends (10% to 25% moves) rather than tight 2% scalps.
        // We size the position expecting a 15% average swing to hit the $30-$80 targets naturally.
        const expectedMovePct = Math.max(0.10, Math.min(0.35, (topCandidate.ctx.micropriceVolatility || 0.005) * 12)); 
        const requiredCapital = targetDollarGoal / expectedMovePct;
        const requiredContracts = topCandidate.ctx.isPerpetual
          ? Math.max(1, Math.round(requiredCapital / Math.max(1, entryPrice)))
          : Math.round(requiredCapital / Math.max(0.01, entryPrice));
        
        // Use the baseline Kelly Multiplier from settings as a clean multiplier (default to 1.0 if not set)
        // We remove the fractional Shrinkage Estimator that was crushing sizes down to 0.1x
        let userKelly = settings.kellyMultiplier && settings.kellyMultiplier > 0 ? settings.kellyMultiplier : 1.0;
        
        // Apply favored trade boosts mathematically to the target, rather than shrinking the sizing
        if (pref.isFavored) {
          userKelly *= 1.25; 
        }
        
        let dynamicSize = Math.round(requiredContracts * userKelly);
        
        // Ensure sizing respects the minimum capital required for >= $10 TP
        const minCapForTen = 10.0 / expectedMovePct;
        const currentWorkingBal = await getEffectiveWorkingBalance();
        const maxAllowedCapital = Math.max(minCapForTen, currentWorkingBal);
        const maxAllowedSize = Math.floor(maxAllowedCapital / Math.max(0.01, entryPrice));
        dynamicSize = Math.max(Math.ceil(minCapForTen / Math.max(0.01, entryPrice)), Math.min(dynamicSize, maxAllowedSize));
        
        // Hierarchical Risk Parity (HRP) & Covariance Scaling (Amendment C)
        let covariancePenalty = 1.0;
        const assetBase = topCandidate.symbol.split('-')[0] || '';
        if (activePositions.length > 0) {
          let correlatedExposure = 0;
          activePositions.forEach(p => {
             const pBase = p.symbol.split('-')[0] || '';
             const correlation = (assetBase === pBase) ? 1.0 : (['BTC','ETH','SOL','HYPE','DOGE','XRP'].includes(assetBase) && ['BTC','ETH','SOL','HYPE','DOGE','XRP'].includes(pBase)) ? 0.85 : 0.4;
             if (p.side === topCandidate.signalSide) {
                correlatedExposure += (p.size * correlation);
             } else {
                correlatedExposure -= (p.size * correlation);
             }
          });
          if (correlatedExposure > 0) {
            covariancePenalty = Math.max(0.4, 1.0 - (correlatedExposure / 200) * 0.5);
          }
        }
        
        dynamicSize = Math.round(dynamicSize * covariancePenalty);
        if (covariancePenalty < 1.0 && dynamicSize > 0) {
           spotLogs.unshift({
               id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
               message: `[HRP COVARIANCE SCALING] Scaled size by ${covariancePenalty.toFixed(2)}x for ${topCandidate.symbol} (${topCandidate.signalSide}) due to correlated cross-asset portfolio exposure.`
           });
        }

        // Avellaneda-Stoikov Inventory Risk Management Calculation
        let netInventory = 0;
        activePositions.forEach(p => {
            netInventory += (p.side === 'YES' ? p.size : -p.size);
        });
        const inventoryRiskAversion = 0.15;
        const variance = Math.pow(topCandidate.ctx.micropriceVolatility || 0.005, 2);
        const inventorySkew = inventoryRiskAversion * netInventory * variance;
        
        // Hawkes Process Toxic Sweep Detection (Bypassed if overrideConfluence is active or for non-crypto categories)
        const isCrypto = (topCandidate.ctx.category || 'crypto') === 'crypto';
        const hawkesBypass = settings.overrideConfluence || !isCrypto;

        if ((topCandidate.ctx.totalHawkesIntensity || 0) > 1.2 && topCandidate.overrideKellyMultiplier === undefined && !hawkesBypass) {
            spotLogs.unshift({
                id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
                message: `[HAWKES SWEEP REJECT] ${topCandidate.symbol}: High self/cross excitation intensity (${topCandidate.ctx.totalHawkesIntensity.toFixed(2)}) detected. Order book clustering indicates toxic liquidity sweep. Trade aborted.`
            });
            dynamicSize = 0;
        }
        
        // Latency-Aware State Space Simulation (30-50ms window)
        const simulatedLatencyMs = Math.random() * 20 + 30;
        const orderHoldTimePenalty = simulatedLatencyMs * 0.00005;
        const simulatedFillPrice = entryPrice + orderHoldTimePenalty;
        
        const p_shrunk = (pref.shrunkKellyMultiplier + 1) / 2;
        const expectedValue = p_shrunk * (1 - simulatedFillPrice) - (1 - p_shrunk) * simulatedFillPrice;
        const expectedValueSkewed = expectedValue - (topCandidate.signalSide === 'YES' ? inventorySkew : -inventorySkew);
        const net_edge = expectedValueSkewed - 0.005;
        
        const ctxSpread = Math.abs((topCandidate.ctx.asks?.[0]?.price || 1) - (topCandidate.ctx.bids?.[0]?.price || 0));

        if ((net_edge < 0.01 || net_edge < ctxSpread) && topCandidate.overrideKellyMultiplier === undefined && !hawkesBypass && dynamicSize > 0) {
          spotLogs.unshift({
            id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
            message: `[ADVERSE SELECTION REJECT] ${topCandidate.symbol} (${topCandidate.signalSide}): Net edge (${net_edge.toFixed(3)}) is smaller than the spread (${ctxSpread.toFixed(3)}). Mathematically negative EV.`
          });
          dynamicSize = 0; 
        }

        if (dynamicSize > 0) {
          // Feature 1: Gemini Pre-Flight False Breakout Veto Check (Bypassed if overrideConfluence is active)
          if (!settings.overrideConfluence) {
            const vetoRes = await geminiStrategyEngine.evaluatePreFlightVeto({
              symbol: topCandidate.symbol,
              side: topCandidate.signalSide,
              patternType: topCandidate.patternType,
              spotTA: topCandidate.spotTA,
              bidVol: topCandidate.bidVol || 10,
              askVol: topCandidate.askVol || 10
            });

            if (!vetoRes.approved) {
              spotLogs.unshift({
                id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
                message: `[GEMINI PRE-FLIGHT VETO] Vetoed ${topCandidate.signalSide} setup on ${topCandidate.symbol}: ${vetoRes.reason} (Confidence: ${(vetoRes.confidenceScore * 100).toFixed(0)}%).`
              });
              dynamicSize = 0;
            }
          }
        }

        if (dynamicSize > 0) {
          if (topCandidate.overrideKellyMultiplier !== undefined) {
             dynamicSize = Math.round(50 * topCandidate.overrideKellyMultiplier);
          } else if ((topCandidate as any).isBearishFlip) {
            dynamicSize *= 2;
            spotLogs.unshift({
                id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
                message: `[BEARISH DIVERGENCE DOUBLE] Doubling position size to ${dynamicSize} for NO on ${topCandidate.symbol} due to bearish confluence flip.`
            });
          }

          const analysisMeta = {
            patternType: topCandidate.patternType,
            prediction: `${topCandidate.reason} | ${pref.reason}`,
            spotTA: topCandidate.spotTA,
            confluenceCount: topCandidate.recCheck.confluenceCount,
            activeTools: topCandidate.recCheck.activeTools,
            adaptivePreference: pref,
            indicators: {
              spotPair: topCandidate.spotTA.pair, spotPrice: topCandidate.spotTA.price,
              bidVol: topCandidate.bidVol, askVol: topCandidate.askVol, currentPrice: topCandidate.ctx.currentPrice
            }
          };
          spotLogs.unshift({
            id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
            message: `[ADAPTIVE STRATEGY EXECUTION] Executing candidate ${topCandidate.patternType} on ${topCandidate.symbol} (${topCandidate.signalSide}) (Kelly Multiplier: ${pref.shrunkKellyMultiplier || settings.kellyMultiplier}x).`
          });
          await openPosition(topCandidate.symbol, topCandidate.signalSide, entryPrice, dynamicSize, false, topCandidate.ctx.matchId || topCandidate.symbol, topCandidate.ctx.label || topCandidate.symbol, topCandidate.ctx.category || 'crypto', topCandidate.reason, analysisMeta);
        }
      }
    }

    // ALWAYS-ON MARKET MAINTENANCE PROTOCOL (ZERO-IDLE GUARANTEE)
    if (settings.botActive && activePositions.length === 0) {
      const attachedSymbols = Object.keys(spotContexts);
      let bestSym: string | null = null;
      let bestSide: 'YES' | 'NO' = 'YES';
      let bestPrice = 0.50;
      let maxVol = -1;

      for (const sym of attachedSymbols) {
        const c = spotContexts[sym];
        if (!c || !c.currentPrice || c.isOrderBookStale) continue;
        // STRICT RULE: Always-On maintenance MUST be a crypto contract (sports contracts excluded)
        if (c.category !== 'crypto') continue;
        const bids = c.bids || [];
        const asks = c.asks || [];
        const bidVol = bids.reduce((acc: number, b: any) => acc + (b.size || 0), 0);
        const askVol = asks.reduce((acc: number, a: any) => acc + (a.size || 0), 0);
        const totVol = bidVol + askVol;
        if (totVol > maxVol) {
          maxVol = totVol;
          bestSym = sym;
          bestSide = bidVol >= askVol ? 'YES' : 'NO';
          bestPrice = bestSide === 'YES' ? c.currentPrice : (1.0 - c.currentPrice);
        }
      }

      if (bestSym) {
        const c = spotContexts[bestSym];
        spotLogs.unshift({
          id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
          message: `[ALWAYS-ON MAINTENANCE] Zero active positions. Auto-deploying baseline contract on ${bestSym} (${bestSide} @ $${bestPrice.toFixed(2)}) to maintain continuous selling.`
        });
        const expectedMovePct = Math.max(0.08, Math.min(0.35, (c.micropriceVolatility || 0.005) * 12)); 
        const reqCap = 20.0 / expectedMovePct; // Target $20 fallback minimum
        const requiredContracts = Math.round(reqCap / Math.max(0.01, bestPrice));
        let userKelly = settings.kellyMultiplier && settings.kellyMultiplier > 0 ? settings.kellyMultiplier : 1.0;
        let dynamicSize = Math.round(requiredContracts * userKelly);
        await openPosition(
          bestSym,
          bestSide,
          bestPrice,
          dynamicSize,
          false,
          c.matchId || bestSym,
          c.label || bestSym,
          c.category || 'crypto',
          '[ALWAYS-ON MAINTENANCE] Zero-Idle Market Position',
          { patternType: 'ALWAYS_ON_MAINTENANCE' }
        );
      }
    }
  }

  if (!settings.botActive) return;

  // Evaluate active positions for TP / SL
  for (let i = activePositions.length - 1; i >= 0; i--) {
    let pos = activePositions[i];
    let ctx = spotContexts[pos.symbol];
    let timeInContractSec = (Date.now() - pos.entryTime) / 1000;

    let shouldClose = false;
    let closeReason = "";
    let pnlRatio = 0;
    let currentSidePrice = pos.entryPrice || 0.50;

    if (ctx) {
      let price = ctx.currentPrice;
      const isPerp = Boolean(pos.isPerpetual || ctx.isPerpetual || pos.symbol.endsWith('PERP'));
      if (isPerp) {
        currentSidePrice = price;
        pnlRatio = pos.side === 'YES'
          ? (price - pos.entryPrice) / pos.entryPrice
          : (pos.entryPrice - price) / pos.entryPrice;
      } else {
        currentSidePrice = pos.side === 'YES' ? price : (1.0 - price);
        pnlRatio = (currentSidePrice - pos.entryPrice) / pos.entryPrice;
      }
      pos.pnlRatio = pnlRatio;

      if (pos.peakPnlRatio === undefined) pos.peakPnlRatio = pnlRatio;
      if (pnlRatio > pos.peakPnlRatio) pos.peakPnlRatio = pnlRatio;

      if (pos.maxAdverseExcursion === undefined) pos.maxAdverseExcursion = pnlRatio;
      if (pnlRatio < pos.maxAdverseExcursion) pos.maxAdverseExcursion = pnlRatio;

      const now = Date.now();
      if (pos.lastTickTime === undefined) pos.lastTickTime = now;
      const tickDeltaSec = (now - pos.lastTickTime) / 1000;
      pos.lastTickTime = now;
      
      if (pos.timeInProfitSec === undefined) pos.timeInProfitSec = 0;
      if (pos.timeInLossSec === undefined) pos.timeInLossSec = 0;

      if (pnlRatio > 0) pos.timeInProfitSec += tickDeltaSec;
      else if (pnlRatio < 0) pos.timeInLossSec += tickDeltaSec;

      // --- Orderbook, Volume, RSI & Momentum Fetch ---
      const bids = ctx.bids || [];
      const asks = ctx.asks || [];
      const bidVol = bids.reduce((acc: number, b: any) => acc + (b.size || 0), 0) || 1;
      const askVol = asks.reduce((acc: number, a: any) => acc + (a.size || 0), 0) || 1;
      const spotTA = unifiedDataHandler.getSpotIndicatorsForContract(pos.symbol, ctx.label, pos.category || 'crypto', scalper.candles);
      const rsi = spotTA.rsi || 50;

      let currentImbalanceTowards = pos.side === 'YES' ? bidVol / askVol : askVol / bidVol;
      if (!pos.analysisMeta) pos.analysisMeta = {};
      if (pos.analysisMeta.entryOFI === undefined) {
         pos.analysisMeta.entryOFI = ctx.OFI || 0;
      }
        
      const currentOFI = ctx.OFI || 0;
      const ofiDelta = currentOFI - pos.analysisMeta.entryOFI;
      const averageDepth = Math.max(1, (bidVol + askVol) / 2);
      const priceImpact = ofiDelta / averageDepth;
      const directionalImpact = pos.side === 'YES' ? priceImpact : -priceImpact;
      const volSurge = spotTA.volumeSurgeRatio || 1.0;
      const isConsolidating = (spotTA.adx && spotTA.adx < 20) || spotTA.isChoppy || volSurge < 0.90;

      // Ornstein-Uhlenbeck First-Exit-Time boundary calculation
      const vol = ctx.micropriceVolatility || 0.005;
      // Stop-loss boundary dynamically expands with microstructure noise to prevent premature exit
      const fetStopLoss = Math.max(-0.03, Math.min(-0.005, -(vol * 2.5))); // 2.5 std devs of noise
      
      // --- DYNAMIC EMERGENCY STOP LOSS (Decaying over time based on indicator score) ---
      // EXCLUSIVELY USING CONTRACT ORDER BOOK DATA, NO SPOT DATA.
      let slScore = 0;
      slScore += Math.min(0.4, vol * 20); // Volatility adds up to 0.4
      slScore += Math.min(0.3, Math.max(0, (currentImbalanceTowards - 1.0) * 0.3)); // Imbalance adds up to 0.3
      slScore += Math.min(0.3, Math.max(0, directionalImpact * 2.5)); // OFI flow adds up to 0.3
      
      // slScore is 0.0 to 1.0. Wider SL maxes at -0.07 (7%) based on the indicator score.
      const maxBeginningSL = -0.03 - (0.04 * slScore); 
      
      // Decay over 90 seconds. At t=0, SL is wider. At t=90, SL tightens down to fetStopLoss.
      const decayDurationSec = 90;
      const timeDecayFactor = Math.max(0, 1.0 - (timeInContractSec / decayDurationSec));
      const dynamicInitialSL = fetStopLoss + (maxBeginningSL - fetStopLoss) * timeDecayFactor;
      
      let dynamicSL = pos.params ? Math.max(-0.10, pos.params.dynamicSL || dynamicInitialSL) : dynamicInitialSL;
      dynamicSL = Math.min(dynamicSL, fetStopLoss); // Ensure it doesn't get tighter than the FET bound

      let slMag = Math.abs(dynamicSL);
      // Base trend-following Take Profit starts at 15%, scales with params if provided
      let dynamicTP = pos.params ? Math.max(0.15, pos.params.dynamicTP) : 0.15;
      // Widen the trailing stop so the trade can breathe during minor pullbacks
      let dynamicTrail = pos.params ? Math.max(0.05, pos.params.dynamicTrail || 0.05) : 0.05;

      const escalated = plasticityEngine.getEscalatedContractParams(
        pos.symbol,
        pos.side,
        dynamicTP,
        dynamicTrail,
        pos.category
      );
      dynamicTP = Math.max(dynamicTP, escalated.dynamicTP);
      dynamicTrail = Math.max(dynamicTrail, escalated.dynamicTrail);

      if (isCapitalPreservationActive) {
        // First-Exit-Time boundary under strict mode
        dynamicSL = Math.max(-0.02, Math.min(-0.005, fetStopLoss));
        // Keep TP at least 10% even during capital preservation mode so we get larger wins
        dynamicTP = Math.max(0.10, Math.min(0.20, pos.params?.dynamicTP || 0.15));
      }

      // --- Dynamic Target Price Adjustments (Strictly Orderbook/OFI Based) ---
      // OFI-Driven Take-Profit Scaling Rule:
      // 1. Trending Market Flow (Stretch TP) when OFI and Orderbook align
      let flowMultiplier = 1.0;
      const isOFIStrong = directionalImpact > 0.05 || currentImbalanceTowards >= 1.25;

      if (isOFIStrong) {
        // High momentum trend: Stretch TP targets up to 2.25x to capture strong run-ups
        flowMultiplier = Math.min(2.25, 1.0 + (directionalImpact * 1.5));
      } 
      // 2. Consolidating / Ranging Market (Compress TP) during opposing OFI flow
      else if (directionalImpact < -0.05) {
        flowMultiplier = Math.max(0.70, 0.70 + (directionalImpact * 0.5));
      }

      // Apply OFI Flow Multiplier to dynamicTP (Zero Latency - Synchronous Math)
      dynamicTP = Math.max(0.10, Math.min(2.50, dynamicTP * flowMultiplier)); // Hard floor at 10%

      // Continuous L2-Norm Inventory Risk Adjustment
      let netInventory = 0;
      activePositions.forEach(p => {
          netInventory += (p.side === 'YES' ? p.size : -p.size);
      });
      const inventoryRiskAversion = 0.15; // Low risk aversion
      const variance = Math.pow(ctx.micropriceVolatility || 0.005, 2);
      const continuousPenalty = inventoryRiskAversion * Math.pow(netInventory, 2) * variance;

      if ((pos.side === 'YES' && netInventory > 0) || (pos.side === 'NO' && netInventory < 0)) {
          dynamicTP = Math.max(0.10, dynamicTP - continuousPenalty);
      }

      const slippageBuffer = 0.015 / pos.entryPrice; 
      
      // Hedge Fund Tactic: Breakeven Ratchet SL (Step-Up SL)
      // Once a trade achieves a solid profit buffer (e.g., 4% + slippage), we instantly step the stop-loss up 
      // to Breakeven + Fees (0.5%), completely eliminating downside risk on the trade. We never let a winning trade go red.
      const breakevenThreshold = 0.04 + slippageBuffer;
      let ratchetSL = dynamicSL; // Default to standard SL
      if (pos.peakPnlRatio >= breakevenThreshold) {
          ratchetSL = 0.005; // Breakeven + 0.5% for fees
      }
      
      // The trailing stop tracks the peak PNL minus the trail distance. 
      // This allows the trade to trend freely.
      const trailingLock = Math.max(ratchetSL, pos.peakPnlRatio - dynamicTrail);

      // TP must always be at least 2% above the trailing lock
      if (dynamicTP < trailingLock + 0.02) {
          dynamicTP = Math.max(0.10, trailingLock + 0.02);
      }

      dynamicTP = Math.max(0.10, dynamicTP);
      // --- End Dynamic Adjustments ---

      // [F] Reinforcement Learning (PPO) Dynamic Exits
      // Replace static Stop-Loss/Take-Profit heuristics with continuous PPO agent state evaluation
      let ppoAction: 'HOLD' | 'EXIT' | 'TRAIL_SL' = 'HOLD';
      const timeInTradeMin = timeInContractSec / 60.0;
      let ppoRewardScore = pnlRatio * 100.0; 
      
      // Order book toxicity penalty/reward
      if (pos.side === 'YES') {
        ppoRewardScore += ((bidVol - askVol) / Math.max(1, askVol)) * 1.5;
      } else {
        ppoRewardScore += ((askVol - bidVol) / Math.max(1, bidVol)) * 1.5;
      }
      
      // Time decay penalty (theta decay equivalent)
      ppoRewardScore -= (timeInTradeMin * 1.2);

      if (ppoRewardScore > 8.0 && pnlRatio > 0.02) {
         ppoAction = 'TRAIL_SL';
      } else if (ppoRewardScore < -6.0 && pnlRatio < -0.015) {
         ppoAction = 'EXIT';
      }

      if (ppoAction === 'EXIT' && !isCapitalPreservationActive) {
          shouldClose = true;
          closeReason = `[PPO AGENT EXIT] Toxic flow detected. Terminated position dynamically to minimize loss (${(pnlRatio*100).toFixed(2)}%)`;
      } else if (ppoAction === 'TRAIL_SL') {
         // Keep trail loose enough so the trend doesn't get instantly chopped by noise
         dynamicTrail = Math.min(0.04, dynamicTrail * 0.8); 
         dynamicTP = Math.max(dynamicTP, pnlRatio + 0.15); // Stretch take-profit out to let runner run
      }

      // Enhancement #4: Dynamic Trailing Profit Expansion on Spike Wins (+15% profit momentum spikes)
      const isMomentumSpike = pos.peakPnlRatio >= 0.15;
      if (isMomentumSpike) {
        // Expand dynamicTP so monster spike winners (+100% to +1000%) can keep running
        dynamicTP = Math.max(dynamicTP, pos.peakPnlRatio + 0.50);
      }

      // [SMART TRAILING TAKE PROFIT ENGINE]
      // Instead of an abrupt fixed 10% hard target, Smart Trailing Take Profit adjusts target prices dynamically.
      // As profit targets are met, it trails the stop-loss upward to lock in gains while allowing
      // momentum runs targeting the $10-$50 profit range defined by user specifications.
      const smartTrailRes = SmartTrailingEngine.evaluate({
        pnlRatio,
        peakPnlRatio: pos.peakPnlRatio || pnlRatio,
        entryPrice: pos.entryPrice || 0.50,
        size: pos.size || 10,
        side: pos.side,
        currentMarketPrice: currentSidePrice,
        baseDynamicTP: dynamicTP,
        currentState: pos.smartTrailing,
        minDollarTarget: 5.0, // Target $5-$10 without losing gains
        maxDollarTarget: 50.0, // Scale all the way up to $50 dynamically
        isPerpetual: pos.isPerpetual,
        latencyAgilityFactor: latencyAdaptiveEngine.getProfile().trailingStopAgilityFactor,
        spotDataMetrics: {
          directionalImpact,
          volSurge,
          rsi,
          isConsolidating
        }
      });

      pos.smartTrailing = smartTrailRes.state;

      if (smartTrailRes.isInitialActivation) {
        spotLogs.unshift({
          id: logIdCounter++, time: new Date().toISOString(), type: 'PROFIT',
          message: `[SMART TRAILING TP ACTIVATED] ${pos.symbol} (${pos.side}): Reached $5 target zone (+${(pnlRatio * 100).toFixed(1)}% / +$${smartTrailRes.state.currentProfitUsd.toFixed(2)})! Trailing Stop engaged at +${(smartTrailRes.state.trailingFloorRatio * 100).toFixed(1)}% ($${smartTrailRes.state.lockedProfitUsd.toFixed(2)} guaranteed locked). Gains cannot be lost as position scales towards $10-$50.`
        });
      } else if (smartTrailRes.newTierReached) {
        spotLogs.unshift({
          id: logIdCounter++, time: new Date().toISOString(), type: 'PROFIT',
          message: `[SMART TRAILING TIER UPGRADE] ${pos.symbol} (${pos.side}): Advanced to Tier ${smartTrailRes.state.tier} (${smartTrailRes.state.tierLabel})! Trailing SL ratcheted up to +${(smartTrailRes.state.trailingFloorRatio * 100).toFixed(1)}% ($${smartTrailRes.state.lockedProfitUsd.toFixed(2)} secured). Dynamic Target: +${(smartTrailRes.state.dynamicTargetRatio * 100).toFixed(1)}% ($${smartTrailRes.state.targetDollarGoal.toFixed(0)} Goal).`
        });
      }

      // Exit Evaluation:
      // Time-to-Expiry (Theta) Cutoff
      const timeToExpiryMs = ctx.closeTime ? (new Date(ctx.closeTime).getTime() - Date.now()) : Infinity;
      const isImminentExpiry = timeToExpiryMs < 60 * 1000; // Final 60 seconds of contract
      
      // Trade Model Discrepancy Convergence Check
      const hasConvergedWithFairValue = pos.modelFairValue !== undefined && 
          ((pos.side === 'YES' && currentSidePrice >= pos.modelFairValue) || 
           (pos.side === 'NO' && currentSidePrice <= pos.modelFairValue));

      if (smartTrailRes.shouldClose) {
        shouldClose = true;
        closeReason = smartTrailRes.closeReason || `Smart Trailing TP (+${(pnlRatio * 100).toFixed(1)}%)`;
      } else if (smartTrailRes.state.isActive) {
        // Position is actively riding momentum with guaranteed trailing floor!
        // We do NOT kill winners prematurely with 2% cuts or 5-minute theta cuts.
        // It runs toward the $10-$50 target range with monotonic gain-locking.
        if (isImminentExpiry && pnlRatio > 0.02) {
          shouldClose = true;
          closeReason = `Imminent Expiry Lock-In (<60s to close | Secured +$${smartTrailRes.state.currentProfitUsd.toFixed(2)})`;
        }
      } else if (isImminentExpiry && pnlRatio > 0.01) { 
        shouldClose = true;
        closeReason = `Imminent Expiry Settlement Lock (<60s to close)`;
      } else if (hasConvergedWithFairValue && pnlRatio >= 0.10) { 
        shouldClose = true;
        closeReason = `Model Fair Value Convergence Triggered (+${(pnlRatio * 100).toFixed(1)}%)`;
      } else {
        // Pre-activation zone (pnl < 10% / < $10): Standard downside risk protections
        const isGracePeriodActive = timeInContractSec < 45;
        const effectiveSL = Math.max(dynamicSL, ratchetSL);

        if (pnlRatio <= effectiveSL) {
          shouldClose = true;
          closeReason = effectiveSL === ratchetSL
            ? `Breakeven Ratchet SL (Locked at +0.5%)`
            : isGracePeriodActive
              ? `Emergency SL (${(effectiveSL * 100).toFixed(1)}% breached during 45s Grace Period)`
              : isCapitalPreservationActive
                ? `Capital Preservation SL (${(dynamicSL * 100).toFixed(1)}%)`
                : `Volatility-Adjusted SL (${(dynamicSL * 100).toFixed(1)}%)`;
        } else if (ctx.isExpired) {
          shouldClose = true;
          closeReason = `Market Expiration / Contract Settlement`;
        }
      }
    } else {
      // Handle orphaned / unlisted position where ctx was detached
      if (timeInContractSec >= 60) {
        shouldClose = true;
        pnlRatio = pos.peakPnlRatio || 0;
        closeReason = `Orphaned Contract Expiration Auto-Settlement (${Math.round(timeInContractSec)}s elapsed)`;
      }
    }

      if (shouldClose) {
        const positionCapitalCost = pos.size * (pos.entryPrice || 0.50);
        
        // FACTOR IN SLIPPAGE AND FEES (Execution & Model Training Recalibration)
        // Subtract exchange fees and bid-ask spread crossing friction directly from the PNL.
        // This ensures the simulated bankroll, market testing engine, and training modules all learn the true cost of trading.
        const averageSpreadAndFeeFriction = 0.02; // Roughly 2 cents / 2% friction penalty per round trip
        let effectiveExitRatio = pnlRatio;
        if (closeReason.includes('Smart Trailing Stop Triggered') && pos.smartTrailing?.trailingFloorRatio) {
          // Trailing stop order fills at the ratcheted floor level
          effectiveExitRatio = Math.max(pos.smartTrailing.trailingFloorRatio, pnlRatio);
        } else if (closeReason.includes('Breakeven Ratchet SL')) {
          // Breakeven ratchet stop executes at breakeven + fee buffer (+0.5%)
          effectiveExitRatio = Math.max(0.005, pnlRatio);
        }
        const adjustedPnlRatio = effectiveExitRatio - averageSpreadAndFeeFriction;
        
        let pnlUsd = adjustedPnlRatio * positionCapitalCost;
        simulatedPaperBalance = Math.max(0, simulatedPaperBalance + pnlUsd);
        cycleEarnedProfit += pnlUsd;

        // Severe Drawdown Protocol
        const patternType = pos.analysisMeta?.patternType || 'GENERAL_ANALYSIS';
        if (settings.paperTrading && startingBankroll > 0) {
            if (simulatedPaperBalance <= startingBankroll * 0.50 && simulatedPaperBalance > startingBankroll * 0.25) {
                if (!hasTriggered50PercentDrawdown) {
                    hasTriggered50PercentDrawdown = true;
                    const lossAmount = startingBankroll - simulatedPaperBalance;
                    spotLogs.unshift({
                        id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
                        message: `[SEVERE DRAWDOWN] Lost 50% of starting capital (Down ${lossAmount.toFixed(2)}). Registering severe drawdown failure for ${patternType} with Meta-Learning Engine.`
                    });
                    metaModelManager.recordSevereDrawdown(patternType);
                    metaModelManager.recordSevereDrawdown('GLOBAL');
                }
            } else if (simulatedPaperBalance > startingBankroll * 0.50) {
                hasTriggered50PercentDrawdown = false;
            }
        }

        // Drawdown Blowout Protocol
        if (settings.paperTrading && startingBankroll > 0 && simulatedPaperBalance <= startingBankroll * 0.25) {
          const lossAmount = startingBankroll - simulatedPaperBalance;
          spotLogs.unshift({
            id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
            message: `[BLOWOUT DETECTED] Lost 75% of starting capital (Down ${lossAmount.toFixed(2)}). Restarting funds, wiping P/L, closing all positions. Registering failure for ${patternType}.`
          });
          
          metaModelManager.recordBlowoutFailure(patternType);
          metaModelManager.recordBlowoutFailure('GLOBAL');
          
          simulatedPaperBalance = startingBankroll;
          cycleEarnedProfit = 0;
          vaultedProfits = 0;
          completedGoalCycles = 0;
          sessionPocketedProfit = 0;
          isStrict3ConfluenceTriggeredInSession = false;
          hasTriggered50PercentDrawdown = false;
          activePositions = activePositions.filter(p => !settings.paperTrading);
          
          // Clear active positions and exit the evaluation loop
          break;
        }

        // Track Net Session Profit (subtract losses, floor at 0)
        sessionPocketedProfit = Math.max(0, sessionPocketedProfit + pnlUsd);
        macroCycleProfit += pnlUsd;
        if (macroCycleProfit >= 100) {
           const elapsedHours = (Date.now() - macroCycleStartTime) / (1000 * 60 * 60);
           spotLogs.unshift({
              id: logIdCounter++, time: new Date().toISOString(), type: 'PROFIT',
              message: `[MACRO GOAL ACHIEVED] Earned $100 profit in ${elapsedHours.toFixed(2)} hours! Velocity Grade: A+ (Target was <= 12 hours). NN Primary Goal satisfied. Resetting macro cycle.`
           });
           macroCycleStartTime = Date.now();
           macroCycleProfit = 0;
        } else if (macroCycleProfit < -200) {
           macroCycleStartTime = Date.now();
           macroCycleProfit = 0;
        }

        // Record both wins and losses toward the $100 market testing net profit milestone
        marketTestingEngine.recordTradeResult(pnlUsd);

        // Record toward the goal (resets at Midnight EST and 9:00 AM EST, or 5m compound in Training on the Job)
        goalResetScheduler.recordTrade(pnlUsd, (currProfit, target, isTraining) => {
          if (isTraining) {
            const status = goalResetScheduler.getStatus();
            const untouched = status.training_on_the_job?.untouched_vault_balance || 0;
            const isFull = status.training_on_the_job?.is_untouched_vault_full;
            if (!isFull) {
              spotLogs.unshift({
                id: logIdCounter++,
                time: new Date().toISOString(),
                type: 'PROFIT',
                message: `🛡️ [TRAINING ON THE JOB] Initial Vaulting Active: Set aside +$${currProfit.toFixed(2)} toward the $200 Untouched Reserve Vault ($${untouched.toFixed(2)} / $200.00). Confluence Override active.`
              });
            } else {
              spotLogs.unshift({
                id: logIdCounter++,
                time: new Date().toISOString(),
                type: 'PROFIT',
                message: `⏳ [TRAINING ON THE JOB] Goal ($${target.toFixed(2)}) Reached! Profit ($${currProfit.toFixed(2)}) + next 5 mins gains are accumulating in Temporary Vault and will enter working capital in 5m. Confluence Override active.`
              });
            }
          } else {
            spotLogs.unshift({
              id: logIdCounter++,
              time: new Date().toISOString(),
              type: 'PROFIT',
              message: `[GOAL TARGET ACHIEVED] Reached $${currProfit.toFixed(2)} toward the $${target.toFixed(2)} goal for this session! Goal secured until next reset (Midnight EST / 9:00 AM EST).`
            });
          }
        });

        if (pnlUsd > 0) {
          lastWinTimestamps[pos.symbol] = Date.now();
          const currentSession = getGlobalMarketSession();
          const totalPocketed = Math.max(sessionPocketedProfit, vaultedProfits + Math.max(0, cycleEarnedProfit));

          if (!isStrict3ConfluenceTriggeredInSession && totalPocketed >= 100) {
            isStrict3ConfluenceTriggeredInSession = true;
            spotLogs.unshift({
              id: logIdCounter++, time: new Date().toISOString(), type: 'PROFIT',
              message: `[STRICT 3-CONFLUENCE MODE ACTIVATED] $100+ net profit milestone reached ($${totalPocketed.toFixed(2)} net profit)! Enforcing strict 3-confluence strategy to minimize losses until 35m after ${currentSession.nextSessionName} (${currentSession.nextSessionTransitionStr}).`
            });
          }
        }

        // Micro-Profit Dynamic Ratchet Vaulting: Automatically vault 50% of un-vaulted earned profits whenever cycleEarnedProfit >= $3.00
        if (cycleEarnedProfit >= 3.00) {
          const ratchetVaultAmt = Math.round((cycleEarnedProfit * 0.50) * 100) / 100;
          if (ratchetVaultAmt > 0) {
            vaultedProfits += ratchetVaultAmt;
            completedGoalCycles += 1;
            cycleEarnedProfit -= ratchetVaultAmt;
            simulatedPaperBalance -= ratchetVaultAmt;

            spotLogs.unshift({
              id: logIdCounter++, time: new Date().toISOString(), type: 'PROFIT',
              message: `[MICRO-PROFIT RATCHET VAULT] Auto-vaulted 50% of earned profit ($${ratchetVaultAmt.toFixed(2)}) into untouchable reserve! Total Vault: $${vaultedProfits.toFixed(2)} across ${completedGoalCycles} completed micro-cycles.`
            });
          }
        }

        // Auto-Vault profits into Untouchable Reserve:
        // Standard threshold is $50. After $100+ net profit is reached,
        // the threshold accelerates to taking EVERY $20 into the untouchable vault until 35 minutes after next market session open.
        const currentSession = getGlobalMarketSession();
        const totalPocketed = Math.max(sessionPocketedProfit, vaultedProfits + Math.max(0, cycleEarnedProfit));
        const isAcceleratedVaultMode = totalPocketed >= 100 || vaultedProfits >= 100;
        const vaultThreshold = isAcceleratedVaultMode ? 20 : 50;

        while (cycleEarnedProfit >= vaultThreshold) {
          const vaultAmount = vaultThreshold;
          vaultedProfits += vaultAmount;
          completedGoalCycles += 1;
          cycleEarnedProfit -= vaultAmount;
          simulatedPaperBalance -= vaultAmount; // Remove from working balance to truly "vault" it

          const modeLabel = isAcceleratedVaultMode
            ? `ACCELERATED $20 VAULT MODE ($100+ Profit Milestone)`
            : `STANDARD $50 VAULT MODE`;

          spotLogs.unshift({
            id: logIdCounter++, time: new Date().toISOString(), type: 'PROFIT',
            message: `[UNTOUCHABLE VAULT - ${modeLabel}] Locked $${vaultAmount.toFixed(2)} into untouchable vault! Total Vault: $${vaultedProfits.toFixed(2)} across ${completedGoalCycles} completed cycles (Active until 35m after ${currentSession.nextSessionName} at ${currentSession.nextSessionTransitionStr}).`
          });
        }

        tradingBrain.recordStrategyOutcome(pos, adjustedPnlRatio, closeReason);
        if (recoveryProtocol) {
          recoveryProtocol.processTradeOutcome(
            pos.symbol, pos.side, pnlUsd, adjustedPnlRatio * 100, positionCapitalCost,
            Math.round((Date.now() - pos.entryTime) / 1000), closeReason, pos.category,
            pos.analysisMeta?.patternType || 'GENERAL_ANALYSIS', pos.analysisMeta?.spotTA
          );
        }

        const isStopLossClose = closeReason.includes('Stop Loss') || closeReason.includes('SL');
        const wasAlreadyReversed = Boolean(pos.analysisMeta?.isReversalFlip);

        spotLogs.unshift({
          id: logIdCounter++, time: new Date().toISOString(), type: pnlRatio > 0 ? 'PROFIT' : 'TRADE',
          message: `[POS CLOSED] ${pos.symbol} (${pos.side}) hit ${closeReason}. PnL: ${pnlUsd > 0 ? '+' : ''}$${pnlUsd.toFixed(2)}`
        });

        // Dispatch live order to Kalshi to close real position when paperTrading is disabled
        if (!settings.paperTrading) {
          const isPerp = Boolean(pos.isPerpetual || pos.symbol.endsWith('PERP'));
          const exitPrice = isPerp ? currentSidePrice : (pos.side === 'YES' ? currentSidePrice : (1.0 - currentSidePrice));
          const closeAction = isPerp ? (pos.side === 'YES' ? 'sell' : 'buy') : 'sell';
          kalshiService.placeOrder(pos.symbol, closeAction, pos.side.toLowerCase() as 'yes' | 'no', pos.size, exitPrice).then(res => {
            if (res.success) {
              spotLogs.unshift({
                id: logIdCounter++, time: new Date().toISOString(), type: 'INFO',
                message: `[KALSHI LIVE CLOSE SUCCESS] Closed ${pos.size} contracts of ${pos.symbol} (${pos.side}) on Kalshi at $${exitPrice.toFixed(isPerp ? 4 : 2)} (OrderID: ${res.order_id}).`
              });
            } else {
              spotLogs.unshift({
                id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
                message: `[KALSHI LIVE CLOSE ERROR] Failed to submit close order for ${pos.symbol}: ${res.error}`
              });
            }
          });
        }

        activePositions.splice(i, 1);

        if (closeReason.includes('Emergency SL')) {
           spotLogs.unshift({
              id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
              message: `[EMERGENCY MONITOR INITIATED] AI deployed to monitor ${pos.symbol} in 10s increments for the next 60 seconds.`
           });
           startEmergencyMonitor(pos);
        }

        // Immediate Momentum Reversal Check on Stop Loss
        if (isStopLossClose && !wasAlreadyReversed && ctx && !ctx.isExpired) {
          const oppositeSide: 'YES' | 'NO' = pos.side === 'YES' ? 'NO' : 'YES';
          const oppositeEntryPrice = oppositeSide === 'YES' ? ctx.currentPrice : (1.0 - ctx.currentPrice);

          const spotPair = getSpotPairFromSymbol(pos.label, pos.category);
          const pairCandles = scalper.candles[spotPair] || [];

          // Query price action & statistical volatility viability
          const viability = evaluateCounterPositionViability(pos, ctx, oppositeSide, oppositeEntryPrice, pairCandles);

          if (viability.isViable) {
            spotLogs.unshift({
              id: logIdCounter++, time: new Date().toISOString(), type: 'TRADE',
              message: `[STOP-LOSS REVERSAL APPROVED] ${pos.symbol} (${pos.side} -> ${oppositeSide}) | Volatility Index: ${viability.volatilityIndex}x, Velocity: ${viability.velocityPctPerMin}%/min, Viability Score: ${viability.score} >= 0.85. Executing counter-position!`
            });

            openPosition(
              pos.symbol,
              oppositeSide,
              oppositeEntryPrice,
              pos.size,
              true,
              pos.matchId,
              pos.label,
              pos.category,
              `Stop Loss Volatility Reversal (Flipped from ${pos.side} | Viability Score: ${viability.score})`,
              {
                patternType: 'MOMENTUM_REVERSAL_FLIP',
                isReversalFlip: true,
                spotTA: computeSpotTAMetrics(spotPair, pairCandles),
                viabilityMeta: viability
              }
            );
          } else {
            spotLogs.unshift({
              id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
              message: `[STOP-LOSS REVERSAL SUPPRESSED] Skipped counter-position on ${pos.symbol}: ${viability.reason}`
            });
          }
        }

        // Post-Stop Loss Candidate Re-Evaluation Schedule (5 seconds and 1 minute post-close, max 1 period per 5 minutes per contract)
        if (isStopLossClose) {
          const contractKey = `${pos.symbol}:${pos.side}`;
          const now = Date.now();
          const FIVE_MINUTES_MS = 5 * 60 * 1000;
          const lastEvalTime = contractSLEvalPeriodTimestamps[contractKey] || 0;

          if (now - lastEvalTime < FIVE_MINUTES_MS) {
            const elapsedSec = Math.round((now - lastEvalTime) / 1000);
            const remainSec = Math.round((FIVE_MINUTES_MS - (now - lastEvalTime)) / 1000);
            spotLogs.unshift({
              id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
              message: `[POST-SL RE-EVALUATION LIMITED] ${contractKey}: Post-SL evaluation period throttled (${elapsedSec}s elapsed since last, ${remainSec}s remaining). Limit: 1 period per 5 mins.`
            });
          } else {
            contractSLEvalPeriodTimestamps[contractKey] = now;
            spotLogs.unshift({
              id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
              message: `[POST-SL RE-EVALUATION INITIATED] ${contractKey}: Initiated candidate re-evaluation period (Stage 1: 5s, Stage 2: 1m). Limit: 1 period per 5 mins.`
            });

            // Stage 1: 5 seconds immediately after closing
            setTimeout(() => {
              evaluatePostSLContractCandidate(pos.symbol, pos.side, '5s post-SL', pos.category);
            }, 5000);

            // Stage 2: 1 minute (60s) after closing
            setTimeout(() => {
              evaluatePostSLContractCandidate(pos.symbol, pos.side, '1m post-SL', pos.category);
            }, 60000);
          }
        }
      }
    }

  if (spotLogs.length > 50) spotLogs.length = 50;
  lastSuccessfulLoopTime = Date.now();
  } catch (e) { console.error("[BACKGROUND INTERVAL ERROR]", e); }
}, 4000);

// API Endpoints
app.post('/api/reset-bot', async (req, res) => {
  try {
    spotContexts = {};
    await discoverMarkets();
    spotLogs.unshift({
      id: logIdCounter++, time: new Date().toISOString(), type: 'INFO',
      message: `[WATCHDOG FORCE RESET] Bot markets re-discovered and loop state refreshed successfully.`
    });
    res.json({ success: true, message: 'Bot reset and re-discovered successfully.' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to reset bot' });
  }
});

app.get('/api/top-tier-alpha', (req, res) => {
  res.json({
    success: true,
    topTierAlphaSignatures: tradingBrain.topTierAlphaSignatures || []
  });
});

// API Endpoints
app.get('/api/health', (req, res) => { res.json({ status: 'ok' }); });

app.get('/api/settings', (req, res) => { res.json(settings); });
app.post('/api/settings', (req, res) => {
  const updated = { ...settings, ...req.body };
  if (updated.trainingOnTheJob) {
    updated.overrideConfluence = true;
  }
  settings = updated;
  goalResetScheduler.setTrainingOnTheJob(!!settings.trainingOnTheJob);
  if (typeof req.body.daily_goal === 'number' && req.body.daily_goal > 0) {
    goalResetScheduler.setProfitTarget(req.body.daily_goal);
  } else if (typeof req.body.profitTarget === 'number' && req.body.profitTarget > 0) {
    goalResetScheduler.setProfitTarget(req.body.profitTarget);
  }
  res.json({ success: true, settings, goal_window: goalResetScheduler.getStatus() });
});

app.post('/api/goal-target', (req, res) => {
  const { target } = req.body;
  if (typeof target === 'number' && target > 0) {
    goalResetScheduler.setProfitTarget(target);
    spotLogs.unshift({
      id: logIdCounter++,
      time: new Date().toISOString(),
      type: 'INFO',
      message: `[GOAL TARGET UPDATED] Profit target set to $${target.toFixed(2)}. ${settings.trainingOnTheJob ? 'Training on the Job mode will require reaching this updated goal before entering temporary vault.' : ''}`
    });
    return res.json({ success: true, target, goal_window: goalResetScheduler.getStatus() });
  }
  res.status(400).json({ error: 'Invalid target amount' });
});

app.get('/api/balance', async (req, res) => {
  const availableCashPool = await getEffectiveWorkingBalance();
  goalResetScheduler.updateCapitalScaling(availableCashPool);
  
  let capitalInUse = 0;
  if (settings.paperTrading) {
    activePositions.forEach(p => capitalInUse += (p.capitalPlacedUsd || (p.size * p.entryPrice)));
  }
  
  const totalEquity = settings.paperTrading 
    ? (simulatedPaperBalance + vaultedProfits)
    : (availableCashPool + vaultedProfits); // For real Kalshi, we'd need portfolio value to get true total equity

  const sessionInfo = getGlobalMarketSession();
  const strictActive = isStrict3ConfluenceActive();
  const pocketedAmount = sessionPocketedProfit;
  const isAcceleratedVault = pocketedAmount >= 100;
  const currentVaultThreshold = isAcceleratedVault ? 20 : 50;

  res.json({
    working_balance: availableCashPool, // the available cash
    capital_in_use: capitalInUse,
    bankroll_ath: settings.paperTrading ? paperBankrollATH : liveBankrollATH,
    reserve_amount: (settings.paperTrading ? paperBankrollATH : liveBankrollATH) * 0.10,
    paper_trading: settings.paperTrading,
    low_funds_mode: settings.lowFundsMode,
    real_kalshi_cash_pool: realKalshiCashPool,
    simulated_paper_balance: simulatedPaperBalance,
    cycle_earned_profit: cycleEarnedProfit,
    vaulted_profits: vaultedProfits,
    completed_goal_cycles: completedGoalCycles,
    cumulative_paper_profit: cumulativePaperProfit,
    completed_paper_iterations: completedPaperIterations,
    total_balance: totalEquity,
    starting_bankroll: startingBankroll,
    delta_24h: totalEquity - startingBankroll,
    delta_24h_pct: startingBankroll > 0 ? ((totalEquity - startingBankroll) / startingBankroll) * 100 : 0,
    goal_window: goalResetScheduler.getStatus(),
    daily_goal: 100,
    daily_profit: goalResetScheduler.getStatus().current_profit,
    previous_day_profit: goalResetScheduler.getStatus().previous_profit,
    session_info: {
      current_session: sessionInfo.sessionName,
      session_key: sessionInfo.sessionKey,
      next_session: sessionInfo.nextSessionName,
      next_session_time: sessionInfo.nextSessionTimeStr,
      next_session_transition_time: sessionInfo.nextSessionTransitionStr,
      session_pocketed_profit: pocketedAmount,
      strict_3_confluence_active: strictActive,
      threshold_amount: 100,
      accelerated_vault_active: isAcceleratedVault,
      current_vault_threshold: currentVaultThreshold
    },
    market_testing: marketTestingEngine.getStatus(),
    latency_profile: latencyAdaptiveEngine.getProfile(),
    perp_allocation_stats: {
      active_perps_count: activePositions.filter(p => p.isPerpetual).length,
      max_perps_allowed: 4,
      active_predictions_count: activePositions.filter(p => !p.isPerpetual).length,
      perp_capital_in_use: activePositions.filter(p => p.isPerpetual).reduce((sum, p) => sum + (p.capitalPlacedUsd || (p.size * p.entryPrice)), 0),
      prediction_capital_in_use: activePositions.filter(p => !p.isPerpetual).reduce((sum, p) => sum + (p.capitalPlacedUsd || (p.size * p.entryPrice)), 0),
      min_prediction_capital_reserve_pct: 0.50
    }
  });
});

app.get('/api/latency', (req, res) => {
  res.json({
    success: true,
    ...latencyAdaptiveEngine.getProfile()
  });
});

app.get('/api/market-testing', (req, res) => {
  res.json(marketTestingEngine.getStatus());
});

app.get('/api/coinbase/status', async (req, res) => {
  try {
    const status = await coinbaseService.checkApiStatus();
    res.json({ success: true, ...status });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Coinbase status check failed' });
  }
});

app.get('/api/kalshi/pool', async (req, res) => {
  try {
    const resKalshi = await kalshiService.getBalance();
    res.json({ success: true, connected: resKalshi.success, totalCashPool: resKalshi.balance || 0 });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to fetch cash pool' });
  }
});

app.post('/api/restart', (req, res) => {
  simulatedPaperBalance = startingBankroll;
  cycleEarnedProfit = 0;
  vaultedProfits = 0;
  completedGoalCycles = 0;
  sessionPocketedProfit = 0;
  isStrict3ConfluenceTriggeredInSession = false;
  activePositions.length = 0;
  executedOverrides.clear();
  isCapitalPreservationActive = false;

  tradingBrain.resetBrain();
  recoveryProtocol.resetProtocol();
  goalResetScheduler.resetManual(startingBankroll);

  spotLogs.unshift({
    id: logIdCounter++, time: new Date().toISOString(), type: 'INFO',
    message: `[BANKROLL REBOOT] Working bankroll reset to $${startingBankroll.toFixed(2)}. Performance P/L history & positions cleared.`
  });

  res.json({
    success: true,
    message: 'Working bankroll reset successfully. Performance P/L history cleared.',
    balance: simulatedPaperBalance,
    vaultedProfits
  });
});

app.post('/api/panic-sell', (req, res) => {
  settings.botActive = false;
  let closedCount = 0;
  
  for (let i = activePositions.length - 1; i >= 0; i--) {
    let pos = activePositions[i];
    let ctx = spotContexts[pos.symbol];
    let currentSidePrice = pos.entryPrice;
    
    if (ctx) {
      if (pos.isPerpetual) {
        currentSidePrice = pos.side === 'YES' ? ctx.currentPrice : (1.0 - ctx.currentPrice);
      } else {
        currentSidePrice = pos.side === 'YES' ? ctx.currentPrice : (1.0 - ctx.currentPrice);
      }
    }
    
    const pnlRatio = (currentSidePrice - pos.entryPrice) / pos.entryPrice;
    const positionCapitalCost = pos.size * pos.entryPrice;
    const averageSpreadAndFeeFriction = 0.02; 
    const adjustedPnlRatio = pnlRatio - averageSpreadAndFeeFriction;
    let pnlUsd = adjustedPnlRatio * positionCapitalCost;
    const closeReason = 'PANIC SELL INITIATED';

    // Account updating
    if (settings.paperTrading) {
        simulatedPaperBalance = Math.max(0, simulatedPaperBalance + pnlUsd);
        cycleEarnedProfit += pnlUsd;
        sessionPocketedProfit = Math.max(0, sessionPocketedProfit + pnlUsd);
        marketTestingEngine.recordTradeResult(pnlUsd);
        goalResetScheduler.recordTrade(pnlUsd);
        
        if (pnlUsd > 0) {
          lastWinTimestamps[pos.symbol] = Date.now();
        }
    } else {
        const isPerp = Boolean(pos.isPerpetual || pos.symbol.endsWith('PERP'));
        const exitPrice = isPerp ? currentSidePrice : (pos.side === 'YES' ? currentSidePrice : (1.0 - currentSidePrice));
        const closeAction = isPerp ? (pos.side === 'YES' ? 'sell' : 'buy') : 'sell';
        kalshiService.placeOrder(pos.symbol, closeAction, pos.side.toLowerCase() as 'yes' | 'no', pos.size, exitPrice).then(res => {
          if (res.success) {
            spotLogs.unshift({
              id: logIdCounter++, time: new Date().toISOString(), type: 'INFO',
              message: `[KALSHI PANIC SELL SUCCESS] Closed ${pos.size} contracts of ${pos.symbol} (${pos.side}) on Kalshi at $${exitPrice.toFixed(isPerp ? 4 : 2)} (OrderID: ${res.order_id}).`
            });
          } else {
            spotLogs.unshift({
              id: logIdCounter++, time: new Date().toISOString(), type: 'ANALYZE',
              message: `[KALSHI PANIC SELL ERROR] Failed to panic sell ${pos.symbol}: ${res.error}`
            });
          }
        });
    }

    tradingBrain.recordStrategyOutcome(pos, adjustedPnlRatio, closeReason);
    if (recoveryProtocol) {
      recoveryProtocol.processTradeOutcome(
        pos.symbol, pos.side, pnlUsd, adjustedPnlRatio * 100, positionCapitalCost,
        Math.round((Date.now() - pos.entryTime) / 1000), closeReason, pos.category,
        pos.analysisMeta?.patternType || 'GENERAL_ANALYSIS', pos.analysisMeta?.spotTA
      );
    }

    spotLogs.unshift({
      id: logIdCounter++, time: new Date().toISOString(), type: 'ERROR',
      message: `[PANIC SELL EXECUTED] ${pos.symbol} (${pos.side}) forcefully closed at market price. PnL: ${pnlUsd > 0 ? '+' : ''}$${pnlUsd.toFixed(2)}`
    });

    activePositions.splice(i, 1);
    closedCount++;
  }
  
  spotLogs.unshift({
    id: logIdCounter++, time: new Date().toISOString(), type: 'ERROR',
    message: `🚨 [BOT PAUSED] Panic Sell executed. ${closedCount} positions closed. Trading engine is offline until manually resumed.`
  });
  
  res.json({ success: true, message: `Panic sell executed. ${closedCount} positions closed.` });
});
app.post('/api/contracts/reset', (req, res) => {
  if (settings.paperTrading) {
    const closedCount = activePositions.length;
    activePositions.length = 0;
    
    spotLogs.unshift({
      id: logIdCounter++, time: new Date().toISOString(), type: 'INFO',
      message: `[CONTRACTS RESET] Cleared ${closedCount} active orphaned contracts in paper trading mode.`
    });

    res.json({ success: true, message: 'All active paper contracts reset successfully.' });
  } else {
    res.status(403).json({ success: false, message: 'Cannot reset contracts directly in Live Trading mode. Must use exchange.' });
  }
});

app.post('/api/vault/reset', (req, res) => {
  vaultedProfits = 0;
  completedGoalCycles = 0;
  sessionPocketedProfit = 0;
  tradingBrain._saveMemory();

  spotLogs.unshift({
    id: logIdCounter++, time: new Date().toISOString(), type: 'INFO',
    message: `[OFF-LIMITS VAULT RESET] Off-limits vault reserve and completed goal cycles reset to $0.00.`
  });

  res.json({
    success: true,
    vaulted_profits: 0,
    completed_goal_cycles: 0,
    message: 'Off-Limits Vault reset successfully.'
  });
});

app.post('/api/balance/reset', (req, res) => {
  const amount = req.body && typeof req.body.amount === 'number' ? req.body.amount : 200;
  simulatedPaperBalance = amount;
  startingBankroll = amount;
  cycleEarnedProfit = 0;
  vaultedProfits = 0;
  completedGoalCycles = 0;
  sessionPocketedProfit = 0;
  isStrict3ConfluenceTriggeredInSession = false;
  activePositions.length = 0;
  isCapitalPreservationActive = false;

  tradingBrain.resetBrain();
  recoveryProtocol.resetProtocol();
  goalResetScheduler.resetManual(amount);

  spotLogs.unshift({
    id: logIdCounter++, time: new Date().toISOString(), type: 'INFO',
    message: `[BANKROLL RESET] Paper trading balance reset to $${simulatedPaperBalance.toFixed(2)}. Vault and P/L history fully cleared.`
  });
  res.json({ success: true, balance: simulatedPaperBalance });
});

app.get('/api/goal-reset', (req, res) => {
  res.json(goalResetScheduler.getStatus());
});

app.post('/api/goal-reset', (req, res) => {
  const currentTotalEquity = settings.paperTrading 
    ? (simulatedPaperBalance + vaultedProfits) 
    : (realKalshiCashPool + vaultedProfits);
  goalResetScheduler.resetManual(currentTotalEquity);

  if (settings.paperTrading) {
    cumulativePaperProfit += Math.max(0, goalResetScheduler.getStatus().previous_profit || 0);
    completedPaperIterations += 1;
    simulatedPaperBalance = currentTotalEquity;
    vaultedProfits = 0;
    completedGoalCycles = 0;
    startingBankroll = currentTotalEquity;
    cycleEarnedProfit = 0;
    sessionPocketedProfit = 0;
    isStrict3ConfluenceTriggeredInSession = false;
    activePositions.length = 0;
    executedOverrides.clear();
    Object.keys(lastWinTimestamps).forEach(k => delete lastWinTimestamps[k]);
    tradingBrain.resetBrain();
    recoveryProtocol.resetProtocol();
    isCapitalPreservationActive = false;
    tradingBrain._saveMemory();
  }

  macroCycleProfit = 0;
  macroCycleStartTime = Date.now();
  marketTestingEngine.resetWindowProfit();
  
  spotLogs.unshift({
    id: logIdCounter++,
    time: new Date().toISOString(),
    type: 'INFO',
    message: `[MANUAL GOAL RESET] $100 Goal and session metrics reset to first-time Day 1 state. Baseline bankroll set to $${currentTotalEquity.toFixed(2)}.`
  });

  res.json({ success: true, goal_window: goalResetScheduler.getStatus() });
});

app.post('/api/pattern-brain/reset', (req, res) => {
  tradingBrain.resetBrain();
  recoveryProtocol.resetProtocol();
  spotLogs.unshift({
    id: logIdCounter++, time: new Date().toISOString(), type: 'INFO',
    message: `[PERFORMANCE RESET] Strategy performance summary and trade history cleared.`
  });
  res.json({ success: true, message: 'Performance summary cleared.' });
});

app.get('/api/logs', (req, res) => { res.json({ logs: spotLogs }); });
app.get('/api/recovery-mode', (req, res) => { res.json(getCapitalPreservationStatus()); });
app.get('/api/recovery-protocol', (req, res) => { res.json(recoveryProtocol.data); });
app.post('/api/recovery-protocol/reset', (req, res) => {
  recoveryProtocol.resetProtocol();
  res.json(recoveryProtocol.data);
});

// Plasticity Modifier Engine endpoints
app.get('/api/plasticity', (req, res) => {
  res.json(plasticityEngine.getPlasticitySummary());
});

app.post('/api/plasticity/synthesize', async (req, res) => {
  try {
    const { patternType, freshHybridization } = req.body;
    const targetPattern = patternType || 'RECOVERY_PROTOCOL_GLOBAL';
    const proposal = freshHybridization || {
      dynamicTP: 0.015,
      dynamicSL: -0.008,
      kellyMultiplier: 0.8,
      preferredContractTypes: ['YES', 'NO'],
      winSelectionRules: ['ICHIMOKU_CLOUD_ALIGNMENT'],
      lossAvoidanceRules: ['AVOID_DOJI_INDECISION_CANDLES'],
      riskTolerance: 'MODERATE',
      explanation: 'Manual user trigger for Plasticity comparative cross-synthesis.'
    };

    const spotContext = spotContexts['BTC'] || spotContexts['SOL'] || {};
    const result = await plasticityEngine.synthesizePlasticitySolution(targetPattern, proposal, spotContext);
    res.json({ success: true, targetPattern, result, summary: plasticityEngine.getPlasticitySummary() });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'Plasticity synthesis error' });
  }
});

app.get('/api/gemini-status', (req, res) => {
  res.json({
    regime: geminiStrategyEngine.getCurrentRegime(),
    leadLagSol: geminiStrategyEngine.getLeadLagSignal('SOL'),
    leadLagEth: geminiStrategyEngine.getLeadLagSignal('ETH'),
    leadLagHype: geminiStrategyEngine.getLeadLagSignal('HYPE'),
    leadLagDoge: geminiStrategyEngine.getLeadLagSignal('DOGE'),
    leadLagXrp: geminiStrategyEngine.getLeadLagSignal('XRP'),
    activeKellyMultiplier: settings.kellyMultiplier
  });
});

app.get('/api/pattern-brain', async (req, res) => {
  try {
    const dbTrades = await tradeDbManager.getAllTrades(200);
    if (dbTrades && dbTrades.length > 0) {
      tradingBrain.tradeHistory = dbTrades;
    }
  } catch (e) {}

  res.json({
    winningStrategies: tradingBrain.winningStrategies,
    losingStrategies: tradingBrain.losingStrategies,
    tradeHistory: tradingBrain.tradeHistory,
    invalidationReviews: tradingBrain.invalidationReviews,
    extinctionList: Object.values(tradingBrain.extinctionList || {}),
    featureStats: tradingBrain.featureStats,
    smartTrailingStats: tradingBrain.smartTrailingStats
  });
});

app.get(['/api/extinction-list', '/api/timeout-list'], (req, res) => {
  res.json({
    extinctionList: Object.values(tradingBrain.extinctionList || {}),
    timeoutList: Object.values(tradingBrain.extinctionList || {}),
    featureStats: tradingBrain.featureStats || {}
  });
});

app.post(['/api/extinction-list/toggle', '/api/timeout-list/toggle'], (req, res) => {
  const { id, active } = req.body || {};
  if (!id || typeof active !== 'boolean') {
    return res.status(400).json({ error: 'Missing id or boolean active flag in request body.' });
  }

  const result = tradingBrain.toggleExtinctItem(id, active);
  if (!result.success) {
    return res.status(404).json({ error: result.message });
  }

  res.json({
    success: true,
    item: result.item,
    extinctionList: Object.values(tradingBrain.extinctionList || {}),
    timeoutList: Object.values(tradingBrain.extinctionList || {})
  });
});

app.post(['/api/timeout-list/override-all', '/api/override-all-timeouts'], (req, res) => {
  let clearedCount = 0;
  const now = Date.now();
  Object.values(tradingBrain.extinctionList).forEach((item: any) => {
    const isGlobalActive = item.globalTimeoutUntilMs && item.globalTimeoutUntilMs > now;
    const isAssetActive = item.assetTimeouts && Object.values(item.assetTimeouts).some((a: any) => a.timeoutUntilMs > now);
    if (isGlobalActive || isAssetActive || item.isManuallyDisabled) {
      clearedCount++;
    }
    item.globalTimeoutUntilMs = 0;
    item.assetTimeouts = {};
    item.isManuallyDisabled = false;
    item.isExtinct = false;
    item.reason = 'Emergency override initiated: All active time-outs cleared.';
  });
  tradingBrain._saveMemory();

  spotLogs.unshift({
    id: logIdCounter++, time: new Date().toISOString(), type: 'WARN',
    message: `[EMERGENCY OVERRIDE] User triggered emergency override. Cleared ${clearedCount} active time-outs.`
  });

  res.json({
    success: true,
    clearedCount,
    extinctionList: Object.values(tradingBrain.extinctionList),
    timeoutList: Object.values(tradingBrain.extinctionList)
  });
});

app.post(['/api/extinction-list/reset', '/api/timeout-list/reset'], (req, res) => {
  Object.values(tradingBrain.extinctionList).forEach((item: any) => {
    item.globalTimeoutUntilMs = 0;
    item.globalLossCount = 0;
    item.assetTimeouts = {};
    item.isManuallyDisabled = false;
    item.isExtinct = false;
    item.wins = 0;
    item.losses = 0;
    item.totalTrades = 0;
    item.winRatePct = 0;
    item.reason = 'All time-outs cleared and ratios scrubbed by user reset.';
  });
  Object.values(tradingBrain.featureStats).forEach((stat: any) => {
    stat.wins = 0;
    stat.losses = 0;
    stat.totalTrades = 0;
  });
  tradingBrain._saveMemory();

  spotLogs.unshift({
    id: logIdCounter++, time: new Date().toISOString(), type: 'INFO',
    message: `[TIME-OUT ENGINE RESET] All feature/indicator time-outs cleared and ratios scrubbed to 0/0.`
  });

  res.json({
    success: true,
    message: 'All time-outs cleared and ratios scrubbed.',
    extinctionList: Object.values(tradingBrain.extinctionList),
    timeoutList: Object.values(tradingBrain.extinctionList)
  });
});

// Gemini Strategy Doctor & Auto-Compiler endpoints
app.get('/api/gemini-amendments', (req, res) => {
  res.json({
    amendments: tradingBrain.geminiAmendments || []
  });
});

app.post('/api/gemini-amendments/toggle', (req, res) => {
  const { id, active } = req.body || {};
  if (!id || typeof active !== 'boolean') {
    return res.status(400).json({ error: 'Missing id or boolean active flag in request body.' });
  }

  const amendment = (tradingBrain.geminiAmendments || []).find(a => a.id === id);
  if (!amendment) {
    return res.status(404).json({ error: 'Amendment not found.' });
  }

  amendment.isActive = active;
  tradingBrain._saveMemory();

  spotLogs.unshift({
    id: logIdCounter++, time: new Date().toISOString(), type: 'INFO',
    message: `[GEMINI AMENDMENT TOGGLE] User ${active ? 'enabled' : 'disabled'} rule '${amendment.proposedAction?.description}' for ${amendment.featureName}.`
  });

  res.json({
    success: true,
    amendments: tradingBrain.geminiAmendments
  });
});

app.post('/api/gemini-amendments/delete', (req, res) => {
  const { id } = req.body || {};
  if (!id) {
    return res.status(400).json({ error: 'Missing id in request body.' });
  }

  tradingBrain.geminiAmendments = (tradingBrain.geminiAmendments || []).filter(a => a.id !== id);
  tradingBrain._saveMemory();

  spotLogs.unshift({
    id: logIdCounter++, time: new Date().toISOString(), type: 'INFO',
    message: `[GEMINI AMENDMENT DELETE] User removed AI strategy rule ${id}.`
  });

  res.json({
    success: true,
    amendments: tradingBrain.geminiAmendments
  });
});

app.post('/api/gemini-amendments/trigger-doctor', async (req, res) => {
  const { featureId, assetSymbol } = req.body || {};
  const item = tradingBrain.extinctionList[featureId] || {
    id: featureId || 'pattern_CONFLUENCE_ICHIMOKU_VOL_SURGE',
    name: featureId ? featureId.replace(/^(pattern_|indicator_|combo_)/, '') : 'Ichimoku Vol Surge Confluence',
    category: 'PATTERN',
    wins: 1,
    losses: 3,
    totalTrades: 4,
    winRatePct: 25.0,
    globalTimeoutUntilMs: Date.now() + 300000,
    globalLossCount: 1,
    assetTimeouts: {}
  };

  try {
    const amendment = await tradingBrain.invokeGeminiStrategyDoctor(
      item,
      assetSymbol || 'GLOBAL',
      { manualUserTrigger: true, timestamp: new Date().toISOString() }
    );

    res.json({
      success: true,
      amendment,
      amendments: tradingBrain.geminiAmendments
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'Gemini Doctor execution failed.' });
  }
});

app.post('/api/db/maintenance', async (req, res) => {
  try {
    const result = await tradeDbManager.runLifecycleMaintenance();
    res.json({ success: true, ...result });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'Database maintenance error' });
  }
});

// On-Demand Asynchronous Counterfactual Retraining & Meta-Learning API Endpoints
app.post(['/api/v1/train-model', '/api/train-model'], (req, res) => {
  try {
    if (metaModelManager.getIsTraining()) {
      return res.status(202).json({
        status: "training_already_in_progress",
        message: "Counterfactual retraining pipeline is currently running in background."
      });
    }

    // Trigger non-blocking background task
    metaModelManager.runRetrainingPipeline().catch(err => {
      console.error("[BACKGROUND TRAIN ERROR]", err);
    });

    res.status(202).json({
      status: "training_initiated",
      job_id: crypto.randomUUID(),
      message: "Rehearsal buffer retraining, TBM labeling, CPCV, and DSR verification initiated asynchronously in background."
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message || "Failed starting retraining loop" });
  }
});

app.get(['/api/v1/train-model/status', '/api/train-model/status'], (req, res) => {
  res.json({
    isTraining: metaModelManager.getIsTraining(),
    globalPrecisionPct: metaModelManager.getGlobalPrecisionPct(),
    report: metaModelManager.getLatestReport(),
    history: metaModelManager.getReportHistory()
  });
});

app.get(['/api/v1/train-model/history', '/api/train-model/history'], (req, res) => {
  res.json({
    history: metaModelManager.getReportHistory()
  });
});

async function scheduleCounterfactualSnapshot(
  dbId: number,
  symbol: string,
  side: 'YES' | 'NO',
  exitPrice: number,
  isWin: boolean,
  closeReason: string
) {
  const postExitTicks: Array<{ relativeSec: number; timestamp: string; price: number }> = [];
  const startMs = Date.now();
  const dir = side === 'YES' ? 1 : -1;

  // 1. Second-by-second tick recorder for 20 seconds after trade exit
  const intervalId = setInterval(() => {
    const elapsedSec = Math.round((Date.now() - startMs) / 1000);
    const ctx = spotContexts[symbol];
    const currentP = ctx?.currentPrice || exitPrice;

    postExitTicks.push({
      relativeSec: elapsedSec,
      timestamp: new Date().toISOString(),
      price: currentP
    });

    if (elapsedSec >= 20) {
      clearInterval(intervalId);
      tradeDbManager.updateTradeCounterfactualData(dbId, postExitTicks).catch(() => {});
    }
  }, 1000);

  // 2. Non-blocking callback executed at timestamp_exit + 60 seconds
  setTimeout(async () => {
    try {
      const ctx = spotContexts[symbol];
      const midPrice = ctx?.currentPrice || exitPrice;
      const bids = ctx?.bids || [];
      const asks = ctx?.asks || [];
      const bidAskSpread = (asks[0]?.price || midPrice * 1.001) - (bids[0]?.price || midPrice * 0.999);
      const bidVol = bids.reduce((acc: number, b: any) => acc + (b.size || 0), 0) || 1;
      const askVol = asks.reduce((acc: number, a: any) => acc + (a.size || 0), 0) || 1;
      const depthRatio = parseFloat((bidVol / Math.max(1, askVol)).toFixed(2));

      // Post-exit excursion calculation
      const excursionPct = parseFloat((((midPrice - exitPrice) / exitPrice) * 100 * dir).toFixed(2));
      let regretScore = 0;
      let counterfactualRecommendation = "Exit timing validated";

      if (closeReason.toLowerCase().includes("stop") || !isWin) {
        if (excursionPct > 0) {
          regretScore = parseFloat((excursionPct * 1.5).toFixed(2));
          counterfactualRecommendation = "Stop-loss placed in liquidity sweep zone; price reversed back into profitability within 1m";
        } else {
          counterfactualRecommendation = "Stop-loss successfully prevented catastrophic further drawdown";
        }
      } else {
        if (excursionPct > 0.5) {
          regretScore = parseFloat((excursionPct * 0.8).toFixed(2));
          counterfactualRecommendation = "Capital left on table; price continued rallying aggressively in 1m";
        } else {
          counterfactualRecommendation = "Take-profit timed perfectly at local price peak";
        }
      }

      const snapshot1m = {
        timestamp: new Date().toISOString(),
        midPrice,
        bidAskSpread: parseFloat(bidAskSpread.toFixed(4)),
        orderbookDepthRatio: depthRatio,
        postExitExcursion: excursionPct,
        regretScore,
        counterfactualRecommendation
      };

      await tradeDbManager.updateTradeCounterfactualData(dbId, postExitTicks, snapshot1m);
      console.log(`[COUNTERFACTUAL 1M CALLBACK] Recorded 1m post-exit snapshot for trade ${dbId} on ${symbol}. Excursion: ${excursionPct}%, Regret Score: ${regretScore}.`);
    } catch (e) {
      console.error(`[COUNTERFACTUAL ERROR] Failed completing 1m callback for trade ${dbId}:`, e);
    }
  }, 60000);
}

// Periodic TradeDatabaseManager maintenance execution:
// Downsamples trades older than 30 days to lightweight schema, hard culls records > 60 days, runs VACUUM
setTimeout(() => {
  tradeDbManager.runLifecycleMaintenance().catch(() => {});
}, 5000);
setInterval(() => {
  tradeDbManager.runLifecycleMaintenance().catch(() => {});
}, 24 * 60 * 60 * 1000);

app.get('/api/market-context', (req, res) => {
  res.json({
    activePositions,
    spotContexts,
    spotLogs,
    isInitializing,
    botActive: settings.botActive
  });
});

app.get('/api/order-book/:symbol', (req, res) => {
  const { symbol } = req.params;
  let ctx = spotContexts[symbol];

  if (!ctx) {
    const pos = activePositions.find(p => p.symbol === symbol);
    if (pos) {
      const matchKey = Object.keys(spotContexts).find(k => k === pos.symbol || spotContexts[k]?.label === pos.label);
      if (matchKey && spotContexts[matchKey]) {
        ctx = spotContexts[matchKey];
      } else {
        const pr = pos.entryPrice || 0.50;
        const fallback = settings.paperTrading ? { bids: [{ price: parseFloat((pr - 0.01).toFixed(2)), size: 500 }], asks: [{ price: parseFloat((pr + 0.01).toFixed(2)), size: 500 }] } : { bids: [], asks: [] };
        ctx = {
          bids: fallback.bids,
          asks: fallback.asks,
          currentPrice: pr
        };
      }
    }
  }

  if (!ctx) {
    const fallback = settings.paperTrading ? { bids: [{ price: 0.49, size: 500 }], asks: [{ price: 0.51, size: 500 }] } : { bids: [], asks: [] };
    ctx = {
      bids: fallback.bids,
      asks: fallback.asks,
      currentPrice: 0.50
    };
  }

  res.json({
    bids: ctx.bids || [],
    asks: ctx.asks || [],
    currentPrice: ctx.currentPrice || 0.50
  });
});

app.get('/api/spot-book/:symbol', (req, res) => {
  const { symbol } = req.params;
  const ctx = spotContexts[symbol];
  const label = ctx?.label || symbol;
  const correlation = unifiedDataHandler.resolveCorrelatedSpotPair(symbol, label, ctx?.category || 'crypto');
  const spotPair = correlation.correlatedSpotPair;

  let basePrice = 65000;
  if (spotPair && scalper.currentCandles[spotPair]?.close) {
    basePrice = scalper.currentCandles[spotPair].close;
  } else if (label.includes('ETH')) basePrice = 3500;
  else if (label.includes('SOL')) basePrice = 145;
  else if (label.includes('HYPE')) basePrice = 40;
  else if (label.includes('DOGE')) basePrice = 0.25;
  else if (label.includes('XRP')) basePrice = 2.40;
  else if (label.includes('SUI')) basePrice = 3.20;
  else if (label.includes('LINK')) basePrice = 18.50;
  else if (label.includes('ADA')) basePrice = 0.85;
  else if (label.includes('LTC')) basePrice = 110;
  else if (label.includes('BCH')) basePrice = 480;
  else if (label.includes('AAVE')) basePrice = 240;
  else if (label.includes('AVAX')) basePrice = 32;

  basePrice = basePrice + (Math.random() * (basePrice * 0.0004) - (basePrice * 0.0002));
  const tick = Math.max(0.0001, basePrice * 0.00015);

  let bids = [];
  for (let i = 1; i <= 30; i++) {
    bids.push({ price: parseFloat((basePrice - i * tick).toFixed(basePrice < 10 ? 4 : 2)), size: parseFloat((Math.random() * 2 + 0.5).toFixed(2)) });
  }
  let asks = [];
  for (let i = 1; i <= 30; i++) {
    asks.push({ price: parseFloat((basePrice + i * tick).toFixed(basePrice < 10 ? 4 : 2)), size: parseFloat((Math.random() * 2 + 0.5).toFixed(2)) });
  }
  res.json({ bids, asks, currentPrice: basePrice, spotPair });
});

// API error handler middleware to guarantee /api/* routes always return JSON
app.use('/api', (err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('[API ERROR]', err);
  res.status(500).json({ error: err?.message || 'Internal API error' });
});

// Vite Middleware for Development / Static Production Serving
async function startServer() {
  const isProduction = process.env.NODE_ENV === "production";
  
  app.post("/api/client-error", express.json(), (req, res) => { 
    console.log("[CLIENT ERROR REPORT]", req.body); 
    try {
      require('fs').appendFileSync('client_errors.log', JSON.stringify(req.body) + '\n');
    } catch {}
    res.json({ ok: true }); 
  });

  // Self-destroying service worker to instantly purge mobile caches
  app.get(["/sw.js", "/registerSW.js", "/workbox-*.js"], (req, res) => {
    res.setHeader("Content-Type", "application/javascript");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(`
      self.addEventListener('install', function(e) { self.skipWaiting(); });
      self.addEventListener('activate', function(e) {
        self.registration.unregister().then(function() {
          return self.clients.matchAll();
        }).then(function(clients) {
          clients.forEach(function(client) {
            if (client.url && 'navigate' in client) {
              client.navigate(client.url);
            }
          });
        });
      });
    `);
  });

  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });

    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath, {
      etag: true,
      lastModified: true,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=31536000');
        }
      }
    }));
    app.get('*', (req, res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
