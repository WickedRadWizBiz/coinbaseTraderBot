import React, { useState, useEffect } from 'react';
import { Cpu, Sparkles, Trophy, ArrowRightLeft, ShieldAlert, CheckCircle2, RefreshCw, Zap, Sliders, Layers } from 'lucide-react';

export interface StrategyParameterSet {
  dynamicTP: number;
  dynamicSL: number;
  dynamicTrail?: number;
  kellyMultiplier: number;
  preferredContractTypes: string[];
  winSelectionRules: string[];
  lossAvoidanceRules: string[];
  riskTolerance: string;
  explanation?: string;
}

export interface PlasticityHallOfFameRecord {
  id: string;
  patternType: string;
  peakYieldPnlPct: number;
  winRatePct: number;
  totalTradesExecuted: number;
  parameterSet: StrategyParameterSet;
  achievedAt: string;
  marketRegime: string;
}

export interface PlasticitySynthesisEvent {
  id: number;
  timestamp: string;
  patternType: string;
  freshHybridization: StrategyParameterSet;
  allTimeBest: StrategyParameterSet;
  synthesizedSolution: StrategyParameterSet;
  plasticityScore: number;
  comparisonReasoning: string;
  winningFactors: string[];
}

export interface SynapticComponentNode {
  key: string;
  label: string;
  category: 'ASSET' | 'ASSET_TYPE' | 'INDICATOR' | 'PATTERN' | 'RULE' | 'CONTRACT_SIDE';
  winCount: number;
  lossCount: number;
  totalNetPnlUsd: number;
  baseStrengthScore: number;
  isTopEarner: boolean;
  effectiveStrengthScore: number;
  influencePctBoost: number;
  lastFiredAt: string;
}

export interface PlasticitySummary {
  hallOfFame: { [patternType: string]: PlasticityHallOfFameRecord };
  recentEvents: PlasticitySynthesisEvent[];
  synapticMatrix?: { [key: string]: SynapticComponentNode };
  topEarner?: SynapticComponentNode | null;
  heatmapData?: any;
  lastUpdated: string;
}

