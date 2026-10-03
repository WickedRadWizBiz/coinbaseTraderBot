// Exit-plan study: the same setups (2020 on, every asset) traded with different take-profit / trailing
// plans, after costs. Shows where each setup's result comes from: how often each exit fires, the
// average winner and loser in R, and the net R per trade.
//
//   npx tsx research/exitStudy.ts [historyDir]
import path from 'path';
import { loadAssetBars, simulateSetup } from './trainSetupModel';
import { detectAt, FAST_TFS, SLOW_TFS, type SetupSignal } from '../bot/setups/detectors';
import { DEFAULT_COSTS, tradeResult, type OpenTrade } from '../bot/setups/exits';

const FROM = Date.UTC(2020, 0, 1);

type Variant = (s: SetupSignal) => SetupSignal;
const risk = (s: SetupSignal) => Math.abs(s.ref - s.stop);
const VARIANTS: Record<string, Variant> = {
  current: (s) => s,
  'no partial (all at final target)': (s) => ({ ...s, plan: { ...s.plan, target1: undefined } }),
  'fixed 2R': (s) => ({ ...s, plan: { ...s.plan, target1: undefined, target2: s.ref + s.dir * 2 * risk(s) } }),
  'fixed 3R': (s) => ({ ...s, plan: { ...s.plan, target1: undefined, target2: s.ref + s.dir * 3 * risk(s) } }),
  'half at 1R, trail rest 2 ATR': (s) => ({ ...s, plan: { target1: s.ref + s.dir * risk(s), target2: undefined, trailAtr: 2, maxBars: s.lane === 'slow' ? 60 : 48 } }),
  'trail only 2 ATR (let it run)': (s) => ({ ...s, lane: 'slow', plan: { target1: undefined, target2: undefined, trailAtr: 2, maxBars: s.lane === 'slow' ? 60 : 48 } }),
  'trail only 3 ATR': (s) => ({ ...s, lane: 'slow', plan: { target1: undefined, target2: undefined, trailAtr: 3, maxBars: s.lane === 'slow' ? 90 : 96 } }),
};

function main(hist: string) {
  const assets = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'].map((a) => loadAssetBars(hist, a)!).filter(Boolean);
  const sigs: Array<{ A: (typeof assets)[number]; s: SetupSignal }> = [];
  for (const A of assets) for (const tf of [...FAST_TFS, ...SLOW_TFS]) {
    const se = A.series[tf]!;
    for (let i = 60; i < se.cs.length; i++) { if (se.cs[i].ts < FROM) continue; const g = detectAt(A.asset, tf, se, i); if (g) sigs.push({ A, s: g }); }
  }
  const kinds = [...new Set(sigs.map((x) => `${x.s.tf} ${x.s.kind}`))];
  for (const kind of kinds) {
    const mine = sigs.filter((x) => `${x.s.tf} ${x.s.kind}` === kind);
    console.log(`\n=== ${kind}: ${mine.length} setups since 2020 ===`);
    console.log('  exit plan                           win%   avg win R  avg loss R  net R/trade  gross R  median hold   exits (stop / b-e / trail / target / time)');
    for (const [name, v] of Object.entries(VARIANTS)) {
      const ts: OpenTrade[] = [];
      for (const { A, s } of mine) { const t = simulateSetup(A, v(s), DEFAULT_COSTS); if (t?.closed) ts.push(t); }
      const rs = ts.map((t) => ({ t, ...tradeResult(t) }));
      const w = rs.filter((x) => x.ret > 0), l = rs.filter((x) => x.ret <= 0);
      const n = rs.length;
      const gross = rs.reduce((a, x) => a + x.r + x.t.costs / (Math.abs(x.t.entry - x.t.initialStop) / x.t.entry), 0) / n;
      const holds = ts.map((t) => (t.closed!.ts - t.entryTs) / 3_600_000).sort((a, b) => a - b);
      const cnt = (r: string) => ts.filter((t) => t.closed!.reason === r).length;
      console.log(`  ${name.padEnd(34)} ${(100 * w.length / n).toFixed(1).padStart(5)}  ${(w.reduce((a, x) => a + x.r, 0) / Math.max(1, w.length)).toFixed(2).padStart(9)}  ${(l.reduce((a, x) => a + x.r, 0) / Math.max(1, l.length)).toFixed(2).padStart(10)}  ${(rs.reduce((a, x) => a + x.r, 0) / n).toFixed(3).padStart(11)}  ${gross.toFixed(3).padStart(7)}  ${holds[holds.length >> 1].toFixed(1).padStart(8)} h   ${['stop', 'breakeven', 'trail', 'target', 'time'].map((r) => `${(100 * cnt(r) / n).toFixed(0)}%`).join(' / ')}`);
    }
  }
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) main(process.argv[2] ?? 'data/history');
