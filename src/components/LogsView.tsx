import React, { useEffect, useState } from 'react';
import { Terminal, Clock, Activity, Cpu, Download, FileJson, FileText, Copy, Check, Filter, Search, Sparkles, RefreshCw, AlertCircle } from 'lucide-react';
import { BackpressureMonitor } from './BackpressureMonitor';
import { KalshiTokenBucketGauges } from './KalshiTokenBucketGauges';

interface Log {
  id: number;
  time: string;
  type: string;
  message: string;
}

export function LogsView() {
  const [logs, setLogs] = useState<Log[]>([]);
  const [filterType, setFilterType] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [copiedStatus, setCopiedStatus] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    const fetchLogs = () => {
      if (document.hidden) return;
      fetch('/api/logs?limit=500')
        .then(r => {
          if (!r.ok) return null;
          const ct = r.headers.get('content-type');
          if (!ct || !ct.includes('application/json')) return null;
          return r.json().catch(() => null);
        })
        .then(data => { if (data && isMounted) setLogs(data.logs || []); }).catch(() => {});
    };
    fetchLogs();
    const interval = setInterval(fetchLogs, 3000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  const getTypeColor = (type: string) => {
    switch(type) {
      case 'INFO': return 'text-crypto-primary';
      case 'ANALYZE': return 'text-crypto-primary opacity-70';
      case 'TRADE': return 'text-[#ff9900] font-bold';
      case 'EXECUTE': return 'text-crypto-text';
      case 'WARN': return 'text-yellow-400';
      case 'ERROR': return 'text-crypto-danger font-semibold';
      default: return 'text-crypto-primary opacity-70';
    }
  };

  const getIcon = (type: string) => {
    switch(type) {
      case 'ANALYZE': return <Cpu className="w-4 h-4 mt-0.5 shrink-0" />;
      case 'EXECUTE': return <Activity className="w-4 h-4 mt-0.5 shrink-0" />;
      case 'WARN': return <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-yellow-400" />;
      case 'ERROR': return <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-crypto-danger" />;
      default: return <Terminal className="w-4 h-4 mt-0.5 shrink-0" />;
    }
  };

  // Download AI Studio Optimized JSON telemetry bundle
  const handleDownloadAIStudioJSON = async () => {
    setIsExporting(true);
    try {
      const response = await fetch('/api/logs/export');
      let data: any;
      if (response.ok) {
        data = await response.json();
      } else {
        // Fallback: build client bundle
        data = {
          exportMetadata: {
            exportedAt: new Date().toISOString(),
            app: "PredictionsRunner.exe",
            totalLogs: logs.length,
            targetConsumer: "Google AI Studio / Gemini"
          },
          logs
        };
      }

      const jsonStr = JSON.stringify(data, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      a.href = url;
      a.download = `kalshi-ai-studio-telemetry-${timestamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setCopiedStatus('JSON Exported!');
      setTimeout(() => setCopiedStatus(null), 3000);
    } catch (e: any) {
      console.error('Failed to export AI Studio JSON', e);
      setCopiedStatus('Export Failed');
      setTimeout(() => setCopiedStatus(null), 3000);
    } finally {
      setIsExporting(false);
    }
  };

  // Download Markdown formatted report for direct prompt ingestion
  const handleDownloadMarkdownReport = async () => {
    setIsExporting(true);
    try {
      const response = await fetch('/api/logs/export');
      const data = response.ok ? await response.json() : { recentLogs: logs };

      const timestamp = new Date().toISOString();
      let md = `# PREDICTIONSRUNNER TELEMETRY & STRATEGY AUDIT REPORT\n`;
      md += `**Exported At:** ${timestamp}\n`;
      md += `**Environment:** ${data.exportMetadata?.environment || 'production'}\n`;
      md += `**Trading Mode:** ${data.exportMetadata?.tradingMode || 'LIVE_KALSHI_TRADING'}\n\n`;

      md += `## 1. PORTFOLIO & BANKROLL STATUS\n`;
      if (data.portfolioSnapshot) {
        md += `- Paper Balance: $${data.portfolioSnapshot.paperBalance?.toFixed(2) || '0.00'}\n`;
        md += `- Real Kalshi Cash Pool: $${data.portfolioSnapshot.realKalshiCash?.toFixed(2) || '0.00'}\n`;
        md += `- Live Total Portfolio Value: $${data.portfolioSnapshot.livePortfolioValue?.toFixed(2) || '0.00'}\n`;
        md += `- Live Realized PnL: $${data.portfolioSnapshot.liveRealizedPnl?.toFixed(2) || '0.00'}\n`;
        md += `- Vaulted Profits: $${data.portfolioSnapshot.vaultedProfits?.toFixed(2) || '0.00'}\n`;
      }

      md += `\n## 2. ACTIVE POSITIONS (${data.activePositions?.length || 0})\n`;
      if (data.activePositions && data.activePositions.length > 0) {
        data.activePositions.forEach((p: any, idx: number) => {
          md += `### Position ${idx + 1}: ${p.symbol} (${p.side})\n`;
          md += `- Entry Price: $${p.entryPrice?.toFixed(4)} | Size: ${p.size} | Capital Placed: $${p.capitalPlacedUsd?.toFixed(2)}\n`;
          md += `- Expected TP: +${((p.expectedTP || 0) * 100).toFixed(1)}% | Target Dollar Goal: $${p.targetDollarGoal?.toFixed(2)}\n`;
          md += `- Entry Time: ${p.entryTime} | Market Regime: ${p.marketRegimeAtEntry}\n\n`;
        });
      } else {
        md += `*No active open positions.*\n\n`;
      }

      md += `## 3. HISTORICAL CLOSED TRADES (${data.tradeHistory?.length || 0})\n`;
      if (data.tradeHistory && data.tradeHistory.length > 0) {
        data.tradeHistory.slice(0, 50).forEach((t: any, idx: number) => {
          const winIcon = t.wasAnalysisCorrect ? '✅ WIN' : '❌ LOSS';
          md += `${idx + 1}. **[${winIcon}]** ${t.symbol} (${t.side}) | PnL: ${t.pnlPct}% ($${t.pnlUsd?.toFixed(2)}) | Pattern: ${t.patternType} | Reason: ${t.closeReason} | Time: ${t.timestamp}\n`;
        });
      } else {
        md += `*No historical trades recorded.*\n\n`;
      }

      md += `\n## 4. AGENT EXECUTION LOGS (${data.recentLogs?.length || logs.length} Records)\n\`\`\`\n`;
      const logList = data.recentLogs || logs;
      logList.forEach((l: any) => {
        md += `[${l.time}] [${l.type}] ${l.message}\n`;
      });
      md += `\`\`\`\n\n`;

      md += `## 5. AI DIAGNOSTIC PROMPT INSTRUCTIONS\n`;
      md += `Please analyze the disconnect between simulated paper trading and live Kalshi execution:\n`;
      md += `1. Identify why binary option expiration (15m contracts decaying to $0.00) causes heavy drawdown when buying low-probability contracts.\n`;
      md += `2. Analyze bid-ask spread friction and taker fees vs. resting maker limit orders.\n`;
      md += `3. Recommend sizing adjustments and strategy parameter amendments to ensure positive expected value (EV).\n`;

      const blob = new Blob([md], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const filenameTime = timestamp.replace(/[:.]/g, '-');
      a.href = url;
      a.download = `kalshi-ai-diagnostic-report-${filenameTime}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setCopiedStatus('Markdown Exported!');
      setTimeout(() => setCopiedStatus(null), 3000);
    } catch (e: any) {
      console.error('Failed to export markdown', e);
      setCopiedStatus('Export Failed');
      setTimeout(() => setCopiedStatus(null), 3000);
    } finally {
      setIsExporting(false);
    }
  };

  // Copy structured diagnostic prompt to clipboard
  const handleCopyPromptContext = async () => {
    try {
      const response = await fetch('/api/logs/export');
      const data = response.ok ? await response.json() : { recentLogs: logs.slice(0, 50) };
      
      const snippet = `=== PREDICTIONSRUNNER TELEMETRY FOR AI STUDIO ===
Export Time: ${new Date().toISOString()}
Mode: ${data.exportMetadata?.tradingMode || 'LIVE'}
Real Kalshi Cash: $${data.portfolioSnapshot?.realKalshiCash?.toFixed(2) || '0.00'}
Live PnL: $${data.portfolioSnapshot?.liveRealizedPnl?.toFixed(2) || '0.00'}

RECENT EXECUTION LOGS (Last 40):
${(data.recentLogs || logs).slice(0, 40).map((l: any) => `[${l.time}] [${l.type}] ${l.message}`).join('\n')}

RECENT CLOSED TRADES:
${(data.tradeHistory || []).slice(0, 15).map((t: any) => `${t.wasAnalysisCorrect ? 'WIN' : 'LOSS'}: ${t.symbol} (${t.side}) PnL: ${t.pnlPct}% | ${t.closeReason}`).join('\n')}

TASK: Diagnose the execution failure in live mode vs paper mode and provide fixes.`;

      await navigator.clipboard.writeText(snippet);
      setCopiedStatus('Copied Prompt!');
      setTimeout(() => setCopiedStatus(null), 3000);
    } catch (e) {
      setCopiedStatus('Copy Failed');
      setTimeout(() => setCopiedStatus(null), 3000);
    }
  };

  const filteredLogs = logs.filter(log => {
    if (filterType !== 'ALL' && log.type !== filterType) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return log.message.toLowerCase().includes(q) || log.type.toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <div className="flex flex-col gap-6 w-full max-w-5xl mx-auto pb-24 md:pb-6 relative z-10 text-crypto-primary font-mono text-sm tracking-wider">
      {/* Header & Export Actions Panel */}
      <div className="crt-grid-panel p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-[#8f73ff11] border border-crypto-primary/20">
        <div className="flex items-center gap-3">
          <Terminal className="w-8 h-8 text-crypto-primary animate-pulse" />
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold uppercase text-crypto-text tracking-[0.15em]">Algorithmic Telemetry</h2>
              <span className="px-2 py-0.5 text-[10px] bg-crypto-primary/20 text-crypto-primary border border-crypto-primary/40 font-mono">
                {logs.length} LOGS
              </span>
            </div>
            <p className="text-xs text-[#808080] font-sans">
              Live stream of agent execution logs, algorithmic analysis, and market data insights.
            </p>
          </div>
        </div>

        {/* AI Studio Export Action Buttons */}
        <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
          <button
            onClick={handleDownloadAIStudioJSON}
            disabled={isExporting}
            title="Download full telemetry in structured JSON format optimized for Google AI Studio context ingestion"
            className="flex-1 md:flex-initial flex items-center justify-center gap-2 px-3 py-2 bg-crypto-primary/20 hover:bg-crypto-primary/30 text-crypto-primary border border-crypto-primary/50 text-xs font-bold uppercase tracking-wider transition-all active:scale-95 shadow-[0_0_10px_rgba(143,115,255,0.2)] disabled:opacity-50 cursor-pointer"
          >
            {isExporting ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <FileJson className="w-3.5 h-3.5 text-crypto-primary" />}
            <Sparkles className="w-3 h-3 text-yellow-400" />
            <span>Export AI Studio (.JSON)</span>
          </button>

          <button
            onClick={handleDownloadMarkdownReport}
            disabled={isExporting}
            title="Download comprehensive Markdown diagnostic audit report"
            className="flex items-center justify-center gap-1.5 px-3 py-2 bg-black/40 hover:bg-black/60 text-crypto-text border border-white/20 text-xs uppercase tracking-wider transition-all active:scale-95 disabled:opacity-50 cursor-pointer"
          >
            <FileText className="w-3.5 h-3.5 text-crypto-primary/80" />
            <Download className="w-3 h-3" />
            <span>Report (.MD)</span>
          </button>

          <button
            onClick={handleCopyPromptContext}
            title="Copy formatted diagnostic prompt snippet to clipboard"
            className="flex items-center justify-center gap-1.5 px-3 py-2 bg-black/40 hover:bg-black/60 text-crypto-text border border-white/20 text-xs uppercase tracking-wider transition-all active:scale-95 cursor-pointer"
          >
            {copiedStatus?.includes('Copied') ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-crypto-primary/80" />}
            <span>{copiedStatus || 'Copy Prompt'}</span>
          </button>
        </div>
      </div>

      {/* Kalshi Rate Limit Token Bucket & Tier Engine */}
      <KalshiTokenBucketGauges />

      {/* Backpressure Queue & Rate Limit Pacing Monitor */}
      <BackpressureMonitor />

      {/* Main Terminal View with Filters & Search */}
      <div className="crt-grid-panel !p-0 overflow-hidden font-mono text-xs relative h-[560px] flex flex-col border border-crypto-primary/30">
        <div className="absolute inset-0 heavy-dither-overlay pointer-events-none" />
        <div className="absolute inset-0 dither-gradient-overlay pointer-events-none" />
        
        {/* Terminal Header Bar with Category Filters & Search */}
        <div className="flex flex-wrap items-center justify-between gap-2 bg-black/40 crt-border-b px-4 py-2.5 shrink-0 z-10">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-crypto-primary font-bold uppercase tracking-wider text-xs">
              <Terminal className="w-4 h-4 text-crypto-primary animate-pulse" />
              <span>Agent Telemetry</span>
            </div>

            {/* Quick Type Filter Pills */}
            <div className="hidden sm:flex items-center gap-1 border-l border-crypto-primary/30 pl-3">
              {['ALL', 'TRADE', 'ANALYZE', 'ERROR', 'WARN', 'INFO'].map(type => (
                <button
                  key={type}
                  onClick={() => setFilterType(type)}
                  className={`px-2 py-0.5 text-[10px] font-bold uppercase transition-colors cursor-pointer ${
                    filterType === type
                      ? 'bg-crypto-primary text-black'
                      : 'bg-black/30 text-crypto-primary/70 hover:text-crypto-primary hover:bg-crypto-primary/10'
                  }`}
                >
                  {type}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Search Filter Input */}
            <div className="relative flex items-center">
              <Search className="w-3.5 h-3.5 absolute left-2 text-crypto-primary/50 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter logs..."
                className="pl-7 pr-2 py-0.5 bg-black/60 border border-crypto-primary/30 text-[11px] text-crypto-primary focus:outline-none focus:border-crypto-primary rounded-none w-32 sm:w-44 placeholder:text-crypto-primary/30"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-1.5 text-crypto-primary/50 hover:text-crypto-primary text-[10px]"
                >
                  ×
                </button>
              )}
            </div>

            <span className="px-2 py-0.5 bg-emerald-950/40 border border-emerald-500/30 text-[10px] text-emerald-400 font-bold flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
              LIVE ({filteredLogs.length})
            </span>
          </div>
        </div>
        
        {/* Terminal Logs Content Area */}
        <div className="p-4 flex-1 overflow-y-auto custom-scrollbar touch-pan-y bg-black/40 flex flex-col gap-1.5 z-10">
          {filteredLogs.length === 0 ? (
            <div className="text-crypto-primary/60 italic py-8 text-center">
              {logs.length === 0 ? 'Waiting for telemetry stream from predictions engine...' : 'No logs match current filter criteria.'}
            </div>
          ) : (
            filteredLogs.map((log, idx) => (
              <div
                key={`log-${log.id}-${log.time}-${idx}`}
                className={`flex gap-3 items-start p-1 hover:bg-white/[0.02] transition-colors ${getTypeColor(log.type)}`}
              >
                <div className="flex items-center gap-1 shrink-0 mt-0.5 opacity-60 text-[10px]">
                  <Clock className="w-3 h-3" />
                  [{new Date(log.time).toLocaleTimeString()}]
                </div>
                <div className={`w-20 shrink-0 font-bold text-[11px] ${getTypeColor(log.type)}`}>
                  [{log.type}]
                </div>
                <div className="flex gap-2 min-w-0 flex-1">
                  <span className={getTypeColor(log.type)}>{getIcon(log.type)}</span>
                  <span className="leading-relaxed break-words">{log.message}</span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer info bar */}
        <div className="px-4 py-1.5 bg-black/60 border-t border-crypto-primary/20 flex justify-between items-center text-[10px] text-crypto-primary/50 z-10">
          <span>AI Studio Ready Format • Retaining up to 2,000 historical telemetry frames</span>
          <span>Buffer: {logs.length} entries</span>
        </div>
      </div>
    </div>
  );
}

