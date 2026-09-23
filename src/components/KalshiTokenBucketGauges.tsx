import React, { useEffect, useState } from 'react';
import {
  Zap,
  ShieldCheck,
  CheckCircle2,
  Cpu,
  Layers,
  Sparkles,
  RefreshCw,
  AlertTriangle,
  Lock,
  ExternalLink,
  Activity,
  Award
} from 'lucide-react';

export type RateLimitTier = 
  | 'Basic' 
  | 'Advanced' 
  | 'Expert' 
  | 'Premier' 
  | 'Paragon' 
  | 'Prime' 
  | 'Prestige';

export type BucketType = 
  | 'PREDICTIONS_READ' 
  | 'PREDICTIONS_WRITE' 
  | 'PERPS_READ' 
  | 'PERPS_WRITE';

export interface BucketStats {
  tokens: number;
  maxCapacity: number;
  fillPercentage: number;
  refillRatePerSec: number;
  burstCapacity: number;
  status: 'OPTIMAL' | 'CONSTRAINED' | 'DRAINED' | 'CIRCUIT_OPEN';
  totalTokensConsumed: number;
  totalRequestsServed: number;
  totalRequestsShed: number;
  total429s: number;
}

export interface KalshiRateLimiterStats {
  tier: RateLimitTier;
  tierSource: 'AUTO_DETECTED' | 'CONFIGURED_DEFAULT';
  lastTierCheckTime: number;
  rawLimits?: any;
  buckets: Record<BucketType, BucketStats>;
  throughput: {
    tokensConsumedPerSec: number;
    requestsPerSec: number;
  };
  totalShedded: number;
  totalProcessed: number;
}

