// History replay: years of exchange history turned into recording files (md-YYYY-MM-DD.jsonl.gz) that
// research/replay.ts reads exactly like the bot's own live recordings. Every recording-based step (the
// perps model, the SNN tournaments, the whole-bot replay and sweep) can then "trade" years of history
// through the same code paths it uses on live data, without knowing the difference.
//
// From the candle store (research/history/*):
//   index / spot   1-minute Binance spot bars (source binance-1m) as four prints a minute (+0 / +15 / +30 /
//                  +45 s): the bar's open, then a Brownian bridge toward its close at +60 s (where the next
//                  bar's open takes over), spread by the recent Garman-Klass volatility of the bars. Each
//                  print says as much about the coming close as a real price at that moment would, and the
//                  15 s returns add up to the bars' real variance. (Printing the bar's extremes instead
//                  told the replay the bar's direction 30 s early and doubled the measured volatility.)
//                  The index prints are scaled by the Binance -> Kalshi basis: each real 15-minute contract's
//                  strike is Kalshi's own 60 s index average, so strike / Binance price at its open is a
//                  causal basis reading (it applies from that open on, forward-filled).
//   candles        the live candle feed's timeframes (1m, 5m, 15m, 1h, 1d): each day file starts with the
//                  last 300 closed bars of each, then every bar as it closes (so any day can start a replay)
//   perp           1-minute Binance USD-M perpetual bars (binance-um) along the same bridge draws, quoted at
//                  the spread and contract specs the bot's own perp recordings show (defaults otherwise),
//                  with Binance's last settled funding rate (binance-funding), the next funding time and
//                  Binance's open interest (binance-oi: every 5 minutes from September 2020; a reading is
//                  carried at most 10 minutes)
//   market / book / trade / result / alive
//                  Kalshi's settled contracts (history/kalshi, 1-minute YES bid / ask candles): the market
//                  a minute before it opens, a book snapshot each minute (nominal 100 contracts a side),
//                  marked alive at the prints in between while it is near the money, the minute's volume as
//                  one trade at its last price, the result one second after the close
//   tennis (tennisSeries)
//                  Kalshi's settled tennis match markets (history/kalshi/<SERIES>, with their trade tapes in
//                  <SERIES>/trades): the market half an hour before the match, the real tape trade by trade
//                  (price, size, taker side) with the book following it (the side the taker hit moves to the
//                  trade price, the minute candles' spread on the other side), the minute quotes, alive
//                  marks every 5 s, the result after the close. No score: Kalshi keeps no score history
//                  (the bot's own recordings carry the real live score).
//   synthetic contracts (synth: 1)
//                  Wherever Kalshi's history has no contract, the same contracts built from the price path:
//                  a 15-minute Up/Down every quarter hour and an hourly "above" ladder (4 strikes around the
//                  price at the hour), per asset. Kalshi's rules: the strike of an Up/Down is the index's
//                  60 s average before the open, the result is the 60 s average before the close against
//                  the strike. Quoted at every print around a no-skill fair value (a random walk at the bars'
//                  recent volatility, Student-t tails) with a 1-2 cent spread: a network beats these quotes
//                  only by calling the direction better than a coin flip on a random walk. The networks learn
//                  on them; the strategy backtest and the decision model's dataset skip them (they would be
//                  grading the bot's pricing against itself).
//   dominance      BTC.D and USDT.D at every print, rebuilt as the live bot rebuilds them: anchored to the
//                  stored real series (TradingView's history and the bot's own hourly bars; hourly, 4-hourly
//                  or daily, the finest there is) and moved between anchors by BTC's and the alts' prints
//                  (research/history/dominanceReplay.ts).
//
// Prints are 15 s apart. The live features read one value a second (5 s gap limits, Kalshi's 60 one-second
// marks): the replay reader fills the seconds in between with a Brownian bridge at the series' own
// volatility (research/replay.ts), from the records marked `hist`.
//
// The replay can start at the first day of the 1-minute history (HISTORY_REPLAY_YEARS=0: August 2017 for
// BTC and ETH; each coin from its own listing). A day is rebuilt when an input it read changes: Kalshi's
// files for it, the 1-minute spot / perp history or the funding rates reaching further into it (a day
// built before its data arrived), dominance anchors added near it.
//
// Every record of an instant shares its timestamp; replays apply the whole instant before acting on it
// (research/replay.ts readRecordings: `tie`).
//
// What it cannot reproduce: the real second-by-second path inside a minute (the reader's bridge stands in
// for it), order-book depth, the side of each crypto contract trade. Fill simulation on replayed contracts
// is therefore coarse; the perps model and the networks' direction calls depend on prices, not on those.
//
//   npm run history:replay -- --history data/history --out data/history-replay --assets BTC,ETH --from 2024-01-01

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import zlib from 'zlib';
import { contractKind, priceContract, SETTLEMENT_AVG_SEC } from '../../bot/model/fairValue';
import { loadSeries } from './candles';
import { loadKalshiTrades, type KalshiHistMarket, type KalshiTrade } from './kalshiHistory';
import { anchorsIn, dominanceAnchors, DominanceReplay, type DomState } from './dominanceReplay';
import type { Candle } from '../../bot/ta/indicators';

export const REPLAY_VERSION = 5;
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const TFS: Array<{ tf: string; ms: number }> = [{ tf: '1m', ms: MIN }, { tf: '5m', ms: 5 * MIN }, { tf: '15m', ms: 15 * MIN }, { tf: '1h', ms: HOUR }, { tf: '1d', ms: DAY }];
const BACKFILL = 300;
/** Print offsets inside a minute. */
const TICKS = [0, 15_000, 30_000, 45_000];
/** EWMA half-lives (in 1-minute bars) of the bar variance: the bridge's spread, the synthetic market's volatility. */
const PATH_HALF_LIFE = 10, MARKET_HALF_LIFE = 60;
/** Tails of the synthetic market's random walk (Student-t degrees of freedom). */
export const MARKET_NU = 5;
/** Hourly ladder: grid offsets from the price at the hour (two strikes below, two above), grid = 0.25% of price. */
const LADDER = [-1, 0, 1, 2];
const LADDER_STEP = 0.0025;
/** Print slots a day (TICKS.length a minute). */
const SLOTS = 1440 * TICKS.length;

