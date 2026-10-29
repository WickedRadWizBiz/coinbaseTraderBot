// How Kalshi's order book behaves on the recorded days, as the inputs of a depth simulator for the history replay
// (Steven, Oct 29: simulate the full depth the recordings show in the history, which keeps only one quote a minute).
//
// The recordings hold every book snapshot, every change at every price level and every trade. For each contract this
// rebuilds the book and measures, against the two things the history also knows (minutes to close, and where the
// minute's quote stands: its mid), what the history lacks:
//   - the shape: the spread, the size at each level behind the best price, the levels quoted within 10 cents, and walls
//     (the biggest level, how big against the median level, and how far from the best price);
//   - the flow, as a queue-reactive model calibrates it (Huang, Lehalle and Rosenbaum 2015): at each distance from the
//     best price and each queue size, how often orders are added, cancelled and traded, per second spent in that state;
//   - the trades: how many a minute, their sizes, and how often they take the bid or the ask.
// Read-only; prints aggregates and writes the tables to --out for the simulator to be fitted from.
//
//   node --import tsx research/depthStudy.ts --recordings data/recordings [--days 2026-10-25,2026-10-26] [--out depth_study.json]

import fs from 'fs';
import path from 'path';
import { OrderBook } from '../bot/marketdata/orderBook';
import { recordingFiles, recordingLines } from '../bot/marketdata/recordingFiles';

const MIN = 60_000;
const SAMPLE_MS = 15_000;
const LEVELS = 10;

/** Minutes to close and mid (cents) buckets: what the history knows about a contract at each minute. */
export const TAU_EDGES = [1, 3, 6, 10, 15, 60, Infinity];
export const MID_EDGES = [10, 25, 40, 60, 75, 90, 101];
/** Queue sizes (contracts) for the queue-reactive intensities. */
export const Q_EDGES = [1, 10, 50, 200, 1000, Infinity];
const bucket = (edges: number[], x: number) => { const i = edges.findIndex((e) => x < e); return i < 0 ? edges.length - 1 : i; };
const label = (edges: number[], i: number, unit = '') => `${i === 0 ? 0 : edges[i - 1]}-${edges[i] === Infinity ? '' : edges[i]}${unit}`;

