import React, { useState, useEffect } from 'react';
import { Activity, AlertCircle, CheckCircle, Copy, FileText, Play, RotateCcw, ShieldAlert, Sparkles, Terminal, Clock, Eye, Cpu, Zap, ArrowRight, ShieldCheck, Database, History, ListOrdered, CheckCircle2, ChevronDown, ChevronUp, AlertTriangle } from 'lucide-react';

interface GeminiTradeAuditorCardProps {
  totalTrades: number;
}

interface AuditIssue {
  id: string;
  title: string;
  category: string;
  description: string;
  severity: string;
  detectionCount: number;
  firstDetectedAt: string;
  lastDetectedAt: string;
  status: 'ACTIVE' | 'RESOLVED';
  resolvedAt?: string;
  resolutionNote?: string;
}

interface ShortTermComparison {
  evaluatedAt: string;
  previousAuditTimestamp: string | null;
  resolvedInThisBatch: string[];
  persistingInThisBatch: string[];
  newlyDetectedInThisBatch: string[];
  summaryText: string;
}

interface AuditMemoryState {
  shortTermMemory: {
    lastAuditTimestamp: string | null;
    lastAuditTradeCount: number;
    previousIssues: AuditIssue[];
    lastComparison?: ShortTermComparison;
  };
  recurringIssuesQueue: AuditIssue[];
  activeWatchList: AuditIssue[];
  solvedLongTermMemory: AuditIssue[];
}

