// Kalshi quote lag (Steven, Nov 1: "predict where Kalshi's quote moves next, alongside everything else").
//
// The sine study (Oct 30) found the coin's last 10 s calls the direction of a 15m contract's next quote move 64.5% of
// the time: Kalshi's book lags the coin. This measures whether that lag is worth money, per contract, on the recorded
// days (real books and the real index, never history replays):
//
//   the gap      each second, how far the contract's fair value (the bot's own pricing from the coin and its
//                volatility) moved over the last w seconds MORE than its mid did: the coin's move the quote has not
//                caught up with yet, in cents. A trade also needs fair itself to have moved that way by theta (a quote
//                catching up on an older move opens a gap the other way).
//   prediction   does the mid close the gap over the next H seconds? Slope of the mid's move on the gap and the share
//                of big gaps the mid then moves toward (sampled every 5 s).
//   trading      when the gap passes theta: buy the side the gap points to, at the ask one second later (latency), and
//                sell it H seconds after at the bid (taker both ways, Kalshi's taker fee each way; no settlement hold:
//                entries stop 60 s before the close and every exit is at H or the last quote before the close). One
//                position per contract at a time. Cents per contract after fees with an hour-block bootstrap 95% CI,
//                and dollars per hour at `--count` contracts a trade over the hours recorded.
//
//   npm run research:quote-lag -- --recordings data/recordings [--from-day 2026-10-24] [--to-day 2026-10-31] [--count 20]

import fs from 'fs';
import { priceContract, SETTLEMENT_AVG_SEC } from '../bot/model/fairValue';
import { makerFee, takerFee } from '../bot/fees';
import { MetaModel } from '../bot/model/metaModel';
import { readRecordings, ReplayState, type RecMarket } from './replay';
import { rng } from './stats';

const S = 1000, HOUR = 3_600_000;
export const WINDOWS = [5, 10, 30];
export const HORIZONS = [5, 10, 30, 60];
export const THETAS = [0.02, 0.04, 0.06, 0.1];

/** One contract second: fair value and the book. */
export interface Tick { t: number; fair: number; bid: number; ask: number }

export interface Trade { t: number; pnl: number; side: 'yes' | 'no' }

/** Index of the tick at time t (ticks are one per second, possibly with holes): the last tick at or before t. */
export function at(ticks: Tick[], t: number, from = 0): number {
  let lo = from, hi = ticks.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (ticks[m].t <= t) { k = m; lo = m + 1; } else hi = m - 1; }
  return k;
}

/** The gap at tick i over w seconds: fair's move minus the mid's move (probability units); undefined without data. */
export function gapAt(ticks: Tick[], i: number, w: number): number | undefined {
  const j = at(ticks, ticks[i].t - w * S);
  if (j < 0 || ticks[i].t - ticks[j].t > (w + 2) * S) return undefined;
  const mid = (x: Tick) => (x.bid + x.ask) / 2;
  return (ticks[i].fair - ticks[j].fair) - (mid(ticks[i]) - mid(ticks[j]));
}

/** Fair value's own move over the last w seconds at tick i. */
export function fairMove(ticks: Tick[], i: number, w: number): number | undefined {
  const j = at(ticks, ticks[i].t - w * S);
  if (j < 0 || ticks[i].t - ticks[j].t > (w + 2) * S) return undefined;
  return ticks[i].fair - ticks[j].fair;
}

/** Per-contract fee in dollars at `count` contracts (Kalshi rounds the order's fee up). */
const feePer = (price: number, count: number) => takerFee(count, price) / count;
const makerFeePer = (price: number, count: number) => makerFee(count, price) / count;

/** Trades of one contract for (w, theta, H): enter at the next second's ask (bid for NO), exit H later at the bid. */
/** The adversary's knobs: a slower bot (latency, seconds from the signal to the fill) and a worse fill (slip, cents
 *  against the trade on entry and on exit). The study prints every cell with the plain settings and again under the
 *  adversary; a gain that survives 3 s and a cent of slippage is one worth building on. */
export interface Adversary { latency: number; slip: number }
export const ADVERSARIES: Adversary[] = [{ latency: 1, slip: 0 }, { latency: 3, slip: 0 }, { latency: 3, slip: 0.01 }];

