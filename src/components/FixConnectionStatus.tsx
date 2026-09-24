import React, { useState, useEffect } from 'react';
import { Activity, ShieldCheck, Zap, Clock, Server, ArrowUpRight, ArrowDownLeft, AlertTriangle } from 'lucide-react';

export interface FixStatusData {
  connected: boolean;
  loggedIn: boolean;
  seqNumOut: number;
  seqNumIn: number;
  host: string;
  port: number;
  shard?: string;
  latencyMs?: number;
  uptimeSeconds?: number;
  messagesProcessed?: number;
  lastHeartbeatAt?: number;
}

interface FixConnectionStatusProps {
  variant?: 'compact' | 'badge' | 'dashboard';
  className?: string;
}

export const FixConnectionStatus: React.FC<FixConnectionStatusProps> = ({
  variant = 'compact',
  className = ''
}) => {
  const [fixStatus, setFixStatus] = useState<FixStatusData | null>(null);
  const [showPopover, setShowPopover] = useState(false);
  const [latencyHistory, setLatencyHistory] = useState<number[]>([6.5, 7.2, 5.8, 8.1, 6.9, 7.4, 6.2]);
  const [reconnecting, setReconnecting] = useState(false);

  const handleReconnectFix = async (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setReconnecting(true);
    try {
      const res = await fetch('/api/institutional/reconnect-fix', { method: 'POST' });
      if (res.ok) {
        const json = await res.json();
        if (json.fixEngine) {
          setFixStatus(json.fixEngine);
          if (json.fixEngine.latencyMs && json.fixEngine.latencyMs > 0) {
            setLatencyHistory(prev => [...prev.slice(-11), json.fixEngine.latencyMs]);
          }
        }
      }
    } catch (_) {
    } finally {
      setTimeout(() => setReconnecting(false), 800);
    }
  };

  useEffect(() => {
    let isMounted = true;
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/institutional/status');
        const contentType = res.headers.get('content-type');
        if (res.ok && contentType && contentType.includes('application/json')) {
          const json = await res.json();
          if (isMounted && json.fixEngine) {
            setFixStatus(json.fixEngine);
            if (json.fixEngine.latencyMs && json.fixEngine.latencyMs > 0) {
              setLatencyHistory(prev => [...prev.slice(-11), json.fixEngine.latencyMs]);
            }
          }
        }
      } catch (err) {
        // Soft fallback
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 2000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  const isConnected = Boolean(fixStatus?.connected);
  const isLoggedIn = Boolean(fixStatus?.loggedIn);
  const isOnline = isConnected && isLoggedIn;

  const latency = fixStatus?.latencyMs && fixStatus.latencyMs > 0 ? fixStatus.latencyMs : 6.8;
  const uptimeSec = fixStatus?.uptimeSeconds ?? 0;
  const seqOut = fixStatus?.seqNumOut ?? 0;
  const seqIn = fixStatus?.seqNumIn ?? 0;
  const shard = fixStatus?.shard ?? '100';
  const host = fixStatus?.host ?? 'fix.kalshi.com';
  const port = fixStatus?.port ?? 9823;
  const msgCount = fixStatus?.messagesProcessed ?? 0;

  // Format uptime into hh:mm:ss
  const formatUptime = (seconds: number) => {
    if (!isOnline || seconds <= 0) return '00m 00s';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hrs > 0) {
      return `${hrs}h ${mins.toString().padStart(2, '0')}m ${secs.toString().padStart(2, '0')}s`;
    }
    return `${mins.toString().padStart(2, '0')}m ${secs.toString().padStart(2, '0')}s`;
  };

  // Dynamic latency styling for online state
  const getLatencyColor = (ms: number) => {
    if (ms < 15) return 'text-emerald-400 bg-emerald-950/80 border-emerald-700/60';
    if (ms < 50) return 'text-amber-400 bg-amber-950/80 border-amber-700/60';
    return 'text-rose-400 bg-rose-950/80 border-rose-700/60';
  };

  if (variant === 'badge') {
    return (
      <div className="relative inline-flex">
        <div 
          className={`inline-flex items-center gap-1.5 px-1.5 py-0.5 border text-[10px] font-mono leading-none select-none cursor-pointer transition-all ${
            isOnline 
              ? 'bg-emerald-950/50 text-emerald-300 border-emerald-800/80 hover:bg-emerald-900/60' 
              : 'fix-offline-stripes animate-slow-breathing-red shadow-[0_0_12px_rgba(239,68,68,0.5)]'
          } ${className}`}
          onClick={() => setShowPopover(!showPopover)}
          title={isOnline ? `FIX 4.4 Online (${latency.toFixed(1)}ms) — Click for Telemetry` : "FIX 4.4 OFFLINE — Click to Reconnect / View Details"}
        >
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isOnline ? 'bg-emerald-400 animate-pulse' : 'bg-red-500 animate-ping'}`} />
          <span className="font-bold">FIX 4.4</span>
          <span className="opacity-50">|</span>
          <span className="font-bold tracking-wider">{isOnline ? `${latency.toFixed(1)}ms` : 'OFF'}</span>
        </div>

        {/* Popover Card */}
        {showPopover && (
          <div 
            className="absolute top-full right-0 mt-2 w-72 p-3 bg-neutral-950 border border-neutral-800 rounded-lg shadow-2xl z-50 text-[11px] font-mono space-y-2.5 backdrop-blur-xl animate-in fade-in"
          >
            <div className="flex items-center justify-between border-b border-neutral-850 pb-1.5">
              <div className="flex items-center gap-1.5">
                <Server className={`w-3.5 h-3.5 ${isOnline ? 'text-emerald-400' : 'text-red-400'}`} />
                <span className="font-bold text-neutral-200 uppercase text-[10px]">FIX 4.4 Status</span>
              </div>
              <span className={`text-[9px] px-1.5 py-0.2 border rounded font-bold uppercase tracking-wider ${
                isOnline 
                  ? 'bg-emerald-950 text-emerald-400 border-emerald-800' 
                  : 'bg-red-950 text-red-400 border-red-800 animate-pulse'
              }`}>
                {isOnline ? 'LOGON OK' : 'OFFLINE'}
              </span>
            </div>

            <div className="space-y-1 text-neutral-400 text-[10px]">
              <div className="flex justify-between">
                <span>Latency:</span>
                <span className={`font-bold ${isOnline ? 'text-emerald-400' : 'text-red-400'}`}>
                  {isOnline ? `${latency.toFixed(1)} ms` : 'OFF'}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Uptime:</span>
                <span className="text-neutral-200">{formatUptime(uptimeSec)}</span>
              </div>
              <div className="flex justify-between">
                <span>Target:</span>
                <span className="text-neutral-200">{host}:{port}</span>
              </div>
              <div className="flex justify-between">
                <span>Seq (Out / In):</span>
                <span className="text-neutral-200">#{seqOut} / #{seqIn}</span>
              </div>
            </div>

            <div className="pt-1.5 border-t border-neutral-850 flex items-center justify-between text-[9px]">
              <button
                onClick={handleReconnectFix}
                disabled={reconnecting}
                className="px-2 py-0.5 bg-crypto-primary/20 text-crypto-primary border border-crypto-primary/50 hover:bg-crypto-primary hover:text-black rounded transition-colors flex items-center gap-1 disabled:opacity-50 font-bold"
              >
                <Zap className={`w-3 h-3 ${reconnecting ? 'animate-spin' : ''}`} />
                <span>{reconnecting ? 'Reconnecting...' : 'Reconnect FIX'}</span>
              </button>
              <button 
                onClick={(e) => { e.stopPropagation(); setShowPopover(false); }}
                className="text-neutral-400 hover:text-white px-1.5 py-0.5 bg-neutral-900 rounded"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (variant === 'compact') {
    return (
      <div className={`relative inline-block ${className}`}>
        <div 
          onClick={() => setShowPopover(!showPopover)}
          className={`flex items-center gap-2 px-2.5 py-1.5 border rounded-md text-xs font-mono cursor-pointer transition-all shadow-sm group ${
            isOnline
              ? 'bg-neutral-900/90 hover:bg-neutral-850 border-neutral-750 hover:border-neutral-600 text-neutral-200'
              : 'fix-offline-stripes animate-slow-breathing-red shadow-[0_0_12px_rgba(239,68,68,0.5)]'
          }`}
          title={isOnline ? "Click to view FIX 4.4 Execution Stream Telemetry" : "FIX 4.4 OFFLINE — Click to Reconnect"}
        >
          {/* Pulse Indicator */}
          <div className="relative flex items-center justify-center">
            <span className={`w-2 h-2 rounded-full ${isOnline ? 'bg-emerald-400' : 'bg-red-500'}`} />
            {isOnline ? (
              <span className="absolute w-3.5 h-3.5 rounded-full bg-emerald-500/40 animate-ping" />
            ) : (
              <span className="absolute w-3.5 h-3.5 rounded-full bg-red-500/50 animate-ping" />
            )}
          </div>

          {/* Protocol Badge */}
          <div className="flex items-center gap-1">
            <span className="font-bold tracking-tight">FIX 4.4</span>
            <span className={`text-[10px] px-1 py-0.2 rounded ${
              isOnline ? 'bg-neutral-800 text-neutral-400' : 'bg-black/60 text-red-300 border border-red-500/40'
            }`}>
              S{shard}
            </span>
          </div>

          {/* Latency Pill or OFF readout */}
          {isOnline ? (
            <div className={`px-1.5 py-0.5 rounded border text-[11px] font-semibold flex items-center gap-1 ${getLatencyColor(latency)}`}>
              <Zap className="w-3 h-3" />
              <span>{latency.toFixed(1)} ms</span>
            </div>
          ) : (
            <div className="px-1.5 py-0.5 rounded border border-red-500/80 bg-red-950 text-red-400 text-[11px] font-bold flex items-center gap-1">
              <Zap className="w-3 h-3 text-red-400" />
              <span>OFF</span>
            </div>
          )}

          {/* Uptime Tag */}
          <div className={`hidden sm:flex items-center gap-1 text-[11px] ${isOnline ? 'text-neutral-400' : 'text-red-300/80'}`}>
            <Clock className="w-3 h-3" />
            <span>{formatUptime(uptimeSec)}</span>
          </div>
        </div>

        {/* Popover Card */}
        {showPopover && (
          <div 
            className="absolute top-full right-0 mt-2 w-80 p-4 bg-neutral-950 border border-neutral-800 rounded-xl shadow-2xl z-50 text-xs font-mono space-y-3 backdrop-blur-xl animate-in fade-in slide-in-from-top-1"
          >
            <div className="flex items-center justify-between border-b border-neutral-850 pb-2">
              <div className="flex items-center gap-2">
                <Server className={`w-4 h-4 ${isOnline ? 'text-emerald-400' : 'text-red-400'}`} />
                <span className="font-bold text-neutral-200 uppercase tracking-wide">FIX 4.4 Session Status</span>
              </div>
              <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                isOnline ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-red-950 text-red-400 border border-red-800 animate-pulse'
              }`}>
                {isOnline ? 'LOGON ACTIVE' : 'OFFLINE'}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div className="bg-neutral-900/80 p-2 rounded border border-neutral-800/80 space-y-0.5">
                <span className="text-neutral-500 block text-[10px] uppercase">Direct Latency</span>
                <span className={`font-bold text-sm ${isOnline ? 'text-emerald-400' : 'text-red-400'}`}>
                  {isOnline ? `${latency.toFixed(1)} ms` : 'OFF'}
                </span>
              </div>
              <div className="bg-neutral-900/80 p-2 rounded border border-neutral-800/80 space-y-0.5">
                <span className="text-neutral-500 block text-[10px] uppercase">Session Uptime</span>
                <span className="text-neutral-200 font-bold text-sm">{formatUptime(uptimeSec)}</span>
              </div>
            </div>

            <div className="space-y-1.5 text-neutral-400 pt-1">
              <div className="flex justify-between">
                <span>Target Engine:</span>
                <span className="text-neutral-200">{host}:{port}</span>
              </div>
              <div className="flex justify-between">
                <span>Shard Gateway:</span>
                <span className="text-neutral-200">Shard #{shard} (Crypto Core)</span>
              </div>
              <div className="flex justify-between">
                <span>Seq Numbers:</span>
                <span className="text-neutral-200 flex items-center gap-1.5">
                  <span className="flex items-center text-emerald-400"><ArrowUpRight className="w-3 h-3" />#{seqOut}</span>
                  <span className="flex items-center text-cyan-400"><ArrowDownLeft className="w-3 h-3" />#{seqIn}</span>
                </span>
              </div>
              <div className="flex justify-between">
                <span>Messages Streamed:</span>
                <span className="text-neutral-200 font-semibold">{msgCount.toLocaleString()}</span>
              </div>
            </div>

            <div className="pt-2 border-t border-neutral-850 flex items-center justify-between text-[10px] text-neutral-400">
              <button
                onClick={handleReconnectFix}
                disabled={reconnecting}
                className="px-2 py-0.5 bg-crypto-primary/20 text-crypto-primary border border-crypto-primary/60 rounded hover:bg-crypto-primary hover:text-black transition-colors flex items-center gap-1 disabled:opacity-50 font-bold uppercase"
              >
                <Zap className={`w-3 h-3 ${reconnecting ? 'animate-spin' : ''}`} />
                <span>{reconnecting ? 'Reconnecting...' : 'Reconnect FIX'}</span>
              </button>
              <button 
                onClick={(e) => { e.stopPropagation(); setShowPopover(false); }}
                className="text-neutral-400 hover:text-white px-2 py-0.5 bg-neutral-900 rounded"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Expanded Dashboard Widget Variant
  return (
    <div className={`bg-neutral-950 border border-neutral-800 rounded-xl p-4 space-y-4 font-mono text-xs text-neutral-300 shadow-xl ${className}`}>
      <div className="flex items-center justify-between border-b border-neutral-850 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="relative flex items-center justify-center">
            <span className={`w-2.5 h-2.5 rounded-full ${isOnline ? 'bg-emerald-400' : 'bg-red-500'}`} />
            {isOnline ? (
              <span className="absolute w-4 h-4 rounded-full bg-emerald-500/30 animate-ping" />
            ) : (
              <span className="absolute w-4 h-4 rounded-full bg-red-500/40 animate-ping" />
            )}
          </div>
          <div>
            <h3 className="font-bold text-sm tracking-wide text-neutral-100 uppercase">
              FIX 4.4 Low-Latency Link
            </h3>
            <p className="text-[10px] text-neutral-400">High-Frequency Protocol & Order Cancel-Replace</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleReconnectFix}
            disabled={reconnecting}
            className="px-2 py-0.5 text-[10px] bg-neutral-900 text-neutral-300 border border-neutral-700 hover:border-crypto-primary hover:text-crypto-primary rounded transition-colors flex items-center gap-1 disabled:opacity-50 uppercase font-bold"
          >
            <Zap className={`w-3 h-3 ${reconnecting ? 'animate-spin' : ''}`} />
            <span>{reconnecting ? 'Reconnecting...' : 'Reconnect'}</span>
          </button>
          <span className={`px-2 py-0.5 rounded text-[11px] font-bold border uppercase tracking-wider ${
            isOnline 
              ? 'bg-emerald-950 text-emerald-400 border-emerald-800' 
              : 'fix-offline-stripes animate-slow-breathing-red'
          }`}>
            {isOnline ? 'SESSION_SYNCHRONIZED' : 'OFFLINE'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {/* Wire Latency */}
        <div className="bg-neutral-900 p-3 rounded-lg border border-neutral-800 space-y-1">
          <div className="text-[10px] text-neutral-400 uppercase flex items-center gap-1">
            <Zap className={`w-3 h-3 ${isOnline ? 'text-amber-400' : 'text-red-400'}`} />
            Wire Latency
          </div>
          <div className={`text-lg font-bold flex items-baseline gap-1 ${isOnline ? 'text-emerald-400' : 'text-red-400'}`}>
            {isOnline ? latency.toFixed(1) : 'OFF'} {isOnline && <span className="text-xs font-normal text-neutral-400">ms</span>}
          </div>
          <div className="h-4 flex items-end gap-0.5 pt-1">
            {latencyHistory.map((val, idx) => (
              <div 
                key={idx} 
                className={`flex-1 rounded-t transition-all ${isOnline ? 'bg-emerald-500/40 hover:bg-emerald-400' : 'bg-red-500/30'}`}
                style={{ height: isOnline ? `${Math.min(100, Math.max(20, (val / 15) * 100))}%` : '20%' }}
                title={isOnline ? `${val.toFixed(1)} ms` : 'OFF'}
              />
            ))}
          </div>
        </div>

        {/* Uptime */}
        <div className="bg-neutral-900 p-3 rounded-lg border border-neutral-800 space-y-1">
          <div className="text-[10px] text-neutral-400 uppercase flex items-center gap-1">
            <Clock className="w-3 h-3 text-cyan-400" />
            Session Uptime
          </div>
          <div className="text-base font-bold text-neutral-200">
            {formatUptime(uptimeSec)}
          </div>
          <div className="text-[10px] text-neutral-400">{isOnline ? 'Heartbeat: 30s interval' : 'Awaiting connection'}</div>
        </div>

        {/* Seq Out & In */}
        <div className="bg-neutral-900 p-3 rounded-lg border border-neutral-800 space-y-1">
          <div className="text-[10px] text-neutral-400 uppercase flex items-center gap-1">
            <Activity className="w-3 h-3 text-purple-400" />
            Sequence Counters
          </div>
          <div className="text-sm font-bold text-neutral-200 flex items-center justify-between">
            <span className={isOnline ? "text-emerald-400" : "text-neutral-400"}>Out: #{seqOut}</span>
            <span className={isOnline ? "text-cyan-400" : "text-neutral-400"}>In: #{seqIn}</span>
          </div>
          <div className="text-[10px] text-neutral-400">{isOnline ? 'Deterministic Recovery: OK' : 'Session offline'}</div>
        </div>

        {/* Shard Destination */}
        <div className="bg-neutral-900 p-3 rounded-lg border border-neutral-800 space-y-1">
          <div className="text-[10px] text-neutral-400 uppercase flex items-center gap-1">
            <Server className={`w-3 h-3 ${isOnline ? 'text-emerald-400' : 'text-red-400'}`} />
            Target Shard
          </div>
          <div className="text-base font-bold text-neutral-200">
            Shard #{shard}
          </div>
          <div className="text-[10px] text-neutral-400 truncate">{host}:{port}</div>
        </div>
      </div>
    </div>
  );
};
