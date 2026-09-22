import React, { useEffect, useState } from 'react';
import { Save, AlertCircle, ShieldCheck, PieChart, Activity, Clock, Zap } from 'lucide-react';

import { PWAInstallButton } from './PWAInstallButton';
import { KalshiKeyConfigCard } from './KalshiKeyConfigCard';

export function SettingsView() {
  const [settings, setSettings] = useState({
    trainingOnTheJob: false,
    winningsLock: 50,
    allocCrypto15m: 50,
    allocCrypto1h: 35,
    allocSports: 15,
    lossRecoveryMode: false,
    overrideConfluence: false,
    stopLossBase: -20,
    profitLockTrigger: 15,
    profitLockFloor: 5,
    instantProfitQueue: 20,
    kellyMultiplier: 0.5,
    paperTrading: true,
    botActive: true, adaptationMode: true, ENABLE_RAPID_SCALP_MODE: true, lowFundsMode: false, gauntletMode: false, simulatedLatencyMs: 0
  });
  const [balanceData, setBalanceData] = useState<any>(null);
  const [marketTesting, setMarketTesting] = useState<any>(null);
  const [startingBankroll, setStartingBankroll] = useState<number>(200);
  const [saving, setSaving] = useState(false);

  const fetchAll = () => {
    fetch('/api/balance')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data) {
          setBalanceData(data);
          if (typeof data.starting_bankroll === 'number') {
            setStartingBankroll(data.starting_bankroll);
          }
        }
      }).catch(() => {});

    fetch('/api/settings')
      .then(r => {
        if (!r.ok) return null;
        const ct = r.headers.get('content-type');
        if (!ct || !ct.includes('application/json')) return null;
        return r.json().catch(() => null);
      })
      .then(data => { 
        if (data) setSettings(prev => ({ ...prev, ...data })); 
      }).catch(() => {});

    fetch('/api/market-testing')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setMarketTesting(data); })
      .catch(() => {});
  };

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleToggleTrainingOnTheJob = async () => {
    const newVal = !settings.trainingOnTheJob;
    const updated = {
      ...settings,
      trainingOnTheJob: newVal,
      overrideConfluence: newVal ? true : settings.overrideConfluence
    };
    setSettings(updated);
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trainingOnTheJob: newVal,
          overrideConfluence: newVal ? true : settings.overrideConfluence
        })
      });
      fetchAll();
    } catch (e) {
      console.error(e);
    }
  };

  const handleSetGoalTarget = async (tgt: number) => {
    try {
      await fetch('/api/goal-target', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: tgt })
      });
      fetchAll();
    } catch (e) {
      console.error(e);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      fetchAll();
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  const trainingStatus = balanceData?.goal_window?.training_on_the_job || {
    enabled: settings.trainingOnTheJob,
    untouched_vault_balance: 0,
    untouched_vault_target: 200,
    is_untouched_vault_full: false,
    temporary_vault_balance: 0,
    is_in_5m_compound_window: false,
    compound_seconds_remaining: null,
    compounded_cycles_count: 0,
    total_compounded_to_working_capital: 0,
    current_goal_target: 100
  };

  return (
    <div className="flex flex-col gap-6 w-full max-w-3xl mx-auto pb-24 md:pb-6 relative z-10 text-crypto-primary font-mono text-sm tracking-wider">
      <div className="crt-grid-panel p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-[#8f73ff11]">
        <div className="flex items-center gap-3">
          <Activity className="w-8 h-8 text-crypto-primary animate-pulse" />
          <div>
            <h2 className="text-xl font-bold uppercase text-crypto-text tracking-[0.15em]">Prediction Market Configuration</h2>
            <p className="text-xs text-[#808080] font-sans">
              Adjust risk tolerances, engine states, and strategy settings.
            </p>
          </div>
        </div>
      </div>

      {/* KALSHI LIVE API AUTHENTICATION & DIAGNOSTIC CARD */}
      <KalshiKeyConfigCard onBalanceUpdated={fetchAll} />

      {/* TRAINING ON THE JOB PROTOCOL SETTING */}
      <div className={`crt-grid-panel flex flex-col gap-4 relative overflow-hidden border ${
        settings.trainingOnTheJob 
          ? 'border-crypto-success/70 bg-crypto-success/5 shadow-[0_0_15px_rgba(74,222,128,0.15)]' 
          : 'border-crypto-primary/40'
      }`}>
        <div className="absolute inset-0 heavy-dither-overlay pointer-events-none" />
        <div className="flex items-center justify-between pb-3 border-b border-crypto-primary/30 flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <Zap className={`w-6 h-6 ${settings.trainingOnTheJob ? 'text-crypto-success animate-pulse' : 'text-crypto-primary'}`} />
            <div>
              <h3 className="text-sm font-bold uppercase tracking-wider text-crypto-text">Training on the Job Mode</h3>
              <p className="text-[11px] text-[#808080] font-sans">Automated non-destructive cycle with $200 untouched vault & 5m capital compounding</p>
            </div>
          </div>
          <span className={`px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border ${
            settings.trainingOnTheJob 
              ? 'bg-crypto-success/20 text-crypto-success border-crypto-success' 
              : 'bg-black/50 text-[#808080] border-[#404040]'
          }`}>
            {settings.trainingOnTheJob ? 'ENABLED' : 'DISABLED'}
          </span>
        </div>

        {/* The Gauntlet Mode Switch */}
        <div className="flex items-center justify-between gap-4 p-3 bg-black/40 border border-[#f59e0b]/50">
          <div className="flex flex-col gap-0.5">
            <span className="font-bold text-[#f59e0b] text-xs uppercase flex items-center gap-2">
              🔥 The Gauntlet ($20 to $2000 Crucible)
              <span className={`px-2 py-0.5 text-[9px] font-bold border rounded-none ${
                (settings as any).gauntletMode ? 'bg-[#f59e0b]/20 text-[#f59e0b] border-[#f59e0b]' : 'bg-black/50 text-[#808080] border-[#404040]'
              }`}>
                {(settings as any).gauntletMode ? 'ACTIVE: CRRA SCALING' : 'DISABLED'}
              </span>
            </span>
            <span className="text-[11px] text-[#909090] font-sans">
              Engages LARL (Latency-Aware RL) & fractional Kelly dynamic scaling. Starts paper bankroll at $20 and algorithmically drives compounding toward $2,000 using CRRA log-utility maximization.
            </span>
          </div>
          <div className="relative shrink-0">
            <input
              type="checkbox"
              className="sr-only"
              checked={Boolean((settings as any).gauntletMode)}
              onChange={(e) => {
                const isChecked = e.target.checked;
                const newSettings = {
                  ...settings,
                  gauntletMode: isChecked,
                  paperTrading: isChecked ? true : settings.paperTrading,
                  simulatedLatencyMs: isChecked && !(settings as any).simulatedLatencyMs ? 50 : (settings as any).simulatedLatencyMs
                };
                setSettings(newSettings as any);
                fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newSettings) });
              }}
            />
            <div className={`block w-14 h-8 rounded-none transition-colors crt-border ${(settings as any).gauntletMode ? 'bg-[#f59e0b]' : 'bg-black/60 border border-[#404040]'}`}></div>
            <div className={`absolute left-1 top-1 bg-white w-6 h-6 rounded-none transition-transform ${(settings as any).gauntletMode ? 'translate-x-6' : ''}`}></div>
          </div>
        </div>


        {/* Latency Simulation Slider */}
        <div className="flex flex-col gap-2 p-3 bg-black/40 border border-crypto-primary/30 mt-4">
          <div className="flex items-center justify-between">
            <span className="font-bold text-crypto-primary text-xs uppercase flex items-center gap-2">
              Network Latency Simulator
              <span className={`px-2 py-0.5 text-[9px] font-bold border rounded-none ${
                (settings as any).simulatedLatencyMs > 0 ? 'bg-amber-500/20 text-amber-500 border-amber-500' : 'bg-black/50 text-[#808080] border-[#404040]'
              }`}>
                {(settings as any).simulatedLatencyMs > 0 ? `${(settings as any).simulatedLatencyMs}ms (RANDOMIZED SCALED)` : 'OFF'}
              </span>
            </span>
          </div>
          <span className="text-[11px] text-[#909090] font-sans">
            Simulates realistic execution delays during paper trading to model HFT slippage and quote freshness gating. Bypassed when paper trading is off.
          </span>
          <div className="pt-2 flex items-center gap-4">
            <span className="text-[10px] text-[#606060] font-bold">OFF</span>
            <input
              type="range"
              min="0"
              max="500"
              step="5"
              disabled={!settings.paperTrading}
              value={(settings as any).simulatedLatencyMs || 0}
              onChange={(e) => {
                const newLatency = parseInt(e.target.value);
                const newSettings = { ...settings, simulatedLatencyMs: newLatency };
                setSettings(newSettings as any);
                fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newSettings) });
              }}
              className="w-full accent-crypto-primary bg-black/60 cursor-pointer disabled:opacity-30"
            />
            <span className="text-[10px] text-crypto-danger font-bold">HIGH</span>
          </div>
          <div className="flex justify-between text-[9px] text-[#606060] px-8">
             <span>0ms</span>
             <span>10ms (Low)</span>
             <span>50ms (Med)</span>
             <span>200ms (High)</span>
             <span>500ms (Extreme)</span>
          </div>
        </div>


        {/* Toggle Switch */}
        <div className="flex items-center justify-between gap-4 p-3 bg-black/40 border border-crypto-primary/30">
          <div className="flex flex-col gap-0.5">
            <span className="font-bold text-crypto-text text-xs uppercase">Enable "Training on the Job" Mode</span>
            <span className="text-[11px] text-[#909090] font-sans">
              Overrides confluence automatically. Quarantines initial $200 into untouched vault, then routes post-goal 5m earnings into working capital.
            </span>
          </div>
          <button
            onClick={handleToggleTrainingOnTheJob}
            className={`px-4 py-2 text-xs uppercase font-bold border transition-all cursor-pointer shrink-0 min-h-[44px] flex items-center gap-2 ${
              settings.trainingOnTheJob
                ? 'bg-crypto-success text-crypto-bg border-crypto-success shadow-[0_0_12px_rgba(74,222,128,0.5)]'
                : 'bg-black/60 text-crypto-primary border-crypto-primary hover:bg-crypto-primary hover:text-black'
            }`}
          >
            <span className={`w-2.5 h-2.5 rounded-full ${settings.trainingOnTheJob ? 'bg-black animate-ping' : 'bg-crypto-primary'}`}></span>
            <span>{settings.trainingOnTheJob ? 'SWITCH: ON' : 'SWITCH: OFF'}</span>
          </button>
        </div>

        {/* Dynamic Goal Target Escalation (Linked Directly to Daily Subroutine) */}
        <div className="flex flex-col gap-2 p-3 bg-black/40 border border-crypto-primary/30 text-xs">
          <div className="flex items-center justify-between">
            <span className="font-bold uppercase tracking-wider text-crypto-text">Dynamic Goal Target Escalation</span>
            <span className="text-crypto-primary font-bold font-mono">${trainingStatus.current_goal_target || 100} Target</span>
          </div>
          <p className="text-[11px] text-[#808080] font-sans">
            Target escalation is linked directly to the daily subroutine. Once the initial $200 enters the untouched vault, the target automatically switches to the daily subroutine scaling dynamically (50%) with the working capital at hand.
          </p>
          <div className="flex items-center gap-2 pt-1">
            <div className={`px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider border flex items-center gap-1.5 ${
              trainingStatus.is_untouched_vault_full
                ? 'bg-crypto-success/20 text-crypto-success border-crypto-success'
                : 'bg-black/60 text-amber-300 border-amber-500/50'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${trainingStatus.is_untouched_vault_full ? 'bg-crypto-success' : 'bg-amber-400'}`} />
              <span>{trainingStatus.is_untouched_vault_full ? 'ACTIVE: DAILY SUBROUTINE (50% WORKING CAPITAL SCALING)' : 'PHASE 1: FILLING $200 UNTOUCHED VAULT ($100 TARGET)'}</span>
            </div>
          </div>
        </div>

        {/* Real-Time Training Status Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-1 text-xs">
          <div className="p-2.5 bg-black/40 border border-crypto-primary/30 flex flex-col gap-1">
            <span className="text-[10px] text-crypto-text/60 uppercase font-bold">Untouched Vault ($200)</span>
            <span className="text-sm font-bold text-crypto-text">${(trainingStatus.untouched_vault_balance || 0).toFixed(2)} / $200.00</span>
            <span className="text-[9px] text-[#808080]">{trainingStatus.is_untouched_vault_full ? 'Protected in Vault' : 'Filling Reserve'}</span>
          </div>
          <div className="p-2.5 bg-black/40 border border-crypto-primary/30 flex flex-col gap-1">
            <span className="text-[10px] text-crypto-text/60 uppercase font-bold">5m Temp Vault</span>
            <span className="text-sm font-bold text-crypto-success">+${(trainingStatus.temporary_vault_balance || 0).toFixed(2)}</span>
            <span className="text-[9px] text-[#808080]">{trainingStatus.is_in_5m_compound_window ? `Injecting in ${trainingStatus.compound_seconds_remaining || 0}s` : 'Ready'}</span>
          </div>
          <div className="p-2.5 bg-black/40 border border-crypto-primary/30 flex flex-col gap-1">
            <span className="text-[10px] text-crypto-text/60 uppercase font-bold">Total Injected Capital</span>
            <span className="text-sm font-bold text-crypto-primary">+${(trainingStatus.total_compounded_to_working_capital || 0).toFixed(2)}</span>
            <span className="text-[9px] text-[#808080]">{trainingStatus.compounded_cycles_count || 0} Cycles Compounded</span>
          </div>
        </div>
      </div>

      {/* 1. Bankroll Management */}
      
      <div className="crt-grid-panel flex flex-col gap-6 relative overflow-hidden">
        <div className="absolute inset-0 heavy-dither-overlay pointer-events-none" />
