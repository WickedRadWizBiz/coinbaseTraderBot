import { useRef, useState } from 'react';
import { Play, Square } from 'lucide-react';
import { api } from '../api';
import { LiveTradingConfirmationModal } from './LiveTradingConfirmationModal';

/**
 * Status row restored from the previous bot: PLAY / STOP above ACTIVE / STOPPED (stopped = no new
 * entries, open positions still managed), and the PAPER CASH / KALSHI CASH POOL button: one tap while
 * live returns to paper at once; in paper a double-tap opens the live authorisation dialog (which itself
 * needs a double-tap). A mode switch restarts the bot; the row shows that until it is back.
 */
export function BotControls({ s, onChange }: { s: any; onChange: () => void }) {
  const active = s?.run?.active !== false;
  const isLive = s?.mode === 'live';
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [showLive, setShowLive] = useState(false);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toggleRun = async () => {
    setBusy(true);
    try { await api('/run', { method: 'POST', body: JSON.stringify({ active: !active }) }); } catch (e) { alert((e as Error).message); }
    setBusy(false);
    onChange();
  };

  const waitForRestart = (target: string) => {
    setRestarting(target);
    const started = Date.now();
    const poll = async () => {
      try {
        const st = await api<any>('/status');
        if (st.mode === target) { setRestarting(null); onChange(); return; }
      } catch { /* restarting */ }
      if (Date.now() - started < 180_000) setTimeout(poll, 2000); else setRestarting(null);
    };
    setTimeout(poll, 3000);
  };

  const toPaper = async () => {
    setBusy(true);
    try { await api('/mode', { method: 'POST', body: JSON.stringify({ mode: 'paper' }) }); waitForRestart('paper'); }
    catch (e) { alert((e as Error).message); }
    setBusy(false);
  };

  const tapMode = () => {
    if (isLive) { void toPaper(); return; }
    if (!pending) {
      setPending(true);
      if (tapTimer.current) clearTimeout(tapTimer.current);
      tapTimer.current = setTimeout(() => setPending(false), 1000);
    } else {
      if (tapTimer.current) clearTimeout(tapTimer.current);
      setPending(false);
      setShowLive(true);
    }
  };

  return (
    <div className="flex border-b border-crypto-primary border-opacity-50 px-4 py-3 justify-between items-center gap-3 bg-[#8f73ff08]">
      <div className="flex flex-col">
        <span className="text-[11px] uppercase tracking-widest text-crypto-primary font-bold">Status</span>
        <span className="text-[10px] opacity-70 normal-case">
          {restarting ? `restarting into ${restarting.toUpperCase()} mode...` : active ? 'trading' : 'no new entries; open positions still managed'}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex flex-col items-center justify-center gap-1">
          <button
            type="button" onClick={toggleRun} disabled={busy || !!restarting}
            title={active ? 'Stop Bot Execution' : 'Start Bot Execution'}
            className={`px-2 py-0.5 border text-[10px] font-bold uppercase transition-all cursor-pointer active:scale-95 flex items-center gap-1 shadow-sm ${
              active
                ? 'border-crypto-danger/70 bg-crypto-danger/20 text-crypto-danger hover:bg-crypto-danger hover:text-white shadow-[0_0_8px_rgba(255,77,77,0.35)]'
                : 'border-crypto-success/70 bg-crypto-success/20 text-crypto-success hover:bg-crypto-success hover:text-black shadow-[0_0_8px_rgba(74,222,128,0.35)] animate-pulse'
            }`}
          >
            {active ? (<><Square className="w-3 h-3 fill-current" /><span>STOP</span></>) : (<><Play className="w-3 h-3 fill-current ml-0.5" /><span>PLAY</span></>)}
          </button>
          <button
            type="button" onClick={toggleRun} disabled={busy || !!restarting}
            className={`text-[11px] font-bold tracking-widest leading-none cursor-pointer hover:opacity-80 transition-opacity ${
              active ? 'text-crypto-success drop-shadow-[0_0_8px_var(--color-crypto-success)]' : 'text-crypto-danger drop-shadow-[0_0_8px_var(--color-crypto-danger)] animate-pulse'
            }`}
          >
            {active ? 'ACTIVE' : 'STOPPED'}
          </button>
        </div>
        <button
          type="button" onClick={tapMode} disabled={busy || !!restarting}
          title={isLive ? 'Tap to disarm and return to Paper Cash' : 'Double-tap to open the Live Kalshi Cash Pool confirmation dialog'}
          className={`text-[10px] px-2.5 py-1 border font-bold uppercase transition-all select-none cursor-pointer flex flex-col items-center justify-center leading-tight active:scale-95 ${
            isLive
              ? 'border-crypto-success text-crypto-success bg-crypto-success/15 shadow-[0_0_10px_rgba(74,222,128,0.25)] hover:bg-crypto-success/25'
              : pending
                ? 'border-crypto-danger text-white bg-crypto-danger animate-pulse shadow-[0_0_15px_rgba(255,59,48,0.5)]'
                : 'border-crypto-primary/60 text-crypto-primary bg-crypto-primary/10 shadow-[0_0_10px_rgba(143,115,255,0.2)] hover:bg-crypto-primary/20'
          }`}
        >
          <div className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${isLive ? 'bg-crypto-success animate-pulse' : 'bg-crypto-primary'}`} />
            <span>{restarting ? 'RESTARTING' : isLive ? 'KALSHI CASH POOL' : pending ? 'TAP AGAIN (2/2)' : 'PAPER CASH'}</span>
          </div>
          <span className="text-[7.5px] opacity-75 font-mono tracking-tighter mt-0.5">
            {isLive ? '(TAP TO DISARM)' : pending ? 'CONFIRM SELECTION' : '(DOUBLE-TAP)'}
          </span>
        </button>
      </div>
      <LiveTradingConfirmationModal isOpen={showLive} onClose={() => setShowLive(false)} onConfirmSuccess={() => waitForRestart('live')} currentKalshiBalance={s?.balance ?? null} overrideOn={s?.run?.killOverride !== false} />
    </div>
  );
}

/** Latency and sample-rate badges (restored): Kalshi WS / REST round trips, Coinbase feed delay, engine pass interval. */
export function LatencyBadges({ latency }: { latency?: { kalshiWs: number | null; kalshiRest: number | null; coinbase: number | null; sample: number | null; kalshiIndex?: number | null; kalshiTransit?: number | null; loopP99?: number | null } }) {
  const ms = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v}ms`);
  return (
    <div className="flex flex-col gap-1 font-mono text-[10px] normal-case tracking-normal">
      <span
        className="px-1.5 py-0.5 border border-crypto-primary/40 bg-black/40 text-crypto-text/80 flex items-center justify-between gap-1.5 leading-none w-full"
        title={`Measured transport latencies: Kalshi WebSocket one way, Kalshi's send stamp to handled here (${ms(latency?.kalshiTransit)}; the ping round trip, which also waits behind every queued frame: ${ms(latency?.kalshiWs)}), Kalshi REST round trip (${ms(latency?.kalshiRest)}), Coinbase ticker delay (${ms(latency?.coinbase)}, recorded for the networks)`}
      >
        <span className="text-[#808080] font-bold">Latency:</span>
        <span className="font-bold flex items-center gap-1">
          <span className="text-emerald-400">WS {ms(latency?.kalshiTransit ?? latency?.kalshiWs)}</span>
          <span className="text-[#606060]">/</span>
          <span className="text-crypto-primary">REST {ms(latency?.kalshiRest)}</span>
          <span className="text-[#606060]">/</span>
          <span className="text-cyan-400 font-normal">CB {ms(latency?.coinbase)} <span className="text-[8px] text-cyan-300/70">(NN)</span></span>
        </span>
      </span>
      <span
        className="px-1.5 py-0.5 border border-crypto-primary/40 bg-black/40 text-crypto-text/80 flex items-center justify-between gap-1 leading-none"
        title={`Measured interval between engine evaluation passes (${ms(latency?.sample)}; 1000ms nominal, longer when the server is busy).`}
      >
        <span className="text-[#808080]">SMP RT:</span>
        <span className="text-crypto-primary font-bold">{ms(latency?.sample)}</span>
      </span>
      <span
        className="px-1.5 py-0.5 border border-crypto-primary/40 bg-black/40 text-crypto-text/80 flex items-center justify-between gap-1 leading-none"
        title={`Main-thread event-loop delay p99 (${ms(latency?.loopP99)}): how long a received message waits before the bot runs it. A WS round trip close to this number is local CPU load, not the network. IDX: Kalshi index vendor timestamp to received (${ms(latency?.kalshiIndex)}).`}
      >
        <span className="text-[#808080]">LOOP:</span>
        <span className="font-bold"><span className={latency?.loopP99 !== null && latency?.loopP99 !== undefined && latency.loopP99 > 500 ? 'text-red-400' : 'text-emerald-400'}>{ms(latency?.loopP99)}</span> <span className="text-[#606060]">/ IDX</span> <span className="text-crypto-primary">{ms(latency?.kalshiIndex)}</span></span>
      </span>
    </div>
  );
}

