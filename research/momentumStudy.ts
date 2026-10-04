// Volatile-moment study. (1) The existing fast setups split by how volatile the moment is (ATR rank,
// volume surge): do they clear fees when the market is moving? (2) A momentum-burst setup: join a move
// that is happening now (wide-range bar, volume spike, one-sided taker flow, breakout of the recent
// range, higher timeframe agreeing), stop under the burst bar, ride it with an ATR trail.
//
//   npx tsx research/momentumStudy.ts [historyDir]
import path from 'path';
import { loadAssetBars, simulateSetup } from './trainSetupModel';
import { detectAt, TF_MS, type SetupSeries, type SetupSignal } from '../bot/setups/detectors';
import { DEFAULT_COSTS, tradeResult, type OpenTrade } from '../bot/setups/exits';
import type { Timeframe } from '../bot/ta/knowledge';

const FROM = Date.UTC(2020, 0, 1), SPLIT = Date.UTC(2024, 0, 1);

function stats(ts: OpenTrade[], days: number): string {
  if (!ts.length) return 'no trades';
  const rs = ts.map((t) => ({ t, ...tradeResult(t) }));
  const w = rs.filter((x) => x.ret > 0), l = rs.filter((x) => x.ret <= 0), n = rs.length;
  const gross = rs.reduce((a, x) => a + x.r + x.t.costs / (Math.abs(x.t.entry - x.t.initialStop) / x.t.entry), 0) / n;
  const net = rs.reduce((a, x) => a + x.r, 0) / n;
  const sd = Math.sqrt(rs.reduce((a, x) => a + (x.r - net) ** 2, 0) / n);
  const stop = ts.map((t) => Math.abs(t.entry - t.initialStop) / t.entry).sort((a, b) => a - b)[n >> 1];
  return `${String(n).padStart(6)} trades (${(n / days).toFixed(2)}/day)  win ${(100 * w.length / n).toFixed(1).padStart(5)}%  avg win ${(w.reduce((a, x) => a + x.r, 0) / Math.max(1, w.length)).toFixed(2)}R  avg loss ${(l.reduce((a, x) => a + x.r, 0) / Math.max(1, l.length)).toFixed(2)}R  gross ${gross.toFixed(3)}R  NET ${net.toFixed(3)}R (t ${(net / (sd / Math.sqrt(n))).toFixed(1)})  median stop ${(100 * stop).toFixed(2)}%`;
}

/** Momentum burst at bar i (undefined = none). */
function burstAt(asset: string, tf: Timeframe, s: SetupSeries, i: number, o: { volX: number; rangeX: number; flow: number; htf: boolean; trail: number; partial: boolean }): SetupSignal | undefined {
  if (i < 60) return undefined;
  const cs = s.cs, b = cs[i], a = s.atr[i - 1];
  if (!(a > 0) || !(s.volAvg[i - 1] > 0)) return undefined;
  const range = b.h - b.l, body = Math.abs(b.c - b.o);
  if (range < o.rangeX * a || body < 0.6 * range || b.v < o.volX * s.volAvg[i - 1]) return undefined;
  let hi = -Infinity, lo = Infinity;
  for (let k = i - 20; k < i; k++) { hi = Math.max(hi, cs[k].h); lo = Math.min(lo, cs[k].l); }
  const sh = s.share[i];
  const H = s.htf;
  const up = !o.htf || (H && H.s20[i] > H.s50[i]), dn = !o.htf || (H && H.s20[i] < H.s50[i]);
  const plan = (dir: 1 | -1, stop: number) => { const r = Math.abs(b.c - stop); return { target1: o.partial ? b.c + dir * r : undefined, target2: undefined, trailAtr: o.trail, maxBars: 16 }; };
  const mk = (dir: 1 | -1, stop: number): SetupSignal => ({ asset, lane: 'slow', kind: 'breakout', tf, dir, ts: b.ts, ref: b.c, stop, atr: a, plan: plan(dir, stop), info: { rsi: s.rsi[i], pctB: s.pctB[i], flow: sh, bandwidth: s.bandwidth[i], volRatio: b.v / s.volAvg[i - 1] } });
  // lane 'slow' here only switches the trail on from entry (the momentum trade rides from the start).
  if (b.c > b.o && b.c > hi && sh >= o.flow && up) return mk(1, Math.min(b.l, b.c - a) - 0.1 * a);
  if (b.c < b.o && b.c < lo && sh <= 1 - o.flow && dn) return mk(-1, Math.max(b.h, b.c + a) + 0.1 * a);
  return undefined;
}

