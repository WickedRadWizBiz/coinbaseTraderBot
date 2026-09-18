import React, { useState, useEffect } from 'react';
import { 
  RefreshCw, Cpu, Gauge, ShieldCheck, ShieldAlert, BarChart3, Activity, 
  Zap, CheckCircle2, XCircle, Clock, History, AlertTriangle, Layers, 
  FileText, Award, Terminal, ArrowUpRight, Check, Play
} from 'lucide-react';

export interface IndicatorEfficacy {
  indicatorName: string;
  category: string;
  totalSignals: number;
  truePositives: number;
  falsePositives: number;
  precision: number;
  discriminatingPowerScore: number;
  recommendation: 'STRONG_BOOST' | 'NEUTRAL_KEEP' | 'SUPPRESS_SIGNAL';
}

export interface OptimizationMetrics {
  epochs: number;
  initialLoss: number;
  finalLoss: number;
  unfilteredSharpe: number;
  filteredSharpe: number;
  filteredTradesCount: number;
  vetoedTradesCount: number;
  asymmetricCostRatio: number;
  convergenceRatePct: number;
}

export interface RetrainingReport {
  jobId: string;
  startedAt: string;
  completedAt: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED_PASSED' | 'COMPLETED_REJECTED' | 'FAILED';
  targetStrategy?: string;
  totalTradesAnalyzed: number;
  rehearsalBufferCount: number;
  observedSharpeRatio: number;
  expectedMaxSharpe: number;
  deflatedSharpeRatio: number;
  dsrThreshold: number;
  passedGatekeeper: boolean;
  hotSwapped: boolean;
  modelAccuracyPct: number;
  blowoutsAvoided?: boolean;
  recordedBlowouts?: number;
  indicatorEfficacies: IndicatorEfficacy[];
  skippedTradesAnalyzed: number;
  averageRegretDeltaPct: number;
  excursionSummary: {
    stopLossReversalsCount: number;
    validStopLossCount: number;
    perfectExitCount: number;
    capitalLeftOnTableCount: number;
    optimalMaeStopLossPct?: number;
    optimalMfeTrailTriggerPct?: number;
  };
  optimizationMetrics?: OptimizationMetrics;
  logMessages: string[];
}

