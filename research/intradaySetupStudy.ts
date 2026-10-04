// Intraday setup study: does a discretionary-style setup have an edge on its own, before any model?
//
//   npx tsx research/intradaySetupStudy.ts [historyDir]
//
// Setups (pre-declared, textbook thresholds, nothing fitted):
//   fade:     RSI(14) overbought (>= 70 / >= 80), high tagged the upper Bollinger band (20, 2) on this or the
//             previous bar, momentum fading (RSI below its 3-bar max and MACD histogram falling), and sell
//             volume coming in (red bar, taker-buy share below 50% and below its 4-bar average) -> short.
//             Mirror image -> long.
//   pullback: higher-timeframe trend (EMA 20 > EMA 50 on 4x bars, close above EMA 50), price dips to the lower
//             band / RSI < 40, then a green bar with buying -> long. Mirror -> short.
// Exits: structure stop beyond the last 3 bars' extreme + 0.25 ATR; target the middle band (fade) or 2R
// (pullback); time stop after 24 bars; a bar touching stop and target counts as the stop. Entry at the
// next bar's open. Costs per side as given. Control: random entries with the same exits, side and count.
import path from 'path';
import { loadSeries } from './history/candles';
import { atr, bollinger, ema, macd, rsi, type Candle } from '../bot/ta/indicators';

const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];
const COST = 0.0007; // per side: 5 bp fee + 2 bp slippage
const SPLIT = Date.UTC(2024, 0, 1);

export interface Trade { ts: number; ret: number; r: number; bars: number; i: number; dir: 1 | -1; risk: number }
export interface Signal { i: number; dir: 1 | -1; stop: number; target: number | 'R2' }

function agg(cs: Candle[], k: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i + k <= cs.length; i += k) {
    const g = cs.slice(i, i + k);
    out.push({ ts: g[0].ts, o: g[0].o, h: Math.max(...g.map((x) => x.h)), l: Math.min(...g.map((x) => x.l)), c: g[k - 1].c, v: g.reduce((a, x) => a + x.v, 0), tb: g.every((x) => x.tb !== undefined) ? g.reduce((a, x) => a + (x.tb ?? 0), 0) : undefined });
  }
  return out;
}

export function signals(cs: Candle[], kind: 'fade70' | 'fade80' | 'pullback'): Signal[] {
  const c = cs.map((x) => x.c), R = rsi(c, 14), bb = bollinger(c, 20, 2), m = macd(c), A = atr(cs, 14);
  const share = cs.map((x) => (x.tb !== undefined && x.v > 0 ? x.tb / x.v : NaN));
  // Higher timeframe (4 bars) trend, known only after its bar closes.
  const hi4 = agg(cs, 4), e20 = ema(hi4.map((x) => x.c), 20), e50 = ema(hi4.map((x) => x.c), 50);
  const out: Signal[] = [];
  const lvl = kind === 'fade80' ? 80 : 70;
  for (let i = 60; i < cs.length - 1; i++) {
    const a = A[i];
    if (!(a > 0) || !Number.isFinite(bb.upper[i])) continue;
    const avgShare = (share[i - 1] + share[i - 2] + share[i - 3] + share[i - 4]) / 4;
    const hiN = Math.max(cs[i].h, cs[i - 1].h, cs[i - 2].h), loN = Math.min(cs[i].l, cs[i - 1].l, cs[i - 2].l);
    if (kind !== 'pullback') {
      const rsiMax = Math.max(R[i - 1], R[i - 2], R[i - 3]), rsiMin = Math.min(R[i - 1], R[i - 2], R[i - 3]);
      const shortOk = rsiMax >= lvl && R[i] < rsiMax && (cs[i].h >= bb.upper[i] || cs[i - 1].h >= bb.upper[i - 1]) && m.hist[i] < m.hist[i - 1] && cs[i].c < cs[i].o && share[i] < 0.5 && share[i] < avgShare;
      const longOk = rsiMin <= 100 - lvl && R[i] > rsiMin && (cs[i].l <= bb.lower[i] || cs[i - 1].l <= bb.lower[i - 1]) && m.hist[i] > m.hist[i - 1] && cs[i].c > cs[i].o && share[i] > 0.5 && share[i] > avgShare;
      if (shortOk) out.push({ i, dir: -1, stop: hiN + 0.25 * a, target: bb.mid[i] });
      else if (longOk) out.push({ i, dir: 1, stop: loN - 0.25 * a, target: bb.mid[i] });
    } else {
      const j = Math.floor((i + 1) / 4) - 1; // last closed 4-bar candle
      if (j < 50) continue;
      const up = e20[j] > e50[j] && hi4[j].c > e50[j], dn = e20[j] < e50[j] && hi4[j].c < e50[j];
      const dipped = Math.min(R[i - 1], R[i - 2]) < 40 || cs[i - 1].l <= bb.lower[i - 1];
      const popped = Math.max(R[i - 1], R[i - 2]) > 60 || cs[i - 1].h >= bb.upper[i - 1];
      if (up && dipped && cs[i].c > cs[i].o && share[i] > 0.5) out.push({ i, dir: 1, stop: loN - 0.25 * a, target: 'R2' });
      else if (dn && popped && cs[i].c < cs[i].o && share[i] < 0.5) out.push({ i, dir: -1, stop: hiN + 0.25 * a, target: 'R2' });
    }
  }
  return out;
}

