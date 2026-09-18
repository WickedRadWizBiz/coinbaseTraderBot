import React, { useEffect, useState } from 'react';
import { ShieldAlert, Zap, Award, AlertTriangle, RefreshCw } from 'lucide-react';

export interface RecoveryProtocolData {
  consecutiveWins: number;
  consecutiveLosses: number;
  inquiryActive: boolean;
  status: 'INQUIRY_ACTIVE' | 'STABILIZED_3_WINS' | 'RE_EVALUATING_3_LOSSES';
  statusMessage: string;
  hybridParams?: {
    explanation?: string;
  };
}

export interface RecoveryModeInfo {
  isCapitalPreservationActive: boolean;
  isDrawdownTriggered: boolean;
  isProtocolInquiryActive: boolean;
  startingBankroll: number;
  currentCapital: number;
}

export const RecoveryProtocolCard: React.FC = () => {
  const [data, setData] = useState<RecoveryProtocolData | null>(null);
  const [modeInfo, setModeInfo] = useState<RecoveryModeInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [resetting, setResetting] = useState(false);

  const fetchProtocolData = async (showLoading = false) => {
    try {
      if (showLoading) setLoading(true);
      const safeFetch = (url: string) => fetch(url).catch(() => null);
      const [resProtocol, resMode] = await Promise.all([
        safeFetch('/api/recovery-protocol'),
        safeFetch('/api/recovery-mode')
      ]);

      const parseJsonSafe = async (res: Response | null) => {
        if (!res || !res.ok) return null;
        const ct = res.headers.get('content-type');
        if (!ct || !ct.includes('application/json')) return null;
        return await res.json().catch(() => null);
      };

      const protocolData = await parseJsonSafe(resProtocol);
      if (protocolData) setData(protocolData);

      const modeData = await parseJsonSafe(resMode);
      if (modeData) setModeInfo(modeData);
    } catch {
      // Suppress transient network fetch error
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  const handleResetProtocol = async () => {
    try {
      setResetting(true);
      const res = await fetch('/api/recovery-protocol/reset', { method: 'POST' });
      if (res.ok) {
        const ct = res.headers.get('content-type');
        if (ct && ct.includes('application/json')) {
          const resetData = await res.json().catch(() => null);
          if (resetData) setData(resetData);
        }
      }
    } catch (e) {
      console.error('Error resetting recovery protocol:', e);
    } finally {
      setResetting(false);
    }
  };

  useEffect(() => {
    fetchProtocolData(true);
    const interval = setInterval(() => fetchProtocolData(false), 4000);
    return () => clearInterval(interval);
  }, []);

  if (!data) {
    return (
      <div className="crt-grid-panel p-3 flex items-center justify-center text-xs text-crypto-primary">
        <RefreshCw className="w-3.5 h-3.5 animate-spin mr-2" />
        INITIALIZING RECOVERY PROTOCOL...
      </div>
    );
  }

  const { consecutiveWins, consecutiveLosses, status, statusMessage, hybridParams } = data;
  const isTriggered = modeInfo ? (modeInfo.isDrawdownTriggered || modeInfo.isCapitalPreservationActive || data.inquiryActive) : data.inquiryActive;
  const isStandby = !isTriggered;

  return (
    <div id="capital-preservation-recovery-protocol" className="crt-grid-panel relative overflow-hidden flex flex-col p-4 bg-black/60 border border-crypto-primary/40 shadow-[0_0_15px_rgba(143,115,255,0.1)]">
      <div className="absolute inset-0 heavy-dither-overlay pointer-events-none" />

      {/* Red/Orange Overlay in Standby Mode */}
      {isStandby && <div className="protocol-standby-overlay" />}

      <div className="relative z-10 flex flex-col gap-3">
        
        {/* Header Bar: Title, Standby Badge & Actions */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 border-b border-crypto-primary/30 pb-2.5">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-crypto-primary animate-pulse shrink-0" />
            <h3 className="font-bold text-sm uppercase tracking-wider text-crypto-text">
              CAPITAL PRESERVATION RECOVERY PROTOCOL
            </h3>
          </div>

          <div className="flex items-center gap-2">
            {/* Standby / Active Badge */}
            {isStandby ? (
              <div className="px-2.5 py-0.5 bg-red-950/90 border border-red-500/80 text-red-400 font-bold text-[10px] uppercase tracking-widest animate-slow-breathing-red flex items-center gap-1.5 shadow-[0_0_10px_rgba(239,68,68,0.4)]">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-ping shrink-0" />
                <span>STANDBY MODE (-25% TRIGGER)</span>
              </div>
            ) : (
              <div className="px-2.5 py-0.5 bg-crypto-danger/30 border border-crypto-danger text-crypto-danger font-bold text-[10px] uppercase tracking-widest flex items-center gap-1.5 animate-pulse">
                <ShieldAlert className="w-3.5 h-3.5 text-crypto-danger shrink-0" />
                <span>PROTOCOL ACTIVE</span>
              </div>
            )}

            <button
              onClick={() => fetchProtocolData(true)}
              disabled={loading}
              className="p-1 border border-crypto-primary/40 bg-black/40 hover:bg-crypto-primary hover:text-black text-crypto-primary text-[10px] transition-colors"
              title="Refresh"
            >
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={handleResetProtocol}
              disabled={resetting}
              className="px-2 py-0.5 border border-crypto-danger/50 text-crypto-danger bg-crypto-danger/10 hover:bg-crypto-danger hover:text-white text-[9px] font-bold uppercase transition-colors"
              title="Reset Streaks"
            >
              {resetting ? '...' : 'Reset'}
            </button>
          </div>
        </div>

        {/* 3 Count Win and Loss Counters + Brief Processing Status */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-center bg-black/50 p-3 border border-white/10">
          
          {/* Win / Loss Streak Counters */}
          <div className="md:col-span-5 flex items-center justify-around sm:justify-start gap-4 border-b md:border-b-0 md:border-r border-white/10 pb-2 md:pb-0 md:pr-4">
            
            {/* Wins Counter (3 Target) */}
            <div className="flex flex-col items-center">
              <span className="text-[9px] uppercase tracking-wider text-crypto-primary/80 font-bold">3-Win Target</span>
              <div className="flex gap-1 mt-1">
                {[1, 2, 3].map((step) => (
                  <div
                    key={`win-step-${step}`}
                    className={`w-6 h-5 border flex items-center justify-center text-[10px] font-bold ${
                      consecutiveWins >= step
                        ? 'bg-crypto-success border-crypto-success text-black'
                        : 'border-crypto-primary/30 text-crypto-primary/40 bg-black/40'
                    }`}
                  >
                    W{step}
                  </div>
                ))}
              </div>
            </div>

            <div className="w-[1px] h-7 bg-white/10 hidden sm:block" />

            {/* Losses Counter (3 Pivot) */}
            <div className="flex flex-col items-center">
              <span className="text-[9px] uppercase tracking-wider text-crypto-danger/80 font-bold">3-Loss Pivot</span>
              <div className="flex gap-1 mt-1">
                {[1, 2, 3].map((step) => (
                  <div
                    key={`loss-step-${step}`}
                    className={`w-6 h-5 border flex items-center justify-center text-[10px] font-bold ${
                      consecutiveLosses >= step
                        ? 'bg-crypto-danger border-crypto-danger text-white'
                        : 'border-crypto-primary/30 text-crypto-primary/40 bg-black/40'
                    }`}
                  >
                    L{step}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Current Processing Explanation */}
          <div className="md:col-span-7 flex items-start gap-2 text-xs">
            {status === 'STABILIZED_3_WINS' ? (
              <Award className="w-4 h-4 shrink-0 text-crypto-success mt-0.5" />
            ) : status === 'RE_EVALUATING_3_LOSSES' ? (
              <AlertTriangle className="w-4 h-4 shrink-0 text-crypto-danger animate-bounce mt-0.5" />
            ) : (
              <Zap className="w-4 h-4 shrink-0 text-amber-400 animate-pulse mt-0.5" />
            )}
            <div className="flex flex-col gap-0.5">
              <div className="font-bold text-[10px] uppercase tracking-wider text-crypto-text flex items-center gap-1.5">
                <span>PROCESSING: {status.replace(/_/g, ' ')}</span>
              </div>
              <p className="text-[10px] text-crypto-text/80 leading-tight">
                {statusMessage}
              </p>
              {hybridParams?.explanation && (
                <p className="text-[9px] text-crypto-primary/80 italic mt-0.5">
                  Logic: {hybridParams.explanation}
                </p>
              )}
            </div>
          </div>

        </div>

      </div>
    </div>
  );
};
