import React, { useState, useEffect } from 'react';
import { Sparkles, AlertTriangle, CheckCircle2, Trash2, RefreshCw, Bot, DollarSign } from 'lucide-react';

export interface GeminiStrategyAmendment {
  id: string;
  timestamp: string;
  targetFeatureId: string;
  featureName: string;
  assetSymbol: string;
  verdict: 'FLAWED_SETUP' | 'STRATEGIC_AMENDMENT';
  diagnosis: string;
  proposedAction: {
    ruleType: 'THRESHOLD_FILTER' | 'STATE_REQUIREMENT' | 'DISABLE_PATTERN' | 'SIDE_RESTRICTION';
    field: 'rsi' | 'volumeSurgeRatio' | 'ichimokuState' | 'tenkanKijunCross' | 'orderBookRatio' | 'contractSide';
    operator: '>' | '<' | '>=' | '<=' | '==' | '!=' | 'NOT_IN';
    value: string | number;
    description: string;
  };
  kellyParameters?: {
    tradeCashVolumeUsd: number;
    takeProfitPct: number;
    stopLossPct: number;
    explanation?: string;
  };
  isActive: boolean;
  triggeringTradeId?: number;
}

interface TimeoutItem {
  id: string;
  name: string;
  category: 'PATTERN' | 'INDICATOR' | 'COMBINATION';
}