<div className="absolute inset-0 dither-gradient-overlay pointer-events-none" />
        <div className="flex items-center gap-3 pb-4">

          <PieChart className="w-6 h-6 text-crypto-primary" />
          <h3 className="text-sm font-bold text-crypto-primary opacity-70 uppercase tracking-wider">Bankroll Management & Allocation</h3>
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm text-crypto-primary opacity-70 font-medium flex justify-between">
            <span>High-Water Mark Winnings Lock (%)</span>
            <span className="text-crypto-primary">{settings.winningsLock}%</span>
          </label>
          <input 
            type="range" 
            min="0" 
            max="100" 
            step="5"
            value={settings.winningsLock}
            onChange={(e) => setSettings({...settings, winningsLock: parseInt(e.target.value)})}
            className="w-full h-2 bg-black/60 border border-[#404040] rounded-none appearance-none cursor-pointer accent-crypto-primary"
          />
          <p className="text-xs text-[#808080] mt-1">
            Percentage of total profits permanently locked away once the account hits a new all-time high.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-2">
          <div className="flex flex-col gap-1 p-3 bg-black/40 crt-border border-crypto-primary/30">
            <span className="text-xs text-crypto-primary opacity-70 uppercase tracking-wider font-bold">15m Crypto</span>
            <div className="flex items-center justify-between">
              <span className="text-xl font-semibold text-crypto-primary">{settings.allocCrypto15m}%</span>
            </div>
          </div>
          <div className="flex flex-col gap-1 p-3 bg-black/40 crt-border border-crypto-primary/30">
            <span className="text-xs text-crypto-primary opacity-70 uppercase tracking-wider font-bold">1H Crypto</span>
            <div className="flex items-center justify-between">
              <span className="text-xl font-semibold text-crypto-primary">{settings.allocCrypto1h}%</span>
            </div>
          </div>
          <div className="flex flex-col gap-1 p-3 bg-black/40 crt-border border-crypto-primary/30">
            <span className="text-xs text-crypto-primary opacity-70 uppercase tracking-wider font-bold">Intraday Sports</span>
            <div className="flex items-center justify-between">
              <span className="text-xl font-semibold text-crypto-primary">{settings.allocSports}%</span>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2 pt-2">
          <label className="flex items-center justify-between cursor-pointer">
            <div className="flex flex-col gap-1">
              <span className="font-medium text-crypto-primary text-sm">Capital Preservation (Recovery Mode)</span>
              <span className="text-xs text-[#808080]">Suspend crypto. Shift sports to 85-95% probability favorites.</span>
            </div>
            <div className="relative">
              <input 
                type="checkbox" 
                className="sr-only" 
                checked={settings.lossRecoveryMode}
                onChange={(e) => setSettings({...settings, lossRecoveryMode: e.target.checked})}
              />
              <div className={`block w-12 h-6 rounded-none transition-colors ${settings.lossRecoveryMode ? 'bg-crypto-primary' : 'bg-black/60 border border-[#404040]'}`}></div>
              <div className={`absolute left-1 top-1 bg-white w-4 h-4 rounded-none transition-transform ${settings.lossRecoveryMode ? 'translate-x-6' : ''}`}></div>
            </div>
          </label>
        </div>

        <div className="flex items-start gap-3 p-3 bg-black/40 crt-border border-crypto-primary/30 mt-1">
          <ShieldCheck className="w-5 h-5 text-crypto-primary shrink-0 mt-0.5" />
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-bold uppercase tracking-wider text-crypto-text flex items-center gap-2">
              Perpetual Capital Reserve Guard: <span className="text-crypto-primary font-mono">30% Hard Floor</span>
            </span>
            <span className="text-xs text-[#808080]">
              The last remaining 30% of working capital is hard-locked against Perpetual Contracts, ensuring liquidity is never exhausted by perpetual margin and always preserved for prediction market entries.
            </span>
          </div>
        </div>
      </div>

      {/* 2. Execution & Stop-Loss */}
      
      <div className="crt-grid-panel flex flex-col gap-6 relative overflow-hidden">
        <div className="absolute inset-0 heavy-dither-overlay pointer-events-none" />
