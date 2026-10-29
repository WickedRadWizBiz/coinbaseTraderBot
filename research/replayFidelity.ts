// How true to life the history replay's Kalshi quotes are, measured on the bot's own recordings (Steven, Oct 28: fill in
// the quotes between Kalshi's minute candles the way that comes out closest to the real market, and check it first).
//
// Kalshi's history keeps one quote a minute per contract (the candle's closing bid and ask, stamped at the minute's end)
// and the minute's volume at its last price; the recordings hold every quote. Each recorded day is cut down to exactly
// what the history would hold and filled back in each way research/goLiveTally.ts can play a history day
// (QUOTE_FILLS): the minute's quote standing (hold), following the index as the replay does (requote: the same
// research/history/historyReplay.ts requoteBetween, on the recorded index), that at the worse side of the minute so far
// (worst), and that plus a Brownian bridge in log-odds pinned at the candles (noise), its size measured on the other
// recorded days (never on the day it is used on). The decision model's backtest on each is compared with its
// backtest on the real quotes, settlement window by settlement window; the fill-in whose P&L lands closest (root mean
// square error per window) is written to models/replay_fidelity.json, which the tally reads. This is the check banks
// run on a synthetic market before trusting it: rebuild data you have in full from the coarse form, and measure the
// strategy's error against the full data, out of sample.
//
// Only the quotes are tested: the history's index is itself bridged between 1-minute bars, the recordings' is real.
//
//   npm run research:replay-fidelity -- --recordings data/recordings --model data/models/model.json [--days 4]
//       [--out data/models/replay_fidelity.json]

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { loadConfig, paperEnv } from '../bot/config';
import { OrderBook } from '../bot/marketdata/orderBook';
import { recordingFiles, recordingLines, type RecordingDay } from '../bot/marketdata/recordingFiles';
import { contractKind, type MarketKind } from '../bot/model/fairValue';
import { backtestMain } from './backtest';
import { fillDayFile, QUOTE_FILLS, type Ev, type QuoteFill } from './goLiveTally';
import { gkVariance, requoteBetween } from './history/historyReplay';

const MIN = 60_000, SLOT = 15_000, DAY = 86_400_000;
const SLOTS = DAY / SLOT;
/** The replay's market volatility half-life (bars), research/history/historyReplay.ts MARKET_HALF_LIFE. */
const MARKET_HALF_LIFE = 60;
const logit = (p: number) => { const q = Math.min(0.995, Math.max(0.005, p)); return Math.log(q / (1 - q)); };

interface Mkt { ticker: string; asset: string; kind: MarketKind; strike: number | null; cap: number | null; openTime: number; closeTime: number }
/** A residual sum for the bridge's size: Σ (real log-odds - requoted log-odds)², Σ the bridge's variance factor
 *  s (60 - s) / 60 at the same points (s in seconds into the minute), and how many. */
export interface Residuals { r2: number; f: number; n: number }

/** What carries from one recorded day to the next: the contracts listed, their books, the index and its volatility. */
export interface DayCarry { markets: Map<string, Mkt>; books: Map<string, OrderBook>; idx: Map<string, { v?: number; bar?: { m: number; o: number; h: number; l: number; c: number }; vMkt?: number }> }
export const newCarry = (): DayCarry => ({ markets: new Map(), books: new Map(), idx: new Map() });

/** A recorded day cut down to what Kalshi's history would hold and filled in as the history replay does (requote),
 *  written to `out` (without `out`, the day is only read for what carries into the next); with the residuals of the
 *  requoted quotes against the real ones. */
