// Replays recorded market data (data/recordings/md-YYYY-MM-DD.jsonl) in time
// order and maintains the same IndexTracker / OrderBook state production uses.
// Research code never imports the OMS or the Kalshi order client.

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { recordingFiles, recordingLines } from '../bot/marketdata/recordingFiles';
import { IndexStore } from '../bot/marketdata/indexBars';
import { IndexTracker, type AvgMode } from '../bot/marketdata/indexTracker';
import { setTaNetContextSource } from '../bot/ta/taNet';
import { OrderBook } from '../bot/marketdata/orderBook';
import { FeatureHub } from '../bot/model/featureEngine';
import { contractKind, type ContractTerms, type MarketKind } from '../bot/model/fairValue';
import type { SnnConf, SnnContext } from '../bot/model/featureEngine';
import type { TennisScore } from '../bot/tennis/tennisModel';
import { hashStr, normals } from './history/historyReplay';

/** Settlement averaging in research, matching the bot's SETTLEMENT_AVG (default official). */
const AVG_MODE: AvgMode = process.env.SETTLEMENT_AVG === 'continuous' ? 'continuous' : 'official';
/** The history replay's prints (records marked `hist`) sit on a 15 s grid (research/history/historyReplay.ts). */
const HIST_GRID_MS = 15_000;
/** Longest gap between two such prints that is filled (a longer one stays a gap, as a stalled feed's would). */
const FILL_MAX_MS = 20_000;
/** A series being filled: its last value and time, its last print's time, the bridge's seed key, and the
 *  asset whose bars it also feeds (the settlement index). */
interface Fill { key: string; v: number; ts: number; print: number; bars?: string }

export interface RecMarket {
  ticker: string;
  series: string;
  asset: string;
  openTime: number;
  closeTime: number;
  strike?: number;
  cap?: number;
  kind: MarketKind;
  event?: string;
  tickSize: number;
  title?: string;
  startTime?: number;
  /** Recorded for research only (RECORD_SERIES): not priced or traded by the bot. */
  recordOnly?: boolean;
  /** Built from price history by research/history/historyReplay.ts where Kalshi lists no real contract:
   *  quoted at a no-skill fair value. The networks learn direction on it; anything that grades the bot's
   *  pricing against the market (strategy backtest, decision-model dataset) skips it. */
  synthetic?: boolean;
}

export interface RecEvent { t: number; k: string; [key: string]: any }

async function* lines(file: string): AsyncGenerator<RecEvent> {
  const rl = file.endsWith('.gz') ? recordingLines(file) : readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try { yield JSON.parse(line) as RecEvent; } catch { /* torn line */ }
  }
}

/** k-way merge by time; ties go to the first file, then the others in order. */
async function* mergeByTime(files: string[]): AsyncGenerator<RecEvent> {
  const its = files.map((x) => lines(x));
  const heads = await Promise.all(its.map((it) => it.next()));
  for (;;) {
    let best = -1;
    for (let i = 0; i < heads.length; i++) if (!heads[i].done && (best < 0 || (heads[i].value as RecEvent).t < (heads[best].value as RecEvent).t)) best = i;
    if (best < 0) break;
    yield heads[best].value as RecEvent;
    heads[best] = await its[best].next();
  }
}

/** Recordings in time order. `sidecar` (default: env SNN_BACKFILL_DIR) is one or more directories
 *  (path.delimiter-separated, one per SNN domain) of snnfill-YYYY-MM-DD.jsonl files; each day's
 *  sidecar events (prequential SNN outputs) are merged in by time.
 *  An event followed by another with the same timestamp carries `tie: true`: a replay applies a whole
 *  instant before acting on it (the history replay writes each instant's prices and books as one burst
 *  of same-time records; in live recordings exact ties are rare). */
export async function* readRecordings(dir: string, sidecar = process.env.SNN_BACKFILL_DIR, fromDay?: string, toDay?: string): AsyncGenerator<RecEvent> {
  const files = recordingFiles(dir).filter((f) => (!fromDay || f.day >= fromDay) && (!toDay || f.day <= toDay));
  const sides = (sidecar ?? '').split(path.delimiter).filter(Boolean);
  let prev: RecEvent | undefined;
  for (const f of files) {
    const extra = sides.map((d) => path.join(d, `snnfill-${f.day}.jsonl`)).filter((x) => fs.existsSync(x));
    for await (const e of extra.length ? mergeByTime([f.file, ...extra]) : lines(f.file)) {
      if (prev) { if (e.t === prev.t) prev.tie = true; yield prev; }
      prev = e;
    }
  }
  if (prev) yield prev;
}

