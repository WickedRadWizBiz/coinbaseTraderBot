// Per-side parameter search for the 1h momentum burst (longs and shorts tuned separately; both always
// trade). Grid over the entry thresholds and the exits, scored on the tuning window only, every config
// then checked on the later test window. Runs unattended (no interaction needed while it searches).
//
//   npx tsx research/burstParamSearch.ts [historyDir] [out.json]
//
// Searched per side: bar range (x prior ATR), volume spike (x 20-bar average), taker-flow share on the
// move's side, breakout lookback, daily-trend rule (off / on), ATR trail, time stop. Fixed: body >= 60%
// of the range, higher-timeframe trend agreeing, structure stop (bar extreme, at least 1 ATR).
// Overlap: within one coin and side a trade is skipped while the previous one is still open (as the
// lane book holds one position per coin). Objective: t-statistic of net R per trade (rewards a steady
// edge and enough trades), at least MIN_TRADES trades in the tuning window.
import fs from 'fs';
import path from 'path';
import { loadAssetBars, simulateSetup } from './trainSetupModel';
import { dailyTrendAt, type SetupSignal } from '../bot/setups/detectors';
import { DEFAULT_COSTS, tradeResult } from '../bot/setups/exits';

const TUNE_FROM = Date.UTC(2020, 0, 1), TEST_FROM = Date.UTC(2025, 6, 1);
const H = 3_600_000;
const MIN_TRADES = 80;
const GRID = {
  range: [1.25, 1.5, 1.75, 2, 2.5],
  vol: [1.5, 2, 2.5, 3, 4],
  flow: [0.55, 0.6, 0.65, 0.7],
  lookback: [10, 20, 40],
  daily: [0, 1],
  trail: [2, 2.5, 3, 3.5],
  bars: [12, 16, 24, 32],
};

interface Cand { asset: string; ts: number; side: 1 | -1; range: number; vol: number; flow: number; brk: Record<number, boolean>; daily: -1 | 0 | 1; out: Map<string, { r: number; exit: number }> }

