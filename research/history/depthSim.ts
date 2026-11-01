// The Kalshi order book's depth, simulated between the history's minute quotes (Steven, Oct 29). Kalshi's history keeps
// one quote a minute per contract; the bot's recordings keep every level and every change. research/depthStudy.ts
// measures on the recordings how the book is shaped and how it moves, against what the history also knows (minutes to
// close and the quote's mid); this plays that back around each quote the history replay gives (the anchors):
//   - at each anchor, the book is re-centred on the anchor's bid and ask: levels still on the right side keep their size
//     (so walls persist), levels the quote moved through go, and empty places near the top are drawn from the measured
//     share of time each level is quoted and its size's median and 90th percentile (log-normal);
//   - until the next anchor, each level's orders arrive and are cancelled at the measured queue-reactive rates
//     (Huang, Lehalle and Rosenbaum 2015: per distance from the best price and queue size), and trades take the best
//     level at the measured rate, size and side;
//   - the trades' rate and side follow where the mid goes by the next quote (the study's flow by move): on the way up,
//     mostly YES takers lift the asks, so a resting order fills just before the price moves against it, as on the
//     real book (adverse selection). Without it, the simulated flow was blind to the next quote, and resting orders
//     filled at no cost: the Oct 27-30 check had depth at +$880 against the real quotes' -$4.51.
// Every draw is seeded by the contract and the anchor's time, so a day plays out the same wherever it is replayed (the
// GitHub runners and the Windows trainer, which bundles this file).

import fs from 'fs';
import { hashStr } from './historyReplay';

export const DEPTH_LEVELS = 10;
/** Prices in tenths of a cent: Kalshi quotes in tenths below 10 cents and above 90 cents, whole cents between. */
export const PX = 1000;
export const tickAt = (px: number) => (px < 100 || px > 900 ? 1 : 10);
/** Ticks between a price and the best price on its side (both in tenths of a cent). */
export const ticksFrom = (px: number, best: number) => Math.round(Math.abs(px - best) / tickAt(best));
const MIN = 60_000;
/** The study's buckets (research/depthStudy.ts): minutes to close, mid in cents, queue size in contracts. */
const TAU_EDGES = [1, 3, 6, 10, 15, 60, Infinity];
const MID_EDGES = [10, 25, 40, 60, 75, 90, 101];
const Q_EDGES = [1, 10, 50, 200, 1000, Infinity];
const bucket = (edges: number[], x: number) => { const i = edges.findIndex((e) => x < e); return i < 0 ? edges.length - 1 : i; };

type Quant = { n: number; mean: number; p10: number; p50: number; p90: number };
/** The trade flow over a quarter-minute by where the mid went (research/depthStudy.ts byMove: down, flat, up). */
export interface MoveFlow { segs: number; tradesPerSec: number; takerYesShare: number | null }
export interface ShapeCell { ti: number; mi: number; samples: number; levelQuoted: number[]; levelFilledP50: number[]; levelFilledP90: number[]; tradesPerMin: Quant; tradeSize: Quant; takerYesShare: number | null; byMove?: MoveFlow[] }
/** Fewest quarter-minutes a cell's flow by move needs before it is used (else the cell's flow over all moves). */
export const MOVE_MIN_SEGS = 20;
/** Where the mid goes: 0 down, 1 flat (within half a tick), 2 up. Mids in cents (as research/depthStudy.ts moveOf). */
export const moveOf = (from: number, to: number): 0 | 1 | 2 => { const half = from < 10 || from > 90 ? 0.05 : 0.5, d = to - from; return d < -half ? 0 : d > half ? 2 : 1; };
export interface FlowCell { offset: number; qi: number; seconds: number; addPerSec: number; cancelPerSec: number; addSize: Quant; cancelSize: Quant }
/** research/depthStudy.ts's --out: the depth model. */
export interface DepthModel { days: string[]; shape: ShapeCell[]; flow: FlowCell[] }

export function readDepthModel(file: string): DepthModel | undefined {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8')) as DepthModel;
    return Array.isArray(m.shape) && m.shape.length && Array.isArray(m.flow) && m.shape.every((c) => Number.isInteger(c.ti) && Array.isArray(c.levelQuoted)) ? m : undefined;
  } catch { return undefined; }
}

