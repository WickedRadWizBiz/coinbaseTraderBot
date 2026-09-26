import React, { useState, useEffect } from 'react';
import { Activity, AlertCircle, CheckCircle, Copy, FileText, Play, RotateCcw, ShieldAlert, Sparkles, Terminal, Clock, Eye } from 'lucide-react';

interface GeminiTradeAuditorCardProps {
  totalTrades: number;
}

export function GeminiTradeAuditorCard({ totalTrades }: GeminiTradeAuditorCardProps) {
  const [auditReport, setAuditReport] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  
  // Background autonomous audits states
  const [autoAudits, setAutoAudits] = useState<any[]>([]);
  const [selectedAutoAuditIdx, setSelectedAutoAuditIdx] = useState<number | 'MANUAL'>('MANUAL');

  // Auto-run trigger or status helper
  const isEligible = totalTrades >= 1; // Show readiness, run on demand

  const fetchAutoAudits = async () => {
    try {
      const response = await fetch('/api/gemini/autonomous-audits');
      const data = await response.json();
      if (data.success && data.history) {
        setAutoAudits(data.history);
      }
    } catch (e) {}
  };

  useEffect(() => {
    fetchAutoAudits();
    const interval = setInterval(fetchAutoAudits, 15000);
    return () => clearInterval(interval);
  }, []);

  const triggerAudit = async () => {
    setLoading(true);
    setError(null);
    setAuditReport(null);
    setSelectedAutoAuditIdx('MANUAL');

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
    } catch (err: any) {
      console.error('[AUDIT CARD ERROR]', err);
      setError(err?.message || 'An error occurred during trade history validation.');
    } finally {
      setLoading(false);
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

  // Determine current active report
  const activeReport = selectedAutoAuditIdx === 'MANUAL' 
    ? auditReport 
    : (autoAudits[selectedAutoAuditIdx]?.report || null);

  const activeTimestamp = selectedAutoAuditIdx === 'MANUAL'
    ? null
    : autoAudits[selectedAutoAuditIdx]?.timestamp;

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
              Autonomous Risk Model Orchestration
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`px-2 py-0.5 border text-[10px] font-bold uppercase tracking-widest ${
            totalTrades >= 20 
              ? 'border-crypto-success text-crypto-success bg-crypto-success/10' 
              : 'border-amber-500/50 text-amber-400 bg-amber-500/5'
          }`}>
            {totalTrades} / 20 TRADES INGESTED
          </span>
        </div>
      </div>

      {/* BODY */}
      <div className="relative z-10 flex flex-col gap-4">
        <p className="text-[11px] text-[#a0a0a0] leading-relaxed">
          The Senior Quantitative Auditor analyzes trade state lineage, execution slippage trajectories (Markout), Implementation Shortfalls, and overfitting metrics. Audits trigger **automatically on every multiple of 20 trades**, or can be executed on demand.
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
              <span>{loading ? 'Auditing...' : 'Run Audit On-Demand'}</span>
            </button>

            {activeReport && (
              <button
                onClick={() => { setAuditReport(null); setError(null); setSelectedAutoAuditIdx('MANUAL'); }}
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
                    Auto-Audit ({new Date(audit.timestamp).toLocaleTimeString()})
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* LOADING STATE */}
        {loading && (
          <div className="p-5 border border-crypto-primary/30 bg-crypto-primary/5 flex flex-col items-center justify-center gap-3 py-8">
            <div className="relative w-8 h-8">
              <div className="absolute inset-0 rounded-full border-3 border-crypto-primary/20 border-t-crypto-primary animate-spin" />
            </div>
            <div className="flex flex-col items-center gap-1">
              <span className="text-crypto-primary font-bold text-[10px] uppercase tracking-widest animate-pulse">
                Auditing Ledger Lineage...
              </span>
              <span className="text-[9px] text-[#808080] uppercase tracking-widest">
                Evaluating Markout Adverse Selection Trajectories
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

        {/* AUDIT OUTPUT REPORT */}
        {activeReport && (
          <div className="flex flex-col gap-3 animation-fade-in">
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