/**
 * Conditioning champion row: which conditioning settings the bot runs on (research/conditioningRun.ts, an Elite
 * Champion of the trainer's conditioning mode) and a ROLLBACK button that puts the previous champion back (or,
 * with none, the configured settings) and restarts the bot. Hidden until a champion has ever been applied.
 */
export function ConditioningRow({ s, onChange }: { s: any; onChange: () => void }) {
  const c = s?.conditioning as { applied: { version: string; params: Record<string, number>; skipped: string[] } | null; available: string | null; previous: string | null } | undefined;
  const [restarting, setRestarting] = useState(false);
  if (!c || (!c.applied && !c.available)) return null;

  const rollback = async () => {
    const to = c.previous ? `the previous champion (${c.previous})` : 'the configured settings';
    if (!confirm(`Roll back the conditioning champion to ${to}? The bot restarts.`)) return;
    setRestarting(true);
    try {
      const r = await api<{ to: string | null }>('/conditioning/rollback', { method: 'POST' });
      const started = Date.now();
      const poll = async () => {
        try {
          const st = await api<any>('/status');
          if ((st.conditioning?.applied?.version ?? null) === r.to) { setRestarting(false); onChange(); return; }
        } catch { /* restarting */ }
        if (Date.now() - started < 180_000) setTimeout(poll, 2000); else { setRestarting(false); onChange(); }
      };
      setTimeout(poll, 3000);
    } catch (e) { alert((e as Error).message); setRestarting(false); }
  };

  const params = c.applied ? Object.entries(c.applied.params).map(([k, v]) => `${k}=${+v.toFixed(4)}`).join(', ') : '';
  return (
    <div className="flex border-b border-crypto-primary border-opacity-50 px-4 py-2 justify-between items-center gap-3">
      <div className="flex flex-col min-w-0">
        <span className="text-[11px] uppercase tracking-widest text-crypto-primary font-bold">Conditioning</span>
        <span className="text-[10px] opacity-70 normal-case truncate" title={params}>
          {restarting ? 'rolling back, restarting...'
            : c.applied ? `Elite Champion ${c.applied.version}${c.available && c.available !== c.applied.version ? ` (new: ${c.available}, applying)` : ''}`
            : `champion ${c.available} not applied (CONDITIONING_APPLY=false or invalid)`}
        </span>
      </div>
      <button
        type="button" onClick={rollback} disabled={restarting || !c.available}
        title={c.previous ? `Restore ${c.previous} and restart` : 'Return to the configured settings and restart'}
        className="text-[10px] px-2 py-0.5 border font-bold uppercase border-crypto-danger/70 text-crypto-danger bg-crypto-danger/10 hover:bg-crypto-danger/25 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Rollback
      </button>
    </div>
  );
}

