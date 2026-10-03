// CSV parsers for historical candles. Recognised layouts:
//   binance  data.binance.vision klines: 12 columns, no header (spot) or `open_time,...` (futures);
//            open time in ms, or in MICROseconds for spot files from 2025 on.
//   cdd      CryptoDataDownload (also their Bittrex/Bitstamp/Gemini/... files): a URL banner line,
//            then `unix,date,symbol,open,high,low,close,Volume <BASE>,Volume <QUOTE>[,tradecount]`,
//            newest first; older files use dates like `2020-03-13 08-PM`.
//   yahoo    `Date,Open,High,Low,Close,Adj Close,Volume` (daily) or `Datetime,...` (intraday, with a
//            UTC offset); also the yfinance multi-row header (`Price,...` / `Ticker,...` / `Date,...`).
//   bittrex  Bittrex API export `startsAt,open,high,low,close,volume,quoteVolume`.
//   coinbase `time,low,high,open,close,volume` (Exchange API rows).
//   generic  any header with a time column and open/high/low/close.
// Every timestamp is converted to the bar's OPEN time in UTC milliseconds (all of these sources
// stamp bars with their open time; importCsv.ts verifies that against other sources when it can).

import path from 'path';
import type { Candle } from '../../bot/ta/indicators';
import { HIST_TF_MS, tfFromMs, type HistTf } from './candles';

export interface ParsedCsv {
  format: 'binance' | 'cdd' | 'yahoo' | 'bittrex' | 'coinbase' | 'generic';
  /** Store source name: the exchange (binance, bittrex, bitstamp, coinbase, ...), yahoo, cdd or other. */
  source: string;
  asset?: string;
  quote?: string;
  tf?: HistTf;
  candles: Candle[];
  notes: string[];
}

const USD_QUOTES = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'USD'];
const EXCHANGES = ['binance', 'bittrex', 'bitstamp', 'coinbase', 'gemini', 'kraken', 'bitfinex', 'okx', 'kucoin', 'huobi', 'poloniex', 'bybit'];

/** Split "BTCUSDT", "BTC/USD", "BTC-USD", "btc_usd" into base / quote (USD-like quotes only). */
export function splitSymbol(sym: string): { asset: string; quote: string } | undefined {
  const s = sym.toUpperCase().replace(/\.CSV$/, '');
  const parts = s.split(/[\/\-_: ]+/).filter(Boolean);
  if (parts.length >= 2 && USD_QUOTES.includes(parts[1])) return { asset: parts[0], quote: parts[1] };
  for (const q of USD_QUOTES) if (s.length > q.length && s.endsWith(q) && /^[A-Z0-9]+$/.test(s)) return { asset: s.slice(0, -q.length), quote: q };
  return undefined;
}

/** Timeframe named in a file name (BTCUSDT-1h-2021-03.csv, Bittrex_BTCUSD_1h.csv, ..._d.csv). */
export function tfFromName(name: string): HistTf | undefined {
  const tokens = path.basename(name).toLowerCase().replace(/\.csv$/, '').split(/[\s_\-.]+/);
  const map: Record<string, HistTf> = { '1m': '1m', minute: '1m', '5m': '5m', '15m': '15m', '1h': '1h', '60m': '1h', hourly: '1h', hour: '1h', '4h': '4h', '1d': '1d', d: '1d', daily: '1d', day: '1d' };
  for (const t of tokens) if (map[t]) return map[t];
  return undefined;
}

function assetFromName(name: string): { asset: string; quote: string } | undefined {
  const base = path.basename(name).replace(/\.csv$/i, '');
  const tokens = base.split(/[\s_.]+/);
  // Yahoo-style "BTC-USD" keeps the dash; Binance "BTCUSDT-1h-2021-03" splits on it.
  for (const t of [base, ...tokens, ...base.split(/[\s_.\-]+/)]) {
    const s = splitSymbol(t);
    if (s && s.asset.length >= 2 && s.asset.length <= 10 && !/^\d/.test(s.asset)) return s;
  }
  // Two adjacent tokens: "BTC-USD-1h" -> BTC + USD.
  const dash = base.split(/[\s_.\-]+/);
  for (let i = 0; i + 1 < dash.length; i++) { const s = splitSymbol(`${dash[i]}-${dash[i + 1]}`); if (s) return s; }
  return undefined;
}

/** TradingView index export (CRYPTOCAP:BTC.D, USDT.D, TOTAL, TOTAL2, TOTAL3, OTHERS.D, ...): TradingView's
 *  own "CRYPTOCAP_BTC.D, 1D.csv" / "CRYPTOCAP_USDT.D, 60.csv" or deploy/tv_history.py's
 *  "CRYPTOCAP_BTC.D_1d.csv". These are market-wide index series, stored apart from spot pairs. */
