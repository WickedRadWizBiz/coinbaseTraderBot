import { useState } from 'react';
import { api } from '../api';

/**
 * Fractal Alignment Engine and waterfall mode (bot/macro): where the 2018-to-now BTC.D cycle stands on its 2016-2017
 * parent, the four trigger legs, and the ARM switch. Arming is possible only after BTC.D's first close at or below
 * the gate (55%); the server refuses it before. Disarming always works.
 */
type Fractal = {
  asOf: number; parentDate: string; progress: number; phase: string; dilation: number; localDilation: number;
  fit: { r: number; recentR: number; maePts: number; recentMaePts: number };
  proj: { d30: number; d90: number; d180: number };
  nextWaterfall: { startTs: number; endTs: number; fromBtcd: number; toBtcd: number; weeksAway: number; inside: boolean } | null;
  low: { ts: number; btcd: number } | null;
  projectedGateCross: number | null;
  chart: { child: Array<[number, number, number]>; projection: Array<[number, number]> };
};
type Waterfall = {
  gateHitAt: number | null; armed: boolean; armable: boolean; level: 'off' | 'armed' | 'triggered'; why: string; gate: number;
  legs: { gate: boolean; fractal: boolean; usdt: boolean; shib: boolean } | null; signal: boolean; readings: string[];
  btcd: number | null; usdtd: number | null; shibVelocity: number | null; parentHistory: boolean; fractal: Fractal | null; error: string | null;
};

const day = (ts: number | null | undefined) => (ts ? new Date(ts).toISOString().slice(0, 10) : '—');
const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(d)}%`);

function Chart({ f, gate }: { f: Fractal; gate: number }) {
  const child = f.chart.child, proj = f.chart.projection;
  if (child.length < 2) return null;
  const xs = [...child.map((c) => c[0]), ...proj.map((p) => p[0])];
  const ys = [...child.flatMap((c) => [c[1], c[2]]), ...proj.map((p) => p[1]), gate];
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys) - 1, y1 = Math.max(...ys) + 1;
  const W = 320, H = 70;
  const X = (t: number) => ((t - x0) / Math.max(1, x1 - x0)) * W, Y = (v: number) => H - ((v - y0) / Math.max(1e-9, y1 - y0)) * H;
  const line = (pts: Array<[number, number]>) => pts.map(([t, v], i) => `${i ? 'L' : 'M'}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const last = child[child.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[70px]" preserveAspectRatio="none" aria-label="BTC.D since 2018, the 2016-2017 parent mapped onto it, and the projection">
      <line x1={0} x2={W} y1={Y(gate)} y2={Y(gate)} stroke="currentColor" strokeOpacity={0.35} strokeDasharray="2 3" />
      <path d={line(child.map((c) => [c[0], c[2]]))} fill="none" stroke="currentColor" strokeOpacity={0.45} strokeDasharray="4 2" strokeWidth={1} />
      <path d={line(child.map((c) => [c[0], c[1]]))} fill="none" className="stroke-crypto-primary" strokeWidth={1.4} />
      {proj.length > 0 && <path d={line([[last[0], last[1]], ...proj])} fill="none" className="stroke-crypto-primary" strokeOpacity={0.6} strokeDasharray="1 2" strokeWidth={1.4} />}
    </svg>
  );
}

