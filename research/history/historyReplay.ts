// History replay: years of exchange history turned into recording files (md-YYYY-MM-DD.jsonl.gz) that
// research/replay.ts reads exactly like the bot's own live recordings. Every recording-based step (the
// perps model, the SNN tournaments, the whole-bot replay and sweep, the Kalshi dataset) can then "trade"
// years of history through the same code paths it uses on live data, without knowing the difference.
//
// From the candle store (research/history/*):
//   index / spot   1-minute Binance spot bars (source binance-1m) as four prints a minute: open, the first
//                  extreme, the second, close (at +0 / +15 / +30 / +45 s; low before high on an up bar).
//                  The index prints are scaled by the Binance -> Kalshi basis: each 15-minute contract's
//                  strike is Kalshi's own 60 s index average, so strike / Binance price at its open is a
//                  causal basis reading (it applies from that open on, forward-filled).
//   candles        the live candle feed's timeframes (1m, 5m, 15m, 1h, 1d): each day file starts with the
//                  last 300 closed bars of each, then every bar as it closes (so any day can start a replay)
//   perp           1-minute Binance USD-M perpetual bars (binance-um) as the same four prints, quoted at
//                  the spread and contract specs the bot's own perp recordings show (defaults otherwise),
//                  with Binance's last settled funding rate (binance-funding) and the next funding time
//   market / book / trade / result
//                  Kalshi's settled contracts (history/kalshi, 1-minute YES bid / ask candles): the market
//                  a minute before it opens, a book snapshot each minute (nominal 100 contracts a side), the
//                  minute's volume as one trade at its last price, the result one second after the close
//
// What it cannot reproduce: second-by-second paths inside a minute, order-book depth, the side of each
// trade. Fill simulation on replayed contracts is therefore coarse; the perps model and the networks'
// direction calls depend on prices, not on those.
//
//   npm run history:replay -- --history data/history --out data/history-replay --assets BTC,ETH --from 2024-01-01

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import zlib from 'zlib';
import { contractKind } from '../../bot/model/fairValue';
import { loadSeries } from './candles';
import type { Candle } from '../../bot/ta/indicators';

export const REPLAY_VERSION = 1;
const MIN = 60_000, DAY = 86_400_000;
const TFS: Array<{ tf: string; ms: number }> = [{ tf: '1m', ms: MIN }, { tf: '5m', ms: 5 * MIN }, { tf: '15m', ms: 15 * MIN }, { tf: '1h', ms: 60 * MIN }, { tf: '1d', ms: DAY }];
const BACKFILL = 300;

export interface PerpSpec { ticker?: string; contractSize?: number; tickSize?: number; fractional?: boolean; leverage?: number; halfSpreadBps?: number }
export interface ReplayOpts {
  historyDir: string;
  outDir: string;
  assets: string[];
  fromDay: string;
  toDay: string;
  /** Kalshi settled contracts (download: research/history/kalshiHistory.ts); default <historyDir>/kalshi. */
  kalshiDir?: string;
  perpSpecs?: Record<string, PerpSpec>;
  /** Rebuild days already written (default: skip them unless the format version changed). */
  force?: boolean;
  log?: (m: string) => void;
}

/** The four prints of a bar (open, first extreme, second extreme, close) and their offsets. */
export function barPath(b: { o: number; h: number; l: number; c: number }): Array<[number, number]> {
  const up = b.c >= b.o;
  return [[0, b.o], [15_000, up ? b.l : b.h], [30_000, up ? b.h : b.l], [45_000, b.c]];
}

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
}

function readFunding(file: string): Array<[number, number]> {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').slice(1).map((l) => l.split(',').map(Number) as [number, number]).filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v));
}

interface KMarket { ticker: string; series: string; event?: string; openTime: number; closeTime: number; strike: number | null; cap: number | null; strikeType?: string; result?: string; candles: Array<{ ts: number; bidC: number | null; askC: number | null; last: number | null; volume: number | null }> }

