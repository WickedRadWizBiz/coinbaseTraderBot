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
      {!g ? <Panel title="Cadence, Sizing & Risk Guards" scroll="h-[380px]"><div className="p-4 animate-pulse">ESTABLISHING LINK...</div></Panel> : (
        <Panel title="Cadence, Sizing & Risk Guards" scroll="h-[380px]">
          <div className="overflow-x-auto">
            <table className="crt-table">
              <tbody>
                <tr><td className="uppercase font-bold">Cadence</td><td>{g.cadence}</td><td className="uppercase font-bold">Sizing</td><td>{g.sizing} · κ {g.kappa} · target ${g.targetEvUsd} · min EV ${g.minTradeEvUsd} · min bankroll ${g.minTradableBankrollUsd}</td></tr>
                {g.tier && <tr><td className="uppercase font-bold">Risk tier</td><td>{g.tier.name} · high-water ${g.tier.reference?.toFixed(2)}</td><td className="uppercase font-bold">Tier limits</td><td>{pct(g.tier.orderFrac)}/order (${g.tier.orderRiskUsd}) · daily stop ${g.tier.dailyLossLimitUsd} · Kelly {g.tier.kellyFraction?.toFixed(2)}</td></tr>}
                {status?.tennis?.enabled && <tr><td className="uppercase font-bold">Tennis (ATP)</td><td>{status.tennis.trading ? 'trading' : 'tracking only'} · {status.tennis.matches.length} matches · {status.tennis.matches.filter((m: any) => m.phase === 'underdog_window' || m.phase === 'late').length} in an entry phase</td><td className="uppercase font-bold">Tennis budget</td><td>${status.tennis.budget.used.toFixed(2)} of ${status.tennis.budget.cap.toFixed(2)} (25% of pool)</td></tr>}
                {status?.perps?.trading && status.perps.trading.mode !== 'off' && (() => {
                  const t = status.perps.trading;
                  const pos = Object.entries(status.perps.hedge?.positions ?? {}).filter(([, v]) => v !== 0).map(([k, v]) => `${k} ${v}`).join(', ') || 'flat';
                  const d = Object.values(t.decisions ?? {})[0] as any;
                  return <tr><td className="uppercase font-bold">Perps ({t.mode})</td><td className={t.dayHalt ? 'text-crypto-danger' : ''}>{t.signal} · equity {t.equity === null ? '—' : `$${Number(t.equity).toFixed(2)}`} · {pos}{t.dayHalt ? ` · ${t.dayHalt}` : ''}</td><td className="uppercase font-bold">Perp decision</td><td>{d ? d.reason : '—'}</td></tr>;
                })()}
                {status?.snn && status.snn.mode !== 'off' && <tr><td className="uppercase font-bold">SNN ({status.snn.mode} · {status.snn.stage})</td><td className={status.snn.shadow ? '' : 'text-crypto-success'}>α {Number(status.snn.alpha).toFixed(3)} · {status.snn.events} events · {status.snn.reason}</td><td className="uppercase font-bold">SNN health</td><td>{status.snn.shadow ? 'shadow' : 'voting'} · p99 {status.snn.p99Ms} ms · target ×{Number(status.snn.targetScale).toFixed(2)}{status.snn.top ? ` · top ${status.snn.top}` : ''}</td></tr>}
                {status?.snn?.dirs?.length > 0 && <tr><td className="uppercase font-bold">SNN direction</td><td colSpan={3}>{status.snn.dirs.map((d: any) => `${d.key} ${d.pUp >= 0.5 ? '▲' : '▼'}${(Math.max(d.pUp, 1 - d.pUp) * 100).toFixed(0)}% (${d.labelled})`).join(' · ')}{status.snn.takeGate ? ` · take gate ${status.snn.takeGate.validated ? 'on' : 'off (not validated)'}` : ''}</td></tr>}
                {status?.snn?.units && Object.keys(status.snn.units).length > 0 && <tr><td className="uppercase font-bold">SNN networks</td><td colSpan={3}>{Object.entries(status.snn.units).map(([d, u]: [string, any]) => `${d} ${u.stage} · ${u.shadow ? 'shadow' : 'voting'} · p99 ${u.p99Ms} ms`).join('  |  ')} · isolated (each model reads only its own)</td></tr>}
                {status?.treeModels && <tr><td className="uppercase font-bold">Vol forecast</td><td>{status.treeModels.volModel ? `${status.treeModels.volModel.applied ? 'applied' : status.treeModels.volModel.validated ? 'validated, VOL_MODEL off' : 'not validated'} · ${status.treeModels.volModel.version}` : 'not trained yet'}</td><td className="uppercase font-bold">Fill model</td><td className={status.treeModels.fill?.active ? 'text-crypto-success' : ''}>{status.treeModels.fill ? `${status.treeModels.fill.active ? 'active' : 'not validated'} · ${status.treeModels.fill.quotes} quotes / ${status.treeModels.fill.fills} fills` : status.treeModels.fillLogging ? 'collecting quotes (comes online once validated)' : 'off'}</td></tr>}
                {status?.autoTrain && <tr><td className="uppercase font-bold">Auto-train ({status.autoTrain.mode})</td><td className={status.autoTrain.lastExit && status.autoTrain.lastExit.code !== 0 ? 'text-crypto-danger' : ''}>{status.autoTrain.running ? (status.autoTrain.paused ? `pipeline paused until the next window${status.autoTrain.window?.next ? ` (${status.autoTrain.window.next.label} ${new Date(status.autoTrain.window.next.start).toISOString().slice(11, 16)}Z)` : ''}` : `pipeline running${status.autoTrain.window?.inside ? ` (${status.autoTrain.window.inside} window)` : ''}`) : status.autoTrain.lastExit ? `last run exit ${status.autoTrain.lastExit.code} · ${new Date(status.autoTrain.lastExit.ts).toISOString().slice(0, 16)}Z` : 'not run yet'}{status.autoTrain.nextRun ? ` · next ${new Date(status.autoTrain.nextRun).toISOString().slice(0, 16)}Z` : ''}</td><td className="uppercase font-bold">Last hot swap</td><td>{status.autoTrain.lastSwap ? `${status.autoTrain.lastSwap.kind}: ${status.autoTrain.lastSwap.detail}` : '—'}</td></tr>}
                <tr><td className="uppercase font-bold">Exit mode</td><td>{g.exitPolicy}</td><td className="uppercase font-bold">Entry windows</td><td>15m {g.entryWindowUpdown?.[0] / 60}–{g.entryWindowUpdown?.[1] / 60} min · hourly {g.entryWindowHourly?.[0] / 60}–{g.entryWindowHourly?.[1] / 60} min</td></tr>
                <tr><td className="uppercase font-bold">Maker buffer</td><td>{cents(g.makerBuffer)}{g.makerMarkout60?.n ? ` (${g.makerMarkout60.n} fills)` : ' (default)'}</td><td className="uppercase font-bold">Drawdown</td><td className={g.equityGuard?.kellyScale !== null && g.equityGuard?.kellyScale < 1 ? 'text-crypto-danger' : ''}>{pct(g.equityGuard?.drawdown)} · Kelly ×{g.equityGuard?.kellyScale?.toFixed(2) ?? '—'}</td></tr>
                <tr><td className="uppercase font-bold">Model vs market</td><td className={g.modelHealth?.halt ? 'text-crypto-danger' : ''}>{g.modelHealth?.advantage === null || g.modelHealth?.advantage === undefined ? `${g.modelHealth?.windows ?? 0} windows` : `${g.modelHealth.advantage >= 0 ? '+' : ''}${g.modelHealth.advantage.toFixed(4)} nats · ${g.modelHealth.windows} windows`}</td><td className="uppercase font-bold">Entry guards</td><td className={g.entryGuards?.length ? 'text-crypto-danger' : 'text-crypto-success'}>{g.entryGuards?.length ? g.entryGuards.join(' · ') : 'clear'}</td></tr>
              </tbody>
            </table>
          </div>
        </Panel>
      )}
      {!tca ? <Panel title="Execution Quality (TCA)" scroll="h-[200px]"><div className="p-4 animate-pulse">ESTABLISHING LINK...</div></Panel> : (
        <Panel title="Execution Quality (TCA)" scroll="h-[200px]">
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
        <div className="crt-scroll h-[480px] pr-2 flex flex-col gap-2">
          {(audit ?? []).length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center opacity-50">
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