<div className="absolute inset-0 dither-gradient-overlay pointer-events-none" />
        <div className="flex items-center gap-3 pb-4">

          <Activity className="w-6 h-6 text-crypto-primary" />
          <h3 className="text-sm font-bold text-crypto-primary opacity-70 uppercase tracking-wider">Dual-Threshold Stop-Loss Tracker</h3>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="flex flex-col gap-2 md:col-span-2">
            <label className="text-sm text-crypto-primary opacity-70 font-medium flex justify-between">
              <span>Base Fractional Kelly Multiplier (Dynamic Ceiling)</span>
              <span className="text-crypto-primary">{settings.kellyMultiplier}x</span>
            </label>
            <input 
              type="range" 
              min="0.1" 
              max="1.0" 
              step="0.1"
              value={settings.kellyMultiplier}
              onChange={(e) => setSettings({...settings, kellyMultiplier: parseFloat(e.target.value)})}
              className="w-full h-2 bg-black/60 border border-[#404040] rounded-none appearance-none cursor-pointer accent-crypto-primary"
            />
            <p className="text-xs text-[#808080] mt-1">
              Base risk scaling. The live bot dynamically modulates this Kelly Multiplier based on real-time spot order book pressures (e.g. contracting on opposing sell walls).
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm text-crypto-primary opacity-70 font-medium flex justify-between">
              <span>Base Hard Stop-Loss</span>
              <span className="text-crypto-danger">{settings.stopLossBase}%</span>
            </label>
            <input 
              type="range" 
              min="-3" 
              max="-0.7" 
              step="0.1"
              value={settings.stopLossBase}
              onChange={(e) => setSettings({...settings, stopLossBase: parseFloat(e.target.value)})}
              className="w-full h-2 bg-black/60 border border-[#404040] rounded-none appearance-none cursor-pointer accent-crypto-primary"
            />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm text-crypto-primary opacity-70 font-medium flex justify-between">
              <span>Trailing Profit Trigger</span>
              <span className="text-crypto-text">+{settings.profitLockTrigger}%</span>
            </label>
            <input 
              type="range" 
              min="5" 
              max="50" 
              step="1"
              value={settings.profitLockTrigger}
              onChange={(e) => setSettings({...settings, profitLockTrigger: parseInt(e.target.value)})}
              className="w-full h-2 bg-black/60 border border-[#404040] rounded-none appearance-none cursor-pointer accent-crypto-primary"
            />
          </div>
          
          <div className="flex flex-col gap-2">
            <label className="text-sm text-crypto-primary opacity-70 font-medium flex justify-between">
              <span>Trailing Stop Floor</span>
              <span className="text-crypto-primary">+{settings.profitLockFloor}%</span>
            </label>
            <input 
              type="range" 
              min="1" 
              max="20" 
              step="1"
              value={settings.profitLockFloor}
              onChange={(e) => setSettings({...settings, profitLockFloor: parseInt(e.target.value)})}
              className="w-full h-2 bg-black/60 border border-[#404040] rounded-none appearance-none cursor-pointer accent-crypto-primary"
            />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm text-crypto-primary opacity-70 font-medium flex justify-between">
              <span>Instant Profit Queue (Limit Sell)</span>
              <span className="text-crypto-primary">+{settings.instantProfitQueue}%</span>
            </label>
            <input 
              type="range" 
              min="15" 
              max="100" 
              step="5"
              value={settings.instantProfitQueue}
              onChange={(e) => setSettings({...settings, instantProfitQueue: Math.max(15, parseInt(e.target.value))})}
              className="w-full h-2 bg-black/60 border border-[#404040] rounded-none appearance-none cursor-pointer accent-crypto-primary"
            />
            <p className="text-[10px] text-[#808080] mt-1">
              Forced dynamic target: Max of +15% or Kelly-implied equivalent.
            </p>
          </div>
        </div>
      </div>

      {/* 3. TTE Buffers */}
      
      <div className="crt-grid-panel flex flex-col gap-6 relative overflow-hidden">
        <div className="absolute inset-0 heavy-dither-overlay pointer-events-none" />