/** A seeded uniform draw (the same generator as historyReplay's normals). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const normal = (u: () => number) => Math.sqrt(-2 * Math.log(Math.max(u(), 1e-12))) * Math.cos(2 * Math.PI * u());
/** A log-normal draw with this median and 90th percentile, at least 1 contract. */
function lognormal(u: () => number, p50: number, p90: number): number {
  if (!(p50 > 0)) return 1;
  const s = p90 > p50 ? Math.log(p90 / p50) / 1.2816 : 0;
  return Math.max(1, Math.round(p50 * Math.exp(s * normal(u))));
}
/** A seeded Poisson count: by multiplying uniforms when small, else its normal approximation. */
function poisson(u: () => number, lambda: number): number {
  if (!(lambda > 0)) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal(u)));
  const L = Math.exp(-lambda);
  let k = 0, p = u();
  while (p > L) { k++; p *= u(); }
  return k;
}
/** The total of n log-normal sizes (median p50, 90th percentile p90): drawn one by one up to 30, else from the mean and
 *  spread of the sum. */
function sumOf(u: () => number, n: number, p50: number, p90: number): number {
  if (n <= 0) return 0;
  if (n <= 30) { let s = 0; for (let i = 0; i < n; i++) s += lognormal(u, p50, p90); return s; }
  const sg = p90 > p50 && p50 > 0 ? Math.log(p90 / p50) / 1.2816 : 0, m = Math.max(1, p50) * Math.exp((sg * sg) / 2);
  const sd = m * Math.sqrt(Math.max(0, Math.exp(sg * sg) - 1));
  return Math.max(n, Math.round(n * m + Math.sqrt(n) * sd * normal(u)));
}

type Level = { price: number; size: number };
type Side = 'bid' | 'ask';
interface SimBook { bid: Map<number, number>; ask: Map<number, number> } // price in tenths of a cent -> size

export type DepthEv = { t: number; k: string; ticker: string; [key: string]: unknown };

export class DepthSim {
  private readonly shape = new Map<string, ShapeCell>();
  private readonly flow = new Map<string, FlowCell>();
  private readonly books = new Map<string, SimBook>();

  constructor(private readonly model: DepthModel) {
    for (const c of model.shape) this.shape.set(`${c.ti}|${c.mi}`, c);
    for (const f of model.flow) this.flow.set(`${f.offset}|${f.qi}`, f);
  }

  /** The shape cell for a contract's state: its own bucket when measured, else the nearest mid at the same minutes to
   *  close, else the nearest minutes to close. */
  private cell(tau: number, mid: number): ShapeCell {
    const ti = bucket(TAU_EDGES, Math.max(0, tau)), mi = bucket(MID_EDGES, mid);
    const own = this.shape.get(`${ti}|${mi}`);
    if (own) return own;
    let best: ShapeCell | undefined, bd = Infinity;
    for (const c of this.model.shape) { const d = 3 * Math.abs(c.ti - ti) + Math.abs(c.mi - mi); if (d < bd || (d === bd && best && c.samples > best.samples)) { bd = d; best = c; } }
    return best!;
  }

  private rates(off: number, q: number): FlowCell | undefined {
    const qi = bucket(Q_EDGES, q);
    for (let k = 0; k < Q_EDGES.length; k++) { const f = this.flow.get(`${off}|${qi + k}`) ?? this.flow.get(`${off}|${qi - k}`); if (f) return f; }
    return undefined;
  }

  /** Drop a contract's book (settled). */
  forget(ticker: string): void { this.books.delete(ticker); }

