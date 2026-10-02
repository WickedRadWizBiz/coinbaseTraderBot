// Market-wide context for the TA network, computed identically in training (history store) and live
// (the bot's candle sets and index store). Every lookup is at or before the bar being forecast.
//
//   BTC        BTC's own moves (z-scored), its position in the 24h range: every coin follows BTC.
//   relative   the coin's move minus BTC's (for BTC: BTC minus the alt basket): the asset-level
//              BTC-dominance signal ("is this alt outperforming BTC?").
//   market     equal-weighted move of every tracked coin, and breadth (share of coins up). USDT.D's
//              hour-to-hour moves are mostly the inverse of total crypto market cap (USDT's own cap
//              barely moves intraday), so this stands in for USDT.D at the hourly scale.
//   BTCDOM     Binance's BTC dominance index (BTC vs the top-20 alts, cap-weighted, no stablecoins):
//              its moves and its TA readings. Oriented to the asset: + for BTC, - for alts (BTCDOM
//              rising is bullish BTC relative to alts and bearish alts).
//   matrix     the knowledge base's BTC.D x USDT.D quadrant (altseason / risk-on for BTC only / risk-off
//              / distribution) at the 4h and 24h scale, from BTCDOM and the market proxy; the 4h one is
//              also handed to the TA library, so the dominance_matrix rule and macro_rotation fire.
//   daily      TA on the real BTC.D and USDT.D daily charts (TradingView history + the bot's own bars):
//              trend, momentum, structure, distance to moving averages and round numbers.

import { tfState, type MacroInput, type TfState } from './analyzer';
import type { Candle } from './indicators';

const H = 3_600_000;
const DAY = 86_400_000;
const clip = (x: number, lim: number) => (Number.isFinite(x) ? Math.max(-lim, Math.min(lim, x)) : NaN);
const perAtr = (s: TfState, x: number) => (s.atr > 0 ? x / s.atr : NaN);

/** Directional readings taken from a TA state of an index series (all signed: flipping them orients them). */
export const INDEX_STATE_KEYS = ['rsi', 'macd_atr', 'trend', 'bos', 'choch', 'ema_stack', 'sma50_dist', 'breakout', 'div', 'chg20_atr'] as const;
export const DAILY_STATE_KEYS = [...INDEX_STATE_KEYS, 'sma200_dist', 'bb_pctb', 'round_dist', 'donchian'] as const;
type StateKey = typeof DAILY_STATE_KEYS[number];

function stateReading(s: TfState, k: StateKey): number {
  switch (k) {
    case 'rsi': return clip((s.rsi - 50) / 50, 10);
    case 'macd_atr': return clip(perAtr(s, s.macdHist), 10);
    case 'trend': return s.trend === 'up' ? 1 : s.trend === 'down' ? -1 : 0;
    case 'bos': return s.bos;
    case 'choch': return s.choch;
    case 'ema_stack': return s.close > s.ema21 && s.ema21 > s.ema50 ? 1 : s.close < s.ema21 && s.ema21 < s.ema50 ? -1 : Number.isFinite(s.ema50) ? 0 : NaN;
    case 'sma50_dist': return clip(perAtr(s, s.close - s.sma50), 30);
    case 'breakout': return s.breakout;
    case 'div': return clip(s.divRsi.regular + s.divMacd.regular, 4);
    case 'chg20_atr': return clip(s.chg20Atr, 30);
    case 'sma200_dist': return clip(perAtr(s, s.close - s.sma200), 60);
    case 'bb_pctb': return clip(s.bbPctB - 0.5, 3);
    case 'round_dist': return clip(s.round.distAtr, 20);
    case 'donchian': return s.donchianBreak;
  }
}

/** Hourly context features (names, in order). */
export const CONTEXT_FEATURES: string[] = [
  'x_btc_ret_1h_z', 'x_btc_ret_4h_z', 'x_btc_ret_24h_z', 'x_btc_ret_168h_z', 'x_btc_range_pos_24h',
  'x_rel_btc_1h', 'x_rel_btc_4h', 'x_rel_btc_24h', 'x_rel_btc_168h',
  'x_mkt_ret_1h_z', 'x_mkt_ret_4h_z', 'x_mkt_ret_24h_z', 'x_breadth_4h', 'x_breadth_24h',
  'x_btcdom_ret_1h_z', 'x_btcdom_ret_4h_z', 'x_btcdom_ret_24h_z', 'x_btcdom_ret_168h_z',
  ...INDEX_STATE_KEYS.map((k) => `x_btcdom_${k}`),
  'x_dom_matrix_4h', 'x_dom_matrix_24h',
];