export interface PerpSpec { ticker?: string; contractSize?: number; tickSize?: number; fractional?: boolean; leverage?: number; halfSpreadBps?: number }
export interface ReplayOpts {
  historyDir: string;
  outDir: string;
  assets: string[];
  fromDay: string;
  toDay: string;
  /** Kalshi settled contracts (download: research/history/kalshiHistory.ts); default <historyDir>/kalshi. */
  kalshiDir?: string;
  /** Kalshi tennis series to replay (match markets from <kalshiDir>/<SERIES>, tapes from <SERIES>/trades). */
  tennisSeries?: string[];
  perpSpecs?: Record<string, PerpSpec>;
  /** Synthetic 15-minute and hourly contracts where Kalshi's history has none (default on). */
  synthetic?: boolean;
  /** Rebuild days already written (default: skip them unless the format version changed). */
  force?: boolean;
  log?: (m: string) => void;
}

/** Garman-Klass variance of a bar's log price over its minute (unbiased for a driftless random walk). */
export function gkVariance(b: { o: number; h: number; l: number; c: number }): number {
  const hl = Math.log(b.h / b.l), co = Math.log(b.c / b.o);
  return Number.isFinite(hl) && Number.isFinite(co) ? Math.max(0, 0.5 * hl * hl - (2 * Math.LN2 - 1) * co * co) : 0;
}

/** The four prints of a 1-minute bar (+0, +15, +30, +45 s): the open, then a Brownian bridge (log price)
 *  toward the close at +60 s with variance `varPerSec` per second, driven by three standard normals `z`. */
export function barPath(b: { o: number; c: number }, varPerSec: number, z: readonly number[]): Array<[number, number]> {
  const S = Math.log(b.c / b.o), T = 60;
  const out: Array<[number, number]> = [[0, b.o]];
  let B = 0, t0 = 0;
  for (let k = 0; k < 3; k++) {
    const t = (k + 1) * 15;
    B = (B * (T - t)) / (T - t0) + Math.sqrt((Math.max(0, varPerSec) * (t - t0) * (T - t)) / (T - t0)) * (z[k] ?? 0);
    out.push([t * 1000, b.o * Math.exp((S * t) / T + B)]);
    t0 = t;
  }
  return out;
}

/** Deterministic standard normals (mulberry32 + Box-Muller): the same bar always gets the same path. */
export function normals(seed: number, n: number): number[] {
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out: number[] = [];
  while (out.length < n) { const r = Math.sqrt(-2 * Math.log(Math.max(u(), 1e-12))), th = 2 * Math.PI * u(); out.push(r * Math.cos(th), r * Math.sin(th)); }
  return out.slice(0, n);
}
export const hashStr = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

/** Kalshi's official 60 s average ending at `windowEnd` (one sample a second: the last print at or before
 *  each mark), from what has printed by `now`. Undefined when a mark has no print within 20 s. */
export function windowAverage(prints: ReadonlyArray<readonly [number, number]>, windowEnd: number, now = windowEnd, windowSec = SETTLEMENT_AVG_SEC): { avg: number; n: number } | undefined {
  let sum = 0, n = 0, j = -1;
  for (let k = 1; k <= windowSec; k++) {
    const mark = windowEnd - (windowSec - k) * 1000;
    if (mark > now) break;
    while (j + 1 < prints.length && prints[j + 1][0] <= mark) j++;
    if (j < 0 || mark - prints[j][0] > 20_000) return undefined;
    sum += prints[j][1];
    n++;
  }
  return n ? { avg: sum / n, n } : undefined;
}

/** YES bid / ask around a fair value: 2 cents wide between 10c and 90c, 1 cent outside, on the cent grid. */
export function synthQuote(p: number): [number, number] {
  const w = p >= 0.1 && p <= 0.9 ? 2 : 1;
  const bid = Math.min(99 - w, Math.max(1, Math.round(p * 100 - w / 2)));
  return [bid / 100, (bid + w) / 100];
}

/** A "round" grid step near x: 1, 2, 2.5 or 5 times a power of ten. */
export function niceStep(x: number): number {
  const e = Math.pow(10, Math.floor(Math.log10(x)));
  let best = 1;
  for (const m of [1, 2, 2.5, 5, 10]) if (Math.abs(Math.log(x / e / m)) < Math.abs(Math.log(x / e / best))) best = m;
  return best * e;
}

const stamp = (t: number) => new Date(t).toISOString().replace(/[-:T]/g, '').slice(2, 12); // yymmddHHMM (UTC)
const row = (c: Candle): number[] => (c.tb !== undefined ? [c.ts / 1000, c.l, c.h, c.o, c.c, c.v, c.tb] : [c.ts / 1000, c.l, c.h, c.o, c.c, c.v]);

/** Sequential reader of a sorted candle CSV (ts,o,h,l,c,v[,tb]): hands out bars in time order. */
class CsvStream {
  private it?: AsyncIterator<string>;
  private head?: Candle | null;
  constructor(private readonly file: string) {}
  private async next(): Promise<Candle | null> {
    if (!fs.existsSync(this.file)) return null;
    this.it ??= readline.createInterface({ input: fs.createReadStream(this.file), crlfDelay: Infinity })[Symbol.asyncIterator]();
    for (;;) {
      const r = await this.it.next();
      if (r.done) return null;
      if (!r.value || r.value.startsWith('ts')) continue;
      const f = r.value.split(',').map(Number);
      if (!(f[0] > 0) || !(f[4] > 0)) continue;
      return { ts: f[0], o: f[1], h: f[2], l: f[3], c: f[4], v: f[5] || 0, ...(Number.isFinite(f[6]) ? { tb: f[6] } : {}) };
    }
  }
  /** Bars with ts < bound (consumed). */
  async until(bound: number): Promise<Candle[]> {
    const out: Candle[] = [];
    if (this.head === undefined) this.head = await this.next();
    while (this.head && this.head.ts < bound) { out.push(this.head); this.head = await this.next(); }
    return out;
  }
  /** Drop the bars before `bound`. */
  async skip(bound: number): Promise<void> {
    if (this.head === undefined) this.head = await this.next();
    while (this.head && this.head.ts < bound) this.head = await this.next();
  }
}

