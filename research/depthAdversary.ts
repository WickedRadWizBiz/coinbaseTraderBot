// The depth simulator's adversary (Steven, Nov 1: "try to break whatever is working to create gains so that we can be
// sure it is genuine"). The replay fill check compares the whole bot on the real books and on each fill-in; this
// attacks the fill-in directly with probes that only make money where a simulated book is kinder than the real one:
//   - join:   a resting bid at the best bid and a resting ask at the best ask (the queue ahead must trade first);
//   - inside: resting one tick inside the touch when the spread allows (first in the queue: fills on any print);
//   - behind: resting one tick behind the touch (fills only when the price moves through it);
//   - taker:  buying at the ask and selling at the bid at once.
// Each probe quotes 10 contracts on every live crypto contract, refreshed every 15 s and withdrawn after 60 s, on the
// same paper exchange the bot trades on. Every fill is marked out 60 s later against the mid and held to settlement.
// A fill-in the probes earn more on than the real books (per contract, beyond the day-bootstrap noise) is too kind
// there, whatever the whole bot's P&L says: a real book fills a resting order mostly just before the price moves
// against it (adverse selection), a book that fills it for free hands the bot gains that are not genuine.
//
//   node --import tsx research/depthAdversary.ts --recordings <dir> [--days d1,d2] --out adversary-<how>.json
//   node --import tsx research/depthAdversary.ts --compare real=<json>[,<json>...] depth=<json>[,...] [hold=...]
// replayFidelity.ts --stage adversary runs them on each part's days; the compare job prints real vs each fill-in.

import fs from 'fs';
import path from 'path';
import { DEFAULT_FEES } from '../bot/fees';
import { PaperExchange } from '../bot/paper/paperExchange';
import { readRecordings, ReplayState } from './replay';
import { recordingFiles } from '../bot/marketdata/recordingFiles';
import { PX, tickAt } from './history/depthSim';

export const PROBES = ['join', 'inside', 'behind', 'taker'] as const;
export type Probe = (typeof PROBES)[number];
const SIZE = 10;
const REFRESH_MS = 15_000;
const LIFE_MS = 60_000;
const MARKOUT_MS = 60_000;
/** No probe in a contract's last two minutes (the bot's own end-window rules take over there). */
const END_MS = 120_000;

export interface ProbeFill { probe: Probe; side: 'bid' | 'ask'; price: number; count: number; fee: number; t: number; markout?: number; settled?: number; day: string }
/** One day's probe results per file (per day, so the comparison can bootstrap over days). */
export interface AdversaryDay {
  day: string;
  /** Contract-hours each probe side was resting (join, inside, behind) or taker attempts (taker). */
  quoted: Record<Probe, number>;
  fills: ProbeFill[];
}
export interface AdversaryOut { how: string; days: AdversaryDay[] }

const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const tick = (px: number) => tickAt(Math.round(px * PX)) / PX;
const r = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

