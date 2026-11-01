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
//       [--out data/models/replay_fidelity.json] [--depth-model depth_model.json] [--only <fill-in>] [--stage all|prepare|backtest --how <real|fill-in>|compare --work <dir>]

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { loadConfig, paperEnv } from '../bot/config';
import { OrderBook } from '../bot/marketdata/orderBook';
import { linkDays, recordingFiles, recordingLines, type RecordingDay } from '../bot/marketdata/recordingFiles';
import { contractKind, type MarketKind } from '../bot/model/fairValue';
import { backtestMain } from './backtest';
import { fillDayFile, QUOTE_FILLS, type Ev, type QuoteFill } from './goLiveTally';
import { readDepthModel, type DepthModel } from './history/depthSim';
import { probeDays, probeStats, type AdversaryOut } from './depthAdversary';
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

/** What the prepare stage hands the backtests and the comparison (`<work>/meta.json`). */
interface FidelityMeta { days: string[]; files: string[]; warm?: string; res: Residuals[]; sigmaAll: number }

const elapsed = (t0: number) => `${((Date.now() - t0) / 60_000).toFixed(1)} min`;

/** The newest `n` whole recorded days (today's is still being recorded), and of them the `part`-th of `parts` runs of
 *  days in a row: each part is backtested on a runner of its own, from the day before it. */
export function sliceDays(rec: string, n: number, part: number, parts: number) {
  const today = new Date().toISOString().slice(0, 10);
  const all = recordingFiles(rec).filter((d) => d.day < today);
  const newest = all.slice(-n);
  if (newest.length < 2) throw new Error(`need at least 2 whole recorded days, have ${newest.length}`);
  const per = Math.ceil(newest.length / parts);
  const days = newest.slice(part * per, (part + 1) * per);
  if (!days.length) throw new Error(`part ${part} of ${parts} has no days (${newest.length} day(s))`);
  return { all, days, warm: all[all.indexOf(days[0]) - 1] };
}

/** A window's day: the day its contract closed in (UTC; one closing at midnight belongs to the day before). */
const dayOfWindow = (closeTime: number) => new Date(closeTime - 1).toISOString().slice(0, 10);
/** The windows of these days only (the day read before them warms the bot up and is not compared). */
export const onDays = (w: Windows, days: readonly string[]): Windows => new Map([...w].filter(([k]) => days.includes(dayOfWindow(k))));

/** Cut the newest `n` whole recorded days down to the history's minute candles and write each fill-in's folder under
 *  `work` (one per QUOTE_FILLS), with meta.json for the later stages. */
async function prepare(rec: string, n: number, work: string, fills: readonly QuoteFill['how'][], depth?: DepthModel, part = 0, parts = 1): Promise<FidelityMeta> {
  const { all, days } = sliceDays(rec, n, part, parts);
  fs.rmSync(work, { recursive: true, force: true });
  const dirs = Object.fromEntries(['history', ...fills].map((k) => [k, path.join(work, k)]));
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const res: Residuals[] = [];
  const t0 = Date.now();
  // The day before is read first, for the contracts and books still open at midnight; it is not compared, but the real
  // replay reads it too, so both start from the same state.
  const carry = newCarry();
  const warm = all[all.indexOf(days[0]) - 1];
  if (warm) await asHistory(warm, undefined, carry);
  for (const d of days) {
    res.push(await asHistory(d, path.join(dirs.history, `md-${d.day}.jsonl.gz`), carry));
    console.log(`[fidelity] ${d.day}: cut down to the history's minute candles and filled back in (${elapsed(t0)})`);
  }
  // Each day's fill-ins; the bridge's size from the other days.
  const sigmaAll = bridgeSigma(res);
  for (let i = 0; i < days.length; i++) {
    const name = `md-${days[i].day}.jsonl.gz`;
    const sigma = bridgeSigma(res.filter((_, j) => j !== i));
    for (const how of fills) await fillDayFile(path.join(dirs.history, name), path.join(dirs[how], name), { how, sigma }, depth);
  }
  console.log(`[fidelity] fill-ins written (${elapsed(t0)})`);
  fs.rmSync(dirs.history, { recursive: true, force: true });
  const meta: FidelityMeta = { days: days.map((d) => d.day), files: [...(warm ? [warm] : []), ...days].map((d) => path.basename(d.file)), warm: warm?.day, res, sigmaAll };
  fs.writeFileSync(path.join(work, 'meta.json'), JSON.stringify(meta));
  return meta;
}