/** Open interest readings of binance-oi/<ASSET>/oi.csv ("ts,oi,oi_usd"), in time order. */
function readOpenInterest(file: string): AssetState['oi'] {
  const ts: number[] = [], v: number[] = [];
  if (fs.existsSync(file)) for (const l of fs.readFileSync(file, 'utf8').split('\n')) { const c = l.split(','); const t = Number(c[0]), x = Number(c[1]); if (t > 0 && x > 0 && (!ts.length || t > ts[ts.length - 1])) { ts.push(t); v.push(x); } }
  return { ts: Float64Array.from(ts), v: Float64Array.from(v), at: -1 };
}
/** The open interest reading at `t` (the latest at or before it, if at most 10 minutes old). */
function openInterestAt(o: AssetState['oi'], t: number): number | undefined {
  if (o.at >= 0 && o.ts[o.at] > t) o.at = -1; // a new build going back in time
  while (o.at + 1 < o.ts.length && o.ts[o.at + 1] <= t) o.at++;
  return o.at >= 0 && t - o.ts[o.at] <= 10 * MIN ? o.v[o.at] : undefined;
}

function readFunding(file: string): Array<[number, number]> {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').slice(1).map((l) => l.split(',').map(Number) as [number, number]).filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v));
}

interface KMarket { ticker: string; series: string; event?: string; openTime: number; closeTime: number; strike: number | null; cap: number | null; strikeType?: string; result?: string; candles: Array<{ ts: number; bidC: number | null; askC: number | null; last: number | null; volume: number | null }> }

/** Settled Kalshi contracts of the replayed assets in the day files of `day` and the next (files are by close day). */
function kalshiMarkets(dir: string, day: string, assets: Set<string>): Array<KMarket & { asset: string }> {
  const out: Array<KMarket & { asset: string }> = [];
  if (!fs.existsSync(dir)) return out;
  for (const series of fs.readdirSync(dir)) {
    const asset = /^KX([A-Z]+?)(15M|D)?$/.exec(series)?.[1];
    if (!asset || !assets.has(asset)) continue;
    for (const d of [day, new Date(Date.parse(day) + DAY).toISOString().slice(0, 10)]) {
      const f = path.join(dir, series, `${d}.jsonl`);
      if (!fs.existsSync(f)) continue;
      for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!l) continue;
        try { const m = JSON.parse(l) as KMarket; if (m.result === 'yes' || m.result === 'no') out.push({ ...m, asset }); } catch { /* torn line */ }
      }
    }
  }
  return out;
}

/** Perp quote specs from the bot's own recordings (first perp record per asset in the newest days). */
export async function perpSpecsFromRecordings(dir: string, assets: string[]): Promise<Record<string, PerpSpec>> {
  const out: Record<string, PerpSpec> = {};
  if (!fs.existsSync(dir)) return out;
  const files = fs.readdirSync(dir).filter((f) => /^md-\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(f)).sort().reverse().slice(0, 2);
  for (const f of files) {
    const input = fs.createReadStream(path.join(dir, f));
    const rl = readline.createInterface({ input: f.endsWith('.gz') ? input.pipe(zlib.createGunzip()) : input, crlfDelay: Infinity });
    const spreads: Record<string, number[]> = {};
    for await (const l of rl) {
      if (!l.includes('"k":"perp"')) continue;
      try {
        const e = JSON.parse(l);
        if (!assets.includes(e.asset)) continue;
        out[e.asset] ??= { ticker: e.ticker, contractSize: e.contractSize, tickSize: e.tickSize, fractional: e.fractional, leverage: e.leverage };
        if (e.bid > 0 && e.ask > e.bid) (spreads[e.asset] ??= []).push(1e4 * (e.ask - e.bid) / (e.ask + e.bid));
        if (Object.keys(out).length === assets.length && Object.values(spreads).every((s) => s.length > 200)) break;
      } catch { /* torn line */ }
    }
    rl.close(); input.destroy();
    for (const [a, s] of Object.entries(spreads)) { const v = [...s].sort((x, y) => x - y); out[a].halfSpreadBps = v[Math.floor(v.length / 2)]; }
    if (Object.keys(out).length === assets.length) break;
  }
  return out;
}

function roundTo(x: number, tick: number | undefined, dir: -1 | 1): number {
  if (!tick || !(tick > 0)) return x;
  return (dir < 0 ? Math.floor(x / tick) : Math.ceil(x / tick)) * tick;
}

interface SynthContract { ticker: string; strike: number; kind: 'updown' | 'greater'; closeTime: number }
interface AssetState {
  spot: CsvStream; perp: CsvStream; tfs: Map<string, Candle[]>; recent: Candle[]; funding: Array<[number, number]>; basis: number;
  /** Open interest readings (times, values) and the reading in use. */
  oi: { ts: Float64Array; v: Float64Array; at: number };
  /** EWMA bar variance per second: the bridge's spread and the synthetic market's volatility. */
  vPath?: number; vMkt?: number;
  /** Recent index prints [ts, value] for the 60 s averages, and the open synthetic contracts. */
  prints: Array<[number, number]>; open: SynthContract[];
}

type Ev = Record<string, unknown> & { t: number };

interface ReplayManifest {
  version?: number;
  /** Each built day's input signature. */
  days: Record<string, string>;
  /** Records written each day (0: nothing to replay that day, no file). */
  n?: Record<string, number>;
  /** Real Kalshi contracts opening each day. */
  kalshi?: Record<string, number>;
  /** Tennis match markets each day. */
  tennis?: Record<string, number>;
  /** Assets with perpetual quotes each day (Binance's USD-M perps start in September 2019). */
  perps?: Record<string, number>;
}
/** The builder's state at the end of a day: the next build starts from the latest one before its first
 *  day to build instead of going over every earlier day again (same output either way). Kept for the last
 *  KEEP_STATES days (new Kalshi data for a day also rebuilds the day before it) and for each month's last
 *  day (a late input deep in the history, such as a month of funding rates, rebuilds from there). */