export async function probeDays(rec: string, days?: string[]): Promise<AdversaryDay[]> {
  const st = new ReplayState();
  const ex = new PaperExchange(undefined, 1e9, (t) => st.books.get(t), () => DEFAULT_FEES, () => st.now);
  const byDay = new Map<string, AdversaryDay>();
  const dayRec = (t: number) => { const d = dayOf(t); let x = byDay.get(d); if (!x) byDay.set(d, (x = { day: d, quoted: { join: 0, inside: 0, behind: 0, taker: 0 }, fills: [] })); return x; };
  // Probes by client order id (a taker's fill fires inside createOrder, before its order id is known); the resting
  // ones also by order id, for their withdrawal.
  const probes = new Map<string, { probe: Probe; side: 'bid' | 'ask'; ticker: string; t: number }>();
  const resting = new Map<string, { probe: Probe; side: 'bid' | 'ask'; ticker: string; t: number; coid: string }>();
  const lastAt = new Map<string, number>();
  const pending: Array<{ due: number; f: ProbeFill; ticker: string }> = [];
  const open = new Map<string, ProbeFill[]>();
  let n = 0;
  ex.on('fill', (f) => {
    const p = f.clientOrderId ? probes.get(f.clientOrderId) : undefined;
    if (!p) return;
    const fill: ProbeFill = { probe: p.probe, side: f.side, price: f.price, count: f.count, fee: f.fee ?? 0, t: st.now, day: dayOf(st.now) };
    dayRec(st.now).fills.push(fill);
    pending.push({ due: st.now + MARKOUT_MS, f: fill, ticker: f.ticker });
    (open.get(f.ticker) ?? open.set(f.ticker, []).get(f.ticker)!).push(fill);
  });
  const wanted = new Set(days ?? []);
  const files = recordingFiles(rec).filter((d: { day: string }) => !wanted.size || wanted.has(d.day));
  if (!files.length) throw new Error(`no recorded days in ${rec}`);
  const from = files[0].day, to = files[files.length - 1].day;
  let lastTick = 0;
  for await (const e of readRecordings(rec, '', from, to)) {
    st.apply(e);
    if (e.k === 'trade') ex.onTrade(e.ticker, e.price, e.count, e.takerSide, e.ts);
    if (e.k === 'result') {
      // Settlement: each open probe fill's P&L a contract, then the contract is done.
      for (const f of open.get(e.ticker) ?? []) f.settled = r((f.side === 'bid' ? (e.result === 'yes' ? 1 : 0) - f.price : f.price - (e.result === 'yes' ? 1 : 0)) - f.fee / f.count);
      open.delete(e.ticker);
      for (const [id, p] of [...resting]) if (p.ticker === e.ticker) { resting.delete(id); probes.delete(p.coid); await ex.cancelOrder(id); }
      ex.settle(e.ticker, e.result);
      st.forget(e.ticker);
      continue;
    }
    if (e.tie || st.now - lastTick < 1000) continue;
    lastTick = st.now;
    while (pending.length && pending[0].due <= st.now) {
      const x = pending.shift()!;
      const mid = st.books.get(x.ticker)?.mid();
      if (mid !== undefined) x.f.markout = r((x.f.side === 'bid' ? 1 : -1) * (mid - x.f.price));
    }
    // Withdraw probes older than LIFE_MS.
    for (const [id, p] of [...resting]) if (st.now - p.t >= LIFE_MS) { resting.delete(id); probes.delete(p.coid); await ex.cancelOrder(id); }
    for (const m of st.markets.values()) {
      if (m.recordOnly || m.synthetic || m.kind !== 'updown') continue;
      if (st.now >= m.closeTime - END_MS || st.now < m.openTime) continue;
      const last = lastAt.get(m.ticker) ?? -Infinity;
      if (st.now - last < REFRESH_MS) continue;
      const b = st.books.get(m.ticker);
      const bb = b?.bestBid(), ba = b?.bestAsk();
      if (!b || !bb || !ba || !(ba.price > bb.price)) continue;
      lastAt.set(m.ticker, st.now);
      const day = dayRec(st.now);
      const tk = tick(bb.price);
      const want: Array<{ probe: Probe; side: 'bid' | 'ask'; price: number }> = [
        { probe: 'join', side: 'bid', price: bb.price }, { probe: 'join', side: 'ask', price: ba.price },
        { probe: 'behind', side: 'bid', price: bb.price - tk }, { probe: 'behind', side: 'ask', price: ba.price + tk },
      ];
      if (ba.price - bb.price > tk * 1.5) want.push({ probe: 'inside', side: 'bid', price: r(bb.price + tk) }, { probe: 'inside', side: 'ask', price: r(ba.price - tk) });
      for (const w of want) {
        if (!(w.price > 0.005 && w.price < 0.995)) continue;
        // One resting probe per contract, probe and side: the old one is withdrawn when the touch has moved.
        for (const [id, p] of [...resting]) if (p.ticker === m.ticker && p.probe === w.probe && p.side === w.side) { resting.delete(id); probes.delete(p.coid); await ex.cancelOrder(id); }
        const coid = `adv-${w.probe}-${n++}`;
        probes.set(coid, { probe: w.probe, side: w.side, ticker: m.ticker, t: st.now });
        try {
          const o = await ex.createOrder({ ticker: m.ticker, side: w.side, count: SIZE, price: w.price, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, selfTradePrevention: 'taker_at_cross', clientOrderId: coid });
          resting.set(o.orderId, { probe: w.probe, side: w.side, ticker: m.ticker, t: st.now, coid });
          day.quoted[w.probe] += REFRESH_MS / 3_600_000 / 2; // each side half of a contract-hour per refresh
        } catch { probes.delete(coid); /* post-only would cross: the touch moved */ }
      }
      // The taker probe: once a minute, both ways.
      if (Math.floor(st.now / 60_000) !== Math.floor(last / 60_000)) {
        for (const side of ['bid', 'ask'] as const) {
          const coid = `adv-taker-${n++}`;
          probes.set(coid, { probe: 'taker', side, ticker: m.ticker, t: st.now });
          try {
            await ex.createOrder({ ticker: m.ticker, side, count: SIZE, price: side === 'bid' ? ba.price : bb.price, timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: false, selfTradePrevention: 'taker_at_cross', clientOrderId: coid });
            day.quoted.taker += 0.5;
          } catch { /* nothing on the other side */ }
          probes.delete(coid);
        }
      }
    }
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** A probe's numbers over some days: fills a contract-hour quoted, the 60 s markout and the settlement P&L a contract
 *  (cents, fees in), and the whole P&L in dollars. */
export interface ProbeStat { probe: Probe; quoted: number; contracts: number; perHour: number; markoutC: number; settledC: number; pnlUsd: number; n: number }
export function probeStats(days: AdversaryDay[]): ProbeStat[] {
  return PROBES.map((probe) => {
    const fills = days.flatMap((d) => d.fills.filter((f) => f.probe === probe));
    const quoted = days.reduce((a, d) => a + d.quoted[probe], 0);
    const contracts = fills.reduce((a, f) => a + f.count, 0);
    const mk = fills.filter((f) => f.markout !== undefined), se = fills.filter((f) => f.settled !== undefined);
    const wmean = (xs: ProbeFill[], v: (f: ProbeFill) => number) => { const c = xs.reduce((a, f) => a + f.count, 0); return c ? xs.reduce((a, f) => a + v(f) * f.count, 0) / c : 0; };
    return { probe, quoted: r(quoted, 2), contracts: r(contracts, 2), perHour: quoted ? r(contracts / quoted, 2) : 0, markoutC: r(100 * wmean(mk, (f) => f.markout! - f.fee / f.count), 2), settledC: r(100 * wmean(se, (f) => f.settled!), 2), pnlUsd: r(se.reduce((a, f) => a + f.settled! * f.count, 0), 2), n: fills.length };
  });
}

/** real vs each fill-in, probe by probe: the settlement P&L a contract's difference and its day-bootstrap 90% band.
 *  A fill-in is "kinder" on a probe when the whole band is above zero (it pays the probe more than the real books). */
export function compareProbes(real: AdversaryDay[], fills: Record<string, AdversaryDay[]>, draws = 400): Array<{ how: string; probe: Probe; real: ProbeStat; sim: ProbeStat; diffC: number; lo: number; hi: number; kinder: boolean }> {
  const out: ReturnType<typeof compareProbes> = [];
  let seed = 7;
  const u = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (const [how, sim] of Object.entries(fills)) {
    const days = real.map((d) => d.day).filter((d) => sim.some((x) => x.day === d));
    const rs = probeStats(real.filter((d) => days.includes(d.day))), ss = probeStats(sim.filter((d) => days.includes(d.day)));
    for (const probe of PROBES) {
      const a = rs.find((x) => x.probe === probe)!, b = ss.find((x) => x.probe === probe)!;
      const diffs: number[] = [];
      for (let i = 0; i < draws; i++) {
        const pick = days.map(() => days[Math.floor(u() * days.length)]);
        const ra = probeStats(pick.map((d) => real.find((x) => x.day === d)!)).find((x) => x.probe === probe)!;
        const rb = probeStats(pick.map((d) => sim.find((x) => x.day === d)!)).find((x) => x.probe === probe)!;
        diffs.push(rb.settledC - ra.settledC);
      }
      diffs.sort((x, y) => x - y);
      const lo = diffs[Math.floor(0.05 * diffs.length)] ?? 0, hi = diffs[Math.min(diffs.length - 1, Math.floor(0.95 * diffs.length))] ?? 0;
      out.push({ how, probe, real: a, sim: b, diffC: r(b.settledC - a.settledC, 2), lo: r(lo, 2), hi: r(hi, 2), kinder: days.length >= 2 ? lo > 0 : b.settledC - a.settledC > 1 });
    }
  }
  return out;
}

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }

async function main() {
  const cmp = cliArg('compare', '');
  if (cmp) {
    const sets: Record<string, AdversaryDay[]> = {};
    for (const part of cmp.split(/\s+/).filter(Boolean)) {
      const [how, list] = part.split('=');
      sets[how] = (sets[how] ?? []).concat(...list.split(',').filter(Boolean).map((f) => (JSON.parse(fs.readFileSync(f, 'utf8')) as AdversaryOut).days));
    }
    const { real, ...rest } = sets;
    if (!real) throw new Error('--compare needs real=<json>');
    const rows = compareProbes(real, rest);
    console.log(`[adversary] ${real.length} day(s) of real books; settlement P&L a contract in cents (fees in), 60 s markout, fills a contract-hour quoted`);
    for (const s of probeStats(real)) console.log(`  real     ${s.probe.padEnd(7)} ${String(s.perHour).padStart(6)}/h  markout ${String(s.markoutC).padStart(7)}c  settled ${String(s.settledC).padStart(7)}c  $${s.pnlUsd} (${s.n} fills)`);
    for (const x of rows) console.log(`  ${x.how.padEnd(8)} ${x.probe.padEnd(7)} ${String(x.sim.perHour).padStart(6)}/h  markout ${String(x.sim.markoutC).padStart(7)}c  settled ${String(x.sim.settledC).padStart(7)}c  $${x.sim.pnlUsd} (${x.sim.n} fills) | vs real ${x.diffC >= 0 ? '+' : ''}${x.diffC}c [${x.lo}, ${x.hi}]${x.kinder ? '  KINDER THAN REAL' : ''}`);
    const kinder = rows.filter((x) => x.kinder);
    console.log(kinder.length ? `[adversary] broken: ${kinder.map((x) => `${x.how}/${x.probe}`).join(', ')} pay the probes more than the real books` : '[adversary] no probe earns more on a fill-in than on the real books');
    const out = cliArg('out', '');
    if (out) fs.writeFileSync(out, JSON.stringify({ real: probeStats(real), rows, kinder: kinder.map((x) => `${x.how}/${x.probe}`) }, null, 1));
    return;
  }
  const rec = cliArg('recordings', 'data/recordings');
  const days = cliArg('days', '').split(',').filter(Boolean);
  const how = cliArg('how', path.basename(rec));
  const t0 = Date.now();
  const res = await probeDays(rec, days.length ? days : undefined);
  const out = cliArg('out', '');
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, JSON.stringify({ how, days: res } satisfies AdversaryOut)); }
  console.log(`[adversary] ${how}: ${res.map((d) => d.day).join(', ')} (${((Date.now() - t0) / 60_000).toFixed(1)} min)`);
  for (const s of probeStats(res)) console.log(`  ${s.probe.padEnd(7)} quoted ${s.quoted} contract-h, ${s.contracts} ct filled (${s.perHour}/h), markout ${s.markoutC}c, settled ${s.settledC}c a contract, $${s.pnlUsd} (${s.n} fills)`);
}

if (process.argv[1] && /depthAdversary\.(ts|cjs|js)$/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1); });
