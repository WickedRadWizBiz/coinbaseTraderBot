import React, { useEffect, useState } from 'react';
import { 
  Layers, 
  ShieldAlert, 
  Zap, 
  Activity, 
  CheckCircle2, 
  AlertTriangle, 
  Flame, 
  Clock, 
  FilterX, 
  RefreshCw,
  Gauge
} from 'lucide-react';

export interface DropLogEntry {
  id: string;
  time: string;
  type: string;
  priority: 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';
  symbol?: string;
  reason: string;
}

export interface BackpressureStats {
  queueDepth: number;
  maxCapacity: number;
  saturationPct: number;
  status: 'OPTIMAL' | 'THROTTLED' | 'SHEDDING_LOAD' | 'CIRCUIT_TRIPPED';
  depthByPriority: {
    CRITICAL: number;
    HIGH: number;
    NORMAL: number;
    LOW: number;
  };
  totalProcessed: number;
  totalDropped: number;
  droppedByPriority: {
    CRITICAL: number;
    HIGH: number;
    NORMAL: number;
    LOW: number;
  };
  throughputReqSec: number;
  circuitBreaker: {
    state: 'CLOSED' | 'HALF_OPEN' | 'OPEN';
    failureCount: number;
    lastTripTime: number | null;
    cooldownRemainingMs: number;
  };
  recentDropLogs: DropLogEntry[];
}