<div className="absolute inset-0 dither-gradient-overlay pointer-events-none" />
        <div className="flex items-center gap-3 pb-4">

          <Clock className="w-6 h-6 text-crypto-primary" />
          <h3 className="text-sm font-bold text-crypto-primary opacity-70 uppercase tracking-wider">Time-to-Expiration (TTE) Buffers</h3>
        </div>
        
        <div className="flex flex-col gap-4">
          <div className="p-4 bg-black/40 crt-border border-crypto-primary/30">
             <div className="text-sm font-semibold mb-2">15-Minute Contracts</div>
             <div className="text-xs text-[#808080] flex flex-col gap-1">
               <div className="flex justify-between"><span>Entry Buffer (Liquidity):</span> <span className="text-crypto-primary font-mono">First 90s</span></div>
               <div className="flex justify-between"><span>Exit Buffer (Time Decay):</span> <span className="text-crypto-primary font-mono">Last 2m</span></div>
             </div>
          </div>
          <div className="p-4 bg-black/40 crt-border border-crypto-primary/30">
             <div className="text-sm font-semibold mb-2">1-Hour Contracts</div>
             <div className="text-xs text-[#808080] flex flex-col gap-1">
               <div className="flex justify-between"><span>Entry Buffer (Liquidity):</span> <span className="text-crypto-primary font-mono">First 3m</span></div>
               <div className="flex justify-between"><span>Exit Buffer (Time Decay):</span> <span className="text-crypto-primary font-mono">Last 10m</span></div>
             </div>
          </div>
        </div>
      </div>

      
      <div className="crt-grid-panel flex flex-col gap-6 relative overflow-hidden">
        <div className="absolute inset-0 heavy-dither-overlay pointer-events-none" />
