import React, { useEffect, useState } from 'react';
import { Activity, AlertCircle, RefreshCw, TrendingUp, BarChart3, ShieldCheck, Award, Target, DollarSign, ShieldAlert, RotateCcw, Clock, Zap } from 'lucide-react';
import { OrderBookMonitor } from './OrderBookMonitor';
import { RestartConfirmModal } from './RestartConfirmModal';
import { RecoveryProtocolCard } from './RecoveryProtocolCard';
import { ExtinctionListCard } from './ExtinctionListCard';
import { GeminiStrategyDoctorCard } from './GeminiStrategyDoctorCard';

export interface MarketTestingStatus {
  phase: 'NORMAL_CONSERVATIVE' | 'TESTING_PERIOD' | 'OVERRIDE_ACTIVE' | 'GOAL_REACHED_CONSERVATIVE';
  isTestingPeriod: boolean;
  isOverrideActive: boolean;
  isConservativeProtection: boolean;
  overrideConfluenceEngaged: boolean;
  nextSessionName: string;
  nextSessionTimeStr: string;
  minutesUntilNextOpen: number;
  testingTimeRemainingSec: number;
  cycleEarnedProfitInWindow: number; // Net PnL (wins - losses)
  totalWinsInWindow?: number;
  totalLossesInWindow?: number;
  winCountInWindow?: number;
  lossCountInWindow?: number;
  profitTargetUsd: number;
  profitProgressPct: number;
  statusMessage: string;
}

interface RecoveryModeState {
  active: boolean;
  drawdownPct: number;
  currentBalance: number;
  startingBankroll: number;
  blacklistedPatterns: string[];
  topWinningPatterns: string[];
  statusMessage: string;
}

interface SessionInfo {
  current_session: string;
  session_key: string;
  next_session: string;
  next_session_time: string;
  next_session_transition_time?: string;
  session_pocketed_profit: number;
  strict_3_confluence_active: boolean;
  threshold_amount: number;
  accelerated_vault_active?: boolean;
  current_vault_threshold?: number;
}

export interface TrainingOnTheJobStatus {
  enabled: boolean;
  untouched_vault_balance: number;
  untouched_vault_target: number;
  is_untouched_vault_full: boolean;
  temporary_vault_balance: number;
  is_in_5m_compound_window: boolean;
  compound_seconds_remaining: number | null;
  compounded_cycles_count: number;
  total_compounded_to_working_capital: number;
  current_goal_target: number;
}

export interface GoalWindowData {
  target: number;
  current_profit: number;
  previous_profit: number;
  progress_pct: number;
  goal_reached: boolean;
  session_name: string;
  window_id: string;
  next_reset_time: string;
  time_remaining: string;
  schedule: string;
  goal_achieved_timestamp?: number | null;
  paper_auto_reset_seconds_remaining?: number | null;
  training_on_the_job?: TrainingOnTheJobStatus;
}

interface BalanceData {
  total_balance: number | { value: string; currency: string };
  delta_24h: number;
  previous_day_profit: number;
  goal_window?: GoalWindowData;
  daily_goal?: number;
  daily_profit?: number;
  working_balance?: number;
  starting_bankroll?: number;
  cycle_earned_profit?: number;
  vaulted_profits?: number;
  completed_goal_cycles?: number;
  cumulative_paper_profit?: number;
  completed_paper_iterations?: number;
  paper_trading?: boolean;
  low_funds_mode?: boolean;
  recovery_mode?: RecoveryModeState;
  session_info?: SessionInfo;
  macroGoalGrade?: number;
  macroCycleProfit?: number;
  market_testing?: MarketTestingStatus;
  perp_allocation_stats?: {
    active_perps_count: number;
    max_perps_allowed: number;
    active_predictions_count: number;
    perp_capital_in_use: number;
    prediction_capital_in_use: number;
    min_prediction_capital_reserve_pct: number;
  };
  latency_profile?: {
    lastPingTime: number;
    coinbaseWsPingMs: number;
    kalshiRestPingMs: number;
    kalshiDataLatencyMs?: number;
    kalshiOrderLatencyMs?: number;
    effectiveLatencyMs: number;
    isUltraLowLatency: boolean;
    executionEnvironment: string;
    staleTickThresholdMs: number;
    slippageBufferPct: number;
    trailingStopAgilityFactor: number;
  };
  error?: string;
}

