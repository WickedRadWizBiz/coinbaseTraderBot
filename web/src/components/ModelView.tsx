import { Brain } from 'lucide-react';
import { Panel } from './Panel';
import { usePoll } from './usePoll';

const fmt = (v: unknown, dp = 4) => (typeof v === 'number' ? v.toFixed(dp) : v === undefined || v === null ? '—' : String(v));

const GROUP_LABEL: Record<string, string> = {
  base: 'Base (fair value & book)',
  micro: 'Microstructure (Kalshi book & trades)',
  momentum: 'Momentum / TA (settlement index)',
  spot: 'Spot lead-lag (Coinbase)',
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
    </div>
  );
}
