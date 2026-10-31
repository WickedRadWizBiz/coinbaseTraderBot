// The operator's iftrades strategies (an export of 20 long-only spot rules, 2026-10-29) as directional triggers,
// read off the Binance 1-minute spot history so the TA contract study (research/taContractStudy.ts) can ask
// whether any of them moves the odds of a 15-minute Up/Down contract, and what the spot price did after each
// over the strategies' own horizons.
//
// Every trigger is +1 (the strategy's buy condition), -1 (its mirror image: the same condition read for a
// short) or 0, evaluated at the close of the last bar of its timeframe that had closed by the time asked.
// Indicators follow the export's specification: RSI(14) with Wilder smoothing, SMA/EMA of closes with the
// period converted to bars of the signal timeframe, "price change over the last period" against the close of
// the most recent earlier bar at least that far back. Nothing here is fitted.
//
// Families (the export's twenty strategies collapse to these conditions):
//   if_rsi20_<tf>          RSI(14) below 20 (+1) / above 80 (-1) on 5m, 15m, 1h
//   if_pull_sma_15m        SMA 2h above SMA 8h and RSI below 40 (+1); SMA 2h below SMA 8h and RSI above 60 (-1)
//   if_pull_ema_15m        the same with EMAs
//   if_pull_sma_1h         SMA 4h above SMA 24h and RSI below 40 / mirror
//   if_pull_ema_4h         EMA 24h above EMA 168h and RSI below 60 / EMA below and RSI above 40
//   if_dip_<pct>_<period>  price fell pct% or more over the period (+1, the dip buy) / rose as much (-1; the
//                          "+2% over 4h momentum" strategy is the -1 side of if_dip_2_4h read the other way)
//   if_ma_<fast>_<slow>    fast average above slow (+1) / below (-1): SMA 12h/72h on 15m bars, EMA 12h/72h on 4h
//                          bars, EMA 24h/168h on 1h bars; if_px_sma72h: close above / below the 72h SMA on 4h bars
//   if_x_<...>             the same averages, +1 / -1 only on the bar where they crossed
// And the "confluence engine" spec's micro triggers (the operator's second note, 2026-10-29), on 15m and 1h bars:
//   sp_rsi_hook_<tf>       RSI(14) was below 32 and turned up while still below 45 (+1) / above 68 turning down, above 55 (-1)
//   sp_bb_test_<tf>        the low of this or the previous bar touched the lower Bollinger band (20, 2) within 0.5% and the
//                          close held at or above it (+1) / the mirror at the upper band (-1)
//   sp_obv_div_<tf>        10-bar regression slope of price <= 0 while OBV's is > 0 (+1) / the mirror (-1)
//   sp_conf_<tf>           two or more of the three agree (+1 / -1): the spec's weighted score without the macro layer
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { aggregate } from './history/historyReplay';
import { bollinger, ema, obv, rsi, sma, type Candle } from '../bot/ta/indicators';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const fin = Number.isFinite;

type Tf = '5m' | '15m' | '1h' | '4h';
const TF_MS: Record<Tf, number> = { '5m': 5 * MIN, '15m': 15 * MIN, '1h': HOUR, '4h': 4 * HOUR };

/** A trigger's values on its timeframe's bar grid: value v[i] holds from bars[i].ts + tf until the next bar closes. */
interface Grid { tf: Tf; ts: number[]; v: Int8Array }

export const IFTRADES_TRIGGERS = [
  'if_rsi20_5m', 'if_rsi20_15m', 'if_rsi20_1h',
  'if_pull_sma_15m', 'if_pull_ema_15m', 'if_pull_sma_1h', 'if_pull_ema_4h',
  'if_dip_2_1h', 'if_dip_2_4h', 'if_dip_3_4h', 'if_dip_4_4h', 'if_dip_2_1d', 'if_dip_3_1w',
  'if_ma_sma12h_72h', 'if_ma_ema12h_72h', 'if_ma_ema24h_168h', 'if_px_sma72h',
  'if_x_sma12h_72h', 'if_x_ema12h_72h', 'if_x_ema24h_168h', 'if_x_px_sma72h',
  'sp_rsi_hook_15m', 'sp_bb_test_15m', 'sp_obv_div_15m', 'sp_conf_15m', 'sp_rsi_hook_1h', 'sp_bb_test_1h', 'sp_obv_div_1h', 'sp_conf_1h',
] as const;
export type Trigger = typeof IFTRADES_TRIGGERS[number];

