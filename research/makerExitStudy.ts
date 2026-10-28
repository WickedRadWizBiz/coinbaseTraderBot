// Maker exit study (the owner's choice on Oct 28: measure before building a new exit). Would a resting post-only sell,
// placed the moment a position opened, have paid better than the exits paper actually took?
//
// Every crypto position paper opened on --days (the audit log's fills, split into lots: each opening fill is a lot, and
// later reductions close lots first in, first out) is replayed against the real Kalshi tape of its market (the bot's
// own recordings: books, deltas, trades, results). For each target rule a post-only sell for the lot rests from its
// entry until the market closes, at:
//   tp+4c / tp+8c / tp+12c   the entry price plus that much
//   wall                      one tick in front of the nearest ask wall for our side above the entry (a level with at
//                             least twice the lot and twice the side's median level size): buyers lifting the book reach
//                             us before the stack of sellers behind
//   sr                        what the contract is worth (the settlement-exact pricer, at the index's own volatility and
//                             the time left at entry) if spot reaches the next spot level in our direction: a swing high
//                             or low of the last 4 hours of 1-minute index bars, or the hour's high or low
//   sr+wall                   the lower of the two
// Every target is at least 2c over the entry and one tick over our side's best bid (a post-only order never crosses).
//
// A resting sell fills two ways, both counted:
//   through   a trade printed at a better price than ours for a buyer of our side (it would have hit us first)
//   queue     also trades at our price once the size resting there when we joined has traded, and a bid for our
//             side at or above our price (it would have matched us)
// Each rule is scored two ways per lot, against what paper actually made and what holding to settlement made:
//   +paper    the resting sell on top of the exits paper took (whichever came first sells; the rest settles)
//   or hold   the resting sell alone; what it does not sell settles
// Fees: the entry's and paper's exits' as logged; the resting sells at the maker rate times --maker-mult (0: the
// standard fee-free maker; 1: a maker-fee series), each line printed both ways.
//
//   npm run research:maker-exit-study -- --recordings data/recordings --audit data/audit --days 2026-10-26,2026-10-27 \
//       [--out data/sweeps/maker-exit-study.json]
//
// Read-only: writes only --out. Tennis is left out.

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import zlib from 'zlib';
import { makerFee } from '../bot/fees';
import { IndexTracker } from '../bot/marketdata/indexTracker';
import { OrderBook } from '../bot/marketdata/orderBook';
import { contractKind, priceContract, type ContractTerms, type MarketKind } from '../bot/model/fairValue';
import type { Candle } from '../bot/ta/indicators';
import { swings } from '../bot/ta/structure';
import { ceilToTick, floorToTick, round } from '../bot/util/num';
import { readRecordings, type RecEvent } from './replay';

const isTennis = (t: string) => t.startsWith('KXATP') || t.startsWith('KXWTA');
const EPS = 1e-9;
/** A target must bank at least this much a contract over the entry price. */
export const MIN_PROFIT = 0.02;

export interface AuditFill { t: number; ticker: string; side: 'bid' | 'ask'; price: number; count: number; fee: number; purpose: string }

/** A lot's exit by paper: when, how many, at what price for the held side, and that part of the fill's fee. */
export interface PaperExit { t: number; qty: number; px: number; fee: number }

export interface Lot {
  ticker: string; t: number;
  /** +1 long YES, -1 long NO. */
  sign: 1 | -1;
  n: number;
  /** Entry price of the held side, and the entry's fee for the lot. */
  entry: number; entryFee: number;
  purpose: string;
  exits: PaperExit[];
}

