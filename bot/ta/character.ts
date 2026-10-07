// Market character per coin: calm / trending / volatile-idiosyncratic / volatile-systemic.
//
// Direction is hard to call (25-55 % accuracy in most published tests); character is not: volatility
// clusters and trends persist, so "what kind of market is this, and what will the next 24 hours be
// like" can be answered far more reliably, and it decides which direction rules deserve trust (trend
// rules in trends, mean-reversion in calm ranges, nothing when everything moves together). The inputs
// follow the VIX x correlation idea (high volatility + low correlation: coin-specific moves where
// trend signals hold; high volatility + high correlation: systemic, stand aside), with crypto analogs:
//
//   rvPct    24 h realised volatility (hourly returns) as a percentile of the daily volatility of the
//            last 180 days (Parkinson, from daily ranges): the "VIX" of the coin
//   volFc    the TA network's validated 4 h volatility forecast, log(next 4 h / last 24 h) (live only)
//   corr     average correlation of the coin's hourly returns with the other coins over 72 h
//   hurst    variance-ratio Hurst exponent over 128 hourly returns (> 0.5 trending, < 0.5 mean-reverting)
//   er       Kaufman efficiency ratio over 24 hourly bars (net move / path length)
//   adx      ADX(14) on hourly bars
//   bbRank   Bollinger bandwidth percentile over 120 hourly bars (low = squeeze)
//
// Classes (first match):
//   volatile_systemic   rvPct >= 0.75 and corr >= 0.6       everything moves together: stand aside
//   volatile_idio       rvPct >= 0.75                        coin-specific: trend signals hold up best
//   trending            er >= 0.3, or adx >= 25 with hurst >= 0.55
//   calm                otherwise                            ranges: mean reversion, squeezes
// The volatility forecast nudges rvPct (+-0.1) when the network expects volatility to rise or fall.
//
// Everything uses closed bars only, the same code offline (research/ruleBook.ts measures how often the
// character holds over the next 24 hours) and live.

import { adx, type Candle } from './indicators';

export type Character = 'calm' | 'trending' | 'volatile_idio' | 'volatile_systemic';
export const CHARACTERS: Character[] = ['calm', 'trending', 'volatile_idio', 'volatile_systemic'];

export interface CharacterInputs { rvPct: number; volFc?: number; corr: number; hurst: number; er: number; adx: number; bbRank: number }

export const CHAR_THRESHOLDS = { volPct: 0.75, sysCorr: 0.6, er: 0.3, adx: 25, hurst: 0.55, volFcNudge: 0.2 };

const H = 3_600_000;
const finite = Number.isFinite;

/** Classify from the inputs (NaN inputs simply do not vote for the class they define). */
export function classify(x: CharacterInputs, t = CHAR_THRESHOLDS): { cls: Character; why: string } {
  const nudge = x.volFc !== undefined && finite(x.volFc) ? (x.volFc > t.volFcNudge ? 0.1 : x.volFc < -t.volFcNudge ? -0.1 : 0) : 0;
  const rv = finite(x.rvPct) ? x.rvPct + nudge : NaN;
  if (rv >= t.volPct) {
    return finite(x.corr) && x.corr >= t.sysCorr
      ? { cls: 'volatile_systemic', why: `volatility at the ${(100 * x.rvPct).toFixed(0)}th percentile with the market moving together (corr ${x.corr.toFixed(2)})` }
      : { cls: 'volatile_idio', why: `volatility at the ${(100 * x.rvPct).toFixed(0)}th percentile, coin-specific (corr ${finite(x.corr) ? x.corr.toFixed(2) : 'n/a'})` };
  }
  if (x.er >= t.er || (x.adx >= t.adx && x.hurst >= t.hurst)) return { cls: 'trending', why: `efficiency ${finite(x.er) ? x.er.toFixed(2) : 'n/a'}, ADX ${finite(x.adx) ? x.adx.toFixed(0) : 'n/a'}, Hurst ${finite(x.hurst) ? x.hurst.toFixed(2) : 'n/a'}` };
  return { cls: 'calm', why: `volatility at the ${finite(x.rvPct) ? (100 * x.rvPct).toFixed(0) : '?'}th percentile, efficiency ${finite(x.er) ? x.er.toFixed(2) : 'n/a'}${finite(x.bbRank) && x.bbRank < 0.2 ? ', squeeze' : ''}` };
}

const logRets = (cs: Candle[]) => { const r: number[] = []; for (let i = 1; i < cs.length; i++) r.push(Math.log(cs[i].c / cs[i - 1].c)); return r; };
const std = (xs: number[]) => { if (xs.length < 2) return NaN; const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)); };

/** Daily volatility from the last 24 hourly returns. */
export function rv24(h1: Candle[]): number {
  const r = logRets(h1.slice(-25));
  return r.length >= 20 ? std(r) * Math.sqrt(24) : NaN;
}

/** Parkinson daily volatility of each daily bar: ln(H/L) / (2 sqrt(ln 2)). */
export const parkinson = (c: Candle) => (c.h > 0 && c.l > 0 ? Math.log(c.h / c.l) / (2 * Math.sqrt(Math.log(2))) : NaN);