/** A running sample of values, summarised as quantiles. */
class Dist {
  xs: number[] = [];
  add(x: number) { if (Number.isFinite(x)) this.xs.push(x); }
  q(p: number): number { if (!this.xs.length) return NaN; const s = [...this.xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }
  mean(): number { return this.xs.length ? this.xs.reduce((a, b) => a + b, 0) / this.xs.length : NaN; }
  summary() { return { n: this.xs.length, mean: +this.mean().toFixed(3), p10: this.q(0.1), p50: this.q(0.5), p90: this.q(0.9) }; }
}

interface Cell {
  samples: number; spread: Dist; quotedLevels: Dist; depth10: Dist; wallSize: Dist; wallRatio: Dist; wallOffset: Dist;
  levelSize: Dist[]; levelFilled: Dist[]; tradesPerMin: Dist; tradeSize: Dist; takerYes: number; trades: number; deltasPerMin: Dist;
}
const newCell = (): Cell => ({ samples: 0, spread: new Dist(), quotedLevels: new Dist(), depth10: new Dist(), wallSize: new Dist(), wallRatio: new Dist(), wallOffset: new Dist(),
  levelSize: Array.from({ length: LEVELS }, () => new Dist()), levelFilled: Array.from({ length: LEVELS }, () => new Dist()), tradesPerMin: new Dist(), tradeSize: new Dist(), takerYes: 0, trades: 0, deltasPerMin: new Dist() });

/** Queue-reactive counts: per (distance from best in cents, queue size bucket), events and seconds spent there. */
interface Qr { seconds: number; add: number; cancel: number; trade: number; addSize: Dist; cancelSize: Dist }
const newQr = (): Qr => ({ seconds: 0, add: 0, cancel: 0, trade: 0, addSize: new Dist(), cancelSize: new Dist() });

interface Contract { ticker: string; close: number; book: OrderBook; lastSample: number; minute: number; deltas: number; trades: number }

type Side = 'bid' | 'ask';
/** The book's levels on one side, best first, as [price cents, size]. */
function sideLevels(b: OrderBook, side: Side): Array<[number, number]> {
  const s = b.snapshot(100);
  return (side === 'bid' ? s.bids : s.asks).map((l) => [Math.round(l.price * 100), l.size]);
}

export function depthStudy(files: string[]): Promise<ReturnType<typeof report>> {
  return run(files);
}

async function run(files: string[]) {
  const cells = new Map<string, Cell>();
  const qr = new Map<string, Qr>();
  const cellOf = (tau: number, mid: number) => { const k = `${bucket(TAU_EDGES, tau)}|${bucket(MID_EDGES, mid)}`; let c = cells.get(k); if (!c) cells.set(k, (c = newCell())); return c; };
  const qrOf = (off: number, q: number) => { const k = `${Math.min(off, LEVELS)}|${bucket(Q_EDGES, q)}`; let c = qr.get(k); if (!c) qr.set(k, (c = newQr())); return c; };
  const contracts = new Map<string, Contract>();
  const state = (c: Contract, t: number) => {
    const bb = c.book.bestBid(), ba = c.book.bestAsk();
    if (!bb || !ba) return undefined;
    return { tau: (c.close - t) / MIN, mid: ((bb.price + ba.price) / 2) * 100 };
  };
  const sample = (c: Contract, t: number) => {
    const s = state(c, t);
    if (!s || s.tau < 0) return;
    const cell = cellOf(s.tau, s.mid);
    cell.samples++;
    const bids = sideLevels(c.book, 'bid'), asks = sideLevels(c.book, 'ask');
    cell.spread.add(asks[0][0] - bids[0][0]);
    for (const lv of [bids, asks]) {
      const best = lv[0][0];
      // Each sample stands for SAMPLE_MS at each distance and queue size: the intensities' denominators.
      const atAll = new Map(lv.map(([p, v]) => [Math.abs(p - best), v]));
      for (let off = 0; off < LEVELS; off++) qrOf(off, atAll.get(off) ?? 0).seconds += SAMPLE_MS / 1000;
      const near = lv.filter(([p]) => Math.abs(p - best) < LEVELS);
      cell.quotedLevels.add(near.length);
      cell.depth10.add(near.reduce((a, [, v]) => a + v, 0));
      const at = new Map(near.map(([p, v]) => [Math.abs(p - best), v]));
      for (let off = 0; off < LEVELS; off++) { const v = at.get(off) ?? 0; cell.levelSize[off].add(v); if (v > 0) cell.levelFilled[off].add(v); }
      const sizes = near.map(([, v]) => v).sort((a, b) => a - b);
      const med = sizes[Math.floor(sizes.length / 2)] || 1;
      const wall = near.reduce((m, x) => (x[1] > m[1] ? x : m), near[0]);
      cell.wallSize.add(wall[1]); cell.wallRatio.add(wall[1] / med); cell.wallOffset.add(Math.abs(wall[0] - best));
    }
  };
  const minuteEnd = (c: Contract, t: number) => {
    const s = state(c, t);
    if (s && s.tau >= 0) { const cell = cellOf(s.tau, s.mid); cell.tradesPerMin.add(c.trades); cell.deltasPerMin.add(c.deltas); }
    c.trades = 0; c.deltas = 0;
  };

  for (const file of files) {
    for await (const line of recordingLines(file)) {
      if (!line) continue;
      let e: Record<string, any>;
      try { e = JSON.parse(line); } catch { continue; }
      const t: number = e.t ?? e.ts;
      if (e.k === 'market' && e.ticker && e.closeTime && (e.kind === 'updown' || /15M/.test(e.series ?? ''))) {
        if (!contracts.has(e.ticker)) contracts.set(e.ticker, { ticker: e.ticker, close: Number(e.closeTime), book: new OrderBook(e.ticker), lastSample: 0, minute: 0, deltas: 0, trades: 0 });
        continue;
      }
      const c = e.ticker ? contracts.get(e.ticker) : undefined;
      if (!c) continue;
      if (t > c.close) { contracts.delete(c.ticker); continue; }
      // The contract's samples and minutes up to this event, on the book as it stood.
      while (c.lastSample && c.lastSample + SAMPLE_MS <= t) { c.lastSample += SAMPLE_MS; sample(c, c.lastSample); }
      const m = Math.floor(t / MIN);
      if (c.minute && m > c.minute) minuteEnd(c, c.minute * MIN + MIN - 1);
      c.minute = m;
      if (e.k === 'book') {
        c.book.applySnapshot({ bids: e.bids ?? [], asks: e.asks ?? [] }, t);
        if (!c.lastSample) c.lastSample = Math.ceil(t / SAMPLE_MS) * SAMPLE_MS - SAMPLE_MS;
      } else if (e.k === 'delta' && (e.side === 'bid' || e.side === 'ask')) {
        const side = e.side as Side;
        const top = side === 'bid' ? c.book.bestBid() : c.book.bestAsk();
        const p = Math.round(Number(e.price) * 100), d = Number(e.delta);
        if (top && Number.isFinite(d) && d !== 0) {
          const best = Math.round(top.price * 100);
          // A level better than the best is a new best (distance 0); the queue is the level's size before the change.
          const off = side === 'bid' ? Math.max(0, best - p) : Math.max(0, p - best);
          const before = c.book.sizeAt(side, Number(e.price));
          const cell = qrOf(off, before);
          if (d > 0) { cell.add++; cell.addSize.add(d); } else { cell.cancel++; cell.cancelSize.add(-d); }
        }
        c.book.applyDelta(side, Number(e.price), d, t);
        c.deltas++;
      } else if (e.k === 'trade') {
        const s = state(c, t);
        if (s) { const cell = cellOf(s.tau, s.mid); cell.trades++; cell.tradeSize.add(Number(e.count)); if (e.takerSide === 'yes') cell.takerYes++; }
        // The trade takes the best level on the side it hits: the queue-reactive model's market orders.
        const side: Side = e.takerSide === 'yes' ? 'ask' : 'bid';
        const best = side === 'ask' ? c.book.bestAsk() : c.book.bestBid();
        if (best) qrOf(0, best.size).trade++;
        c.trades++;
      }
    }
  }
  return report(cells, qr);
}

function report(cells: Map<string, Cell>, qr: Map<string, Qr>) {
  const shape = [...cells.entries()].filter(([, c]) => c.samples >= 20).map(([k, c]) => {
    const [ti, mi] = k.split('|').map(Number);
    return {
      tau: label(TAU_EDGES, ti, ' min'), mid: label(MID_EDGES, mi, 'c'), samples: c.samples,
      spread: c.spread.summary(), quotedLevels: c.quotedLevels.summary(), depth10: c.depth10.summary(),
      wallSize: c.wallSize.summary(), wallRatio: c.wallRatio.summary(), wallOffset: c.wallOffset.summary(),
      levelSizeP50: c.levelSize.map((d) => d.q(0.5)), levelSizeMean: c.levelSize.map((d) => +d.mean().toFixed(1)),
      // Where a level is quoted: how often, and its size's median and 90th percentile (the simulator draws from these).
      levelQuoted: c.levelFilled.map((d) => +(d.xs.length / Math.max(1, c.levelSize[0].xs.length)).toFixed(3)),
      levelFilledP50: c.levelFilled.map((d) => d.q(0.5)), levelFilledP90: c.levelFilled.map((d) => d.q(0.9)),
      tradesPerMin: c.tradesPerMin.summary(), deltasPerMin: c.deltasPerMin.summary(), tradeSize: c.tradeSize.summary(),
      takerYesShare: c.trades ? +(c.takerYes / c.trades).toFixed(3) : null,
    };
  });
  const flow = [...qr.entries()].filter(([, q]) => q.seconds > 60).map(([k, q]) => {
    const [off, qi] = k.split('|').map(Number);
    const per = (n: number) => +(n / q.seconds).toFixed(5);
    return { offset: off, queue: label(Q_EDGES, qi), seconds: Math.round(q.seconds), addPerSec: per(q.add), cancelPerSec: per(q.cancel), tradePerSec: per(q.trade),
      addSize: q.addSize.summary(), cancelSize: q.cancelSize.summary() };
  }).sort((a, b) => a.offset - b.offset || a.queue.localeCompare(b.queue));
  return { shape, flow };
}

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }

async function main() {
  const rec = cliArg('recordings', 'data/recordings');
  const want = cliArg('days', '').split(',').filter(Boolean);
  const today = new Date().toISOString().slice(0, 10);
  const days = recordingFiles(rec).filter((d) => d.day < today && (!want.length || want.includes(d.day)));
  if (!days.length) throw new Error('no whole recorded days');
  const r = await run(days.map((d) => d.file));
  const out = cliArg('out', '');
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, JSON.stringify({ days: days.map((d) => d.day), ...r }, null, 1)); }
  console.log(`[depth] ${days.length} day(s): ${days[0].day}..${days[days.length - 1].day}`);
  console.log('[depth] shape by minutes to close and mid (each side; sizes in contracts, spread and offsets in cents)');
  for (const s of r.shape) {
    console.log(`  ${s.tau.padEnd(9)} ${s.mid.padEnd(7)} n=${String(s.samples).padStart(6)}  spread p50 ${s.spread.p50} p90 ${s.spread.p90} | levels in 10c ${s.quotedLevels.p50} | depth10 p50 ${s.depth10.p50} | wall ${s.wallSize.p50} (x${(+s.wallRatio.p50).toFixed(1)} median, ${s.wallOffset.p50}c back) | lvl0-4 quoted ${s.levelQuoted.slice(0, 5).join('/')} size p50 ${s.levelFilledP50.slice(0, 5).join('/')} p90 ${s.levelFilledP90.slice(0, 5).join('/')} | trades/min ${s.tradesPerMin.mean} size p50 ${s.tradeSize.p50} | changes/min ${s.deltasPerMin.mean}`);
  }
  console.log('[depth] queue-reactive flow (per second at each distance from best and queue size)');
  for (const f of r.flow) console.log(`  off ${String(f.offset).padStart(2)}c q ${f.queue.padEnd(9)} ${String(f.seconds).padStart(8)} s  add ${f.addPerSec} (p50 ${f.addSize.p50})  cancel ${f.cancelPerSec} (p50 ${f.cancelSize.p50})  trade ${f.tradePerSec}`);
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) main().catch((e) => { console.error(e); process.exit(1); });