export function BackpressureMonitor() {
  const [stats, setStats] = useState<BackpressureStats | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [showLogs, setShowLogs] = useState<boolean>(false);

  useEffect(() => {
    let isMounted = true;
    const fetchStats = () => {
      if (document.hidden) return;
      fetch('/api/backpressure-status')
        .then(res => {
          if (!res.ok) return null;
          return res.json().catch(() => null);
        })
        .then(data => {
          if (data && isMounted) {
            setStats(data);
            setIsLoading(false);
          }
        })
        .catch(() => {});
    };

    fetchStats();
    const interval = setInterval(fetchStats, 2500);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  const getStatusBadge = (status: BackpressureStats['status']) => {
    switch (status) {
      case 'OPTIMAL':
        return (
          <span className="flex items-center gap-1.5 px-2.5 py-1 bg-emerald-950/80 text-emerald-400 border border-emerald-500/40 text-[11px] font-bold uppercase tracking-wider rounded-sm shadow-[0_0_10px_rgba(16,185,129,0.15)]">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
            OPTIMAL • FLOW CLEAR
          </span>
        );
      case 'THROTTLED':
        return (
          <span className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-950/80 text-amber-400 border border-amber-500/40 text-[11px] font-bold uppercase tracking-wider rounded-sm shadow-[0_0_10px_rgba(245,158,11,0.15)]">
            <Zap className="w-3.5 h-3.5 text-amber-400 animate-pulse" />
            RATE-PACED (5 REQ/S)
          </span>
        );
      case 'SHEDDING_LOAD':
        return (
          <span className="flex items-center gap-1.5 px-2.5 py-1 bg-rose-950/90 text-rose-300 border border-rose-500/60 text-[11px] font-bold uppercase tracking-wider rounded-sm animate-pulse shadow-[0_0_15px_rgba(244,63,94,0.3)]">
            <Flame className="w-3.5 h-3.5 text-rose-400" />
            SHEDDING NON-ESSENTIAL LOAD
          </span>
        );
      case 'CIRCUIT_TRIPPED':
        return (
          <span className="flex items-center gap-1.5 px-2.5 py-1 bg-red-950 text-red-400 border border-red-500 font-bold text-[11px] uppercase tracking-wider rounded-sm shadow-[0_0_20px_rgba(239,68,68,0.4)]">
            <ShieldAlert className="w-3.5 h-3.5 text-red-500 animate-bounce" />
            CIRCUIT BREAKER OPEN (429 BACKOFF)
          </span>
        );
      default:
        return null;
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'CRITICAL': return 'text-rose-400 border-rose-500/40 bg-rose-950/40';
      case 'HIGH': return 'text-amber-400 border-amber-500/40 bg-amber-950/40';
      case 'NORMAL': return 'text-indigo-300 border-indigo-500/40 bg-indigo-950/40';
      case 'LOW': return 'text-slate-400 border-slate-700/50 bg-slate-900/40';
      default: return 'text-slate-300 border-slate-700 bg-slate-900';
    }
  };

  const saturation = stats?.saturationPct || 0;
  const saturationColor = saturation > 75 
    ? 'bg-rose-500 shadow-[0_0_10px_#f43f5e]' 
    : saturation > 40 
      ? 'bg-amber-400 shadow-[0_0_10px_#f59e0b]' 
      : 'bg-emerald-400 shadow-[0_0_10px_#10b981]';

  return (
    <div className="crt-grid-panel p-4 flex flex-col gap-4 bg-[#0a0d14]/90 border border-crypto-primary/30 relative overflow-hidden text-crypto-primary font-mono text-xs">
      <div className="absolute top-0 right-0 w-48 h-48 bg-gradient-to-bl from-crypto-primary/5 via-transparent to-transparent pointer-events-none" />

      {/* Top Header Row */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 pb-3 border-b border-crypto-primary/20">
        <div className="flex items-center gap-2.5">
          <div className="p-2 bg-crypto-primary/10 rounded-sm border border-crypto-primary/30">
            <Layers className="w-5 h-5 text-crypto-primary animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold uppercase tracking-[0.15em] text-crypto-text">
                Backpressure & Queue Telemetry
              </h3>
              <span className="text-[10px] px-1.5 py-0.5 bg-crypto-primary/10 text-crypto-primary/80 border border-crypto-primary/20 uppercase tracking-widest font-mono">
                SLA Guardian
              </span>
            </div>
            <p className="text-[11px] text-slate-400 font-sans mt-0.5">
              Priority-tier rate pacing with automatic shedding of non-essential quote polls under exchange load.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 self-stretch sm:self-auto justify-between sm:justify-end">
          {stats && getStatusBadge(stats.status)}
          <button
            onClick={() => setShowLogs(!showLogs)}
            className={`px-2.5 py-1 text-[10px] uppercase font-bold tracking-wider rounded-sm transition flex items-center gap-1.5 border ${
              showLogs 
                ? 'bg-crypto-primary text-black border-crypto-primary' 
                : 'bg-black/40 text-crypto-primary hover:bg-crypto-primary/20 border-crypto-primary/30'
            }`}
          >
            <FilterX className="w-3 h-3" />
            <span>{showLogs ? 'Hide Drop Logs' : `Drop Logs (${stats?.totalDropped || 0})`}</span>
          </button>
        </div>
      </div>

      {/* Main Queue Metrics & Saturation */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        {/* Metric 1: Queue Depth */}
        <div className="p-3 bg-black/40 border border-slate-800/80 rounded-sm flex flex-col justify-between">
          <div className="flex justify-between items-center text-[10px] text-slate-400 uppercase tracking-wider">
            <span>Queue Depth</span>
            <Layers className="w-3.5 h-3.5 text-slate-500" />
          </div>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-xl font-bold font-mono text-crypto-text">
              {stats?.queueDepth ?? 0}
            </span>
            <span className="text-[10px] text-slate-500 font-mono">
              / {stats?.maxCapacity ?? 35} max
            </span>
          </div>
          <div className="mt-2 w-full bg-slate-800/80 h-1.5 rounded-full overflow-hidden">
            <div 
              className={`h-full transition-all duration-300 ${saturationColor}`}
              style={{ width: `${Math.max(4, saturation)}%` }}
            />
          </div>
        </div>

        {/* Metric 2: Throughput */}
        <div className="p-3 bg-black/40 border border-slate-800/80 rounded-sm flex flex-col justify-between">
          <div className="flex justify-between items-center text-[10px] text-slate-400 uppercase tracking-wider">
            <span>Throughput</span>
            <Gauge className="w-3.5 h-3.5 text-slate-500" />
          </div>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-xl font-bold font-mono text-emerald-400">
              {stats?.throughputReqSec.toFixed(1) ?? '0.0'}
            </span>
            <span className="text-[10px] text-slate-500 font-mono">req / sec</span>
          </div>
          <div className="mt-2 text-[10px] text-slate-400 flex justify-between font-mono">
            <span>Processed:</span>
            <span className="text-slate-200 font-bold">{stats?.totalProcessed ?? 0}</span>
          </div>
        </div>

        {/* Metric 3: Dropped Load */}
        <div className="p-3 bg-black/40 border border-slate-800/80 rounded-sm flex flex-col justify-between">
          <div className="flex justify-between items-center text-[10px] text-slate-400 uppercase tracking-wider">
            <span>Non-Essential Shed</span>
            <FilterX className="w-3.5 h-3.5 text-slate-500" />
          </div>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className={`text-xl font-bold font-mono ${(stats?.totalDropped || 0) > 0 ? 'text-amber-400' : 'text-slate-400'}`}>
              {stats?.totalDropped ?? 0}
            </span>
            <span className="text-[10px] text-slate-500 font-mono">requests</span>
          </div>
          <div className="mt-2 text-[10px] text-slate-400 flex justify-between font-mono">
            <span>Drop Protection:</span>
            <span className="text-emerald-400 font-bold">ACTIVE</span>
          </div>
        </div>

        {/* Metric 4: Circuit Breaker */}
        <div className="p-3 bg-black/40 border border-slate-800/80 rounded-sm flex flex-col justify-between">
          <div className="flex justify-between items-center text-[10px] text-slate-400 uppercase tracking-wider">
            <span>Circuit Breaker</span>
            <ShieldAlert className="w-3.5 h-3.5 text-slate-500" />
          </div>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className={`text-base font-bold font-mono ${
              stats?.circuitBreaker.state === 'OPEN' 
                ? 'text-rose-400 animate-pulse' 
                : stats?.circuitBreaker.state === 'HALF_OPEN'
                  ? 'text-amber-400'
                  : 'text-emerald-400'
            }`}>
              {stats?.circuitBreaker.state ?? 'CLOSED'}
            </span>
          </div>
          <div className="mt-2 text-[10px] text-slate-400 flex justify-between font-mono">
            <span>429 Trips:</span>
            <span className="text-slate-200 font-bold">{stats?.circuitBreaker.failureCount ?? 0}</span>
          </div>
        </div>
      </div>

      {/* Priority Tiers Breakdown Matrix */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-[11px] uppercase tracking-wider text-slate-400">
          <span className="flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5 text-crypto-primary" />
            Active Priority Tiers & Queue Allocation
          </span>
          <span className="text-[10px] text-slate-500 lowercase">
            auto-prioritized execution
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-2">
          {/* Tier 1: CRITICAL */}
          <div className={`p-2.5 rounded-sm border ${getPriorityColor('CRITICAL')} flex flex-col justify-between`}>
            <div className="flex items-center justify-between">
              <span className="font-bold text-[11px] tracking-wider">CRITICAL</span>
              <span className="text-[9px] px-1 py-0.2 bg-rose-900/60 text-rose-200 uppercase font-mono rounded">
                Tier 1
              </span>
            </div>
            <div className="text-[10px] text-slate-300/80 font-sans mt-1">
              Stop-losses, TP exits, cancels
            </div>
            <div className="mt-2 pt-1.5 border-t border-rose-500/20 flex justify-between items-center text-[10px] font-mono">
              <span className="text-slate-400">Pending:</span>
              <span className="font-bold text-rose-300">{stats?.depthByPriority.CRITICAL ?? 0}</span>
            </div>
            <div className="flex justify-between items-center text-[10px] font-mono text-slate-400">
              <span>SLA Target:</span>
              <span className="text-emerald-400 font-bold">100% (No Drop)</span>
            </div>
          </div>

          {/* Tier 2: HIGH */}
          <div className={`p-2.5 rounded-sm border ${getPriorityColor('HIGH')} flex flex-col justify-between`}>
            <div className="flex items-center justify-between">
              <span className="font-bold text-[11px] tracking-wider">HIGH</span>
              <span className="text-[9px] px-1 py-0.2 bg-amber-900/60 text-amber-200 uppercase font-mono rounded">
                Tier 2
              </span>
            </div>
            <div className="text-[10px] text-slate-300/80 font-sans mt-1">
              Live market order entries & fills
            </div>
            <div className="mt-2 pt-1.5 border-t border-amber-500/20 flex justify-between items-center text-[10px] font-mono">
              <span className="text-slate-400">Pending:</span>
              <span className="font-bold text-amber-300">{stats?.depthByPriority.HIGH ?? 0}</span>
            </div>
            <div className="flex justify-between items-center text-[10px] font-mono text-slate-400">
              <span>SLA Target:</span>
              <span className="text-emerald-400 font-bold">100% (No Drop)</span>
            </div>
          </div>

          {/* Tier 3: NORMAL */}
          <div className={`p-2.5 rounded-sm border ${getPriorityColor('NORMAL')} flex flex-col justify-between`}>
            <div className="flex items-center justify-between">
              <span className="font-bold text-[11px] tracking-wider">NORMAL</span>
              <span className="text-[9px] px-1 py-0.2 bg-indigo-900/60 text-indigo-200 uppercase font-mono rounded">
                Tier 3
              </span>
            </div>
            <div className="text-[10px] text-slate-300/80 font-sans mt-1">
              Resting limits, balance syncs
            </div>
            <div className="mt-2 pt-1.5 border-t border-indigo-500/20 flex justify-between items-center text-[10px] font-mono">
              <span className="text-slate-400">Pending:</span>
              <span className="font-bold text-indigo-200">{stats?.depthByPriority.NORMAL ?? 0}</span>
            </div>
            <div className="flex justify-between items-center text-[10px] font-mono text-slate-400">
              <span>Dropped:</span>
              <span className="text-slate-200 font-bold">{stats?.droppedByPriority.NORMAL ?? 0}</span>
            </div>
          </div>

          {/* Tier 4: LOW */}
          <div className={`p-2.5 rounded-sm border ${getPriorityColor('LOW')} flex flex-col justify-between`}>
            <div className="flex items-center justify-between">
              <span className="font-bold text-[11px] tracking-wider">LOW</span>
              <span className="text-[9px] px-1 py-0.2 bg-slate-800 text-slate-300 uppercase font-mono rounded">
                Tier 4
              </span>
            </div>
            <div className="text-[10px] text-slate-400 font-sans mt-1">
              Quote polls, telemetry updates
            </div>
            <div className="mt-2 pt-1.5 border-t border-slate-700/50 flex justify-between items-center text-[10px] font-mono">
              <span className="text-slate-400">Pending:</span>
              <span className="font-bold text-slate-300">{stats?.depthByPriority.LOW ?? 0}</span>
            </div>
            <div className="flex justify-between items-center text-[10px] font-mono text-slate-400">
              <span>Auto-Shed:</span>
              <span className={`font-bold ${(stats?.droppedByPriority.LOW || 0) > 0 ? 'text-amber-400' : 'text-slate-400'}`}>
                {stats?.droppedByPriority.LOW ?? 0}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Expandable Dropped Request Activity Stream */}
      {showLogs && (
        <div className="mt-1 p-3 bg-black/60 border border-slate-800 rounded-sm flex flex-col gap-2">
          <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-slate-300">
            <span className="flex items-center gap-1.5 text-amber-400">
              <AlertTriangle className="w-3.5 h-3.5" />
              Shedded Request Log (Under Load / 429 Protection)
            </span>
            <span className="text-[10px] text-slate-500 font-mono">
              Showing last {stats?.recentDropLogs.length || 0} events
            </span>
          </div>

          {(!stats?.recentDropLogs || stats.recentDropLogs.length === 0) ? (
            <div className="py-4 text-center text-slate-500 text-[11px] italic font-mono flex items-center justify-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-500/60" />
              Zero dropped requests. All inbound orderbook and telemetry streams running within rate capacity.
            </div>
          ) : (
            <div className="max-h-48 overflow-y-auto custom-scrollbar flex flex-col gap-1.5 pr-1 font-mono text-[10.5px]">
              {stats.recentDropLogs.map(log => (
                <div 
                  key={log.id} 
                  className="p-2 bg-slate-950/80 border border-slate-800/80 rounded flex flex-col sm:flex-row justify-between items-start sm:items-center gap-1 text-slate-300"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] text-slate-500 font-mono">
                      {new Date(log.time).toLocaleTimeString()}
                    </span>
                    <span className={`px-1.5 py-0.2 text-[9px] font-bold rounded ${
                      log.priority === 'CRITICAL' ? 'bg-rose-950 text-rose-400' :
                      log.priority === 'HIGH' ? 'bg-amber-950 text-amber-400' :
                      log.priority === 'NORMAL' ? 'bg-indigo-950 text-indigo-300' :
                      'bg-slate-800 text-slate-400'
                    }`}>
                      {log.priority}
                    </span>
                    <span className="text-crypto-text font-bold">[{log.type}]</span>
                    {log.symbol && <span className="text-crypto-primary">({log.symbol})</span>}
                  </div>
                  <div className="text-[10px] text-slate-400 leading-tight">
                    {log.reason}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