interface DayState { carry: Ev[]; assets: Record<string, Pick<AssetState, 'recent' | 'basis' | 'vPath' | 'vMkt' | 'prints' | 'open'>>; dom?: DomState }
interface StateFile { version: number; sig: string; day: string; state: DayState }
const KEEP_STATES = 3;

/** First and last bar time of a sorted candle CSV (`ts,...` lines; a torn last line is ignored). */
export function csvRange(file: string): { first: number; last: number } | undefined {
  let fd: number;
  try { fd = fs.openSync(file, 'r'); } catch { return undefined; }
  try {
    const size = fs.fstatSync(fd).size;
    const read = (pos: number, len: number) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); return b.toString('utf8'); };
    const tsOf = (l: string) => { const x = Number(l.slice(0, l.indexOf(','))); return l.includes(',') && x > 0 ? x : undefined; };
    const head = read(0, Math.min(size, 4096)).split('\n');
    if (size > 4096) head.pop();
    const first = head.map(tsOf).find((x) => x !== undefined);
    const tailStart = Math.max(0, size - 4096);
    const tail = read(tailStart, size - tailStart).split('\n');
    tail.pop(); // after the last newline: '' or a torn line
    if (tailStart > 0) tail.shift(); // the chunk may start mid-line
    let last: number | undefined;
    for (let i = tail.length - 1; i >= 0 && last === undefined; i--) last = tsOf(tail[i]);
    return first !== undefined && last !== undefined ? { first, last } : undefined;
  } finally { fs.closeSync(fd); }
}

/** The first day of 1-minute spot history among `assets` (the replay's start for "all of it"). */
export function historyStart(historyDir: string, assets: string[]): string | undefined {
  const firsts = assets.map((a) => csvRange(path.join(historyDir, 'binance-1m', a, '1m.csv'))?.first).filter((x): x is number => x !== undefined);
  return firsts.length ? new Date(Math.floor(Math.min(...firsts) / DAY) * DAY).toISOString().slice(0, 10) : undefined;
}

/** Replay days holding Kalshi's real contracts (the strategy backtest and its sweep trade only those). */
export function replayKalshiDays(outDir: string): string[] { return manifestDays(outDir, 'kalshi'); }
/** Replay days holding Kalshi tennis matches. */
export function replayTennisDays(outDir: string): string[] { return manifestDays(outDir, 'tennis'); }
/** Replay days with perpetual quotes. */
export function replayPerpDays(outDir: string): string[] { return manifestDays(outDir, 'perps'); }
function manifestDays(outDir: string, field: 'kalshi' | 'tennis' | 'perps'): string[] {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(outDir, 'replay-manifest.json'), 'utf8')) as ReplayManifest;
    if (m.version !== REPLAY_VERSION) return [];
    return Object.entries(m[field] ?? {}).filter(([d, n]) => n > 0 && fs.existsSync(path.join(outDir, `md-${d}.jsonl.gz`))).map(([d]) => d).sort();
  } catch { return []; }
}