export function PlasticityModifierCard() {
  const [data, setData] = useState<PlasticitySummary | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [synthesizing, setSynthesizing] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<string>('HALL_OF_FAME');
  const [selectedPattern, setSelectedPattern] = useState<string>('RECOVERY_PROTOCOL_GLOBAL');

  const fetchPlasticityData = async () => {
    try {
      const res = await fetch('/api/plasticity');
      if (res.ok) {
        const ct = res.headers.get('content-type');
        if (ct && ct.includes('application/json')) {
          const json = await res.json().catch(() => null);
          if (json) setData(json);
        }
      }
    } catch (e) {
      console.error('[PLASTICITY UI] Error fetching plasticity summary:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleManualSynthesis = async () => {
    setSynthesizing(true);
    try {
      const res = await fetch('/api/plasticity/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patternType: selectedPattern })
      });
      if (res.ok) {
        await fetchPlasticityData();
      }
    } catch (e) {
      console.error('[PLASTICITY UI] Error triggering manual synthesis:', e);
    } finally {
      setSynthesizing(false);
    }
  };

  useEffect(() => {
    let isMounted = true;
    const safeFetch = () => {
      if (document.hidden) return;
      fetchPlasticityData();
    };
    safeFetch();
    const interval = setInterval(safeFetch, 10000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  const patternKeys = [
    { key: 'RECOVERY_PROTOCOL_GLOBAL', label: 'Recovery Protocol Global' },
    { key: 'RAPID_SCALP_RSI', label: '1m RSI Scalp Divergence' },
    { key: 'ORDERBOOK_IMBALANCE', label: 'Orderbook Depth Imbalance' },
    { key: 'ICHIMOKU_CLOUD_BREAKOUT', label: '5m Ichimoku Cloud Breakout' },
    { key: 'UNDERDOG_OVERRIDE', label: 'Underdog Value Reversals' },
    { key: 'EXPIRATION_SAFETY', label: 'Near-Expiration Safety Sweeps' },
    { key: 'CANDLESTICK_DOJI_REVERSAL', label: 'Doji Reversal Patterns' }
  ];

  const latestEvent = data?.recentEvents?.[0];
  const activeRecord = data?.hallOfFame?.[selectedPattern];

  return (
    <div className="crt-grid-panel p-5 bg-black/70 border border-crypto-secondary/50 flex flex-col gap-5 w-full font-mono text-xs shadow-[0_0_15px_rgba(143,115,255,0.15)] relative overflow-hidden">
      
      {/* Top Banner Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-crypto-secondary/30 pb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-crypto-secondary/20 border border-crypto-secondary rounded">
            <Cpu className="w-6 h-6 text-crypto-secondary animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-sm tracking-[0.15em] text-crypto-text uppercase">
                Plasticity Strategy Modifier
              </h3>
              <span className="text-[10px] px-2 py-0.5 bg-crypto-secondary/20 text-crypto-secondary border border-crypto-secondary font-bold uppercase tracking-wider">
                NEURO-PLASTIC MEMORY ENGINE
              </span>
            </div>
            <p className="text-[11px] text-[#909090] font-sans mt-0.5">
              Remembers all-time highest-yield strategy configurations across tracked parameters. When a strategy hybridizes, Plasticity compares fresh proposals against peak historical records with Gemini for optimal cross-synthesis.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleManualSynthesis}
            disabled={synthesizing}
            className="px-3 py-1.5 bg-crypto-secondary text-black font-bold hover:bg-opacity-90 transition-all flex items-center gap-1.5 uppercase text-[11px] disabled:opacity-50"
          >
            <Sparkles className={`w-3.5 h-3.5 ${synthesizing ? 'animate-spin' : ''}`} />
            {synthesizing ? 'SYNTHESIZING WITH GEMINI...' : 'COMPARE & SYNTHESIZE WITH GEMINI'}
          </button>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex items-center justify-between border-b border-crypto-primary/20 pb-2">
        <div className="flex items-center gap-2 overflow-x-auto pb-1 custom-scrollbar">
          <button
            onClick={() => setActiveTab('HALL_OF_FAME')}
            className={`px-3 py-1 border text-[11px] font-bold uppercase transition-all flex items-center gap-1.5 whitespace-nowrap ${
              activeTab === 'HALL_OF_FAME'
                ? 'border-crypto-secondary bg-crypto-secondary/20 text-crypto-text'
                : 'border-crypto-primary/30 text-[#808080] hover:bg-crypto-primary/10'
            }`}
          >
            <Trophy className="w-3.5 h-3.5 text-yellow-400" />
            All-Time High Yield Hall of Fame
          </button>
          <button
            onClick={() => setActiveTab('SYNTACTIC_MATRIX')}
            className={`px-3 py-1 border text-[11px] font-bold uppercase transition-all flex items-center gap-1.5 whitespace-nowrap ${
              activeTab === 'SYNTACTIC_MATRIX'
                ? 'border-crypto-secondary bg-crypto-secondary/20 text-crypto-text'
                : 'border-crypto-primary/30 text-[#808080] hover:bg-crypto-primary/10'
            }`}
          >
            <Zap className="w-3.5 h-3.5 text-yellow-400 animate-pulse" />
            Adaptive Weight Scores ({data?.synapticMatrix ? Object.keys(data.synapticMatrix).length : 0})
          </button>
          <button
            onClick={() => setActiveTab('SYNTHESIS_EVENTS')}
            className={`px-3 py-1 border text-[11px] font-bold uppercase transition-all flex items-center gap-1.5 whitespace-nowrap ${
              activeTab === 'SYNTHESIS_EVENTS'
                ? 'border-crypto-secondary bg-crypto-secondary/20 text-crypto-text'
                : 'border-crypto-primary/30 text-[#808080] hover:bg-crypto-primary/10'
            }`}
          >
            <ArrowRightLeft className="w-3.5 h-3.5 text-crypto-secondary" />
            Plasticity Comparative Synthesis Feed ({data?.recentEvents?.length || 0})
          </button>
        </div>

        <span className="text-[10px] text-[#707070] hidden md:inline">
          Last Memory Sync: {data?.lastUpdated ? new Date(data.lastUpdated).toLocaleTimeString() : 'LIVE'}
        </span>
      </div>

      {/* TAB 1: ALL-TIME HIGH YIELD HALL OF FAME */}
      {activeTab === 'HALL_OF_FAME' && (
        <div className="flex flex-col gap-4">
          
          {/* Pattern Selection Pills */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 custom-scrollbar touch-pan-x">
            {patternKeys.map((p) => (
              <button
                key={p.key}
                onClick={() => setSelectedPattern(p.key)}
                className={`px-2.5 py-1 text-[10px] border font-bold uppercase whitespace-nowrap transition-all ${
                  selectedPattern === p.key
                    ? 'border-crypto-secondary bg-crypto-secondary/30 text-white shadow-[0_0_8px_rgba(143,115,255,0.3)]'
                    : 'border-crypto-primary/30 text-[#808080] bg-black/40 hover:text-crypto-primary'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {activeRecord ? (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 bg-black/50 border border-crypto-secondary/30 p-4">
              
              {/* Left Column: Peak Performance Badges */}
              <div className="lg:col-span-4 flex flex-col gap-3 border-b lg:border-b-0 lg:border-r border-crypto-primary/20 pr-0 lg:pr-4 pb-3 lg:pb-0">
                <div className="flex items-center gap-2">
                  <Trophy className="w-5 h-5 text-yellow-400" />
                  <div>
                    <h4 className="font-bold text-crypto-text text-xs uppercase">{activeRecord.patternType}</h4>
                    <span className="text-[10px] text-[#808080]">Record ID: {activeRecord.id}</span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 bg-[#11111e] p-3 border border-crypto-secondary/20">
                  <div>
                    <span className="text-[10px] text-[#808080] uppercase block">Peak Yield PnL</span>
                    <span className="text-sm font-bold text-crypto-success">+{activeRecord.peakYieldPnlPct}%</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-[#808080] uppercase block">Historical Win Rate</span>
                    <span className="text-sm font-bold text-crypto-primary">{activeRecord.winRatePct}%</span>
                  </div>
                </div>

                <div className="flex flex-col gap-1 text-[10px] text-[#909090] font-sans">
                  <span><strong className="font-mono text-crypto-text">Achieved Date:</strong> {new Date(activeRecord.achievedAt).toLocaleString()}</span>
                  <span><strong className="font-mono text-crypto-text">Evaluated Trades:</strong> {activeRecord.totalTradesExecuted} trades</span>
                  <span><strong className="font-mono text-crypto-text">Regime Memory:</strong> {activeRecord.marketRegime}</span>
                </div>
              </div>

              {/* Right Column: Stored Strategy Parameter Matrix */}
              <div className="lg:col-span-8 flex flex-col gap-3 font-sans text-xs">
                <div className="flex items-center justify-between border-b border-crypto-primary/20 pb-1 font-mono text-[11px]">
                  <span className="font-bold text-crypto-text uppercase">ALL-TIME BEST PARAMETER SNAPSHOT</span>
                  <span className="text-crypto-secondary font-bold text-[10px] uppercase">
                    Risk Tolerance: {activeRecord.parameterSet.riskTolerance}
                  </span>
                </div>

                {/* Key Parameter Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-xs bg-[#0a0a14] p-2.5 border border-crypto-primary/20">
                  <div>
                    <span className="text-[10px] text-[#808080] block uppercase">Dynamic TP</span>
                    <span className="font-bold text-crypto-success">+{(activeRecord.parameterSet.dynamicTP * 100).toFixed(1)}%</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-[#808080] block uppercase">Dynamic SL</span>
                    <span className="font-bold text-crypto-danger">{(activeRecord.parameterSet.dynamicSL * 100).toFixed(1)}%</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-[#808080] block uppercase">Trailing Lock</span>
                    <span className="font-bold text-crypto-primary">+{( (activeRecord.parameterSet.dynamicTrail || 0.005) * 100).toFixed(1)}%</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-[#808080] block uppercase">Kelly Sizing</span>
                    <span className="font-bold text-crypto-secondary">{activeRecord.parameterSet.kellyMultiplier}x</span>
                  </div>
                </div>

                {/* Rules & Contracts */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px]">
                  <div className="p-2 bg-black/40 border border-crypto-success/20 flex flex-col gap-1">
                    <span className="font-mono font-bold text-crypto-success text-[10px] uppercase flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" /> Win Selection Rules ({activeRecord.parameterSet.winSelectionRules?.length || 0})
                    </span>
                    <ul className="list-disc list-inside text-[#a0a0a0] font-mono text-[10px] gap-0.5 flex flex-col">
                      {activeRecord.parameterSet.winSelectionRules?.map((r, i) => (
                        <li key={i}>{r}</li>
                      )) || <li>ICHIMOKU_CLOUD_ALIGNMENT</li>}
                    </ul>
                  </div>

                  <div className="p-2 bg-black/40 border border-crypto-danger/20 flex flex-col gap-1">
                    <span className="font-mono font-bold text-crypto-danger text-[10px] uppercase flex items-center gap-1">
                      <ShieldAlert className="w-3 h-3" /> Loss Avoidance Rules ({activeRecord.parameterSet.lossAvoidanceRules?.length || 0})
                    </span>
                    <ul className="list-disc list-inside text-[#a0a0a0] font-mono text-[10px] gap-0.5 flex flex-col">
                      {activeRecord.parameterSet.lossAvoidanceRules?.map((r, i) => (
                        <li key={i}>{r}</li>
                      )) || <li>AVOID_DOJI_INDECISION_CANDLES</li>}
                    </ul>
                  </div>
                </div>

                <p className="text-[11px] text-[#808080] italic">
                  "{activeRecord.parameterSet.explanation || 'All-Time Highest Yield Strategy Memory Profile.'}"
                </p>
              </div>

            </div>
          ) : (
            <div className="p-4 text-center text-[#808080]">No Plasticity record available for {selectedPattern}.</div>
          )}

        </div>
      )}

      {/* TAB 3: ADAPTIVE MATRIX & COMPONENT STRENGTH SCORES */}
      {activeTab === 'SYNTACTIC_MATRIX' && (
        <div className="flex flex-col gap-4 font-sans text-xs">
          
          {/* Top Earner 1.5x Boost Banner */}
          {data?.topEarner ? (
            <div className="bg-gradient-to-r from-yellow-950/40 via-black to-purple-950/40 border border-yellow-500/50 p-3.5 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 shadow-[0_0_15px_rgba(234,179,8,0.15)]">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-yellow-500/20 border border-yellow-500/80 rounded shrink-0">
                  <Trophy className="w-6 h-6 text-yellow-400 animate-bounce" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono font-bold px-1.5 py-0.2 bg-yellow-500 text-black uppercase">
                      #1 TOP EARNING COMPONENT (+1.5x BOOST)
                    </span>
                    <span className="text-[10px] font-mono text-yellow-300 uppercase font-bold">
                      {data.topEarner.category}
                    </span>
                  </div>
                  <h4 className="text-sm font-bold text-white font-mono uppercase mt-0.5">
                    {data.topEarner.label}
                  </h4>
                  <p className="text-[11px] text-[#b0b0b0] font-sans mt-0.5">
                    Highest net USD profit earner. Receives a <strong className="text-yellow-400">1.5x strength boost multiplier</strong> ({data.topEarner.baseStrengthScore} base &rarr; <span className="text-yellow-300 font-bold">{data.topEarner.effectiveStrengthScore} boosted score</span>).
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0 font-mono text-right">
                <div className="bg-black/60 p-2 border border-yellow-500/30 rounded">
                  <span className="text-[9px] text-[#808080] uppercase block">Cumulative Net Profit</span>
                  <span className="text-sm font-bold text-crypto-success">+${(data.topEarner?.totalNetPnlUsd ?? 0).toFixed(2)} USD</span>
                </div>
                <div className="bg-black/60 p-2 border border-yellow-500/30 rounded">
                  <span className="text-[9px] text-[#808080] uppercase block">Hybrid Influence Boost</span>
                  <span className="text-sm font-bold text-yellow-300">+{data.topEarner.influencePctBoost}% influence</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="p-3 bg-black/40 border border-crypto-primary/20 text-[#808080] text-center font-mono">
              Evaluating live trades to determine #1 top-earning component for the 1.5x plasticity boost.
            </div>
          )}

          {/* Matrix Description Header */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between bg-black/40 p-2.5 border border-crypto-secondary/20 text-[11px] text-[#a0a0a0] font-sans gap-2">
            <div>
              <strong className="text-crypto-text font-mono">OJA'S LEARNING RULE (WEIGHT DECAY):</strong> Win occurrences increase probability shrinkage (+1.5 score), while losses apply Ornstein-Uhlenbeck variance tracking (-1.2 score). Base strength scores span strictly <strong>1 &ndash; 30</strong>.
            </div>
            <span className="text-[10px] font-mono text-crypto-secondary whitespace-nowrap bg-crypto-secondary/10 px-2 py-0.5 border border-crypto-secondary/30">
              1 Strength Point = +1% Hybridization Influence
            </span>
          </div>

          {/* Synaptic Strength Nodes Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 max-h-[380px] overflow-y-auto pr-1 custom-scrollbar touch-pan-y">
            {data?.synapticMatrix && Object.values(data.synapticMatrix).length > 0 ? (
              (Object.values(data.synapticMatrix) as SynapticComponentNode[])
                .sort((a, b) => b.effectiveStrengthScore - a.effectiveStrengthScore)
                .map((node) => {
                  const winRate = (node.winCount + node.lossCount) > 0 
                    ? Math.round((node.winCount / (node.winCount + node.lossCount)) * 100) 
                    : 0;
                  const pctWidth = Math.min(100, Math.max(5, (node.effectiveStrengthScore / 45) * 100));

                  return (
                    <div 
                      key={node.key} 
                      className={`p-3 border font-mono text-xs flex flex-col gap-2 transition-all ${
                        node.isTopEarner 
                          ? 'bg-yellow-950/20 border-yellow-500/80 shadow-[0_0_10px_rgba(234,179,8,0.2)]' 
                          : 'bg-black/60 border-crypto-primary/30 hover:border-crypto-secondary/50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-1.5">
                        <div className="flex items-center gap-1.5 overflow-hidden">
                          <span className={`text-[9px] px-1.5 py-0.2 font-bold uppercase shrink-0 ${
                            node.category === 'ASSET' ? 'bg-blue-900/60 text-blue-300 border border-blue-500/40' :
                            node.category === 'ASSET_TYPE' ? 'bg-purple-900/60 text-purple-300 border border-purple-500/40' :
                            node.category === 'INDICATOR' ? 'bg-emerald-900/60 text-emerald-300 border border-emerald-500/40' :
                            'bg-gray-800 text-gray-300 border border-gray-600'
                          }`}>
                            {node.category}
                          </span>
                          <span className="font-bold text-crypto-text truncate text-[11px]" title={node.label}>
                            {node.label}
                          </span>
                        </div>

                        {node.isTopEarner && (
                          <span className="text-[9px] px-1.5 py-0.2 bg-yellow-500 text-black font-bold uppercase shrink-0">
                            1.5x BOOST
                          </span>
                        )}
                      </div>

                      {/* Strength Score Progress Bar */}
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center justify-between text-[10px]">
                          <span className="text-[#808080] uppercase">Synaptic Strength:</span>
                          <span className="font-bold text-crypto-text">
                            {node.baseStrengthScore} {node.isTopEarner ? `x 1.5 = ${node.effectiveStrengthScore}` : ''} / 30
                          </span>
                        </div>
                        <div className="w-full h-1.5 bg-gray-900 border border-gray-700 rounded-full overflow-hidden">
                          <div 
                            className={`h-full transition-all duration-500 ${
                              node.isTopEarner ? 'bg-yellow-400 shadow-[0_0_8px_#eab308]' :
                              node.effectiveStrengthScore >= 20 ? 'bg-crypto-success' :
                              node.effectiveStrengthScore >= 10 ? 'bg-crypto-secondary' : 'bg-crypto-danger'
                            }`}
                            style={{ width: `${pctWidth}%` }}
                          />
                        </div>
                      </div>

                      {/* Performance Metrics Row */}
                      <div className="grid grid-cols-3 gap-1 bg-black/40 p-1.5 border border-white/5 text-[10px] text-center">
                        <div>
                          <span className="text-[#707070] block uppercase">Wins / Loss</span>
                          <span className="font-bold text-crypto-text">{node.winCount}W / {node.lossCount}L ({winRate}%)</span>
                        </div>
                        <div>
                          <span className="text-[#707070] block uppercase">Net PnL</span>
                          <span className={`font-bold ${node.totalNetPnlUsd >= 0 ? 'text-crypto-success' : 'text-crypto-danger'}`}>
                            {(node?.totalNetPnlUsd ?? 0) >= 0 ? '+' : ''}${(node?.totalNetPnlUsd ?? 0).toFixed(2)}
                          </span>
                        </div>
                        <div>
                          <span className="text-[#707070] block uppercase">Influence</span>
                          <span className="font-bold text-crypto-secondary">+{node.influencePctBoost}%</span>
                        </div>
                      </div>

                    </div>
                  );
                })
            ) : (
              <div className="col-span-3 p-4 text-center text-[#808080]">No synaptic matrix nodes recorded yet.</div>
            )}
          </div>

        </div>
      )}

      {/* TAB 3: SYNTHESIS EVENTS FEED */}
      {activeTab === 'SYNTHESIS_EVENTS' && (
        <div className="flex flex-col gap-3 max-h-[400px] overflow-y-auto pr-1 custom-scrollbar touch-pan-y">
          {data?.recentEvents && data.recentEvents.length > 0 ? (
            data.recentEvents.map((evt) => (
              <div key={evt.id} className="bg-black/60 border border-crypto-secondary/30 p-3 flex flex-col gap-2 font-sans text-xs">
                
                {/* Event Header */}
                <div className="flex items-center justify-between font-mono text-[11px] border-b border-crypto-primary/20 pb-1.5">
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.2 bg-crypto-secondary/20 text-crypto-secondary border border-crypto-secondary font-bold">
                      SCORE: {evt.plasticityScore}/100
                    </span>
                    <span className="font-bold text-crypto-text uppercase">{evt.patternType}</span>
                  </div>
                  <span className="text-[#707070] text-[10px]">
                    {new Date(evt.timestamp).toLocaleTimeString()}
                  </span>
                </div>

                {/* Synthesis Reasoning */}
                <p className="text-crypto-text leading-relaxed font-sans text-[11px]">
                  {evt.comparisonReasoning}
                </p>

                {/* Winning Factors Chips */}
                {evt.winningFactors && evt.winningFactors.length > 0 && (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[10px] font-mono text-[#808080] uppercase">Selected Factors:</span>
                    {evt.winningFactors.map((wf, idx) => (
                      <span key={idx} className="text-[10px] font-mono px-1.5 py-0.2 border border-crypto-success/40 text-crypto-success bg-crypto-success/10">
                        {wf}
                      </span>
                    ))}
                  </div>
                )}

                {/* Comparative Parameters Comparison */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2 font-mono text-[10px] mt-1 bg-[#0d0d17] p-2 border border-crypto-primary/20">
                  <div>
                    <span className="text-[#808080] uppercase block">Fresh Proposal</span>
                    <span className="text-crypto-primary">
                      TP: +{((evt.freshHybridization?.dynamicTP ?? 0) * 100).toFixed(1)}% | SL: {((evt.freshHybridization?.dynamicSL ?? 0) * 100).toFixed(1)}% | Kelly: {evt.freshHybridization?.kellyMultiplier ?? 0}x
                    </span>
                  </div>
                  <div>
                    <span className="text-[#808080] uppercase block">All-Time Past Best</span>
                    <span className="text-yellow-400">
                      TP: +{((evt.allTimeBest?.dynamicTP ?? 0) * 100).toFixed(1)}% | SL: {((evt.allTimeBest?.dynamicSL ?? 0) * 100).toFixed(1)}% | Kelly: {evt.allTimeBest?.kellyMultiplier ?? 0}x
                    </span>
                  </div>
                  <div>
                    <span className="text-[#808080] uppercase block">Plasticity Solution</span>
                    <span className="text-crypto-success font-bold">
                      TP: +{((evt.synthesizedSolution?.dynamicTP ?? 0) * 100).toFixed(1)}% | SL: {((evt.synthesizedSolution?.dynamicSL ?? 0) * 100).toFixed(1)}% | Kelly: {evt.synthesizedSolution?.kellyMultiplier ?? 0}x
                    </span>
                  </div>
                </div>

              </div>
            ))
          ) : (
            <div className="p-4 text-center text-[#808080]">No Plasticity synthesis events recorded yet.</div>
          )}
        </div>
      )}

    </div>
  );
}
