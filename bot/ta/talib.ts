// TA-Lib (https://ta-lib.org, the C library behind ta-lib-python) as the bot's main indicator engine,
// through the native Node binding vendored in vendor/talib (compiled from TA-Lib's C sources on
// install). The core indicators every consumer reads (ATR, EMA / SMA, ADX / DI, Bollinger, RSI, MACD,
// Stochastic, Williams %R, OBV, MFI) come from here; the TA library in bot/ta (market structure,
// divergences, fair-value gaps, volume profile, Ichimoku, Keltner squeeze, VWAP, round numbers, the
// knowledge base's rules and confluences) adds what TA-Lib doesn't have.
//
// On top of the core, TA-Lib-only readings and its 61 candlestick patterns (CDL*) become extra model
// inputs (talibExtras). If the native module can't load, everything falls back to the built-in
// indicators and the extras read NaN; TA_ENGINE says which engine is active, and every model file
// records the engine it was trained with so a mismatch is visible.

import { createRequire } from 'module';
import type { Candle } from './indicators';

interface TalibLib {
  version: string;
  functions: Array<{ name: string; group: string }>;
  execute(p: Record<string, unknown>): { begIndex: number; nbElement: number; result: Record<string, number[]> };
  explain(name: string): { optInputs?: Array<{ name: string; defaultValue: number }> };
}

/** Each function's documented default optional inputs (TA-Lib rejects a call that omits one). */
const defaults = new Map<string, Record<string, number>>();
function defaultsOf(L: TalibLib, name: string): Record<string, number> {
  let d = defaults.get(name);
  if (!d) { d = {}; try { for (const o of L.explain(name).optInputs ?? []) d[o.name] = o.defaultValue; } catch { /* unknown function */ } defaults.set(name, d); }
  return d;
}

let lib: TalibLib | null | undefined;
let loadError: string | undefined;

function load(): TalibLib | null {
  if (lib !== undefined) return lib;
  if (process.env.TA_ENGINE === 'builtin') { lib = null; loadError = 'TA_ENGINE=builtin'; return lib; }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const req = typeof require === 'function' ? require : createRequire(import.meta.url);
    lib = req('talib') as TalibLib;
    if (!lib || typeof lib.execute !== 'function') throw new Error('not the TA-Lib binding');
  } catch (e) {
    lib = null;
    loadError = String((e as Error).message ?? e);
  }
  return lib;
}

/** The active engine: 'talib' when the native module loaded, else 'builtin'. */
export function taEngine(): 'talib' | 'builtin' { return load() ? 'talib' : 'builtin'; }
export function taEngineError(): string | undefined { load(); return loadError; }

type Arr = ArrayLike<number>;

/** Run one TA-Lib function over full-length inputs; outputs aligned to the input (NaN before the first value). */
export function tl(name: string, inputs: Record<string, Arr>, opts: Record<string, number> = {}): Record<string, number[]> {
  const L = load();
  const n = (Object.values(inputs)[0]?.length ?? 0);
  if (!L || n === 0) return {};
  const params: Record<string, unknown> = { name, startIdx: 0, endIdx: n - 1 };
  for (const [k, v] of Object.entries(inputs)) params[k] = Array.isArray(v) ? v : Array.from(v);
  for (const [k, v] of Object.entries({ ...defaultsOf(L, name), ...opts })) params[k] = v;
  let r;
  try { r = L.execute(params); } catch { return {}; }
  // The binding returns nothing (no throw) when TA-Lib rejects the inputs: treat as no output.
  if (!r?.result) { if (process.env.TALIB_DEBUG) console.warn(`[talib] ${name} returned no result (n=${n})`); return {}; }
  const out: Record<string, number[]> = {};
  for (const [k, vals] of Object.entries(r.result ?? {})) {
    const a = new Array<number>(n).fill(NaN);
    for (let i = 0; i < r.nbElement; i++) a[r.begIndex + i] = vals[i];
    out[k] = a;
  }
  return out;
}

/** OHLCV arrays of a candle window. */
export function ohlcv(cs: Candle[]) {
  return { open: cs.map((c) => c.o), high: cs.map((c) => c.h), low: cs.map((c) => c.l), close: cs.map((c) => c.c), volume: cs.map((c) => c.v) };
}

/** The core indicators from TA-Lib (undefined when the module isn't available: use the built-ins). */
export interface CoreSeries {
  atr: number[]; ema12: number[]; ema21: number[]; ema26: number[]; ema50: number[]; sma50: number[]; sma200: number[];
  adx: number[]; plusDI: number[]; minusDI: number[];
  bbUpper: number[]; bbMiddle: number[]; bbLower: number[];
  rsi: number[]; macd: number[]; macdSignal: number[]; macdHist: number[];
  stochK: number[]; stochD: number[]; willR: number[]; obv: number[]; mfi: number[];
}

