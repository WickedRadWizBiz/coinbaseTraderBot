import React, { useState, useEffect } from 'react';
import { ShieldAlert, Zap, RefreshCw, CheckCircle2 } from 'lucide-react';

export interface AssetTimeoutRecord {
  assetSymbol: string;
  lossCount: number;
  timeoutUntilMs: number;
}

export interface TimeoutItem {
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

export function ExtinctionListCard() {
  const [items, setItems] = useState<TimeoutItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [overriding, setOverriding] = useState(false);
  const [justCleared, setJustCleared] = useState(false);
  const [now, setNow] = useState(Date.now());

  const fetchTimeoutList = async () => {
    try {
      const res = await fetch('/api/timeout-list').catch(() => null);
      if (res && res.ok) {
        const data = await res.json().catch(() => null);
        const list = data?.timeoutList || data?.extinctionList;
        if (list) {
          setItems(list);
        }
      }
    } catch {
      // Suppress transient network fetch errors
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTimeoutList();
    const fetchInterval = setInterval(fetchTimeoutList, 3000);
    const clockInterval = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(fetchInterval);
      clearInterval(clockInterval);
    };
  }, []);

  const handleOverrideAll = async () => {
    setOverriding(true);
    try {
      const res = await fetch('/api/override-all-timeouts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      if (res.ok) {
        setJustCleared(true);
        setTimeout(() => setJustCleared(false), 3000);
        await fetchTimeoutList();
      }
    } catch (e) {
      console.error("[OVERRIDE ALL TIMEOUTS ERROR]", e);
    } finally {
      setOverriding(false);
    }
  };

  // Calculate active timeouts
  const activeTimeouts = items.filter(item => {
    const isGlobal = item.globalTimeoutUntilMs && item.globalTimeoutUntilMs > now;
    const isAsset = item.assetTimeouts && Object.values(item.assetTimeouts).some((a: any) => a.timeoutUntilMs > now);
    return isGlobal || isAsset || item.isManuallyDisabled;
  });

  const activeCount = activeTimeouts.length;
  const globalCount = items.filter(item => item.globalTimeoutUntilMs && item.globalTimeoutUntilMs > now).length;
  const assetCount = items.filter(item => item.assetTimeouts && Object.values(item.assetTimeouts).some((a: any) => a.timeoutUntilMs > now)).length;

  return (
    <div id="skinny-timeout-screen" className="crt-grid-panel relative overflow-hidden flex flex-col p-3 sm:p-4 my-2 border border-crypto-primary/40 bg-black/60 font-mono text-xs shadow-[0_0_15px_rgba(143,115,255,0.15)]">
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 relative z-10">
        {/* Left Side: Status & LED Counter */}
        <div className="flex items-center gap-3">
          <div className={`p-2 border ${
            activeCount > 0
              ? 'border-crypto-danger bg-crypto-danger/20 text-crypto-danger'
              : 'border-crypto-success bg-crypto-success/20 text-crypto-success'
          }`}>
            {activeCount > 0 ? (
              <ShieldAlert className="w-5 h-5 animate-pulse" />
            ) : (
              <CheckCircle2 className="w-5 h-5" />
            )}
          </div>

          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-bold uppercase tracking-wider text-crypto-text text-xs">
                &gt; TIME-OUT GUARD STATUS
              </span>
              <span className="px-1.5 py-0.5 border border-crypto-primary/50 text-crypto-primary bg-crypto-primary/10 text-[10px] uppercase font-bold tracking-widest">
                1m Global / 2.5m Asset
              </span>
            </div>

            <div className="flex items-baseline gap-2 mt-1">
              <span className={`text-xl font-bold font-mono ${activeCount > 0 ? 'text-crypto-danger animate-pulse' : 'text-crypto-success'}`}>
                {loading ? '--' : activeCount}
              </span>
              <span className="text-[11px] text-crypto-text uppercase tracking-wide">
                {activeCount === 1 ? 'FEATURE IN TIME-OUT' : 'FEATURES IN TIME-OUT'}
              </span>
            </div>

            <div className="text-[10px] text-[#808080] mt-0.5 flex items-center gap-2">
              <span>1m Global: <strong className="text-crypto-text">{globalCount}</strong></span>
              <span>|</span>
              <span>2.5m Asset: <strong className="text-crypto-text">{assetCount}</strong></span>
            </div>
          </div>
        </div>

        {/* Right Side: Machinery Emergency Override Button */}
        <div className="w-full sm:w-auto flex items-center justify-end">
          <button
            id="emergency-override-all-btn"
            onClick={handleOverrideAll}
            disabled={overriding}
            className={`w-full sm:w-auto font-mono font-bold text-xs px-4 py-2 border-2 transition-all flex items-center justify-center gap-2 cursor-pointer uppercase tracking-widest ${
              justCleared
                ? 'bg-crypto-success/20 border-crypto-success text-crypto-success shadow-[0_0_15px_rgba(0,255,157,0.5)]'
                : 'bg-crypto-danger border-crypto-danger text-white hover:bg-red-600 shadow-[0_0_20px_rgba(255,51,102,0.8)] animate-pulse active:scale-95'
            } disabled:opacity-50`}
            title="Machinery Emergency Override: Immediately clear all active global and asset timeouts"
          >
            {overriding ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                OVERRIDING...
              </>
            ) : justCleared ? (
              <>
                <CheckCircle2 className="w-3.5 h-3.5 text-crypto-success" />
                OVERRIDDEN!
              </>
            ) : (
              <>
                <Zap className="w-3.5 h-3.5 text-amber-300 fill-amber-300 animate-bounce" />
                <span>OVERRIDE ALL TIMEOUTS</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
