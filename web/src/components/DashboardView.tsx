import { Power, ShieldAlert, ShieldCheck } from 'lucide-react';
import { api, clock, pct, px, usd } from '../api';
import { MarketSessionCard } from './MarketSessionCard';
import { VaultCard } from './VaultCard';
import { OrderBookMonitor } from './OrderBookMonitor';
import { Panel, Screen } from './Panel';
import { usePoll } from './usePoll';

function Row({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'ok' | 'bad' | 'warn' }) {
  const color = tone === 'ok' ? 'text-crypto-success' : tone === 'bad' ? 'text-crypto-danger' : tone === 'warn' ? 'text-yellow-300' : 'text-crypto-text';
  return (
    <div className="flex border-b border-crypto-primary border-opacity-50 px-4 py-3 justify-between items-center bg-[#8f73ff08] gap-3">
      <span className="text-[11px] uppercase tracking-widest text-crypto-primary">{label}</span>
      <span className="flex flex-col items-end">
        <span className={`font-bold ${color}`}>{value}</span>
        {sub && <span className="text-[10px] opacity-60">{sub}</span>}
      </span>
    </div>
  );
}

// Fixed screen sizes (phone / wider): cards keep their size while loading and when full.
const BANNER = 'h-[164px] sm:h-[80px]';

