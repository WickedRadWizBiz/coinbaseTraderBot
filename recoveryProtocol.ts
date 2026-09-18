import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import { plasticityEngine, StrategyParameterSet } from './plasticityEngine';
import { unifiedDataHandler } from './unifiedDataHandler';

export interface HybridParams {
  dynamicTP: number;
  dynamicSL: number;
  kellyMultiplier: number;
  preferredContractTypes: string[];
  allowedCategories: string[];
  riskTolerance: 'CONSERVATIVE' | 'MODERATE' | 'AGGRESSIVE';
  winSelectionRules: string[];
  lossAvoidanceRules: string[];
  explanation: string;
  lastUpdated: string;
}

export interface RecoveryLedgerItem {
  id: number;
  timestamp: string;
  symbol: string;
  side: 'YES' | 'NO';
  pnlUsd: number;
  pnlPct: number;
  wasWin: boolean;
  cashVolume: number;
  timeInContractSeconds: number;
  closeReason: string;
  category: string;
  patternType: string;
  spotTA: any;
  askingReasoning: string;
  sameAssetWinLossDiff: string;
  hybridParamsAtTime: HybridParams;
}

export interface RecoveryProtocolData {
  consecutiveWins: number;
  consecutiveLosses: number;
  inquiryActive: boolean;
  status: 'INQUIRY_ACTIVE' | 'NORMAL_OPERATIONS' | 'STABILIZED_3_WINS' | 'RE_EVALUATING_3_LOSSES';
  statusMessage: string;
  hybridParams: HybridParams;
  ledger: RecoveryLedgerItem[];
}

export class CapitalPreservationProtocol {
  private memoryFile: string;
  public data: RecoveryProtocolData;
  private idCounter = 1;
  private rateLimitCooldownUntil = 0;

  constructor(memoryFile = 'recovery_protocol.json') {
    this.memoryFile = path.join(process.cwd(), memoryFile);
    this.data = {
      consecutiveWins: 0,
      consecutiveLosses: 0,
      inquiryActive: true,
      status: 'INQUIRY_ACTIVE',
      statusMessage: 'RECOVERY PROTOCOL READY (Down 25% Threshold): Ultra-tight stop loss & aggressive fast profit taking.',
      hybridParams: {
        dynamicTP: 0.010,
        dynamicSL: -0.005,
        kellyMultiplier: 0.5,
        preferredContractTypes: ['YES', 'NO'],
        allowedCategories: ['crypto', 'sports', 'orderbook', 'expiration_safety'],
        riskTolerance: 'CONSERVATIVE',
        winSelectionRules: ['REQUIRE_MULTI_TOOL_CONFLUENCE', 'ICHIMOKU_CLOUD_ALIGNMENT', 'RSI_REVERSION_ZONE', 'ORDERBOOK_BID_ASK_DOMINANCE'],
        lossAvoidanceRules: ['AVOID_SINGLE_INDICATOR_TRADES', 'AVOID_DOJI_INDECISION_CANDLES', 'AVOID_COUNTER_CLOUD_ENTRIES'],
        explanation: 'Capital preservation mode: tightest feasible stop loss (-0.5%) & aggressive quick profit taking.',
        lastUpdated: new Date().toISOString()
      },
      ledger: []
    };
    this._loadMemory();
  }

  private _loadMemory() {
    try {
      if (fs.existsSync(this.memoryFile)) {
        const raw = fs.readFileSync(this.memoryFile, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.hybridParams) {
          this.data = parsed;
          if (this.data.ledger && this.data.ledger.length > 0) {
            this.idCounter = Math.max(...this.data.ledger.map(i => i.id || 0)) + 1;
          }
        }
      }
      if (this.data.hybridParams) {
        const sl = Math.min(-0.005, Math.max(-0.015, Number(this.data.hybridParams.dynamicSL) || -0.005));
        const slMag = Math.abs(sl);
        let tp = Number(this.data.hybridParams.dynamicTP) || (slMag + 0.003);
        if (tp < slMag + 0.003) {
          tp = slMag + 0.003;
        }
        this.data.hybridParams.dynamicSL = sl;
        this.data.hybridParams.dynamicTP = Number(tp.toFixed(3));
      }
    } catch (e) {
      console.error('[RECOVERY PROTOCOL] Memory load failed:', e);
    }
  }