/** Paper's crypto fills on `days`, with the purpose of the order each filled (order_new records). */
export async function readFills(auditDir: string, days: string[]): Promise<AuditFill[]> {
  const want = new Set(days);
  const files = fs.existsSync(auditDir) ? fs.readdirSync(auditDir).filter((f) => /^audit-\d{4}-\d{2}-\d{2}.*\.jsonl(\.gz)?$/.test(f) && want.has(f.slice(6, 16))).sort() : [];
  const purpose = new Map<string, string>();
  const out: AuditFill[] = [];
  for (const f of files) {
    const raw = fs.createReadStream(path.join(auditDir, f));
    const rl = readline.createInterface({ input: f.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw, crlfDelay: Infinity });
    for await (const line of rl) {
      const head = line.slice(0, 160);
      const fill = head.includes('"kind":"fill"');
      if (!fill && !head.includes('"kind":"order_new"')) continue;
      let r: { ts?: string; data?: Record<string, any> };
      try { r = JSON.parse(line); } catch { continue; }
      const d = r.data ?? {};
      if (!fill) { if (d.clientOrderId) purpose.set(String(d.clientOrderId), String(d.purpose ?? 'other')); continue; }
      const fl = d.fill ?? {};
      const ticker = String(fl.ticker ?? '');
      const t = Date.parse(r.ts ?? '');
      if (!ticker || isTennis(ticker) || !Number.isFinite(t) || !want.has(String(r.ts).slice(0, 10))) continue;
      if (fl.side !== 'bid' && fl.side !== 'ask') continue;
      const count = Number(fl.count), price = Number(fl.price);
      if (!(count > 0) || !(price > 0 && price < 1)) continue;
      const coid = d.clientOrderId ?? fl.clientOrderId;
      out.push({ t, ticker, side: fl.side, price, count, fee: Number(d.fee) || 0, purpose: (coid && purpose.get(String(coid))) || 'other' });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Fills into lots: a fill that adds to (or opens) a position is a lot; one that reduces it closes lots first in, first
 *  out (its fee shared by contracts); one that crosses through flat closes them all and opens a lot the other way. */
export function buildLots(fills: AuditFill[]): Lot[] {
  const lots: Lot[] = [];
  const open = new Map<string, Lot[]>();
  const rem = new Map<Lot, number>();
  for (const f of fills) {
    const q = open.get(f.ticker) ?? [];
    open.set(f.ticker, q);
    const sign: 1 | -1 = f.side === 'bid' ? 1 : -1;
    let left = f.count;
    const feePer = f.fee / f.count;
    while (left > EPS && q.length && q[0].sign !== sign) {
      const lot = q[0];
      const take = Math.min(left, rem.get(lot)!);
      // Selling the held side: a YES ask at p is p for long YES; a YES bid at p closes long NO at 1 - p.
      lot.exits.push({ t: f.t, qty: round(take, 2), px: lot.sign > 0 ? f.price : round(1 - f.price, 4), fee: feePer * take });
      rem.set(lot, rem.get(lot)! - take);
      left -= take;
      if (rem.get(lot)! <= EPS) q.shift();
    }
    if (left > EPS) {
      const lot: Lot = { ticker: f.ticker, t: f.t, sign, n: round(left, 2), entry: sign > 0 ? f.price : round(1 - f.price, 4), entryFee: feePer * left, purpose: f.purpose, exits: [] };
      lots.push(lot);
      q.push(lot);
      rem.set(lot, left);
    }
  }
  return lots;
}

/** Our side's view of a book: its best bid (where a taker exit sells) and the levels a resting sell joins, nearest first. */
export function sideView(book: OrderBook, sign: 1 | -1, depth = 100): { bestBid?: number; sell: Array<{ price: number; size: number }> } {
  const s = book.snapshot(depth);
  if (sign > 0) return { bestBid: s.bids[0]?.price, sell: s.asks.map((l) => ({ price: l.price, size: l.size })) };
  return { bestBid: s.asks[0] ? round(1 - s.asks[0].price, 4) : undefined, sell: s.bids.map((l) => ({ price: round(1 - l.price, 4), size: l.size })) };
}

/** One tick in front of the nearest wall for our side above `from` (side terms). */
export function wallTarget(sell: Array<{ price: number; size: number }>, lotSize: number, from: number, tick: number): number | undefined {
  const sizes = sell.map((l) => l.size).sort((a, b) => a - b);
  const median = sizes.length ? sizes[(sizes.length - 1) >> 1] : 0;
  const need = Math.max(2 * lotSize, 2 * median);
  const wall = sell.find((l) => l.price - tick >= from - EPS && l.size + EPS >= need);
  return wall ? round(wall.price - tick, 4) : undefined;
}

/** The next spot level in the direction that pays our side: swing highs (lows) of the bars and the last hour's high
 *  (low), the nearest one past spot. `up`: the side gains as spot rises. */
export function nextLevel(bars: Candle[], spot: number, up: boolean): number | undefined {
  if (bars.length < 10) return undefined;
  const sw = swings(bars, 3, 3);
  const hour = bars.slice(-60);
  const cands = up
    ? [...sw.filter((s) => s.kind === 'high').map((s) => s.price), Math.max(...hour.map((b) => b.h))].filter((x) => x > spot * (1 + 1e-5))
    : [...sw.filter((s) => s.kind === 'low').map((s) => s.price), Math.min(...hour.map((b) => b.l))].filter((x) => x < spot * (1 - 1e-5));
  if (!cands.length) return undefined;
  return up ? Math.min(...cands) : Math.max(...cands);
}

/** A resting post-only sell of a lot at `price` (side terms), filled from the tape in both modes. */
export class RestingSell {
  through = 0;
  queue = 0;
  readonly throughFills: Array<{ t: number; qty: number }> = [];
  readonly queueFills: Array<{ t: number; qty: number }> = [];
  private ahead: number;
  /** Bid size for our side at or above our price already counted (a resting bid matches us once). */
  private crossed = 0;

  constructor(readonly sign: 1 | -1, readonly n: number, readonly price: number, sizeAhead: number) {
    this.ahead = Math.max(0, sizeAhead);
  }

  private add(mode: 'through' | 'queue', t: number, qty: number): void {
    const room = this.n - this[mode];
    const q = Math.min(room, qty);
    if (q <= EPS) return;
    this[mode] = round(this[mode] + q, 2);
    (mode === 'through' ? this.throughFills : this.queueFills).push({ t, qty: round(q, 2) });
  }

  /** A trade on the market: YES price, contracts, the taker's side. */
  onTrade(t: number, yesPrice: number, count: number, takerSide: string | undefined): void {
    // Our sell is lifted by a buyer of our side: a YES taker for long YES, a NO taker for long NO.
    if (takerSide !== (this.sign > 0 ? 'yes' : 'no')) return;
    const px = this.sign > 0 ? yesPrice : round(1 - yesPrice, 4);
    if (px > this.price + EPS) { this.add('through', t, count); this.add('queue', t, count); return; }
    if (Math.abs(px - this.price) <= EPS) {
      const eat = Math.min(this.ahead, count);
      this.ahead -= eat;
      if (count - eat > EPS) this.add('queue', t, count - eat);
    }
  }

  /** The book after a change: a bid for our side at or above our price would have matched us (queue mode). */
  onBook(t: number, bidSizeAtOrAbove: number): void {
    if (bidSizeAtOrAbove > this.crossed + EPS) this.add('queue', t, bidSizeAtOrAbove - this.crossed);
    this.crossed = Math.max(this.crossed, bidSizeAtOrAbove);
  }
}

/** A lot's dollars: the resting sell's fills (in time order) merged with paper's own exits, or alone; the rest settles. */
export function lotPnl(lot: Lot, payout: 0 | 1, fills: Array<{ t: number; qty: number }>, price: number, makerMult: number, withPaper: boolean): number {
  type Ev = { t: number; qty: number; px: number; fee: number | 'maker'; order: number };
  const evs: Ev[] = fills.map((f) => ({ t: f.t, qty: f.qty, px: price, fee: 'maker' as const, order: 1 }));
  if (withPaper) for (const x of lot.exits) evs.push({ t: x.t, qty: x.qty, px: x.px, fee: x.fee / x.qty, order: 0 });
  evs.sort((a, b) => a.t - b.t || a.order - b.order);
  let left = lot.n, cash = -(lot.n * lot.entry + lot.entryFee);
  for (const e of evs) {
    const q = Math.min(left, e.qty);
    if (q <= EPS) continue;
    const fee = e.fee === 'maker' ? makerFee(q, e.px, { takerMultiplier: 1, makerMultiplier: makerMult }) : e.fee * q;
    cash += q * e.px - fee;
    left -= q;
  }
  return cash + left * payout;
}

export const RULES = ['tp+4c', 'tp+8c', 'tp+12c', 'wall', 'sr', 'sr+wall'] as const;
export type Rule = (typeof RULES)[number];

export interface RuleTally {
  lots: number; withTarget: number; contracts: number; targetContracts: number;
  filledThrough: number; filledQueue: number; minutesToFill: number[];
  /** Dollars over the lots: [mode][variant][maker multiplier 0 | 1]. */
  usd: Record<'through' | 'queue', Record<'paper' | 'hold', [number, number]>>;
}

export interface StudyResult {
  days: string[]; lots: number; skipped: Record<string, number>; contracts: number;
  actualUsd: number; holdUsd: number;
  /** Lots paper exited (any part) before settlement, and their contracts. */
  paperExited: { lots: number; contracts: number };
  byRule: Record<Rule, RuleTally>;
  bySeries: Record<string, { lots: number; actualUsd: number; holdUsd: number }>;
}

const emptyTally = (): RuleTally => ({ lots: 0, withTarget: 0, contracts: 0, targetContracts: 0, filledThrough: 0, filledQueue: 0, minutesToFill: [],
  usd: { through: { paper: [0, 0], hold: [0, 0] }, queue: { paper: [0, 0], hold: [0, 0] } } });

interface Mkt { ticker: string; series: string; asset: string; openTime: number; closeTime: number; strike?: number; cap?: number; kind: MarketKind; tick: number }

/** Does our side gain as spot rises? Undefined for kinds the S/R rule doesn't price (range brackets). */
const gainsUp = (kind: MarketKind, sign: 1 | -1): boolean | undefined => (kind === 'updown' || kind === 'greater' ? sign > 0 : kind === 'less' ? sign < 0 : undefined);

export async function runStudy(o: { recordings: string; audit: string; days: string[]; log?: (m: string) => void }): Promise<StudyResult> {
  const log = o.log ?? (() => {});
  const fills = await readFills(o.audit, o.days);
  const lots = buildLots(fills);
  log(`${fills.length} crypto fills on ${o.days.join(',')}: ${lots.length} lots in ${new Set(lots.map((l) => l.ticker)).size} markets`);
  const tickers = new Set(lots.map((l) => l.ticker));
  const TICKER = /"ticker":"([^"]+)"/;
  // Only the lots' markets' books and trades are parsed (most of a recorded day is other markets' books).
  const keep = (kind: string, line: string) => {
    if (kind === 'book' || kind === 'delta' || kind === 'trade') { const m = TICKER.exec(line.slice(0, 200)); return Boolean(m && tickers.has(m[1])); }
    return kind === 'market' || kind === 'index' || kind === 'result' || kind === 'lifecycle';
  };
  const days = [...o.days].sort();
  const markets = new Map<string, Mkt>();
  const books = new Map<string, OrderBook>();
  const index = new Map<string, IndexTracker>();
  const bars = new Map<string, Candle[]>();
  const results = new Map<string, 'yes' | 'no'>();
  const pending = [...lots];
  let next = 0;
  type Active = { lot: Lot; m: Mkt; sells: Partial<Record<Rule, RestingSell>> };
  const active = new Map<string, Active[]>();
  const done: Array<{ a: Active; payout: 0 | 1 }> = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };

  const strikeOf = (m: Mkt): number | undefined => {
    if (m.strike) return m.strike;
    if (m.kind !== 'updown') return undefined;
    const a = index.get(m.asset)?.settlement(m.openTime, m.openTime);
    if (a && a.n >= 60) m.strike = a.avg;
    return m.strike;
  };
  const termsOf = (m: Mkt): ContractTerms | undefined => {
    if (m.kind === 'updown') { const k = strikeOf(m); return k ? { kind: 'updown', strike: k } : undefined; }
    if (m.kind === 'less') return m.cap ? { kind: 'less', cap: m.cap } : undefined;
    if (m.kind === 'between') return m.strike && m.cap ? { kind: 'between', strike: m.strike, cap: m.cap } : undefined;
    return m.strike ? { kind: 'greater', strike: m.strike } : undefined;
  };
  const outcome = (m: Mkt): 0 | 1 | undefined => {
    const r = results.get(m.ticker);
    if (r) return r === 'yes' ? 1 : 0;
    const t = termsOf(m);
    const a = index.get(m.asset)?.settlement(m.closeTime, m.closeTime);
    if (!t || !a || a.n < 60) return undefined;
    const yes = t.kind === 'less' ? a.avg < t.cap! : t.kind === 'between' ? a.avg >= t.strike! && a.avg < t.cap! : a.avg >= t.strike!;
    return yes ? 1 : 0;
  };

  const activate = (lot: Lot, now: number) => {
    const m = markets.get(lot.ticker);
    const book = books.get(lot.ticker);
    if (!m) return skip('market not recorded');
    if (!book || !book.bestBid() && !book.bestAsk()) return skip('no book at entry');
    const tick = m.tick;
    const v = sideView(book, lot.sign);
    const floor = Math.max(lot.entry + MIN_PROFIT, (v.bestBid ?? 0) + tick);
    const clamp = (x: number | undefined) => (x === undefined ? undefined : Math.min(0.99, Math.max(ceilToTick(x - EPS, tick), ceilToTick(floor - EPS, tick))));
    const targets: Partial<Record<Rule, number>> = {
      'tp+4c': clamp(lot.entry + 0.04), 'tp+8c': clamp(lot.entry + 0.08), 'tp+12c': clamp(lot.entry + 0.12),
    };
    const wall = wallTarget(v.sell, lot.n, floor, tick);
    if (wall !== undefined) targets.wall = clamp(wall);
    const up = gainsUp(m.kind, lot.sign);
    const spot = index.get(m.asset)?.latest()?.value;
    const sigma = index.get(m.asset)?.vol()?.sigmaPerSqrtSec;
    const terms = termsOf(m);
    const tau = (m.closeTime - now) / 1000;
    if (up !== undefined && spot && sigma && terms && tau > 60) {
      const L = nextLevel(bars.get(m.asset) ?? [], spot, up);
      const fv = L ? priceContract(terms, { spot: L, sigmaPerSqrtSec: sigma, tauSec: tau }) : undefined;
      if (fv) {
        const side = floorToTick(lot.sign > 0 ? fv.pYes : 1 - fv.pYes, tick);
        // Worth selling there only if it banks the minimum (else the level gives no target: the lot holds).
        if (side >= floor - EPS && side <= 0.99) {
          targets.sr = side;
          targets['sr+wall'] = wall !== undefined && wall >= floor - EPS && wall < side ? clamp(wall) : side;
        }
      }
    }
    const sells: Partial<Record<Rule, RestingSell>> = {};
    for (const r of RULES) {
      const T = targets[r];
      if (T === undefined || T >= 1) continue;
      const ahead = v.sell.find((l) => Math.abs(l.price - T) <= EPS)?.size ?? 0;
      sells[r] = new RestingSell(lot.sign, lot.n, T, ahead);
    }
    const arr = active.get(lot.ticker) ?? [];
    arr.push({ lot, m, sells });
    active.set(lot.ticker, arr);
  };

  const bidsAtOrAbove = (book: OrderBook, sign: 1 | -1, price: number): number => {
    const s = book.snapshot(100);
    // A bid for our side at or above our ask: a YES bid >= T for long YES; a YES ask <= 1 - T for long NO.
    return sign > 0 ? s.bids.filter((l) => l.price >= price - EPS).reduce((a, l) => a + l.size, 0)
      : s.asks.filter((l) => round(1 - l.price, 4) >= price - EPS).reduce((a, l) => a + l.size, 0);
  };

  const settle = (now: number) => {
    for (const [ticker, arr] of active) {
      const m = arr[0].m;
      if (now < m.closeTime + 90_000) continue;
      const p = outcome(m);
      for (const a of arr) { if (p === undefined) skip('no result'); else done.push({ a, payout: p }); }
      active.delete(ticker);
      books.delete(ticker);
      markets.delete(ticker);
    }
  };

  let events = 0, lastSettle = 0;
  for await (const e of readRecordings(o.recordings, '', days[0], days[days.length - 1], keep) as AsyncGenerator<RecEvent>) {
    events++;
    while (next < pending.length && pending[next].t <= e.t) activate(pending[next++], e.t);
    switch (e.k) {
      case 'market':
        if (tickers.has(e.ticker) && !markets.has(e.ticker)) markets.set(e.ticker, { ticker: e.ticker, series: e.series, asset: e.asset, openTime: e.openTime, closeTime: e.closeTime,
          strike: e.strike ?? undefined, cap: e.cap ?? undefined, kind: e.kind ?? contractKind(e.series ?? ''), tick: e.tickSize ?? 0.01 });
        break;
      case 'index': {
        const ts = e.ts ?? e.t;
        let tr = index.get(e.asset);
        if (!tr) { tr = new IndexTracker(e.asset); index.set(e.asset, tr); }
        tr.add(e.value, ts);
        const bs = bars.get(e.asset) ?? [];
        const minute = Math.floor(ts / 60_000) * 60_000;
        const b = bs[bs.length - 1];
        if (b && b.ts === minute) { b.h = Math.max(b.h, e.value); b.l = Math.min(b.l, e.value); b.c = e.value; }
        else if (!b || minute > b.ts) { bs.push({ ts: minute, o: e.value, h: e.value, l: e.value, c: e.value, v: 0 }); if (bs.length > 240) bs.shift(); }
        bars.set(e.asset, bs);
        break;
      }
      case 'book': case 'delta': {
        let b = books.get(e.ticker);
        if (!b) { b = new OrderBook(e.ticker); books.set(e.ticker, b); }
        if (e.k === 'book') b.applySnapshot({ bids: e.bids ?? [], asks: e.asks ?? [] }, e.t);
        else b.applyDelta(e.side, e.price, e.delta, e.t);
        for (const a of active.get(e.ticker) ?? []) for (const s of Object.values(a.sells)) s!.onBook(e.t, bidsAtOrAbove(b, a.lot.sign, s!.price));
        break;
      }
      case 'trade':
        for (const a of active.get(e.ticker) ?? []) for (const s of Object.values(a.sells)) s!.onTrade(e.ts ?? e.t, e.price, e.count, e.takerSide);
        break;
      case 'result':
      case 'lifecycle':
        if (e.result === 'yes' || e.result === 'no') results.set(e.ticker, e.result);
        break;
    }
    if (e.t - lastSettle > 30_000) { settle(e.t); lastSettle = e.t; }
  }
  settle(Infinity);
  for (; next < pending.length; next++) skip('after the recordings end');
  log(`${events} recorded events read; ${done.length} lots scored`);

  const byRule = Object.fromEntries(RULES.map((r) => [r, emptyTally()])) as Record<Rule, RuleTally>;
  const bySeries: StudyResult['bySeries'] = {};
  let actualUsd = 0, holdUsd = 0, contracts = 0;
  const paperExited = { lots: 0, contracts: 0 };
  for (const { a, payout } of done) {
    const { lot } = a;
    const actual = lotPnl(lot, payout, [], 0, 0, true);
    const hold = lotPnl(lot, payout, [], 0, 0, false);
    actualUsd += actual; holdUsd += hold; contracts += lot.n;
    if (lot.exits.length) { paperExited.lots++; paperExited.contracts += lot.exits.reduce((s, x) => s + x.qty, 0); }
    const ser = (bySeries[lot.ticker.split('-')[0]] ??= { lots: 0, actualUsd: 0, holdUsd: 0 });
    ser.lots++; ser.actualUsd += actual; ser.holdUsd += hold;
    for (const r of RULES) {
      const x = byRule[r];
      const s = a.sells[r];
      x.lots++; x.contracts += lot.n;
      if (!s) {
        for (const mode of ['through', 'queue'] as const) for (const k of [0, 1] as const) { x.usd[mode].paper[k] += actual; x.usd[mode].hold[k] += hold; }
        continue;
      }
      x.withTarget++; x.targetContracts += lot.n; x.filledThrough += s.through; x.filledQueue += s.queue;
      if (s.queueFills.length) x.minutesToFill.push((s.queueFills[0].t - lot.t) / 60_000);
      for (const mode of ['through', 'queue'] as const) {
        const f = mode === 'through' ? s.throughFills : s.queueFills;
        for (const k of [0, 1] as const) {
          x.usd[mode].paper[k] += lotPnl(lot, payout, f, s.price, k, true);
          x.usd[mode].hold[k] += lotPnl(lot, payout, f, s.price, k, false);
        }
      }
    }
  }
  return { days, lots: done.length, skipped, contracts: round(contracts, 2), actualUsd: round(actualUsd, 2), holdUsd: round(holdUsd, 2), paperExited: { lots: paperExited.lots, contracts: round(paperExited.contracts, 2) }, byRule, bySeries };
}