/** The history store's index series (BTCDOM, BTC.D, USDT.D) for the TA network's context in replays:
 *  the same store and splice the live bot uses (lookups never pass the replayed bar's time). */
let replayIndex: IndexStore | undefined;
const replayIndexStore = () => (replayIndex ??= new IndexStore(path.resolve(process.env.HISTORY_DIR ?? path.join(process.env.DATA_DIR ?? './data', 'history'))));

export class ReplayState {
  constructor() {
    // The TA network reads every replayed coin's candles and the index series, exactly as live.
    setTaNetContextSource({ sets: () => this.features.candles, index: (asset, tf) => replayIndexStore().get(asset, tf) });
  }

  readonly markets = new Map<string, RecMarket>();
  readonly books = new Map<string, OrderBook>();
  readonly index = new Map<string, IndexTracker>();
  readonly results = new Map<string, 'yes' | 'no'>();
  readonly spot = new Map<string, IndexTracker>();
  readonly usdtd = new IndexTracker('USDT.D', 90 * 60_000, 300);
  readonly btcd = new IndexTracker('BTC.D', 90 * 60_000, 300);
  /** Same feature state machine production uses (MarketData.features). */
  readonly features = new FeatureHub();
  /** Logged SNN outputs (live 'snn' events, or a prequential backfill), keyed `${domain}:${column}`
   *  (domain = the isolated network that made the call: crypto / perps / tennis): direction calls
   *  with their confidence, and p_snn per contract, with their timestamps. */
  readonly snnDirs = new Map<string, { pUp: number; move: number; ts: number; conf: SnnConf }>();
  readonly snnContract = new Map<string, { p: number; ts: number; domain: string }>();
  /** Live tennis scores (Live Tennis API), latest per event. */
  readonly tennisScores = new Map<string, TennisScore & { ts: number; tiebreak?: boolean; breaksTotal?: [number, number] | null }>();
  now = 0;
  /** History replay: the seconds between a series' 15 s prints, filled as the live feed's one value a second
   *  fills them -- a Brownian bridge from print to print at the series' own volatility, the last print held
   *  until the next one is read -- so every window the live features read one value a second from (5 s gap
   *  limits, Kalshi's 60 one-second settlement marks, the dominance trackers' 10 s limit, per-second
   *  volatility and path shape) is filled as live data fills it. Only seconds before the record being
   *  applied are filled: nothing is known early. Live recordings (no `hist` mark) are left as recorded. */
  private readonly fill = new Map<IndexTracker, Fill>();

  /** Hold every filled series' last value through the second marks up to `t`. Off the print grid only: on
   *  it, the series' own print may still come in this instant, and the bridge needs those seconds. */
  private holdUntil(t: number): void {
    if (t % HIST_GRID_MS === 0) return;
    for (const [tr, f] of this.fill) {
      const end = Math.min(t, f.print + FILL_MAX_MS);
      for (let m = Math.floor(f.ts / 1000) * 1000 + 1000; m <= end; m += 1000) this.addFilled(tr, f, f.v, m);
    }
  }

  private addFilled(tr: IndexTracker, f: Fill, v: number, ts: number): void {
    tr.add(v, ts);
    if (f.bars) this.features.onIndex(f.bars, v, ts);
    f.ts = ts;
  }

  /** A history replay print: the seconds since the series' last value bridged toward it, then the print. */
  private histPrint(tr: IndexTracker, key: string, v: number, ts: number, bars?: string): void {
    const f = this.fill.get(tr);
    if (f && ts > f.ts && ts - f.ts <= FILL_MAX_MS && v > 0 && f.v > 0) {
      const first = Math.floor(f.ts / 1000) * 1000 + 1000, n = Math.ceil((ts - first) / 1000);
      if (n > 0) {
        const x1 = Math.log(v);
        let tc = f.ts, x = Math.log(f.v);
        const sig = tr.vol(0)?.sigmaPerSqrtSec ?? Math.abs(x1 - x) / Math.sqrt((ts - tc) / 1000);
        const z = normals(hashStr(key) ^ Math.floor(ts / 1000), n);
        for (let m = first, i = 0; m < ts; m += 1000, i++) {
          const dt = (m - tc) / 1000, span = (ts - tc) / 1000;
          x += ((x1 - x) * dt) / span + sig * Math.sqrt((dt * (span - dt)) / span) * z[i];
          tc = m;
          this.addFilled(tr, f, Math.exp(x), m);
        }
      }
    }
    tr.add(v, ts);
    this.fill.set(tr, { key, v, ts, print: ts, bars });
  }

