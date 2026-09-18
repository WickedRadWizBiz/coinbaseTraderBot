import React, { useEffect, useState } from 'react';
import { Brain, CheckCircle2, XCircle, Zap, ShieldAlert, Layers, HelpCircle, ArrowRightLeft, Cpu, Activity, Lightbulb } from 'lucide-react';
import { RecoveryProtocolCard } from './RecoveryProtocolCard';
import { PlasticityModifierCard } from './PlasticityModifierCard';
import { ExtinctionListCard } from './ExtinctionListCard';
import { GeminiStrategyDoctorCard } from './GeminiStrategyDoctorCard';
import { MetaLearningSandboxCard } from './MetaLearningSandboxCard';

interface PatternRecord {
  patternType: string;
  winCount?: number;
  lossCount?: number;
  avgWinPnlPct?: number;
  avgLossPnlPct?: number;
  hybridizedParams?: {
    dynamicTP: number;
    dynamicSL: number;
    dynamicTrail: number;
  };
  hybridizedFailedParams?: {
    dynamicTP: number;
    dynamicSL: number;
  };
  history?: any[];
}

interface DivergenceFactor {
  metric: string;
  current: string;
  reference: string;
  discrepancy: string;
}

interface InvalidationReview {
  id: number;
  timestamp: string;
  label: string;
  symbol: string;
  patternType: string;
  outcome: string;
  pnlPct: number;
  pnlUsd?: number;
  analysisQuery: string;
  analysisShowed: string;
  wasCorrectQuery: string;
  wasAnalysisCorrect: string;
  comparisonQuery: string;
  comparativeAnalysis: {
    referenceLabel: string;
    divergenceFactors: DivergenceFactor[];
  };
  learnedBehaviorRule: string;
}

interface PatternBrainData {
  winningStrategies: { [pattern: string]: PatternRecord };
  losingStrategies: { [pattern: string]: PatternRecord };
  tradeHistory: any[];
  invalidationReviews?: InvalidationReview[];
  smartTrailingStats?: { [pattern: string]: { totalActivations: number, failures: number, totalEfficiencySum: number } };
}