function main(hist: string) {
  const assets = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'].map((a) => loadAssetBars(hist, a)!).filter(Boolean);
  const end = Math.max(...assets.map((A) => A.m15[A.m15.length - 1].ts));
  const days = (lo: number, hi: number) => (Math.min(hi, end) - lo) / 86_400_000;

  // (1) Existing fast setups by volatility.
  console.log('\n(1) Existing fast setups (15m + 1h fade / pullback) by how volatile the moment is, 2020 on');
  const buckets: Record<string, OpenTrade[]> = {};
  for (const A of assets) for (const tf of ['15m', '1h'] as const) {
    const s = A.series[tf]!;
    // ATR as a share of price, ranked against its own last 500 bars.
    for (let i = 600; i < s.cs.length; i++) {
      if (s.cs[i].ts < FROM) continue;
      const g = detectAt(A.asset, tf, s, i);
      if (!g) continue;
      const ap = s.atr[i] / s.cs[i].c;
      let below = 0; for (let k = i - 500; k < i; k++) if (s.atr[k] / s.cs[k].c < ap) below++;
      const rank = below / 500, vr = g.info.volRatio;
      const key = `${tf} ATR rank ${rank >= 0.9 ? 'top 10%' : rank >= 0.7 ? '70-90%' : 'below 70%'}${vr >= 2 ? ', volume >= 2x' : ''}`;
      const t = simulateSetup(A, g, DEFAULT_COSTS);
      if (t?.closed) (buckets[key] ??= []).push(t);
    }
  }
  for (const k of Object.keys(buckets).sort()) console.log(`  ${k.padEnd(40)} ${stats(buckets[k], days(FROM, end))}`);

  // (2) Momentum bursts.
  console.log('\n(2) Momentum bursts (join the move), base-tier costs');
  const VARIANTS = [
    { name: 'vol 2x, range 1.5 ATR, flow 60%, HTF agrees, trail 1.5', volX: 2, rangeX: 1.5, flow: 0.6, htf: true, trail: 1.5, partial: false },
    { name: 'vol 2x, range 1.5 ATR, flow 60%, HTF agrees, trail 2.5', volX: 2, rangeX: 1.5, flow: 0.6, htf: true, trail: 2.5, partial: false },
    { name: 'vol 3x, range 2 ATR, flow 65%, HTF agrees, trail 2', volX: 3, rangeX: 2, flow: 0.65, htf: true, trail: 2, partial: false },
    { name: 'vol 3x, range 2 ATR, flow 65%, any trend, trail 2', volX: 3, rangeX: 2, flow: 0.65, htf: false, trail: 2, partial: false },
    { name: 'vol 3x, range 2 ATR, flow 65%, HTF agrees, half at 1R + trail 2', volX: 3, rangeX: 2, flow: 0.65, htf: true, trail: 2, partial: true },
  ];
  for (const tf of ['15m', '1h'] as const) {
    for (const v of VARIANTS) {
      const early: OpenTrade[] = [], late: OpenTrade[] = [];
      for (const A of assets) {
        const s = A.series[tf]!;
        for (let i = 60; i < s.cs.length; i++) {
          if (s.cs[i].ts < FROM) continue;
          const g = burstAt(A.asset, tf, s, i, v);
          if (!g) continue;
          const t = simulateSetup(A, g, DEFAULT_COSTS);
          if (t?.closed) (g.ts < SPLIT ? early : late).push(t);
        }
      }
      console.log(`  ${tf} ${v.name}`);
      console.log(`      2020-23: ${stats(early, days(FROM, SPLIT))}`);
      console.log(`      2024-26: ${stats(late, days(SPLIT, end))}`);
    }
  }
  void TF_MS;
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) main(process.argv[2] ?? 'data/history');
