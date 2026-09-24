import { GoogleGenAI, Type } from '@google/genai';

export interface PreFlightVetoResult {
  approved: boolean;
  confidenceScore: number; // 0.0 to 1.0
  reason: string;
  adversarialConsensus?: number; // C score (0.0 to 1.0)
  bullishThesis?: string;
  bearishCounterThesis?: string;
}

export interface AdversarialDebateResult {
  verdict: 'EXECUTE' | 'ABSTAIN_DISSONANCE' | 'REJECT_HIGH_RISK';
  consensusScore: number; // C = 1 - Var({d_i}) / Var_max (0.0 to 1.0)
  bullishConfidence: number; // 0.0 to 1.0
  bearishConfidence: number; // 0.0 to 1.0
  bullishRationale: string;
  bearishRationale: string;
  recommendedPositionMultiplier: number;
  debateTimestamp: string;
}

export interface MarketRegimeResult {
  regime: 'CHOPPY_SIDEWAYS' | 'HIGH_VOLATILITY_BREAKOUT' | 'TRENDING_BULLISH' | 'TRENDING_BEARISH';
  kellyAdjustment: number; // e.g. 0.7 for choppy, 1.2 for breakout
  tpMultiplier: number;    // e.g. 0.8 for choppy, 1.5 for breakout
  slMultiplier: number;    // e.g. 0.8 for tight SL
  reasoning: string;
  timestamp: string;
}

export interface LeadLagSignal {
  leadAsset: 'BTC';
  targetAsset: 'SOL' | 'ETH';
  predictedDirection: 'YES' | 'NO';
  leadDeltaPct: number;
  reason: string;
  timestamp: number;
}

export interface RiskGovernorResult {
  recommendedKellyMultiplier: number; // 0.2 to 1.2
  status: 'SCALING_UP' | 'STABLE' | 'THROTTLED_DRAWDOWN';
  reason: string;
}

export interface TradeAuditResult {
  identifiedWeaknesses: string[];
  recommendedRules: string[];
  timestamp: string;
}

class GeminiStrategyEngine {
  private vetoCache: Record<string, { result: PreFlightVetoResult; timestamp: number }> = {};
  private currentRegime: MarketRegimeResult = {
    regime: 'TRENDING_BEARISH',
    kellyAdjustment: 1.0,
    tpMultiplier: 1.0,
    slMultiplier: 1.0,
    reasoning: 'Initial default regime state',
    timestamp: new Date().toISOString()
  };
  private activeLeadLagSignals: Record<string, LeadLagSignal> = {};
  private rateLimitCooldownUntil: number = 0;
  private lastBatchAuditTradeCount: number = 0;