/** The real recordings the prepare stage used, linked into `<work>/real`. */
function realDir(rec: string, work: string, meta: FidelityMeta): string {
  const dir = path.join(work, 'real');
  fs.rmSync(dir, { recursive: true, force: true });
  linkDays(meta.files.map((f) => ({ day: '', file: path.join(rec, f) })), dir);
  return dir;
}

export type Windows = Awaited<ReturnType<typeof backtestMain>>['windows'];

/** The decision model's backtest on one folder of days, as the pipeline runs it for the decision model
 *  (research/pipeline.ts, mlp): the production exit settings, the vol forecast and the fill model next to the model. */
export async function backtestDir(dir: string, model: string, extra: Record<string, string> = {}): Promise<Windows> {
  const cfg = loadConfig(paperEnv(process.env));
  const models = path.dirname(model);
  const opt = (f: string) => (fs.existsSync(path.join(models, f)) ? path.join(models, f) : '');
  const fixed: Record<string, string> = {
    model, exits: cfg.strategy.exitPolicy, 'vol-model': cfg.strategy.volModel ? opt('vol_model.json') : '', 'fill-model': opt('fill_model.json'),
    'hunt-grid': String(cfg.strategy.huntTargetMargin), 'hunt-confluence': String(cfg.strategy.huntMinConfluence),
    'ratchet-fill-grid': String(cfg.strategy.ratchetMinFillRatio), 'ratchet-age': String(cfg.strategy.ratchetMinWallAgeSec), 'ratchet-slip': String(cfg.strategy.ratchetSlippageTicks),
    // The paper bot's pool is topped back up when it runs dry (bot/training/supervisor.ts): without it a losing replay goes
    // broke on its first day ($10-$20 orders on a $200 pool) and trades nothing after.
    refill: String(cfg.paperBankrollUsd),
    ...extra,
  };
  const t0 = Date.now();
  const { windows: w, result: r } = await backtestMain((k, d) => (k === 'recordings' ? dir : k in fixed ? fixed[k] : d), false);
  console.log(`[fidelity] backtest on ${path.basename(dir)}: ${w.size} windows (${elapsed(t0)})`);
  // Why a backtest traded what it did (counts only): the entry evaluations, the orders sent, the fills, and the risk
  // gateway's commonest refusals.
  const refused = Object.entries(r.paper?.rejected ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k} x${n}`).join('; ');
  console.log(`[fidelity] ${path.basename(dir)}: ${r.entryEvaluations} entry evaluations, ${r.latency?.sent ?? 0} orders sent, ${r.fills} fills, ${r.contracts} contracts, optimal-f bound ${r.optimalFBound ?? 0}, refills ${r.refills?.length ?? 0} ($${(r.refills ?? []).reduce((a, x) => a + x.usd, 0).toFixed(2)})${refused ? ` | refused: ${refused}` : ''}`);
  // Which windows it traded and when (counts only): a backtest that stops early, or trades only outside the compared days,
  // shows here.
  const byHour = Object.entries(r.contractsByHour ?? {}).sort(([a], [b]) => a.localeCompare(b));
  console.log(`[fidelity] ${path.basename(dir)}: ${r.trades.length} settled positions; traded hours ${byHour.length ? `${byHour[0][0]}h to ${byHour[byHour.length - 1][0]}h` : 'none'} (${byHour.map(([h, n]) => `${h.slice(11)}:${Math.round(n)}`).join(' ')})`);
  console.log(`[fidelity] ${path.basename(dir)} windows: ${[...w].filter(([, x]) => x.contracts > 0).slice(0, 30).map(([k, x]) => `${Number.isFinite(k) ? new Date(k).toISOString().slice(5, 16) : String(k)} ${Math.round(x.contracts)}ct $${x.pnl.toFixed(2)}`).join('; ')}`);
  const rej = Object.entries(r.exchangeRejected ?? {}).map(([k, n]) => `${k} x${n}`).join('; ');
  console.log(`[fidelity] ${path.basename(dir)} at the end: cash $${r.end?.balance.toFixed(2)}, ${r.end?.openPositions} open positions (worst loss $${r.end?.openMaxLoss.toFixed(2)}), ${r.end?.openOrders} resting orders${rej ? ` | exchange refused: ${rej}` : ''}${r.makerMarkout ? ` | maker fills' 60 s markout ${(r.makerMarkout.mean * 100).toFixed(2)}c a contract (${r.makerMarkout.n})` : ''}`);
  console.log(`[fidelity] ${path.basename(dir)} entry funnel: ${Object.entries(r.funnel ?? {}).map(([k, n]) => `${k} ${n}`).join('; ')}`);
  return w;
}

const writeWindows = (file: string, w: Windows) => fs.writeFileSync(file, JSON.stringify([...w.entries()]));
const readWindows = (file: string): Windows => new Map(JSON.parse(fs.readFileSync(file, 'utf8')));

/** The fill-ins' backtests against the real one, written to `out`. */
function compare(meta: FidelityMeta, real: Windows, variants: Record<string, Windows>, model: string, out: string): { choice: QuoteFill; rows: FidelityRow[] } {
  const rows = compareWindows(real, variants);
  const best = [...rows].sort((a, b) => a.rmseUsd - b.rmseUsd)[0];
  const choice: QuoteFill = best.how === 'noise' ? { how: 'noise', sigma: +meta.sigmaAll.toPrecision(6) } : { how: best.how as QuoteFill['how'] };
  const realPnl = [...real.values()].reduce((a, x) => a + x.pnl, 0);
  // Without a real baseline there is nothing to be closest to: no verdict (it would still pick a fill-in and send it).
  if (![...real.values()].some((x) => x.contracts > 0)) throw new Error('the backtest on the real quotes traded no window: no verdict');
  const report = {
    at: new Date().toISOString(), days: meta.days, model: path.basename(model),
    real: { pnl: +realPnl.toFixed(4), windowsTraded: [...real.values()].filter((x) => x.contracts > 0).length },
    variants: rows, bridgeSigma: +meta.sigmaAll.toPrecision(6), residualPoints: meta.res.reduce((a, r) => a + r.n, 0), choice,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(`${out}.tmp`, JSON.stringify(report, null, 1));
  fs.renameSync(`${out}.tmp`, out);
  console.table([{ how: 'real', ...report.real }, ...rows]);
  console.log(`[fidelity] closest to the real quotes: ${choice.how}${choice.sigma ? ` (bridge ${choice.sigma} log-odds per root second)` : ''}`);
  return { choice, rows };
}

/** `--stage all` (the default) runs everything in one process. The workflow splits it so the five backtests run on
 *  runners of their own: `--stage prepare` (the fill-in folders and meta.json under --work), `--stage backtest --how
 *  <real|fill-in>` (that backtest's windows to <work>/windows-<how>.json), `--stage compare` (the verdict). */
export async function replayFidelityMain(argOf: (k: string, d: string) => string = cliArg): Promise<{ choice: QuoteFill; rows: FidelityRow[] } | undefined> {
  const rec = argOf('recordings', 'data/recordings');
  const model = argOf('model', 'data/models/model.json');
  const out = argOf('out', 'data/models/replay_fidelity.json');
  const n = Number(argOf('days', '4'));
  const work = argOf('work', path.join(path.dirname(out), 'work', 'replay-fidelity'));
  const stage = argOf('stage', 'all');
  const readMeta = (): FidelityMeta => JSON.parse(fs.readFileSync(path.join(work, 'meta.json'), 'utf8'));
  // The real days without the prepare stage's meta (a runner of its own): the recordings folder as copied.
  // The depth fill-in's model (research/depthStudy.ts --out), fitted on days other than these; without one it is left out.
  const depthFile = argOf('depth-model', '');
  const depth = depthFile ? readDepthModel(depthFile) : undefined;
  if (depthFile && !depth) throw new Error(`no usable depth model in ${depthFile}`);
  const only = argOf('only', '');
  const fills = QUOTE_FILLS.filter((h) => (h !== 'depth' || depth) && (!only || h === only));
  const parts = Math.max(1, Number(argOf('parts', '1'))), part = Number(argOf('part', '0'));
  const sliced = (): FidelityMeta => { const { days, warm } = sliceDays(rec, n, part, parts); return { days: days.map((d) => d.day), files: [...(warm ? [warm] : []), ...days].map((d) => path.basename(d.file)), warm: warm?.day, res: [], sigmaAll: 0 }; };
  const dirOf = (how: string) => (how !== 'real' ? path.join(work, how) : realDir(rec, work, fs.existsSync(path.join(work, 'meta.json')) ? readMeta() : sliced()));
  if (stage === 'prepare') { await prepare(rec, n, work, fills, depth, part, parts); return undefined; }
  if (stage === 'backtest') {
    const how = argOf('how', '');
    if (how !== 'real' && !(QUOTE_FILLS as readonly string[]).includes(how)) throw new Error(`--how must be real or one of ${QUOTE_FILLS.join(', ')}`);
    const w = await backtestDir(dirOf(how), model);
    // The real backtest's runner has no prepare stage, so nothing has made the folder yet.
    fs.mkdirSync(work, { recursive: true });
    writeWindows(path.join(work, parts > 1 ? `windows-${how}-p${part}.json` : `windows-${how}.json`), onDays(w, sliced().days));
    return undefined;
  }
  // The adversary's probes on the real books or a fill-in (research/depthAdversary.ts), on this part's days only.
  if (stage === 'adversary') {
    const how = argOf('how', '');
    if (how !== 'real' && !(QUOTE_FILLS as readonly string[]).includes(how)) throw new Error(`--how must be real or one of ${QUOTE_FILLS.join(', ')}`);
    const days = sliced().days, t0 = Date.now();
    const res = await probeDays(dirOf(how), days);
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, parts > 1 ? `adversary-${how}-p${part}.json` : `adversary-${how}.json`), JSON.stringify({ how, days: res } satisfies AdversaryOut));
    console.log(`[fidelity] adversary on ${how} (${elapsed(t0)}): ${probeStats(res).map((x) => `${x.probe} ${x.perHour}/h, markout ${x.markoutC}c, settled ${x.settledC}c (${x.n})`).join(' | ')}`);
    return undefined;
  }
  if (stage === 'compare') {
    // Each fill-in whose backtest came back.
    // Each fill-in whose backtests all came back (one file, or one per part: windows-<how>-p<k>.json).
    const files = fs.readdirSync(work);
    const metas = files.filter((f) => /^meta(-p\d+)?\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(work, f), 'utf8')) as FidelityMeta);
    const res = metas.flatMap((m) => m.res);
    const meta: FidelityMeta = { ...metas[0], days: [...new Set(metas.flatMap((m) => m.days))].sort(), res, sigmaAll: metas.length > 1 ? bridgeSigma(res) : metas[0].sigmaAll };
    const nParts = Math.max(1, metas.length);
    const load = (how: string): Windows | undefined => {
      const mine = files.filter((f) => new RegExp(`^windows-${how}(-p\\d+)?\\.json$`).test(f));
      if (!mine.length || (mine.some((f) => /-p\d+\.json$/.test(f)) && mine.length < nParts)) return undefined;
      return onDays(new Map(mine.flatMap((f) => [...readWindows(path.join(work, f))])), meta.days);
    };
    const real = load('real');
    if (!real) throw new Error('the real backtest did not come back (every part is needed)');
    const variants = Object.fromEntries(QUOTE_FILLS.map((how) => [how, load(how)] as const).filter((x): x is [QuoteFill['how'], Windows] => !!x[1]));
    return compare(meta, real, variants, model, out);
  }
  if (stage !== 'all') throw new Error(`unknown --stage ${stage}`);
  const meta = await prepare(rec, n, work, fills, depth);
  const real = onDays(await backtestDir(dirOf('real'), model), meta.days);
  const variants: Record<string, Windows> = {};
  for (const how of fills) variants[how] = onDays(await backtestDir(dirOf(how), model), meta.days);
  const r = compare(meta, real, variants, model, out);
  fs.rmSync(work, { recursive: true, force: true });
  return r;
}

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) replayFidelityMain().catch((e) => { console.error(e); process.exit(1); });
