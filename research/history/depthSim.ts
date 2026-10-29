// The Kalshi order book's depth, simulated between the history's minute quotes (Steven, Oct 29). Kalshi's history keeps
// one quote a minute per contract; the bot's recordings keep every level and every change. research/depthStudy.ts
// measures on the recordings how the book is shaped and how it moves, against what the history also knows (minutes to
// close and the quote's mid); this plays that back around each quote the history replay gives (the anchors):
//   - at each anchor, the book is re-centred on the anchor's bid and ask: levels still on the right side keep their size
//     (so walls persist), levels the quote moved through go, and empty places near the top are drawn from the measured
//     share of time each level is quoted and its size's median and 90th percentile (log-normal);
//   - until the next anchor, each level's orders arrive and are cancelled at the measured queue-reactive rates
//     (Huang, Lehalle and Rosenbaum 2015: per distance from the best price and queue size), and trades take the best
//     level at the measured rate, size and side.
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
export interface ShapeCell { ti: number; mi: number; samples: number; levelQuoted: number[]; levelFilledP50: number[]; levelFilledP90: number[]; tradesPerMin: Quant; tradeSize: Quant; takerYesShare: number | null }
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
const expDraw = (u: () => number, rate: number) => -Math.log(Math.max(u(), 1e-12)) / rate;

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
   *  the changes and trades in between, in time order. `close` is the contract's close time. */
  play(ticker: string, t: number, bid: number, ask: number, until: number, close: number): DepthEv[] {
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
    // Until the next anchor: each level's adds and cancels, and the trades, as competing Poisson clocks.
    const tradeRate = Math.max(0, cell.tradesPerMin?.mean ?? 0) / 60;
    let now = t, lastChange = t;
    // Adds and cancels are netted per level and second (one delta each): the book at every second is the same as
    // event by event, with a tenth to a fiftieth of the lines. Trades flush the net first, so they see the book as it is.
    const net = new Map<string, { side: Side; p: number; d: number }>();
    const change = (side: Side, p: number, d: number) => {
      const k = `${side}|${p}`, x = net.get(k);
      if (x) x.d += d; else net.set(k, { side, p, d });
      lastChange = now;
    };
    const flush = () => {
      for (const x of net.values()) if (x.d !== 0) out.push({ t: lastChange, k: 'delta', ticker, side: x.side, price: x.p / PX, delta: x.d, ts: lastChange, sim: 1 });
      net.clear();
    };
    for (let guard = 0; guard < 5000; guard++) {
      const clocks: Array<{ rate: number; act: () => void }> = [];
      for (const side of ['bid', 'ask'] as Side[]) {
        const m = b[side], top = side === 'bid' ? Math.max(...m.keys()) : Math.min(...m.keys());
        if (!Number.isFinite(top)) continue;
        const tick = tickAt(top);
        for (let off = 0; off < DEPTH_LEVELS; off++) {
          const p = side === 'bid' ? top - off * tick : top + off * tick;
          if (p < 1 || p > PX - 1) continue;
          const q = m.get(p) ?? 0, f = this.rates(off, q);
          if (!f) continue;
          if (f.addPerSec > 0) clocks.push({ rate: f.addPerSec, act: () => { const d = lognormal(u, f.addSize.p50, f.addSize.p90); m.set(p, q + d); change(side, p, d); } });
          if (q > 0 && f.cancelPerSec > 0) clocks.push({ rate: f.cancelPerSec, act: () => { const d = Math.min(q, lognormal(u, f.cancelSize.p50, f.cancelSize.p90)); if (q - d > 0) m.set(p, q - d); else m.delete(p); change(side, p, -d); } });
        }
      }
      if (tradeRate > 0) clocks.push({ rate: tradeRate, act: () => {
        // A YES taker buys at the best ask; a NO taker sells YES at the best bid.
        const yes = u() < (cell.takerYesShare ?? 0.5), side: Side = yes ? 'ask' : 'bid', m = b![side];
        const top = side === 'bid' ? Math.max(...m.keys()) : Math.min(...m.keys());
        if (!Number.isFinite(top)) return;
        const q = m.get(top)!, n = Math.min(q, lognormal(u, cell.tradeSize.p50, cell.tradeSize.p90));
        flush();
        out.push({ t: now, k: 'trade', ticker, price: top / PX, count: n, takerSide: yes ? 'yes' : 'no', ts: now, sim: 1 });
        if (q - n > 0) m.set(top, q - n); else m.delete(top);
        out.push({ t: now, k: 'delta', ticker, side, price: top / PX, delta: -n, ts: now, sim: 1 });
      } });
      const total = clocks.reduce((a, c) => a + c.rate, 0);
      if (!(total > 0)) break;
      const next = now + Math.max(1, Math.round(expDraw(u, total) * 1000));
      if (Math.floor(next / 1000) !== Math.floor(now / 1000)) flush();
      now = next;
      if (now >= until) break;
      let pick = u() * total;
      for (const c of clocks) { pick -= c.rate; if (pick <= 0) { c.act(); break; } }
    }
    flush();
    return out;
  }
}