export function GeminiStrategyDoctorCard() {
  const [amendments, setAmendments] = useState<GeminiStrategyAmendment[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState<string | null>(null);
  const [triggeringDoctor, setTriggeringDoctor] = useState(false);
  const [timeoutList, setTimeoutList] = useState<TimeoutItem[]>([]);
  const [selectedFeatureId, setSelectedFeatureId] = useState<string>('');

  const fetchAmendments = async () => {
    try {
      const res = await fetch('/api/gemini-amendments').catch(() => null);
      if (res && res.ok) {
        const data = await res.json().catch(() => null);
        if (data && Array.isArray(data.amendments)) {
          setAmendments(data.amendments);
        }
      }

      const timeoutRes = await fetch('/api/timeout-list').catch(() => null);
      if (timeoutRes && timeoutRes.ok) {
        const tData = await timeoutRes.json().catch(() => null);
        const list = tData?.timeoutList || tData?.extinctionList || [];
        setTimeoutList(list);
        if (list.length > 0 && !selectedFeatureId) {
          setSelectedFeatureId(list[0].id);
        }
      }
    } catch {
      // Suppress network errors
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAmendments();
    const interval = setInterval(fetchAmendments, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleToggle = async (id: string, currentActive: boolean) => {
    setActionId(id);
    try {
      const res = await fetch('/api/gemini-amendments/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, active: !currentActive })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.amendments) setAmendments(data.amendments);
      }
    } catch (e) {
      console.error("[TOGGLE AMENDMENT ERROR]", e);
    } finally {
      setActionId(null);
    }
  };

  const handleDelete = async (id: string) => {
    setActionId(id);
    try {
      const res = await fetch('/api/gemini-amendments/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.amendments) setAmendments(data.amendments);
      }
    } catch (e) {
      console.error("[DELETE AMENDMENT ERROR]", e);
    } finally {
      setActionId(null);
    }
  };

  const handleRunDoctor = async () => {
    if (!selectedFeatureId) return;
    setTriggeringDoctor(true);
    try {
      const res = await fetch('/api/gemini-amendments/trigger-doctor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ featureId: selectedFeatureId, assetSymbol: 'GLOBAL' })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.amendments) setAmendments(data.amendments);
      }
    } catch (e) {
      console.error("[TRIGGER DOCTOR ERROR]", e);
    } finally {
      setTriggeringDoctor(false);
    }
  };

  const activeCount = amendments.filter(a => a.isActive).length;
  const flawedCount = amendments.filter(a => a.verdict === 'FLAWED_SETUP').length;

  return (
    <div id="strategic-evolution-screen" className="crt-grid-panel relative overflow-hidden flex flex-col p-4 my-2 border border-crypto-primary/40 bg-black/60 font-mono text-xs shadow-[0_0_15px_rgba(143,115,255,0.15)]">
      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-crypto-primary/30">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-crypto-primary animate-pulse shrink-0" />
          <h3 className="font-bold text-sm uppercase tracking-wider text-crypto-text">
            &gt; STRATEGIC EVOLUTION
          </h3>
          <span className="px-1.5 py-0.5 border border-crypto-primary/50 text-crypto-primary bg-crypto-primary/10 text-[10px] uppercase font-bold tracking-widest">
            GEMINI 3.8 REASONER
          </span>
        </div>

        {/* Quick Action Bar */}
        <div className="flex items-center gap-2">
          {timeoutList.length > 0 && (
            <select
              value={selectedFeatureId}
              onChange={(e) => setSelectedFeatureId(e.target.value)}
              className="bg-black text-[11px] text-crypto-text border border-crypto-primary/50 px-2 py-1 font-mono focus:outline-none"
            >
              {timeoutList.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}

          <button
            id="trigger-strategic-evolution-btn"
            onClick={handleRunDoctor}
            disabled={triggeringDoctor || !selectedFeatureId}
            className="flex items-center gap-1.5 px-3 py-1 bg-crypto-primary text-black font-bold text-xs hover:bg-white transition-all disabled:opacity-50 font-mono uppercase tracking-wider cursor-pointer"
          >
            {triggeringDoctor ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Bot className="w-3.5 h-3.5" />
            )}
            <span>Synthesize</span>
          </button>
        </div>
      </div>

      {/* Stats Bar */}
      <div className="flex flex-wrap items-center justify-between my-2 text-[11px] font-mono text-[#808080]">
        <div className="flex items-center gap-3">
          <span>Active Rules: <strong className="text-crypto-primary">{activeCount}</strong></span>
          <span>|</span>
          <span>Quarantined: <strong className="text-crypto-danger">{flawedCount}</strong></span>
          <span>|</span>
          <span className="text-crypto-success font-bold">50% Kelly Calibration Active</span>
        </div>
      </div>

      {/* Scrollable Rules Container */}
      <div className="relative z-10 max-h-48 overflow-y-auto pr-1 space-y-2 mt-1 font-mono scrollbar-thin scrollbar-thumb-crypto-primary/40 scrollbar-track-black">
        {loading ? (
          <div className="py-4 text-center text-crypto-primary text-xs font-mono animate-pulse">
            LOADING STRATEGIC EVOLUTION STATE...
          </div>
        ) : amendments.length === 0 ? (
          <div className="py-4 text-center bg-black/40 border border-crypto-primary/20 p-3 text-crypto-text text-xs">
            <p className="font-bold text-crypto-primary text-xs uppercase">&gt; NO ACTIVE STRATEGIC AMENDMENTS</p>
            <p className="text-[10px] text-[#808080] mt-0.5">
              Select a timed-out feature above and click Synthesize to run Gemini strategy evolution.
            </p>
          </div>
        ) : (
          amendments.map((a, index) => {
            const isWorking = actionId === a.id;
            const isFlawed = a.verdict === 'FLAWED_SETUP';

            return (
              <div
                key={`${a.id}-${index}`}
                className={`p-2.5 border text-xs transition-all ${
                  isFlawed
                    ? 'bg-crypto-danger/10 border-crypto-danger/40'
                    : 'bg-black/50 border-crypto-primary/40'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 truncate">
                    {isFlawed ? (
                      <AlertTriangle className="w-3.5 h-3.5 text-crypto-danger flex-shrink-0" />
                    ) : (
                      <CheckCircle2 className="w-3.5 h-3.5 text-crypto-success flex-shrink-0" />
                    )}
                    <span className="font-bold text-crypto-text uppercase truncate">
                      {a.featureName}
                    </span>
                    <span className="text-[10px] text-crypto-primary border border-crypto-primary/40 px-1.5 py-0.2">
                      {a.assetSymbol || 'GLOBAL'}
                    </span>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleToggle(a.id, a.isActive)}
                      disabled={isWorking}
                      className={`px-2 py-0.5 text-[10px] font-bold uppercase border cursor-pointer ${
                        a.isActive
                          ? 'bg-crypto-success/20 border-crypto-success text-crypto-success'
                          : 'bg-black border-slate-600 text-slate-400'
                      }`}
                    >
                      {a.isActive ? 'ACTIVE' : 'DISABLED'}
                    </button>

                    <button
                      onClick={() => handleDelete(a.id)}
                      disabled={isWorking}
                      className="text-crypto-danger hover:text-white p-0.5 cursor-pointer"
                      title="Delete Amendment"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <p className="text-[11px] text-[#a0a0a0] italic mt-1 leading-snug">
                  "{a.diagnosis}"
                </p>

                {/* 0.5x Kelly Baseline (Dynamic Ceiling) Risk Parameters */}
                {a.kellyParameters && (
                  <div className="mt-1.5 text-[10px] font-mono bg-crypto-primary/10 border border-crypto-primary/40 p-1.5 text-crypto-text flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5">
                      <Sparkles className="w-3 h-3 text-crypto-primary" />
                      <span>0.5x Base Kelly Targets:</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span>Base TP: <strong className="text-crypto-success">+{(a.kellyParameters.takeProfitPct * 100).toFixed(1)}%</strong></span>
                      <span>Base SL: <strong className="text-crypto-danger">{(a.kellyParameters.stopLossPct * 100).toFixed(1)}%</strong></span>
                    </span>
                  </div>
                )}

                {!isFlawed && a.proposedAction && (
                  <div className="mt-1 text-[10px] font-mono text-crypto-primary bg-black/60 px-2 py-1 border border-crypto-primary/30 flex items-center justify-between">
                    <span>
                      RULE: {a.proposedAction.field} <strong>{a.proposedAction.operator} {String(a.proposedAction.value)}</strong>
                    </span>
                    <span className="text-[9px] text-[#808080]">
                      {a.proposedAction.description}
                    </span>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