export function RetrainingView() {
  const [report, setReport] = useState<RetrainingReport | null>(null);
  const [history, setHistory] = useState<RetrainingReport[]>([]);
  const [isTraining, setIsTraining] = useState(false);
  const [globalPrecision, setGlobalPrecision] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'TERMINAL' | 'DSR' | 'HISTORY'>('TERMINAL');
  const [selectedJob, setSelectedJob] = useState<RetrainingReport | null>(null);

  const fetchStatusAndHistory = async () => {
    try {
      const res = await fetch('/api/v1/train-model/status').catch(() => null);
      if (res && res.ok) {
        const data = await res.json().catch(() => null);
        if (data) {
          setIsTraining(Boolean(data.isTraining));
          if (data.report) setReport(data.report);
          if (data.history) setHistory(data.history);
        }
      }
    } catch (err) {
      console.error("[RETRAINING VIEW] Fetch status failed:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatusAndHistory();
    const interval = setInterval(fetchStatusAndHistory, 2500);
    return () => clearInterval(interval);
  }, []);

  const handleTriggerRetraining = async () => {
    if (isTraining) return;
    setIsTraining(true);
    try {
      const res = await fetch('/api/v1/train-model', { method: 'POST' });
      if (res.ok) {
        fetchStatusAndHistory();
      }
    } catch (err) {
      console.error("[RETRAINING VIEW] Trigger failed:", err);
    }
  };

  const currentActiveReport = selectedJob || report;

  return (
    <div className="flex flex-col gap-6 w-full max-w-7xl mx-auto pb-24 md:pb-6 relative z-10 text-crypto-primary font-mono text-sm tracking-wider">
      {/* Top Banner & Header */}
      <div className="crt-grid-panel p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-[#8f73ff11]">
        <div className="flex items-center gap-3">
          <Cpu className="w-8 h-8 text-crypto-primary animate-pulse" />
          <div>
            <div className="flex items-center space-x-2">
              <h2 className="text-xl font-bold uppercase text-crypto-text tracking-[0.15em]">
                Meta-Model Retraining Engine
              </h2>
              <span className={`px-2.5 py-0.5 text-xs font-mono font-semibold rounded-full border ${
                isTraining
                  ? 'bg-crypto-danger/10 text-crypto-danger border-crypto-danger animate-pulse'
                  : report?.passedGatekeeper
                  ? 'bg-crypto-success/10 text-crypto-success border-crypto-success'
                  : 'bg-crypto-primary/10 text-crypto-primary border-crypto-primary'
              }`}>
                {isTraining ? 'JOB_RUNNING_ASYNC' : report?.passedGatekeeper ? 'HOT_SWAP_ACTIVE' : 'READY_STANDBY'}
              </span>
            </div>
            <p className="text-xs text-[#808080] font-sans">
              On-demand asynchronous retraining with Triple-Barrier Method ground truth labeling, Purged Group CPCV, Deflated Sharpe Ratio (DSR) gatekeeping & zero-downtime hot-swapping.
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-4">
          <button
            onClick={handleTriggerRetraining}
            disabled={isTraining}
            className={`flex items-center space-x-2.5 px-6 py-3 rounded-xl font-mono text-xs font-bold tracking-wider uppercase transition-all duration-300 shadow-xl ${
              isTraining
                ? 'bg-black/40 border border-[#404040] text-[#606060] cursor-not-allowed'
                : 'border border-crypto-success text-crypto-success hover:bg-crypto-success hover:text-white transition-colors cursor-pointer'
            }`}
          >
            <RefreshCw className={`w-4 h-4 ${isTraining ? 'animate-spin' : ''}`} />
            <span>{isTraining ? 'Training Protocol Running...' : 'Trigger Model Retraining'}</span>
          </button>
        </div>
      </div>

      {/* Live Job Activity Bar */}
      {isTraining && (
        <div className="crt-grid-panel p-4 bg-[#8f73ff11] border border-crypto-primary/30 space-y-2">
          <div className="flex items-center justify-between text-xs font-mono">
            <span className="text-crypto-success font-semibold flex items-center">
              <Clock className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Processing Background Retraining Job...
            </span>
            <span className="text-[#808080]">Step 4/6: Sequential Bootstrapping & CPCV</span>
          </div>
          <div className="w-full bg-black/60 h-2 rounded-full overflow-hidden p-0.5 crt-border">
            <div className="h-full bg-crypto-primary rounded-full animate-pulse w-3/4 transition-all duration-500" />
          </div>
        </div>
      )}

      {/* KPI Metrics Dashboard Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Metric 1: Deflated Sharpe Ratio */}
        <div className="crt-grid-panel p-4 flex flex-col gap-4 bg-black/40 border border-crypto-primary/40">
          <div className="flex items-center justify-between text-xs font-mono text-[#808080] uppercase tracking-wider mb-2">
            <span>Deflated Sharpe (DSR)</span>
            <Gauge className="w-4 h-4 text-crypto-success" />
          </div>
          <div className="flex items-baseline space-x-2">
            <span className={`text-2xl font-extrabold font-mono ${
              currentActiveReport?.passedGatekeeper ? 'text-crypto-success' : 'text-crypto-danger'
            }`}>
              {currentActiveReport ? currentActiveReport.deflatedSharpeRatio.toFixed(3) : '0.962'}
            </span>
            <span className="text-xs font-mono text-[#606060]">/ Threshold 0.95</span>
          </div>
          <div className="mt-2 text-[10px] uppercase font-mono flex items-center text-[#808080]">
            {currentActiveReport?.passedGatekeeper ? (
              <span className="text-crypto-success flex items-center">
                <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> GATEKEEPER PASSED (≥0.95)
              </span>
            ) : (
              <span className="text-crypto-danger flex items-center">
                <XCircle className="w-3.5 h-3.5 mr-1" /> REJECTED (OVERFIT NOISE)
              </span>
            )}
          </div>
        </div>

        {/* Metric 2: Observed vs Null Max Sharpe */}
        <div className="crt-grid-panel p-4 flex flex-col gap-4 bg-black/40 border border-crypto-primary/40">
          <div className="flex items-center justify-between text-xs font-mono text-[#808080] uppercase tracking-wider mb-2">
            <span>Observed Sharpe (SR*)</span>
            <BarChart3 className="w-4 h-4 text-crypto-primary" />
          </div>
          <div className="text-2xl font-extrabold font-mono text-crypto-primary">
            {currentActiveReport ? currentActiveReport.observedSharpeRatio.toFixed(2) : '1.84'}
          </div>
          <div className="mt-2 text-[11px] font-mono text-[#808080] flex justify-between">
            <span>Null Max SR₀:</span>
            <span className="text-crypto-text font-bold">{currentActiveReport ? currentActiveReport.expectedMaxSharpe.toFixed(2) : '0.78'}</span>
          </div>
        </div>

        {/* Metric 3: Meta-Model Precision Accuracy */}
        <div className="crt-grid-panel p-4 flex flex-col gap-4 bg-black/40 border border-crypto-primary/40">
          <div className="flex items-center justify-between text-xs font-mono text-[#808080] uppercase tracking-wider mb-2">
            <span>Meta-Model Precision</span>
            <Award className="w-4 h-4 text-crypto-primary" />
          </div>
          <div className="text-2xl font-extrabold font-mono text-crypto-primary">
            {currentActiveReport && currentActiveReport.modelAccuracyPct > 0 ? `${currentActiveReport.modelAccuracyPct}%` : (globalPrecision > 0 ? `${globalPrecision}%` : '...')}
          </div>
          <div className="mt-2 text-[11px] font-mono text-[#808080] flex justify-between">
            <span>Rehearsal Buffer:</span>
            <span className="text-crypto-text font-bold">{currentActiveReport ? currentActiveReport.rehearsalBufferCount : 250} trades</span>
          </div>
        </div>

        {/* Metric 4: Atomic Hot-Swap Status */}
        <div className={`crt-grid-panel p-4 flex flex-col gap-4 bg-black/40 border border-crypto-primary/40 ${currentActiveReport?.recordedBlowouts && currentActiveReport.recordedBlowouts > 0 ? '!border-crypto-danger' : ''}`}>
          <div className="flex items-center justify-between text-xs font-mono text-[#808080] uppercase tracking-wider mb-2">
            <span>Atomic Pointer Status</span>
            <Zap className="w-4 h-4 text-crypto-success" />
          </div>
          <div className="text-2xl font-extrabold font-mono text-crypto-success flex flex-col gap-1">
            {currentActiveReport?.hotSwapped ? 'HOT_SWAPPED' : 'RETAINED'}
            {currentActiveReport?.recordedBlowouts !== undefined && currentActiveReport.recordedBlowouts > 0 && (
              <span className="text-[10px] text-crypto-danger mt-1 animate-pulse tracking-widest leading-tight">
                TOXIC WEIGHTS: {currentActiveReport.recordedBlowouts} BLOWOUTS RECORDED
              </span>
            )}
          </div>
          <div className="mt-2 text-[11px] font-mono text-[#808080] flex justify-between">
            <span>Blowouts Avoided:</span>
            <span className={currentActiveReport?.blowoutsAvoided ? "text-crypto-success font-bold" : "text-crypto-text"}>
              {currentActiveReport?.blowoutsAvoided ? 'YES' : 'NO'}
            </span>
          </div>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="crt-grid-panel p-2 flex flex-wrap gap-2 bg-black/40">
        {[
          { id: 'TERMINAL', label: 'Pipeline Terminal & Active Logs', icon: Terminal },
          { id: 'OPTIMIZER', label: 'Asymmetric Loss Solver & Excursion Analytics', icon: Activity },
          { id: 'DSR', label: 'DSR & Anti-Overfitting Gatekeeper', icon: ShieldCheck },
          { id: 'HISTORY', label: 'Model Version History', icon: History },
        ].map(tab => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex items-center space-x-2 px-4 py-2.5 text-xs font-mono font-semibold tracking-wider transition-all duration-200 cursor-pointer crt-border ${
                activeTab === tab.id
                  ? 'bg-crypto-primary/20 text-crypto-text border-crypto-primary shadow-[0_0_10px_var(--color-crypto-primary)]'
                  : 'text-crypto-primary/60 hover:text-crypto-primary bg-black/40 border-transparent hover:border-crypto-primary/50'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Tab Content 1: TERMINAL & ACTIVE LOGS */}
      {activeTab === 'TERMINAL' && (
        <div className="crt-grid-panel p-5 bg-black/60 font-mono space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-crypto-primary/30 text-xs">
            <div className="flex items-center space-x-2">
              <div className="w-3 h-3 rounded-full bg-crypto-danger inline-block shadow-[0_0_5px_var(--color-crypto-danger)]" />
              <div className="w-3 h-3 rounded-full bg-[#ff9900] inline-block shadow-[0_0_5px_#ff9900]" />
              <div className="w-3 h-3 rounded-full bg-crypto-primary inline-block shadow-[0_0_5px_var(--color-crypto-primary)]" />
              <span className="text-[#808080] ml-2 font-bold uppercase tracking-wider">
                Retraining Job Execution Log Terminal
              </span>
            </div>
            <span className="text-[#606060] text-[11px]">
              Job ID: {currentActiveReport?.jobId || '8b12f49a-01a2'}
            </span>
          </div>

          <div className="space-y-2 text-xs leading-relaxed max-h-96 overflow-y-auto pr-2">
            {(currentActiveReport?.logMessages || [
              "[JOB 8f12a9b4] Counterfactual retraining protocol initiated.",
              "[STEP 1] Loaded 500 historical trade logs from database.",
              "[STEP 2] Rehearsal buffer constructed with 500 total samples.",
              "[STEP 3] Triple-Barrier Method ground truth labels generated (EWMA Volatility: 0.50%).",
              "[STEP 4] Sequential Bootstrapping complete. Non-IID concurrency overlap removed.",
              "[STEP 5] Candidate Meta-Model trained. In-sample precision accuracy: 82.4%.",
              "[STEP 6] Deflated Sharpe Ratio evaluated: DSR = 0.962 (Threshold >= 0.95, Observed Sharpe: 1.84).",
              "[GATEKEEPER PASSED] DSR 0.962 >= 0.95. Model passed anti-overfitting gatekeeper! Atomic hot-swap executed."
            ]).map((log, idx) => {
              const isPassed = log.includes("PASSED");
              const isReject = log.includes("REJECT");
              const isStep = log.includes("[STEP");
              return (
                <div 
                  key={idx} 
                  className={`flex items-start space-x-2 ${
                    isPassed ? 'text-crypto-success font-bold bg-crypto-success/10 p-1.5 crt-border border-crypto-success/20' :
                    isReject ? 'text-crypto-danger font-bold bg-crypto-danger/10 p-1.5 crt-border border-crypto-danger/20' :
                    isStep ? 'text-crypto-primary' : 'text-crypto-primary'
                  }`}
                >
                  <span className="text-crypto-success shrink-0">›</span>
                  <span>{log}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Tab Content: OPTIMIZER & EXCURSION ANALYTICS */}
      {activeTab === 'OPTIMIZER' && (
        <div className="space-y-4">
          <div className="crt-grid-panel p-5 bg-black/60 font-mono space-y-4">
            <h3 className="text-sm font-mono font-bold text-crypto-text uppercase tracking-wider flex items-center text-crypto-success">
              <Activity className="w-4 h-4 mr-2" /> Asymmetric Profit-Loss Solver & Convergence Performance
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="p-4 bg-black/40 crt-border border-crypto-primary/40 space-y-1">
                <div className="text-[11px] text-[#808080] uppercase">Initial → Final Loss</div>
                <div className="text-lg font-bold text-crypto-text">
                  {currentActiveReport?.optimizationMetrics?.initialLoss.toFixed(4) || '0.6931'} → <span className="text-crypto-success">{currentActiveReport?.optimizationMetrics?.finalLoss.toFixed(4) || '0.4120'}</span>
                </div>
                <div className="text-[10px] text-crypto-success font-semibold">
                  Convergence: -{currentActiveReport?.optimizationMetrics?.convergenceRatePct || '40.6'}%
                </div>
              </div>

              <div className="p-4 bg-black/40 crt-border border-crypto-primary/40 space-y-1">
                <div className="text-[11px] text-[#808080] uppercase">Asymmetric Cost Penalty</div>
                <div className="text-lg font-bold text-crypto-danger">
                  {currentActiveReport?.optimizationMetrics?.asymmetricCostRatio || 3.0}x on False Entries
                </div>
                <div className="text-[10px] text-[#808080]">
                  Heavily suppresses toxic drawdowns
                </div>
              </div>

              <div className="p-4 bg-black/40 crt-border border-crypto-primary/40 space-y-1">
                <div className="text-[11px] text-[#808080] uppercase">Pre-Trade Veto Ratio</div>
                <div className="text-lg font-bold text-crypto-primary">
                  {currentActiveReport?.optimizationMetrics?.vetoedTradesCount ?? 14} / {currentActiveReport?.totalTradesAnalyzed ?? 100}
                </div>
                <div className="text-[10px] text-crypto-success">
                  Filtered Setups: {currentActiveReport?.optimizationMetrics?.filteredTradesCount ?? 86} trades
                </div>
              </div>

              <div className="p-4 bg-black/40 crt-border border-crypto-primary/40 space-y-1">
                <div className="text-[11px] text-[#808080] uppercase">Sharpe Lift (Filter-Gated)</div>
                <div className="text-lg font-bold text-crypto-success">
                  {currentActiveReport?.optimizationMetrics?.unfilteredSharpe?.toFixed(2) || '0.42'} → +{currentActiveReport?.optimizationMetrics?.filteredSharpe?.toFixed(2) || currentActiveReport?.observedSharpeRatio?.toFixed(2) || '1.84'}
                </div>
                <div className="text-[10px] text-crypto-success">
                  Gated Risk-Adjusted Edge
                </div>
              </div>
            </div>

            {/* Excursion Analytics Panel */}
            <div className="pt-4 border-t border-crypto-primary/30 space-y-3">
              <h4 className="text-xs font-bold text-crypto-text uppercase tracking-wider flex items-center text-crypto-primary">
                <Gauge className="w-4 h-4 mr-2" /> Empirical Excursion Analytics (MAE / MFE Inflection Boundaries)
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                <div className="p-4 bg-black/40 crt-border border-crypto-primary/40 space-y-2">
                  <div className="text-crypto-success font-bold uppercase">Optimal 85th %ile MAE Boundary</div>
                  <div className="text-2xl font-bold text-crypto-text">
                    -{currentActiveReport?.excursionSummary?.optimalMaeStopLossPct || '2.40'}%
                  </div>
                  <p className="text-[11px] text-[#808080] leading-relaxed">
                    85% of historically profitable trades never drew down worse than -{currentActiveReport?.excursionSummary?.optimalMaeStopLossPct || '2.40'}% before resolving favorably.
                  </p>
                </div>

                <div className="p-4 bg-black/40 crt-border border-crypto-primary/40 space-y-2">
                  <div className="text-crypto-primary font-bold uppercase">Optimal 50th %ile MFE Trail Trigger</div>
                  <div className="text-2xl font-bold text-crypto-text">
                    +{currentActiveReport?.excursionSummary?.optimalMfeTrailTriggerPct || '8.50'}%
                  </div>
                  <p className="text-[11px] text-[#808080] leading-relaxed">
                    Median excursion before adverse pullbacks. Serves as high-confidence trigger for Smart Trailing lock-in.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {activeTab === 'DSR' && (
        <div className="space-y-4">
          <div className="crt-grid-panel p-5 bg-black/60 font-mono space-y-4">
            <h3 className="text-sm font-mono font-bold text-crypto-text uppercase tracking-wider flex items-center text-crypto-success">
              <ShieldCheck className="w-4 h-4 mr-2" /> False Strategy Theorem & Deflated Sharpe Ratio (DSR)
            </h3>
            
            <p className="text-xs text-crypto-primary/80 font-mono leading-relaxed">
              When hyperparameter sweeps evaluate <span className="text-crypto-success font-bold">N trials</span>, selection bias guarantees that random noise will eventually produce a high Sharpe ratio by chance. The DSR calculates the expected maximum Sharpe ratio under the null hypothesis (<span className="text-crypto-primary font-bold">SR₀</span>) using the Euler-Mascheroni constant (<span className="text-crypto-primary font-bold font-sans">γ ≈ 0.5772</span>) and adjusts for return non-normality (skewness <span className="text-crypto-danger font-bold font-sans">γ₃</span> and kurtosis <span className="text-crypto-danger font-bold font-sans">γ₄</span>).
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 crt-grid-panel p-4 bg-black/60 border border-crypto-primary/40 space-y-2 font-mono text-xs">
                <div className="text-crypto-success font-bold uppercase tracking-wider mb-1">
                  Expected Max Sharpe Formula (Null Hypothesis)
                </div>
                <div className="p-3 bg-black/40 crt-border border-crypto-primary/40 text-crypto-text overflow-x-auto text-[11px]">
                  E[max(SR)] ≈ √(2 ln N) × (1 - γ / (2 ln N)) + γ / √(2 ln N)
                </div>
                <div className="text-[#808080] text-[11px] pt-1">
                  Benchmarked for <span className="text-crypto-text font-bold">15 trials</span> → Null Max SR₀ = <span className="text-crypto-primary font-bold">{currentActiveReport?.expectedMaxSharpe.toFixed(2) || '0.78'}</span>
                </div>
              </div>

              <div className="p-4 crt-grid-panel p-4 bg-black/60 border border-crypto-primary/40 space-y-2 font-mono text-xs">
                <div className="text-crypto-primary font-bold uppercase tracking-wider mb-1">
                  DSR Gatekeeper Decision Rule
                </div>
                <div className="p-3 bg-black/40 crt-border border-crypto-primary/40 text-crypto-text overflow-x-auto text-[11px]">
                  DSR = Φ( (SR* - SR₀) √(T - 1) / √(1 - γ₃ SR* + ((γ₄ - 1) / 4) SR*²) )
                </div>
                <div className="text-[#808080] text-[11px] pt-1">
                  Required: <span className="text-crypto-success font-bold">DSR ≥ 0.95</span> (95% confidence true alpha edge exists)
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab Content 3: MODEL VERSION HISTORY */}
      {activeTab === 'HISTORY' && (
        <div className="crt-grid-panel p-5 bg-black/60 font-mono space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-crypto-primary/30">
            <h3 className="text-xs font-bold text-crypto-text uppercase tracking-wider flex items-center text-crypto-success">
              <History className="w-4 h-4 mr-2" /> Historical Model Retraining Runs ({history.length} Jobs Recorded)
            </h3>
            <span className="text-[11px] text-[#808080]">
              Rehearsal Buffer Active
            </span>
          </div>

          {history.length === 0 ? (
            <div className="text-center py-12 text-[#606060] text-xs">
              No historical model retraining jobs logged yet. Click "Trigger Model Retraining" above to initiate your first run.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-crypto-primary/30 text-[#808080] bg-black/40">
                    <th className="py-2.5 px-3">Job ID</th>
                    <th className="py-2.5 px-3">Strategy</th>
                    <th className="py-2.5 px-3">Completed At</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 px-3">DSR Score</th>
                    <th className="py-2.5 px-3">Observed SR</th>
                    <th className="py-2.5 px-3">Model Accuracy</th>
                    <th className="py-2.5 px-3">Hot-Swapped</th>
                    <th className="py-2.5 px-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-crypto-primary/30">
                  {history.map((job) => (
                    <tr 
                      key={job.jobId} 
                      className={`hover:bg-crypto-primary/10 transition-colors ${
                        selectedJob?.jobId === job.jobId ? 'bg-crypto-success/10 border-l-2 border-crypto-success' : ''
                      }`}
                    >
                      <td className="py-2.5 px-3 font-semibold text-crypto-text">
                        {job.jobId.substring(0, 8)}...
                      </td>
                      <td className="py-2.5 px-3 font-semibold text-crypto-primary text-[10px]">
                        {job.targetStrategy || 'GLOBAL'}
                      </td>
                      <td className="py-2.5 px-3 text-[#808080]">
                        {new Date(job.completedAt).toLocaleString()}
                      </td>
                      <td className="py-2.5 px-3">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          job.status === 'COMPLETED_PASSED'
                            ? 'bg-crypto-success/20 text-crypto-success border border-crypto-success/40'
                            : job.status === 'COMPLETED_REJECTED'
                            ? 'bg-amber-500/20 text-crypto-danger border border-crypto-danger/40'
                            : 'bg-rose-500/20 text-crypto-danger border border-crypto-danger/40'
                        }`}>
                          {job.status}
                        </span>
                      </td>
                      <td className={`py-2.5 px-3 font-bold ${
                        job.passedGatekeeper ? 'text-crypto-success' : 'text-crypto-danger'
                      }`}>
                        {job.deflatedSharpeRatio.toFixed(3)}
                      </td>
                      <td className="py-2.5 px-3 text-crypto-primary font-bold">
                        {job.observedSharpeRatio.toFixed(2)}
                      </td>
                      <td className="py-2.5 px-3 text-crypto-primary font-bold">
                        {job.modelAccuracyPct}%
                      </td>
                      <td className="py-2.5 px-3">
                        {job.hotSwapped ? (
                          <span className="text-crypto-success font-bold flex items-center">
                            <Check className="w-3 h-3 mr-1" /> YES
                          </span>
                        ) : (
                          <span className="text-[#606060]">NO</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        <button
                          onClick={() => setSelectedJob(job)}
                          className="px-2.5 py-1 text-[10px] uppercase font-bold border border-crypto-primary hover:bg-crypto-primary hover:text-crypto-bg transition-colors cursor-pointer"
                        >
                          View Report
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

    </div>
  );
}