export async function buildHistoryReplay(o: ReplayOpts): Promise<{ days: number; written: number; skipped: number; assets: string[]; notes: string[]; synthetic: number; tennis?: number; dominance: number; resumed?: string }> {
  const log = o.log ?? ((m: string) => console.log(`[replay] ${m}`));
  fs.mkdirSync(o.outDir, { recursive: true });
  const manifestFile = path.join(o.outDir, 'replay-manifest.json');
  let manifest: ReplayManifest = { days: {} };
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { /* first build */ }
  if (manifest.version !== REPLAY_VERSION) manifest = { version: REPLAY_VERSION, days: {} };
  manifest.n ??= {};
  manifest.kalshi ??= {};
  manifest.tennis ??= {};
  manifest.perps ??= {};
  const saveManifest = () => { fs.writeFileSync(`${manifestFile}.tmp`, JSON.stringify(manifest)); fs.renameSync(`${manifestFile}.tmp`, manifestFile); };
  const notes: string[] = [];
  const assets = o.assets.filter((a) => {
    const ok = fs.existsSync(path.join(o.historyDir, 'binance-1m', a, '1m.csv'));
    if (!ok) notes.push(`${a}: no 1-minute spot history (binance-1m), skipped`);
    return ok;
  });
  const kalshiDir = o.kalshiDir ?? path.join(o.historyDir, 'kalshi');
  const synthetic = o.synthetic !== false;
  const assetSet = new Set(assets);
  const from = Date.parse(o.fromDay), to = Date.parse(o.toDay);
  const aPath = 1 - Math.pow(0.5, 1 / PATH_HALF_LIFE), aMkt = 1 - Math.pow(0.5, 1 / MARKET_HALF_LIFE);
  const st = new Map<string, AssetState>();
  // How far each input reaches (spot and perp minutes, funding rates): a day built before its data arrived
  // is built again once the data covers it.
  const cover = new Map<string, Array<[{ first: number; last: number } | undefined, number]>>();
  for (const a of assets) {
    const tfs = new Map<string, Candle[]>();
    for (const t of ['15m', '1h', '1d'] as const) tfs.set(t, loadSeries(o.historyDir, a, t).candles);
    const spotFile = path.join(o.historyDir, 'binance-1m', a, '1m.csv'), perpFile = path.join(o.historyDir, 'binance-um', a, '1m.csv'), fundFile = path.join(o.historyDir, 'binance-funding', a, 'funding.csv'), oiFile = path.join(o.historyDir, 'binance-oi', a, 'oi.csv');
    st.set(a, { spot: new CsvStream(spotFile), perp: new CsvStream(perpFile), tfs, recent: [], funding: readFunding(fundFile), oi: readOpenInterest(oiFile), basis: 1, prints: [], open: [] });
    cover.set(a, [[csvRange(spotFile), MIN], [csvRange(perpFile), MIN], [csvRange(fundFile), 8 * HOUR], [csvRange(oiFile), 5 * MIN]]);
  }
  const anchors = dominanceAnchors(o.historyDir);
  if (!anchors.length) notes.push('no BTC.D history (TradingView / the bot\'s own bars): no dominance records');
  const dom = new DominanceReplay(anchors);
  let written = 0, skipped = 0, days = 0, synthCount = 0, tennisCount = 0, domCount = 0;
  // Events past midnight (a real contract running into the next day, the last 1m bar's close) go into the
  // next day's file, so every file stays in time order.
  let carry: Ev[] = [];
  const tennisSeries = o.tennisSeries ?? [];
  const base = `${REPLAY_VERSION}:${assets.join(',')}:${synthetic ? 'synth' : 'real'}:${tennisSeries.join(',')}`;
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  // A day's inputs: the Kalshi history it reads (a later download reached it), how far the 1-minute
  // history and funding rates reach into it, and the dominance anchors near it.
  const seriesDirs = fs.existsSync(kalshiDir) ? fs.readdirSync(kalshiDir).filter((x) => fs.statSync(path.join(kalshiDir, x)).isDirectory()) : [];
  const sigOf = (day: string) => {
    const d0 = Date.parse(day), d1 = d0 + DAY, next = iso(d1);
    let bytes = 0;
    for (const sd of seriesDirs) for (const f of [`${day}.jsonl`, `${next}.jsonl`, `trades/${day}.jsonl`, `trades/${next}.jsonl`]) { try { bytes += fs.statSync(path.join(kalshiDir, sd, f)).size; } catch { /* none */ } }
    const cov = assets.map((a) => cover.get(a)!.map(([r, len]) => (!r ? 'n' : r.first >= d1 || r.last + len >= d1 ? '' : String(r.last))).join('/')).join(',');
    return `${base}:${bytes}:${cov}:${anchorsIn(anchors, d0 - DAY, d1)}`;
  };
  const fileOf = (day: string) => path.join(o.outDir, `md-${day}.jsonl.gz`);
  const needs = (day: string) => Boolean(o.force) || manifest.days[day] !== sigOf(day) || (manifest.n![day] !== 0 && !fs.existsSync(fileOf(day)));
  // The bridge, the volatility estimates, the open contracts and the dominance rebuild carry from day to
  // day, so every day from the start is processed (the writing skipped for days already built) -- unless a
  // kept end-of-day state before the first day to build lets the build start after it.
  const stateDir = path.join(o.outDir, 'replay-states');
  const stateFileOf = (day: string) => path.join(stateDir, `${day}.json.gz`);
  fs.rmSync(path.join(o.outDir, 'replay-state.json'), { force: true }); // format 3's single state file
  let start = from;
  while (start <= to && !needs(iso(start))) start += DAY;
  if (start > to) {
    log(`history replay: all ${Math.round((to - from) / DAY) + 1} day(s) already built`);
    return { days: Math.round((to - from) / DAY) + 1, written: 0, skipped: Math.round((to - from) / DAY) + 1, assets, notes, synthetic: 0, tennis: 0, dominance: 0 };
  }
  let resumedFrom: string | undefined;
  if (start > from) {
    const kept = fs.existsSync(stateDir) ? fs.readdirSync(stateDir).map((f) => /^(\d{4}-\d{2}-\d{2})\.json\.gz$/.exec(f)?.[1]).filter((d): d is string => !!d && d < iso(start) && d >= iso(from - DAY)).sort().reverse() : [];
    let resumed = false;
    for (const d of kept) {
      try {
        const f = JSON.parse(zlib.gunzipSync(fs.readFileSync(stateFileOf(d))).toString('utf8')) as StateFile;
        if (f.version !== REPLAY_VERSION || f.sig !== base || !assets.every((a) => f.state.assets[a])) continue;
        const at = Date.parse(d) + DAY;
        for (const [a, s] of st) { await s.spot.skip(at); await s.perp.skip(at); Object.assign(s, f.state.assets[a]); }
        carry = f.state.carry;
        dom.state = f.state.dom;
        start = at;
        days = skipped = Math.round((start - from) / DAY);
        resumed = true;
        resumedFrom = d;
        break;
      } catch { /* unreadable: an older one */ }
    }
    if (!resumed) start = from;
  }
  fs.mkdirSync(stateDir, { recursive: true });
  for (let d0 = start; d0 <= to; d0 += DAY) {
    days++;
    const day = iso(d0);
    const file = fileOf(day);
    const build = needs(day);
    const d1 = d0 + DAY;
    const ev: Ev[] = carry;
    carry = [];
    const kAll = kalshiMarkets(kalshiDir, day, assetSet);
    const kms = kAll.filter((m) => m.openTime >= d0 && m.openTime < d1);
    // Windows Kalshi's own history covers: no synthetic contract there.
    const real15 = new Set(kAll.filter((m) => /15M$/.test(m.series)).map((m) => `${m.asset}:${m.openTime}`));
    const realHour = new Set(kAll.filter((m) => /D$/.test(m.series)).map((m) => `${m.asset}:${m.closeTime}`));
    // Every asset's spot print at each slot of the day (the dominance rebuild reads them all at once).
    const slotPx = new Map<string, Float64Array>();
    let perpAssets = 0;
    for (const [a, s] of st) {
      const pre = await s.spot.until(d0);
      s.recent.push(...pre.slice(-5 * BACKFILL));
      if (s.recent.length > 5 * BACKFILL) s.recent.splice(0, s.recent.length - 5 * BACKFILL);
      await s.perp.until(d0);
      const spotBars = await s.spot.until(d1), perpBars = await s.perp.until(d1);
      if (perpBars.length) perpAssets++;
      const px = spotBars.length ? new Float64Array(SLOTS).fill(NaN) : undefined;
      if (px) slotPx.set(a, px);
      if (spotBars.length) {
        // Backfill: the last 300 closed bars of every timeframe before the day starts.
        const r5 = aggregate(s.recent.slice(-5 * BACKFILL), 5 * MIN);
        const back: Record<string, Candle[]> = { '1m': s.recent.slice(-BACKFILL), '5m': r5.slice(-BACKFILL) };
        for (const t of ['15m', '1h', '1d']) {
          const arr = s.tfs.get(t)!, ms = TFS.find((x) => x.tf === t)!.ms;
          const hi = lowerBound(arr, d0 - ms + 1); // bars that closed by d0
          back[t] = arr.slice(Math.max(0, hi - BACKFILL), hi);
        }
        for (const [tf, cs] of Object.entries(back)) if (cs.length) ev.push({ t: d0, k: 'candles', asset: a, tf, rows: cs.map(row), ts: d0, hist: 1 });
      }
      // Kalshi strikes of this asset's real 15-minute contracts opening today: the basis readings.
      const opens = kms.filter((m) => m.asset === a && /15M$/.test(m.series) && m.strike).map((m) => ({ t: m.openTime, k: m.strike! })).sort((x, y) => x.t - y.t);
      let oi = 0, last: Candle | undefined = s.recent[s.recent.length - 1];
      const fund = s.funding;
      let fi = 0;
      const spec = o.perpSpecs?.[a] ?? {};
      const half = (spec.halfSpreadBps ?? 1) / 1e4;
      const perpBy = new Map(perpBars.map((c) => [c.ts, c]));
      const seed = hashStr(a);
      let m5: Candle[] = [];
      for (const bar of spotBars) {
        while (oi < opens.length && opens[oi].t <= bar.ts) {
          if (last) { const ratio = opens[oi].k / last.c; if (Math.abs(ratio - 1) < 0.005) s.basis = ratio; }
          oi++;
        }
        const z = normals(seed ^ Math.floor(bar.ts / MIN), 3);
        const prints = barPath(bar, s.vPath ?? 0, z);
        const p = perpBy.get(bar.ts);
        const pprints = p ? barPath(p, s.vPath ?? 0, z) : undefined;
        while (p && fi < fund.length && fund[fi][0] <= bar.ts) fi++;
        const rate = fi > 0 ? fund[fi - 1][1] : undefined;
        const next = Math.ceil((bar.ts + 1) / (8 * HOUR)) * 8 * HOUR;
        const slot0 = ((bar.ts - d0) / MIN) * TICKS.length;
        for (let k = 0; k < TICKS.length; k++) {
          const t = bar.ts + TICKS[k], v = prints[k][1];
          const iv = +(v * s.basis).toPrecision(10);
          ev.push({ t, k: 'index', asset: a, value: iv, ts: t, src: 'kalshi', hist: 1 });
          ev.push({ t, k: 'spot', asset: a, value: v, ts: t, hist: 1 });
          if (px) px[slot0 + k] = v;
          if (pprints) {
            const pv = pprints[k][1];
            ev.push({ t, k: 'perp', ticker: spec.ticker ?? `${a}-PERP`, asset: a, ts: t, bid: roundTo(pv * (1 - half), spec.tickSize, -1), ask: roundTo(pv * (1 + half), spec.tickSize, 1), last: pv, mark: pv,
              fundingRate: rate, nextFundingTs: next, openInterest: openInterestAt(s.oi, t), contractSize: spec.contractSize ?? 0.001, tickSize: spec.tickSize, fractional: spec.fractional ?? true, leverage: spec.leverage ?? 10, hist: 1 });
          }
          s.prints.push([t, iv]);
          if (s.prints.length > 80) s.prints.splice(0, s.prints.length - 64);
          if (synthetic) synthCount += synthTick(a, s, t, iv, ev, real15, realHour);
        }
        // This bar's variance feeds the estimates used from the next bar on (causal).
        const g = gkVariance(bar) / 60;
        s.vPath = s.vPath === undefined ? g : s.vPath + aPath * (g - s.vPath);
        s.vMkt = s.vMkt === undefined ? g : s.vMkt + aMkt * (g - s.vMkt);
        // Closed bars as the live candle feed would deliver them.
        const close = bar.ts + MIN;
        ev.push({ t: close, k: 'candles', asset: a, tf: '1m', rows: [row(bar)], ts: close, hist: 1 });
        m5.push(bar);
        if (close % (5 * MIN) === 0) { const agg = aggregate(m5, 5 * MIN); m5 = []; for (const c of agg) if (c.ts + 5 * MIN === close) ev.push({ t: close, k: 'candles', asset: a, tf: '5m', rows: [row(c)], ts: close, hist: 1 }); }
        last = bar;
        s.recent.push(bar);
      }
      if (s.recent.length > 5 * BACKFILL) s.recent.splice(0, s.recent.length - 5 * BACKFILL);
      if (spotBars.length) {
        for (const t of ['15m', '1h', '1d']) {
          const arr = s.tfs.get(t)!, ms = TFS.find((x) => x.tf === t)!.ms;
          for (let i = lowerBound(arr, d0 - ms); i < arr.length && arr[i].ts + ms <= d1; i++) {
            const close = arr[i].ts + ms;
            if (close > d0) ev.push({ t: close, k: 'candles', asset: a, tf: t, rows: [row(arr[i])], ts: close, hist: 1 });
          }
        }
      }
    }
    // BTC.D / USDT.D at every print slot, from every asset's print there.
    let domToday = 0;
    if (anchors.length && slotPx.size) {
      for (let i = 0; i < SLOTS; i++) {
        const px: Record<string, number> = {};
        for (const [a, arr] of slotPx) if (arr[i] > 0) px[a] = arr[i];
        const t = d0 + Math.floor(i / TICKS.length) * MIN + TICKS[i % TICKS.length];
        const r = dom.at(t, px);
        if (!r) continue;
        ev.push({ t, k: 'dominance', usdtd: r.usdtd === null ? null : +r.usdtd.toPrecision(8), btcd: +r.btcd.toPrecision(8), hist: 1 });
        domToday++;
      }
    }
    domCount += domToday;
    const alive = new Map<number, string[]>();
    for (const m of kms) {
      const kind = contractKind(m.series, m.strikeType);
      ev.push({ t: m.openTime - MIN, k: 'market', ticker: m.ticker, series: m.series, asset: m.asset, openTime: m.openTime, closeTime: m.closeTime, strike: m.strike, cap: m.cap, kind, event: m.event, tickSize: 0.01, hist: 1 });
      const cs = (m.candles ?? []).filter((c) => c.ts >= m.openTime && c.ts <= m.closeTime);
      for (let i = 0; i < cs.length; i++) {
        const c = cs[i];
        if (c.bidC !== null && c.askC !== null && c.askC > c.bidC) {
          ev.push({ t: c.ts, k: 'book', ticker: m.ticker, bids: [{ price: c.bidC, size: 100 }], asks: [{ price: c.askC, size: 100 }], ts: c.ts });
          // The minute's last quote stands until the next one (near the money, where a network would use it).
          const mid = (c.bidC + c.askC) / 2, until = Math.min(cs[i + 1]?.ts ?? m.closeTime, m.closeTime);
          if (mid >= 0.03 && mid <= 0.97) for (let at = c.ts + 15_000; at < until; at += 15_000) { const l = alive.get(at); if (l) l.push(m.ticker); else alive.set(at, [m.ticker]); }
        }
        if (c.volume && c.volume > 0 && c.last !== null) ev.push({ t: c.ts, k: 'trade', ticker: m.ticker, price: c.last, count: c.volume, ts: c.ts - 1 });
      }
      ev.push({ t: m.closeTime + 1000, k: 'result', ticker: m.ticker, result: m.result });
    }
    const tennisToday = tennisSeries.length ? tennisEvents(kalshiDir, tennisSeries, day, d0, d1, ev, alive) : 0;
    tennisCount += tennisToday;
    for (const [t, tickers] of alive) ev.push({ t, k: 'alive', tickers });
    ev.sort((x, y) => x.t - y.t);
    const cut = ev.findIndex((e) => e.t >= d1);
    if (cut >= 0) carry = ev.splice(cut);
    if (to - d0 < KEEP_STATES * DAY || iso(d1).endsWith('-01')) {
      const state: DayState = { carry, assets: Object.fromEntries([...st].map(([a, x]) => [a, { recent: x.recent, basis: x.basis, vPath: x.vPath, vMkt: x.vMkt, prints: x.prints, open: x.open }])), dom: dom.state };
      const sf: StateFile = { version: REPLAY_VERSION, sig: base, day, state };
      fs.writeFileSync(`${stateFileOf(day)}.tmp`, zlib.gzipSync(JSON.stringify(sf), { level: 6 }));
      fs.renameSync(`${stateFileOf(day)}.tmp`, stateFileOf(day));
    }
    if (!build) { skipped++; continue; }
    manifest.kalshi![day] = kms.length;
    manifest.tennis![day] = tennisToday;
    manifest.perps![day] = perpAssets;
    manifest.n![day] = ev.length;
    if (ev.length) {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, zlib.gzipSync(ev.map((e) => JSON.stringify(e)).join('\n') + '\n', { level: 6 }));
      fs.renameSync(tmp, file);
      written++;
      if (written % 30 === 1) log(`${day}: ${ev.length} records (${kms.length} Kalshi contracts${domToday ? `, dominance at ${domToday} prints` : ''})`);
    } else fs.rmSync(file, { force: true });
    manifest.days[day] = sigOf(day);
    saveManifest();
  }
  // Kept states: the last KEEP_STATES days and every month's last day.
  const keepFrom = iso(to - (KEEP_STATES - 1) * DAY);
  for (const f of fs.readdirSync(stateDir)) {
    const d = /^(\d{4}-\d{2}-\d{2})\.json\.gz$/.exec(f)?.[1];
    if (d && d < keepFrom && !iso(Date.parse(d) + DAY).endsWith('-01')) fs.rmSync(path.join(stateDir, f), { force: true });
  }
  log(`history replay: ${written} day(s) written, ${skipped} already built${resumedFrom ? ` (continued from the end of ${resumedFrom})` : ''}, ${assets.length} asset(s)${synthetic ? `, ${synthCount} synthetic contract(s)` : ''}${tennisSeries.length ? `, ${tennisCount} tennis match market(s)` : ''}${anchors.length ? `, dominance at ${domCount} prints` : ''}`);
  return { days, written, skipped, assets, notes, synthetic: synthCount, tennis: tennisCount, dominance: domCount, resumed: resumedFrom };
}