export function talibCore(cs: Candle[]): CoreSeries | undefined {
  if (!load()) return undefined;
  const p = ohlcv(cs);
  const hlc = { high: p.high, low: p.low, close: p.close };
  const real = { inReal: p.close };
  const bb = tl('BBANDS', real, { optInTimePeriod: 20, optInNbDevUp: 2, optInNbDevDn: 2, optInMAType: 0 });
  const m = tl('MACD', real, { optInFastPeriod: 12, optInSlowPeriod: 26, optInSignalPeriod: 9 });
  const st = tl('STOCH', hlc, { optInFastK_Period: 14, optInSlowK_Period: 3, optInSlowK_MAType: 0, optInSlowD_Period: 3, optInSlowD_MAType: 0 });
  const nan = () => new Array<number>(cs.length).fill(NaN);
  const o = (r: Record<string, number[]>, k: string) => r[k] ?? nan();
  return {
    atr: o(tl('ATR', hlc, { optInTimePeriod: 14 }), 'outReal'),
    ema12: o(tl('EMA', real, { optInTimePeriod: 12 }), 'outReal'), ema21: o(tl('EMA', real, { optInTimePeriod: 21 }), 'outReal'),
    ema26: o(tl('EMA', real, { optInTimePeriod: 26 }), 'outReal'), ema50: o(tl('EMA', real, { optInTimePeriod: 50 }), 'outReal'),
    sma50: o(tl('SMA', real, { optInTimePeriod: 50 }), 'outReal'), sma200: o(tl('SMA', real, { optInTimePeriod: 200 }), 'outReal'),
    adx: o(tl('ADX', hlc, { optInTimePeriod: 14 }), 'outReal'), plusDI: o(tl('PLUS_DI', hlc, { optInTimePeriod: 14 }), 'outReal'), minusDI: o(tl('MINUS_DI', hlc, { optInTimePeriod: 14 }), 'outReal'),
    bbUpper: o(bb, 'outRealUpperBand'), bbMiddle: o(bb, 'outRealMiddleBand'), bbLower: o(bb, 'outRealLowerBand'),
    rsi: o(tl('RSI', real, { optInTimePeriod: 14 }), 'outReal'),
    macd: o(m, 'outMACD'), macdSignal: o(m, 'outMACDSignal'), macdHist: o(m, 'outMACDHist'),
    stochK: o(st, 'outSlowK'), stochD: o(st, 'outSlowD'),
    willR: o(tl('WILLR', hlc, { optInTimePeriod: 14 }), 'outReal'),
    obv: o(tl('OBV', { inReal: p.close, volume: p.volume }), 'outReal'),
    mfi: o(tl('MFI', { ...hlc, volume: p.volume }, { optInTimePeriod: 14 }), 'outReal'),
  };
}

/** Candlestick patterns kept as individual inputs (TA-Lib function names without "CDL"). */
export const KEY_PATTERNS = ['ENGULFING', 'HAMMER', 'INVERTEDHAMMER', 'SHOOTINGSTAR', 'HANGINGMAN', 'DOJI', 'DRAGONFLYDOJI', 'GRAVESTONEDOJI', 'MORNINGSTAR', 'EVENINGSTAR',
  '3WHITESOLDIERS', '3BLACKCROWS', 'HARAMI', 'PIERCING', 'DARKCLOUDCOVER', 'MARUBOZU', '3INSIDE', '3OUTSIDE', 'BELTHOLD', 'KICKING', 'ABANDONEDBABY', 'SPINNINGTOP'];

/** TA-Lib-only readings at the last bar, scale-free, and the candlestick summary (names = TALIB_KEYS). */
export const TALIB_KEYS = [
  'tl_cci', 'tl_mom_atr', 'tl_aroonosc', 'tl_ultosc', 'tl_natr', 'tl_trix', 'tl_ppo', 'tl_cmo', 'tl_bop', 'tl_sar_dist', 'tl_ht_trendmode', 'tl_linreg_slope', 'tl_stddev_atr', 'tl_kama_dist', 'tl_adosc', 'tl_stochrsi',
  'cdl_bull', 'cdl_bear', 'cdl_net', 'cdl_net3',
  ...KEY_PATTERNS.map((k) => `cdl_${k.toLowerCase()}`),
];

const clip = (x: number, lim: number) => (Number.isFinite(x) ? Math.max(-lim, Math.min(lim, x)) : NaN);
let cdlNames: string[] | undefined;
/** Bars handed to the candlestick functions (their body / shadow averages look back about 10 bars). */
const CDL_BARS = 40;