export async function asHistory(day: RecordingDay, out: string | undefined, carry: DayCarry): Promise<Residuals> {
  const d0 = Date.parse(`${day.day}T00:00:00Z`);
  const { markets, books, idx } = carry;
  const candles = new Map<string, Array<{ t: number; bid: number; ask: number }>>();
  const vol = new Map<string, { t: number; n: number; last: number }>();
  const realMid = new Map<string, Float32Array>();
  const ixs = new Map<string, Float64Array>(), sgs = new Map<string, Float64Array>();
  const aMkt = 1 - Math.pow(0.5, 1 / MARKET_HALF_LIFE);
  let slot = -1;
  const toSlot = (t: number) => Math.floor((t - d0) / SLOT);
  // Every 15 s print slot reached (before the records at or after it): the index and its volatility there, each
  // contract's real mid, and at each minute mark the candle's close.
  const advance = (t: number) => {
    const upTo = Math.min(SLOTS - 1, toSlot(t));
    for (let s = slot + 1; s <= upTo; s++) {
      if (s < 0) continue;
      const at = d0 + s * SLOT;
      for (const [a, x] of idx) {
        if (x.v === undefined) continue;
        if (!ixs.has(a)) { ixs.set(a, new Float64Array(SLOTS)); sgs.set(a, new Float64Array(SLOTS).fill(NaN)); }
        ixs.get(a)![s] = x.v;
        sgs.get(a)![s] = x.vMkt && x.vMkt > 0 ? Math.sqrt(x.vMkt) : NaN;
      }
      for (const [tk, m] of markets) {
        if (at < m.openTime || at > m.closeTime) continue;
        const b = books.get(tk)?.bestBid()?.price, k = books.get(tk)?.bestAsk()?.price;
        if (b === undefined || k === undefined || !(k > b)) continue;
        if (!realMid.has(tk)) realMid.set(tk, new Float32Array(SLOTS).fill(NaN));
        realMid.get(tk)![s] = (b + k) / 2;
        if (s % 4 === 0) { const c = candles.get(tk) ?? []; c.push({ t: at, bid: b, ask: k }); candles.set(tk, c); }
      }
    }
    if (upTo > slot) slot = upTo;
  };
  for await (const line of recordingLines(day.file)) {
    if (!line) continue;
    let e: Ev & Record<string, any>;
    try { e = JSON.parse(line); } catch { continue; }
    advance(e.t);
    if (e.k === 'market' && e.ticker && e.asset) {
      markets.set(e.ticker, { ticker: e.ticker, asset: e.asset, kind: e.kind ?? contractKind(e.series ?? ''), strike: e.strike ?? null, cap: e.cap ?? null, openTime: e.openTime, closeTime: e.closeTime });
    } else if (e.k === 'book' && e.ticker) {
      const b = books.get(e.ticker) ?? new OrderBook(e.ticker); books.set(e.ticker, b);
      b.applySnapshot({ bids: e.bids ?? [], asks: e.asks ?? [] }, e.t);
    } else if (e.k === 'delta' && e.ticker) {
      const b = books.get(e.ticker) ?? new OrderBook(e.ticker); books.set(e.ticker, b);
      b.applyDelta(e.side, e.price, e.delta, e.t);
    } else if (e.k === 'trade' && e.ticker && e.price !== undefined) {
      // The candle the trade falls in: the minute ending at or after it.
      const end = Math.ceil((e.ts ?? e.t) / MIN) * MIN, key = `${e.ticker}|${end}`;
      const v = vol.get(key) ?? { t: end, n: 0, last: e.price };
      v.n += e.count ?? 0; v.last = e.price; vol.set(key, v);
    } else if (e.k === 'index' && e.asset && e.value > 0) {
      const x = idx.get(e.asset) ?? {}; idx.set(e.asset, x);
      x.v = e.value;
      const m = Math.floor(e.t / MIN);
      if (x.bar && x.bar.m !== m) {
        // This bar's variance feeds the estimates from the next bar on (causal), as the replay's.
        const g = gkVariance(x.bar) / 60;
        x.vMkt = x.vMkt === undefined ? g : x.vMkt + aMkt * (g - x.vMkt);
        x.bar = undefined;
      }
      if (!x.bar) x.bar = { m, o: e.value, h: e.value, l: e.value, c: e.value };
      else { x.bar.h = Math.max(x.bar.h, e.value); x.bar.l = Math.min(x.bar.l, e.value); x.bar.c = e.value; }
    }
  }
  advance(d0 + DAY);
  // Contracts settled by midnight do not carry into the next day.
  const settled = [...markets.values()].filter((m) => m.closeTime < d0 + DAY);
  const forget = () => { for (const m of settled) { markets.delete(m.ticker); books.delete(m.ticker); } };
  const res: Residuals = { r2: 0, f: 0, n: 0 };
  if (!out) { forget(); return res; }

  // The history's records for each contract, as research/history/historyReplay.ts writes them from the candles.
  const gen: Ev[] = [];
  const quoted = new Set<string>();
  for (const [tk, cs] of candles) {
    const m = markets.get(tk)!;
    const ix = ixs.get(m.asset), sg = sgs.get(m.asset);
    if (!ix || !sg) continue;
    quoted.add(tk);
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      gen.push({ t: c.t, k: 'book', ticker: tk, bids: [{ price: c.bid, size: 100 }], asks: [{ price: c.ask, size: 100 }], ts: c.t });
      const mid = (c.bid + c.ask) / 2, until = Math.min(cs[i + 1]?.t ?? m.closeTime, m.closeTime);
      if (mid >= 0.03 && mid <= 0.97) for (let at = c.t + SLOT; at < until; at += SLOT) gen.push({ t: at, k: 'alive', tickers: [tk] });
      requoteBetween(gen as any, { ticker: tk, kind: m.kind, strike: m.strike, cap: m.cap, closeTime: m.closeTime }, c.bid, c.ask, c.t, until, d0, ix, sg);
      const v = vol.get(`${tk}|${c.t}`);
      if (v && v.n > 0) gen.push({ t: c.t, k: 'trade', ticker: tk, price: v.last, count: v.n, ts: c.t - 1 });
    }
  }
  gen.sort((a, b) => a.t - b.t);
  forget();

  // The bridge's size: the requoted quotes against the real mids at the same prints.
  for (const e of gen) {
    if (e.k !== 'book' || e.t % MIN === 0) continue;
    const real = realMid.get(e.ticker!)?.[toSlot(e.t)];
    if (real === undefined || !Number.isFinite(real)) continue;
    const s = (e.t % MIN) / 1000;
    res.r2 += (logit(real) - logit((e.bids![0].price + e.asks![0].price) / 2)) ** 2; res.f += (s * (60 - s)) / 60; res.n++;
  }

  // The day again, with the contracts' own quotes and trades replaced by the history's.
  const gz = zlib.createGzip({ level: 1 });
  const done = new Promise<void>((ok, fail) => gz.pipe(fs.createWriteStream(out)).on('finish', ok).on('error', fail));
  let gi = 0;
  const write = (s: string) => (gz.write(s) ? undefined : new Promise<void>((ok) => gz.once('drain', ok)));
  for await (const line of recordingLines(day.file)) {
    if (!line) continue;
    let e: Ev;
    try { e = JSON.parse(line); } catch { continue; }
    while (gi < gen.length && gen[gi].t <= e.t) await write(JSON.stringify(gen[gi++]) + '\n');
    if ((e.k === 'book' || e.k === 'delta' || e.k === 'trade') && e.ticker && quoted.has(e.ticker)) continue;
    await write(line + '\n');
  }
  while (gi < gen.length) await write(JSON.stringify(gen[gi++]) + '\n');
  gz.end();
  await done;
  return res;
}