export function WaterfallRow({ s, onChange }: { s: any; onChange: () => void }) {
  const w = s?.waterfall as Waterfall | null | undefined;
  const [busy, setBusy] = useState(false);
  if (!w) return null;
  const f = w.fractal;

  const toggle = async () => {
    const on = !w.armed;
    if (on && !confirm('Arm waterfall mode? Tennis pauses and Kalshi binaries are held to a small share of the bank now; when the trigger fires, Kalshi binaries pause too and the perps lanes lean into alt longs.')) return;
    setBusy(true);
    try { await api('/waterfall', { method: 'POST', body: JSON.stringify({ armed: on }) }); } catch (e) { alert((e as Error).message); }
    setBusy(false);
    onChange();
  };

  const state = w.level === 'triggered' ? 'TRIGGERED' : w.level === 'armed' ? 'ARMED, waiting for the trigger' : w.armable ? `gate hit ${day(w.gateHitAt)}: can be armed` : `locked until BTC.D closes at or below ${w.gate}%`;
  const legs: Array<[string, boolean | undefined]> = [['gate', w.legs?.gate], ['fractal', w.legs?.fractal], ['usdt', w.legs?.usdt], ['shib', w.legs?.shib]];
  return (
    <div className="flex flex-col border-b border-crypto-primary border-opacity-50 px-4 py-2 gap-1">
      <div className="flex justify-between items-center gap-3">
        <div className="flex flex-col min-w-0">
          <span className="text-[11px] uppercase tracking-widest text-crypto-primary font-bold">Waterfall</span>
          <span className={`text-[10px] normal-case truncate ${w.level === 'triggered' ? 'text-crypto-danger font-bold' : 'opacity-70'}`} title={w.why}>{state}</span>
        </div>
        <button
          type="button" onClick={toggle} disabled={busy || (!w.armed && !w.armable)}
          title={w.armable || w.armed ? (w.armed ? 'Disarm waterfall mode' : 'Arm waterfall mode') : `Available after BTC.D's first close at or below ${w.gate}%`}
          className={`text-[10px] px-2 py-0.5 border font-bold uppercase cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${w.armed ? 'border-crypto-danger/70 text-crypto-danger bg-crypto-danger/10 hover:bg-crypto-danger/25' : 'border-crypto-primary/70 text-crypto-primary bg-crypto-primary/10 hover:bg-crypto-primary/25'}`}
        >
          {w.armed ? 'Disarm' : 'Arm'}
        </button>
      </div>
      <div className="flex gap-1 flex-wrap">
        {legs.map(([k, on]) => (
          <span key={k} className={`text-[9px] px-1 border uppercase font-mono ${on ? 'border-crypto-success/70 text-crypto-success' : 'border-current opacity-40'}`}>{k}</span>
        ))}
        <span className="text-[10px] font-mono opacity-70 ml-auto">BTC.D {pct(w.btcd, 2)} · USDT.D {pct(w.usdtd, 2)} · SHIB {w.shibVelocity ? `${w.shibVelocity.toFixed(2)}x` : '—'}</span>
      </div>
      {f ? (
        <>
          <Chart f={f} gate={w.gate} />
          <div className="text-[10px] font-mono opacity-80 leading-snug">
            <div title="The parent week matched to now, and how far through the 2016-2017 parent the cycle is">parent {f.parentDate} · {(100 * f.progress).toFixed(0)}% · {f.phase}</div>
            <div title="Child time per parent time, since 2018 and over the last 26 weeks; fit after the level map">dilation {f.dilation.toFixed(2)}x (recent {f.localDilation.toFixed(2)}x) · fit {f.fit.r.toFixed(2)} / last year {f.fit.recentR.toFixed(2)} (±{f.fit.recentMaePts.toFixed(1)} pts)</div>
            <div title="The parent's remaining path on today's scale">projection 30d {pct(f.proj.d30)} · 90d {pct(f.proj.d90)} · 180d {pct(f.proj.d180)}{f.projectedGateCross ? ` · ${w.gate}% ~${day(f.projectedGateCross)}` : ''}</div>
            {f.nextWaterfall && <div>{f.nextWaterfall.inside ? 'inside the parent waterfall' : `next waterfall ~${day(f.nextWaterfall.startTs)} (${f.nextWaterfall.weeksAway.toFixed(0)} wk)`}: to {pct(f.nextWaterfall.toBtcd)} ~{day(f.nextWaterfall.endTs)}</div>}
          </div>
        </>
      ) : (
        <span className="text-[10px] opacity-60 normal-case">{w.parentHistory ? 'aligning (needs a year of weekly BTC.D since 2018)' : 'no BTC.D history for 2016-2017: the pipeline fetches it from TradingView (CRYPTOCAP:BTC.D)'}</span>
      )}
      {w.error && <span className="text-[10px] text-crypto-danger normal-case truncate" title={w.error}>{w.error}</span>}
    </div>
  );
}
