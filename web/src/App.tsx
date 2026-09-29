import { useCallback, useEffect, useState } from 'react';

type Json = any;
const TOKEN_KEY = 'bot-console-token';

function getToken(): string {
  try { return sessionStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
}

async function api(path: string, token: string, init?: RequestInit): Promise<Json> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (res.status === 401) throw new Error('unauthorized');
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

const usd = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`);
const pct = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);
const px = (x: number | null | undefined) => (x === null || x === undefined ? '—' : x.toFixed(2));
const time = (ts: number) => new Date(ts).toLocaleTimeString();

export function App() {
  const [token, setToken] = useState(getToken());
  const [draft, setDraft] = useState('');
  const [data, setData] = useState<{ status?: Json; markets?: Json[]; positions?: Json[]; orders?: Json[]; tca?: Json; audit?: Json[] }>({});
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const [status, markets, positions, orders, tca, audit] = await Promise.all([
        api('/status', token), api('/markets', token), api('/positions', token), api('/orders?limit=50', token), api('/tca', token), api('/audit?limit=40', token),
      ]);
      setData({ status, markets, positions, orders, tca, audit });
      setError('');
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === 'unauthorized') { try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } setToken(''); }
      setError(msg);
    }
  }, [token]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 2000);
    return () => clearInterval(id);
  }, [refresh]);

  if (!token) {
    return (
      <main>
        <h1>Bot Console</h1>
        <p className="muted">Enter the dashboard token (DASHBOARD_TOKEN). It is kept only for this browser tab.</p>
        <form className="row" onSubmit={(e) => { e.preventDefault(); try { sessionStorage.setItem(TOKEN_KEY, draft); } catch { /* ignore */ } setToken(draft); }}>
          <input type="password" autoComplete="off" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="token" />
          <button type="submit">Connect</button>
        </form>
        {error && <p className="bad">{error}</p>}
      </main>
    );
  }

  const s = data.status;
  const kill = async () => {
    const reason = prompt('Engage kill switch: cancels all orders and blocks new ones. Reason?');
    if (reason === null) return;
    await api('/kill', token, { method: 'POST', body: JSON.stringify({ reason: reason || 'manual' }) }).catch((e) => setError(e.message));
    void refresh();
  };
  const reset = async () => {
    const confirm = prompt('Type RESET KILL SWITCH to re-enable trading.');
    if (confirm === null) return;
    await api('/kill/reset', token, { method: 'POST', body: JSON.stringify({ confirm }) }).catch((e) => setError(e.message));
    void refresh();
  };

  return (
    <main>
      <header>
        <h1>Bot Console {s && <span className="muted">· {s.mode.toUpperCase()} · {s.kalshiEnv}</span>}</h1>
        <div className="row">
          {s?.kill?.engaged ? <button onClick={reset}>Reset kill switch</button> : <button className="danger" onClick={kill}>Kill switch</button>}
        </div>
      </header>
      {error && <div className="banner">Error: {error}</div>}
      {s?.kill?.engaged && <div className="banner">KILL SWITCH ENGAGED ({s.kill.source}): {s.kill.reason} — since {s.kill.engagedAt}</div>}
      {s && s.haltReasons.length > 0 && !s.kill.engaged && <div className="banner">New risk halted: {s.haltReasons.join('; ')}</div>}

      {s && (
        <div className="grid">
          <div className="card"><div className="label">Daily PnL (net of fees)</div><div className={`value ${s.dailyPnl < 0 ? 'bad' : 'ok'}`}>{usd(s.dailyPnl)}</div><div className="label">limit {usd(-s.dailyLossLimit)}</div></div>
          <div className="card"><div className="label">Balance / bankroll</div><div className="value">{usd(s.balance)}</div><div className="label">bankroll {usd(s.bankroll)}</div></div>
          <div className="card"><div className="label">Reconciliation</div><div className={`value ${s.recon?.ok ? 'ok' : 'bad'}`}>{s.recon ? (s.recon.ok ? 'clean' : 'BREAK') : '—'}</div><div className="label">{s.recon ? time(s.recon.ts) : ''}</div></div>
          <div className="card"><div className="label">Model</div><div className="value" style={{ fontSize: 14 }}>{s.model.id}</div><div className={`label ${s.model.liveBlockers.length ? 'warn' : 'ok'}`}>{s.model.liveBlockers.length ? `not live-validated (${s.model.liveBlockers.length})` : 'validated'}</div></div>
          <div className="card"><div className="label">Data</div><div className="value" style={{ fontSize: 14 }}>index: {s.indexSource}</div><div className="label">ws {s.wsConnected ? 'connected' : 'off'} · order errors {s.consecutiveOrderErrors}</div></div>
        </div>
      )}

      <section>
        <h2>Markets</h2>
        <table>
          <thead><tr><th>Ticker</th><th>Close</th><th>Spot</th><th>Strike</th><th>Fair value</th><th>Model p</th><th>Bid</th><th>Ask</th><th>Pos</th><th>State</th></tr></thead>
          <tbody>
            {(data.markets ?? []).map((m) => (
              <tr key={m.ticker}>
                <td><code>{m.ticker}</code></td><td>{time(m.closeTs)}</td><td>{m.spot?.toFixed(2) ?? '—'}</td>
                <td>{m.strike?.toFixed(2) ?? '—'} <span className="muted">{m.strikeSource === 'computed' ? '(ours)' : ''}</span></td>
                <td>{pct(m.fairValue)}</td><td>{pct(m.pYes)}</td><td>{px(m.bestBid)}</td><td>{px(m.bestAsk)}</td><td>{m.position}</td>
                <td className={m.blocked ? 'warn' : 'muted'}>{m.blocked ?? (m.notes.join('; ') || 'ok')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Positions</h2>
        <table>
          <thead><tr><th>Ticker</th><th>YES</th><th>Fees</th><th>If YES</th><th>If NO</th><th>Max loss</th><th>Settled</th><th>Realized</th></tr></thead>
          <tbody>
            {(data.positions ?? []).slice(0, 30).map((p) => (
              <tr key={p.ticker}>
                <td><code>{p.ticker}</code></td><td>{p.yes}</td><td>{usd(p.fees)}</td><td>{usd(p.scenario.ifYes)}</td><td>{usd(p.scenario.ifNo)}</td>
                <td>{usd(p.maxLoss)}</td><td>{p.settled ? p.result : '—'}</td><td className={(p.realized ?? 0) < 0 ? 'bad' : 'ok'}>{p.settled ? usd(p.realized) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Orders</h2>
        <table>
          <thead><tr><th>Time</th><th>Ticker</th><th>Side</th><th>Price</th><th>Count</th><th>Filled</th><th>Purpose</th><th>State</th><th>FV</th></tr></thead>
          <tbody>
            {(data.orders ?? []).map((o) => (
              <tr key={o.clientOrderId}>
                <td>{time(o.createdTs)}</td><td><code>{o.ticker}</code></td><td>{o.side}</td><td>{px(o.price)}</td><td>{o.count}</td><td>{o.filledCount}</td>
                <td>{o.purpose}{o.postOnly ? ' · post' : ''}{o.reduceOnly ? ' · reduce' : ''}</td><td>{o.state}</td><td>{pct(o.fairValue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {data.tca && (
        <section>
          <h2>Execution quality (TCA)</h2>
          <table>
            <thead><tr><th></th><th>Fills</th><th>Contracts</th><th>Fees</th><th>Edge at decision</th><th>Markout 5s</th><th>30s</th><th>60s</th></tr></thead>
            <tbody>
              {(['maker', 'taker'] as const).map((k) => {
                const b = data.tca[k];
                return (
                  <tr key={k}>
                    <td>{k}</td><td>{b.fills}</td><td>{b.contracts.toFixed(2)}</td><td>{usd(b.fees)}</td>
                    <td>{b.avgEdgeAtDecision === null ? '—' : `${(b.avgEdgeAtDecision * 100).toFixed(2)}¢`}</td>
                    {(['avgMarkout5s', 'avgMarkout30s', 'avgMarkout60s'] as const).map((h) => (
                      <td key={h} className={b[h] !== null && b[h] < 0 ? 'bad' : ''}>{b[h] === null ? '—' : `${(b[h] * 100).toFixed(2)}¢`}</td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      <section>
        <h2>Audit log</h2>
        <table>
          <thead><tr><th>#</th><th>Time</th><th>Kind</th><th>Detail</th></tr></thead>
          <tbody>
            {(data.audit ?? []).slice().reverse().map((a) => (
              <tr key={a.seq}><td>{a.seq}</td><td>{new Date(a.ts).toLocaleTimeString()}</td><td>{a.kind}</td><td className="muted"><code>{JSON.stringify(a.data).slice(0, 140)}</code></td></tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
