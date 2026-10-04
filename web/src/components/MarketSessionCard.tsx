import { Target } from 'lucide-react';
import { useEffect, useState } from 'react';

const VENUE_LABEL: Record<string, string> = { tokyo: 'Tokyo', hongkong: 'Hong Kong', london: 'London', newYork: 'New York' };

function countdown(ms: number): string {
  if (!(ms > 0)) return 'now';
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${m}m ${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

/** Market session banner (restored from the original dashboard, DST-correct). */
export function MarketSessionCard({ session }: { session: any }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!session) return null;
  const hot = session.usOpenWindow || session.key === 'twilight' || session.key === 'weekend';
  return (
    <div className={`crt-grid-panel p-4 font-mono text-xs flex flex-col gap-3 border ${hot ? 'bg-amber-950/30 border-amber-500/80 text-amber-300' : 'bg-crypto-primary/5 border-crypto-primary/40 text-crypto-primary'}`}>
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <Target className={`w-6 h-6 shrink-0 mt-0.5 ${hot ? 'text-amber-400 animate-pulse' : 'text-crypto-primary'}`} />
          <div className="flex flex-col gap-1">
            <div className="font-bold text-sm tracking-wider flex items-center gap-2 flex-wrap">
              <span>SESSION: {String(session.label).toUpperCase()}</span>
              {session.usOpenWindow && (
                <span className="px-2 py-0.5 bg-amber-500/20 text-amber-300 border border-amber-500 text-[10px] uppercase font-bold tracking-widest animate-pulse">US OPEN WINDOW · VOLATILITY SPIKE</span>
              )}
              {session.mondayAsiaOpen && (
                <span className="px-2 py-0.5 bg-crypto-primary/20 text-crypto-primary border border-crypto-primary/50 text-[10px] uppercase font-bold tracking-widest">MONDAY ASIA OPEN</span>
              )}
              {session.risk?.applied?.length > 0 && (
                <span className="px-2 py-0.5 bg-crypto-danger/20 text-crypto-danger border border-crypto-danger/60 text-[10px] uppercase font-bold tracking-widest">
                  SESSION RISK: SIZE ×{session.risk.sizeMult} · +{session.risk.minEdgeAdd} EDGE
                </span>
              )}
            </div>
            <div className="text-[11px] opacity-90 leading-relaxed normal-case">
              {session.next ? <>Next: <strong>{session.next.label}</strong> in <strong>{countdown(session.next.at - now)}</strong> ({new Date(session.next.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} local).</> : null}
              {' '}Hunt mode: {session.huntBlocked ? <strong className="text-amber-300">blocked — {session.huntBlocked}</strong> : <strong>allowed</strong>}.
              {' '}Volatility profile: {session.volProfile?.applied ? <strong>{session.volProfile.version} applied</strong> : 'not applied (fit and validate with research:sessions)'}.
            </div>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {Object.entries(session.venues ?? {}).map(([k, v]: [string, any]) => (
          <div key={k} className="crt-border bg-black/30 px-3 py-2 flex items-center justify-between">
            <span className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${v.open ? 'bg-crypto-success shadow-[0_0_8px_var(--color-crypto-success)]' : 'bg-[#555]'}`} />
              <span className="uppercase tracking-widest text-[10px]">{VENUE_LABEL[k] ?? k}</span>
            </span>
            <span className="text-crypto-text font-bold">{v.local}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
