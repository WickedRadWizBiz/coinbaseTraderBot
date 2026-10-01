// Replays recorded market data (data/recordings/md-YYYY-MM-DD.jsonl) in time
// order and maintains the same IndexTracker / OrderBook state production uses.
// Research code never imports the OMS or the Kalshi order client.

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { IndexTracker, type AvgMode } from '../bot/marketdata/indexTracker';
import { OrderBook } from '../bot/marketdata/orderBook';
import { FeatureHub } from '../bot/model/featureEngine';
import { contractKind, type ContractTerms, type MarketKind } from '../bot/model/fairValue';
import type { SnnContext } from '../bot/model/featureEngine';
import type { TennisScore } from '../bot/tennis/tennisModel';

/** Settlement averaging in research, matching the bot's SETTLEMENT_AVG (default official). */
const AVG_MODE: AvgMode = process.env.SETTLEMENT_AVG === 'continuous' ? 'continuous' : 'official';

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
}

export interface RecEvent { t: number; k: string; [key: string]: any }

async function* lines(file: string): AsyncGenerator<RecEvent> {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try { yield JSON.parse(line) as RecEvent; } catch { /* torn line */ }
  }
}

/** Recordings in time order. When `sidecar` (default: env SNN_BACKFILL_DIR) holds a
 *  snnfill-YYYY-MM-DD.jsonl for a day, its events (prequential SNN outputs) are merged in by time. */
export async function* readRecordings(dir: string, sidecar = process.env.SNN_BACKFILL_DIR, fromDay?: string, toDay?: string): AsyncGenerator<RecEvent> {
  const files = fs.readdirSync(dir).filter((f) => /^md-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()
    .filter((f) => (!fromDay || f.slice(3, 13) >= fromDay) && (!toDay || f.slice(3, 13) <= toDay));
  for (const f of files) {
    const side = sidecar ? path.join(sidecar, f.replace(/^md-/, 'snnfill-')) : undefined;
    if (!side || !fs.existsSync(side)) { yield* lines(path.join(dir, f)); continue; }
    const a = lines(path.join(dir, f)), b = lines(side);
    let x = await a.next(), y = await b.next();
    while (!x.done || !y.done) {
      if (y.done || (!x.done && x.value.t <= y.value.t)) { yield x.value as RecEvent; x = await a.next(); }
      else { yield y.value as RecEvent; y = await b.next(); }
    }
  }
}

export class ReplayState {
  readonly markets = new Map<string, RecMarket>();
  readonly books = new Map<string, OrderBook>();
  readonly index = new Map<string, IndexTracker>();
  readonly results = new Map<string, 'yes' | 'no'>();
  readonly spot = new Map<string, IndexTracker>();
  readonly usdtd = new IndexTracker('USDT.D', 90 * 60_000, 300);
  readonly btcd = new IndexTracker('BTC.D', 90 * 60_000, 300);
  /** Same feature state machine production uses (MarketData.features). */
  readonly features = new FeatureHub();
  /** Logged SNN outputs (live 'snn' events, or a prequential backfill): direction calls per column
   *  key and p_snn per contract, with their timestamps. */
  readonly snnDirs = new Map<string, { pUp: number; move: number; ts: number }>();
  readonly snnContract = new Map<string, { p: number; ts: number }>();
  /** Live tennis scores (Live Tennis API), latest per event. */
  readonly tennisScores = new Map<string, TennisScore & { ts: number; tiebreak?: boolean; breaksTotal?: [number, number] | null }>();
  now = 0;

  apply(e: RecEvent): void {
    this.now = e.t;
    switch (e.k) {
      case 'market':
        this.markets.set(e.ticker, {
          ticker: e.ticker, series: e.series, asset: e.asset, openTime: e.openTime, closeTime: e.closeTime, strike: e.strike ?? undefined, cap: e.cap ?? undefined,
          kind: e.kind ?? contractKind(e.series ?? ''), event: e.event ?? undefined, tickSize: e.tickSize ?? 0.01,
          title: e.title ?? undefined, startTime: e.startTime ?? undefined, recordOnly: e.recordOnly ? true : undefined,
        });
        break;
      case 'index': {
        let tr = this.index.get(e.asset);
        if (!tr) { tr = new IndexTracker(e.asset, undefined, undefined, AVG_MODE); this.index.set(e.asset, tr); }
        tr.add(e.value, e.ts ?? e.t);
        this.features.onIndex(e.asset, e.value, e.ts ?? e.t);
        break;
      }
      case 'dominance':
        this.usdtd.add(e.usdtd, e.ts ?? e.t);
        this.btcd.add(e.btcd, e.ts ?? e.t);
        break;
      case 'spot': {
        let tr = this.spot.get(e.asset);
        if (!tr) { tr = new IndexTracker(e.asset); this.spot.set(e.asset, tr); }
        tr.add(e.value, e.ts ?? e.t);
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
      case 'candles':
        this.features.onCandles(e.asset, e.tf, e.rows ?? [], e.ts ?? e.t);
        break;
      case 'perp':
        this.features.onPerp({ ...(e as any), ts: e.ts ?? e.t });
        break;
      case 'result':
        this.results.set(e.ticker, e.result);
        break;
      case 'snn':
        for (const [key, pUp, move] of (e.dirs ?? []) as [string, number, number][]) this.snnDirs.set(key, { pUp, move, ts: e.t });
        for (const [t, p] of Object.entries((e.c ?? {}) as Record<string, number>)) this.snnContract.set(t, { p, ts: e.t });
        break;
      case 'tennis_score':
        this.tennisScores.set(e.event, { setsA: e.setsA, setsB: e.setsB, gamesA: e.gamesA, gamesB: e.gamesB, pointsA: e.pointsA, pointsB: e.pointsB, serverA: e.serverA, tiebreak: e.tiebreak, breaksTotal: e.breaksTotal, ts: e.t });
        break;
      case 'lifecycle':
        if (e.result === 'yes' || e.result === 'no') this.results.set(e.ticker, e.result);
        break;
    }
  }

  /** SNN context for the MLP/perp features at `now` (calls older than 3 minutes are ignored). */
  snnContext(asset: string, ticker?: string, maxAgeMs = 180_000): SnnContext | undefined {
    const up: SnnContext['up'] = {}, move: SnnContext['move'] = {};
    let any = false;
    for (const h of [15, 60, 240] as const) {
      const d = this.snnDirs.get(`${asset}-${h}m`);
      if (d && this.now - d.ts <= maxAgeMs) { up[h] = d.pUp; move[h] = d.move; any = true; }
    }
    const c = ticker ? this.snnContract.get(ticker) : undefined;
    const pContract = c && this.now - c.ts <= maxAgeMs ? c.p : undefined;
    return any || pContract !== undefined ? { up, move, pContract } : undefined;
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
