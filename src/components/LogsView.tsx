import React, { useEffect, useState } from 'react';
import { Terminal, Clock, Activity, Cpu } from 'lucide-react';


interface Log {
  id: number;
  time: string;
  type: string;
  message: string;
}

export function LogsView() {
  const [logs, setLogs] = useState<Log[]>([]);

  useEffect(() => {
    const fetchLogs = () => {
      fetch('/api/logs')
        .then(r => {
          if (!r.ok) return null;
          const ct = r.headers.get('content-type');
          if (!ct || !ct.includes('application/json')) return null;
          return r.json().catch(() => null);
        })
        .then(data => { if (data) setLogs(data.logs || []); }).catch(() => {});
    };
    fetchLogs();
    const interval = setInterval(fetchLogs, 2000);
    return () => clearInterval(interval);
  }, []);

  const getTypeColor = (type: string) => {
    switch(type) {
      case 'INFO': return 'text-crypto-primary';
      case 'ANALYZE': return 'text-crypto-primary opacity-70';
      case 'TRADE': return 'text-[#ff9900]';
      case 'EXECUTE': return 'text-crypto-text';
      case 'ERROR': return 'text-crypto-danger';
      default: return 'text-crypto-primary opacity-70';
    }
  };

  const getIcon = (type: string) => {
    switch(type) {
      case 'ANALYZE': return <Cpu className="w-4 h-4 mt-0.5 shrink-0" />;
      case 'EXECUTE': return <Activity className="w-4 h-4 mt-0.5 shrink-0" />;
      default: return <Terminal className="w-4 h-4 mt-0.5 shrink-0" />;
    }
  };

  return (
    <div className="flex flex-col gap-6 w-full max-w-5xl mx-auto pb-24 md:pb-6 relative z-10 text-crypto-primary font-mono text-sm tracking-wider">
      <div className="crt-grid-panel p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-[#8f73ff11]">
        <div className="flex items-center gap-3">
          <Terminal className="w-8 h-8 text-crypto-primary animate-pulse" />
          <div>
            <h2 className="text-xl font-bold uppercase text-crypto-text tracking-[0.15em]">Algorithmic Telemetry</h2>
            <p className="text-xs text-[#808080] font-sans">
              Live stream of agent execution logs, algorithmic analysis, and market data insights.
            </p>
          </div>
        </div>
      </div>

      
      <div className="crt-grid-panel !p-0 overflow-hidden font-mono text-xs relative h-[520px] flex flex-col">
        <div className="absolute inset-0 heavy-dither-overlay pointer-events-none" />
        <div className="absolute inset-0 dither-gradient-overlay pointer-events-none" />
        <div className="flex items-center justify-between bg-black/30 crt-border-b px-4 py-2 border-none shrink-0">
          <div className="flex items-center gap-2 text-crypto-primary opacity-70 font-bold uppercase tracking-wider">
            <Terminal className="w-4 h-4" />
            Agent Execution Logs
          </div>
          <span className="px-2 py-0.5 bg-black/30 border-none rounded-none text-[10px] text-crypto-primary opacity-50">Live Stream</span>
        </div>
        
        <div className="p-4 flex-1 overflow-y-auto custom-scrollbar touch-pan-y bg-black/30 flex flex-col gap-1">
          {logs.length === 0 ? (
            <div className="text-crypto-primary opacity-70 italic">Waiting for telemetry...</div>
          ) : (
            logs.map((log, idx) => (
              <div key={`log-${log.id}-${log.time}-${idx}`} className={`flex gap-3 items-start ${getTypeColor(log.type)}`}>
                <div className="flex items-center gap-1 shrink-0 mt-0.5 opacity-70 text-[10px]">
                  <Clock className="w-3 h-3" />
                  [{new Date(log.time).toLocaleTimeString()}]
                </div>
                <div className={`w-20 shrink-0 font-medium ${getTypeColor(log.type)}`}>
                  [{log.type}]
                </div>
                <div className="flex gap-2">
                  <span className={getTypeColor(log.type)}>{getIcon(log.type)}</span>
                  <span className="leading-tight">{log.message}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