async function read1m(file: string, from: number, to: number): Promise<Candle[]> {
  const out: Candle[] = [];
  if (!fs.existsSync(file)) return out;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line.startsWith('ts')) continue;
    const f = line.split(',').map(Number);
    if (!(f[0] > 0) || !(f[4] > 0) || f[0] < from || f[0] >= to) continue;
    out.push({ ts: f[0], o: f[1], h: f[2], l: f[3], c: f[4], v: f[5] || 0 });
  }
  return out;
}

const sign = (up: boolean, dn: boolean): number => (up ? 1 : dn ? -1 : 0);
const state = (a: number[], b: number[]): Int8Array => Int8Array.from(a, (x, i) => (fin(x) && fin(b[i]) ? (x > b[i] ? 1 : x < b[i] ? -1 : 0) : 0));
const cross = (st: Int8Array): Int8Array => Int8Array.from(st, (x, i) => (i > 0 && x !== 0 && st[i - 1] !== 0 && st[i - 1] !== x ? x : 0));
/** Least-squares slope of the last n values (per bar), NaN until n values exist. */
function regSlope(xs: number[], n: number): number[] {
  const out = new Array(xs.length).fill(NaN);
  const mx = (n - 1) / 2, sxx = (n * (n * n - 1)) / 12;
  for (let i = n - 1; i < xs.length; i++) {
    let sxy = 0, my = 0, ok = true;
    for (let j = 0; j < n; j++) { const y = xs[i - n + 1 + j]; if (!fin(y)) { ok = false; break; } my += y; }
    if (!ok) continue;
    my /= n;
    for (let j = 0; j < n; j++) sxy += (j - mx) * (xs[i - n + 1 + j] - my);
    out[i] = sxy / sxx;
  }
  return out;
}
/** The confluence spec's micro triggers on one timeframe's bars. */
function specTriggers(bars: Candle[]): { hook: Int8Array; bb: Int8Array; obvDiv: Int8Array; conf: Int8Array } {
  const c = bars.map((b) => b.c), r = rsi(c, 14), bb = bollinger(c, 20, 2);
  const hook = Int8Array.from(c, (_, i) => (i < 1 || !fin(r[i]) || !fin(r[i - 1]) ? 0 : sign(r[i - 1] < 32 && r[i] > r[i - 1] && r[i] < 45, r[i - 1] > 68 && r[i] < r[i - 1] && r[i] > 55)));
  const bbT = Int8Array.from(c, (_, i) => {
    if (i < 1 || !fin(bb.lower[i]) || !fin(bb.lower[i - 1])) return 0;
    const lowTest = (bars[i].l <= bb.lower[i] * 1.005 || bars[i - 1].l <= bb.lower[i - 1] * 1.005) && c[i] >= bb.lower[i];
    const highTest = (bars[i].h >= bb.upper[i] * 0.995 || bars[i - 1].h >= bb.upper[i - 1] * 0.995) && c[i] <= bb.upper[i];
    return sign(lowTest && !highTest, highTest && !lowTest);
  });
  const ps = regSlope(c, 10), os = regSlope(obv(bars), 10);
  const obvDiv = Int8Array.from(c, (_, i) => (!fin(ps[i]) || !fin(os[i]) ? 0 : sign(ps[i] <= 0 && os[i] > 0, ps[i] >= 0 && os[i] < 0)));
  const conf = Int8Array.from(c, (_, i) => { const s = hook[i] + bbT[i] + obvDiv[i]; return s >= 2 ? 1 : s <= -2 ? -1 : 0; });
  return { hook, bb: bbT, obvDiv, conf };
}
const pull = (fast: number[], slow: number[], r: number[], lo: number, hi: number): Int8Array =>
  Int8Array.from(fast, (f, i) => (!fin(f) || !fin(slow[i]) || !fin(r[i]) ? 0 : sign(f > slow[i] && r[i] < lo, f < slow[i] && r[i] > hi)));

