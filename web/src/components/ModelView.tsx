import { Brain } from 'lucide-react';
import { pct } from '../api';
import { Panel } from './Panel';
import { usePoll } from './usePoll';

const fmt = (v: unknown, dp = 4) => (typeof v === 'number' ? v.toFixed(dp) : v === undefined || v === null ? '—' : String(v));

const GROUP_LABEL: Record<string, string> = {
  base: 'Base (fair value & book)',
  micro: 'Microstructure (Kalshi book & trades)',
  momentum: 'Momentum / TA (settlement index)',
  spot: 'Spot lead-lag (Coinbase)',
  macro: 'Macro: USDT.D / BTC.D (Binance × CoinGecko)',
  confluence: 'Confluence (agreement between factors)',
  session: 'Market sessions (Asia / London / New York, DST-correct)',
  time: 'Time of day',
};

function FeatureTable({ model }: { model: any }) {
  const { data: feats } = usePoll<Array<{ name: string; group: string; description: string }>>('/features', 60_000);
  if (!feats) return null;
  const used = new Set<string>(model.kind === 'identity' ? [] : model.features);
  const imp = new Map<string, number>((model.importance ?? []).map((i: any) => [i.feature, i.logLossIncrease]));
  const groups = [...new Set(feats.map((f) => f.group))];
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[11px] uppercase tracking-widest opacity-80">
        Candidate features — {model.kind === 'identity' ? 'none in use (pure fair value until a model is trained)' : `${used.size} in use${model.selected ? ` · selected set: ${model.selected.set}, ${model.selected.hidden} hidden units` : ''}`}
      </div>
      <div className="crt-scroll max-h-[480px] flex flex-col gap-3">
      {groups.map((g) => (
        <div key={g} className="crt-border bg-black/30 p-3">
          <div className="text-xs font-bold uppercase tracking-widest text-crypto-text mb-2">{GROUP_LABEL[g] ?? g}</div>
          <table className="crt-table">
            <tbody>
              {feats.filter((f) => f.group === g).map((f) => (
                <tr key={f.name}>
                  <td className={used.has(f.name) ? 'text-crypto-success font-bold' : 'opacity-60'}>{used.has(f.name) ? '● ' : '○ '}{f.name}</td>
                  <td className="opacity-70 normal-case whitespace-normal">{f.description}</td>
                  <td className="text-right">{imp.has(f.name) ? `Δ logloss ${imp.get(f.name)!.toFixed(4)}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      </div>
    </div>
  );
}

const FACTOR_LABEL: Record<string, string> = {
  usdtd_ret_5m_z: 'USDT.D 5m (z)',
  btcd_rel_5m_z: 'BTC.D 5m, asset-oriented (z)',
  rsi_14_1m: 'RSI(14, 1m)',
  conf_riskon_momentum: 'Risk-on × momentum',
  conf_riskon_momentum_rsi: 'Risk-on × momentum × oversold',
  conf_count: 'Confluence count',
};

function ConfluenceMonitor({ modelKind }: { modelKind: string }) {
  const { data: markets } = usePoll<any[]>('/markets', 2000);
  const rows = (markets ?? []).filter((m) => !m.blocked);
  return (
    <Panel title="Confluence Monitor" scroll="max-h-[560px]">
      <p className="text-xs opacity-80 normal-case leading-relaxed mb-3">
        Confluence factors are signed: positive = bullish for YES, negative = bearish; agreement features are zero unless every factor points the same way.
        Their weights are learned offline and validated, and they act on trades only through the model&apos;s probability: a stronger, agreeing signal raises the edge,
        which raises Kelly size and permits taking liquidity. {modelKind === 'identity' && 'No trained model yet: factors are tracked and recorded but carry no weight.'}
      </p>
      {rows.length === 0 ? <div className="opacity-60 text-xs">[NO PRICED MARKETS]</div> : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {rows.map((m) => (
            <div key={m.ticker} className="crt-border bg-black/30 p-3 flex flex-col gap-2">
              <div className="flex justify-between text-xs font-bold uppercase">
                <span className="text-crypto-text">{m.ticker}</span>
                <span>FV {pct(m.fairValue)} → MODEL <span className="text-crypto-primary">{pct(m.pYes)}</span></span>
              </div>
              <table className="crt-table">
                <tbody>
                  {Object.entries(m.macro ?? {}).map(([k, v]) => {
                    const n = v as number | null;
                    return (
                      <tr key={k}>
                        <td className="opacity-80">{FACTOR_LABEL[k] ?? k}</td>
                        <td className={`text-right ${n == null ? 'opacity-50' : n > 0 ? 'text-crypto-success' : n < 0 ? 'text-crypto-danger' : ''}`}>{n == null ? 'n/a' : n.toFixed(2)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {(m.drivers ?? []).length > 0 && (
                <div className="flex flex-col gap-1">
                  <div className="text-[10px] uppercase tracking-widest opacity-70">Model drivers (log-odds vs fair value, total {m.modelShift >= 0 ? '+' : ''}{(m.modelShift ?? 0).toFixed(3)})</div>
                  {m.drivers.map((d: any) => {
                    const w = Math.min(50, Math.abs(d.logitContribution) * 200);
                    return (
                      <div key={d.feature} className="flex items-center gap-2 text-[11px]">
                        <span className="w-48 truncate opacity-80">{d.feature}</span>
                        <div className="relative flex-1 h-3 crt-border bg-black/30 overflow-hidden">
                          <div className="absolute left-1/2 top-0 bottom-0 w-px bg-crypto-primary" />
                          <div className={`absolute h-full ${d.logitContribution >= 0 ? 'left-1/2 bg-crypto-success/60 dither-bg-light' : 'right-1/2 bg-crypto-danger/60 dither-bg-dark'}`} style={{ width: `${w}%` }} />
                        </div>
                        <span className="w-16 text-right">{d.logitContribution >= 0 ? '+' : ''}{d.logitContribution.toFixed(3)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

export function ModelView() {
  const { data: s } = usePoll<any>('/status', 5000);
  const m = s?.model;
  const v = m?.validation;
  const gates: Array<[string, string, boolean | undefined]> = v ? [
    ['Holdout windows', `${v.nWindows} / 1000`, v.nWindows >= 1000],
    ['Brier: model vs market', `${fmt(v.brierModel)} vs ${fmt(v.brierMarket)}`, v.brierModel < v.brierMarket],
    ['Calibration error', `${fmt(v.maxCalibrationErrorPp, 2)} pp (≤ 3)`, v.maxCalibrationErrorPp <= 3],
    ['Net edge CI low (fee-incl.)', fmt(v.netEdgeCiLow), v.netEdgeCiLow === undefined ? undefined : v.netEdgeCiLow > 0],
    ['Deflated Sharpe', fmt(v.deflatedSharpe), v.deflatedSharpe === undefined ? undefined : v.deflatedSharpe > 0],
  ] : [];

  return (
    <div className="flex flex-col gap-6 w-full max-w-7xl mx-auto pb-24 md:pb-6 relative z-10 text-crypto-primary font-mono text-sm tracking-wider">
      <Panel title={<span className="flex items-center gap-2"><Brain className="w-5 h-5" /> Strategy Brain</span>}>
        {!m ? <div className="animate-pulse">ESTABLISHING LINK...</div> : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="px-2 py-0.5 crt-border bg-black/40 font-bold text-crypto-text">{m.id}</span>
              <span className="px-2 py-0.5 crt-border bg-[#8f73ff15] text-[#e2d5ed]">{m.kind === 'identity' ? 'PURE FAIR VALUE (NO META-MODEL)' : 'FROZEN NEURAL META-MODEL'}</span>
              <span className={`px-2 py-0.5 crt-border font-bold ${m.liveBlockers.length ? 'bg-yellow-500/15 text-yellow-300' : 'bg-crypto-success/20 text-crypto-success'}`}>
                {m.liveBlockers.length ? 'NOT LIVE-VALIDATED' : 'LIVE-VALIDATED'}
              </span>
            </div>
            <p className="text-xs opacity-80 normal-case leading-relaxed">
              Pricing: digital option on the 60-second CF Benchmarks settlement average versus the opening average (ties resolve YES).
              The neural meta-model, when present, learns a regularized correction on top of that fair value. It is trained offline with
              purged walk-forward validation and is read-only at runtime — nothing, including any LLM, can change it while the bot runs.
            </p>
            {gates.length > 0 && (
              <table className="crt-table">
                <thead><tr><th>Go-live gate</th><th>Value</th><th>Status</th></tr></thead>
                <tbody>
                  {gates.map(([k, val, ok]) => (
                    <tr key={k}><td>{k}</td><td>{val}</td><td className={ok === undefined ? 'opacity-60' : ok ? 'text-crypto-success' : 'text-crypto-danger'}>{ok === undefined ? 'NOT RUN' : ok ? 'PASS' : 'FAIL'}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
            <FeatureTable model={m} />
            {m.liveBlockers.length > 0 && (
              <div className="border border-yellow-500/40 bg-yellow-500/10 p-3 text-yellow-300 text-xs">
                <div className="font-bold uppercase mb-1">Live trading blocked until:</div>
                <ul className="list-disc pl-5 normal-case">{m.liveBlockers.map((b: string) => <li key={b}>{b}</li>)}</ul>
              </div>
            )}
          </div>
        )}
      </Panel>
      {m && <ConfluenceMonitor modelKind={m.kind} />}
    </div>
  );
}