export function contractTrades(ticks: Tick[], closeTime: number, w: number, theta: number, H: number, count: number, adv: Adversary = ADVERSARIES[0]): Trade[] {
  const out: Trade[] = [];
  let busyUntil = -Infinity;
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i].t;
    if (t < busyUntil || closeTime - t < 60 * S) continue;
    const g = gapAt(ticks, i, w);
    if (g === undefined || Math.abs(g) < theta) continue;
    // The coin must have moved fair value that way itself: a quote catching up on an old move also opens a gap.
    const f = fairMove(ticks, i, w);
    if (f === undefined || Math.sign(f) !== Math.sign(g) || Math.abs(f) < theta) continue;
    const e = at(ticks, t + adv.latency * S, i);
    if (e <= i || ticks[e].t - t > (adv.latency + 2) * S) continue;
    const xT = Math.min(ticks[e].t + H * S, closeTime - S);
    const x = at(ticks, xT, e);
    if (x <= e) continue;
    const yes = g > 0;
    const entry = (yes ? ticks[e].ask : 1 - ticks[e].bid) + adv.slip, exit = (yes ? ticks[x].bid : 1 - ticks[x].ask) - adv.slip;
    if (!(entry > 0 && entry < 1) || !(exit >= 0 && exit <= 1)) continue;
    const pnl = exit - entry - feePer(entry, count) - (exit > 0 ? feePer(exit, count) : 0);
    out.push({ t, pnl, side: yes ? 'yes' : 'no' });
    busyUntil = ticks[x].t;
  }
  return out;
}

/** Maker variant (Steven's add-dynamics rule, 11-01: the lag is a feature, so test it without paying the spread). On the
 *  same signal, rest a bid for the favoured side at the current best bid (1 - ask for NO) one latency later; it fills
 *  only if the market crosses to it (the ask comes down to the resting price) within H seconds, which is the
 *  conservative fill rule; then exit H seconds after the fill at the bid as a taker. Maker fee in, taker fee out. */
export function contractMakerTrades(ticks: Tick[], closeTime: number, w: number, theta: number, H: number, count: number, adv: Adversary = ADVERSARIES[0]): Trade[] {
  const out: Trade[] = [];
  let busyUntil = -Infinity;
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i].t;
    if (t < busyUntil || closeTime - t < 60 * S) continue;
    const g = gapAt(ticks, i, w);
    if (g === undefined || Math.abs(g) < theta) continue;
    const f = fairMove(ticks, i, w);
    if (f === undefined || Math.sign(f) !== Math.sign(g) || Math.abs(f) < theta) continue;
    const e = at(ticks, t + adv.latency * S, i);
    if (e <= i || ticks[e].t - t > (adv.latency + 2) * S) continue;
    const yes = g > 0;
    const rest = yes ? ticks[e].bid : 1 - ticks[e].ask;
    if (!(rest > 0 && rest < 1)) continue;
    const until = Math.min(ticks[e].t + H * S, closeTime - S);
    let fill = -1;
    for (let j = e + 1; j < ticks.length && ticks[j].t <= until; j++) {
      const cross = yes ? ticks[j].ask <= rest : 1 - ticks[j].bid <= rest;
      if (cross) { fill = j; break; }
    }
    busyUntil = until;
    if (fill < 0) continue;
    const xT = Math.min(ticks[fill].t + H * S, closeTime - S);
    const x = at(ticks, xT, fill);
    if (x <= fill) continue;
    const exit = (yes ? ticks[x].bid : 1 - ticks[x].ask) - adv.slip;
    if (!(exit >= 0 && exit <= 1)) continue;
    const pnl = exit - rest - makerFeePer(rest, count) - (exit > 0 ? feePer(exit, count) : 0);
    out.push({ t, pnl, side: yes ? 'yes' : 'no' });
    busyUntil = ticks[x].t;
  }
  return out;
}

/** Entry-timing filter: what a trader who wants the side the gap disfavours saves by waiting H seconds for the quote to
 *  move before entering, per contract (cents of entry price; fees are the same either way). Positive = waiting helped. */
export function contractTimingGains(ticks: Tick[], closeTime: number, w: number, theta: number, H: number, adv: Adversary = ADVERSARIES[0]): { t: number; pnl: number }[] {
  const out: { t: number; pnl: number }[] = [];
  let busyUntil = -Infinity;
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i].t;
    if (t < busyUntil || closeTime - t < 60 * S) continue;
    const g = gapAt(ticks, i, w);
    if (g === undefined || Math.abs(g) < theta) continue;
    const f = fairMove(ticks, i, w);
    if (f === undefined || Math.sign(f) !== Math.sign(g) || Math.abs(f) < theta) continue;
    const e = at(ticks, t + adv.latency * S, i);
    if (e <= i || ticks[e].t - t > (adv.latency + 2) * S) continue;
    const l = at(ticks, Math.min(ticks[e].t + H * S, closeTime - S), e);
    if (l <= e) continue;
    const wantsNo = g > 0; // the gap says the mid rises, so the disfavoured buyer wants NO
    const now = wantsNo ? 1 - ticks[e].bid : ticks[e].ask, later = wantsNo ? 1 - ticks[l].bid : ticks[l].ask;
    out.push({ t, pnl: now - later });
    busyUntil = ticks[l].t;
  }
  return out;
}