function kalshiMarkets(dir: string, day: string, assets: Set<string>): Array<KMarket & { asset: string }> {
  const out: Array<KMarket & { asset: string }> = [];
  if (!fs.existsSync(dir)) return out;
  for (const series of fs.readdirSync(dir)) {
    const asset = /^KX([A-Z]+?)(15M|D)?$/.exec(series)?.[1];
    if (!asset || !assets.has(asset)) continue;
    // A contract closing tomorrow may open today: read both days' files.
    for (const d of [day, new Date(Date.parse(day) + DAY).toISOString().slice(0, 10)]) {
      const f = path.join(dir, series, `${d}.jsonl`);
      if (!fs.existsSync(f)) continue;
      for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!l) continue;
        try { const m = JSON.parse(l) as KMarket; if (m.openTime >= Date.parse(day) && m.openTime < Date.parse(day) + DAY && (m.result === 'yes' || m.result === 'no')) out.push({ ...m, asset }); } catch { /* torn line */ }
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

export async function buildHistoryReplay(o: ReplayOpts): Promise<{ days: number; written: number; skipped: number; assets: string[]; notes: string[] }> {
  const log = o.log ?? ((m: string) => console.log(`[replay] ${m}`));
  fs.mkdirSync(o.outDir, { recursive: true });
  const manifestFile = path.join(o.outDir, 'replay-manifest.json');
  let manifest: { version?: number; days: Record<string, string> } = { days: {} };
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { /* first build */ }
  if (manifest.version !== REPLAY_VERSION) manifest = { version: REPLAY_VERSION, days: {} };
  const notes: string[] = [];
  const assets = o.assets.filter((a) => {
    const ok = fs.existsSync(path.join(o.historyDir, 'binance-1m', a, '1m.csv'));
    if (!ok) notes.push(`${a}: no 1-minute spot history (binance-1m), skipped`);
    return ok;
  });
  const kalshiDir = o.kalshiDir ?? path.join(o.historyDir, 'kalshi');
  const assetSet = new Set(assets);
  const from = Date.parse(o.fromDay), to = Date.parse(o.toDay);
  // Per asset: streams for 1m spot and perps, stored higher timeframes, funding.
  const st = new Map<string, { spot: CsvStream; perp: CsvStream; hasPerp: boolean; tfs: Map<string, Candle[]>; recent: Candle[]; funding: Array<[number, number]>; basis: number }>();
  for (const a of assets) {
    const tfs = new Map<string, Candle[]>();
    for (const t of ['15m', '1h', '1d'] as const) tfs.set(t, loadSeries(o.historyDir, a, t).candles);
    const perpFile = path.join(o.historyDir, 'binance-um', a, '1m.csv');
    st.set(a, { spot: new CsvStream(path.join(o.historyDir, 'binance-1m', a, '1m.csv')), perp: new CsvStream(perpFile), hasPerp: fs.existsSync(perpFile), tfs, recent: [], funding: readFunding(path.join(o.historyDir, 'binance-funding', a, 'funding.csv')), basis: 1 });
  }
  let written = 0, skipped = 0, days = 0;
  // Events of a contract that opened today but runs past midnight go into the next day's file (time order).
  let carry: Array<Record<string, unknown> & { t: number }> = [];
  for (let d0 = from; d0 <= to; d0 += DAY) {
    days++;
    const day = new Date(d0).toISOString().slice(0, 10);
    const file = path.join(o.outDir, `md-${day}.jsonl.gz`);
    const sig = `${REPLAY_VERSION}:${assets.join(',')}`;
    const d1 = d0 + DAY;
    // Keep the streams moving even for days already built (they are sequential).
    const bars = new Map<string, { spot: Candle[]; perp: Candle[] }>();
    for (const [a, s] of st) {
      const pre = await s.spot.until(d0);
      s.recent.push(...pre); if (s.recent.length > 5 * BACKFILL) s.recent.splice(0, s.recent.length - 5 * BACKFILL);
      await s.perp.until(d0);
      bars.set(a, { spot: await s.spot.until(d1), perp: await s.perp.until(d1) });
    }
    if (!o.force && manifest.days[day] === sig && fs.existsSync(file)) {
      skipped++;
      carry = [];
      for (const [a, s] of st) { s.recent.push(...bars.get(a)!.spot); if (s.recent.length > 5 * BACKFILL) s.recent.splice(0, s.recent.length - 5 * BACKFILL); }
      continue;
    }
    const ev: Array<Record<string, unknown> & { t: number }> = carry;
    carry = [];
    const kms = kalshiMarkets(kalshiDir, day, assetSet);
    for (const [a, s] of st) {
      const b = bars.get(a)!;
      if (!b.spot.length) continue;
      // Backfill: the last 300 closed bars of every timeframe before the day starts.
      const r5 = aggregate(s.recent, 5 * MIN);
      const back: Record<string, Candle[]> = { '1m': s.recent.slice(-BACKFILL), '5m': r5.slice(-BACKFILL) };
      for (const t of ['15m', '1h', '1d']) {
        const arr = s.tfs.get(t)!, ms = TFS.find((x) => x.tf === t)!.ms;
        const hi = lowerBound(arr, d0 - ms + 1); // bars that closed by d0
        back[t] = arr.slice(Math.max(0, hi - BACKFILL), hi);
      }
      for (const [tf, cs] of Object.entries(back)) if (cs.length) ev.push({ t: d0, k: 'candles', asset: a, tf, rows: cs.map(row), ts: d0, hist: 1 });
      // Kalshi strikes of this asset's 15-minute contracts opening today: the basis readings.
      const opens = kms.filter((m) => m.asset === a && /15M$/.test(m.series) && m.strike).map((m) => ({ t: m.openTime, k: m.strike! })).sort((x, y) => x.t - y.t);
      let oi = 0, last: Candle | undefined = s.recent[s.recent.length - 1];
      const fund = s.funding;
      let fi = 0;
      const spec = o.perpSpecs?.[a] ?? {};
      const half = (spec.halfSpreadBps ?? 1) / 1e4;
      const perpBy = new Map(b.perp.map((c) => [c.ts, c]));
      let m5: Candle[] = [];
      for (const bar of b.spot) {
        while (oi < opens.length && opens[oi].t <= bar.ts) {
          if (last) { const ratio = opens[oi].k / last.c; if (Math.abs(ratio - 1) < 0.005) s.basis = ratio; }
          oi++;
        }
        for (const [off, v] of barPath(bar)) {
          const t = bar.ts + off;
          ev.push({ t, k: 'index', asset: a, value: +(v * s.basis).toPrecision(10), ts: t, src: 'kalshi', hist: 1 });
          ev.push({ t, k: 'spot', asset: a, value: v, ts: t });
        }
        const p = perpBy.get(bar.ts);
        if (p) {
          while (fi < fund.length && fund[fi][0] <= bar.ts) fi++;
          const rate = fi > 0 ? fund[fi - 1][1] : undefined;
          const next = Math.ceil((bar.ts + 1) / (8 * 3_600_000)) * 8 * 3_600_000;
          for (const [off, v] of barPath(p)) {
            const t = bar.ts + off;
            ev.push({ t, k: 'perp', ticker: spec.ticker ?? `${a}-PERP`, asset: a, ts: t, bid: roundTo(v * (1 - half), spec.tickSize, -1), ask: roundTo(v * (1 + half), spec.tickSize, 1), last: v, mark: v,
              fundingRate: rate, nextFundingTs: next, contractSize: spec.contractSize ?? 0.001, tickSize: spec.tickSize, fractional: spec.fractional ?? true, leverage: spec.leverage ?? 10, hist: 1 });
          }
        }
        // Closed bars as the live candle feed would deliver them.
        const close = bar.ts + MIN;
        ev.push({ t: close, k: 'candles', asset: a, tf: '1m', rows: [row(bar)], ts: close, hist: 1 });
        m5.push(bar);
        if (close % (5 * MIN) === 0) { const agg = aggregate(m5, 5 * MIN); m5 = []; for (const c of agg) if (c.ts + 5 * MIN === close) ev.push({ t: close, k: 'candles', asset: a, tf: '5m', rows: [row(c)], ts: close, hist: 1 }); }
        last = bar;
        s.recent.push(bar);
      }
      if (s.recent.length > 5 * BACKFILL) s.recent.splice(0, s.recent.length - 5 * BACKFILL);
      for (const t of ['15m', '1h', '1d']) {
        const arr = s.tfs.get(t)!, ms = TFS.find((x) => x.tf === t)!.ms;
        for (let i = lowerBound(arr, d0 - ms); i < arr.length && arr[i].ts + ms <= d1; i++) {
          const close = arr[i].ts + ms;
          if (close > d0) ev.push({ t: close, k: 'candles', asset: a, tf: t, rows: [row(arr[i])], ts: close, hist: 1 });
        }
      }
    }
    for (const m of kms) {
      const kind = contractKind(m.series, m.strikeType);
      ev.push({ t: m.openTime - MIN, k: 'market', ticker: m.ticker, series: m.series, asset: m.asset, openTime: m.openTime, closeTime: m.closeTime, strike: m.strike, cap: m.cap, kind, event: m.event, tickSize: 0.01, hist: 1 });
      for (const c of m.candles ?? []) {
        if (c.ts < m.openTime || c.ts > m.closeTime) continue;
        if (c.bidC !== null && c.askC !== null && c.askC > c.bidC) ev.push({ t: c.ts, k: 'book', ticker: m.ticker, bids: [{ price: c.bidC, size: 100 }], asks: [{ price: c.askC, size: 100 }], ts: c.ts });
        if (c.volume && c.volume > 0 && c.last !== null) ev.push({ t: c.ts, k: 'trade', ticker: m.ticker, price: c.last, count: c.volume, ts: c.ts - 1 });
      }
      ev.push({ t: m.closeTime + 1000, k: 'result', ticker: m.ticker, result: m.result });
    }
    ev.sort((x, y) => x.t - y.t);
    const cut = ev.findIndex((e) => e.t >= d1);
    if (cut >= 0) carry = ev.splice(cut);
    if (!ev.length) continue;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, zlib.gzipSync(ev.map((e) => JSON.stringify(e)).join('\n') + '\n', { level: 6 }));
    fs.renameSync(tmp, file);
    manifest.days[day] = sig;
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    written++;
    if (written % 30 === 1) log(`${day}: ${ev.length} records (${kms.length} Kalshi contracts)`);
  }
  log(`history replay: ${written} day(s) written, ${skipped} already built, ${assets.length} asset(s)`);
  return { days, written, skipped, assets, notes };
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
    fromDay: arg('from', new Date(Date.now() - 365 * DAY).toISOString().slice(0, 10)), toDay: arg('to', new Date(Date.parse(today) - DAY).toISOString().slice(0, 10)), force: process.argv.includes('--force'),
  });
}