function main(hist: string, outFile: string) {
  const t0 = Date.now();
  const cands: Cand[] = [];
  for (const name of ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE']) {
    const A = loadAssetBars(hist, name);
    if (!A) continue;
    const s = A.series['1h']!, d = A.series['1d']!, cs = s.cs;
    for (let i = 60; i < cs.length; i++) {
      const b = cs[i];
      if (b.ts < TUNE_FROM) continue;
      const a = s.atr[i - 1], range = b.h - b.l;
      if (!(a > 0) || !(s.volAvg[i - 1] > 0) || !s.htf || !Number.isFinite(s.htf.s50[i])) continue;
      if (range < GRID.range[0] * a || Math.abs(b.c - b.o) < 0.6 * range || b.v < GRID.vol[0] * s.volAvg[i - 1]) continue;
      const side: 1 | -1 = b.c > b.o ? 1 : -1;
      const flow = side > 0 ? s.share[i] : 1 - s.share[i];
      if (!(flow >= GRID.flow[0])) continue;
      if (side > 0 ? !(s.htf.s20[i] > s.htf.s50[i]) : !(s.htf.s20[i] < s.htf.s50[i])) continue;
      const brk: Record<number, boolean> = {};
      for (const lb of GRID.lookback) {
        let hi = -Infinity, lo = Infinity;
        for (let k = i - lb; k < i; k++) { hi = Math.max(hi, cs[k].h); lo = Math.min(lo, cs[k].l); }
        brk[lb] = side > 0 ? b.c > hi : b.c < lo;
      }
      if (!brk[GRID.lookback[0]]) continue; // the shortest lookback is the loosest
      const stop = side > 0 ? Math.min(b.l, b.c - a) - 0.1 * a : Math.max(b.h, b.c + a) + 0.1 * a;
      const out = new Map<string, { r: number; exit: number }>();
      for (const trail of GRID.trail) for (const bars of GRID.bars) {
        const sig: SetupSignal = { asset: name, lane: 'fast', kind: 'burst', tf: '1h', dir: side, ts: b.ts, ref: b.c, stop, atr: a, plan: { trailAtr: trail, maxBars: bars, trailFromStart: true }, info: { rsi: s.rsi[i], pctB: s.pctB[i], flow: s.share[i], bandwidth: s.bandwidth[i], volRatio: b.v / s.volAvg[i - 1] } };
        const t = simulateSetup(A, sig, DEFAULT_COSTS);
        if (t?.closed) out.set(`${trail}|${bars}`, { r: tradeResult(t).r, exit: t.closed.ts });
      }
      cands.push({ asset: name, ts: b.ts, side, range: range / a, vol: b.v / s.volAvg[i - 1], flow, brk, daily: dailyTrendAt(d, b.ts + H), out });
    }
    console.log(`[search] ${name}: candidates so far ${cands.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
  cands.sort((x, y) => x.ts - y.ts);

  type Stats = { n: number; mean: number; t: number; win: number };
  const stats = (rs: number[]): Stats => {
    const n = rs.length; if (!n) return { n: 0, mean: NaN, t: NaN, win: NaN };
    const m = rs.reduce((a, v) => a + v, 0) / n, sd = Math.sqrt(rs.reduce((a, v) => a + (v - m) ** 2, 0) / Math.max(1, n - 1));
    return { n, mean: m, t: sd > 0 ? m / (sd / Math.sqrt(n)) : 0, win: rs.filter((v) => v > 0).length / n };
  };
  const results: Array<{ side: number; cfg: Record<string, number>; tune: Stats; test: Stats }> = [];
  for (const side of [1, -1] as const) {
    const mine = cands.filter((c) => c.side === side);
    for (const range of GRID.range) for (const vol of GRID.vol) for (const flow of GRID.flow) for (const lookback of GRID.lookback) for (const daily of GRID.daily) {
      const sel = mine.filter((c) => c.range >= range && c.vol >= vol && c.flow >= flow && c.brk[lookback] && (!daily || (side > 0 ? c.daily >= 0 : c.daily <= 0)));
      for (const trail of GRID.trail) for (const bars of GRID.bars) {
        const key = `${trail}|${bars}`;
        const busy = new Map<string, number>();
        const tune: number[] = [], test: number[] = [];
        for (const c of sel) {
          const o = c.out.get(key);
          if (!o || (busy.get(c.asset) ?? 0) > c.ts) continue;
          busy.set(c.asset, o.exit);
          (c.ts < TEST_FROM ? tune : test).push(o.r);
        }
        const st = stats(tune);
        if (st.n >= MIN_TRADES) results.push({ side, cfg: { range, vol, flow, lookback, daily, trail, bars }, tune: st, test: stats(test) });
      }
    }
  }
  const fmt = (s: Stats) => `${s.n} trades, win ${(100 * s.win).toFixed(0)}%, ${s.mean >= 0 ? '+' : ''}${s.mean.toFixed(3)}R (t ${s.t.toFixed(2)})`;
  const summary: Record<string, unknown> = { candidates: cands.length, configsPerSide: results.length / 2, seconds: (Date.now() - t0) / 1000 };
  for (const side of [1, -1] as const) {
    const lab = side > 0 ? 'LONGS' : 'SHORTS';
    const rs = results.filter((r) => r.side === side).sort((a, b) => b.tune.t - a.tune.t);
    const cur = results.find((r) => r.side === side && r.cfg.range === 1.5 && r.cfg.vol === 2 && r.cfg.flow === 0.6 && r.cfg.lookback === 20 && r.cfg.trail === 2.5 && r.cfg.bars === 16 && r.cfg.daily === (side > 0 ? 0 : 1));
    console.log(`\n=== ${lab}: ${rs.length} configs with >= ${MIN_TRADES} tuning trades ===`);
    if (cur) console.log(`  current settings: tuning ${fmt(cur.tune)} | test ${fmt(cur.test)}`);
    console.log('  top 10 by tuning t-stat (range, vol, flow, lookback, daily, trail, bars):');
    for (const r of rs.slice(0, 10)) console.log(`   ${JSON.stringify(Object.values(r.cfg))}  tuning ${fmt(r.tune)} | test ${fmt(r.test)}`);
    const top = rs.slice(0, 10).map((r) => r.test.mean).filter(Number.isFinite).sort((a, b) => a - b);
    console.log(`  test-window mean R of the top 10: median ${top[top.length >> 1]?.toFixed(3)}, range ${top[0]?.toFixed(3)} to ${top[top.length - 1]?.toFixed(3)}`);
    summary[lab] = { current: cur, best: rs[0], top10: rs.slice(0, 10) };
  }
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 1));
  console.log(`\n[search] done in ${((Date.now() - t0) / 1000).toFixed(0)} s; wrote ${outFile}`);
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) main(process.argv[2] ?? 'data/history', process.argv[3] ?? 'burst_search.json');