/** Mean with an hour-block bootstrap 95% interval (trades in the same hour resampled together). */
export function hourBlockCi(trades: { t: number; pnl: number }[], iters = 2000, seed = 3): { mean: number; lo: number; hi: number } {
  if (!trades.length) return { mean: NaN, lo: NaN, hi: NaN };
  const blocks = new Map<number, number[]>();
  for (const x of trades) { const h = Math.floor(x.t / HOUR); (blocks.get(h) ?? blocks.set(h, []).get(h)!).push(x.pnl); }
  const bs = [...blocks.values()], r = rng(seed), means: number[] = [];
  const mean = trades.reduce((s, x) => s + x.pnl, 0) / trades.length;
  for (let k = 0; k < iters; k++) {
    let s = 0, n = 0;
    for (let j = 0; j < bs.length; j++) { const b = bs[Math.floor(r() * bs.length)]; for (const v of b) { s += v; n++; } }
    means.push(n ? s / n : 0);
  }
  means.sort((a, b) => a - b);
  return { mean, lo: means[Math.floor(0.025 * iters)], hi: means[Math.floor(0.975 * iters)] };
}

interface Cell { trades: Trade[] }
interface Pred { n: number; sxy: number; sxx: number; big: number; bigToward: number }

async function main() {
  const arg = (k: string, d = '') => { const i = process.argv.indexOf(`--${k}`); return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d; };
  const dir = arg('recordings', 'data/recordings'), count = Number(arg('count', '20'));
  const fromDay = arg('from-day') || undefined, toDay = arg('to-day') || undefined;
  const st = new ReplayState(), model = MetaModel.identity();
  const ticks = new Map<string, Tick[]>();
  const cells = new Map<string, Cell>(), preds = new Map<string, Pred>();
  const makers = new Map<string, Cell>(), timings = new Map<string, { trades: { t: number; pnl: number }[] }>();
  for (const adv of ADVERSARIES) for (const w of WINDOWS) for (const th of THETAS) for (const H of HORIZONS) cells.set(`${w}|${th}|${H}|${adv.latency}|${adv.slip}`, { trades: [] });
  for (const adv of ADVERSARIES) for (const w of WINDOWS) for (const th of THETAS) for (const H of HORIZONS) { makers.set(`${w}|${th}|${H}|${adv.latency}|${adv.slip}`, { trades: [] }); timings.set(`${w}|${th}|${H}|${adv.latency}|${adv.slip}`, { trades: [] }); }
  for (const w of WINDOWS) for (const H of HORIZONS) preds.set(`${w}|${H}`, { n: 0, sxy: 0, sxx: 0, big: 0, bigToward: 0 });
  let first = Infinity, last = -Infinity, contracts = 0, nextSec = 0;

  const finish = (m: RecMarket) => {
    const tk = ticks.get(m.ticker);
    ticks.delete(m.ticker);
    if (!tk || tk.length < 120) return;
    contracts++;
    for (const [k, c] of cells) { const [w, th, H, lat, slip] = k.split('|').map(Number); for (const x of contractTrades(tk, m.closeTime, w, th, H, count, { latency: lat, slip })) c.trades.push(x); }
    for (const [k, c] of makers) { const [w, th, H, lat, slip] = k.split('|').map(Number); for (const x of contractMakerTrades(tk, m.closeTime, w, th, H, count, { latency: lat, slip })) c.trades.push(x); }
    for (const [k, c] of timings) { const [w, th, H, lat, slip] = k.split('|').map(Number); for (const x of contractTimingGains(tk, m.closeTime, w, th, H, { latency: lat, slip })) c.trades.push(x); }
    for (const [k, p] of preds) {
      const [w, H] = k.split('|').map(Number);
      for (let i = 0; i < tk.length; i += 5) {
        const g = gapAt(tk, i, w), j = at(tk, tk[i].t + H * S, i);
        if (g === undefined || j <= i || tk[j].t - tk[i].t < (H - 2) * S) continue;
        const dm = (tk[j].bid + tk[j].ask) / 2 - (tk[i].bid + tk[i].ask) / 2;
        p.n++; p.sxy += g * dm; p.sxx += g * g;
        if (Math.abs(g) >= 0.04) { p.big++; if (Math.sign(dm) === Math.sign(g)) p.bigToward++; }
      }
    }
  };

  for await (const e of readRecordings(dir, undefined, fromDay, toDay)) {
    st.apply(e);
    if (e.tie || st.now < nextSec) continue;
    const T = Math.floor(st.now / S) * S;
    nextSec = T + S;
    first = Math.min(first, T); last = Math.max(last, T);
    for (const m of [...st.markets.values()]) {
      if (m.recordOnly || m.kind === 'match') continue;
      if (st.now >= m.closeTime + 90_000) { finish(m); st.forget(m.ticker); continue; }
      if (st.now < m.openTime || st.now >= m.closeTime) continue;
      const book = st.books.get(m.ticker), idx = st.index.get(m.asset);
      const bid = book?.bestBid(), ask = book?.bestAsk(), spot = idx?.fresh(st.now, 3000), vol = idx?.vol(), terms = st.terms(m);
      if (!book?.isUsable(st.now, 5000) || !bid || !ask || !spot || !vol || !terms) continue;
      const tauSec = (m.closeTime - st.now) / 1000;
      const settle = tauSec <= SETTLEMENT_AVG_SEC ? idx!.settlement(m.closeTime, st.now, SETTLEMENT_AVG_SEC) : undefined;
      const fv = priceContract(terms, { spot: spot.value, sigmaPerSqrtSec: vol.sigmaPerSqrtSec, tauSec, observedAvg: settle?.avg, observedCount: settle?.n, nu: model.params.tNu });
      if (!fv) continue;
      let tk = ticks.get(m.ticker);
      if (!tk) ticks.set(m.ticker, (tk = []));
      tk.push({ t: T, fair: fv.pYes, bid: bid.price, ask: ask.price });
    }
  }
  for (const m of [...st.markets.values()]) if (!m.recordOnly && m.kind !== 'match' && st.now >= m.closeTime) finish(m);

  const hours = Math.max(1e-9, (last - first) / HOUR);
  console.log(`[quote-lag] ${contracts} contracts, ${hours.toFixed(1)} h recorded, ${count} contracts a trade, taker fee both ways`);
  console.log('[quote-lag] prediction: mid move over H on the gap over w (slope 1 = the quote closes the whole gap); big gaps (>=4c) followed by a mid move toward them');
  for (const [k, p] of preds) {
    const [w, H] = k.split('|');
    console.log(`[quote-lag]   w ${w}s H ${H}s: slope ${(p.sxy / Math.max(1e-12, p.sxx)).toFixed(2)} over ${p.n}; big gaps ${p.big}, toward ${p.big ? ((100 * p.bigToward) / p.big).toFixed(1) : '-'}%`);
  }
  const summary: unknown[] = [];
  const table = (title: string, kind: string, map: Map<string, { trades: { t: number; pnl: number }[] }>, dollars: boolean) => {
    for (const adv of ADVERSARIES) {
      console.log(`[quote-lag] ${title}, latency ${adv.latency} s, slip ${(adv.slip * 100).toFixed(0)}c (cents per contract, hour-block 95% CI${dollars ? '; $/h at the count above' : ''}):`);
      const rows = [...map].filter(([k]) => k.endsWith(`|${adv.latency}|${adv.slip}`)).map(([k, c]) => ({ k, c, ci: hourBlockCi(c.trades) })).sort((a, b) => (b.ci.mean || -1e9) - (a.ci.mean || -1e9));
      for (const { k, c, ci } of rows) {
        const [w, th, H] = k.split('|');
        const total = c.trades.reduce((s, x) => s + x.pnl, 0) * count;
        const verdict = ci.lo > 0 ? (dollars ? 'PROFIT' : 'HELPS') : ci.hi < 0 ? (dollars ? 'loss' : 'hurts') : 'undecided';
        console.log(`[quote-lag]   w ${w.padStart(2)}s theta ${(Number(th) * 100).toFixed(0).padStart(2)}c H ${H.padStart(2)}s: ${String(c.trades.length).padStart(6)} ${dollars ? 'trades' : 'cases'}, ${(ci.mean * 100).toFixed(2)}c [${(ci.lo * 100).toFixed(2)}, ${(ci.hi * 100).toFixed(2)}] ${verdict}${dollars ? `; $${(total / hours).toFixed(2)}/h` : ''}`);
        summary.push({ kind, ...adv, w: Number(w), theta: Number(th), H: Number(H), trades: c.trades.length, cents: ci.mean * 100, lo: ci.lo * 100, hi: ci.hi * 100, perHour: dollars ? total / hours : undefined });
      }
    }
  };
  table('trading the gap as a taker', 'taker', cells, true);
  table('resting a maker bid on the gap\'s side (fills only when the market crosses to it within H; maker fee in, taker out)', 'maker', makers, true);
  table('entry-timing filter: cents saved by waiting H before buying the side the gap disfavours', 'timing', timings, false);
  const out = arg('out');
  if (out) fs.writeFileSync(out, JSON.stringify({ contracts, hours, count, preds: Object.fromEntries(preds), cells: summary }, null, 1));
}

if (process.argv[1] && /quoteLagStudy\.ts$/.test(process.argv[1])) main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