/** Daily dominance features (names, in order), appended to the daily branch's step vector. */
export const DAILY_CONTEXT_FEATURES: string[] = [
  ...['btcd', 'usdtd'].flatMap((p) => [`dd_${p}_chg_1`, `dd_${p}_chg_5`, `dd_${p}_chg_20`, ...DAILY_STATE_KEYS.map((k) => `dd_${p}_${k}`)]),
  'dd_dom_matrix_5d',
];

/** The knowledge base's dominance quadrant as a number (bot/ta/knowledge.ts dominance_matrix): USDT.D
 *  and BTC.D changes (sigma-scaled; |z| > 0.5 counts as moving), signed for BTC vs alts. */
export function domMatrixScore(usdtdZ: number, btcdZ: number, isBtc: boolean, th = 0.5): number {
  if (!Number.isFinite(usdtdZ) || !Number.isFinite(btcdZ)) return NaN;
  const u = usdtdZ > th ? 1 : usdtdZ < -th ? -1 : 0, b = btcdZ > th ? 1 : btcdZ < -th ? -1 : 0;
  if (u === 0) return 0;
  if (u > 0 && b > 0) return isBtc ? -0.6 : -1;      // severe risk-off: alts worst
  if (u > 0 && b < 0) return -0.7;                    // distribution into cash
  if (u < 0 && b > 0) return isBtc ? 1 : 0;           // risk-on for BTC only: alts stagnate
  if (u < 0 && b < 0) return isBtc ? 0.4 : 1;         // altseason
  return u < 0 ? 0.5 : -0.5;                          // cash moving, BTC.D flat
}

interface Series { ts: Float64Array; c: Float64Array; h: Float64Array; l: Float64Array; idx: Map<number, number>; cum2: Float64Array; bars: Candle[] }

function series(bars: Candle[] | undefined): Series | undefined {
  if (!bars?.length) return undefined;
  const n = bars.length;
  const s: Series = { ts: new Float64Array(n), c: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), idx: new Map(), cum2: new Float64Array(n), bars };
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    s.ts[i] = b.ts; s.c[i] = b.c; s.h[i] = b.h; s.l[i] = b.l; s.idx.set(b.ts, i);
    const r = i > 0 && b.c > 0 && bars[i - 1].c > 0 ? Math.log(b.c / bars[i - 1].c) : 0;
    s.cum2[i] = (i > 0 ? s.cum2[i - 1] : 0) + r * r;
  }
  return s;
}