export function talibExtras(cs: Candle[], atr: number): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(TALIB_KEYS.map((k) => [k, NaN]));
  const L = load();
  if (!L || cs.length < 30 || process.env.TA_LIB_EXTRAS === 'false') return out;
  const n = cs.length - 1;
  const p = ohlcv(cs);
  const hlc = { high: p.high, low: p.low, close: p.close };
  const real = { inReal: p.close };
  const last = (r: Record<string, number[]>, k = 'outReal') => r[k]?.[n] ?? NaN;
  const close = p.close[n];
  const perAtr = (x: number) => (atr > 0 ? x / atr : NaN);
  const atrPct = atr > 0 && close > 0 ? atr / close : NaN;
  out.tl_cci = clip(last(tl('CCI', hlc, { optInTimePeriod: 20 })) / 100, 5);
  out.tl_mom_atr = clip(perAtr(last(tl('MOM', real, { optInTimePeriod: 10 }))), 20);
  out.tl_aroonosc = clip(last(tl('AROONOSC', { high: p.high, low: p.low }, { optInTimePeriod: 25 })) / 100, 1);
  out.tl_ultosc = clip((last(tl('ULTOSC', hlc, { optInTimePeriod1: 7, optInTimePeriod2: 14, optInTimePeriod3: 28 })) - 50) / 50, 1);
  const natr = last(tl('NATR', hlc, { optInTimePeriod: 14 }));
  out.tl_natr = natr > 0 ? clip(Math.log(natr / 100), 15) : NaN;
  out.tl_trix = atrPct > 0 ? clip(last(tl('TRIX', real, { optInTimePeriod: 15 })) / (100 * atrPct), 10) : NaN;
  out.tl_ppo = atrPct > 0 ? clip(last(tl('PPO', real, { optInFastPeriod: 12, optInSlowPeriod: 26, optInMAType: 1 })) / (100 * atrPct), 20) : NaN;
  out.tl_cmo = clip(last(tl('CMO', real, { optInTimePeriod: 14 })) / 100, 1);
  out.tl_bop = clip(last(tl('BOP', { open: p.open, high: p.high, low: p.low, close: p.close })), 1);
  out.tl_sar_dist = clip(perAtr(close - last(tl('SAR', { high: p.high, low: p.low }, { optInAcceleration: 0.02, optInMaximum: 0.2 }))), 20);
  const htm = last(tl('HT_TRENDMODE', real), 'outInteger');
  out.tl_ht_trendmode = Number.isFinite(htm) ? htm : NaN;
  out.tl_linreg_slope = clip(perAtr(last(tl('LINEARREG_SLOPE', real, { optInTimePeriod: 14 }))), 5);
  out.tl_stddev_atr = clip(perAtr(last(tl('STDDEV', real, { optInTimePeriod: 20, optInNbDev: 1 }))), 10);
  out.tl_kama_dist = clip(perAtr(close - last(tl('KAMA', real, { optInTimePeriod: 30 }))), 30);
  const vols = p.volume.slice(Math.max(0, n - 19));
  const avgV = vols.reduce((a, v) => a + v, 0) / Math.max(1, vols.length);
  out.tl_adosc = avgV > 0 ? clip(last(tl('ADOSC', { ...hlc, volume: p.volume }, { optInFastPeriod: 3, optInSlowPeriod: 10 })) / (avgV * 10), 10) : NaN;
  out.tl_stochrsi = clip((last(tl('STOCHRSI', real, { optInTimePeriod: 14, optInFastK_Period: 5, optInFastD_Period: 3, optInFastD_MAType: 0 }), 'outFastK') - 50) / 50, 1);
  // Candlestick patterns on the last bars: TA-Lib returns +100 / -100 (+-200 for confirmed variants).
  cdlNames ??= L.functions.filter((f) => f.name.startsWith('CDL')).map((f) => f.name);
  const w = cs.slice(Math.max(0, cs.length - CDL_BARS));
  const q = ohlcv(w), m = w.length - 1;
  let bull = 0, bear = 0, net3 = 0;
  const key = new Set(KEY_PATTERNS.map((k) => `CDL${k}`));
  for (const name of cdlNames) {
    const r = tl(name, { open: q.open, high: q.high, low: q.low, close: q.close })?.outInteger;
    if (!r) continue;
    const v = (r[m] ?? 0) / 100;
    if (v > 0) bull += v; else if (v < 0) bear -= v;
    for (let k = Math.max(0, m - 2); k <= m; k++) net3 += (r[k] ?? 0) / 100;
    if (key.has(name)) out[`cdl_${name.slice(3).toLowerCase()}`] = clip(v, 2);
  }
  out.cdl_bull = clip(bull, 5); out.cdl_bear = clip(bear, 5); out.cdl_net = clip(bull - bear, 5); out.cdl_net3 = clip(net3, 8);
  return out;
}