export function simulate(cs: Candle[], sigs: Signal[], maxBars = 24): Trade[] {
  const out: Trade[] = [];
  let busyUntil = -1;
  for (const s of sigs) {
    if (s.i <= busyUntil || s.i + 1 >= cs.length) continue;
    const e = cs[s.i + 1].o, risk = Math.abs(e - s.stop);
    if (!(risk > 0) || (s.dir > 0 ? s.stop >= e : s.stop <= e)) continue;
    const tgt = s.target === 'R2' ? e + s.dir * 2 * risk : s.target;
    if (s.dir > 0 ? tgt <= e : tgt >= e) continue;
    let exit = NaN, k = s.i + 1;
    for (; k < Math.min(cs.length, s.i + 1 + maxBars); k++) {
      const b = cs[k];
      const stopHit = s.dir > 0 ? b.l <= s.stop : b.h >= s.stop, tgtHit = s.dir > 0 ? b.h >= tgt : b.l <= tgt;
      if (stopHit) { exit = s.dir > 0 ? Math.min(s.stop, b.o) : Math.max(s.stop, b.o); break; }
      if (tgtHit) { exit = s.dir > 0 ? Math.max(tgt, b.o) : Math.min(tgt, b.o); break; }
    }
    if (!Number.isFinite(exit)) { k = Math.min(cs.length - 1, s.i + maxBars); exit = cs[k].c; }
    const gross = s.dir * (exit - e) / e;
    out.push({ ts: cs[s.i].ts, ret: gross - 2 * COST, r: (s.dir * (exit - e)) / risk, bars: k - s.i, i: s.i, dir: s.dir, risk: risk / e });
    busyUntil = k;
  }
  return out;
}

/** Same count, sides and exit logic at random bars (seeded). */
export function randomControl(cs: Candle[], sigs: Signal[], kind: string, seed: number): Signal[] {
  let x = seed >>> 0;
  const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const A = atr(cs, 14), bb = bollinger(cs.map((c) => c.c), 20, 2);
  return sigs.map((s) => {
    let i = 0;
    do i = 60 + Math.floor(rnd() * (cs.length - 62)); while (!(A[i] > 0) || !Number.isFinite(bb.mid[i]));
    const hiN = Math.max(cs[i].h, cs[i - 1].h, cs[i - 2].h), loN = Math.min(cs[i].l, cs[i - 1].l, cs[i - 2].l);
    const stop = s.dir > 0 ? loN - 0.25 * A[i] : hiN + 0.25 * A[i];
    return { i, dir: s.dir, stop, target: kind === 'pullback' ? 'R2' : bb.mid[i] } as Signal;
  }).sort((a, b) => a.i - b.i);
}

function stats(ts: Trade[]) {
  const n = ts.length;
  if (!n) return 'no trades';
  const w = ts.filter((t) => t.ret > 0);
  const gp = w.reduce((a, t) => a + t.ret, 0), gl = -ts.filter((t) => t.ret <= 0).reduce((a, t) => a + t.ret, 0);
  const avg = ts.reduce((a, t) => a + t.ret, 0) / n, avgR = ts.reduce((a, t) => a + t.r, 0) / n;
  const sd = Math.sqrt(ts.reduce((a, t) => a + (t.ret - avg) ** 2, 0) / n);
  const gross = avg + 2 * COST;
  return `${String(n).padStart(6)} trades  win ${(100 * w.length / n).toFixed(1).padStart(5)}%  avg ${(avg * 100).toFixed(3).padStart(7)}%/trade (t ${(avg / (sd / Math.sqrt(n))).toFixed(1).padStart(5)})  gross ${(gross * 100).toFixed(3).padStart(7)}%  avgR ${avgR.toFixed(2).padStart(5)}  PF ${(gl > 0 ? gp / gl : Infinity).toFixed(2)}  hold ${(ts.reduce((a, t) => a + t.bars, 0) / n).toFixed(1)} bars`;
}

function main(HIST: string): void {
  for (const tf of ['15m', '1h'] as const) {
    const data = ASSETS.map((a) => loadSeries(HIST, a, tf).candles);
    for (const kind of ['fade70', 'fade80', 'pullback'] as const) {
      const all: Trade[] = [], ctl: Trade[] = [];
      data.forEach((cs, k) => {
        const sg = signals(cs, kind);
        all.push(...simulate(cs, sg));
        ctl.push(...simulate(cs, randomControl(cs, sg, kind, 17 + k)));
      });
      console.log(`\n=== ${tf} ${kind} (costs ${(COST * 1e4).toFixed(0)} bp a side) ===`);
      console.log(`  setup   2017-23: ${stats(all.filter((t) => t.ts < SPLIT))}`);
      console.log(`  setup   2024-26: ${stats(all.filter((t) => t.ts >= SPLIT))}`);
      console.log(`  random  all    : ${stats(ctl)}`);
      console.log(`  setup   all    : ${stats(all)}`);
    }
  }
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) main(process.argv[2] ?? 'data/history');