/** Index of the last bar with ts <= t (or -1). */
function atOrBefore(s: Series, t: number): number {
  let lo = 0, hi = s.ts.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (s.ts[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}

export interface TaNetContextData {
  /** Hourly spot bars per tracked asset (the market basket; BTC must be among them for BTC context). */
  h1: Record<string, Candle[]>;
  /** BTCDOM hourly, and the real BTC.D / USDT.D daily charts (index series), ascending. */
  btcdom1h?: Candle[];
  btcd1d?: Candle[];
  usdtd1d?: Candle[];
}

export class TaNetContext {
  private readonly assets = new Map<string, Series>();
  private readonly dom?: Series;
  private readonly btcd?: Series;
  private readonly usdtd?: Series;
  private readonly domState = new Map<number, Float64Array>();
  private readonly dayState = new Map<string, Float64Array>();
  private readonly mktSigma = new Map<number, number>();

  constructor(d: TaNetContextData) {
    for (const [a, bars] of Object.entries(d.h1)) { const s = series(bars); if (s) this.assets.set(a, s); }
    this.dom = series(d.btcdom1h);
    this.btcd = series(d.btcd1d);
    this.usdtd = series(d.usdtd1d);
  }

  /** Which context series exist (for the model file and the tournament's data signature). */
  coverage(): Record<string, { from: string; to: string; bars: number }> {
    const out: Record<string, { from: string; to: string; bars: number }> = {};
    const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
    for (const [k, s] of [['BTCDOM', this.dom], ['BTC.D', this.btcd], ['USDT.D', this.usdtd]] as const) if (s) out[k] = { from: iso(s.ts[0]), to: iso(s.ts[s.ts.length - 1]), bars: s.ts.length };
    return out;
  }

  get basket(): string[] { return [...this.assets.keys()].sort(); }

  /** Live: is the context for the hourly bar at `ts` complete enough to compute (and cache) features?
   *  BTC's bar and most of the basket must be in, BTCDOM's bar while that feed is alive, and the daily
   *  dominance bar of the day that just closed. Never waits more than `graceMs` past the bar's close. */
  ready(ts: number, now: number, graceMs = 30 * 60_000): boolean {
    if (now - (ts + H) > graceMs) return true;
    let have = 0;
    for (const s of this.assets.values()) if (s.idx.has(ts)) have++;
    if (have < Math.ceil(this.assets.size / 2)) return false;
    const btc = this.assets.get('BTC');
    if (btc && !btc.idx.has(ts)) return false;
    const d = this.dom;
    if (d && !d.idx.has(ts) && d.ts[d.ts.length - 1] >= ts - 3 * H) return false;
    return this.dailyReady(Math.floor((ts + H) / DAY) * DAY - DAY);
  }

  /** Does each live daily dominance series have the bar of `dayTs` (or has it stopped updating)? */
  dailyReady(dayTs: number): boolean {
    for (const s of [this.btcd, this.usdtd]) if (s && !s.idx.has(dayTs) && s.ts[s.ts.length - 1] >= dayTs - 2 * DAY) return false;
    return true;
  }

  private ret(s: Series | undefined, ts: number, k: number): number {
    if (!s) return NaN;
    const i = s.idx.get(ts), j = s.idx.get(ts - k * H);
    return i === undefined || j === undefined || !(s.c[j] > 0) ? NaN : Math.log(s.c[i] / s.c[j]);
  }

  /** RMS of the last 168 hourly log returns ending at ts (bar-index based, like the asset's own sigma). */
  private sigma(s: Series | undefined, ts: number): number {
    if (!s) return NaN;
    const i = s.idx.get(ts);
    if (i === undefined || i < 168) return NaN;
    return Math.sqrt(Math.max(0, s.cum2[i] - s.cum2[i - 168]) / 168);
  }

  private z(s: Series | undefined, ts: number, k: number): number {
    const sg = this.sigma(s, ts);
    return sg > 0 ? clip(this.ret(s, ts, k) / (sg * Math.sqrt(k)), 10) : NaN;
  }

  private basketRet(ts: number, k: number, except?: string): number {
    let s = 0, n = 0;
    for (const [a, ser] of this.assets) { if (a === except) continue; const r = this.ret(ser, ts, k); if (Number.isFinite(r)) { s += r; n++; } }
    return n >= 2 || (except && n >= 1) ? s / n : NaN;
  }

  private basketSigma(ts: number): number {
    const m = this.mktSigma.get(ts);
    if (m !== undefined) return m;
    let s2 = 0, n = 0;
    for (let k = 0; k < 168; k++) { const r = this.basketRet(ts - k * H, 1); if (Number.isFinite(r)) { s2 += r * r; n++; } }
    const v = n >= 120 ? Math.sqrt(s2 / n) : NaN;
    if (this.mktSigma.size > 50_000) this.mktSigma.clear();
    this.mktSigma.set(ts, v);
    return v;
  }

  private mktZ(ts: number, k: number): number {
    const sg = this.basketSigma(ts);
    return sg > 0 ? clip(this.basketRet(ts, k) / (sg * Math.sqrt(k)), 10) : NaN;
  }

  private breadth(ts: number, k: number): number {
    let up = 0, n = 0;
    for (const ser of this.assets.values()) { const r = this.ret(ser, ts, k); if (Number.isFinite(r)) { n++; if (r > 0) up++; } }
    return n >= 2 ? (2 * up) / n - 1 : NaN;
  }

  private domReadings(ts: number): Float64Array | undefined {
    const s = this.dom;
    if (!s) return undefined;
    const i = s.idx.get(ts);
    if (i === undefined || i < 279) return undefined;
    let v = this.domState.get(ts);
    if (!v) {
      const st = tfState('1h', s.bars.slice(i - 279, i + 1));
      v = Float64Array.from(INDEX_STATE_KEYS, (k) => (st ? stateReading(st, k) : NaN));
      if (this.domState.size > 100_000) this.domState.clear();
      this.domState.set(ts, v);
    }
    return v;
  }

  /** USDT.D (market proxy) and BTC.D (BTCDOM) 4h changes, sigma-scaled, for the TA library's dominance rule. */
  macro(asset: string, ts: number): MacroInput | undefined {
    const u = -this.mktZ(ts, 4), b = this.z(this.dom, ts, 4);
    return Number.isFinite(u) && Number.isFinite(b) ? { asset, usdtdChg: u, btcdChg: b } : undefined;
  }

  /** Hourly context features for `asset` at the close of the hourly bar opening at `ts`. */
  hourly(asset: string, ts: number): Record<string, number> {
    const out: Record<string, number> = {};
    const isBtc = asset === 'BTC';
    const o = isBtc ? 1 : -1;
    const btc = this.assets.get('BTC'), own = this.assets.get(asset);
    out.x_btc_ret_1h_z = this.z(btc, ts, 1); out.x_btc_ret_4h_z = this.z(btc, ts, 4); out.x_btc_ret_24h_z = this.z(btc, ts, 24); out.x_btc_ret_168h_z = this.z(btc, ts, 168);
    out.x_btc_range_pos_24h = NaN;
    const bi = btc?.idx.get(ts);
    if (btc && bi !== undefined && bi >= 23) {
      let hi = -Infinity, lo = Infinity;
      for (let k = bi - 23; k <= bi; k++) { hi = Math.max(hi, btc.h[k]); lo = Math.min(lo, btc.l[k]); }
      out.x_btc_range_pos_24h = hi > lo ? clip(((btc.c[bi] - lo) / (hi - lo)) * 2 - 1, 1) : NaN;
    }
    const sgOwn = this.sigma(own, ts);
    for (const k of [1, 4, 24, 168]) {
      const rel = isBtc ? this.ret(btc, ts, k) - this.basketRet(ts, k, 'BTC') : this.ret(own, ts, k) - this.ret(btc, ts, k);
      out[`x_rel_btc_${k}h`] = sgOwn > 0 ? clip(rel / (sgOwn * Math.sqrt(k)), 10) : NaN;
    }
    out.x_mkt_ret_1h_z = this.mktZ(ts, 1); out.x_mkt_ret_4h_z = this.mktZ(ts, 4); out.x_mkt_ret_24h_z = this.mktZ(ts, 24);
    out.x_breadth_4h = this.breadth(ts, 4); out.x_breadth_24h = this.breadth(ts, 24);
    for (const k of [1, 4, 24, 168]) out[`x_btcdom_ret_${k}h_z`] = o * this.z(this.dom, ts, k);
    const st = this.domReadings(ts);
    INDEX_STATE_KEYS.forEach((k, j) => { out[`x_btcdom_${k}`] = st ? o * st[j] : NaN; });
    out.x_dom_matrix_4h = domMatrixScore(-this.mktZ(ts, 4), this.z(this.dom, ts, 4), isBtc);
    out.x_dom_matrix_24h = domMatrixScore(-this.mktZ(ts, 24), this.z(this.dom, ts, 24), isBtc);
    return out;
  }

  private dailyReadings(name: 'btcd' | 'usdtd', s: Series | undefined, j: number): Float64Array {
    const key = `${name}|${j}`;
    let v = this.dayState.get(key);
    if (!v) {
      const st = j >= 29 ? tfState('1d', s!.bars.slice(Math.max(0, j - 249), j + 1)) : undefined;
      // Daily log changes, z-scored by the RMS of the last 60 daily changes.
      const sg = j >= 60 ? Math.sqrt(Math.max(0, s!.cum2[j] - s!.cum2[j - 60]) / 60) : NaN;
      const chg = (k: number) => (j >= k && sg > 0 && s!.ts[j] - s!.ts[j - k] === k * DAY ? clip(Math.log(s!.c[j] / s!.c[j - k]) / (sg * Math.sqrt(k)), 10) : NaN);
      v = Float64Array.from([chg(1), chg(5), chg(20), ...DAILY_STATE_KEYS.map((k) => (st ? stateReading(st, k) : NaN))]);
      this.dayState.set(key, v);
    }
    return v;
  }

  /** Daily dominance features for `asset` for the daily bar opening at `dayTs` (closed at dayTs + 1 day). */
  daily(asset: string, dayTs: number): number[] {
    const isBtc = asset === 'BTC';
    const out: number[] = [];
    const per = 3 + DAILY_STATE_KEYS.length;
    const pick = (name: 'btcd' | 'usdtd', s: Series | undefined, sign: number) => {
      const j = s ? atOrBefore(s, dayTs) : -1;
      // The bar must be this day's (a missing day reads as missing, never as an older value).
      if (!s || j < 0 || s.ts[j] !== dayTs) { for (let k = 0; k < per; k++) out.push(NaN); return [NaN, NaN]; }
      const v = this.dailyReadings(name, s, j);
      for (let k = 0; k < per; k++) out.push(sign * v[k]);
      return [v[1], j];
    };
    const [btcd5] = pick('btcd', this.btcd, isBtc ? 1 : -1);
    const [usdtd5] = pick('usdtd', this.usdtd, 1);
    out.push(domMatrixScore(usdtd5, btcd5, isBtc));
    return out;
  }
}