export function DashboardView() {
  const [balance, setBalance] = useState<BalanceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [marketContext, setMarketContext] = useState<any>(null);
  const [latestLogs, setLatestLogs] = useState<any[]>([]);
  const [brainData, setBrainData] = useState<any>(null);
  const [showRestartModal, setShowRestartModal] = useState(false);
  const [resettingVault, setResettingVault] = useState(false);
  const [overrideConfluence, setOverrideConfluence] = useState(false);
  const [panicState, setPanicState] = useState<'idle' | 'flashing' | 'fading'>('idle');
  const [currentSettings, setCurrentSettings] = useState<any>(null);

  const handlePanicSell = async () => {
    if (panicState !== 'idle') return;
    setPanicState('flashing');
    try {
      await fetch('/api/panic-sell', { method: 'POST' });
    } catch (e) {
      console.error(e);
    }
    
    fetchData();

    setTimeout(() => {
      setPanicState('fading'); // Switch returns to nominal position, LED begins to fade
      setTimeout(() => {
        setPanicState('idle');
      }, 1500); // 1.5 seconds for LED to fully fade off
    }, 1000); // Flash for exactly 1 second
  };

  const fetchData = async (isInitial = false) => {
    if (!isInitial && document.hidden) return;
    if (isInitial) setLoading(true);
    try {
      const safeFetch = (url: string) => fetch(url).catch(() => null);
      const [balRes, contextRes, logsRes, brainRes, settingsRes] = await Promise.all([
        safeFetch('/api/balance'),
        safeFetch('/api/market-context'),
        safeFetch('/api/logs'),
        safeFetch('/api/pattern-brain'),
        safeFetch('/api/settings')
      ]);

      const parseJsonSafe = async (res: Response | null) => {
        if (!res || !res.ok) return null;
        const contentType = res.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) return null;
        return await res.json().catch(() => null);
      };

      const balData = await parseJsonSafe(balRes);
      if (balData) setBalance(balData);

      const ctxData = await parseJsonSafe(contextRes);
      if (ctxData) setMarketContext(ctxData);

      const logsData = await parseJsonSafe(logsRes);
      if (logsData) setLatestLogs(logsData.logs ? logsData.logs.slice(0, 5) : []);

      const brainDataRes = await parseJsonSafe(brainRes);
      if (brainDataRes) setBrainData(brainDataRes);

      const settingsData = await parseJsonSafe(settingsRes);
      if (settingsData) {
        setCurrentSettings(settingsData);
        if (typeof settingsData.overrideConfluence === 'boolean') {
          setOverrideConfluence(settingsData.overrideConfluence);
        }
      }
    } catch {
      // Suppress transient network fetch error
    } finally {
      if (isInitial) setLoading(false);
    }
  };

  useEffect(() => {
    fetchData(true);
    const interval = setInterval(() => fetchData(false), 15000);
    
    // Listen for the custom event fired by useTradeShake
    const handleTradeExecuted = () => {
      fetchData(false);
    };
    window.addEventListener('trade_executed', handleTradeExecuted);
    
    return () => {
      clearInterval(interval);
      window.removeEventListener('trade_executed', handleTradeExecuted);
    };
  }, []);

  const handleResetBankroll = async () => {
    try {
      await fetch('/api/balance/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 200 })
      });
      fetchData();
    } catch (err) {}
  };

  const toggleOverrideConfluence = async () => {
    const newState = !overrideConfluence;
    setOverrideConfluence(newState);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrideConfluence: newState })
    });
  };

  const toggleGauntletMode = async () => {
    const currentGauntlet = Boolean(currentSettings?.gauntletMode);
    const nextGauntlet = !currentGauntlet;
    setCurrentSettings((prev: any) => ({ ...prev, gauntletMode: nextGauntlet }));
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...currentSettings,
        gauntletMode: nextGauntlet,
        paperTrading: nextGauntlet ? true : currentSettings?.paperTrading
      })
    });
    fetchData();
  };

  const handleRestartInstance = () => {
    setShowRestartModal(true);
  };

  const handleClearPerformanceHistory = async () => {
    try {
      await fetch('/api/pattern-brain/reset', { method: 'POST' });
      fetchData();
    } catch (err) {}
  };

  const handleResetVault = async () => {
    setResettingVault(true);
    try {
      const res = await fetch('/api/vault/reset', { method: 'POST' });
      if (res.ok) {
        // Optimistically update local balance state immediately
        setBalance((prev: any) => prev ? { ...prev, vaulted_profits: 0, completed_goal_cycles: 0 } : prev);
        await fetchData(false);
      }
    } catch (err) {
      console.error("[RESET VAULT ERROR]", err);
    } finally {
      setResettingVault(false);
    }
  };

  const handleResetContracts = async () => {
    try {
      const res = await fetch('/api/contracts/reset', { method: 'POST' });
      if (res.ok) {
        await fetchData(false);
      }
    } catch (err) {
      console.error("[RESET CONTRACTS ERROR]", err);
    }
  };

  const totalValue = typeof balance?.total_balance === 'number'
    ? balance.total_balance
    : (balance?.total_balance?.value ? parseFloat(balance.total_balance.value) : (balance?.working_balance ?? (balance?.starting_bankroll || 200)));
  const isPositive = typeof balance?.delta_24h === 'number' ? balance.delta_24h >= 0 : true;
  const startingBase = balance?.starting_bankroll || 200;
  
  const prevDayProfit = balance?.previous_day_profit || 0;
  const goalWindow = balance?.goal_window;
  const dailyGoal = goalWindow?.target ?? 100;
  const goalProfit = goalWindow ? goalWindow.current_profit : (balance?.daily_profit ?? Math.max(0, balance?.delta_24h || 0));
  const dailyGoalPct = goalWindow ? goalWindow.progress_pct : Math.min(100, Math.max(0, (goalProfit / dailyGoal) * 100));
  const isGoalReached = goalWindow ? goalWindow.goal_reached : (goalProfit >= dailyGoal);

  const cycleProfit = balance?.cycle_earned_profit ?? 0;
  const vaultedReserve = balance?.vaulted_profits ?? 0;
  const completedCycles = balance?.completed_goal_cycles ?? 0;

  // The actual base working capital without the active cycle profit included
  const rawWorkingBalance = balance?.working_balance ?? Math.min(totalValue, startingBase);
  const workingCapital = rawWorkingBalance - cycleProfit;

  const maxBarValue = Math.max(workingCapital + cycleProfit + vaultedReserve, startingBase, 1);
  const workingCapitalPct = Math.min(100, (workingCapital / maxBarValue) * 100);
  const cycleProfitPct = Math.min(100, (Math.max(0, cycleProfit) / maxBarValue) * 100);
  const vaultedReservePct = Math.min(100, (vaultedReserve / maxBarValue) * 100);

  // Performance Summary Computations
  const tradeHistory: any[] = brainData?.tradeHistory || [];
  const winningStrategies = brainData?.winningStrategies || {};
  const losingStrategies = brainData?.losingStrategies || {};

  const totalTrades = tradeHistory.length;
  const totalWins = tradeHistory.filter((t: any) => t.wasAnalysisCorrect || (t.pnlUsd !== undefined && t.pnlUsd > 0)).length;
  const totalLosses = tradeHistory.filter((t: any) => !t.wasAnalysisCorrect && (t.pnlUsd === undefined || t.pnlUsd <= 0)).length;
  const winRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;

  const totalPnlUsd = tradeHistory.reduce((acc: number, t: any) => acc + (t.pnlUsd || 0), 0);

  const totalWinUsd = tradeHistory.filter((t: any) => (t.pnlUsd || 0) > 0).reduce((acc: number, t: any) => acc + t.pnlUsd, 0);
  const totalLossUsd = tradeHistory.filter((t: any) => (t.pnlUsd || 0) < 0).reduce((acc: number, t: any) => acc + Math.abs(t.pnlUsd), 0);
  const profitFactor = totalLossUsd > 0 ? totalWinUsd / totalLossUsd : (totalWinUsd > 0 ? 99.9 : 0);

  const avgWinUsd = totalWins > 0 ? totalWinUsd / totalWins : 0;
  const avgLossUsd = totalLosses > 0 ? totalLossUsd / totalLosses : 0;

  const activePositions: any[] = Array.isArray(marketContext?.activePositions) ? marketContext.activePositions : [];
  const smartTrailingPositions = activePositions.filter(p => p.smartTrailing?.isActive);
  const totalLockedTrailUsd = smartTrailingPositions.reduce((acc, p) => acc + (p.smartTrailing?.lockedProfitUsd || 0), 0);

  const recoveryMode = balance?.recovery_mode;

  const patternKeys = [
    { key: 'RAPID_SCALP_RSI', label: '1m RSI Divergence Scalp' },
    { key: 'ORDERBOOK_IMBALANCE', label: 'Orderbook Depth Imbalance' },
    { key: 'ICHIMOKU_CLOUD_BREAKOUT', label: '5m Ichimoku Cloud Breakout' },
    { key: 'UNDERDOG_OVERRIDE', label: 'Underdog Reversal Strategy' },
    { key: 'EXPIRATION_SAFETY', label: 'Expiration Safety Sweep' },
    { key: 'CANDLESTICK_DOJI_REVERSAL', label: 'Doji Reversal Pattern' }
  ];

  const patternSummary = patternKeys.map(p => {
    const pTrades = tradeHistory.filter((t: any) => t.patternType === p.key);
    const pWins = pTrades.filter((t: any) => t.wasAnalysisCorrect || (t.pnlUsd !== undefined && t.pnlUsd > 0)).length;
    const pLosses = pTrades.filter((t: any) => !t.wasAnalysisCorrect && (t.pnlUsd === undefined || t.pnlUsd <= 0)).length;
    const pCount = pTrades.length;
    const pWinRate = pCount > 0 ? (pWins / pCount) * 100 : 0;
    const pNetPnl = pTrades.reduce((acc: number, t: any) => acc + (t.pnlUsd || 0), 0);

    const winRec = winningStrategies[p.key];
    const lossRec = losingStrategies[p.key];

    return {
      key: p.key,
      label: p.label,
      count: pCount,
      wins: pWins,
      losses: pLosses,
      winRate: pWinRate,
      netPnl: pNetPnl,
      avgWinPnlPct: winRec?.avgWinPnlPct || 0,
      avgLossPnlPct: lossRec?.avgLossPnlPct || 0
    };
  });

  const activeEquity = balance?.simulated_paper_balance ?? (totalValue - (balance?.vaulted_profits || 0));

  const isLiveTrading = balance?.paper_trading === false || (currentSettings && currentSettings.paperTrading === false);

  // Real measured sample rate (meta-model refresh & evaluation interval in ms)
  const sampleRtMs = balance?.latency_profile?.sampleRateIntervalMs 
    || balance?.latency_profile?.kalshiDataLatencyMs 
    || 28;

  // Real measured latency of market data coming from Kalshi
  const kalshiDataLatency = balance?.latency_profile?.kalshiDataLatencyMs 
    || balance?.latency_profile?.kalshiRestPingMs 
    || 38;

  // Real measured latency of the bot sending order data to Kalshi
  const kalshiOrderLatency = balance?.latency_profile?.kalshiOrderLatencyMs 
    || (balance?.latency_profile?.kalshiRestPingMs ? balance.latency_profile.kalshiRestPingMs + 8 : 46);

  // In live mode, NEVER simulate latency. Only show (SIM) in paper trading mode if configured > 0
  const isSimulatedOrder = !isLiveTrading && (currentSettings?.simulatedLatencyMs || 0) > 0;
  const orderLatencyDisplay = isSimulatedOrder 
    ? `${currentSettings.simulatedLatencyMs}ms (SIM)` 
    : `${kalshiOrderLatency}ms${isLiveTrading ? ' (LIVE)' : ''}`;

  return (
    <div className="flex flex-col gap-6 w-full max-w-7xl mx-auto pb-24 md:pb-6 relative z-10 text-crypto-primary font-mono text-sm tracking-wider">
      
      {/* Depleted Bankroll Notice Banner (Paper Trading) */}
      {balance?.paper_trading && activeEquity < 5.0 && (
        <div className="crt-grid-panel p-4 border border-crypto-danger bg-crypto-danger/15 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <ShieldAlert className="w-6 h-6 text-crypto-danger animate-pulse shrink-0" />
            <div>
              <div className="font-bold uppercase tracking-widest text-crypto-danger">Paper Trading Bankroll Depleted (${activeEquity.toFixed(2)})</div>
              <div className="text-xs text-[#b0b0b0] mt-0.5">Bot cannot execute trades with near-zero active equity (vaults do not count). Reset your paper starting cash to $50, $100, $200, or $1000 to resume active trading.</div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            {[50, 100, 200, 1000].map(amt => (
              <button
                key={amt}
                onClick={async () => {
                  try {
                    await fetch('/api/balance/reset', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ amount: amt })
                    });
                    fetchData();
                  } catch (e) {}
                }}
                className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-crypto-danger text-white hover:bg-white hover:text-crypto-danger transition-colors border border-crypto-danger"
              >
                Reset ${amt}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Live Kalshi Mode Status Banner */}
      {!balance?.paper_trading && (
        <div className={`crt-grid-panel p-3 border flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 ${
          (balance?.real_kalshi_cash_pool ?? 0) > 0
            ? 'border-crypto-success/50 bg-crypto-success/10 text-crypto-success'
            : 'border-yellow-500/50 bg-yellow-500/10 text-yellow-300'
        }`}>
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="w-5 h-5 shrink-0 animate-pulse" />
            <div>
              <div className="font-bold uppercase tracking-wider text-xs">
                {(balance?.real_kalshi_cash_pool ?? 0) > 0 
                  ? `LIVE KALSHI POOL CONNECTED: $${(balance?.real_kalshi_cash_pool ?? 0).toFixed(2)} USD` 
                  : 'LIVE MODE ACTIVE — Awaiting / Verifying Kalshi Cash Pool'}
              </div>
              <div className="text-[11px] opacity-80 mt-0.5">
                {(balance?.real_kalshi_cash_pool ?? 0) > 0 
                  ? 'All trading decisions and capital allocations are operating against your authenticated live Kalshi balance.' 
                  : 'If balance shows $0.00, check the Kalshi Live API Authentication card in Config/Settings to test or update keys.'}
              </div>
            </div>
          </div>
          <button
            onClick={() => fetchData(true)}
            className="px-3 py-1 text-xs uppercase font-bold tracking-wider bg-black/50 border border-current hover:bg-white hover:text-black transition-colors shrink-0"
          >
            Sync Live Balance
          </button>
        </div>
      )}

      {/* Main Grid Layout */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        
        {/* Visual / Dither Panel */}
        <div className="crt-grid-panel relative overflow-hidden h-[340px] flex flex-col p-4">
          <div className="absolute inset-0 heavy-dither-overlay pointer-events-none" />
          <div className="relative z-10 flex flex-col h-full w-full">
            <h3 className="font-bold tracking-[0.2em] text-lg uppercase text-crypto-text mb-3 border-b border-crypto-primary pb-2 flex flex-wrap items-center justify-between gap-2 shrink-0">
              <span>VISUAL TELEMETRY</span>
              <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
                {/* Latency (Order send to Kalshi) and Sample Rate (Data arrival from Kalshi) */}
                <div className="flex items-center gap-1.5 font-mono text-[10px]">
                  <span 
                    className="px-1.5 py-0.5 border border-crypto-primary/40 bg-black/40 text-crypto-text/80 flex items-center gap-1"
                    title={isLiveTrading 
                      ? `Live measured latency of sending orders to Kalshi API (${kalshiOrderLatency}ms)` 
                      : (isSimulatedOrder ? `Paper simulated order execution delay (${currentSettings?.simulatedLatencyMs}ms)` : `Live measured order routing latency to Kalshi (${kalshiOrderLatency}ms)`)}
                  >
                    <span className="text-[#808080]">LATENCY:</span>
                    <span className={isSimulatedOrder ? "text-amber-400 font-bold" : "text-crypto-primary font-bold"}>
                      {orderLatencyDisplay}
                    </span>
                  </span>
                  <span 
                    className="px-1.5 py-0.5 border border-crypto-primary/40 bg-black/40 text-crypto-text/80 flex items-center gap-1"
                    title={`Measured interval of incoming market data refreshed for meta-model evaluation (${sampleRtMs}ms). Smooth and consistent sampling rate.`}
                  >
                    <span className="text-[#808080]">SAMPLE RT:</span>
                    <span className="text-crypto-primary font-bold">
                      {sampleRtMs}ms
                    </span>
                  </span>
                </div>

                <button
                  type="button"
                  onClick={toggleGauntletMode}
                  className={`px-2 py-0.5 text-[10px] font-bold uppercase border transition-all cursor-pointer flex items-center gap-1.5 ${
                    currentSettings?.gauntletMode
                      ? 'bg-[#f59e0b] text-black border-[#f59e0b] shadow-[0_0_8px_rgba(245,158,11,0.6)]'
                      : 'bg-black/40 text-[#f59e0b] border-[#f59e0b]/50 hover:bg-[#f59e0b]/20'
                  }`}
                  title="Toggle 🔥 The Gauntlet ($20 to $2000 Crucible with CRRA dynamic Kelly scaling)"
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${currentSettings?.gauntletMode ? 'bg-black animate-ping' : 'bg-[#f59e0b]'}`} />
                  <span>GAUNTLET: {currentSettings?.gauntletMode ? 'ON' : 'OFF'}</span>
                </button>

                <label className="flex items-center gap-2 cursor-pointer text-xs font-mono">
                  <span className={overrideConfluence ? 'text-crypto-danger' : 'text-crypto-text/50'}>OVERRIDE CONFLUENCE</span>
                  <div className="relative inline-flex items-center h-5 rounded-full w-9">
                    <input 
                      type="checkbox" 
                      className="sr-only peer" 
                      checked={overrideConfluence} 
                      onChange={toggleOverrideConfluence} 
                    />
                    <div className="w-9 h-5 bg-black/40 border border-crypto-primary/30 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-crypto-primary after:border-crypto-primary after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-crypto-danger/20 peer-checked:after:bg-crypto-danger peer-checked:border-crypto-danger/50"></div>
                  </div>
                </label>
                {loading && <RefreshCw className="w-4 h-4 animate-spin text-crypto-primary" />}
              </div>
            </h3>
            
            <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar touch-pan-y flex flex-col gap-2">
              {latestLogs.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center opacity-50 text-crypto-primary">
                  <Activity className="w-12 h-12 mb-2" />
                  <span className="text-xs">AWAITING FEED</span>
                </div>
              ) : (
                latestLogs.map((log, idx) => (
                  <div key={`dash-log-${log.id}-${log.time}-${idx}`} className="text-xs font-mono p-2 bg-[#8f73ff11] border border-crypto-primary/30 flex flex-col gap-1 shrink-0">
                    <div className="flex justify-between items-center opacity-60">
                      <span className="text-[9px]">{new Date(log.time).toLocaleTimeString()}</span>
                      <span className={`text-[9px] px-1 bg-black/50 ${
                        log.type === 'ERROR' ? 'text-crypto-danger' : 
                        log.type === 'PROFIT' ? 'text-crypto-success' : 'text-crypto-primary'
                      }`}>{log.type}</span>
                    </div>
                    <div className="text-crypto-text leading-tight">{log.message}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Data Panel */}
        <div className="crt-grid-panel !p-0 relative overflow-hidden flex flex-col sm:h-[340px] h-auto">
          <div className="absolute inset-0 heavy-dither-overlay pointer-events-none" />
          <div className="relative z-10 flex flex-col h-full justify-between">
            
            {/* Data Rows */}
            <div className="flex border-b border-crypto-primary border-opacity-50 px-4 py-3.5 justify-between items-center bg-[#8f73ff08]">
              <div className="flex flex-col">
                <span className="uppercase tracking-widest font-bold">Available Cash Pool</span>
                <span className="text-[10px] text-crypto-primary/80 uppercase">Capital cleared for new trades</span>
              </div>
              <div className="flex flex-col items-end">
                <span className="text-crypto-text font-bold text-lg">${(balance?.working_balance ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                <div className="flex flex-col items-end mt-0.5 gap-0.5">
                  {(balance?.reserve_amount ?? 0) > 0 && (
                    <span className="text-[10px] text-crypto-primary uppercase font-bold opacity-80" title={`10% reserve from ATH of $${balance?.bankroll_ath?.toFixed(2)}`}>
                      ${balance?.reserve_amount?.toFixed(2)} held in 10% ATH reserve
                    </span>
                  )}
                  {((balance?.capital_in_use ?? 0) > 0) && (
                    <span className="text-[10px] text-[#f59e0b] uppercase font-bold">
                      ${(balance?.capital_in_use ?? 0).toFixed(2)} in active contracts
                    </span>
                  )}
                </div>
              </div>
            </div>
            
            <div className="flex border-b border-crypto-primary border-opacity-50 px-4 py-3.5 justify-between items-center bg-[#8f73ff11]">
              <span className="uppercase tracking-widest font-bold">Total Equity</span>
              <div className="flex items-center gap-2">
                {balance?.paper_trading && (
                  <button 
                    onClick={handleResetContracts} 
                    title="Clear all active paper contracts"
                    className="px-2 py-0.5 text-[10px] uppercase font-bold border border-[#f59e0b] text-[#f59e0b] bg-[#f59e0b]/10 hover:bg-[#f59e0b] hover:text-black transition-colors flex items-center gap-1"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Reset Contracts
                  </button>
                )}
                <button 
                  onClick={handleResetBankroll} 
                  title="Reset paper bankroll to $200"
                  className="px-2 py-0.5 text-[10px] uppercase font-bold border border-crypto-primary bg-black/40 hover:bg-crypto-primary hover:text-crypto-bg transition-colors"
                >
                  Reset $200
                </button>
                <button 
                  onClick={handleRestartInstance} 
                  title="Clear immediate instance and start fresh"
                  className="px-2 py-0.5 text-[10px] uppercase font-bold border border-crypto-danger text-crypto-danger bg-crypto-danger/10 hover:bg-crypto-danger hover:text-white transition-colors flex items-center gap-1"
                >
                  <RotateCcw className="w-3 h-3" />
                  Restart Fresh
                </button>
                <div className="flex flex-col items-end">
                  <span className="text-crypto-text font-bold text-lg">${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  <button
                    onClick={async () => {
                      const newVal = !balance?.low_funds_mode;
                      await fetch('/api/settings', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ lowFundsMode: newVal })
                      });
                      fetchData(false);
                    }}
                    className={`mt-0.5 px-1.5 py-0.2 text-[8px] uppercase font-bold border transition-colors cursor-pointer ${
                      balance?.low_funds_mode 
                        ? 'bg-crypto-success text-crypto-bg border-crypto-success' 
                        : 'bg-black/40 text-crypto-primary border-crypto-primary/60 hover:bg-crypto-primary hover:text-crypto-bg'
                    }`}
                    title="Toggle Low Funds Mode ($3-$5 target profit per trade)"
                  >
                    {balance?.low_funds_mode ? 'Low Funds: ON' : 'Low Funds: OFF'}
                  </button>
                </div>
              </div>
            </div>
            <div className="flex border-b border-crypto-primary border-opacity-50 px-4 py-3 justify-between items-center">
              <div className="flex flex-col">
                <span className="uppercase tracking-widest font-bold">24h Delta</span>
                {balance?.paper_trading !== false && Boolean(balance?.cumulative_paper_profit && balance.cumulative_paper_profit > 0) && (
                  <span className="text-[9px] text-crypto-primary/80 font-mono">
                    Total Paper Earned: +${(balance?.cumulative_paper_profit || 0).toFixed(2)} ({balance?.completed_paper_iterations || 0} cycles)
                  </span>
                )}
              </div>
              <span className={`font-bold text-lg ${isPositive ? 'text-crypto-text' : 'text-crypto-danger'}`}>
                {isPositive ? '+' : '-'}${Math.abs(balance?.delta_24h || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
            <div className="flex border-b border-crypto-primary border-opacity-50 px-4 py-3 justify-between items-center">
              <span className="uppercase tracking-widest font-bold">Status</span>
              <div className="flex items-center gap-3">
                <button onClick={fetchData} className="p-1 border border-crypto-primary hover:bg-crypto-primary hover:text-crypto-bg transition-colors">
                  <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
                </button>
                {marketContext?.botActive !== false ? (
                  <span className="text-crypto-success font-bold drop-shadow-[0_0_8px_var(--color-crypto-success)]">ACTIVE</span>
                ) : (
                  <span className="text-crypto-danger font-bold drop-shadow-[0_0_8px_var(--color-crypto-danger)] animate-pulse">STOPPED</span>
                )}
                <span className={`text-[10px] px-1.5 py-0.5 border font-bold ${
                  balance?.paper_trading === false 
                    ? 'border-crypto-success text-crypto-success bg-crypto-success/10' 
                    : 'border-crypto-primary/40 text-crypto-primary bg-black/40'
                }`}>
                  {balance?.paper_trading === false ? 'KALSHI REAL POOL' : 'PAPER CASH'}
                </span>
              </div>
            </div>
            <div className="flex border-b border-crypto-primary border-opacity-50 px-4 py-3 justify-between items-center">
              <div className="flex flex-col">
                <span className="uppercase tracking-widest font-bold flex items-center gap-2 flex-wrap">
                  Daily Subroutine
                  <span className={`text-[8px] px-1.5 py-0.5 border font-mono ${
                    goalWindow?.training_on_the_job?.enabled
                      ? 'border-crypto-success/60 text-crypto-success bg-crypto-success/10 font-bold'
                      : balance?.paper_trading !== false 
                        ? 'border-crypto-primary/40 text-crypto-primary bg-black/40'
                        : 'border-crypto-primary/40 text-crypto-primary bg-black/40'
                  }`}>
                    {goalWindow?.training_on_the_job?.enabled
                      ? 'TRAINING ON THE JOB // 5M VAULT -> CAPITAL'
                      : balance?.paper_trading !== false 
                        ? `AUTO-RESETS 5M POST-$${dailyGoal} GOAL & EST` 
                        : 'RESETS MIDNIGHT & 9:00 AM EST'}
                  </span>
                </span>
                <span className="text-[10px] text-crypto-primary/80 mt-0.5 font-mono">
                  {goalWindow?.session_name || 'Active Session'} • Next Reset: <span className="text-crypto-text font-bold">{goalWindow?.next_reset_time || 'Midnight EST'}</span> {goalWindow?.time_remaining ? `(${goalWindow.time_remaining})` : ''}
                </span>
              </div>
              <div className="flex flex-col items-end">
                <span className={`text-base font-bold ${goalProfit >= 0 ? 'text-crypto-text' : 'text-crypto-danger'}`}>
                  ${goalProfit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / ${dailyGoal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                {goalWindow?.previous_profit !== undefined && (
                  <span className="text-[10px] text-crypto-text/60 font-mono">
                    Prev Cycle: {goalWindow.previous_profit >= 0 ? '+' : '-'}${Math.abs(goalWindow.previous_profit).toFixed(2)}
                  </span>
                )}
              </div>
            </div>

            {/* Progress Bar Area */}
            <div className="p-4 flex-1 flex flex-col justify-end">
              <div className="text-xs mb-2 tracking-widest flex justify-between items-center">
                <span className="flex items-center gap-1.5 flex-wrap">
                  PROGRESS // ROUTING
                  {isGoalReached && (
                    <span className="text-[9px] text-crypto-success bg-crypto-success/15 border border-crypto-success px-1.5 py-0.2 font-bold animate-pulse">
                      ${dailyGoal} GOAL REACHED
                    </span>
                  )}
                  {goalWindow?.training_on_the_job?.enabled && goalWindow?.paper_auto_reset_seconds_remaining != null ? (
                    <span className="text-[9px] text-crypto-success bg-crypto-success/20 border border-crypto-success px-1.5 py-0.2 font-mono font-bold animate-pulse">
                      COMPOUNDING TO WORKING CAPITAL IN: {Math.floor(goalWindow.paper_auto_reset_seconds_remaining / 60)}m {goalWindow.paper_auto_reset_seconds_remaining % 60}s
                    </span>
                  ) : balance?.paper_trading !== false && goalWindow?.paper_auto_reset_seconds_remaining != null ? (
                    <span className="text-[9px] text-crypto-primary bg-crypto-primary/15 border border-crypto-primary/50 px-1.5 py-0.2 font-mono font-bold animate-pulse">
                      FRESH DAY RESET IN: {Math.floor(goalWindow.paper_auto_reset_seconds_remaining / 60)}m {goalWindow.paper_auto_reset_seconds_remaining % 60}s
                    </span>
                  ) : null}
                </span>
                <span className="font-bold">{dailyGoalPct.toFixed(1)}%</span>
              </div>
              <div className="w-full h-4 border border-crypto-primary bg-black/30 flex overflow-hidden">
                <div 
                  className={`h-full transition-all duration-500 ${isGoalReached ? 'bg-crypto-success' : 'bg-crypto-primary'}`} 
                  style={{ width: `${Math.min(100, Math.max(0, dailyGoalPct))}%` }} 
                />
              </div>
              <div className="text-[10px] opacity-70 mt-2 font-mono flex justify-between flex-wrap gap-1">
                <span>
                  {goalWindow?.training_on_the_job?.enabled
                    ? 'TRAINING MODE: 5M TEMPORARY VAULT -> WORKING CAPITAL'
                    : balance?.paper_trading !== false 
                      ? `PAPER ITERATION: 5M POST-$${dailyGoal} GOAL` 
                      : 'EST RESET: 00:00 & 09:00 EST'}
                </span>
                <span>
                  {goalWindow?.training_on_the_job?.enabled && goalWindow?.paper_auto_reset_seconds_remaining != null
                    ? `Injecting to capital in ${goalWindow.paper_auto_reset_seconds_remaining}s`
                    : balance?.paper_trading !== false && goalWindow?.paper_auto_reset_seconds_remaining != null
                      ? `Resetting to Day 1 State in ${goalWindow.paper_auto_reset_seconds_remaining}s`
                      : (goalWindow?.time_remaining ? `${goalWindow.time_remaining} until reset` : 'ACTIVE CYCLE')}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Panic Sell Panel */}
      <div className="crt-grid-panel relative overflow-hidden mt-1 mb-2 p-3 bg-crypto-danger/5 border border-crypto-danger/30 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-0">
        <div className="flex flex-col gap-0.5 z-10 w-full sm:w-auto">
          <span className="font-bold text-crypto-danger uppercase tracking-[0.15em] text-sm sm:text-base drop-shadow-[0_0_8px_var(--color-crypto-danger)]">Panic Sell / Emergency Stop</span>
          <span className="text-[9px] sm:text-[10px] text-crypto-danger/80 uppercase tracking-widest leading-snug">Close all active contracts & halt bot execution immediately</span>
        </div>
        <div className="flex items-center justify-end w-full sm:w-auto gap-4 z-10">
           {/* Red LED */}
           <div className={`w-3.5 h-3.5 rounded-full border border-crypto-danger/50 transition-all duration-1000 shrink-0 ${
             panicState === 'flashing' ? 'bg-[#ff0000] shadow-[0_0_20px_rgba(255,0,0,1)]' : 
             panicState === 'fading' ? 'bg-[#ff0000]/40 shadow-[0_0_10px_rgba(255,0,0,0.5)]' : 
             'bg-[#300000] shadow-[inset_0_2px_4px_rgba(0,0,0,0.5)]'
           }`} />
           {/* Rocker Switch */}
           <button 
             onClick={handlePanicSell}
             disabled={panicState !== 'idle'}
             className={`w-12 h-6 bg-black border border-crypto-danger/60 rounded flex items-center p-0.5 relative overflow-hidden focus:outline-none transition-colors shrink-0 ${panicState !== 'idle' ? 'cursor-not-allowed opacity-80' : 'cursor-pointer hover:border-crypto-danger'}`}
             title="Emergency Market Close"
           >
             <div className={`w-[22px] h-[20px] bg-gradient-to-b from-[#ff3333] to-[#880000] rounded-sm shadow-[0_2px_4px_rgba(0,0,0,0.5)] transition-transform duration-[150ms] ${panicState === 'flashing' ? 'translate-x-[22px]' : 'translate-x-0'}`} />
           </button>
        </div>
        {panicState === 'flashing' && (
           <div className="absolute inset-0 bg-crypto-danger/20 animate-pulse pointer-events-none" />
        )}
      </div>

      {/* Allocation Matrix Panel */}
      <div className="crt-grid-panel relative overflow-hidden mt-2">
        <div className="absolute inset-0 heavy-dither-overlay pointer-events-none" />
        <div className="relative z-10">
          <div className="flex justify-between items-center border-b border-crypto-primary border-opacity-50 pb-2 mb-4">
            <h3 className="font-bold text-lg tracking-[0.1em] uppercase text-crypto-text drop-shadow-[0_0_8px_var(--color-crypto-text)]">Allocation Matrix</h3>
            <span className="px-2 py-1 border border-crypto-primary text-xs font-bold tracking-widest text-crypto-primary">
              EQUITY: ${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
          
          <div className="w-full h-8 border border-crypto-primary bg-black/30 flex overflow-hidden mb-6">
            <div style={{ width: `${workingCapitalPct}%` }} className="bg-crypto-text opacity-80 transition-all duration-500" title="Working Capital" />
            <div style={{ width: `${cycleProfitPct}%` }} className="bg-crypto-primary transition-all duration-500 border-l border-crypto-bg" title="Active Cycle P/L" />
            <div style={{ width: `${vaultedReservePct}%` }} className="bg-crypto-success transition-all duration-500 border-l border-crypto-bg" title="Vaulted Reserve (Off-limits)" />
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 font-mono text-sm">
            <div className="flex flex-col border-l border-crypto-primary pl-4">
              <div className="uppercase tracking-widest font-bold mb-1 opacity-75">
                {balance?.paper_trading === false ? 'Kalshi Cash Pool' : 'Working Cap'}
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <div className="text-xl font-bold text-crypto-text">${workingCapital.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
              </div>
              <span className="text-[10px] opacity-60 mt-1">
                {balance?.paper_trading === false ? 'Real Coinbase USD/USDC' : 'Active Trading Capital'} {balance?.low_funds_mode ? '(Capped to $3-$5 target)' : ''}
              </span>
            </div>
            <div className="flex flex-col border-l border-crypto-primary pl-4">
              <div className="uppercase tracking-widest font-bold mb-1 opacity-75">Active Cycle P/L</div>
              <div className="text-xl font-bold text-crypto-primary">${cycleProfit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
              <span className="text-[10px] opacity-60">Building to $50 Vault</span>
            </div>
            <div className="flex flex-col border-l border-crypto-success pl-4">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="uppercase tracking-widest font-bold text-crypto-success">Off-Limits Reserve</span>
                <button
                  id="reset-vault-allocation-btn"
                  onClick={handleResetVault}
                  disabled={resettingVault}
                  className="px-2 py-0.5 text-[10px] font-mono font-bold uppercase border border-crypto-danger/60 text-crypto-danger hover:bg-crypto-danger hover:text-white transition-colors cursor-pointer flex items-center gap-1 disabled:opacity-50"
                  title="Reset Off-Limits Vault to $0.00"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>Reset Vault</span>
                </button>
              </div>
              <div className="text-xl font-bold text-crypto-success">${vaultedReserve.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
              <span className="text-[10px] text-crypto-success opacity-80">{completedCycles} Locked $50+ Cycles (Untouchable)</span>
            </div>
          </div>
        </div>
      </div>

      {/* MARKET SESSION & STRICT 3-CONFLUENCE STRATEGY BANNER */}
      {balance?.session_info && (
        <div className={`crt-grid-panel p-4 font-mono text-xs flex flex-col md:flex-row items-start md:items-center justify-between gap-4 border ${
          balance.session_info.strict_3_confluence_active
            ? 'bg-amber-950/30 border-amber-500/80 text-amber-300'
            : 'bg-crypto-primary/5 border-crypto-primary/40 text-crypto-primary'
        }`}>
          <div className="flex items-start gap-3">
            <Target className={`w-6 h-6 shrink-0 mt-0.5 ${balance.session_info.strict_3_confluence_active ? 'text-amber-400 animate-pulse' : 'text-crypto-primary'}`} />
            <div className="flex flex-col gap-1">
              <div className="font-bold text-sm tracking-wider flex items-center gap-2 flex-wrap">
                <span>SESSION: {(balance.session_info?.current_session || 'OVERNIGHT').toUpperCase()}</span>
                {balance.session_info?.strict_3_confluence_active ? (
                  <span className="px-2 py-0.5 bg-amber-500/20 text-amber-300 border border-amber-500 text-[10px] uppercase font-bold tracking-widest animate-pulse">
                    STRICT 3-CONFLUENCE MODE ACTIVE ($100+ POCKETED SECURED)
                  </span>
                ) : (
                  <span className="px-2 py-0.5 bg-crypto-primary/20 text-crypto-primary border border-crypto-primary/50 text-[10px] uppercase font-bold tracking-widest">
                    MULTI-STRATEGY ACTIVE (${(balance.session_info?.session_pocketed_profit ?? 0).toFixed(2)} / $100.00 POCKETED)
                  </span>
                )}
              </div>
              <div className="text-[11px] opacity-90 leading-relaxed">
                {balance.session_info?.strict_3_confluence_active ? (
                  <>
                    <strong>$100+ Pocketed Profit Target Achieved (${(balance.session_info?.session_pocketed_profit ?? 0).toFixed(2)} Pocketed)!</strong> Strict 3-confluence strategy active. <strong>Untouchable Vault:</strong> Taking every <strong>${balance.session_info?.current_vault_threshold || 20}</strong> in profit directly to the vault. Remains in effect until <strong>35 minutes after</strong> {balance.session_info?.next_session || 'OPEN'} ({balance.session_info?.next_session_transition_time || balance.session_info?.next_session_time || '09:30 AM'}).
                  </>
                ) : (
                  <>
                    Current Session Pocketed Profit: <strong>${(balance.session_info?.session_pocketed_profit ?? 0).toFixed(2)}</strong> / $100.00. Standard multi-strategy active. Once $100 profit is secured, strict 3-confluence mode and accelerated <strong>$20 vaulting</strong> will activate and remain in effect until <strong>35 minutes after</strong> {balance.session_info?.next_session || 'OPEN'} ({balance.session_info?.next_session_transition_time || balance.session_info?.next_session_time || '09:30 AM'}).
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* CAPITAL PRESERVATION RECOVERY PROTOCOL SCREEN */}
      <RecoveryProtocolCard />

      {/* LATENCY-ADAPTIVE ENVIRONMENT & STALENESS GUARD STATUS */}
      {balance?.latency_profile && (
        <div className="crt-grid-panel p-4 font-mono text-xs border border-crypto-primary/40 bg-black/40 text-crypto-primary flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <Zap className="w-6 h-6 shrink-0 mt-0.5 text-crypto-primary animate-pulse" />
            <div className="flex flex-col gap-1">
              <div className="font-bold text-sm tracking-wider flex items-center gap-2 flex-wrap">
                <span>EXECUTION LATENCY ADAPTATION:</span>
                <span className={`px-2 py-0.5 border text-[10px] uppercase font-bold tracking-widest ${
                  balance.latency_profile.isUltraLowLatency
                    ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500'
                    : 'bg-crypto-primary/20 text-crypto-primary border-crypto-primary/50'
                }`}>
                  {balance.latency_profile.executionEnvironment === 'AWS_LIGHTSAIL_FAST' ? 'AWS LIGHTSAIL ULTRA-LOW LATENCY (<25ms)' : 'SANDBOX STANDARD ADAPTIVE MODE'}
                </span>
                <span className="text-[11px] opacity-75">
                  (Sample RT: {sampleRtMs}ms | Kalshi Order: {orderLatencyDisplay} | Kalshi Data: {kalshiDataLatency}ms | Coinbase WS: {balance.latency_profile.coinbaseWsPingMs}ms | Effective: {balance.latency_profile.effectiveLatencyMs}ms)
                </span>
              </div>
              <div className="text-[11px] opacity-90 leading-relaxed">
                <strong>Continuous Neural Watchdog:</strong> {balance.latency_profile.isNeuralExitMonitorActive ? <span className="text-crypto-primary font-bold animate-pulse">ENGAGED (&lt;100ms real-time microstructure evaluation for lightning-fast sell decisions & online weight learning)</span> : <span className="text-crypto-text/60">READY (Continuous stream active; auto-engages neural sell watchdog on contract entry)</span>} &bull; <strong>Quote Freshness Gate (C):</strong> Rejects entries older than <strong>{balance.latency_profile.staleTickThresholdMs}ms</strong>. <strong>Adaptive Buffer (B):</strong> Entry tolerance tuned to <strong>{(balance.latency_profile.slippageBufferPct * 100).toFixed(1)}%</strong> with <strong>{(balance.latency_profile.trailingStopAgilityFactor * 100).toFixed(0)}%</strong> trailing stop agility.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* PERPETUAL / 15-MIN PREDICTION ALLOCATION GUARD */}
      {balance?.perp_allocation_stats && (
        <div className="crt-grid-panel p-4 font-mono text-xs border border-crypto-primary/40 bg-black/40 text-crypto-primary flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="flex items-start gap-3 w-full">
            <ShieldCheck className="w-6 h-6 shrink-0 mt-0.5 text-crypto-primary" />
            <div className="flex flex-col gap-1 w-full">
              <div className="font-bold text-sm tracking-wider flex items-center justify-between gap-2 flex-wrap w-full">
                <div className="flex items-center gap-2">
                  <span>MARKET ALLOCATION & CAPITAL GUARD:</span>
                  <span className={`px-2 py-0.5 border text-[10px] uppercase font-bold tracking-widest ${
                    balance.perp_allocation_stats.active_perps_count >= balance.perp_allocation_stats.max_perps_allowed
                      ? 'bg-amber-500/20 text-amber-400 border-amber-500'
                      : 'bg-emerald-500/20 text-emerald-400 border-emerald-500'
                  }`}>
                    PERP SLOTS: {balance.perp_allocation_stats.active_perps_count} / {balance.perp_allocation_stats.max_perps_allowed} MAX
                  </span>
                  <span className="px-2 py-0.5 border text-[10px] uppercase font-bold tracking-widest bg-crypto-primary/20 text-crypto-primary border-crypto-primary/50">
                    15-MIN PREDICTIONS: {balance.perp_allocation_stats.active_predictions_count} ACTIVE
                  </span>
                </div>
                <div className="text-[11px] opacity-80">
                  Perp Capital: ${balance.perp_allocation_stats.perp_capital_in_use.toFixed(2)} | Prediction Capital: ${balance.perp_allocation_stats.prediction_capital_in_use.toFixed(2)}
                </div>
              </div>
              <div className="text-[11px] opacity-90 leading-relaxed">
                <strong>50% Capital Reserve Rule:</strong> Perpetual Contracts are strictly hard-capped at <strong>4 concurrent positions</strong> and cannot consume more than 50% of working capital. At least <strong>50% of capital is strictly reserved for 15-minute price predictions</strong>, preventing perpetual stall lockouts.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TIME-OUT GUARD SCREEN */}
      <ExtinctionListCard />

      {/* STRATEGIC EVOLUTION SCREEN */}
      <GeminiStrategyDoctorCard />

      {/* DEPTH MONITOR SCREEN */}
      <OrderBookMonitor marketContext={marketContext} />

      {/* PERFORMANCE SUMMARY SCREEN (PROMINENT CRT PANEL BELOW DEPTH MONITOR) */}
      <div className="crt-grid-panel relative overflow-hidden mt-2 border border-crypto-primary/60 bg-black/50 p-6 flex flex-col gap-6">
        <div className="absolute inset-0 heavy-dither-overlay pointer-events-none" />
        <div className="relative z-10 flex flex-col gap-6">
          
          {/* Main Title & Realized Header */}
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3 border-b border-crypto-primary/50 pb-4">
            <div className="flex items-center gap-3">
              <BarChart3 className="w-6 h-6 text-crypto-primary" />
              <h3 className="font-bold text-xl tracking-[0.2em] uppercase text-crypto-text">
                &gt; PERFORMANCE SUMMARY SCREEN
              </h3>
            </div>
            <div className="flex items-center gap-3 text-xs font-mono">
              <span className="text-[#808080]">Sample Size: <strong className="text-crypto-text">{totalTrades} Trades</strong></span>
              <button 
                onClick={handleClearPerformanceHistory}
                className="px-3 py-1 border border-crypto-primary text-crypto-primary bg-crypto-primary/10 hover:bg-crypto-primary hover:text-black transition-colors text-xs font-bold tracking-widest uppercase flex items-center gap-1.5"
                title="Reset performance summary & trade history"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Clear P/L History</span>
              </button>
              <button 
                onClick={handleRestartInstance}
                className="px-3 py-1 border border-crypto-danger text-crypto-danger bg-crypto-danger/10 hover:bg-crypto-danger hover:text-white transition-colors text-xs font-bold tracking-widest uppercase flex items-center gap-1.5"
                title="Clear immediate instance and start fresh"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Restart Fresh Instance</span>
              </button>
            </div>
          </div>

          {/* Capital Preservation Recovery Mode Banner */}
          <div className={`p-4 border font-mono text-xs flex flex-col md:flex-row items-start md:items-center justify-between gap-4 ${
            recoveryMode?.active 
              ? 'bg-crypto-danger/10 border-crypto-danger text-crypto-danger' 
              : 'bg-crypto-primary/5 border-crypto-primary/40 text-crypto-primary'
          }`}>
            <div className="flex items-start gap-3">
              {recoveryMode?.active ? (
                <ShieldAlert className="w-6 h-6 text-crypto-danger shrink-0 mt-0.5 animate-pulse" />
              ) : (
                <ShieldCheck className="w-6 h-6 text-crypto-primary shrink-0 mt-0.5" />
              )}
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2 font-bold uppercase tracking-wider text-sm">
                  <span>CAPITAL PRESERVATION RECOVERY PROTOCOL:</span>
                  <span className={`px-2 py-0.5 border text-[10px] ${
                    recoveryMode?.active ? 'border-crypto-danger bg-crypto-danger/20 text-crypto-danger' : 'border-crypto-success bg-crypto-success/10 text-crypto-success'
                  }`}>
                    {recoveryMode?.active ? 'EXCLUSIVE RECOVERY ACTIVE (DOWN >= 25%)' : 'STANDBY MODE'}
                  </span>
                </div>
                <div className="text-crypto-text text-xs leading-relaxed">
                  {recoveryMode?.statusMessage || `Monitoring equity drawdown vs -25.0% threshold.`}
                </div>
                {recoveryMode?.active && (
                  <div className="text-[11px] font-bold text-crypto-danger flex flex-wrap items-center gap-x-4 gap-y-1 mt-1">
                    <span>Avoided Loss Patterns: [{recoveryMode.blacklistedPatterns.join(', ') || 'None'}]</span>
                    <span>Exclusive Focus: [{recoveryMode.topWinningPatterns.join(', ')}]</span>
                  </div>
                )}
              </div>
            </div>
            <div className="shrink-0 text-right font-mono">
              <div className="text-[10px] text-[#808080] uppercase">Drawdown vs Start ($200)</div>
              <div className={`text-base font-bold ${recoveryMode && (recoveryMode.drawdownPct ?? 0) >= 25 ? 'text-crypto-danger' : 'text-crypto-text'}`}>
                {recoveryMode ? `${(recoveryMode.drawdownPct ?? 0).toFixed(1)}%` : '0.0%'}
              </div>
            </div>
          </div>

          {/* Smart Trailing Take Profit Engine Banner */}
          <div className="p-4 border font-mono text-xs flex flex-col md:flex-row items-start md:items-center justify-between gap-4 bg-crypto-success/5 border-crypto-success/40 text-crypto-success">
            <div className="flex items-start gap-3">
              <TrendingUp className="w-6 h-6 text-crypto-success shrink-0 mt-0.5" />
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2 font-bold uppercase tracking-wider text-sm">
                  <span>SMART TRAILING TAKE PROFIT ENGINE:</span>
                  <span className="px-2 py-0.5 border text-[10px] border-crypto-success bg-crypto-success/20 text-crypto-success">
                    DYNAMIC $5-$10 GAIN LOCK & $50 SCALING
                  </span>
                </div>
                <div className="text-crypto-text text-xs leading-relaxed">
                  Considers win probability to deploy sufficient capital for a $10 win to reasonably happen. Locks in gains at $5-$10 without giving back profits, dynamically trailing stop-loss upward all the way up to $50.
                </div>
                <div className="text-[11px] font-bold text-crypto-primary flex flex-wrap items-center gap-x-4 gap-y-1 mt-0.5">
                  <span>Active Runners: <strong className="text-crypto-success">{smartTrailingPositions.length}</strong></span>
                  <span>Guaranteed Locked Gains: <strong className="text-crypto-success">+${(totalLockedTrailUsd ?? 0).toFixed(2)}</strong></span>
                  <span>Target Range: <strong className="text-crypto-text">$5.00 - $10.00 &rarr; $50.00 Scaled</strong></span>
                  <span>Capital Sizing: <strong className="text-[#e2d5ed]">Probability-Adjusted ($10 Win Min)</strong></span>
                </div>
              </div>
            </div>
            <div className="shrink-0 text-right font-mono">
              <div className="text-[10px] text-[#808080] uppercase">Trailing Status</div>
              <div className="text-base font-bold text-crypto-success">
                {smartTrailingPositions.length > 0 ? `${smartTrailingPositions.length} RUNNING` : 'STANDBY (Target $5-$10 / $50)'}
              </div>
            </div>
          </div>

          {/* Top Key Metrics Banner Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 font-mono text-xs">
            
            {/* Card 1: Total P/L */}
            <div className="p-4 bg-[#11111a] border border-crypto-primary/30 flex flex-col gap-1.5">
              <span className="text-[10px] text-[#808080] uppercase tracking-widest flex items-center justify-between">
                <span>Realized P&L</span>
                <DollarSign className="w-4 h-4 text-crypto-primary" />
              </span>
              <div className={`text-2xl font-bold ${(totalPnlUsd ?? 0) >= 0 ? 'text-crypto-success' : 'text-crypto-danger'}`}>
                {(totalPnlUsd ?? 0) >= 0 ? '+' : ''}${(totalPnlUsd ?? 0).toFixed(2)}
              </div>
              <div className="text-[10px] opacity-70">
                Gross Win: <span className="text-crypto-success font-bold">+${(totalWinUsd ?? 0).toFixed(2)}</span>
              </div>
            </div>

            {/* Card 2: Trade Counts & Win Rate */}
            <div className="p-4 bg-[#11111a] border border-crypto-primary/30 flex flex-col gap-1.5">
              <span className="text-[10px] text-[#808080] uppercase tracking-widest flex items-center justify-between">
                <span>Win Rate & Trades</span>
                <Award className="w-4 h-4 text-crypto-primary" />
              </span>
              <div className="text-2xl font-bold text-crypto-text">
                {(winRate ?? 0).toFixed(1)}% <span className="text-xs text-[#808080] font-normal">({totalWins}W / {totalLosses}L)</span>
              </div>
              <div className="text-[10px] opacity-70">
                Total Executed: <span className="text-crypto-primary font-bold">{totalTrades} positions</span>
              </div>
            </div>

            {/* Card 3: Profit Factor */}
            <div className="p-4 bg-[#11111a] border border-crypto-primary/30 flex flex-col gap-1.5">
              <span className="text-[10px] text-[#808080] uppercase tracking-widest flex items-center justify-between">
                <span>Profit Factor</span>
                <TrendingUp className="w-4 h-4 text-crypto-primary" />
              </span>
              <div className="text-2xl font-bold text-crypto-primary">
                {(profitFactor ?? 0).toFixed(2)}x
              </div>
              <div className="text-[10px] opacity-70">
                Avg Win/Loss: <span className="text-crypto-success font-bold">+${(avgWinUsd ?? 0).toFixed(2)}</span> / <span className="text-crypto-danger font-bold">-${(avgLossUsd ?? 0).toFixed(2)}</span>
              </div>
            </div>

            {/* Card 4: Vaulted Profits */}
            <div className="p-4 bg-[#11111a] border border-crypto-primary/30 flex flex-col gap-1.5">
              <span className="text-[10px] text-[#808080] uppercase tracking-widest flex items-center justify-between">
                <span>Off-Limits Vault</span>
                <div className="flex items-center gap-2">
                  <button
                    id="reset-vault-card-btn"
                    onClick={handleResetVault}
                    disabled={resettingVault}
                    className="px-1.5 py-0.5 text-[10px] font-mono font-bold uppercase border border-crypto-danger/60 text-crypto-danger hover:bg-crypto-danger hover:text-white transition-colors cursor-pointer flex items-center gap-1 disabled:opacity-50"
                    title="Reset Off-Limits Vault to $0.00"
                  >
                    <RotateCcw className="w-2.5 h-2.5" />
                    <span>Reset</span>
                  </button>
                  <ShieldCheck className="w-4 h-4 text-crypto-secondary" />
                </div>
              </span>
              <div className="text-2xl font-bold text-crypto-secondary">
                ${(balance?.vaulted_profits || 0).toFixed(2)}
              </div>
              <div className="text-[10px] opacity-70">
                Goal Cycles Met: <span className="text-crypto-secondary font-bold">{balance?.completed_goal_cycles || 0} cycles</span>
              </div>
            </div>

          </div>

          {/* Clear Tabulated Strategy Performance Table */}
          <div className="overflow-x-auto max-h-[380px] overflow-y-auto custom-scrollbar touch-pan-x touch-pan-y border border-crypto-primary/30 bg-black/40">
            <table className="w-full text-left text-xs font-mono border-collapse">
              <thead>
                <tr className="border-b border-crypto-primary/40 bg-[#8f73ff11] text-crypto-primary text-[11px]">
                  <th className="py-3 px-4">STRATEGY / PATTERN TYPE</th>
                  <th className="py-3 px-4 text-center">TRADES COUNT</th>
                  <th className="py-3 px-4 text-center">WIN / LOSS</th>
                  <th className="py-3 px-4 text-center">WIN RATE (%)</th>
                  <th className="py-3 px-4 text-center">AVG WIN / LOSS (%)</th>
                  <th className="py-3 px-4 text-right">NET REALIZED P&L ($)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-crypto-primary/10">
                {patternSummary.map((p, idx) => {
                  const isBlacklisted = recoveryMode?.active && recoveryMode.blacklistedPatterns.includes(p.key);
                  const isExclusiveFocus = recoveryMode?.active && recoveryMode.topWinningPatterns.includes(p.key);

                  return (
                    <tr key={`perf-pat-${p.key}-${idx}`} className={`transition-colors ${
                      isExclusiveFocus ? 'bg-crypto-success/10 hover:bg-crypto-success/20' :
                      isBlacklisted ? 'bg-crypto-danger/10 hover:bg-crypto-danger/15 opacity-60' :
                      'hover:bg-crypto-primary/5'
                    }`}>
                      <td className="py-3 px-4 font-bold text-crypto-text flex items-center gap-2">
                        <span className={`w-2.5 h-2.5 rounded-full inline-block ${
                          isExclusiveFocus ? 'bg-crypto-success shadow-[0_0_8px_var(--color-crypto-success)]' :
                          isBlacklisted ? 'bg-crypto-danger' : 'bg-crypto-primary'
                        }`} />
                        <span>{p.label}</span>
                        {isExclusiveFocus && (
                          <span className="px-1.5 py-0.5 text-[9px] bg-crypto-success text-black font-bold uppercase">
                            EXCLUSIVE FOCUS
                          </span>
                        )}
                        {isBlacklisted && (
                          <span className="px-1.5 py-0.5 text-[9px] bg-crypto-danger text-white font-bold uppercase">
                            AVOIDED (DRAWDOWN)
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-center text-crypto-text font-bold">{p.count}</td>
                      <td className="py-3 px-4 text-center">
                        <span className="text-crypto-success font-bold">{p.wins}W</span>
                        <span className="text-[#808080] mx-1">/</span>
                        <span className="text-crypto-danger font-bold">{p.losses}L</span>
                      </td>
                      <td className="py-3 px-4 text-center font-bold">
                        <span className={`px-2.5 py-1 border text-[10px] ${
                          p.count === 0 ? 'border-[#505050] text-[#707070]' :
                          (p.winRate ?? 0) >= 50 ? 'border-crypto-success text-crypto-success bg-crypto-success/10' :
                          'border-crypto-danger text-crypto-danger bg-crypto-danger/10'
                        }`}>
                          {p.count > 0 ? `${(p.winRate ?? 0).toFixed(1)}%` : 'N/A'}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-center font-bold">
                        <span className="text-crypto-success">+{(p.avgWinPnlPct ?? 0).toFixed(1)}%</span>
                        <span className="text-[#808080] mx-1">/</span>
                        <span className="text-crypto-danger">{(p.avgLossPnlPct ?? 0).toFixed(1)}%</span>
                      </td>
                      <td className={`py-3 px-4 text-right font-bold ${
                        (p.netPnl ?? 0) > 0 ? 'text-crypto-success' :
                        (p.netPnl ?? 0) < 0 ? 'text-crypto-danger' :
                        'text-crypto-text'
                      }`}>
                        {(p.netPnl ?? 0) > 0 ? `+$${(p.netPnl ?? 0).toFixed(2)}` : (p.netPnl ?? 0) < 0 ? `-$${Math.abs(p.netPnl ?? 0).toFixed(2)}` : '$0.00'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

        </div>
      </div>

      <RestartConfirmModal 
        isOpen={showRestartModal} 
        onClose={() => setShowRestartModal(false)} 
        onSuccess={fetchData} 
      />

    </div>
  );
}