/** One print of an asset's synthetic contracts: settle the ones that closed (their 60 s average is
 *  complete with this print), list the new ones (a 15-minute Up/Down each quarter hour, the hourly
 *  ladder each hour, where Kalshi's history has none), then quote every open one. Returns how many
 *  contracts it listed. */
function synthTick(a: string, s: AssetState, t: number, iv: number, ev: Ev[], real15: Set<string>, realHour: Set<string>): number {
  let listed = 0;
  for (let i = s.open.length - 1; i >= 0; i--) {
    const c = s.open[i];
    if (t < c.closeTime) continue;
    s.open.splice(i, 1);
    const A = windowAverage(s.prints, c.closeTime);
    if (A) ev.push({ t: Math.max(c.closeTime + 1000, t + 1), k: 'result', ticker: c.ticker, result: A.avg >= c.strike ? 'yes' : 'no', synth: 1 });
  }
  const list = (c: SynthContract, series: string, event: string) => {
    s.open.push(c);
    ev.push({ t, k: 'market', ticker: c.ticker, series, asset: a, openTime: t, closeTime: c.closeTime, strike: c.strike, cap: null, kind: c.kind, event, tickSize: 0.01, synth: 1, hist: 1 });
    listed++;
  };
  if (t % (15 * MIN) === 0 && !real15.has(`${a}:${t}`)) {
    const K = windowAverage(s.prints, t);
    if (K) { const ticker = `KX${a}15M-SYN${stamp(t)}`; list({ ticker, strike: +K.avg.toPrecision(10), kind: 'updown', closeTime: t + 15 * MIN }, `KX${a}15M`, ticker); }
  }
  if (t % HOUR === 0 && !realHour.has(`${a}:${t + HOUR}`)) {
    const step = niceStep(LADDER_STEP * iv), base = Math.floor(iv / step), event = `KX${a}D-SYN${stamp(t + HOUR).slice(0, 8)}`;
    for (const off of LADDER) {
      const K = +((base + off) * step).toPrecision(10);
      if (K > 0) list({ ticker: `${event}-T${K}`, strike: K, kind: 'greater', closeTime: t + HOUR }, `KX${a}D`, event);
    }
  }
  const sigma = s.vMkt && s.vMkt > 0 ? Math.sqrt(s.vMkt) : undefined;
  if (!sigma) return listed;
  for (const c of s.open) {
    const tau = (c.closeTime - t) / 1000;
    const obs = tau <= SETTLEMENT_AVG_SEC ? windowAverage(s.prints, c.closeTime, t) : undefined;
    if (tau <= SETTLEMENT_AVG_SEC && !obs) continue;
    const fv = priceContract({ kind: c.kind, strike: c.strike }, { spot: iv, sigmaPerSqrtSec: sigma, tauSec: tau, observedAvg: obs?.avg, observedCount: obs?.n, nu: MARKET_NU });
    if (!fv) continue;
    const [bid, ask] = synthQuote(fv.pYes);
    ev.push({ t, k: 'book', ticker: c.ticker, bids: [{ price: bid, size: 100 }], asks: [{ price: ask, size: 100 }] });
  }
  return listed;
}