export function KalshiTokenBucketGauges() {
  const [stats, setStats] = useState<KalshiRateLimiterStats | null>(null);
  const [isUpgrading, setIsUpgrading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  const fetchStats = () => {
    if (document.hidden) return;
    fetch('/api/kalshi/rate-limits')
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        if (data) setStats(data);
      })
      .catch(() => {});
  };

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 1200);
    return () => clearInterval(interval);
  }, []);

  const handleSyncLimits = async () => {
    setIsSyncing(true);
    setActionMsg(null);
    try {
      const res = await fetch('/api/kalshi/sync-limits', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setActionMsg({
          type: 'success',
          text: `Verified live Kalshi tier: ${data.tier || data.stats?.tier || 'Basic'} (${data.limits?.read_limit || 200} R / ${data.limits?.write_limit || 100} W tokens/sec)`
        });
        if (data.stats) setStats(data.stats);
      } else {
        setActionMsg({
          type: 'error',
          text: `Kalshi Limits API: ${data.error || 'Failed to query /account/limits'}`
        });
      }
    } catch (e: any) {
      setActionMsg({ type: 'error', text: `Sync Error: ${e.message}` });
    } finally {
      setIsSyncing(false);
      fetchStats();
    }
  };

  const handleUpgradeTier = async () => {
    setIsUpgrading(true);
    setActionMsg(null);
    try {
      const res = await fetch('/api/kalshi/upgrade-tier', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setActionMsg({
          type: 'success',
          text: 'Promoted account to Advanced tier (300 Read / 300 Write TPS with 3x Burst Banking) via Kalshi API'
        });
      } else {
        setActionMsg({
          type: 'error',
          text: `Kalshi Upgrade API: ${data.error || 'Account may already be upgraded or API key lacks permissions.'}`
        });
      }
    } catch (e: any) {
      setActionMsg({ type: 'error', text: `Upgrade Error: ${e.message}` });
    } finally {
      setIsUpgrading(false);
      fetchStats();
    }
  };

  const getBucketColor = (fill: number, status: string) => {
    if (status === 'CIRCUIT_OPEN') return 'bg-rose-500 shadow-[0_0_12px_#f43f5e]';
    if (fill < 20) return 'bg-rose-500 shadow-[0_0_10px_#f43f5e]';
    if (fill < 50) return 'bg-amber-400 shadow-[0_0_10px_#f59e0b]';
    return 'bg-emerald-400 shadow-[0_0_10px_#10b981]';
  };

  const buckets = stats?.buckets;
  const isBasic = (stats?.tier || 'Basic') === 'Basic';

  return (
    <div className="crt-grid-panel p-4 flex flex-col gap-4 bg-[#080b11]/95 border border-crypto-primary/40 relative overflow-hidden font-mono text-xs text-crypto-primary">
      <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-bl from-emerald-500/5 via-cyan-500/5 to-transparent pointer-events-none" />

      {/* Header */}
      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-3 pb-3 border-b border-crypto-primary/20">
        <div className="flex items-center gap-2.5">
          <div className="p-2 bg-crypto-primary/10 rounded border border-crypto-primary/30">
            <Zap className="w-5 h-5 text-crypto-primary animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-bold uppercase tracking-[0.15em] text-crypto-text">
                Kalshi Token Bucket Rate Governor
              </h3>
              <span className={`text-[10px] px-2 py-0.5 font-bold uppercase tracking-wider rounded border flex items-center gap-1 ${
                isBasic 
                  ? 'bg-amber-950/80 text-amber-300 border-amber-500/40' 
                  : 'bg-emerald-950/80 text-emerald-400 border-emerald-500/40'
              }`}>
                <ShieldCheck className="w-3 h-3" />
                Live Tier: {stats?.tier || 'Basic'} {stats?.tierSource === 'AUTO_DETECTED' ? '(Kalshi Verified)' : '(Default)'}
              </span>
            </div>
            <p className="text-[11px] text-slate-400 font-sans mt-0.5">
              Live token metering based strictly on Kalshi's exchange rules. Enforces 4 independent sharded buckets, dynamic continuous refill, and burst capacity banking.
            </p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex flex-wrap items-center gap-2 self-stretch lg:self-auto justify-end">
          <button
            onClick={handleSyncLimits}
            disabled={isSyncing}
            className="px-2.5 py-1.5 bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-700 font-bold uppercase tracking-wider text-[11px] rounded transition flex items-center gap-1.5 disabled:opacity-50"
            title="Query GET /account/limits to verify live rate limits from Kalshi"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin text-cyan-400' : ''}`} />
            <span>{isSyncing ? 'Syncing...' : 'Sync Live Tier'}</span>
          </button>

          {isBasic && (
            <button
              onClick={handleUpgradeTier}
              disabled={isUpgrading}
              className="px-3 py-1.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-black font-bold uppercase tracking-wider text-[11px] rounded transition flex items-center gap-1.5 shadow-[0_0_15px_rgba(16,185,129,0.3)] disabled:opacity-50"
              title="Calls POST /account/api_usage_level/upgrade on external-api.kalshi.com. Requirement: At least 1 of last 100 Predictions orders placed via API."
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{isUpgrading ? 'Upgrading...' : 'Upgrade to Advanced Tier'}</span>
            </button>
          )}
        </div>
      </div>

      {isBasic && (
        <div className="text-[10px] text-slate-400 bg-slate-900/60 border border-slate-800 rounded px-2.5 py-1.5 flex items-center justify-between flex-wrap gap-2">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400" />
            <span>
              <strong className="text-slate-300">Kalshi Upgrade Rule:</strong> Upgrade endpoint (<code>POST /account/api_usage_level/upgrade</code>) permanently grants 300 Read/Write TPS. Kalshi requires that at least 1 of your last 100 Predictions orders was placed via API.
            </span>
          </span>
          <a
            href="https://docs.kalshi.com/api-reference/account/upgrade-account-api-usage-level"
            target="_blank"
            rel="noopener noreferrer"
            className="text-cyan-400 hover:text-cyan-300 underline font-mono text-[9.5px]"
          >
            Official Kalshi Docs ↗
          </a>
        </div>
      )}

      {actionMsg && (
        <div className={`p-2 rounded text-[11px] flex items-center gap-2 border ${
          actionMsg.type === 'success' 
            ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-300' 
            : actionMsg.type === 'error'
            ? 'bg-rose-950/60 border-rose-500/40 text-rose-300'
            : 'bg-cyan-950/60 border-cyan-500/40 text-cyan-300'
        }`}>
          {actionMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> : <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />}
          <span>{actionMsg.text}</span>
        </div>
      )}

      {/* 4 Independent Token Buckets Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {/* Bucket 1: PREDICTIONS_READ */}
        {buckets?.PREDICTIONS_READ && (
          <div className="p-3 bg-black/40 border border-slate-800/90 rounded flex flex-col justify-between relative overflow-hidden">
            <div className="flex justify-between items-start">
              <div>
                <span className="text-[11px] font-bold text-slate-200 uppercase tracking-wider block">
                  Predictions Read
                </span>
                <span className="text-[9.5px] text-slate-500 font-sans">
                  GET /markets, /events, /portfolio
                </span>
              </div>
              <span className="text-[9px] px-1.5 py-0.5 bg-slate-800 text-slate-300 font-mono rounded">
                1s Capacity ({buckets.PREDICTIONS_READ.burstCapacity} tok)
              </span>
            </div>

            <div className="mt-3 flex items-baseline justify-between">
              <div className="flex items-baseline gap-1">
                <span className="text-xl font-bold font-mono text-crypto-text">
                  {buckets.PREDICTIONS_READ.tokens}
                </span>
                <span className="text-[10px] text-slate-500">
                  / {buckets.PREDICTIONS_READ.maxCapacity} tokens
                </span>
              </div>
              <span className="text-[11px] font-bold font-mono text-emerald-400">
                {buckets.PREDICTIONS_READ.fillPercentage}%
              </span>
            </div>

            <div className="mt-2 w-full bg-slate-800/80 h-2 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-200 ${getBucketColor(
                  buckets.PREDICTIONS_READ.fillPercentage,
                  buckets.PREDICTIONS_READ.status
                )}`}
                style={{ width: `${Math.max(4, buckets.PREDICTIONS_READ.fillPercentage)}%` }}
              />
            </div>

            <div className="mt-3 pt-2 border-t border-slate-800/60 flex justify-between text-[10px] text-slate-400">
              <span>Refill: +{buckets.PREDICTIONS_READ.refillRatePerSec} tok/s</span>
              <span>Reqs Served: {buckets.PREDICTIONS_READ.totalRequestsServed}</span>
            </div>
          </div>
        )}

        {/* Bucket 2: PREDICTIONS_WRITE */}
        {buckets?.PREDICTIONS_WRITE && (
          <div className="p-3 bg-black/40 border border-slate-800/90 rounded flex flex-col justify-between relative overflow-hidden">
            <div className="flex justify-between items-start">
              <div>
                <span className="text-[11px] font-bold text-amber-300 uppercase tracking-wider block">
                  Predictions Write
                </span>
                <span className="text-[9.5px] text-slate-500 font-sans">
                  POST/DEL /orders, transfers
                </span>
              </div>
              <span className="text-[9px] px-1.5 py-0.5 bg-amber-950/80 text-amber-300 border border-amber-500/30 font-mono rounded">
                {isBasic ? '1s Capacity' : '3s Bank'} ({buckets.PREDICTIONS_WRITE.burstCapacity} tok)
              </span>
            </div>

            <div className="mt-3 flex items-baseline justify-between">
              <div className="flex items-baseline gap-1">
                <span className="text-xl font-bold font-mono text-crypto-text">
                  {buckets.PREDICTIONS_WRITE.tokens}
                </span>
                <span className="text-[10px] text-slate-500">
                  / {buckets.PREDICTIONS_WRITE.maxCapacity} tokens
                </span>
              </div>
              <span className="text-[11px] font-bold font-mono text-amber-400">
                {buckets.PREDICTIONS_WRITE.fillPercentage}%
              </span>
            </div>

            <div className="mt-2 w-full bg-slate-800/80 h-2 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-200 ${getBucketColor(
                  buckets.PREDICTIONS_WRITE.fillPercentage,
                  buckets.PREDICTIONS_WRITE.status
                )}`}
                style={{ width: `${Math.max(4, buckets.PREDICTIONS_WRITE.fillPercentage)}%` }}
              />
            </div>

            <div className="mt-3 pt-2 border-t border-slate-800/60 flex justify-between text-[10px] text-slate-400">
              <span>Refill: +{buckets.PREDICTIONS_WRITE.refillRatePerSec} tok/s</span>
              <span>Orders: {buckets.PREDICTIONS_WRITE.totalRequestsServed}</span>
            </div>
          </div>
        )}

        {/* Bucket 3: PERPS_READ */}
        {buckets?.PERPS_READ && (
          <div className="p-3 bg-black/40 border border-slate-800/90 rounded flex flex-col justify-between relative overflow-hidden">
            <div className="flex justify-between items-start">
              <div>
                <span className="text-[11px] font-bold text-cyan-300 uppercase tracking-wider block">
                  Perps Read
                </span>
                <span className="text-[9.5px] text-slate-500 font-sans">
                  GET /margin/markets, orderbook
                </span>
              </div>
              <span className="text-[9px] px-1.5 py-0.5 bg-cyan-950/80 text-cyan-300 border border-cyan-500/30 font-mono rounded">
                1s Capacity ({buckets.PERPS_READ.burstCapacity} tok)
              </span>
            </div>

            <div className="mt-3 flex items-baseline justify-between">
              <div className="flex items-baseline gap-1">
                <span className="text-xl font-bold font-mono text-crypto-text">
                  {buckets.PERPS_READ.tokens}
                </span>
                <span className="text-[10px] text-slate-500">
                  / {buckets.PERPS_READ.maxCapacity} tokens
                </span>
              </div>
              <span className="text-[11px] font-bold font-mono text-cyan-400">
                {buckets.PERPS_READ.fillPercentage}%
              </span>
            </div>

            <div className="mt-2 w-full bg-slate-800/80 h-2 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-200 ${getBucketColor(
                  buckets.PERPS_READ.fillPercentage,
                  buckets.PERPS_READ.status
                )}`}
                style={{ width: `${Math.max(4, buckets.PERPS_READ.fillPercentage)}%` }}
              />
            </div>

            <div className="mt-3 pt-2 border-t border-slate-800/60 flex justify-between text-[10px] text-slate-400">
              <span>Refill: +{buckets.PERPS_READ.refillRatePerSec} tok/s</span>
              <span>Quotes: {buckets.PERPS_READ.totalRequestsServed}</span>
            </div>
          </div>
        )}

        {/* Bucket 4: PERPS_WRITE */}
        {buckets?.PERPS_WRITE && (
          <div className="p-3 bg-black/40 border border-slate-800/90 rounded flex flex-col justify-between relative overflow-hidden">
            <div className="flex justify-between items-start">
              <div>
                <span className="text-[11px] font-bold text-rose-300 uppercase tracking-wider block">
                  Perps Write (1-tok Cancels)
                </span>
                <span className="text-[9.5px] text-slate-500 font-sans">
                  POST/DEL /margin/orders
                </span>
              </div>
              <span className="text-[9px] px-1.5 py-0.5 bg-rose-950/80 text-rose-300 border border-rose-500/30 font-mono rounded">
                {isBasic ? '1s Capacity' : '3s Bank'} ({buckets.PERPS_WRITE.burstCapacity} tok)
              </span>
            </div>

            <div className="mt-3 flex items-baseline justify-between">
              <div className="flex items-baseline gap-1">
                <span className="text-xl font-bold font-mono text-crypto-text">
                  {buckets.PERPS_WRITE.tokens}
                </span>
                <span className="text-[10px] text-slate-500">
                  / {buckets.PERPS_WRITE.maxCapacity} tokens
                </span>
              </div>
              <span className="text-[11px] font-bold font-mono text-rose-400">
                {buckets.PERPS_WRITE.fillPercentage}%
              </span>
            </div>

            <div className="mt-2 w-full bg-slate-800/80 h-2 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-200 ${getBucketColor(
                  buckets.PERPS_WRITE.fillPercentage,
                  buckets.PERPS_WRITE.status
                )}`}
                style={{ width: `${Math.max(4, buckets.PERPS_WRITE.fillPercentage)}%` }}
              />
            </div>

            <div className="mt-3 pt-2 border-t border-slate-800/60 flex justify-between text-[10px] text-slate-400">
              <span>Refill: +{buckets.PERPS_WRITE.refillRatePerSec} tok/s</span>
              <span>Executed: {buckets.PERPS_WRITE.totalRequestsServed}</span>
            </div>
          </div>
        )}
      </div>

      {/* Real-time Rate & Token Cost Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 pt-2 border-t border-crypto-primary/20 text-[11px]">
        <div className="p-2 bg-black/30 rounded border border-slate-800/60 flex items-center justify-between">
          <span className="text-slate-400">Live Consumption:</span>
          <span className="font-bold text-emerald-400 font-mono">
            {stats?.throughput.tokensConsumedPerSec || 0} tok/s
          </span>
        </div>
        <div className="p-2 bg-black/30 rounded border border-slate-800/60 flex items-center justify-between">
          <span className="text-slate-400">API Throughput:</span>
          <span className="font-bold text-cyan-400 font-mono">
            {stats?.throughput.requestsPerSec.toFixed(1) || '0.0'} req/s
          </span>
        </div>
        <div className="p-2 bg-black/30 rounded border border-slate-800/60 flex items-center justify-between">
          <span className="text-slate-400">Perp Cancel Cost:</span>
          <span className="font-bold text-amber-300 font-mono">1 Token</span>
        </div>
        <div className="p-2 bg-black/30 rounded border border-slate-800/60 flex items-center justify-between">
          <span className="text-slate-400">Default Request Cost:</span>
          <span className="font-bold text-slate-200 font-mono">10 Tokens</span>
        </div>
      </div>

      {/* Tier Qualifications Info Note */}
      <div className="p-2.5 bg-black/40 rounded border border-slate-800/80 text-[10.5px] text-slate-400 flex items-start gap-2">
        <Lock className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
        <div>
          <span className="text-slate-300 font-bold">Tier Qualification Enforcement: </span>
          Higher tiers (<span className="text-slate-300">Expert, Premier, Paragon, Prime, Prestige</span>) cannot be manually selected in the bot because Kalshi dynamically enforces tier access based strictly on your account's trailing 30-day exchange volume share ($0.075\% \to 1.00\%$). When your Kalshi volume qualifies, Kalshi promotes your account automatically and the bot detects it via <code className="text-cyan-400">/account/limits</code>.
        </div>
      </div>
    </div>
  );
}
