import React from 'react';
import { Zap, Clock, FastForward, Activity, ArrowRight, ShieldCheck, Flame, Compass } from 'lucide-react';

export interface LaneCandidateSummary {
  id: string;
  symbol: string;
  signalSide: 'YES' | 'NO';
  patternType: string;
  lane: 'FAST_LANE' | 'SLOW_LANE';
  estimatedResolutionMinutes: number;
  velocityScore: number;
  targetPrice?: number;
  distanceToTargetPct?: number;
  lanePriorityScore: number;
  laneReason: string;
  label: string;
  currentPrice: number;
  spread: number;
  isPerpetual: boolean;
  queuedTimeAgoSec?: number;
}

export interface ContractQueuesData {
  fast_lane_queue: LaneCandidateSummary[];
  slow_lane_queue: LaneCandidateSummary[];
  active_fast_lane_count: number;
  active_slow_lane_count: number;
  total_fast_lane_dispatched: number;
  total_slow_lane_dispatched: number;
  last_updated: string;
  fast_lane_ratio: number;
}

interface ContractLaneQueueCardProps {
  queuesData?: ContractQueuesData;
}

export function ContractLaneQueueCard({ queuesData }: ContractLaneQueueCardProps) {
  const fastQueue = queuesData?.fast_lane_queue || [];
  const slowQueue = queuesData?.slow_lane_queue || [];
  const activeFast = queuesData?.active_fast_lane_count || 0;
  const activeSlow = queuesData?.active_slow_lane_count || 0;
  const totalFast = queuesData?.total_fast_lane_dispatched || 0;
  const totalSlow = queuesData?.total_slow_lane_dispatched || 0;

  return (
    <div className="crt-grid-panel p-4 font-mono text-xs border border-crypto-primary/40 bg-black/50 text-crypto-primary flex flex-col gap-4 relative overflow-hidden">
      <div className="absolute inset-0 heavy-dither-overlay pointer-events-none" />

      <div className="relative z-10 flex flex-col gap-4">
        {/* Header with Title and Telemetry Stats */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3 border-b border-crypto-primary/30 pb-3">
          <div className="flex items-center gap-2.5">
            <FastForward className="w-5 h-5 text-crypto-primary shrink-0" />
            <div>
              <div className="font-bold text-sm tracking-wider uppercase text-crypto-text flex items-center gap-2 flex-wrap">
                <span>CONTRACT EXECUTION QUEUES</span>
                <span className="px-1.5 py-0.5 text-[9px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/50 font-bold uppercase tracking-widest flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  FAST LANE PRIORITY ACTIVE
                </span>
              </div>
              <div className="text-[11px] opacity-75 mt-0.5">
                Dual-tier queue architecture: Fast Lane contracts signal for faster resolution to target price and take absolute priority over Slow Lane contracts.
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap font-mono text-[10px]">
            <span className="px-2 py-1 bg-black/60 border border-emerald-500/40 text-emerald-400 font-bold">
              ⚡ ACTIVE FAST: {activeFast} / 3 MAX
            </span>
            <span className="px-2 py-1 bg-black/60 border border-indigo-500/40 text-indigo-300 font-bold">
              ⏳ ACTIVE SLOW: {activeSlow} / 3 MAX
            </span>
            <span className="px-2 py-1 bg-black/60 border border-crypto-primary/40 text-crypto-primary">
              DISPATCHED: {totalFast} FAST | {totalSlow} SLOW
            </span>
          </div>
        </div>

        {/* Dual Lane Column Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          
          {/* FAST LANE COLUMN */}
          <div className="flex flex-col gap-2 p-3 bg-black/40 border border-emerald-500/30 rounded-none relative">
            <div className="flex items-center justify-between border-b border-emerald-500/30 pb-2">
              <div className="flex items-center gap-1.5">
                <Zap className="w-4 h-4 text-emerald-400 animate-pulse" />
                <span className="font-bold text-xs uppercase tracking-wider text-emerald-400">
                  FAST LANE QUEUE (PRIORITY 1)
                </span>
              </div>
              <span className="px-2 py-0.5 text-[9px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold">
                {fastQueue.length} QUEUED
              </span>
            </div>

            <p className="text-[10px] text-emerald-300/80 leading-relaxed">
              Contracts signaling <strong>rapid strike resolution (~2m - 15m)</strong> via 15M predictions, high OFI velocity, or orderbook sweeps. Dispatched with immediate precedence.
            </p>

            {/* Fast Lane Candidates List */}
            <div className="flex flex-col gap-2 mt-1">
              {fastQueue.length > 0 ? (
                fastQueue.map((c, idx) => (
                  <div key={`fast-${c.id || idx}`} className="p-2.5 bg-black/60 border border-emerald-500/20 flex flex-col gap-1.5 hover:border-emerald-500/50 transition-colors">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        <span className="w-4 h-4 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-[9px] border border-emerald-500/40">
                          #{idx + 1}
                        </span>
                        <span className="font-bold text-crypto-text text-xs">{c.label || c.symbol}</span>
                        <span className={`px-1.5 py-0.2 text-[9px] font-bold border ${c.signalSide === 'YES' ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500' : 'bg-rose-500/20 text-rose-400 border-rose-500'}`}>
                          {c.signalSide}
                        </span>
                      </div>
                      <div className="text-[10px] font-bold text-emerald-400 flex items-center gap-1">
                        <Clock className="w-3 h-3 text-emerald-400" />
                        <span>~{c.estimatedResolutionMinutes}m to target</span>
                      </div>
                    </div>

                    <div className="text-[10px] text-crypto-text/75 line-clamp-1">
                      {c.laneReason}
                    </div>

                    <div className="flex items-center justify-between text-[9px] text-[#909090] border-t border-emerald-500/10 pt-1 mt-0.5 flex-wrap gap-y-1">
                      <span>Velocity Index: <strong className="text-emerald-400">{c.velocityScore.toFixed(1)}x</strong></span>
                      {c.targetPrice !== undefined && (
                        <span>Target: <strong className="text-emerald-300">${c.targetPrice.toFixed(2)} (+{c.distanceToTargetPct}%)</strong></span>
                      )}
                      <span>Mark: <strong>${c.currentPrice.toFixed(2)}</strong></span>
                      <span>Spread: <strong>${c.spread.toFixed(3)}</strong></span>
                      <span>Priority: <strong className="text-crypto-primary">{c.lanePriorityScore.toFixed(0)} pts</strong></span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="p-4 border border-dashed border-emerald-500/20 text-center text-[11px] text-emerald-400/60 flex flex-col items-center justify-center gap-1 py-6">
                  <Activity className="w-4 h-4 animate-spin text-emerald-500/40" />
                  <span>Always-On Engine monitoring 15M/1H feeds // Next fast signal feeds immediately</span>
                </div>
              )}
            </div>
          </div>

          {/* SLOW LANE COLUMN */}
          <div className="flex flex-col gap-2 p-3 bg-black/40 border border-indigo-500/30 rounded-none relative">
            <div className="flex items-center justify-between border-b border-indigo-500/30 pb-2">
              <div className="flex items-center gap-1.5">
                <Clock className="w-4 h-4 text-indigo-300" />
                <span className="font-bold text-xs uppercase tracking-wider text-indigo-300">
                  SLOW LANE QUEUE (PRIORITY 2)
                </span>
              </div>
              <span className="px-2 py-0.5 text-[9px] bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 font-bold">
                {slowQueue.length} QUEUED
              </span>
            </div>

            <p className="text-[10px] text-indigo-300/80 leading-relaxed">
              Contracts requiring <strong>longer resolution runways (~35m - 90m+)</strong> such as perpetuals and macro swing setups. Dispatched only when Fast Lane slots allow.
            </p>

            {/* Slow Lane Candidates List */}
            <div className="flex flex-col gap-2 mt-1">
              {slowQueue.length > 0 ? (
                slowQueue.map((c, idx) => (
                  <div key={`slow-${c.id || idx}`} className="p-2.5 bg-black/60 border border-indigo-500/20 flex flex-col gap-1.5 hover:border-indigo-500/50 transition-colors">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        <span className="w-4 h-4 rounded-full bg-indigo-500/20 text-indigo-300 flex items-center justify-center font-bold text-[9px] border border-indigo-500/40">
                          #{idx + 1}
                        </span>
                        <span className="font-bold text-crypto-text text-xs">{c.label || c.symbol}</span>
                        <span className={`px-1.5 py-0.2 text-[9px] font-bold border ${c.signalSide === 'YES' ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500' : 'bg-rose-500/20 text-rose-400 border-rose-500'}`}>
                          {c.signalSide}
                        </span>
                        {c.isPerpetual && (
                          <span className="px-1 py-0.2 text-[8px] bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 font-bold">
                            PERP
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] font-bold text-indigo-300 flex items-center gap-1">
                        <Compass className="w-3 h-3 text-indigo-300" />
                        <span>~{c.estimatedResolutionMinutes}m to target</span>
                      </div>
                    </div>

                    <div className="text-[10px] text-crypto-text/75 line-clamp-1">
                      {c.laneReason}
                    </div>

                    <div className="flex items-center justify-between text-[9px] text-[#909090] border-t border-indigo-500/10 pt-1 mt-0.5 flex-wrap gap-y-1">
                      <span>Velocity Index: <strong className="text-indigo-300">{c.velocityScore.toFixed(1)}x</strong></span>
                      {c.targetPrice !== undefined && (
                        <span>Target: <strong className="text-indigo-300">${c.targetPrice.toFixed(2)} (+{c.distanceToTargetPct}%)</strong></span>
                      )}
                      <span>Mark: <strong>${c.currentPrice.toFixed(2)}</strong></span>
                      <span>Spread: <strong>${c.spread.toFixed(3)}</strong></span>
                      <span>Priority: <strong className="text-crypto-primary">{c.lanePriorityScore.toFixed(0)} pts</strong></span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="p-4 border border-dashed border-indigo-500/20 text-center text-[11px] text-indigo-300/60 flex flex-col items-center justify-center gap-1 py-6">
                  <Clock className="w-4 h-4 text-indigo-400/40" />
                  <span>Slow Lane Queue Clear // Macro positions feeding in background</span>
                </div>
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