const usd = (x: number) => `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(2)}`;
const pct = (a: number, b: number) => (b > 0 ? `${((100 * a) / b).toFixed(0)}%` : 'n/a');
const median = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };

export function report(r: StudyResult): string {
  const out: string[] = [];
  out.push(`Maker exit study, days ${r.days.join(', ')}: ${r.lots} lots, ${r.contracts} contracts` + (Object.keys(r.skipped).length ? ` (skipped: ${Object.entries(r.skipped).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''));
  out.push(`  paper's actual exits: ${usd(r.actualUsd)}   holding every lot to settlement: ${usd(r.holdUsd)}   (paper exited ${r.paperExited.lots} lots, ${r.paperExited.contracts} contracts, before settlement)`);
  out.push('');
  out.push('  rule      lots w/ target   filled (through / queue)   median min to fill   +paper: through / queue          or hold: through / queue         (maker fee x0; x1 in brackets)');
  for (const rule of RULES) {
    const x = r.byRule[rule];
    const m = median(x.minutesToFill);
    const both = (v: [number, number]) => `${usd(v[0])} [${usd(v[1])}]`;
    out.push(`  ${rule.padEnd(9)} ${pct(x.withTarget, x.lots).padStart(14)}   ${pct(x.filledThrough, x.targetContracts).padStart(8)} / ${pct(x.filledQueue, x.targetContracts).padEnd(13)}   ${(Number.isFinite(m) ? m.toFixed(1) : 'n/a').padStart(18)}   ${both(x.usd.through.paper)} / ${both(x.usd.queue.paper)}   ${both(x.usd.through.hold)} / ${both(x.usd.queue.hold)}`);
  }
  out.push('');
  out.push('  by series (actual vs hold): ' + Object.entries(r.bySeries).sort((a, b) => b[1].lots - a[1].lots).map(([s, v]) => `${s} ${v.lots} lots ${usd(v.actualUsd)} vs ${usd(v.holdUsd)}`).join('; '));
  return out.join('\n');
}

function arg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }

async function main(): Promise<void> {
  const days = arg('days', '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!days.length) throw new Error('--days YYYY-MM-DD[,YYYY-MM-DD...] is required');
  const r = await runStudy({ recordings: arg('recordings', 'data/recordings'), audit: arg('audit', 'data/audit'), days, log: (m) => console.log(m) });
  console.log(report(r));
  const out = arg('out', '');
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(r, null, 1)); }
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) main().catch((e) => { console.error(e); process.exit(1); });