<div className="absolute inset-0 dither-gradient-overlay pointer-events-none" />
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-bold text-crypto-primary opacity-70 uppercase tracking-wider">Trading Engine State</h3>
        </div>
        <label className="flex items-center justify-between cursor-pointer border-b border-crypto-primary/30 pb-4 mb-4">
          <div className="flex flex-col">
            <span className="font-medium text-crypto-primary flex items-center gap-2">Adaptation Mode <span className="px-2 py-0.5 text-[10px] bg-crypto-success/20 text-crypto-success rounded-none border border-crypto-success">Self-Learning</span></span>
            <span className="text-xs text-[#808080]">Bot logs trade performance and iteratively adjusts take-profit and stop-loss targets dynamically based on historical averages to optimize strategy in real-time.</span>
          </div>
          <div className="relative">
            <input 
              type="checkbox" 
              className="sr-only" 
              checked={settings.adaptationMode}
              onChange={(e) => {
                const newSettings = {...settings, adaptationMode: e.target.checked};
                setSettings(newSettings);
                fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newSettings) });
              }}
            />
            <div className={`block w-14 h-8 rounded-none transition-colors crt-border ${settings.adaptationMode ? 'bg-crypto-primary' : 'bg-black/60 border border-[#404040]'}`}></div>
            <div className={`absolute left-1 top-1 bg-white w-6 h-6 rounded-none transition-transform ${settings.adaptationMode ? 'translate-x-6' : ''}`}></div>
          </div>
        </label>
        <label className="flex items-center justify-between cursor-pointer border-b border-crypto-primary/30 pb-4 mb-4">
          <div className="flex flex-col">
            <span className="font-medium text-crypto-primary flex items-center gap-2">
              Paper Trading (Simulation) 
              <span className={`px-2 py-0.5 text-[10px] rounded-none font-bold uppercase tracking-wider ${settings.paperTrading ? 'bg-crypto-primary/20 text-crypto-primary border border-crypto-primary/40' : 'bg-crypto-success/20 text-crypto-success border border-crypto-success/40'}`}>
                {settings.paperTrading ? 'Simulated Paper Cash' : 'Real Kalshi Predictions Pool'}
              </span>
            </span>
            <span className="text-xs text-[#808080]">
              {settings.paperTrading 
                ? 'Using simulated cash bankroll ($200 starting) and local balance testing without real risk.' 
                : 'LIVE MODE: Bankroll strictly reflects actual Kalshi USD cash balance via authenticated API.'}
            </span>
          </div>
          <div className="relative">
            <input 
              type="checkbox" 
              className="sr-only" 
              checked={settings.paperTrading}
              onChange={(e) => {
                const newSettings = {...settings, paperTrading: e.target.checked};
                setSettings(newSettings);
                fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newSettings) });
              }}
            />
            <div className={`block w-14 h-8 rounded-none transition-colors ${settings.paperTrading ? 'bg-crypto-primary' : 'bg-black/60 border border-[#404040]'}`}></div>
            <div className={`absolute left-1 top-1 bg-white w-6 h-6 rounded-none transition-transform ${settings.paperTrading ? 'translate-x-6' : ''}`}></div>
          </div>
        </label>
        {settings.paperTrading && (
          <div className="flex flex-col gap-2 pt-2 pb-4 mb-4 border-b border-crypto-primary/30 pl-2">
            <span className="text-xs text-[#808080] font-bold uppercase tracking-wider">Starting Cash Bankroll:</span>
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              {[50, 100, 200, 1000].map(amt => (
                <button
                  key={amt}
                  type="button"
                  onClick={async () => {
                    setStartingBankroll(amt);
                    try {
                      await fetch('/api/balance/reset', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ amount: amt })
                      });
                    } catch (e) {}
                  }}
                  className={`px-3 py-2 sm:px-4 flex-1 sm:flex-none whitespace-nowrap text-center text-xs font-bold uppercase tracking-wider transition-colors ${startingBankroll === amt ? 'bg-crypto-primary text-black border border-crypto-primary' : 'bg-black/40 text-crypto-primary border border-crypto-primary/40 hover:bg-crypto-primary/10'}`}
                >
                  ${amt} Start
                </button>
              ))}
            </div>
          </div>
        )}
        <label className="flex items-center justify-between cursor-pointer pt-4 mt-4 border-t border-crypto-primary/30">
          <div className="flex flex-col">
            <span className="font-medium text-crypto-primary flex items-center gap-2">
              Low Funds Mode ($3-$5 Target) 
              <span className="px-2 py-0.5 text-[10px] bg-crypto-success/20 text-crypto-success border border-crypto-success/40 rounded-none font-bold">Conserve Pool</span>
            </span>
            <span className="text-xs text-[#808080]">Cap trade capital so each trade targets $3-$5 profit instead of $10, preventing rapid pool exhaustion.</span>
          </div>
          <div className="relative">
            <input 
              type="checkbox" 
              className="sr-only" 
              checked={settings.lowFundsMode}
              onChange={(e) => {
                const newSettings = {...settings, lowFundsMode: e.target.checked};
                setSettings(newSettings);
                fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newSettings) });
              }}
            />
            <div className={`block w-14 h-8 rounded-none transition-colors ${settings.lowFundsMode ? 'bg-crypto-success' : 'bg-black/60 border border-[#404040]'}`}></div>
            <div className={`absolute left-1 top-1 bg-white w-6 h-6 rounded-none transition-transform ${settings.lowFundsMode ? 'translate-x-6' : ''}`}></div>
          </div>
        </label>
        <label className="flex items-center justify-between cursor-pointer pt-4 mt-4 border-t border-crypto-primary/30">
          <span className="font-medium text-crypto-primary">Bot Active Status</span>
          <div className="relative">
            <input 
              type="checkbox" 
              className="sr-only" 
              checked={settings.botActive}
              onChange={(e) => {
                const newSettings = {...settings, botActive: e.target.checked};
                setSettings(newSettings);
                fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newSettings) });
              }}
            />
            <div className={`block w-14 h-8 rounded-none transition-colors ${settings.botActive ? 'bg-crypto-primary' : 'bg-black/60 border border-[#404040]'}`}></div>
            <div className={`absolute left-1 top-1 bg-white w-6 h-6 rounded-none transition-transform ${settings.botActive ? 'translate-x-6' : ''}`}></div>
          </div>
        </label>
        <label className="flex items-center justify-between cursor-pointer pt-4 mt-4 border-t border-crypto-primary/30">
          <div className="flex flex-col">
            <span className="font-medium text-crypto-primary flex items-center gap-2">Rapid Scalp Mode <span className="px-2 py-0.5 text-[10px] bg-crypto-danger/20 text-crypto-danger border border-crypto-danger rounded-none">High Frequency</span></span>
            <span className="text-xs text-[#808080]">Bypass legacy kalshi polling for live WS spot BTC scalping using RSI divergence.</span>
          </div>
          <div className="relative">
            <input 
              type="checkbox" 
              className="sr-only" 
              checked={settings.ENABLE_RAPID_SCALP_MODE}
              onChange={(e) => {
                const newSettings = {...settings, ENABLE_RAPID_SCALP_MODE: e.target.checked};
                setSettings(newSettings);
                fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newSettings) });
              }}
            />
            <div className={`block w-14 h-8 rounded-none transition-colors crt-border ${settings.ENABLE_RAPID_SCALP_MODE ? 'bg-crypto-primary' : 'bg-black/60 border border-[#404040]'}`}></div>
            <div className={`absolute left-1 top-1 bg-white w-6 h-6 rounded-none transition-transform ${settings.ENABLE_RAPID_SCALP_MODE ? 'translate-x-6' : ''}`}></div>
          </div>
        </label>
        <label className="flex items-center justify-between cursor-pointer pt-4 mt-4 border-t border-crypto-primary/30 bg-[#8f73ff08] p-3 -mx-3">
          <div className="flex flex-col pr-4">
            <span className="font-bold text-crypto-primary flex items-center gap-2">
              Training on the Job
              <span className={`px-2 py-0.5 text-[10px] font-bold border rounded-none ${
                (settings as any).trainingOnTheJob ? 'bg-crypto-success/20 text-crypto-success border-crypto-success' : 'bg-black/50 text-[#808080] border-[#404040]'
              }`}>
                {(settings as any).trainingOnTheJob ? 'ACTIVE COMPOUNDING' : 'OFF'}
              </span>
            </span>
            <span className="text-xs text-[#909090] mt-1 leading-relaxed">
              Sets aside an initial $200 total untouched reserve. Thereafter, places $100+ goal profit plus 5m interim gains into a temporary vault which enters working capital after 5 minutes without wiping P/L. Always forces Confluence Override ON.
            </span>
          </div>
          <div className="relative shrink-0">
            <input 
              type="checkbox" 
              className="sr-only" 
              checked={Boolean((settings as any).trainingOnTheJob)}
              onChange={(e) => {
                const isChecked = e.target.checked;
                const newSettings = {
                  ...settings, 
                  trainingOnTheJob: isChecked,
                  // Confluence Override is always forced ON in Training on the Job mode
                  overrideConfluence: isChecked ? true : settings.overrideConfluence
                };
                setSettings(newSettings as any);
                fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newSettings) });
              }}
            />
            <div className={`block w-14 h-8 rounded-none transition-colors crt-border ${(settings as any).trainingOnTheJob ? 'bg-crypto-success' : 'bg-black/60 border border-[#404040]'}`}></div>
            <div className={`absolute left-1 top-1 bg-white w-6 h-6 rounded-none transition-transform ${(settings as any).trainingOnTheJob ? 'translate-x-6' : ''}`}></div>
          </div>
        </label>

        <label className="flex items-center justify-between cursor-pointer pt-4 mt-4 border-t border-crypto-primary/30">
          <div className="flex flex-col">
            <span className="font-medium text-crypto-danger flex items-center gap-2">
              Override Confluence Rules 
              <span className="px-2 py-0.5 text-[10px] bg-crypto-danger/20 text-crypto-danger border border-crypto-danger rounded-none">
                {(settings as any).trainingOnTheJob ? 'LOCKED ON (TRAINING MODE)' : 'Override Active'}
              </span>
            </span>
            <span className="text-xs text-[#808080]">
              {(settings as any).trainingOnTheJob 
                ? 'Permanently engaged while Training on the Job mode is active.' 
                : 'Bypass all multi-tool indicator confluence checks, strict session 3-confluence rules, and doji filters for immediate trade execution.'}
            </span>
          </div>
          <div className="relative">
            <input 
              type="checkbox" 
              className="sr-only" 
              checked={settings.overrideConfluence || Boolean((settings as any).trainingOnTheJob)}
              disabled={Boolean((settings as any).trainingOnTheJob)}
              onChange={(e) => {
                const newSettings = {...settings, overrideConfluence: e.target.checked};
                setSettings(newSettings);
                fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newSettings) });
              }}
            />
            <div className={`block w-14 h-8 rounded-none transition-colors crt-border ${(settings.overrideConfluence || Boolean((settings as any).trainingOnTheJob)) ? 'bg-crypto-danger' : 'bg-black/60 border border-[#404040]'}`}></div>
            <div className={`absolute left-1 top-1 bg-white w-6 h-6 rounded-none transition-transform ${(settings.overrideConfluence || Boolean((settings as any).trainingOnTheJob)) ? 'translate-x-6' : ''}`}></div>
          </div>
        </label>

        {/* Market Testing Protocol Status Card */}
        {marketTesting && (
          <div className="mt-4 p-3 bg-black/40 border border-crypto-primary/40 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase text-crypto-text flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-crypto-primary" />
                Automated Market Testing Protocol
              </span>
              <span className={`px-1.5 py-0.5 text-[9px] font-bold uppercase border ${
                marketTesting.phase === 'TESTING_PERIOD' ? 'bg-amber-500/20 text-amber-300 border-amber-500' :
                marketTesting.phase === 'OVERRIDE_ACTIVE' ? 'bg-crypto-danger/20 text-crypto-danger border-crypto-danger' :
                marketTesting.phase === 'GOAL_REACHED_CONSERVATIVE' ? 'bg-crypto-success/20 text-crypto-success border-crypto-success' :
                'bg-black/50 text-crypto-primary border-crypto-primary/40'
              }`}>
                {marketTesting.phase}
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
              <div className="p-2 bg-black/30 border border-crypto-primary/20">
                <div className="text-crypto-text/60 text-[9px]">NEXT MARKET OPEN</div>
                <div className="font-bold text-crypto-text truncate">{marketTesting.nextSessionName}</div>
                <div className="text-[9px] text-crypto-primary">{marketTesting.nextSessionTimeStr}</div>
              </div>
              <div className="p-2 bg-black/30 border border-crypto-primary/20">
                <div className="text-crypto-text/60 text-[9px]">COUNTDOWN TO OPEN</div>
                <div className="font-bold text-crypto-text">{marketTesting.minutesUntilNextOpen} min</div>
                <div className="text-[9px] text-crypto-primary">
                  {marketTesting.isTestingPeriod ? `${Math.floor(marketTesting.testingTimeRemainingSec / 60)}m ${marketTesting.testingTimeRemainingSec % 60}s gauge` : 'Pre-market cycle'}
                </div>
              </div>
              <div className="p-2 bg-black/30 border border-crypto-primary/20">
                <div className="text-crypto-text/60 text-[9px]">OVERRIDE STATUS</div>
                <div className={`font-bold ${marketTesting.overrideConfluenceEngaged ? 'text-crypto-danger' : 'text-crypto-primary'}`}>
                  {marketTesting.overrideConfluenceEngaged ? 'ENGAGED (TRUE)' : 'DISENGAGED (FALSE)'}
                </div>
                <div className="text-[9px] text-crypto-text/50">
                  {marketTesting.isTestingPeriod ? 'Gauging market (30m)' : marketTesting.isOverrideActive ? 'Active until $100' : 'Conservative mode'}
                </div>
              </div>
              <div className="p-2 bg-black/30 border border-crypto-primary/20">
                <div className="text-crypto-text/60 text-[9px]">NET $100 GOAL (W & L)</div>
                <div className={`font-bold ${(marketTesting.cycleEarnedProfitInWindow ?? 0) >= 0 ? 'text-crypto-text' : 'text-crypto-danger'}`}>
                  {(marketTesting.cycleEarnedProfitInWindow ?? 0) >= 0 ? '+' : ''}${(marketTesting.cycleEarnedProfitInWindow ?? 0).toFixed(2)} / $100.00
                </div>
                <div className="text-[9px] flex items-center gap-1">
                  <span className="text-crypto-success">+{typeof marketTesting.totalWinsInWindow === 'number' ? `$${marketTesting.totalWinsInWindow.toFixed(2)}` : '$0'}</span>
                  <span>/</span>
                  <span className="text-crypto-danger">-{typeof marketTesting.totalLossesInWindow === 'number' ? `$${marketTesting.totalLossesInWindow.toFixed(2)}` : '$0'}</span>
                </div>
              </div>
            </div>

            <div className="text-[10px] text-crypto-text/70 leading-relaxed font-sans border-t border-crypto-primary/20 pt-2">
              <strong>Protocol Lifecycle:</strong> 1 hour before market open, a 30-minute testing window gauges the market with Override Confluence disengaged. At T-30m, Override Confluence engages automatically to trade aggressively until $100 net profit (wins minus losses) is achieved. Once $100 net is reached, Override Confluence is automatically deactivated to enforce conservative risk management and protect profits.
            </div>
          </div>
        )}
      </div>

      <button 
        onClick={handleSave}
        disabled={saving}
        className="flex items-center justify-center gap-2 w-full bg-crypto-primary crt-border text-crypto-bg uppercase tracking-widest font-bold font-semibold rounded-none py-3 hover:opacity-80 transition disabled:opacity-50"
      >
        <Save className="w-5 h-5" />
        {saving ? 'Saving...' : 'Save Configuration'}
      </button>
      
      <div className="mt-4">
        <PWAInstallButton />
      </div>
    </div>
  );
}