export function tradingViewIndexFromName(name: string): { asset: string; tf?: HistTf } | undefined {
  const b = path.basename(name).replace(/\.csv$/i, '');
  // CRYPTOCAP_<SYMBOL>_<tf> (TradingView's crypto indexes) or TVINDEX_<NAME>_<tf> (other indexes, e.g. RTY).
  const m = /(?:CRYPTOCAP|TVINDEX)[_:\s]+([A-Z0-9]+(?:\.D)?)(?:[,_\s]+([0-9]+[a-z]?|[a-z])(?=$|[^0-9a-z]))?/i.exec(b);
  if (!m) return undefined;
  const tf = ({ '1d': '1d', d: '1d', '1440': '1d', '240': '4h', '4h': '4h', '60': '1h', '1h': '1h', '15': '15m', '15m': '15m' } as Record<string, HistTf>)[(m[2] ?? '').toLowerCase()];
  return { asset: m[1].toUpperCase(), tf };
}

function exchangeFromName(name: string): string | undefined {
  const b = path.basename(name).toLowerCase();
  return EXCHANGES.find((e) => b.startsWith(`${e}_`) || b.startsWith(`${e}-`) || b.includes(`_${e}_`));
}

/** Epoch number in s / ms / us / ns -> ms. */
export function epochToMs(x: number): number {
  const a = Math.abs(x);
  return a > 1e17 ? x / 1e6 : a > 1e14 ? x / 1e3 : a > 1e11 ? x : x * 1000;
}

/** Date strings: ISO (no zone = UTC), "YYYY-MM-DD HH-AM/PM" (old CDD), "M/D/YYYY H:MM". */
export function parseTime(raw: string): number {
  const s = raw.trim().replace(/^"|"$/g, '');
  if (!s) return NaN;
  if (/^-?\d+(\.\d+)?$/.test(s)) return epochToMs(Number(s));
  const ampm = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2})-(AM|PM)$/i.exec(s);
  if (ampm) {
    let h = Number(ampm[2]) % 12;
    if (ampm[3].toUpperCase() === 'PM') h += 12;
    return Date.parse(`${ampm[1]}T${String(h).padStart(2, '0')}:00:00Z`);
  }
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (us) return Date.UTC(Number(us[3]), Number(us[1]) - 1, Number(us[2]), Number(us[4] ?? 0), Number(us[5] ?? 0), Number(us[6] ?? 0));
  let iso = s.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) iso += 'T00:00:00';
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(iso)) iso += 'Z';
  return Date.parse(iso);
}