/** The bridge's size (per square-root second) from residual sums. */
export const bridgeSigma = (rs: Residuals[]): number => {
  const r2 = rs.reduce((a, r) => a + r.r2, 0), f = rs.reduce((a, r) => a + r.f, 0);
  return f > 0 ? Math.sqrt(r2 / f) : 0;
};

export interface FidelityRow { how: string; pnl: number; windowsTraded: number; biasUsd: number; rmseUsd: number; corr: number }

/** How close each fill-in's backtest is to the real quotes', over the windows either traded. */
export function compareWindows(real: ReadonlyMap<number, { pnl: number; contracts: number }>, variants: Record<string, ReadonlyMap<number, { pnl: number; contracts: number }>>): FidelityRow[] {
  return Object.entries(variants).map(([how, v]) => {
    const ws = [...new Set([...real.keys(), ...v.keys()])].filter((w) => (real.get(w)?.contracts ?? 0) > 0 || (v.get(w)?.contracts ?? 0) > 0);
    const a = ws.map((w) => real.get(w)?.pnl ?? 0), b = ws.map((w) => v.get(w)?.pnl ?? 0);
    const n = Math.max(1, ws.length);
    const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
    let sab = 0, saa = 0, sbb = 0, se = 0;
    for (let i = 0; i < ws.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; se += (b[i] - a[i]) ** 2; }
    const r = (x: number) => +x.toFixed(4);
    return {
      how, pnl: r(b.reduce((x, y) => x + y, 0)), windowsTraded: [...v.values()].filter((x) => x.contracts > 0).length,
      biasUsd: r(b.reduce((x, y) => x + y, 0) - a.reduce((x, y) => x + y, 0)), rmseUsd: r(Math.sqrt(se / n)), corr: saa > 0 && sbb > 0 ? r(sab / Math.sqrt(saa * sbb)) : 0,
    };
  });
}