export function DashboardView() {
  const { data: s, error, refresh } = usePoll<any>('/status');
  const { data: markets } = usePoll<any[]>('/markets');
  const { data: positions } = usePoll<any[]>('/positions', 3000);
  const { data: orders } = usePoll<any[]>('/orders?limit=40', 3000);

  const engage = async () => {
    const reason = prompt('ENGAGE KILL SWITCH: cancels all orders and blocks new ones. Reason?');
    if (reason === null) return;
    await api('/kill', { method: 'POST', body: JSON.stringify({ reason: reason || 'manual' }) }).catch((e) => alert(e.message));
    void refresh();
  };
  const reset = async () => {
    const confirm = prompt('Type RESET KILL SWITCH to re-enable trading.');
    if (confirm === null) return;
    await api('/kill/reset', { method: 'POST', body: JSON.stringify({ confirm }) }).catch((e) => alert(e.message));
    void refresh();
  };

  const openPositions = (positions ?? []).filter((p) => !p.settled && Math.abs(p.yes) > 1e-9);
  const settled = (positions ?? []).filter((p) => p.settled).slice(0, 12);

  return (
    <div className="flex flex-col gap-6 w-full max-w-7xl mx-auto pb-24 md:pb-6 relative z-10 text-crypto-primary font-mono text-sm tracking-wider">
      {error && (
        <div className="crt-grid-panel p-3 border border-crypto-danger bg-crypto-danger/15 text-crypto-danger font-bold uppercase text-xs">Link error: {error}</div>
      )}

      {!s && <Screen size={BANNER} loading />}

      {s?.kill?.engaged && (
        <div className={`crt-grid-panel p-4 border border-crypto-danger bg-crypto-danger/15 flex flex-col md:flex-row items-center justify-between gap-4 overflow-hidden ${BANNER}`}>
          <div className="flex items-center gap-3">
            <ShieldAlert className="w-6 h-6 text-crypto-danger animate-pulse shrink-0" />
            <div>
              <div className="font-bold uppercase tracking-widest text-crypto-danger">Kill Switch Engaged ({s.kill.source})</div>
              <div className="text-xs text-[#b0b0b0] mt-0.5">{s.kill.reason} — since {s.kill.engagedAt}</div>
            </div>
          </div>
          <button onClick={reset} className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-crypto-danger text-white hover:bg-white hover:text-crypto-danger transition-colors border border-crypto-danger">
            Reset Kill Switch
          </button>
        </div>
      )}

      {s && !s.kill?.engaged && (
        <div className={`crt-grid-panel p-3 border flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 overflow-hidden ${BANNER} ${
          s.haltReasons.length ? 'border-yellow-500/50 bg-yellow-500/10 text-yellow-300' : 'border-crypto-success/50 bg-crypto-success/10 text-crypto-success'
        }`}>
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="w-5 h-5 shrink-0 animate-pulse" />
            <div>
              <div className="font-bold uppercase tracking-wider text-xs">
                {s.mode.toUpperCase()} MODE · KALSHI {s.kalshiEnv.toUpperCase()} · {s.haltReasons.length ? 'NEW RISK HALTED' : 'ARMED'}
              </div>
              <div className="text-[11px] opacity-80 mt-0.5 normal-case">
                {s.haltReasons.length ? s.haltReasons.join('; ') : 'All orders pass the fail-closed risk gateway before reaching the exchange.'}
              </div>
            </div>
          </div>
          <button onClick={engage} className="mech-key !py-2 !px-3 !min-w-0 !flex-row">
            <Power className="w-4 h-4 text-crypto-danger" />
            <span className="text-[11px]">Kill Switch</span>
          </button>
        </div>
      )}

      <Screen size="h-[230px] sm:h-[150px]" loading={!s?.session}>{s?.session && <MarketSessionCard session={s.session} />}</Screen>

      {(!s || s.vault?.enabled) && (
        <Screen size="h-[560px] sm:h-[390px]" loading={!s}>{s?.vault?.enabled && <VaultCard vault={s.vault} session={s.session} onChange={() => void refresh()} />}</Screen>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Panel title="Capital & Risk" className="!p-0" bodyClass="h-full" flush scroll="h-[300px] md:h-[440px]">
          {s ? (
            <div className="flex flex-col">
              <Row label="Daily PnL (net of fees)" value={usd(s.dailyPnl)} sub={`loss limit ${usd(-s.dailyLossLimit)}`} tone={s.dailyPnl < 0 ? 'bad' : 'ok'} />
              <Row label="Cash balance" value={usd(s.balance)} />
              <Row label="Tradable bankroll" value={usd(s.bankroll)} sub={s.vault?.enabled ? `cash + committed − vault ${usd(s.vault.vault)} − pocket ${usd(s.vault.pocket)}` : 'cash + committed'} />
              <Row label="Reconciliation" value={s.recon ? (s.recon.ok ? 'CLEAN' : 'BREAK') : '—'} sub={s.recon ? `${clock(s.recon.ts)}${s.recon.breaks?.length ? ' · ' + s.recon.breaks[0] : ''}` : undefined} tone={s.recon?.ok ? 'ok' : 'bad'} />
              <Row label="Order errors (consecutive)" value={String(s.consecutiveOrderErrors)} tone={s.consecutiveOrderErrors ? 'warn' : undefined} />
            </div>
          ) : <div className="p-6 animate-pulse">ESTABLISHING LINK...</div>}
        </Panel>

        <Panel title="System Telemetry" className="!p-0" bodyClass="h-full" flush scroll="h-[470px] md:h-[440px]">
          {s ? (
            <div className="flex flex-col">
              <Row label="Model" value={s.model.id} sub={s.model.liveBlockers.length ? `not live-validated (${s.model.liveBlockers.length} blockers)` : 'validated for live'} tone={s.model.liveBlockers.length ? 'warn' : 'ok'} />
              <Row label="Settlement index" value={String(s.indexSource).toUpperCase()} sub={s.indexSource === 'proxy' ? 'Coinbase spot proxy (paper only)' : 'CF Benchmarks RTI via Kalshi'} tone={s.indexSource === 'none' ? 'bad' : s.indexSource === 'proxy' ? 'warn' : 'ok'} />
              <Row label="USDT.D (Binance×CoinGecko)" value={s.dominance?.usdtd != null ? `${s.dominance.usdtd.toFixed(3)}%` : 'NO DATA'}
                sub={s.dominance?.usdtdChange5mPct != null ? `5m ${s.dominance.usdtdChange5mPct >= 0 ? '+' : ''}${s.dominance.usdtdChange5mPct.toFixed(3)}% · ${s.dominance.usdtdChange5mPct < 0 ? 'RISK-ON' : 'RISK-OFF'}` : (s.dominance?.error ?? (s.dominance?.enabled ? 'warming up' : 'disabled'))}
                tone={s.dominance?.usdtd == null ? 'warn' : s.dominance.usdtdChange5mPct < 0 ? 'ok' : 'bad'} />
              <Row label="BTC.D" value={s.dominance?.btcd != null ? `${s.dominance.btcd.toFixed(2)}%` : 'NO DATA'}
                sub={s.dominance?.btcdChange5mPct != null ? `5m ${s.dominance.btcdChange5mPct >= 0 ? '+' : ''}${s.dominance.btcdChange5mPct.toFixed(3)}%` : undefined}
                tone={s.dominance?.btcd == null ? 'warn' : undefined} />
              <Row label="Exit policy" value={s.exitPolicy === 'confluence_ratchet' ? 'CONFLUENCE RATCHET' : 'FAIR VALUE'}
                sub={s.exitPolicy === 'confluence_ratchet' ? 'hunts winners only on outperformance + confluence' : 'exit when bid > fair value + fee'} />
              <Row label="Kalshi WebSocket" value={s.wsConnected ? 'CONNECTED' : 'OFFLINE'} tone={s.wsConnected ? 'ok' : 'warn'} />
              <Row label="Active markets" value={String((markets ?? []).length)} />
              <Row label="Uptime" value={`${Math.floor(s.uptimeSec / 3600)}h ${Math.floor((s.uptimeSec % 3600) / 60)}m`} />
            </div>
          ) : <div className="p-6 animate-pulse">ESTABLISHING LINK...</div>}
        </Panel>
      </div>

      <OrderBookMonitor markets={markets ?? []} orders={orders ?? []} />

      <Panel title="Active Markets" scroll="h-[340px]">
        <div className="overflow-x-auto">
          <table className="crt-table">
            <thead><tr><th>Ticker</th><th>Close</th><th>Spot</th><th>Strike</th><th>Fair value</th><th>Model p</th><th>Conf</th><th>Bid</th><th>Ask</th><th>Pos</th><th>State</th></tr></thead>
            <tbody>
              {(markets ?? []).length === 0 && <tr><td colSpan={11} className="opacity-60">[AWAITING MARKET DISCOVERY]</td></tr>}
              {(markets ?? []).map((m) => (
                <tr key={m.ticker}>
                  <td>{m.ticker}</td><td>{clock(m.closeTs)}</td><td>{m.spot?.toFixed(2) ?? '—'}</td>
                  <td>{m.strike?.toFixed(2) ?? '—'}{m.strikeSource === 'computed' ? ' *' : ''}</td>
                  <td>{pct(m.fairValue)}</td><td className="text-crypto-primary font-bold">{pct(m.pYes)}</td>
                  <td className={(m.macro?.conf_count ?? 0) > 0 ? 'text-crypto-success' : (m.macro?.conf_count ?? 0) < 0 ? 'text-crypto-danger' : 'opacity-60'}>{m.macro?.conf_count == null ? '—' : `${m.macro.conf_count > 0 ? '+' : ''}${m.macro.conf_count}`}</td>
                  <td>{px(m.bestBid)}</td><td>{px(m.bestAsk)}</td>
                  <td className={m.position > 0 ? 'text-crypto-success' : m.position < 0 ? 'text-crypto-danger' : ''}>{m.position}</td>
                  <td className={m.blocked ? 'text-yellow-300' : 'opacity-70'}>{m.blocked ? m.blocked.toUpperCase() : (m.notes.join('; ') || 'QUOTING').toUpperCase()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Panel title="Positions" scroll="h-[340px]">
          <div className="overflow-x-auto">
            <table className="crt-table">
              <thead><tr><th>Ticker</th><th>Side</th><th>Qty</th><th>If YES</th><th>If NO</th><th>Max loss</th></tr></thead>
              <tbody>
                {openPositions.length === 0 && <tr><td colSpan={6} className="opacity-60">[NO OPEN POSITIONS]</td></tr>}
                {openPositions.map((p) => (
                  <tr key={p.ticker}>
                    <td>{p.ticker}</td>
                    <td className={p.yes > 0 ? 'text-crypto-success' : 'text-crypto-danger'}>{p.yes > 0 ? 'YES' : 'NO'}</td>
                    <td>{Math.abs(p.yes)}</td><td>{usd(p.scenario.ifYes)}</td><td>{usd(p.scenario.ifNo)}</td><td>{usd(p.maxLoss)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {settled.length > 0 && (
            <>
              <div className="text-[10px] uppercase tracking-widest mt-4 mb-1 opacity-70">Settled (net of fees)</div>
              <table className="crt-table">
                <tbody>
                  {settled.map((p) => (
                    <tr key={p.ticker}><td>{p.ticker}</td><td>{String(p.result).toUpperCase()}</td><td className={(p.realized ?? 0) < 0 ? 'text-crypto-danger' : 'text-crypto-success'}>{usd(p.realized)}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Panel>

        <Panel title="Order Flow" scroll="h-[340px]">
          <div className="overflow-x-auto">
            <table className="crt-table">
              <thead><tr><th>Time</th><th>Ticker</th><th>Side</th><th>Px</th><th>Qty</th><th>Fill</th><th>Type</th><th>State</th></tr></thead>
              <tbody>
                {(orders ?? []).length === 0 && <tr><td colSpan={8} className="opacity-60">[NO ORDERS YET]</td></tr>}
                {(orders ?? []).map((o) => (
                  <tr key={o.clientOrderId}>
                    <td>{clock(o.createdTs)}</td><td>{o.ticker}</td>
                    <td className={o.side === 'bid' ? 'text-crypto-success' : 'text-crypto-danger'}>{o.side === 'bid' ? 'BUY YES' : 'BUY NO'}</td>
                    <td>{px(o.side === 'bid' ? o.price : 1 - o.price)}</td><td>{o.count}</td><td>{o.filledCount}</td>
                    <td>{o.purpose.toUpperCase()}{o.postOnly ? ' · POST' : ''}{o.reduceOnly ? ' · EXIT' : ''}</td>
                    <td className={o.state === 'REJECTED' ? 'text-crypto-danger' : o.state === 'FILLED' ? 'text-crypto-success' : ''}>{o.state}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </div>
  );
}