function splitLine(line: string): string[] {
  if (!line.includes('"')) return line.split(',');
  const out: string[] = [];
  let cur = '', q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

const num = (s: string | undefined) => (s === undefined || s.trim() === '' ? NaN : Number(s.trim().replace(/^"|"$/g, '')));

/** Median spacing of timestamps -> timeframe. */
function inferTf(ts: number[]): HistTf | undefined {
  const s = [...ts].sort((a, b) => a - b);
  const d: number[] = [];
  for (let i = 1; i < s.length && d.length < 2000; i++) if (s[i] > s[i - 1]) d.push(s[i] - s[i - 1]);
  if (!d.length) return undefined;
  d.sort((a, b) => a - b);
  return tfFromMs(d[Math.floor(d.length / 2)]);
}

export function parseCandleCsv(text: string, fileName = 'data.csv', hint: { asset?: string; tf?: HistTf; source?: string } = {}): ParsedCsv {
  const notes: string[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) throw new Error(`${fileName}: empty file`);
  const tvIndex = tradingViewIndexFromName(fileName);
  const nameAsset = tvIndex ? undefined : assetFromName(fileName);
  const exch = exchangeFromName(fileName);
  let format: ParsedCsv['format'];
  let candles: Candle[] = [];
  let symbolSeen: string | undefined;
  const first = splitLine(lines[0]);

  if (first.length >= 11 && first[0].trim() !== '' && Number.isFinite(Number(first[0]))) {
    // Binance kline without header.
    format = 'binance';
    candles = binanceRows(lines);
  } else if (first[0].trim().toLowerCase() === 'open_time') {
    format = 'binance';
    candles = binanceRows(lines.slice(1));
  } else {
    // Header-based: skip banner lines (CDD URL) and yfinance's extra rows.
    let h = 0;
    while (h < lines.length && !/(open|close)/i.test(lines[h])) h++;
    if (h >= lines.length) throw new Error(`${fileName}: no header with open/close columns`);
    const header = splitLine(lines[h]).map((x) => x.trim().replace(/^"|"$/g, ''));
    const low = header.map((x) => x.toLowerCase());
    const col = (...names: string[]) => { for (const n of names) { const i = low.indexOf(n); if (i >= 0) return i; } return -1; };
    const banner = h > 0 && /cryptodatadownload/i.test(lines.slice(0, h).join(' '));
    const tIdx = col('unix', 'unix timestamp', 'timestamp', 'open_time', 'time', 'starts_at', 'startsat', 'date', 'datetime', 'price');
    const iO = col('open'), iH = col('high'), iL = col('low'), iC = col('close'), iAdj = col('adj close');
    const sym = col('symbol', 'ticker', 'pair');
    if (tIdx < 0 || iO < 0 || iH < 0 || iL < 0 || iC < 0) throw new Error(`${fileName}: need time, open, high, low, close columns (header: ${header.join(',')})`);
    format = banner || (low.includes('unix') && sym >= 0) ? 'cdd' : low.includes('adj close') || low[0] === 'date' || low[0] === 'datetime' || low[0] === 'price' ? 'yahoo' : low.includes('startsat') ? 'bittrex' : low[0] === 'time' && low[1] === 'low' ? 'coinbase' : 'generic';
    // Volume in the base asset: "volume", "volume <base>", else the first volume column that is not the quote.
    const baseGuess = (hint.asset ?? nameAsset?.asset ?? '').toLowerCase();
    let iV = col('volume');
    if (iV < 0 && baseGuess) iV = col(`volume ${baseGuess}`);
    if (iV < 0) iV = low.findIndex((x) => x.startsWith('volume') && !/(usd|quote)/.test(x));
    if (iV < 0) iV = low.findIndex((x) => x.startsWith('volume'));
    // When both "unix" and "date" exist, prefer unix (numeric, unambiguous).
    const dateIdx = col('date', 'datetime');
    for (const line of lines.slice(h + 1)) {
      const f = splitLine(line);
      let t = parseTime(f[tIdx] ?? '');
      if (!Number.isFinite(t) && dateIdx >= 0) t = parseTime(f[dateIdx] ?? '');
      if (!Number.isFinite(t)) continue; // yfinance "Ticker"/"Date" rows, footers
      const c = num(f[iC]);
      candles.push({ ts: t, o: num(f[iO]), h: num(f[iH]), l: num(f[iL]), c, v: iV >= 0 ? num(f[iV]) : 0 });
      if (sym >= 0 && !symbolSeen && f[sym]) symbolSeen = f[sym].trim();
    }
    if (format === 'yahoo' && iAdj >= 0) notes.push('yahoo: used Close (Adj Close is identical for crypto)');
  }

  // Asset / quote: explicit hint, symbol column, file name.
  const fromSym = symbolSeen ? splitSymbol(symbolSeen) : undefined;
  const aq = fromSym ?? nameAsset;
  const asset = (hint.asset ?? tvIndex?.asset ?? aq?.asset)?.toUpperCase();
  const quote = aq?.quote;
  if (!hint.asset && symbolSeen && !fromSym) notes.push(`symbol "${symbolSeen}" is not a USD pair`);

  // Timeframe: hint, file name, then spacing; warn when name and spacing disagree.
  const spacing = inferTf(candles.map((c) => c.ts));
  // (".D" in a dominance symbol would read as "daily": TradingView names carry their own interval.)
  const named = tvIndex ? tvIndex.tf : tfFromName(fileName);
  const tf = hint.tf ?? named ?? spacing;
  if (named && spacing && named !== spacing) notes.push(`file name says ${named} but bars are spaced ${spacing}`);

  if (tvIndex) notes.push(`TradingView index ${tvIndex.asset}: stored apart from spot pairs`);
  const source = hint.source ?? (tvIndex ? 'tradingview' : format === 'yahoo' ? 'yahoo' : format === 'binance' ? 'binance' : format === 'coinbase' ? 'coinbase' : format === 'bittrex' ? 'bittrex' : exch ?? (format === 'cdd' ? 'cdd' : 'other'));
  return { format, source, asset, quote, tf, candles: candles.sort((a, b) => a.ts - b.ts), notes };
}

function binanceRows(lines: string[]): Candle[] {
  const out: Candle[] = [];
  for (const line of lines) {
    const f = line.split(',');
    if (f.length < 6) continue;
    const t = Number(f[0]);
    if (!Number.isFinite(t)) continue;
    const bar: Candle = { ts: epochToMs(t), o: Number(f[1]), h: Number(f[2]), l: Number(f[3]), c: Number(f[4]), v: Number(f[5]) };
    // Column 10: taker buy base asset volume (order flow). Index-price klines carry zeros there.
    if (f.length >= 10 && Number.isFinite(Number(f[9])) && bar.v > 0) bar.tb = Number(f[9]);
    out.push(bar);
  }
  return out;
}

/** Bars per timeframe implied by a span (for messages). */
export const barsIn = (ms: number, tf: HistTf) => Math.round(ms / HIST_TF_MS[tf]);