/** Percentile of x among the Parkinson volatilities of the last `n` daily bars. */
export function volPercentile(x: number, d1: Candle[], n = 180): number {
  if (!finite(x)) return NaN;
  const v = d1.slice(-n).map(parkinson).filter(finite);
  return v.length >= 30 ? v.filter((y) => y <= x).length / v.length : NaN;
}

/** Variance-ratio Hurst exponent over the last `n` returns at lag k: H = 0.5 + 0.5 log(VR(k)) / log(k). */
export function hurstVR(h1: Candle[], n = 128, k = 8): number {
  const r = logRets(h1.slice(-(n + 1)));
  if (r.length < n * 0.9) return NaN;
  const v1 = std(r);
  const sums: number[] = [];
  for (let i = 0; i + k <= r.length; i++) { let s = 0; for (let j = 0; j < k; j++) s += r[i + j]; sums.push(s); }
  const vk = std(sums);
  if (!(v1 > 0) || !(vk > 0)) return NaN;
  const vr = (vk * vk) / (k * v1 * v1);
  return Math.max(0, Math.min(1, 0.5 + (0.5 * Math.log(vr)) / Math.log(k)));
}

/** Kaufman efficiency ratio over the last n bars. */
export function efficiencyRatio(h1: Candle[], n = 24): number {
  const s = h1.slice(-(n + 1));
  if (s.length < n + 1) return NaN;
  let path = 0;
  for (let i = 1; i < s.length; i++) path += Math.abs(s[i].c - s[i - 1].c);
  return path > 0 ? Math.abs(s[s.length - 1].c - s[0].c) / path : 0;
}

/** Average correlation of this coin's hourly returns with each other coin's over the last n hours
 *  (bars matched by open time). */
export function avgCorrelation(h1: Candle[], others: Candle[][], n = 72): number {
  const mine = h1.slice(-(n + 1));
  if (mine.length < n * 0.8) return NaN;
  const r = new Map<number, number>();
  for (let i = 1; i < mine.length; i++) r.set(mine[i].ts, Math.log(mine[i].c / mine[i - 1].c));
  const cs: number[] = [];
  for (const o of others) {
    const om = new Map(o.slice(-(n + 30)).map((c) => [c.ts, c.c]));
    const a: number[] = [], b: number[] = [];
    for (const [ts, x] of r) { const p0 = om.get(ts - H), p1 = om.get(ts); if (p0 && p1) { a.push(x); b.push(Math.log(p1 / p0)); } }
    if (a.length < n * 0.6) continue;
    const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
    if (saa > 0 && sbb > 0) cs.push(sab / Math.sqrt(saa * sbb));
  }
  return cs.length ? cs.reduce((s, v) => s + v, 0) / cs.length : NaN;
}

/** Bollinger bandwidth (20, 2) percentile over the last n bars. */
export function bandwidthRank(h1: Candle[], n = 120): number {
  const s = h1.slice(-(n + 20));
  if (s.length < 60) return NaN;
  const bw: number[] = [];
  for (let i = 19; i < s.length; i++) {
    const w = s.slice(i - 19, i + 1).map((c) => c.c), m = w.reduce((a, b) => a + b, 0) / 20;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / 20);
    bw.push(m > 0 ? (4 * sd) / m : NaN);
  }
  const x = bw[bw.length - 1];
  const v = bw.filter(finite);
  return finite(x) && v.length ? v.filter((y) => y <= x).length / v.length : NaN;
}

/** All inputs at the last closed hourly bar (h1 needs >= 130 bars for the Hurst estimate; d1 >= 30). */
export function characterInputs(h1: Candle[], d1: Candle[], others: Candle[][], volFc?: number): CharacterInputs {
  const win = h1.slice(-160);
  const a = win.length >= 30 ? adx(win, 14).adx : [];
  return {
    rvPct: volPercentile(rv24(win), d1),
    volFc,
    corr: avgCorrelation(win, others.map((o) => o.slice(-160))),
    hurst: hurstVR(win),
    er: efficiencyRatio(win),
    adx: a.length ? a[a.length - 1] : NaN,
    bbRank: bandwidthRank(win),
  };
}

/** Character at the last closed hourly bar. */
export function characterOf(h1: Candle[], d1: Candle[], others: Candle[][], volFc?: number): { cls: Character; why: string; x: CharacterInputs } {
  const x = characterInputs(h1, d1, others, volFc);
  return { ...classify(x), x };
}

/** The character the next 24 hours actually had (for scoring the classifier): realised volatility of
 *  those 24 hours against the same daily-volatility history, their correlation with the other coins,
 *  and their efficiency ratio. `h1Fwd` holds the bar before the window plus the 24 bars in it. */
export function realisedCharacter(h1Fwd: Candle[], d1: Candle[], othersFwd: Candle[][], t = CHAR_THRESHOLDS): Character {
  const rvPct = volPercentile(rv24(h1Fwd), d1);
  const corr = avgCorrelation(h1Fwd, othersFwd, 24);
  const er = efficiencyRatio(h1Fwd, 24);
  if (rvPct >= t.volPct) return finite(corr) && corr >= t.sysCorr ? 'volatile_systemic' : 'volatile_idio';
  return er >= t.er ? 'trending' : 'calm';
}