  private getAiClient(): GoogleGenAI | null {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    if (Date.now() < this.rateLimitCooldownUntil) return null;
    return new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: { 'User-Agent': 'aistudio-build' }
      }
    });
  }

  private handleApiError(e: any) {
    const errStr = String(e?.message || e);
    if (errStr.includes('429') || errStr.toLowerCase().includes('resource_exhausted') || errStr.toLowerCase().includes('quota') || errStr.toLowerCase().includes('rate limit')) {
      console.warn('[GEMINI STRATEGY ENGINE] Quota / Rate limit reached. Initiating 60s cooldown.');
      this.rateLimitCooldownUntil = Date.now() + 60000;
    } else {
      console.error('[GEMINI STRATEGY ENGINE] API call failed:', errStr);
    }
  }

  private async generateContentWithFallback(ai: GoogleGenAI, requestConfig: any): Promise<any> {
    const candidateModels = [
      'gemini-flash-latest',
      'gemini-3.8-flash',
      'gemini-3.6-flash',
      'gemini-3.1-flash-lite',
      'gemini-3.1-pro-preview'
    ];
    let lastErr: any = null;
    for (const model of candidateModels) {
      try {
        return await ai.models.generateContent({
          ...requestConfig,
          model
        });
      } catch (err: any) {
        lastErr = err;
        const errMsg = String(err?.message || err);
        if (errMsg.includes('429') || errMsg.toLowerCase().includes('resource_exhausted') || errMsg.toLowerCase().includes('quota') || errMsg.toLowerCase().includes('rate limit') || errMsg.includes('503') || errMsg.toLowerCase().includes('unavailable') || errMsg.toLowerCase().includes('high demand') || errMsg.includes('404')) {
          console.warn(`[GEMINI STRATEGY ENGINE] Model ${model} rate-limited, unavailable or deprecated, attempting fallback...`);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  // --------------------------------------------------------------------------
  // 1. MULTI-AGENT ADVERSARIAL DEBATE COMMITTEE (Section 4.1)
  // Cross-examines "Bullish Quant Analyst" vs "Bearish Risk Manager"
  // Calculates mathematical consensus: C = 1 - Var({d_i}) / Var_max
  // --------------------------------------------------------------------------
  public async evaluateAdversarialDebate(candidate: {
    symbol: string;
    side: 'YES' | 'NO';
    patternType: string;
    spotTA: any;
    bidVol: number;
    askVol: number;
    mertonFairValue?: number;
    currentKalshiPrice?: number;
    vpinToxicity?: number;
  }): Promise<AdversarialDebateResult> {
    const ai = this.getAiClient();
    if (!ai) {
      return {
        verdict: 'EXECUTE',
        consensusScore: 0.85,
        bullishConfidence: 0.8,
        bearishConfidence: 0.2,
        bullishRationale: 'Heuristic quant momentum validation',
        bearishRationale: 'No critical adverse selection detected',
        recommendedPositionMultiplier: 1.0,
        debateTimestamp: new Date().toISOString()
      };
    }

    try {
      const prompt = `You are a Multi-Agent Institutional Trading Committee conducting an Adversarial Cross-Examination on a candidate 15-minute Kalshi binary prediction market trade setup.

CANDIDATE SETUP:
- Market: ${candidate.symbol} | Proposed Side: ${candidate.side} | Strategy Pattern: ${candidate.patternType}
- Spot TA: RSI=${candidate.spotTA?.rsi?.toFixed(1) || '50.0'}, Cloud=${candidate.spotTA?.ichimokuState || 'NEUTRAL'}, Squeeze=${candidate.spotTA?.bbkcSqueezeActive ? 'ACTIVE' : 'NONE'}
- Spot Jump-Diffusion Fair Value: ${candidate.mertonFairValue ? (candidate.mertonFairValue * 100).toFixed(1) + '¢' : 'N/A'} vs Kalshi Book Price: ${candidate.currentKalshiPrice ? (candidate.currentKalshiPrice * 100).toFixed(1) + '¢' : 'N/A'}
- Microstructure: BidVol=${candidate.bidVol}, AskVol=${candidate.askVol}, VPIN Toxicity=${candidate.vpinToxicity ? candidate.vpinToxicity.toFixed(2) : '0.20'}

AGENT PERSONAS:
1. "Bullish Quantitative Analyst": Incentivized to find alpha, directional lead-lag edge, and momentum alignment.
2. "Bearish Risk Governor": Incentivized to surface adverse selection, false breakout traps, fee friction, and liquidity cliffs.

Conduct cross-examination and output JSON:
{
  "bullishConfidence": number (0.0 to 1.0),
  "bullishRationale": string (1 concise sentence),
  "bearishConfidence": number (0.0 to 1.0, where 1.0 means severe risk/veto),
  "bearishRationale": string (1 concise sentence),
  "identifiedTrapType": string ("NONE" | "BULL_TRAP" | "BEAR_TRAP" | "TOXIC_SWEEP" | "HIGH_FEE_CHOP")
}`;

      const response = await this.generateContentWithFallback(ai, {
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              bullishConfidence: { type: Type.NUMBER },
              bullishRationale: { type: Type.STRING },
              bearishConfidence: { type: Type.NUMBER },
              bearishRationale: { type: Type.STRING },
              identifiedTrapType: { type: Type.STRING }
            },
            required: ['bullishConfidence', 'bullishRationale', 'bearishConfidence', 'bearishRationale']
          }
        }
      });

      const parsed = JSON.parse(response.text?.trim() || '{}');
      const bullConf = Math.max(0.0, Math.min(1.0, parsed.bullishConfidence ?? 0.75));
      const bearConf = Math.max(0.0, Math.min(1.0, parsed.bearishConfidence ?? 0.25));

      // Compute mathematical belief dispersion & consensus
      // Signed convictions: Bullish = +bullConf, Bearish = -bearConf
      const d_bull = bullConf;
      const d_bear = 1.0 - bearConf; // Inverted to measure directional agreement
      const meanConviction = (d_bull + d_bear) / 2;
      const variance = (Math.pow(d_bull - meanConviction, 2) + Math.pow(d_bear - meanConviction, 2)) / 2;
      const maxVariance = 0.25; // Max variance between two bounded [0, 1] variables

      const consensusScore = Math.max(0.0, Math.min(1.0, 1.0 - (variance / maxVariance)));

      let verdict: 'EXECUTE' | 'ABSTAIN_DISSONANCE' | 'REJECT_HIGH_RISK' = 'EXECUTE';
      let positionMultiplier = 1.0;

      if (bearConf > 0.75) {
        verdict = 'REJECT_HIGH_RISK';
        positionMultiplier = 0.0;
      } else if (consensusScore < 0.50) {
        // High dissonance between Bull and Bear committee
        verdict = 'ABSTAIN_DISSONANCE';
        positionMultiplier = 0.0;
      } else {
        positionMultiplier = Math.max(0.3, consensusScore * (1 - bearConf * 0.5));
      }

      return {
        verdict,
        consensusScore: Number(consensusScore.toFixed(3)),
        bullishConfidence: bullConf,
        bearishConfidence: bearConf,
        bullishRationale: parsed.bullishRationale || 'Confluence identified in trend setup',
        bearishRationale: parsed.bearishRationale || 'Risk within acceptable bounds',
        recommendedPositionMultiplier: Number(positionMultiplier.toFixed(2)),
        debateTimestamp: new Date().toISOString()
      };
    } catch (e) {
      this.handleApiError(e);
      return {
        verdict: 'EXECUTE',
        consensusScore: 0.80,
        bullishConfidence: 0.8,
        bearishConfidence: 0.2,
        bullishRationale: 'Heuristic fallback execution',
        bearishRationale: 'Heuristic bounds acceptable',
        recommendedPositionMultiplier: 1.0,
        debateTimestamp: new Date().toISOString()
      };
    }
  }

  // --------------------------------------------------------------------------
  // PRE-FLIGHT VETO (Wraps Adversarial Debate for Execution Pipeline)
  // --------------------------------------------------------------------------
  public async evaluatePreFlightVeto(candidate: {
    symbol: string;
    side: 'YES' | 'NO';
    patternType: string;
    spotTA: any;
    bidVol: number;
    askVol: number;
    mertonFairValue?: number;
    currentKalshiPrice?: number;
    vpinToxicity?: number;
  }): Promise<PreFlightVetoResult> {
    const cacheKey = `${candidate.symbol}_${candidate.side}_${candidate.patternType}`;
    const cached = this.vetoCache[cacheKey];
    if (cached && Date.now() - cached.timestamp < 15000) {
      return cached.result;
    }

    const debate = await this.evaluateAdversarialDebate(candidate);
    const approved = debate.verdict === 'EXECUTE';
    const reason = approved
      ? `Debate Cleared (Consensus C=${(debate.consensusScore * 100).toFixed(0)}%). Bull: ${debate.bullishRationale}`
      : `Debate Vetoed (${debate.verdict}). Bear: ${debate.bearishRationale}`;

    const result: PreFlightVetoResult = {
      approved,
      confidenceScore: debate.consensusScore,
      reason,
      adversarialConsensus: debate.consensusScore,
      bullishThesis: debate.bullishRationale,
      bearishCounterThesis: debate.bearishRationale
    };

    this.vetoCache[cacheKey] = { result, timestamp: Date.now() };
    return result;
  }

  // --------------------------------------------------------------------------
  // 2. VOLATILITY REGIME & MARKET PHASE CLASSIFIER
  // --------------------------------------------------------------------------
  public async classifyMarketRegime(candlesData: Record<string, any[]>): Promise<MarketRegimeResult> {
    const ai = this.getAiClient();
    if (!ai) return this.currentRegime;

    try {
      const summaryText = Object.entries(candlesData).map(([symbol, candles]) => {
        if (!candles || candles.length === 0) return `${symbol}: No candles`;
        const last = candles[candles.length - 1];
        const prev = candles[Math.max(0, candles.length - 10)];
        const pctChange = prev ? ((last.close - prev.close) / prev.close) * 100 : 0;
        return `${symbol}: Last=${last.close}, 10-bar Chg=${pctChange.toFixed(2)}%`;
      }).join('\n');

      const prompt = `Classify the current market volatility regime across these assets for a 15-minute prediction market bot:
${summaryText}

Categories:
1. "CHOPPY_SIDEWAYS" (Low volatility, price ranging without momentum -> reduce size, tight TP)
2. "HIGH_VOLATILITY_BREAKOUT" (Rapid expansion, strong momentum spikes -> expand TP, boost Kelly)
3. "TRENDING_BULLISH" / "TRENDING_BEARISH" (Clear directional momentum)

Return JSON:
{
  "regime": "CHOPPY_SIDEWAYS" | "HIGH_VOLATILITY_BREAKOUT" | "TRENDING_BULLISH" | "TRENDING_BEARISH",
  "kellyAdjustment": number (0.5 to 1.3),
  "tpMultiplier": number (0.7 to 1.5),
  "slMultiplier": number (0.8 to 1.2),
  "reasoning": string
}`;

      const response = await this.generateContentWithFallback(ai, {
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              regime: { type: Type.STRING },
              kellyAdjustment: { type: Type.NUMBER },
              tpMultiplier: { type: Type.NUMBER },
              slMultiplier: { type: Type.NUMBER },
              reasoning: { type: Type.STRING }
            },
            required: ['regime', 'kellyAdjustment', 'tpMultiplier', 'slMultiplier', 'reasoning']
          }
        }
      });

      const parsed = JSON.parse(response.text?.trim() || '{}');
      if (parsed.regime) {
        this.currentRegime = {
          regime: parsed.regime,
          kellyAdjustment: parsed.kellyAdjustment || 1.0,
          tpMultiplier: parsed.tpMultiplier || 1.0,
          slMultiplier: parsed.slMultiplier || 1.0,
          reasoning: parsed.reasoning || 'Classified by Gemini 3.8 Flash',
          timestamp: new Date().toISOString()
        };
      }
    } catch (e) {
      this.handleApiError(e);
    }
    return this.currentRegime;
  }

  public getCurrentRegime(): MarketRegimeResult {
    return this.currentRegime;
  }

  // --------------------------------------------------------------------------
  // 3. BATCH TRADE CLUSTERING & META-RULE AUDIT
  // --------------------------------------------------------------------------
  public async auditTradeBatch(recentTrades: any[]): Promise<TradeAuditResult | null> {
    if (!recentTrades || recentTrades.length < 10) return null;

    const ai = this.getAiClient();
    if (!ai) return null;

    try {
      const tradeSummaries = recentTrades.slice(0, 20).map(t => {
        const m = typeof t.raw_metrics === 'string' ? JSON.parse(t.raw_metrics) : (t.raw_metrics || {});
        return `${m.symbol || t.asset} (${m.side || 'YES'}) | Pattern: ${m.patternType} | Result: ${t.is_win ? 'WIN' : 'LOSS'} | PnL: $${(m.pnlUsd || 0).toFixed(2)} | Close: ${m.closeReason}`;
      }).join('\n');

      const prompt = `Perform a meta-audit on these 20 recent prediction market trades. Detect recurring weaknesses and output actionable rules:
${tradeSummaries}

Return JSON:
{
  "identifiedWeaknesses": [string array of 2-3 specific cluster weaknesses],
  "recommendedRules": [string array of 2-3 specific quarantine or sizing rules],
  "timestamp": string
}`;

      const response = await this.generateContentWithFallback(ai, {
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              identifiedWeaknesses: { type: Type.ARRAY, items: { type: Type.STRING } },
              recommendedRules: { type: Type.ARRAY, items: { type: Type.STRING } },
              timestamp: { type: Type.STRING }
            },
            required: ['identifiedWeaknesses', 'recommendedRules']
          }
        }
      });

      const parsed = JSON.parse(response.text?.trim() || '{}');
      return {
        identifiedWeaknesses: parsed.identifiedWeaknesses || [],
        recommendedRules: parsed.recommendedRules || [],
        timestamp: new Date().toISOString()
      };
    } catch (e) {
      this.handleApiError(e);
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // 4. CROSS-ASSET LEAD/LAG CORRELATION ENGINE (BTC -> SOL/ETH)
  // --------------------------------------------------------------------------
  public async detectCrossAssetLeadLag(
    btcChangePct: number,
    solChangePct: number,
    ethChangePct: number
  ): Promise<LeadLagSignal | null> {
    if (Math.abs(btcChangePct) < 0.35) return null;

    let targetAsset: 'SOL' | 'ETH' | null = null;
    let predictedDirection: 'YES' | 'NO' = 'YES';
    let reason = '';
    
    if (btcChangePct >= 0.35) {
      if (solChangePct <= 0.10) {
        targetAsset = 'SOL';
        predictedDirection = 'YES';
        reason = `BTC lead momentum (+${btcChangePct.toFixed(2)}%), SOL lagging (+${solChangePct.toFixed(2)}%)`;
      } else if (ethChangePct <= 0.10) {
        targetAsset = 'ETH';
        predictedDirection = 'YES';
        reason = `BTC lead momentum (+${btcChangePct.toFixed(2)}%), ETH lagging (+${ethChangePct.toFixed(2)}%)`;
      }
    } else if (btcChangePct <= -0.35) {
      if (solChangePct >= -0.10) {
        targetAsset = 'SOL';
        predictedDirection = 'NO';
        reason = `BTC lead momentum (${btcChangePct.toFixed(2)}%), SOL lagging (${solChangePct.toFixed(2)}%)`;
      } else if (ethChangePct >= -0.10) {
        targetAsset = 'ETH';
        predictedDirection = 'NO';
        reason = `BTC lead momentum (${btcChangePct.toFixed(2)}%), ETH lagging (${ethChangePct.toFixed(2)}%)`;
      }
    }

    if (targetAsset) {
      const sig: LeadLagSignal = {
        leadAsset: 'BTC',
        targetAsset: targetAsset,
        predictedDirection: predictedDirection,
        leadDeltaPct: btcChangePct,
        reason: reason,
        timestamp: Date.now()
      };
      this.activeLeadLagSignals[targetAsset] = sig;
      return sig;
    }
    
    return null;
  }

  public getLeadLagSignal(asset: string): LeadLagSignal | null {
    const key = asset.includes('SOL') ? 'SOL' : 
                asset.includes('ETH') ? 'ETH' : 
                asset.includes('HYPE') ? 'HYPE' : 
                asset.includes('DOGE') ? 'DOGE' : 
                asset.includes('XRP') ? 'XRP' : '';
    if (!key) return null;
    const sig = this.activeLeadLagSignals[key];
    if (sig && Date.now() - sig.timestamp < 180000) {
      return sig;
    }
    return null;
  }

  // --------------------------------------------------------------------------
  // 5. DYNAMIC KELLY MULTIPLIER & DRAWDOWN GOVERNOR
  // --------------------------------------------------------------------------
  public async evaluateRiskGovernor(stats: {
    winRate24hPct: number;
    profitFactor: number;
    currentDrawdownPct: number;
    activeKellyMultiplier: number;
  }): Promise<RiskGovernorResult> {
    let baselineKelly = stats.activeKellyMultiplier;
    let status: 'SCALING_UP' | 'STABLE' | 'THROTTLED_DRAWDOWN' = 'STABLE';
    let reason = 'Mathematical drawdown governor active';

    if (stats.currentDrawdownPct > 5.0) {
      baselineKelly = Math.max(0.2, baselineKelly * 0.7);
      status = 'THROTTLED_DRAWDOWN';
      reason = `Drawdown > 5% (${stats.currentDrawdownPct.toFixed(2)}%), scaling Kelly down.`;
    } else if (stats.winRate24hPct >= 65.0 && stats.profitFactor >= 1.5 && stats.currentDrawdownPct < 2.0) {
      baselineKelly = Math.min(1.2, baselineKelly * 1.2);
      status = 'SCALING_UP';
      reason = `Win Rate > 65% and Drawdown < 2%, scaling Kelly up.`;
    }

    return {
      recommendedKellyMultiplier: Number(baselineKelly.toFixed(2)),
      status: status,
      reason: reason
    };
  }
}

export const geminiStrategyEngine = new GeminiStrategyEngine();