/** One coin's triggers, from its 1-minute spot bars (in time order). */
export class CoinTriggers {
  private readonly grids = new Map<Trigger, Grid>();
  /** 1-minute closes by minute index from `t0`, for the forward returns and the dip look-backs. */
  private readonly t0: number;
  private readonly c1: Float64Array;

  constructor(bars1m: Candle[]) {
    this.t0 = bars1m.length ? bars1m[0].ts : 0;
    const n = bars1m.length ? Math.floor((bars1m[bars1m.length - 1].ts - this.t0) / MIN) + 1 : 0;
    this.c1 = new Float64Array(n).fill(NaN);
    for (const b of bars1m) this.c1[Math.floor((b.ts - this.t0) / MIN)] = b.c;
    // Minutes without a bar carry the last close.
    for (let i = 1; i < n; i++) if (!fin(this.c1[i])) this.c1[i] = this.c1[i - 1];
    const by: Partial<Record<Tf, Candle[]>> = {};
    const bars = (tf: Tf) => (by[tf] ??= aggregate(bars1m, TF_MS[tf]));
    const closes = (tf: Tf) => bars(tf).map((b) => b.c);
    const put = (name: Trigger, tf: Tf, v: Int8Array) => this.grids.set(name, { tf, ts: bars(tf).map((b) => b.ts), v });
    for (const tf of ['5m', '15m', '1h'] as Tf[]) {
      const r = rsi(closes(tf), 14);
      put(`if_rsi20_${tf}` as Trigger, tf, Int8Array.from(r, (x) => (fin(x) ? sign(x < 20, x > 80) : 0)));
    }
    { const c = closes('15m'), r = rsi(c, 14);
      put('if_pull_sma_15m', '15m', pull(sma(c, 8), sma(c, 32), r, 40, 60));
      put('if_pull_ema_15m', '15m', pull(ema(c, 8), ema(c, 32), r, 40, 60));
      const st = state(sma(c, 48), sma(c, 288));
      put('if_ma_sma12h_72h', '15m', st); put('if_x_sma12h_72h', '15m', cross(st)); }
    { const c = closes('1h'), r = rsi(c, 14);
      put('if_pull_sma_1h', '1h', pull(sma(c, 4), sma(c, 24), r, 40, 60));
      const st = state(ema(c, 24), ema(c, 168));
      put('if_ma_ema24h_168h', '1h', st); put('if_x_ema24h_168h', '1h', cross(st)); }
    { const c = closes('4h'), r = rsi(c, 14);
      put('if_pull_ema_4h', '4h', pull(ema(c, 6), ema(c, 42), r, 60, 40));
      const st = state(ema(c, 3), ema(c, 18));
      put('if_ma_ema12h_72h', '4h', st); put('if_x_ema12h_72h', '4h', cross(st));
      const px = state(c, sma(c, 18));
      put('if_px_sma72h', '4h', px); put('if_x_px_sma72h', '4h', cross(px)); }
    for (const tf of ['15m', '1h'] as Tf[]) {
      const sp = specTriggers(bars(tf));
      put(`sp_rsi_hook_${tf}` as Trigger, tf, sp.hook); put(`sp_bb_test_${tf}` as Trigger, tf, sp.bb);
      put(`sp_obv_div_${tf}` as Trigger, tf, sp.obvDiv); put(`sp_conf_${tf}` as Trigger, tf, sp.conf);
    }
    // Dips on the strategies' own signal grids (1m / 5m / 1h strategies): read on the 15m grid here, the contract's.
    const dips: Array<[Trigger, number, number]> = [['if_dip_2_1h', 2, HOUR], ['if_dip_2_4h', 2, 4 * HOUR], ['if_dip_3_4h', 3, 4 * HOUR], ['if_dip_4_4h', 4, 4 * HOUR], ['if_dip_2_1d', 2, DAY], ['if_dip_3_1w', 3, 7 * DAY]];
    const b15 = bars('15m');
    for (const [name, pct, period] of dips) {
      put(name, '15m', Int8Array.from(b15, (b) => {
        const ch = this.change(b.ts + TF_MS['15m'], period);
        return fin(ch) ? sign(ch <= -pct, ch >= pct) : 0;
      }));
    }
  }

