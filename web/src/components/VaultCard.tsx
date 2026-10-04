import { Lock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, clock, usd } from '../api';

function countdown(ms: number): string {
  if (!(ms > 0)) return 'now';
  const m = Math.floor(ms / 60_000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${m}m`;
}

const KIND_TONE: Record<string, string> = {
  vault: 'text-crypto-success', pocket: 'text-crypto-primary', release: 'text-crypto-text',
  withdrawal: 'text-crypto-danger', deposit: 'text-crypto-success', quota_reset: 'opacity-70',
};

/** Profit vault / pocket (bookkeeping rules on the Kalshi cash pool). */
export function VaultCard({ vault, session, onChange }: { vault: any; session: any; onChange: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  if (!vault) return null;
  if (!vault.enabled) return null;
  const pct = Math.min(100, (vault.quotaFilled / Math.max(0.01, vault.quotaUsd)) * 100);
  const pocketing = vault.phase === 'pocketing';

  const record = async () => {
    const raw = prompt('Record a withdrawal from the Kalshi account (dollars). It comes out of the vault first, then the pocket.');
    if (raw === null) return;
    const amount = Number(raw);
    if (!(amount > 0)) { alert('Enter a positive dollar amount.'); return; }
    await api('/vault/withdrawal', { method: 'POST', body: JSON.stringify({ amount }) }).catch((e) => alert(e.message));
    onChange();
  };

  return (
    <div className="crt-grid-panel relative overflow-hidden !p-0">
      <div className="absolute inset-0 heavy-dither-overlay pointer-events-none" />
      <div className="relative z-10 flex flex-col">
        <h3 className="font-bold tracking-[0.2em] text-lg uppercase text-crypto-text border-b border-crypto-primary pb-2 px-4 pt-4 flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2"><Lock className="w-5 h-5" /> Profit Vault</span>
          <span className={`px-2 py-0.5 text-[10px] font-bold tracking-widest border ${pocketing ? 'bg-crypto-primary/20 text-crypto-primary border-crypto-primary/60' : 'bg-crypto-success/20 text-crypto-success border-crypto-success/60 animate-pulse'}`}>
            {pocketing ? `POCKETING ${Math.round(vault.pocketShare * 100)}%` : `VAULTING ${Math.round(vault.winShare * 100)}% OF WINS`}
          </span>
        </h3>
        <div className="grid grid-cols-2">
          <div className="px-4 py-3 border-b border-r border-crypto-primary/50 bg-[#8f73ff08]">
            <div className="text-[11px] uppercase tracking-widest text-crypto-primary">Vault</div>
            <div className="text-xl font-bold text-crypto-success">{usd(vault.vault)}</div>
            <div className="text-[10px] opacity-60">untouchable · withdrawals come from here first</div>
          </div>
          <div className="px-4 py-3 border-b border-crypto-primary/50 bg-[#8f73ff08]">
            <div className="text-[11px] uppercase tracking-widest text-crypto-primary">Pocket</div>
            <div className="text-xl font-bold text-crypto-text">{usd(vault.pocket)}</div>
            <div className="text-[10px] opacity-60">{vault.nextRelease ? `releases at US open in ${countdown(vault.nextRelease - now)}` : 'released at each US market open'}</div>
          </div>
        </div>
        <div className="px-4 py-3 flex flex-col gap-2 border-b border-crypto-primary/50">
          <div className="flex justify-between text-xs font-bold tracking-widest uppercase gap-2 flex-wrap">
            <span className="text-crypto-text">Today&apos;s goal {usd(vault.dailyVaulted)} / {usd(vault.dailyGoalUsd)}</span>
            <span className={vault.dailyGoalMet ? 'text-crypto-success' : 'text-crypto-primary'}>
              {vault.dailyGoalMet ? `GOAL MET${vault.dailyVaulted > vault.dailyGoalUsd ? ` · +${usd(vault.dailyVaulted - vault.dailyGoalUsd)} OVER` : ''}` : `${usd(vault.dailyGoalUsd - vault.dailyVaulted)} to go`} · day resets at US open ({countdown(vault.nextUsOpen - now)})
            </span>
          </div>
          <div className="relative w-full h-5 crt-border bg-black/30 overflow-hidden">
            <div className="absolute left-0 top-0 h-full dither-bg-light bg-crypto-primary/60 transition-all duration-500" style={{ width: `${Math.min(100, (vault.dailyVaulted / Math.max(0.01, vault.dailyGoalUsd)) * 100)}%` }} />
          </div>
        </div>
        <div className="px-4 py-3 flex flex-col gap-2 border-b border-crypto-primary/50">
          <div className="flex justify-between text-xs font-bold tracking-widest uppercase gap-2 flex-wrap">
            <span className="text-crypto-primary">Session quota {usd(vault.quotaFilled)} / {usd(vault.quotaUsd)}</span>
            <span className="text-crypto-text">
              {pocketing
                ? `met · resets ${vault.quotaReset === 'session' ? `at ${session?.next?.label ?? 'next session'}${session?.next ? ` (${countdown(session.next.at - now)})` : ''}` : `at US open (${countdown(vault.nextUsOpen - now)})`}`
                : `${usd(vault.quotaUsd - vault.quotaFilled)} to go`}
            </span>
          </div>
          <div className="relative w-full h-5 crt-border bg-black/30 overflow-hidden">
            <div className="absolute left-0 top-0 h-full dither-bg-light bg-crypto-success/60 transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="px-4 py-3 flex flex-col gap-1 max-h-40 overflow-y-auto">
          {(vault.events ?? []).length === 0 && <div className="text-[11px] opacity-60">[NO VAULT ACTIVITY YET]</div>}
          {(vault.events ?? []).slice(0, 8).map((e: any, i: number) => (
            <div key={`${e.ts}-${i}`} className="flex justify-between gap-2 text-[11px]">
              <span className="opacity-70">{clock(e.ts)}</span>
              <span className={`uppercase font-bold ${KIND_TONE[e.kind] ?? ''}`}>{e.kind.replace('_', ' ')}</span>
              <span className="text-crypto-text">{usd(e.amount)}</span>
              <span className="opacity-60 truncate max-w-[45%] normal-case" title={e.note}>{e.ticker ?? e.note ?? ''}</span>
            </div>
          ))}
        </div>
        <div className="px-4 pb-4 flex items-center justify-between gap-2 flex-wrap">
          <span className="text-[10px] opacity-60 normal-case">Bookkeeping only: reserved money stays in your Kalshi cash; the bot just won&apos;t trade it. Withdrawn to date: {usd(vault.withdrawnTotal)}.</span>
          <button onClick={record} className="flat-btn"><span>Record Withdrawal</span></button>
        </div>
      </div>
    </div>
  );
}