/** Kalshi's settled tennis match markets whose match starts on this day, as the live feed would show them:
 *  the market half an hour before, the real tape trade by trade with the book following it, the minute
 *  quotes, alive marks every 5 s (the quotes stand between trades), the result after the close. */
function tennisEvents(kalshiDir: string, series: string[], day: string, d0: number, d1: number, ev: Ev[], alive: Map<number, string[]>): number {
  const next = new Date(d0 + DAY).toISOString().slice(0, 10);
  let n = 0;
  for (const s of series) {
    const tapes = loadKalshiTrades(kalshiDir, s, [day, next]);
    for (const d of [day, next]) {
      const f = path.join(kalshiDir, s, `${d}.jsonl`);
      if (!fs.existsSync(f)) continue;
      for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
        let m: KalshiHistMarket;
        try { if (!l) continue; m = JSON.parse(l); } catch { continue; }
        if ((m.result !== 'yes' && m.result !== 'no') || !m.candles?.length) continue;
        const first = m.candles[0].ts;
        const begin = Math.max(m.openTime, (m.startTime && m.startTime < m.closeTime ? m.startTime : first) - 30 * MIN);
        if (begin < d0 || begin >= d1) continue;
        n++;
        ev.push({ t: Math.max(d0, begin - 1000), k: 'market', ticker: m.ticker, series: s, asset: 'TENNIS', openTime: m.openTime, closeTime: m.closeTime, strike: null, cap: null, kind: 'match', event: m.event, title: m.title, startTime: m.startTime, tickSize: 0.01, hist: 1 });
        // The candles' quotes and the tape, merged in time; the book follows each trade.
        type Step = { t: number; c?: KalshiHistMarket['candles'][number]; tr?: KalshiTrade };
        const steps: Step[] = [
          ...m.candles.filter((c) => c.ts >= begin && c.ts <= m.closeTime).map((c): Step => ({ t: c.ts, c })),
          ...(tapes.get(m.ticker) ?? []).filter((x) => x[0] >= begin && x[0] <= m.closeTime).map((x): Step => ({ t: x[0], tr: x })),
        ].sort((a, b) => a.t - b.t || (a.c ? 0 : 1) - (b.c ? 0 : 1));
        let spread = 0.02, booked = 0;
        const book = (t: number, bid: number, ask: number) => {
          const b = Math.round(bid * 100) / 100, a = Math.round(ask * 100) / 100;
          if (!(b >= 0.01 && a <= 0.99 && a > b)) return;
          ev.push({ t, k: 'book', ticker: m.ticker, bids: [{ price: b, size: 100 }], asks: [{ price: a, size: 100 }] });
          booked = booked || t;
        };
        for (const st of steps) {
          if (st.c) {
            const { bidC, askC } = st.c;
            if (bidC !== null && askC !== null && askC > bidC) { spread = Math.max(0.01, askC - bidC); book(st.t, bidC, askC); }
            continue;
          }
          const [t, price, count, side] = st.tr!;
          ev.push({ t, k: 'trade', ticker: m.ticker, price, count, takerSide: side ? 'yes' : 'no', ts: t });
          // A YES taker lifted the ask at this price, a NO taker hit the bid.
          if (side) book(t, Math.max(0.01, price - spread), price); else book(t, price, Math.min(0.99, price + spread));
        }
        if (booked) for (let at = Math.ceil(booked / 5000) * 5000; at < m.closeTime; at += 5000) { const x = alive.get(at); if (x) x.push(m.ticker); else alive.set(at, [m.ticker]); }
        ev.push({ t: m.closeTime + 1000, k: 'result', ticker: m.ticker, result: m.result });
      }
    }
  }
  return n;
}