/**
 * Strategy playbook row: per coin, its confirmed regime (character : Hilbert trend/cycle) and the weight each
 * strategy family carries there (bot/strategy/playbook.ts). Hidden until the trainer has sent a playbook.
 */
export function PlaybookRow({ s }: { s: any }) {
  const p = s?.playbook as { apply: boolean; version: string | null; enabled: boolean; validation: { why: string } | null; coins: Record<string, { regime: string | null; kalshi: number; perps: number; source: string }> } | null | undefined;
  if (!p || !p.version) return null;
  const coins = Object.entries(p.coins ?? {});
  const state = !p.apply ? 'ignored (PLAYBOOK_APPLY=false)' : p.enabled ? `on (${p.version})` : 'off: failed validation';
  return (
    <div className="flex flex-col border-b border-crypto-primary border-opacity-50 px-4 py-2 gap-1">
      <div className="flex justify-between items-center gap-3">
        <span className="text-[11px] uppercase tracking-widest text-crypto-primary font-bold">Playbook</span>
        <span className="text-[10px] opacity-70 normal-case truncate" title={p.validation?.why ?? ''}>{state}</span>
      </div>
      {coins.length > 0 && (
        <div className="grid grid-cols-[auto_1fr_auto] gap-x-3 text-[10px] font-mono">
          {coins.map(([a, c]) => (
            <div key={a} className="contents">
              <span className="font-bold">{a}</span>
              <span className="opacity-70 truncate">{c.regime ?? 'reading...'}</span>
              <span className={c.kalshi < 1 || c.perps !== 1 ? 'text-crypto-primary' : 'opacity-60'}>K x{c.kalshi} · P x{c.perps}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