export function PatternBrainView() {
  const [data, setData] = useState<PatternBrainData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedReviewId, setSelectedReviewId] = useState<number | null>(null);

  const fetchBrainData = async () => {
    try {
      const res = await fetch('/api/pattern-brain').catch(() => null);
      if (res && res.ok) {
        const ct = res.headers.get('content-type');
        if (ct && ct.includes('application/json')) {
          const json = await res.json().catch(() => null);
          if (json) {
            setData(json);
            if (json.invalidationReviews && json.invalidationReviews.length > 0 && selectedReviewId === null) {
              setSelectedReviewId(json.invalidationReviews[0].id);
            }
          }
        }
      }
    } catch {
      // Suppress transient fetch error
    } finally {
      setLoading(false);
    }
  };

  const handleResetBrain = async () => {
    try {
      await fetch('/api/pattern-brain/reset', { method: 'POST' });
      setSelectedReviewId(null);
      fetchBrainData();
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchBrainData();
    const interval = setInterval(fetchBrainData, 5000);
    return () => clearInterval(interval);
  }, []);

  const defaultPatterns = [
    { key: 'RAPID_SCALP_RSI', label: '1m RSI Divergence Scalp', desc: 'Fast 1-minute ticker RSI oversold/overbought divergence' },
    { key: 'ICHIMOKU_CLOUD_BREAKOUT', label: '5m Ichimoku Cloud Breakout', desc: 'Tenkan/Kijun cross & Senkou Span A/B cloud breakouts' },
    { key: 'CANDLESTICK_DOJI_REVERSAL', label: 'Doji Reversal Patterns', desc: 'Dragonfly/Gravestone Doji candlestick reversals' },
    { key: 'ORDERBOOK_IMBALANCE', label: 'Orderbook Depth Imbalance', desc: 'Top-3 bid/ask depth volume dominance' },
    { key: 'UNDERDOG_OVERRIDE', label: 'Underdog Value Reversals', desc: 'High-yield mispriced sports contracts (<30%)' },
    { key: 'EXPIRATION_SAFETY', label: 'Near-Expiration Safety Sweeps', desc: 'High-probability expiration locks (<1 min remaining)' }
  ];

  const selectedReview = data?.invalidationReviews?.find(r => r.id === selectedReviewId) || data?.invalidationReviews?.[0];

  return (
    <div className="flex flex-col gap-6 w-full max-w-7xl mx-auto pb-24 md:pb-6 relative z-10 text-crypto-primary font-mono text-sm tracking-wider">
      
      {/* Header Banner */}
      <div className="crt-grid-panel p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-[#8f73ff11]">
        <div className="flex items-center gap-3">
          <Brain className="w-8 h-8 text-crypto-primary animate-pulse" />
          <div>
            <h2 className="text-xl font-bold uppercase text-crypto-text tracking-[0.15em]">Pattern Strategy Knowledge Brain</h2>
            <p className="text-xs text-[#808080] font-sans">
              Separates wins & losses by analysis pattern, evaluates if predictions held true, and hybridizes winning solutions.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={fetchBrainData} 
            className="px-3 py-1 text-xs uppercase font-bold border border-crypto-primary hover:bg-crypto-primary hover:text-crypto-bg transition-colors"
          >
            {loading ? 'SYNCING...' : 'REFRESH BRAIN'}
          </button>
          <button 
            onClick={handleResetBrain} 
            className="px-3 py-1 text-xs uppercase font-bold border border-crypto-danger text-crypto-danger hover:bg-crypto-danger hover:text-white transition-colors"
            title="Reset strategy performance memory and trade history"
          >
            RESET BRAIN & HISTORY
          </button>
        </div>
      </div>

      {/* Crypto Analysis Protocol Verification Banner */}
      <div className="crt-grid-panel p-4 bg-black/60 border border-crypto-primary/40 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <Cpu className="w-6 h-6 text-crypto-secondary shrink-0 mt-0.5" />
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-crypto-text uppercase text-xs">Crypto Analysis Verification Protocol</span>
              <span className="text-[10px] px-1.5 py-0.2 border border-crypto-success text-crypto-success bg-crypto-success/10 font-bold">
                SPOT USD + CONTRACT DUAL-LAYER
              </span>
            </div>
            <p className="text-xs text-[#909090] font-sans mt-1">
              <span className="text-crypto-primary font-mono font-bold">Spot USD Pair:</span> Evaluates live Coinbase WebSocket ticks & candles (BTC-USD, ETH-USD, SOL-USD) for Ichimoku clouds, RSI divergence, and candlestick reversals.<br />
              <span className="text-crypto-secondary font-mono font-bold">Kalshi Prediction Contract:</span> Evaluates implied probability odds, contract orderbook bid/ask depth, spread slippage, and expiration time decay.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 border-l border-crypto-primary/30 pl-4 py-1 text-xs">
          <Activity className="w-4 h-4 text-crypto-success animate-pulse" />
          <span className="text-[11px] text-[#a0a0a0]">Real-Time Synchronized</span>
        </div>
      </div>

      {/* Plasticity Strategy Modifier Engine */}
      <PlasticityModifierCard />

      {/* TIME-OUT GUARD SCREEN */}
      <ExtinctionListCard />

      {/* STRATEGIC EVOLUTION SCREEN */}
      <GeminiStrategyDoctorCard />

      {/* Pattern Hybrid Matrix Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {defaultPatterns.map((p, idx) => {
          const winRec = data?.winningStrategies?.[p.key];
          const lossRec = data?.losingStrategies?.[p.key];

          const wins = winRec?.winCount || 0;
          const losses = lossRec?.lossCount || 0;
          const total = wins + losses;
          const accuracy = total > 0 ? (wins / total) * 100 : 0;

          const tp = winRec?.hybridizedParams?.dynamicTP ? (winRec.hybridizedParams.dynamicTP * 100).toFixed(1) : '10.0';
          const sl = winRec?.hybridizedParams?.dynamicSL ? (winRec.hybridizedParams.dynamicSL * 100).toFixed(1) : '-4.0';
          const trail = winRec?.hybridizedParams?.dynamicTrail ? (winRec.hybridizedParams.dynamicTrail * 100).toFixed(1) : '1.0';

          return (
            <div key={`patt-${p.key}-${idx}`} className="crt-grid-panel p-4 flex flex-col justify-between border border-crypto-primary/40 bg-black/40 relative">
              <div className="absolute top-2 right-2 flex items-center gap-1">
                <span className={`text-[10px] px-2 py-0.5 font-bold uppercase border ${
                  accuracy >= 50 ? 'border-crypto-success text-crypto-success bg-crypto-success/10' : 'border-crypto-danger text-crypto-danger bg-crypto-danger/10'
                }`}>
                  {total > 0 ? `${accuracy.toFixed(0)}% ACCURACY` : 'NO TRADES'}
                </span>
              </div>

              <div>
                <h4 className="font-bold text-crypto-text text-base mb-1 pr-20">{p.label}</h4>
                <p className="text-[11px] text-[#707070] mb-4 font-sans leading-tight">{p.desc}</p>

                {/* Metrics */}
                <div className="grid grid-cols-2 gap-2 mb-4 text-xs bg-[#11111a] p-2 border border-crypto-primary/20">
                  <div>
                    <span className="text-[10px] opacity-60 uppercase block">Wins / Losses</span>
                    <span className="font-bold text-crypto-success">{wins} W</span> / <span className="font-bold text-crypto-danger">{losses} L</span>
                  </div>
                  <div>
                    <span className="text-[10px] opacity-60 uppercase block">Avg Win PnL</span>
                    <span className="font-bold text-crypto-primary">+{winRec?.avgWinPnlPct || 0}%</span>
                  </div>
                </div>

                {/* Hybridized Parameters */}
                <div className="text-xs flex flex-col gap-1 border-t border-crypto-primary/30 pt-2">
                  <span className="text-[10px] text-crypto-primary uppercase font-bold flex items-center gap-1">
                    <Zap className="w-3 h-3" /> Hybridized Solution Parameters
                  </span>
                  <div className="flex justify-between items-center text-[11px]">
                    <span className="opacity-70">Take Profit:</span>
                    <span className="font-bold text-crypto-success">+{tp}%</span>
                  </div>
                  <div className="flex justify-between items-center text-[11px]">
                    <span className="opacity-70">Stop Loss:</span>
                    <span className="font-bold text-crypto-danger">{sl}%</span>
                  </div>
                  <div className="flex justify-between items-center text-[11px]">
                    <span className="opacity-70">Trailing Lock:</span>
                    <span className="font-bold text-crypto-primary">+{trail}%</span>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* COMPARATIVE ANALYSIS REVIEW & PATTERN INVALIDATION LOG */}
      <div className="crt-grid-panel p-5 flex flex-col gap-5 border border-crypto-secondary/50 bg-[#0d091a]">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-2 border-b border-crypto-secondary/40 pb-3">
          <div className="flex items-center gap-2">
            <ArrowRightLeft className="w-5 h-5 text-crypto-secondary" />
            <h3 className="font-bold text-base uppercase text-crypto-text tracking-wider">
              Comparative Analysis Review & Pattern Invalidation Matrix
            </h3>
          </div>
          <span className="text-xs text-crypto-secondary bg-crypto-secondary/10 px-2 py-0.5 border border-crypto-secondary/30">
            Learned Asset Behavior Memory ({data?.invalidationReviews?.length || 0} Saved)
          </span>
        </div>

        {(!data?.invalidationReviews || data.invalidationReviews.length === 0) ? (
          <div className="p-8 text-center text-xs text-[#808080] font-sans">
            Awaiting completed trades to generate comparative invalidation reviews...<br />
            When trades execute, the brain compares winning vs. losing setup metrics to isolate pattern invalidation triggers.
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* Left Selection List */}
            <div className="lg:col-span-4 flex flex-col gap-2 max-h-[450px] overflow-y-auto pr-1 custom-scrollbar touch-pan-y">
              <span className="text-[10px] uppercase text-[#808080] font-bold tracking-widest mb-1">
                Select Evaluated Analysis
              </span>
              {data.invalidationReviews.map((rev, idx) => (
                <button
                  key={`rev-${rev.id}-${rev.timestamp}-${idx}`}
                  onClick={() => setSelectedReviewId(rev.id)}
                  className={`p-3 text-left border transition-all flex flex-col gap-1 ${
                    selectedReview?.id === rev.id 
                      ? 'border-crypto-secondary bg-crypto-secondary/20 shadow-[0_0_10px_rgba(143,115,255,0.2)]' 
                      : 'border-crypto-primary/30 bg-black/40 hover:bg-crypto-primary/10'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-crypto-text text-xs">{rev.label}</span>
                    <span className={`text-[10px] font-bold px-1.5 py-0.2 border ${
                      rev.outcome === 'VALIDATED_WIN' 
                        ? 'border-crypto-success text-crypto-success bg-crypto-success/10' 
                        : 'border-crypto-danger text-crypto-danger bg-crypto-danger/10'
                    }`}>
                      {rev.outcome === 'VALIDATED_WIN' ? `WIN +${rev.pnlPct}%` : `INVALIDATED ${rev.pnlPct}%`}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-[#808080]">
                    <span>{rev.patternType}</span>
                    <span>{new Date(rev.timestamp).toLocaleTimeString()}</span>
                  </div>
                </button>
              ))}
            </div>

            {/* Right Detailed Comparative Review Card */}
            {selectedReview && (
              <div className="lg:col-span-8 bg-black/60 border border-crypto-secondary/40 p-5 flex flex-col gap-4 font-sans text-xs max-h-[450px] overflow-y-auto custom-scrollbar touch-pan-y">
                
                {/* Header */}
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-2 border-b border-crypto-primary/20 pb-3">
                  <div>
                    <span className="text-[10px] text-crypto-secondary uppercase font-bold tracking-widest font-mono">
                      Asset & Contract Setup
                    </span>
                    <h4 className="text-base font-bold text-crypto-text font-mono mt-0.5">{selectedReview.label}</h4>
                  </div>
                  <div className="flex items-center gap-2 font-mono">
                    <span className="text-[11px] text-[#808080]">Pattern: <span className="text-crypto-primary font-bold">{selectedReview.patternType}</span></span>
                    <span className={`text-xs font-bold px-2 py-0.5 border ${
                      selectedReview.outcome === 'VALIDATED_WIN' 
                        ? 'border-crypto-success text-crypto-success bg-crypto-success/10' 
                        : 'border-crypto-danger text-crypto-danger bg-crypto-danger/10'
                    }`}>
                      {selectedReview.outcome === 'VALIDATED_WIN' ? `VALIDATED WIN (+${selectedReview.pnlPct}%)` : `PATTERN INVALIDATED (${selectedReview.pnlPct}%)`}
                    </span>
                  </div>
                </div>

                {/* Q1: What did analysis show? */}
                <div className="bg-[#12101e] p-3 border border-crypto-primary/20 rounded">
                  <span className="text-[10px] text-crypto-primary font-mono uppercase font-bold flex items-center gap-1 mb-1">
                    <HelpCircle className="w-3.5 h-3.5" /> What Did Analysis Show?
                  </span>
                  <p className="text-crypto-text font-mono text-xs">{selectedReview.analysisShowed}</p>
                </div>

                {/* Q2: Was the analysis correct? */}
                <div className="bg-[#12101e] p-3 border border-crypto-primary/20 rounded">
                  <span className="text-[10px] text-crypto-primary font-mono uppercase font-bold flex items-center gap-1 mb-1">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Was The Analysis Correct?
                  </span>
                  <p className={`font-mono text-xs font-bold ${selectedReview.outcome === 'VALIDATED_WIN' ? 'text-crypto-success' : 'text-crypto-danger'}`}>
                    {selectedReview.wasAnalysisCorrect}
                  </p>
                </div>

                {/* Q3: Comparative Divergence Analysis */}
                <div className="bg-[#12101e] p-3 border border-crypto-secondary/30 rounded flex flex-col gap-2">
                  <span className="text-[10px] text-crypto-secondary font-mono uppercase font-bold flex items-center gap-1">
                    <ArrowRightLeft className="w-3.5 h-3.5" /> {selectedReview.comparisonQuery}
                  </span>

                  <div className="text-[11px] text-[#a0a0a0] mb-1 font-mono">
                    Baseline Comparison Reference: <span className="text-crypto-text font-bold">{selectedReview.comparativeAnalysis.referenceLabel}</span>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-[11px] font-mono border-collapse">
                      <thead>
                        <tr className="border-b border-crypto-secondary/30 text-crypto-secondary text-[10px]">
                          <th className="py-1.5 px-2">EVALUATED METRIC</th>
                          <th className="py-1.5 px-2">THIS TRADE SETUP</th>
                          <th className="py-1.5 px-2">REFERENCE SETUP</th>
                          <th className="py-1.5 px-2">DISCREPANCY / INVALIDATION CAUSE</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-crypto-primary/10">
                        {(selectedReview?.comparativeAnalysis?.divergenceFactors || []).map((df, idx) => (
                          <tr key={`df-${df.metric.replace(/\s+/g, '-')}-${idx}`} className="hover:bg-crypto-secondary/5">
                            <td className="py-2 px-2 font-bold text-crypto-text">{df.metric}</td>
                            <td className="py-2 px-2 text-crypto-primary font-bold">{df.current}</td>
                            <td className="py-2 px-2 text-[#a0a0a0]">{df.reference}</td>
                            <td className="py-2 px-2 text-crypto-text font-sans text-xs leading-normal">{df.discrepancy}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Q4: Learned Behavior Rule */}
                <div className="bg-crypto-secondary/10 border border-crypto-secondary p-3 rounded flex items-start gap-2.5">
                  <Lightbulb className="w-5 h-5 text-crypto-secondary shrink-0 mt-0.5 animate-pulse" />
                  <div>
                    <span className="text-[10px] text-crypto-secondary font-mono uppercase font-bold block mb-0.5">
                      Memory Injected: Learned Asset & Pattern Behavior Rule
                    </span>
                    <p className="text-xs text-crypto-text font-mono font-bold">{selectedReview.learnedBehaviorRule}</p>
                  </div>
                </div>

              </div>
            )}
          </div>
        )}
      </div>

      {/* Meta-Labeling & Counterfactual Sandbox Retraining Protocol */}
      <MetaLearningSandboxCard />

      {/* Capital Preservation Recovery Protocol Panel */}
      <RecoveryProtocolCard />

    </div>
  );
}