function lowerBound(arr: Array<{ ts: number }>, ts: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].ts < ts) lo = m + 1; else hi = m; }
  return lo;
}

/** Complete bars of `ms` from consecutive 1-minute bars (an incomplete group is dropped). */
export function aggregate(bars: Candle[], ms: number): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | undefined, n = 0;
  const need = ms / MIN;
  for (const b of bars) {
    const start = Math.floor(b.ts / ms) * ms;
    if (!cur || cur.ts !== start) { if (cur && n === need) out.push(cur); cur = { ts: start, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, ...(b.tb !== undefined ? { tb: b.tb } : {}) }; n = 1; continue; }
    cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; if (b.tb !== undefined) cur.tb = (cur.tb ?? 0) + b.tb; n++;
  }
  if (cur && n === need) out.push(cur);
  return out;
}

if (process.argv[1] && /historyReplay\.(ts|cjs|js)$/.test(process.argv[1])) {
  const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
  const today = new Date().toISOString().slice(0, 10);
  void buildHistoryReplay({
    historyDir: arg('history', 'data/history'), outDir: arg('out', 'data/history-replay'), assets: arg('assets', 'BTC,ETH,SOL,XRP,DOGE').split(','),
    fromDay: arg('from', new Date(Date.now() - 365 * DAY).toISOString().slice(0, 10)), toDay: arg('to', new Date(Date.parse(today) - DAY).toISOString().slice(0, 10)),
    force: process.argv.includes('--force'), synthetic: !process.argv.includes('--no-synthetic'),
  });
}