  apply(e: RecEvent): void {
    this.now = e.t;
    if (this.fill.size) this.holdUntil(e.t);
    switch (e.k) {
      case 'market':
        this.markets.set(e.ticker, {
          ticker: e.ticker, series: e.series, asset: e.asset, openTime: e.openTime, closeTime: e.closeTime, strike: e.strike ?? undefined, cap: e.cap ?? undefined,
          kind: e.kind ?? contractKind(e.series ?? ''), event: e.event ?? undefined, tickSize: e.tickSize ?? 0.01,
          title: e.title ?? undefined, startTime: e.startTime ?? undefined, recordOnly: e.recordOnly ? true : undefined, synthetic: e.synth ? true : undefined,
        });
        break;
      case 'index': {
        let tr = this.index.get(e.asset);
        if (!tr) { tr = new IndexTracker(e.asset, undefined, undefined, AVG_MODE); this.index.set(e.asset, tr); }
        if (e.hist) this.histPrint(tr, e.asset, e.value, e.ts ?? e.t, e.asset);
        else tr.add(e.value, e.ts ?? e.t);
        this.features.onIndex(e.asset, e.value, e.ts ?? e.t);
        break;
      }
      case 'dominance':
        if (e.hist) {
          if (e.usdtd > 0) this.histPrint(this.usdtd, 'USDT.D', e.usdtd, e.ts ?? e.t);
          if (e.btcd > 0) this.histPrint(this.btcd, 'BTC.D', e.btcd, e.ts ?? e.t);
          break;
        }
        this.usdtd.add(e.usdtd, e.ts ?? e.t);
        this.btcd.add(e.btcd, e.ts ?? e.t);
        break;
      case 'spot': {
        let tr = this.spot.get(e.asset);
        if (!tr) { tr = new IndexTracker(e.asset); this.spot.set(e.asset, tr); }
        // The same bridge draws as the asset's index (one market, one path).
        if (e.hist) this.histPrint(tr, e.asset, e.value, e.ts ?? e.t);
        else tr.add(e.value, e.ts ?? e.t);
        break;
      }
      case 'book': {
        const b = this.book(e.ticker);
        b.applySnapshot({ bids: e.bids ?? [], asks: e.asks ?? [] }, e.t);
        this.features.onBook(e.ticker, b, e.t);
        break;
      }
      case 'delta': {
        const b = this.book(e.ticker);
        b.applyDelta(e.side, e.price, e.delta, e.t);
        this.features.onBook(e.ticker, b, e.t);
        break;
      }
      case 'trade':
        this.features.onTrade(e.ticker, e.count, e.takerSide, e.ts ?? e.t);
        break;
      case 'alive':
        // History replay: Kalshi's minute quotes still stand at the prints in between.
        for (const t of (e.tickers ?? []) as string[]) this.books.get(t)?.markAlive(e.t);
        break;
      case 'candles':
        this.features.onCandles(e.asset, e.tf, e.rows ?? [], e.ts ?? e.t);
        break;
      case 'perp':
        this.features.onPerp({ ...(e as any), ts: e.ts ?? e.t });
        break;
      case 'result':
        this.results.set(e.ticker, e.result);
        break;
      case 'snn': {
        type Row = [string, number, number, number?, (number | null)?, (number | null)?, (number | null)?, (number | null)?, (number | null)?];
        const num = (x: number | null | undefined) => (x === null || x === undefined ? undefined : x);
        for (const [key, pUp, move, labelled, skill, calConf, contractSkill, surpriseRatio, G] of (e.dirs ?? []) as Row[]) {
          const v = { pUp, move, ts: e.t, conf: { labelled, skill: num(skill), calConf: num(calConf), contractSkill: num(contractSkill), surpriseRatio: num(surpriseRatio), G: num(G) } };
          // Before the networks were split one SNN fed everyone: its 15m/1h calls go to crypto, 1h/4h to perps.
          const domains = e.d ? [e.d] : key.startsWith('TEN:') ? ['tennis'] : key.endsWith('-240m') ? ['perps'] : key.endsWith('-60m') ? ['crypto', 'perps'] : ['crypto'];
          for (const d of domains) this.snnDirs.set(`${d}:${key}`, v);
        }
        for (const [t, p] of Object.entries((e.c ?? {}) as Record<string, number>)) this.snnContract.set(t, { p, ts: e.t, domain: e.d ?? 'any' }); // legacy: one network scored every contract
        break;
      }
      case 'tennis_score':
        this.tennisScores.set(e.event, { setsA: e.setsA, setsB: e.setsB, gamesA: e.gamesA, gamesB: e.gamesB, pointsA: e.pointsA, pointsB: e.pointsB, serverA: e.serverA, tiebreak: e.tiebreak, breaksTotal: e.breaksTotal, ts: e.t });
        break;
      case 'lifecycle':
        if (e.result === 'yes' || e.result === 'no') this.results.set(e.ticker, e.result);
        break;
    }
  }