  /** The book at an anchor quote (bid and ask in dollars) and its life until `until`: a full snapshot at `t`, then
   *  the changes and trades in between, in time order. `close` is the contract's close time; `nextMid` (dollars), the
   *  next quote's mid, sets the trade flow by where the price is going (unknown: the flow over all moves). */
  play(ticker: string, t: number, bid: number, ask: number, until: number, close: number, nextMid?: number): DepthEv[] {
    const bB = Math.round(bid * PX), bA = Math.round(ask * PX);
    if (!(bB >= 1 && bA <= PX - 1 && bA > bB)) return [];
    const u = rng(hashStr(ticker) ^ Math.floor(t / 1000));
    const cell = this.cell((close - t) / MIN, (bB + bA) / 20);
    let b = this.books.get(ticker);
    if (!b) this.books.set(ticker, (b = { bid: new Map(), ask: new Map() }));
    // Re-centre: the quote's levels are the best ones; levels it moved through go; empty places near the top are drawn.
    for (const [p] of b.bid) if (p > bB || ticksFrom(p, bB) >= DEPTH_LEVELS) b.bid.delete(p);
    for (const [p] of b.ask) if (p < bA || ticksFrom(p, bA) >= DEPTH_LEVELS) b.ask.delete(p);
    for (const side of ['bid', 'ask'] as Side[]) {
      const m = b[side], best = side === 'bid' ? bB : bA, tick = tickAt(best);
      for (let off = 0; off < DEPTH_LEVELS; off++) {
        const p = side === 'bid' ? best - off * tick : best + off * tick;
        if (p < 1 || p > PX - 1 || m.has(p)) continue;
        if (off === 0 || u() < (cell.levelQuoted[off] ?? 0)) m.set(p, lognormal(u, cell.levelFilledP50[off], cell.levelFilledP90[off]));
      }
    }
    const levels = (side: Side): Level[] => [...b![side].entries()].sort((x, y) => (side === 'bid' ? y[0] - x[0] : x[0] - y[0])).map(([p, s]) => ({ price: p / PX, size: s }));
    const out: DepthEv[] = [{ t, k: 'book', ticker, bids: levels('bid'), asks: levels('ask'), ts: t, sim: 1 }];
    // Until the next anchor, second by second: each level's adds and cancels arrive at the measured queue-reactive rates
    // (Poisson counts per second, netted into one change per level), and the trades take the best level at the measured
    // rate, size and side. Counting per second, not event by event, keeps a busy book (hundreds of changes a second) cheap.
    const mv = nextMid !== undefined && Number.isFinite(nextMid) ? cell.byMove?.[moveOf((bB + bA) / 20, nextMid * 100)] : undefined;
    const byMove = mv && mv.segs >= MOVE_MIN_SEGS ? mv : undefined;
    const tradeRate = byMove ? Math.max(0, byMove.tradesPerSec) : Math.max(0, cell.tradesPerMin?.mean ?? 0) / 60;
    const yesShare = (byMove ? byMove.takerYesShare : undefined) ?? cell.takerYesShare ?? 0.5;
    const best = (side: Side) => { const m = b![side]; let top = side === 'bid' ? -Infinity : Infinity; for (const p of m.keys()) if (side === 'bid' ? p > top : p < top) top = p; return top; };
    for (let sec = t; sec < until; sec += 1000) {
      const end = Math.min(sec + 1000, until);
      // The trades in this second, spread through it, each on the book as it stands.
      const nTr = poisson(u, tradeRate * ((end - sec) / 1000));
      for (let i = 0; i < nTr; i++) {
        const at = sec + Math.floor(((i + 1) * (end - sec)) / (nTr + 1));
        // A YES taker buys at the best ask; a NO taker sells YES at the best bid.
        const yes = u() < yesShare, side: Side = yes ? 'ask' : 'bid', m = b[side], top = best(side);
        if (!Number.isFinite(top)) continue;
        const q = m.get(top)!, n = Math.min(q, lognormal(u, cell.tradeSize.p50, cell.tradeSize.p90));
        out.push({ t: at, k: 'trade', ticker, price: top / PX, count: n, takerSide: yes ? 'yes' : 'no', ts: at, sim: 1 });
        if (q - n > 0) m.set(top, q - n); else m.delete(top);
        out.push({ t: at, k: 'delta', ticker, side, price: top / PX, delta: -n, ts: at, sim: 1 });
      }
      // Then each level's net change over the second.
      const at = end - 1, frac = (end - sec) / 1000;
      for (const side of ['bid', 'ask'] as Side[]) {
        const m = b[side], top = best(side);
        if (!Number.isFinite(top)) continue;
        const tick = tickAt(top);
        for (let off = 0; off < DEPTH_LEVELS; off++) {
          const p = side === 'bid' ? top - off * tick : top + off * tick;
          if (p < 1 || p > PX - 1) continue;
          const q = m.get(p) ?? 0, f = this.rates(off, q);
          if (!f) continue;
          const added = sumOf(u, poisson(u, f.addPerSec * frac), f.addSize.p50, f.addSize.p90);
          const cancelled = q > 0 ? Math.min(q, sumOf(u, poisson(u, f.cancelPerSec * frac), f.cancelSize.p50, f.cancelSize.p90)) : 0;
          const d = added - cancelled;
          if (d === 0) continue;
          if (q + d > 0) m.set(p, q + d); else m.delete(p);
          out.push({ t: at, k: 'delta', ticker, side, price: p / PX, delta: d, ts: at, sim: 1 });
        }
      }
    }
    return out;
  }
}
