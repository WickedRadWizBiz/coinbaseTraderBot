import { Activity } from 'lucide-react';
import { useState } from 'react';
import { Panel } from './Panel';
import { usePoll } from './usePoll';

const KINDS = ['', 'decision', 'order_new', 'fill', 'settlement', 'risk_reject', 'recon_break', 'kill_engaged', 'alert', 'error'];
const cents = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(2)}¢`);

export function TelemetryView() {
  const [kind, setKind] = useState('');
  const { data: audit } = usePoll<any[]>(`/audit?limit=150${kind ? `&kind=${kind}` : ''}`, 2500);
  const { data: tca } = usePoll<any>('/tca', 5000);
  const { data: status } = usePoll<any>('/status', 5000);
  const g = status?.guards;
  const pct = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);

  const tone = (k: string) => (/break|reject|error|kill/.test(k) ? 'text-crypto-danger' : /fill|settlement|recon_ok/.test(k) ? 'text-crypto-success' : 'text-crypto-primary');

  return (
    <div className="flex flex-col gap-6 w-full max-w-7xl mx-auto pb-24 md:pb-6 relative z-10 text-crypto-primary font-mono text-sm tracking-wider">
      {g && (
        <Panel title="Cadence, Sizing & Risk Guards">
          <div className="overflow-x-auto">
            <table className="crt-table">
              <tbody>
                <tr><td className="uppercase font-bold">Cadence</td><td>{g.cadence}</td><td className="uppercase font-bold">Sizing</td><td>{g.sizing} · κ {g.kappa} · target ${g.targetEvUsd} · min EV ${g.minTradeEvUsd} · min bankroll ${g.minTradableBankrollUsd}</td></tr>
                <tr><td className="uppercase font-bold">Exit mode</td><td>{g.exitPolicy}</td><td className="uppercase font-bold">Entry windows</td><td>15m {g.entryWindowUpdown?.[0] / 60}–{g.entryWindowUpdown?.[1] / 60} min · hourly {g.entryWindowHourly?.[0] / 60}–{g.entryWindowHourly?.[1] / 60} min</td></tr>
                <tr><td className="uppercase font-bold">Maker buffer</td><td>{cents(g.makerBuffer)}{g.makerMarkout60?.n ? ` (${g.makerMarkout60.n} fills)` : ' (default)'}</td><td className="uppercase font-bold">Drawdown</td><td className={g.equityGuard?.kellyScale !== null && g.equityGuard?.kellyScale < 1 ? 'text-crypto-danger' : ''}>{pct(g.equityGuard?.drawdown)} · Kelly ×{g.equityGuard?.kellyScale?.toFixed(2) ?? '—'}</td></tr>
                <tr><td className="uppercase font-bold">Model vs market</td><td className={g.modelHealth?.halt ? 'text-crypto-danger' : ''}>{g.modelHealth?.advantage === null || g.modelHealth?.advantage === undefined ? `${g.modelHealth?.windows ?? 0} windows` : `${g.modelHealth.advantage >= 0 ? '+' : ''}${g.modelHealth.advantage.toFixed(4)} nats · ${g.modelHealth.windows} windows`}</td><td className="uppercase font-bold">Entry guards</td><td className={g.entryGuards?.length ? 'text-crypto-danger' : 'text-crypto-success'}>{g.entryGuards?.length ? g.entryGuards.join(' · ') : 'clear'}</td></tr>
              </tbody>
            </table>
          </div>
        </Panel>
      )}
      {tca && (
        <Panel title="Execution Quality (TCA)">
          <div className="overflow-x-auto">
            <table className="crt-table">
              <thead><tr><th></th><th>Fills</th><th>Contracts</th><th>Fees</th><th>Edge @ decision</th><th>Markout 5s</th><th>30s</th><th>60s</th></tr></thead>
              <tbody>
                {(['maker', 'taker'] as const).map((k) => {
                  const b = tca[k];
                  return (
                    <tr key={k}>
                      <td className="uppercase font-bold">{k}</td><td>{b.fills}</td><td>{b.contracts.toFixed(2)}</td><td>${b.fees.toFixed(2)}</td>
                      <td>{cents(b.avgEdgeAtDecision)}</td>
                      {(['avgMarkout5s', 'avgMarkout30s', 'avgMarkout60s'] as const).map((h) => (
                        <td key={h} className={b[h] !== null && b[h] < 0 ? 'text-crypto-danger' : ''}>{cents(b[h])}</td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <Panel
        title="Audit Telemetry"
        right={
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="crt-border bg-black/60 text-crypto-primary text-xs px-2 py-1 uppercase">
            {KINDS.map((k) => <option key={k} value={k}>{k || 'all events'}</option>)}
          </select>
        }
      >
        <div className="max-h-[70vh] overflow-y-auto pr-2 flex flex-col gap-2">
          {(audit ?? []).length === 0 ? (
            <div className="h-40 flex flex-col items-center justify-center opacity-50">
              <Activity className="w-12 h-12 mb-2" />
              <span className="text-xs">AWAITING FEED</span>
            </div>
          ) : (
            (audit ?? []).slice().reverse().map((a) => (
              <div key={a.seq} className="text-xs font-mono p-2 bg-[#8f73ff11] border border-crypto-primary/30 flex flex-col gap-1 shrink-0">
                <div className="flex justify-between items-center opacity-80">
                  <span className="text-[9px]">#{a.seq} · {new Date(a.ts).toLocaleTimeString()}</span>
                  <span className={`text-[9px] px-1 bg-black/50 uppercase ${tone(a.kind)}`}>{a.kind}</span>
                </div>
                <div className="text-crypto-text leading-tight break-all normal-case">{JSON.stringify(a.data).slice(0, 400)}</div>
              </div>
            ))
          )}
        </div>
      </Panel>
    </div>
  );
}