  /** Last 1-minute close at or before `t` (bar closed by t). */
  close(t: number): number {
    const i = Math.floor((t - this.t0) / MIN) - 1;
    return i >= 0 && i < this.c1.length ? this.c1[i] : NaN;
  }
  /** Percent change of the close at `t` versus the close `period` earlier. */
  change(t: number, period: number): number {
    const a = this.close(t - period), b = this.close(t);
    return fin(a) && fin(b) && a > 0 ? ((b - a) / a) * 100 : NaN;
  }
  /** The triggers as the last closed bar of each timeframe had them at `t`. */
  at(t: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, g] of this.grids) {
      // Bars with ts + tf <= t have closed: binary search the last one.
      const tfMs = TF_MS[g.tf];
      let lo = 0, hi = g.ts.length - 1, k = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (g.ts[m] + tfMs <= t) { k = m; lo = m + 1; } else hi = m - 1; }
      // Only a bar closed within the last two bar lengths counts (a gap in the history reads as "no signal").
      out[name] = k >= 0 && t - (g.ts[k] + tfMs) < 2 * tfMs ? g.v[k] : NaN;
    }
    return out;
  }
  /** Every firing of a trigger: (bar close time, sign). */
  firings(name: Trigger): Array<[number, number]> {
    const g = this.grids.get(name)!;
    const out: Array<[number, number]> = [];
    for (let i = 0; i < g.v.length; i++) if (g.v[i] !== 0) out.push([g.ts[i] + TF_MS[g.tf], g.v[i]]);
    return out;
  }
}

/** Load the coins' 1-minute spot history from the study's store (data/history/binance-1m/<ASSET>/1m.csv). */
export async function loadTriggers(historyDir: string, assets: string[], fromDay: string, toDay: string, log?: (m: string) => void): Promise<Map<string, CoinTriggers>> {
  const out = new Map<string, CoinTriggers>();
  // Eight days before the first day for the weekly dip and the 168-hour EMA's seed; one day past the last day
  // for the forward returns.
  const from = Date.parse(fromDay) - 8 * DAY - 2 * DAY, to = Date.parse(toDay) + 2 * DAY;
  for (const a of assets) {
    const bars = await read1m(path.join(historyDir, 'binance-1m', a, '1m.csv'), from, to);
    if (!bars.length) { log?.(`${a}: no 1-minute history, no triggers`); continue; }
    out.set(a, new CoinTriggers(bars));
    log?.(`${a}: triggers from ${bars.length} 1-minute bars`);
  }
  return out;
}

export interface HorizonGrade { trigger: Trigger; side: 1 | -1; horizonMin: number; n: number; hit: number; meanBps: number; tStat: number }

/** What the spot price did after each firing, in the firing's direction, over the strategies' horizons: non-overlapping
 *  firings only (a firing inside the previous one's horizon is skipped), so the plain t-statistic applies. */
export function gradeHorizons(coins: Map<string, CoinTriggers>, horizonsMin = [15, 60, 240], fromDay?: string, toDay?: string): HorizonGrade[] {
  const out: HorizonGrade[] = [];
  const lo = fromDay ? Date.parse(fromDay) : -Infinity, hi = toDay ? Date.parse(toDay) + DAY : Infinity;
  for (const name of IFTRADES_TRIGGERS) for (const side of [1, -1] as const) for (const h of horizonsMin) {
    const xs: number[] = [];
    for (const c of coins.values()) {
      let lastT = -Infinity;
      for (const [t, s] of c.firings(name)) {
        if (s !== side || t < lo || t >= hi || t - lastT < h * MIN) continue;
        const a = c.close(t), b = c.close(t + h * MIN);
        if (!(fin(a) && fin(b) && a > 0 && b > 0)) continue;
        xs.push(side * Math.log(b / a) * 1e4);
        lastT = t;
      }
    }
    const n = xs.length;
    if (!n) { out.push({ trigger: name, side, horizonMin: h, n: 0, hit: NaN, meanBps: NaN, tStat: NaN }); continue; }
    const mean = xs.reduce((s, x) => s + x, 0) / n;
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1));
    out.push({ trigger: name, side, horizonMin: h, n, hit: xs.filter((x) => x > 0).length / n, meanBps: mean, tStat: sd > 0 ? mean / (sd / Math.sqrt(n)) : NaN });
  }
  return out;
}