  /** SNN context for a decision model at `now`, same rule as the engine's snnContext: the consumer
   *  (crypto = MLP, perps = perps model) reads its own network; the other only when `crossFeed`
   *  (SNN_CROSS_FEED) is on. Calls older than 3 minutes are ignored. */
  snnContext(asset: string, ticker?: string, consumer: 'crypto' | 'perps' = 'crypto', maxAgeMs = 180_000, crossFeed = process.env.SNN_CROSS_FEED === 'true'): SnnContext | undefined {
    const up: SnnContext['up'] = {}, move: SnnContext['move'] = {}, conf: SnnContext['conf'] = {};
    let any = false;
    const other = consumer === 'crypto' ? 'perps' : 'crypto';
    for (const d of crossFeed ? [consumer, other] : [consumer]) {
      for (const h of [15, 60, 240] as const) {
        if (up[h] !== undefined) continue; // own network first
        const x = this.snnDirs.get(`${d}:${asset}-${h}m`);
        if (x && this.now - x.ts <= maxAgeMs) { up[h] = x.pUp; move[h] = x.move; conf[h] = x.conf; any = true; }
      }
    }
    const c = ticker ? this.snnContract.get(ticker) : undefined;
    const pContract = c && this.now - c.ts <= maxAgeMs && (c.domain === consumer || c.domain === 'any') ? c.p : undefined;
    return any || pContract !== undefined ? { up, move, conf, pContract } : undefined;
  }

  book(t: string): OrderBook {
    let b = this.books.get(t);
    if (!b) { b = new OrderBook(t); this.books.set(t, b); }
    return b;
  }

  strike(m: RecMarket): number | undefined {
    if (m.kind === 'match') return undefined;
    if (m.strike) return m.strike;
    if (m.kind !== 'updown') return undefined;
    const a = this.index.get(m.asset)?.settlement(m.openTime, m.openTime);
    if (a && a.n >= 60) m.strike = a.avg;
    return m.strike;
  }

  /** Pricing terms, mirroring MarketData.termsFor. */
  terms(m: RecMarket): ContractTerms | undefined {
    if (m.kind === 'match') return undefined;
    if (m.kind === 'updown') { const k = this.strike(m); return k ? { kind: 'updown', strike: k } : undefined; }
    if (m.kind === 'less') return m.cap ? { kind: 'less', cap: m.cap } : undefined;
    if (m.kind === 'between') return m.strike && m.cap ? { kind: 'between', strike: m.strike, cap: m.cap } : undefined;
    return m.strike ? { kind: 'greater', strike: m.strike } : undefined;
  }

  /** Official result if recorded, else computed from the recorded index. */
  outcome(m: RecMarket): { label: 0 | 1; source: 'official' | 'computed' } | undefined {
    const r = this.results.get(m.ticker);
    if (r) return { label: r === 'yes' ? 1 : 0, source: 'official' };
    const t = this.terms(m);
    const a = this.index.get(m.asset)?.settlement(m.closeTime, m.closeTime);
    if (!t || !a || a.n < 60) return undefined;
    const A = a.avg;
    const yes = t.kind === 'less' ? A < t.cap! : t.kind === 'between' ? A >= t.strike! && A < t.cap! : A >= t.strike!;
    return { label: yes ? 1 : 0, source: 'computed' };
  }
}