export function GeminiTradeAuditorCard({ totalTrades }: GeminiTradeAuditorCardProps) {
  const [auditReport, setAuditReport] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Model Lineage & State Tracking (SR 11-7 Compliance)
  const [configuredModel, setConfiguredModel] = useState<string>('gemini-3.1-pro-preview');
  const [primaryModelName, setPrimaryModelName] = useState<string>('Gemini 3.1 Pro (gemini-3.1-pro-preview)');
  const [fallbackModels, setFallbackModels] = useState<string[]>([
    'gemini-pro-latest',
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3-flash-preview',
    'gemini-flash-latest',
    'gemini-3.1-flash-lite-preview',
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash'
  ]);
  const [manualTargetModel, setManualTargetModel] = useState<string | null>(null);
  const [manualUsedModel, setManualUsedModel] = useState<string | null>(null);
  const [manualModelChanged, setManualModelChanged] = useState<boolean>(false);
  const [manualFallbackReason, setManualFallbackReason] = useState<string | null>(null);
  
  // Background autonomous audits states
  const [autoAudits, setAutoAudits] = useState<any[]>([]);
  const [selectedAutoAuditIdx, setSelectedAutoAuditIdx] = useState<number | 'MANUAL'>('MANUAL');

  // Audit Memory & Recurrence State
  const [auditMemory, setAuditMemory] = useState<AuditMemoryState | null>(null);
  const [latestComparison, setLatestComparison] = useState<ShortTermComparison | null>(null);
  const [showSolvedHistory, setShowSolvedHistory] = useState<boolean>(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  // Auto-run trigger or status helper
  const isEligible = totalTrades >= 1; // Show readiness, run on demand

  const fetchAuditMemory = async () => {
    try {
      const response = await fetch('/api/gemini/audit-memory');
      const data = await response.json();
      if (data.success && data.memory) {
        setAuditMemory(data.memory);
        if (data.memory.shortTermMemory?.lastComparison) {
          setLatestComparison(data.memory.shortTermMemory.lastComparison);
        }
      }
    } catch (e) {}
  };

  const fetchAutoAudits = async () => {
    try {
      const response = await fetch('/api/gemini/autonomous-audits');
      const data = await response.json();
      if (data.success) {
        if (data.configuredModel) setConfiguredModel(data.configuredModel);
        if (data.primaryModelName) setPrimaryModelName(data.primaryModelName);
        if (data.fallbackModels) setFallbackModels(data.fallbackModels);
        if (data.history) setAutoAudits(data.history);
        if (data.auditMemory) {
          setAuditMemory(data.auditMemory);
          if (data.auditMemory.shortTermMemory?.lastComparison) {
            setLatestComparison(data.auditMemory.shortTermMemory.lastComparison);
          }
        }
      }
    } catch (e) {}
  };

  useEffect(() => {
    fetchAutoAudits();
    fetchAuditMemory();
    const interval = setInterval(() => {
      fetchAutoAudits();
      fetchAuditMemory();
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  const triggerAudit = async () => {
    setLoading(true);
    setError(null);
    setAuditReport(null);
    setSelectedAutoAuditIdx('MANUAL');
    setManualTargetModel(configuredModel);
    setManualUsedModel(null);
    setManualModelChanged(false);
    setManualFallbackReason(null);

    try {
      const response = await fetch('/api/gemini/audit-trades?limit=20', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const data = await response.json();
      if (!response.ok) {
        const detailsStr = data.details ? String(data.details) : '';
        if (detailsStr.includes('quota') || detailsStr.includes('429') || detailsStr.includes('RESOURCE_EXHAUSTED') || detailsStr.includes('Quota exceeded')) {
          throw new Error('Gemini API free tier quota exceeded. Please wait 15–30 seconds for the rate limits to clear, then try again. Fallback models have been engaged.');
        }
        throw new Error(data.error || 'Failed to complete quantitative audit.');
      }

      setAuditReport(data.auditReport);
      setManualTargetModel(data.targetModel || configuredModel);
      setManualUsedModel(data.usedModel || configuredModel);
      setManualModelChanged(Boolean(data.modelChanged));
      setManualFallbackReason(data.fallbackReason || null);

      if (data.memoryComparison) {
        setLatestComparison(data.memoryComparison);
      }
      if (data.memoryState) {
        setAuditMemory(data.memoryState);
      }
    } catch (err: any) {
      console.error('[AUDIT CARD ERROR]', err);
      setError(err?.message || 'An error occurred during trade history validation.');
    } finally {
      setLoading(false);
    }
  };

  const handleManualResolve = async (issueId: string) => {
    try {
      setResolvingId(issueId);
      const res = await fetch('/api/gemini/audit-memory/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issueId, note: 'Operator confirmed fix in codebase.' })
      });
      const data = await res.json();
      if (data.success && data.memory) {
        setAuditMemory(data.memory);
      }
    } catch (e) {
      console.error('Failed to resolve issue manually', e);
    } finally {
      setResolvingId(null);
    }
  };

  // Extract the markdown block containing the AI Studio prompt
  const extractCodeBlock = (text: string | null): string => {
    if (!text) return '';
    const match = text.match(/```markdown([\s\S]*?)```/);
    if (match && match[1]) {
      return match[1].trim();
    }
    // Fallback if formatting was slightly different
    const fallbackMatch = text.match(/```([\s\S]*?)```/);
    if (fallbackMatch && fallbackMatch[1]) {
      return fallbackMatch[1].trim();
    }
    return '';
  };

  const handleCopyPrompt = (reportText: string | null) => {
    const code = extractCodeBlock(reportText);
    if (code) {
      navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Determine current active report and its corresponding model state
  const activeReport = selectedAutoAuditIdx === 'MANUAL' 
    ? auditReport 
    : (autoAudits[selectedAutoAuditIdx]?.report || null);

  const activeTimestamp = selectedAutoAuditIdx === 'MANUAL'
    ? null
    : autoAudits[selectedAutoAuditIdx]?.timestamp;

  const currentTargetModel = selectedAutoAuditIdx === 'MANUAL'
    ? (manualTargetModel || configuredModel)
    : (autoAudits[selectedAutoAuditIdx]?.targetModel || configuredModel);

  const currentUsedModel = selectedAutoAuditIdx === 'MANUAL'
    ? manualUsedModel
    : (autoAudits[selectedAutoAuditIdx]?.usedModel || configuredModel);

  const currentModelChanged = selectedAutoAuditIdx === 'MANUAL'
    ? manualModelChanged
    : Boolean(autoAudits[selectedAutoAuditIdx]?.modelChanged);

  const currentFallbackReason = selectedAutoAuditIdx === 'MANUAL'
    ? manualFallbackReason
    : (autoAudits[selectedAutoAuditIdx]?.fallbackReason || null);

  const activeWatchList = auditMemory?.activeWatchList || [];
  const recurringQueue = auditMemory?.recurringIssuesQueue || [];
  const solvedMemory = auditMemory?.solvedLongTermMemory || [];

  return (
    <div className="border border-crypto-primary/40 bg-black/60 p-5 font-mono text-xs shadow-[0_0_15px_rgba(143,115,255,0.05)] relative overflow-hidden flex flex-col gap-4">
      <div className="absolute inset-0 heavy-dither-overlay pointer-events-none" />
      
      {/* HEADER */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-crypto-primary/30 pb-3">
        <div className="flex items-center gap-2.5">
          <Terminal className="w-5 h-5 text-crypto-primary animate-pulse shrink-0" />
          <div className="flex flex-col">
            <span className="font-bold text-sm tracking-wider text-crypto-text uppercase">
              &gt; QUANTITATIVE AUDIT PROTOCOL (SR 11-7)
            </span>
            <span className="text-[10px] text-[#808080] tracking-widest uppercase">
              Autonomous Risk Model Orchestration & Recurrence Surveillance
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 border border-crypto-success text-crypto-success bg-crypto-success/10 text-[10px] font-bold uppercase tracking-widest">
            {totalTrades} TRADES INGESTED
          </span>
          <span className="px-2 py-0.5 border border-[#808080]/30 text-[#a0a0a0] bg-[#808080]/5 text-[10px] font-bold uppercase tracking-widest">
            Batch Progress: {totalTrades % 20 === 0 && totalTrades > 0 ? 20 : totalTrades % 20} / 20
          </span>
        </div>
      </div>

      {/* MODEL SPECIFICATION & GOVERNANCE BANNER (BEFORE & DURING AUDIT) */}
      <div className="bg-black/80 border border-crypto-primary/30 p-2.5 flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-crypto-primary shrink-0" />
          <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
            <span className="text-[#808080] font-bold uppercase tracking-wider">Primary Model:</span>
            <span className="px-1.5 py-0.5 bg-crypto-primary/10 border border-crypto-primary/40 text-crypto-primary font-bold">
              {primaryModelName}
            </span>
            <span className="text-[10px] text-[#606060] hidden sm:inline">|</span>
            <span className="text-[#808080] font-bold uppercase tracking-wider hidden sm:inline">Tier:</span>
            <span className="text-crypto-text font-bold hidden sm:inline">Gemini 3.1 Pro</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-[#808080] flex-wrap">
          <Zap className="w-3 h-3 text-amber-400 shrink-0" />
          <span className="uppercase tracking-wider font-semibold">Sequential Fallback:</span>
          <span className="text-[#a0a0a0] font-mono">
            {fallbackModels.slice(0, 3).join(' ➔ ')} ➔ ... ➔ <span className="text-amber-300 font-bold">gemini-3.5-flash (Last Attempt)</span>
          </span>
        </div>
      </div>

      {/* AUDIT RECURRENCE & MULTI-TIER MEMORY SURVEILLANCE SUITE */}
      <div className="border border-crypto-primary/30 bg-black/70 p-3.5 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-crypto-primary/20 pb-2">
          <div className="flex items-center gap-2 text-crypto-primary font-bold text-[11px]">
            <Database className="w-4 h-4 text-crypto-primary animate-pulse" />
            <span className="uppercase tracking-wider">Audit Memory & Reoccurring Issue Engine</span>
          </div>
          <div className="flex items-center gap-2 text-[10px]">
            <span className="text-[#808080]">Active Watch Slots:</span>
            <span className="px-1.5 py-0.5 bg-crypto-primary/20 border border-crypto-primary/50 text-crypto-primary font-bold font-mono">
              {activeWatchList.length}/3 IN USE
            </span>
            <span className="text-[#606060]">|</span>
            <span className="text-[#808080]">Queue Backlog:</span>
            <span className="px-1.5 py-0.5 bg-[#808080]/10 border border-[#808080]/30 text-[#a0a0a0] font-bold font-mono">
              {recurringQueue.length} PENDING
            </span>
            <span className="text-[#606060]">|</span>
            <span className="text-[#808080]">Solved Archive:</span>
            <span className="px-1.5 py-0.5 bg-crypto-success/10 border border-crypto-success/30 text-crypto-success font-bold font-mono">
              {solvedMemory.length} FIXED
            </span>
          </div>
        </div>

        {/* 1. ACTIVE REOCCURRING WATCH LIST (MAX 3) */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-[10px] text-[#a0a0a0]">
            <span className="uppercase tracking-wider font-bold text-crypto-text flex items-center gap-1.5">
              <ListOrdered className="w-3.5 h-3.5 text-amber-400" />
              <span>Active Reoccurring Watch List (Injected Into Gemini Prompt - Max 3)</span>
            </span>
            <span className="text-[#707070]">Rotates FIFO from queue as items are resolved</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
            {activeWatchList.map((item, idx) => (
              <div 
                key={item.id} 
                className="border border-amber-400/40 bg-amber-400/5 p-2.5 flex flex-col justify-between gap-2 relative overflow-hidden"
              >
                <div className="flex items-start justify-between gap-1.5">
                  <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 bg-amber-400/20 text-amber-300 border border-amber-400/40">
                    SLOT #{idx + 1} &bull; WATCHING
                  </span>
                  <span className="text-[9px] font-mono text-[#a0a0a0]">
                    Observed: {item.detectionCount}x
                  </span>
                </div>
                
                <div className="flex flex-col gap-1">
                  <span className="font-bold text-[11px] text-white leading-tight">
                    {item.title}
                  </span>
                  <span className="text-[10px] text-[#a0a0a0] leading-snug line-clamp-2">
                    {item.description}
                  </span>
                </div>

                <div className="flex items-center justify-between gap-2 pt-1 border-t border-amber-400/20">
                  <span className="text-[9px] font-bold text-amber-400 tracking-wider">
                    {item.category}
                  </span>
                  <button
                    onClick={() => handleManualResolve(item.id)}
                    disabled={resolvingId === item.id}
                    className="text-[9px] px-2 py-0.5 bg-crypto-success/20 hover:bg-crypto-success hover:text-black text-crypto-success border border-crypto-success/40 transition-colors uppercase font-bold cursor-pointer"
                    title="Mark resolved in code and rotate next issue from queue"
                  >
                    {resolvingId === item.id ? 'Resolving...' : 'Mark Solved'}
                  </button>
                </div>
              </div>
            ))}

            {activeWatchList.length === 0 && (
              <div className="col-span-3 border border-crypto-success/30 bg-crypto-success/5 p-3 text-center text-crypto-success text-[11px] flex items-center justify-center gap-2">
                <CheckCircle2 className="w-4 h-4" />
                <span>All reoccurring vulnerabilities currently solved. Surveillance queue clean!</span>
              </div>
            )}
          </div>
        </div>

        {/* 2. SHORT-TERM MEMORY COMPARISON (PREVIOUS AUDIT DIFF) */}
        {latestComparison && (
          <div className="border border-crypto-primary/20 bg-black/60 p-2.5 flex flex-col gap-2">
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-crypto-primary font-bold uppercase tracking-wider flex items-center gap-1.5">
                <History className="w-3.5 h-3.5" />
                <span>Short-Term Comparison Memory (Batch vs Previous Audit)</span>
              </span>
              <span className="text-[#808080] font-mono">
                Evaluated: {new Date(latestComparison.evaluatedAt).toLocaleTimeString()}
              </span>
            </div>

            <p className="text-[10px] text-[#a0a0a0] leading-snug">
              {latestComparison.summaryText}
            </p>

            <div className="flex flex-wrap items-center gap-2 text-[10px]">
              {latestComparison.resolvedInThisBatch.length > 0 && (
                <div className="flex items-center gap-1.5 px-2 py-1 bg-crypto-success/15 border border-crypto-success/40 text-crypto-success">
                  <CheckCircle className="w-3 h-3 shrink-0" />
                  <span className="font-bold">Resolved in this batch:</span>
                  <span className="font-mono">{latestComparison.resolvedInThisBatch.join(', ')}</span>
                </div>
              )}

              {latestComparison.persistingInThisBatch.length > 0 && (
                <div className="flex items-center gap-1.5 px-2 py-1 bg-amber-500/15 border border-amber-500/40 text-amber-300">
                  <AlertTriangle className="w-3 h-3 shrink-0" />
                  <span className="font-bold">Still persisting:</span>
                  <span className="font-mono">{latestComparison.persistingInThisBatch.join(', ')}</span>
                </div>
              )}

              {latestComparison.newlyDetectedInThisBatch.length > 0 && (
                <div className="flex items-center gap-1.5 px-2 py-1 bg-sky-500/15 border border-sky-500/40 text-sky-300">
                  <Activity className="w-3 h-3 shrink-0" />
                  <span className="font-bold">Newly flagged:</span>
                  <span className="font-mono">{latestComparison.newlyDetectedInThisBatch.join(', ')}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 3. SOLVED LONG-TERM MEMORY ARCHIVE TOGGLE */}
        <div className="flex flex-col gap-2 pt-1 border-t border-crypto-primary/20">
          <div 
            onClick={() => setShowSolvedHistory(!showSolvedHistory)}
            className="flex items-center justify-between text-[10px] text-[#a0a0a0] hover:text-white cursor-pointer select-none py-0.5"
          >
            <span className="flex items-center gap-1.5 font-bold uppercase tracking-wider text-crypto-success">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Solved Long-Term Knowledge Base ({solvedMemory.length} Institutional Hardening Milestones)</span>
            </span>
            <div className="flex items-center gap-1">
              <span>{showSolvedHistory ? 'Hide Archive' : 'View Solved History'}</span>
              {showSolvedHistory ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </div>
          </div>

          {showSolvedHistory && (
            <div className="max-h-[160px] overflow-y-auto space-y-1.5 pr-1 scrollbar-thin scrollbar-thumb-crypto-primary/40">
              {solvedMemory.map((solved) => (
                <div 
                  key={solved.id}
                  className="p-2 border border-crypto-success/30 bg-crypto-success/5 flex flex-col gap-0.5 text-[10px]"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-white uppercase">{solved.title}</span>
                    <span className="text-[9px] text-[#808080] font-mono">
                      Solved: {solved.resolvedAt ? new Date(solved.resolvedAt).toLocaleDateString() : 'Baseline'}
                    </span>
                  </div>
                  <span className="text-[#a0a0a0]">{solved.resolutionNote || solved.description}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* BODY */}
      <div className="relative z-10 flex flex-col gap-4">
        <p className="text-[11px] text-[#a0a0a0] leading-relaxed">
          The Senior Quantitative Auditor analyzes trade state lineage, execution slippage trajectories (Markout), Implementation Shortfalls, and overfitting metrics. Audits prioritize **Gemini 3.1 Pro** (<code className="text-crypto-primary font-bold">{configuredModel}</code>) with sequential fallback down the model tier (with 3.5 preserved as the final attempt) and persistent memory comparing past findings. Audits trigger **automatically on every multiple of 20 trades**, or can be executed on demand.
        </p>

        {/* CONTROLS */}
        <div className="flex flex-wrap items-center justify-between gap-4 bg-black/40 border border-crypto-primary/20 p-3">
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={triggerAudit}
              disabled={loading || !isEligible}
              className={`px-4 py-2 font-bold uppercase tracking-wider flex items-center gap-1.5 text-[11px] cursor-pointer transition-all ${
                loading 
                  ? 'bg-crypto-primary/20 border border-crypto-primary text-crypto-primary opacity-60' 
                  : 'bg-crypto-primary text-black hover:bg-white border border-transparent shadow-[0_0_10px_rgba(143,115,255,0.2)]'
              }`}
            >
              <Sparkles className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>{loading ? 'Auditing with Gemini 3.1 Pro...' : 'Run Audit On-Demand (Gemini 3.1 Pro)'}</span>
            </button>

            {activeReport && (
              <button
                onClick={() => { 
                  setAuditReport(null); 
                  setError(null); 
                  setSelectedAutoAuditIdx('MANUAL'); 
                  setManualUsedModel(null);
                }}
                className="px-3 py-1.5 border border-crypto-danger/50 text-crypto-danger hover:bg-crypto-danger hover:text-white transition-colors uppercase font-bold text-[10px] tracking-widest flex items-center gap-1 cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                <span>Clear View</span>
              </button>
            )}
          </div>

          {/* Background Auto Audits Selector */}
          {autoAudits.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-[#808080] font-bold uppercase flex items-center gap-1">
                <Clock className="w-3.5 h-3.5 text-crypto-success animate-pulse" />
                <span>Auto Reports:</span>
              </span>
              <select
                value={selectedAutoAuditIdx}
                onChange={(e) => {
                  const val = e.target.value;
                  setSelectedAutoAuditIdx(val === 'MANUAL' ? 'MANUAL' : parseInt(val));
                }}
                className="bg-black text-[11px] text-crypto-success border border-crypto-success/40 px-2 py-1 font-mono focus:outline-none"
              >
                <option value="MANUAL">Manual On-Demand Audit {auditReport ? '(Active)' : ''}</option>
                {autoAudits.map((audit, i) => (
                  <option key={`auto-audit-opt-${i}`} value={i}>
                    Auto-Audit ({new Date(audit.timestamp).toLocaleTimeString()}) - {audit.usedModel || 'Gemini'}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* LOADING STATE (EXPLICIT MODEL REPORTING BEFORE/DURING AUDIT) */}
        {loading && (
          <div className="p-5 border border-crypto-primary/30 bg-crypto-primary/5 flex flex-col items-center justify-center gap-3 py-8">
            <div className="relative w-8 h-8">
              <div className="absolute inset-0 rounded-full border-3 border-crypto-primary/20 border-t-crypto-primary animate-spin" />
            </div>
            <div className="flex flex-col items-center gap-1.5 text-center">
              <span className="text-crypto-primary font-bold text-[11px] uppercase tracking-widest animate-pulse">
                &gt; Querying Primary Model: {configuredModel} (Gemini 3.1 Pro)...
              </span>
              <span className="text-[10px] text-[#a0a0a0] uppercase tracking-wider">
                Auditing Ledger Lineage, Reoccurring Issues ({activeWatchList.length}/3), & Evaluating Markout Adverse Selection Trajectories
              </span>
              <span className="text-[9px] text-[#606060]">
                * If rate limits or quota constraints occur, dynamic fallback tiers ({fallbackModels.slice(0, 4).join(', ')} ... ending with gemini-3.5-flash) will engage sequentially.
              </span>
            </div>
          </div>
        )}

        {/* ERROR STATE */}
        {error && (
          <div className="p-4 border border-crypto-danger/40 bg-crypto-danger/10 text-crypto-danger flex items-start gap-2.5">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
            <div className="flex flex-col gap-1">
              <span className="font-bold uppercase text-[10px] tracking-wider">Audit Execution Failed</span>
              <span className="text-[11px] leading-relaxed opacity-90">{error}</span>
            </div>
          </div>
        )}

        {/* AUDIT OUTPUT REPORT & MODEL VERIFICATION (AFTER AUDIT) */}
        {activeReport && (
          <div className="flex flex-col gap-3 animation-fade-in">
            {/* MODEL VERIFICATION & STATUS CALLOUT (AFTER AUDIT) */}
            <div className={`p-3 border flex flex-wrap items-center justify-between gap-3 text-xs ${
              currentModelChanged 
                ? 'border-amber-400/50 bg-amber-400/10 text-amber-200' 
                : 'border-crypto-success/50 bg-crypto-success/10 text-crypto-success'
            }`}>
              <div className="flex items-center gap-2">
                {currentModelChanged ? (
                  <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                ) : (
                  <ShieldCheck className="w-4 h-4 text-crypto-success shrink-0" />
                )}
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-bold uppercase tracking-wider text-[11px]">
                      {currentModelChanged ? 'Model Fallback Engaged' : 'Target Model Preserved'}:
                    </span>
                    <span className="font-mono font-bold text-white bg-black/60 px-1.5 py-0.5 border border-current">
                      Target: {currentTargetModel} (Gemini 3.1 Pro)
                    </span>
                    <ArrowRight className="w-3 h-3 text-current inline" />
                    <span className={`font-mono font-bold px-1.5 py-0.5 border ${
                      currentModelChanged 
                        ? 'bg-amber-500/20 border-amber-400 text-amber-300' 
                        : 'bg-crypto-success/20 border-crypto-success text-crypto-success'
                    }`}>
                      Executed With: {currentUsedModel || currentTargetModel}
                    </span>
                  </div>
                  {currentModelChanged ? (
                    <span className="text-[10px] text-amber-300/90 font-mono">
                      {currentFallbackReason || `Primary model (${currentTargetModel} - Gemini 3.1 Pro) was unavailable or rate-limited. Sequentially walked down the fallback list and executed with ${currentUsedModel} (3.5 preserved as last attempt).`}
                    </span>
                  ) : (
                    <span className="text-[10px] text-crypto-success/90 font-mono">
                      Audit successfully executed using high-reasoning Gemini 3.1 Pro ({currentTargetModel}).
                    </span>
                  )}
                </div>
              </div>
              <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 border border-current/40 bg-black/40">
                {currentModelChanged ? 'FALLBACK ACTIVE' : 'GEMINI 3.1 PRO VERIFIED'}
              </span>
            </div>

            {/* AUDIT DETAILS PANEL */}
            <div className="border border-crypto-primary/30 bg-black/80 p-4 max-h-[350px] overflow-y-auto scrollbar-thin scrollbar-thumb-crypto-primary/40 scrollbar-track-black flex flex-col gap-3 font-mono text-[11px] leading-relaxed text-crypto-text">
              <div className="flex items-center justify-between gap-3 border-b border-crypto-primary/20 pb-2">
                <div className="flex items-center gap-1.5 text-crypto-primary font-bold">
                  <FileText className="w-4 h-4" />
                  <span>
                    {selectedAutoAuditIdx === 'MANUAL' 
                      ? 'ON-DEMAND QUANTITATIVE AUDIT REPORT' 
                      : 'ORCHESTRATED AUTONOMOUS AUDIT REPORT'}
                  </span>
                </div>
                {activeTimestamp && (
                  <span className="text-[9px] text-[#808080]">
                    Generated: {new Date(activeTimestamp).toLocaleString()}
                  </span>
                )}
              </div>
              <div className="whitespace-pre-wrap text-left select-text">
                {activeReport}
              </div>
            </div>

            {/* AI STUDIO AGENT PROMPT CARD */}
            {extractCodeBlock(activeReport) && (
              <div className="border border-crypto-success/40 bg-crypto-success/5 p-4 flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-crypto-success/20 pb-2">
                  <div className="flex items-center gap-2 text-crypto-success font-bold text-[11px]">
                    <CheckCircle className="w-4 h-4 animate-pulse" />
                    <span>SYNTHESIZED CODEBASE RECONCILIATION PROMPT</span>
                  </div>
                  <button
                    onClick={() => handleCopyPrompt(activeReport)}
                    className="px-3 py-1 bg-crypto-success text-black hover:bg-white font-bold text-[10px] tracking-wider uppercase transition-colors flex items-center gap-1.5 cursor-pointer"
                  >
                    <Copy className="w-3 h-3" />
                    <span>{copied ? 'Copied!' : 'Copy Prompt'}</span>
                  </button>
                </div>
                <div className="relative">
                  <pre className="p-3 bg-black/90 border border-crypto-success/30 max-h-[180px] overflow-y-auto font-mono text-[10px] leading-relaxed text-crypto-success text-left select-all whitespace-pre-wrap">
                    {extractCodeBlock(activeReport)}
                  </pre>
                </div>
                <span className="text-[9px] text-[#808080] tracking-wider">
                  * Copy this prompt and send it to your AI Studio coding assistant to resolve these structural model risks immediately.
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