export async function replayFidelityMain(argOf: (k: string, d: string) => string = cliArg): Promise<{ choice: QuoteFill; rows: FidelityRow[] }> {
  const rec = argOf('recordings', 'data/recordings');
  const model = argOf('model', 'data/models/model.json');
  const out = argOf('out', 'data/models/replay_fidelity.json');
  const n = Number(argOf('days', '4'));
  const work = argOf('work', path.join(path.dirname(out), 'work', 'replay-fidelity'));
  // Whole days only: today's is still being recorded.
  const today = new Date().toISOString().slice(0, 10);
  const all = recordingFiles(rec).filter((d) => d.day < today);
  const days = all.slice(-n);
  if (days.length < 2) throw new Error(`need at least 2 whole recorded days, have ${days.length}`);
  fs.rmSync(work, { recursive: true, force: true });
  const dirs = Object.fromEntries(['real', 'history', ...QUOTE_FILLS].map((k) => [k, path.join(work, k)]));
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const res: Residuals[] = [];
  // The day before is read first, for the contracts and books still open at midnight; it is not compared, but the real
  // replay reads it too, so both start from the same state.
  const carry = newCarry();
  const warm = all[all.length - days.length - 1];
  if (warm) { await asHistory(warm, undefined, carry); fs.symlinkSync(path.resolve(warm.file), path.join(dirs.real, path.basename(warm.file))); }
  for (const d of days) {
    fs.symlinkSync(path.resolve(d.file), path.join(dirs.real, path.basename(d.file)));
    res.push(await asHistory(d, path.join(dirs.history, `md-${d.day}.jsonl.gz`), carry));
    console.log(`[fidelity] ${d.day}: cut down to the history's minute candles and filled back in`);
  }
  // Each day's fill-ins; the bridge's size from the other days.
  const sigmaAll = bridgeSigma(res);
  for (let i = 0; i < days.length; i++) {
    const name = `md-${days[i].day}.jsonl.gz`;
    const sigma = bridgeSigma(res.filter((_, j) => j !== i));
    for (const how of QUOTE_FILLS) await fillDayFile(path.join(dirs.history, name), path.join(dirs[how], name), { how, sigma });
  }
  fs.rmSync(dirs.history, { recursive: true, force: true });
  // The backtest as the pipeline runs it for the decision model (research/pipeline.ts, mlp): the production exit
  // settings, the vol forecast and the fill model next to the model when present.
  const cfg = loadConfig(paperEnv(process.env));
  const models = path.dirname(model);
  const opt = (f: string) => (fs.existsSync(path.join(models, f)) ? path.join(models, f) : '');
  const fixed: Record<string, string> = {
    model, exits: cfg.strategy.exitPolicy, 'vol-model': cfg.strategy.volModel ? opt('vol_model.json') : '', 'fill-model': opt('fill_model.json'),
    'hunt-grid': String(cfg.strategy.huntTargetMargin), 'hunt-confluence': String(cfg.strategy.huntMinConfluence),
    'ratchet-fill-grid': String(cfg.strategy.ratchetMinFillRatio), 'ratchet-age': String(cfg.strategy.ratchetMinWallAgeSec), 'ratchet-slip': String(cfg.strategy.ratchetSlippageTicks),
  };
  const bt = async (dir: string) => (await backtestMain((k, d) => (k === 'recordings' ? dir : k in fixed ? fixed[k] : d), false)).windows;
  const real = await bt(dirs.real);
  const variants: Record<string, Awaited<ReturnType<typeof bt>>> = {};
  for (const how of QUOTE_FILLS) variants[how] = await bt(dirs[how]);
  const rows = compareWindows(real, variants);
  const best = [...rows].sort((a, b) => a.rmseUsd - b.rmseUsd)[0];
  const choice: QuoteFill = best.how === 'noise' ? { how: 'noise', sigma: +sigmaAll.toPrecision(6) } : { how: best.how as QuoteFill['how'] };
  const realPnl = [...real.values()].reduce((a, x) => a + x.pnl, 0);
  const report = {
    at: new Date().toISOString(), days: days.map((d) => d.day), model: path.basename(model),
    real: { pnl: +realPnl.toFixed(4), windowsTraded: [...real.values()].filter((x) => x.contracts > 0).length },
    variants: rows, bridgeSigma: +sigmaAll.toPrecision(6), residualPoints: res.reduce((a, r) => a + r.n, 0), choice,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(`${out}.tmp`, JSON.stringify(report, null, 1));
  fs.renameSync(`${out}.tmp`, out);
  fs.rmSync(work, { recursive: true, force: true });
  console.table([{ how: 'real', ...report.real }, ...rows]);
  console.log(`[fidelity] closest to the real quotes: ${choice.how}${choice.sigma ? ` (bridge ${choice.sigma} log-odds per root second)` : ''}`);
  return { choice, rows };
}

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) replayFidelityMain().catch((e) => { console.error(e); process.exit(1); });
