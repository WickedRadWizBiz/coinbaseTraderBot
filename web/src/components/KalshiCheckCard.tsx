import { usd } from '../api';
import { Panel } from './Panel';
import { usePoll } from './usePoll';

/** Bot vs Kalshi: fills, settlements and cash compared with Kalshi's own records (bot/recon/kalshiCheck.ts). */
export function KalshiCheckCard({ live }: { live: boolean }) {
  const { data: k } = usePoll<any>('/kalshi-check', 30_000);
  const today = k?.today;
  const row = (label: string, bot: string, kalshi: string, same: boolean) => (
    <tr key={label} className="border-b border-crypto-primary/20">
      <td className="py-1 pr-3 uppercase text-[11px] opacity-80">{label}</td>
      <td className="py-1 pr-3 text-right">{bot}</td>
      <td className={`py-1 text-right ${same ? 'text-crypto-success' : 'text-crypto-danger'}`}>{kalshi}</td>
    </tr>
  );
  const n = (x: number | undefined) => (x === undefined ? '—' : String(+x.toFixed(2)));
  const eq = (a?: number, b?: number, tol = 0.01) => a !== undefined && b !== undefined && Math.abs(a - b) <= tol;
  const cash = today?.cash;
  return (
    <Panel
      title="Kalshi Check"
      right={k ? <span className={`text-sm ${k.ok ? 'text-crypto-success' : 'text-crypto-danger'}`}>{k.ok ? 'BOOKS MATCH' : `${k.mismatches24h} MISMATCH${k.mismatches24h === 1 ? '' : 'ES'} (24 H)`}</span> : undefined}
      scroll="h-[360px]"
    >
      {!k ? <div className="p-2 animate-pulse">WAITING FOR THE FIRST CHECK...</div> : (
        <div className="flex flex-col gap-3 text-sm">
          <div className="text-[11px] opacity-70">
            {live ? 'Every fill, settlement and the cash balance compared with Kalshi’s own records.' : 'Paper mode: the “exchange” is the simulator, so this only proves the plumbing. In live it compares with Kalshi.'}
            {' '}Checked {k.checked.fills} fills ({k.matched.fills} matched), {k.checked.settlements} settlements ({k.matched.settlements} matched).
            {k.cash?.diff != null && <> Cash: Kalshi {usd(k.cash.kalshi)}, bot expects {usd(k.cash.botExpected)} ({k.cash.diff === 0 ? 'equal' : `${k.cash.diff > 0 ? '+' : ''}${k.cash.diff.toFixed(2)}`}).</>}
            {k.lastError && <span className="text-crypto-danger"> {k.lastError}</span>}
          </div>
          {today && (
            <table className="w-full">
              <thead><tr className="text-[10px] uppercase opacity-60"><th className="text-left">Today (UTC)</th><th className="text-right">Bot</th><th className="text-right">Kalshi</th></tr></thead>
              <tbody>
                {row('Fills', n(today.bot.fills), n(today.kalshi.fills), today.bot.fills === today.kalshi.fills)}
                {row('Contracts', n(today.bot.contracts), n(today.kalshi.contracts), eq(today.bot.contracts, today.kalshi.contracts, 1e-6))}
                {row('Fees', usd(today.bot.fees), usd(today.kalshi.fees), eq(today.bot.fees, today.kalshi.fees))}
                {row('Settled markets', n(today.bot.settled), n(today.kalshi.settled), today.bot.settled === today.kalshi.settled)}
                {row('Payouts', usd(today.bot.payout), usd(today.kalshi.payout), eq(today.bot.payout, today.kalshi.payout))}
                {cash && row('Cash change', usd(cash.botExpectedChange), usd(cash.kalshiEnd - cash.kalshiStart), eq(cash.botExpectedChange, cash.kalshiEnd - cash.kalshiStart, 0.05))}
              </tbody>
            </table>
          )}
          {(k.mismatches ?? []).length > 0 && (
            <div className="flex flex-col gap-1">
              <div className="text-[10px] uppercase opacity-60">Latest mismatches</div>
              {(k.mismatches as any[]).slice(0, 8).map((m, i) => (
                <div key={i} className="text-[11px] text-crypto-danger">{new Date(m.ts).toISOString().slice(5, 16).replace('T', ' ')} · {m.what}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