  private _saveMemory() {
    try {
      const temp = `${this.memoryFile}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), 'utf-8');
      fs.renameSync(temp, this.memoryFile);
    } catch (e) {
      console.error('[RECOVERY PROTOCOL] Memory save failed:', e);
    }
  }

  public resetProtocol() {
    this.data.consecutiveWins = 0;
    this.data.consecutiveLosses = 0;
    this.data.inquiryActive = true;
    this.data.status = 'INQUIRY_ACTIVE';
    this.data.statusMessage = 'RECOVERY PROTOCOL RESET: Tight stop loss & aggressive fast profit active when down $50 or after 3 consecutive losses.';
    this.data.hybridParams = {
      dynamicTP: 0.010,
      dynamicSL: -0.005,
      kellyMultiplier: 0.5,
      preferredContractTypes: ['YES', 'NO'],
      allowedCategories: ['crypto', 'sports', 'orderbook', 'expiration_safety'],
      riskTolerance: 'CONSERVATIVE',
      winSelectionRules: ['ICHIMOKU_CLOUD_ALIGNMENT', 'RSI_REVERSION_ZONE', 'ORDERBOOK_BID_ASK_DOMINANCE'],
      lossAvoidanceRules: ['AVOID_DOJI_INDECISION_CANDLES', 'AVOID_COUNTER_CLOUD_ENTRIES'],
      explanation: 'Protocol reset to tight baseline parameters.',
      lastUpdated: new Date().toISOString()
    };
    this.data.ledger = [];
    this._saveMemory();
  }

  public getProtocolStatus() {
    return {
      consecutiveWins: this.data.consecutiveWins,
      consecutiveLosses: this.data.consecutiveLosses,
      inquiryActive: this.data.inquiryActive,
      status: this.data.status,
      statusMessage: this.data.statusMessage,
      hybridParams: this.data.hybridParams,
      recentInquiries: this.data.ledger.slice(0, 10)
    };
  }

  public async processTradeOutcome(
    symbol: string,
    side: 'YES' | 'NO',
    pnlUsd: number,
    pnlPct: number,
    cashVolume: number,
    timeInContractSeconds: number,
    closeReason: string,
    category: string,
    patternType: string,
    spotTA: any
  ) {
    const isWin = pnlUsd > 0;

    // Unified Data Handler: Perform validation check that data being learned is derived exclusively from correlated spot pair
    const spotValidation = unifiedDataHandler.validateTradeSpotCorrelation(symbol, category, spotTA);
    if (!spotValidation.isValid) {
      console.warn(`[UNIFIED DATA HANDLER] Training Loop Spot Correlation Check: ${spotValidation.reason}`);
    }
    const validatedSpotTA = spotValidation.isValid ? spotTA : { pair: spotValidation.correlatedSpotPair, unmappedNote: spotValidation.reason };

    // Update Hebbian Synaptic Plasticity Matrix (LTP on Win, LTD on Loss, top earner 1.5x boost)
    plasticityEngine.updateAdaptiveWeightMatrix(
      symbol,
      side,
      pnlUsd,
      isWin,
      category,
      patternType,
      validatedSpotTA,
      this.data.hybridParams?.winSelectionRules || []
    );

    if (isWin) {
      this.data.consecutiveWins += 1;
      this.data.consecutiveLosses = 0;
    } else {
      this.data.consecutiveLosses += 1;
      this.data.consecutiveWins = 0;
    }

    if (this.data.consecutiveWins >= 3) {
      this.data.inquiryActive = false;
      this.data.status = 'STABILIZED_3_WINS';
      this.data.statusMessage = '3 CONSECUTIVE WINS ACHIEVED! Strategy stabilized & winning momentum validated.';
    } else if (this.data.consecutiveLosses >= 3) {
      this.data.inquiryActive = true;
      this.data.status = 'RE_EVALUATING_3_LOSSES';
      this.data.statusMessage = '3 CONSECUTIVE LOSSES DETECTED! Overhauling strategy logic: flipping contract preference, tightening stop loss to -0.5% & updating spot TA avoidance.';
      
      // Automatic 3-loss streak strategy logic overhaul
      this.data.hybridParams.preferredContractTypes = ['YES', 'NO'];
      this.data.hybridParams.dynamicSL = -0.005; // Tightest feasible stop loss (-0.5%)
      this.data.hybridParams.dynamicTP = 0.008; // Ultra aggressive quick profit (+0.8%)
      this.data.hybridParams.kellyMultiplier = 0.3; // Scale down risk size
      if (!this.data.hybridParams.lossAvoidanceRules.includes('AVOID_3_LOSS_PATTERNS')) {
        this.data.hybridParams.lossAvoidanceRules.push('AVOID_3_LOSS_PATTERNS');
      }
    } else {
      this.data.inquiryActive = true;
      this.data.status = 'INQUIRY_ACTIVE';
      this.data.statusMessage = `INQUIRY ACTIVE (Streak: ${this.data.consecutiveWins}W / ${this.data.consecutiveLosses}L towards 3-win target or 3-loss pivot). Continuously hybridizing logic...`;
    }

    let askingReasoning = '';
    let sameAssetWinLossDiff = '';
    let hybridizationDeltas = '';

    if (this.data.inquiryActive) {
      const apiKey = process.env.GEMINI_API_KEY;
      if (apiKey && Date.now() > this.rateLimitCooldownUntil) {
        try {
          const aiResponse = await this._queryGeminiForHybridization(
            symbol, side, pnlUsd, pnlPct, cashVolume, timeInContractSeconds,
            closeReason, category, patternType, validatedSpotTA, isWin, apiKey
          );

          if (aiResponse) {
            askingReasoning = aiResponse.askingReasoning || '';
            sameAssetWinLossDiff = aiResponse.sameAssetWinLossDiff || '';

            if (aiResponse.hybridParams) {
              const oldParams = this.data.hybridParams;
              const prefContracts = Array.isArray(aiResponse.hybridParams.preferredContractTypes) 
                ? aiResponse.hybridParams.preferredContractTypes.filter((c: string) => c === 'YES' || c === 'NO')
                : oldParams.preferredContractTypes;

              const winRules = Array.isArray(aiResponse.hybridParams.winSelectionRules) && aiResponse.hybridParams.winSelectionRules.length > 0
                ? aiResponse.hybridParams.winSelectionRules
                : oldParams.winSelectionRules;

              const lossRules = Array.isArray(aiResponse.hybridParams.lossAvoidanceRules) && aiResponse.hybridParams.lossAvoidanceRules.length > 0
                ? aiResponse.hybridParams.lossAvoidanceRules
                : oldParams.lossAvoidanceRules;

              const nextSL = Math.min(-0.005, Math.max(-0.03, Number(aiResponse.hybridParams.dynamicSL) || oldParams.dynamicSL));
              const slMag = Math.abs(nextSL);
              const nextTP = Math.max(slMag + 0.005, Math.min(0.20, Number(aiResponse.hybridParams.dynamicTP) || oldParams.dynamicTP));

              const freshProposal: StrategyParameterSet = {
                dynamicTP: Number(nextTP.toFixed(3)),
                dynamicSL: Number(nextSL.toFixed(3)),
                kellyMultiplier: Math.max(0.2, Math.min(2.0, Number(aiResponse.hybridParams.kellyMultiplier) || oldParams.kellyMultiplier)),
                preferredContractTypes: prefContracts.length > 0 ? prefContracts : oldParams.preferredContractTypes,
                winSelectionRules: winRules,
                lossAvoidanceRules: lossRules,
                riskTolerance: aiResponse.hybridParams.riskTolerance || oldParams.riskTolerance,
                explanation: aiResponse.hybridParams.explanation || oldParams.explanation
              };

              // Record trade yield in Plasticity Engine memory
              plasticityEngine.evaluateAndRecordTradeYield(
                patternType || 'RECOVERY_PROTOCOL_GLOBAL',
                pnlPct,
                this.data.consecutiveWins > 0 ? 80 : 40,
                this.data.ledger.length + 1,
                freshProposal
              );

              // Plasticity Comparative Synthesis against All-Time Best historical strategy parameters
              const plasticityResult = await plasticityEngine.synthesizePlasticitySolution(
                patternType || 'RECOVERY_PROTOCOL_GLOBAL',
                freshProposal,
                spotTA
              );

              const synth = plasticityResult.synthesizedSolution;
              this.data.hybridParams = {
                dynamicTP: synth.dynamicTP,
                dynamicSL: synth.dynamicSL,
                kellyMultiplier: synth.kellyMultiplier,
                preferredContractTypes: synth.preferredContractTypes,
                allowedCategories: oldParams.allowedCategories,
                riskTolerance: synth.riskTolerance,
                winSelectionRules: synth.winSelectionRules,
                lossAvoidanceRules: synth.lossAvoidanceRules,
                explanation: `[PLASTICITY SCORE ${plasticityResult.plasticityScore}/100]: ${synth.explanation || plasticityResult.comparisonReasoning}`,
                lastUpdated: new Date().toISOString()
              };

              hybridizationDeltas = `[PLASTICITY SYNTHESIS ${plasticityResult.plasticityScore}/100] TP: ${(this.data.hybridParams.dynamicTP * 100).toFixed(1)}%, SL: ${(this.data.hybridParams.dynamicSL * 100).toFixed(1)}%, Contracts: [${this.data.hybridParams.preferredContractTypes.join(', ')}], Kelly: ${this.data.hybridParams.kellyMultiplier}x`;
            }
          }
        } catch (err: any) {
          if (err?.status === 429 || String(err?.message || '').includes('429') || String(err?.message || '').includes('Quota exceeded')) {
            this.rateLimitCooldownUntil = Date.now() + 60000;
            console.log('[RECOVERY PROTOCOL] Rate limit reached (429). Falling back gracefully to algorithmic hybridization for 60s.');
          } else {
            console.warn('[RECOVERY PROTOCOL] AI hybridization query note:', err?.message || err);
          }
        }
      }

      if (!askingReasoning) {
        if (isWin) {
          askingReasoning = `Strategy RECOVERING money on ${category} (${patternType}) trading ${side} contracts ($${cashVolume}, ${timeInContractSeconds}s in contract). Exit hit ${closeReason}. Parameter & Spot TA alignment validated.`;
          if (this.data.consecutiveWins >= 2) {
            this.data.hybridParams.kellyMultiplier = Math.min(1.5, Number((this.data.hybridParams.kellyMultiplier * 1.1).toFixed(2)));
          }
          if (spotTA?.ichimokuState === 'BULLISH_CLOUD' && !this.data.hybridParams.winSelectionRules.includes('ICHIMOKU_BULLISH_CLOUD')) {
            this.data.hybridParams.winSelectionRules.push('ICHIMOKU_BULLISH_CLOUD');
          }
          this.data.hybridParams.explanation = `Validated ${side} contract edge on ${patternType} with spot TA cloud alignment. Maintaining win momentum towards 3-win target.`;
        } else {
          askingReasoning = `Strategy LOSING money on ${category} (${patternType}) trading ${side} contracts ($${cashVolume}, ${timeInContractSeconds}s in contract). Exit hit ${closeReason}. Entry price or directional bias diverged from spot chart TA.`;
          
          this.data.hybridParams.preferredContractTypes = ['YES', 'NO'];

          if (spotTA?.isDoji && !this.data.hybridParams.lossAvoidanceRules.includes('AVOID_DOJI_INDECISION_CANDLES')) {
            this.data.hybridParams.lossAvoidanceRules.push('AVOID_DOJI_INDECISION_CANDLES');
          }

          this.data.hybridParams.dynamicSL = Number(Math.max(-0.03, Math.min(-0.005, this.data.hybridParams.dynamicSL * 0.85)).toFixed(3));
          const slMag = Math.abs(this.data.hybridParams.dynamicSL);
          if (this.data.hybridParams.dynamicTP < slMag + 0.005) {
            this.data.hybridParams.dynamicTP = Number((slMag + 0.005).toFixed(3));
          }
          this.data.hybridParams.kellyMultiplier = Number(Math.max(0.3, this.data.hybridParams.kellyMultiplier * 0.85).toFixed(2));
          this.data.hybridParams.explanation = `Adjusted stop-loss, contract side preference, and spot TA avoidance rules following ${this.data.consecutiveLosses} consecutive losses.`;
        }
        hybridizationDeltas = `TP: ${(this.data.hybridParams.dynamicTP * 100).toFixed(1)}%, SL: ${(this.data.hybridParams.dynamicSL * 100).toFixed(1)}%, Contracts: [${this.data.hybridParams.preferredContractTypes.join(', ')}]`;
      }
    }

    const ledgerItem: RecoveryLedgerItem = {
      id: this.idCounter++,
      timestamp: new Date().toISOString(),
      symbol,
      side,
      pnlUsd,
      pnlPct,
      wasWin: isWin,
      cashVolume,
      timeInContractSeconds,
      closeReason,
      category,
      patternType,
      spotTA,
      askingReasoning,
      sameAssetWinLossDiff,
      hybridParamsAtTime: { ...this.data.hybridParams }
    };

    this.data.ledger.unshift(ledgerItem);
    if (this.data.ledger.length > 50) this.data.ledger.pop();

    this._saveMemory();
    return { askingReasoning, sameAssetWinLossDiff, hybridizationDeltas, currentParams: this.data.hybridParams };
  }

  private async _queryGeminiForHybridization(
    symbol: string,
    side: 'YES' | 'NO',
    pnlUsd: number,
    pnlPct: number,
    cashVolume: number,
    timeInContractSeconds: number,
    closeReason: string,
    category: string,
    patternType: string,
    spotTA: any,
    isWin: boolean,
    apiKey: string
  ): Promise<any> {
    const aiClient = new GoogleGenAI({ apiKey });

    const previousSameAssetTrades = this.data.ledger.filter(item => item.symbol === symbol || item.category === category);
    const prevWins = previousSameAssetTrades.filter(item => item.wasWin);
    const prevLosses = previousSameAssetTrades.filter(item => !item.wasWin);

    const prompt = `
You are the Lead Recovery & Strategy Hybridization AI.
A trade has just closed under capital preservation mode. Analyze why this trade resulted in a ${isWin ? 'WIN' : 'LOSS'} and update our strategy parameters.

Trade Details:
- Asset/Symbol: ${symbol} (${category})
- Contract Type: ${side}
- Outcome: ${isWin ? 'WIN' : 'LOSS'} (PnL: $${pnlUsd.toFixed(2)}, ${pnlPct.toFixed(2)}%)
- Cash Used (Volume): $${cashVolume.toFixed(2)}
- Time In Contract: ${timeInContractSeconds} seconds
- Exit Trigger: ${closeReason}
- Pattern/Analysis Type: ${patternType}

Corresponding Spot Chart Technical Analysis:
- Spot Pair: ${spotTA?.pair || 'N/A'}
- Spot Price: $${spotTA?.price || 'N/A'}
- Ichimoku Cloud State: ${spotTA?.ichimokuState || 'NEUTRAL'} (Tenkan/Kijun Cross: ${spotTA?.tenkanKijunCross || 'NONE'})
- Doji Candlestick Pattern: ${spotTA?.isDoji ? spotTA.dojiType : 'NO_DOJI'}
- RSI (14-period, 1m): ${spotTA?.rsi ? spotTA.rsi.toFixed(1) : 'N/A'}
- Volume Surge Ratio: ${spotTA?.volumeSurgeRatio ? spotTA.volumeSurgeRatio.toFixed(2) + 'x' : '1.0x'}

Historical Comparison for ${symbol} / ${category}:
- Previous Wins Count: ${prevWins.length}
- Previous Losses Count: ${prevLosses.length}

Inquiry Requirements:
1. Explain specifically WHY the strategy is recovering or losing money on this trade, explicitly correlating contract performance with spot chart TA (Ichimoku Cloud, Doji, RSI, Volume Surge) and execution parameters ($ volume, duration).
2. Compare this trade against previous trades of the same type/crypto. Detail the difference in spot TA patterns, volume, or entry timing between wins and losses.
3. Recommend hybridization adjustments:
   - Select common parameters/TA setups that lead to wins.
   - Avoid parameters/TA setups that lead to losses.
   - Set preferred contract types (['YES'], ['NO'], or ['YES', 'NO']).
   - Adjust dynamicTP (take profit ratio) and dynamicSL (stop loss ratio):
     * Stop loss MUST be as tight as feasible (between -0.5% / -0.005 and -1.0% / -0.010).
     * Take profit MUST favor aggressively selling for any profit as quickly as possible (between +0.8% / 0.008 and +1.5% / 0.015).
     * Constantly refine rules when observing 3 wins in a row or 3 losses in a row.

Return JSON strictly matching this schema:
{
  "isRecovering": boolean,
  "askingReasoning": "Detailed 2-3 sentence explanation of why the strategy is recovering or losing money on this trade, explicitly referencing spot chart Ichimoku Cloud / Doji / RSI metrics and cash/duration parameters.",
  "sameAssetWinLossDiff": "Summary of the critical differences (spot TA, volume, duration, entry price) between this trade and previous trades on the same asset that led to a win or loss.",
  "hybridParams": {
    "dynamicTP": number (e.g. 0.010 for 1.0%),
    "dynamicSL": number (e.g. -0.005 for -0.5%),
    "kellyMultiplier": number (e.g. 0.8),
    "preferredContractTypes": ["YES"] or ["NO"] or ["YES", "NO"],
    "riskTolerance": "CONSERVATIVE" | "MODERATE" | "AGGRESSIVE",
    "winSelectionRules": ["List of parameters & spot TA setups to SELECT for future trades"],
    "lossAvoidanceRules": ["List of parameters & spot TA setups to AVOID for future trades"],
    "explanation": "Brief description of the strategy hybridization adjustments made."
  }
}
`;

    const candidateModels = ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash'];
    let lastError: any = null;

    for (const model of candidateModels) {
      try {
        const response = await aiClient.models.generateContent({
          model,
          contents: prompt,
          config: { responseMimeType: 'application/json' }
        });

        if (response && response.text) {
          return JSON.parse(response.text);
        }
      } catch (err: any) {
        lastError = err;
        const errMsg = String(err?.message || '');
        if (err?.status === 429 || errMsg.includes('429') || errMsg.includes('Quota exceeded') || errMsg.includes('503') || errMsg.toLowerCase().includes('unavailable') || errMsg.toLowerCase().includes('high demand')) {
          console.warn(`[RECOVERY PROTOCOL] Model ${model} rate-limited or unavailable, attempting fallback...`);
          continue;
        }
        throw err;
      }
    }

    if (lastError) throw lastError;
    return null;
  }
}
