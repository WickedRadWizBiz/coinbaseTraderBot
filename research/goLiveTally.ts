// The meta-model's go-live record, kept across the daily runs (Steven, Oct 28). The recordings hold 20 days and the
// gates want 1,000 held-out settlement windows and 1,000 traded ones, so no single run can show them. A run's
// candidate never trains on its holdout, the newest windows of its dataset (research/trainMetaModel.ts): the holdout
// windows no candidate judged before are added here, with what the candidate's backtest made on them, good results
// and bad, and the gates are judged on everything added so far. The next run's holdout reaches back to the first
// window after the last one added (--holdout-from), so every window is judged once, by the first candidate that
// never trained on it. Only results are kept, not the days: per window its losses and P&L, per run the calibration
// bins.
//
// The history replay's days with Kalshi's real contracts are judged the same way (Steven, Oct 28: "the unseen
// historical data should be played as live trades"): the decision model trains only on the recordings, so every
// replay day before the first recorded day the tally saw (`history.edge`) is one no candidate trained on. Each run
// walks back from there, newest day first, and plays the next days as if live: only Kalshi's real contracts (the
// replay's stand-ins for missing history are dropped) at the worse side of each minute's quotes (the history keeps
// one quote a minute; how the quotes in between are filled in is chosen by research/replayFidelity.ts, and until it
// has chosen, at the worse side of the minute so far: a buy pays the highest ask, a sell gets the lowest bid). Their
// results are kept apart from the recorded days' and the gates read both.

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { MetaModel, type MetaModelParams, type TallyEvidence, type TallyPart } from '../bot/model/metaModel';
import type { DatasetRow } from './buildDataset';
import { hashStr, normals } from './history/historyReplay';
import { repriceRow, rowWeights } from './trainMetaModel';
import { readJson } from '../bot/util/persist';
import { recordingLines } from '../bot/marketdata/recordingFiles';
import { bootstrapMeanCi, deflatedSharpe, dieboldMariano } from './stats';

/** Results older than this before the newest are dropped: a year of windows is about 3 MB. */
export const TALLY_KEEP_DAYS = 365;
/** Time-to-close edges of the calibration slices (s), as bot/model/calibration.ts calibrationSlices. */
const TAU_EDGES = [0, 120, 300, 600, 900, 1800, 3600, Infinity];
const DAY = 86_400_000;

/** A holdout as the candidate predicted it, one entry per row: the window (close time), seconds to close, the model's
 *  probability, the calibrated market's, the mid, the outcome and the row's weight (each contract, or hourly event,
 *  weighs 1 over its snapshots). `cut`: the holdout's first window. */
export interface HoldoutJudged { window: number[]; tauSec: number[]; p: number[]; pMkt: number[]; mid: number[]; y: number[]; w: number[]; cut: number }

/** A window: [close, rows, Σ weight, Σ weight x log loss of the model, of the calibrated market, Σ squared error of
 *  the model, of the mid]. */
export type TallyWindow = [number, number, number, number, number, number, number];
/** A calibration bin: [rows, Σ prediction, Σ outcome, windows]. */
export type TallyBin = [number, number, number, number];

export interface TallyBatch {
  /** When it was added, and the version of the candidate that judged it. */
  at: string;
  model: string;
  /** The windows judged: closing in [from, to] (ms). */
  from: number;
  to: number;
  windows: TallyWindow[];
  /** Calibration bins by the model's probability (0.1 wide) and by time to close. */
  price: TallyBin[];
  tau: TallyBin[];
  /** The backtest's windows in [from, to]: [close, P&L $, contracts]. */
  trades: Array<[number, number, number]>;
  /** Variants the candidate and its backtest tried (the Deflated Sharpe's trials). */
  trials: number;
}

/** History days played as live: `edge` the first recorded day the tally saw (every replay day before it is unseen),
 *  `from` the oldest day played so far, `days` how many were played. */
export interface HistoryTally { edge: string; from?: string; days: number; batches: TallyBatch[] }

/** `through`: the last recorded window judged. */
export interface GoLiveTally { through: number; batches: TallyBatch[]; history?: HistoryTally }

export const readTally = (file: string): GoLiveTally => readJson<GoLiveTally>(file) ?? { through: 0, batches: [] };

const rowLoss = (p: number, y: number) => { const q = Math.min(1 - 1e-9, Math.max(1e-9, p)); return y ? -Math.log(q) : -Math.log(1 - q); };
const sig = (x: number, d = 8) => Number(x.toPrecision(d));
const iso = (t: number) => new Date(t).toISOString();

/** The candidate's holdout windows after `after` (ms), with its backtest's windows among them; undefined when there are
 *  none. */
export function judgeBatch(h: HoldoutJudged, trades: ReadonlyMap<number, { pnl: number; contracts: number }>, o: { after: number; model: string; trials: number; at: string }): TallyBatch | undefined {
  const from = Math.max(o.after + 1, h.cut);
  const byWindow = new Map<number, TallyWindow>();
  const price: TallyBin[] = Array.from({ length: 10 }, () => [0, 0, 0, 0]);
  const tau: TallyBin[] = Array.from({ length: TAU_EDGES.length - 1 }, () => [0, 0, 0, 0]);
  const seen = new Map<TallyBin, Set<number>>();
  const add = (b: TallyBin, p: number, y: number, w: number) => { b[0]++; b[1] += p; b[2] += y; if (!seen.has(b)) seen.set(b, new Set()); seen.get(b)!.add(w); };
  for (let i = 0; i < h.window.length; i++) {
    const w = h.window[i], p = h.p[i], y = h.y[i];
    if (w < from) continue;
    const x = byWindow.get(w) ?? [w, 0, 0, 0, 0, 0, 0];
    x[1]++; x[2] += h.w[i]; x[3] += h.w[i] * rowLoss(p, y); x[4] += h.w[i] * rowLoss(h.pMkt[i], y); x[5] += (p - y) ** 2; x[6] += (h.mid[i] - y) ** 2;
    byWindow.set(w, x);
    add(price[Math.min(9, Math.max(0, Math.floor(p * 10)))], p, y, w);
    const k = TAU_EDGES.findIndex((e, j) => h.tauSec[i] >= e && h.tauSec[i] < TAU_EDGES[j + 1]);
    if (k >= 0) add(tau[k], p, y, w);
  }
  if (!byWindow.size) return undefined;
  for (const [b, s] of seen) b[3] = s.size;
  const windows = [...byWindow.values()].sort((a, b) => a[0] - b[0]).map((x) => x.map((v, j) => (j < 2 ? v : sig(v))) as TallyWindow);
  const to = windows[windows.length - 1][0];
  const bins = (bs: TallyBin[]) => bs.map((b) => [b[0], sig(b[1]), b[2], b[3]] as TallyBin);
  return {
    at: o.at, model: o.model, from, to, windows, price: bins(price), tau: bins(tau),
    trades: [...trades].filter(([w]) => w >= from && w <= to).sort((a, b) => a[0] - b[0]).map(([w, r]) => [w, sig(r.pnl, 6), r.contracts]),
    trials: o.trials,
  };
}

/** The next history days to play as live: the newest `n` replay days with Kalshi's real contracts before the oldest
 *  one played so far (before the edge at first). `firstRecorded`: the recordings' first day, the edge the first time. */
export function nextHistoryDays(kalshiDays: readonly string[], firstRecorded: string | undefined, t: GoLiveTally, n: number): string[] {
  const edge = t.history?.edge ?? firstRecorded;
  if (!edge || n <= 0) return [];
  const before = t.history?.from ?? edge;
  return kalshiDays.filter((d) => d < before && d < edge).sort().slice(-n);
}

/** The tally with history days `days` (played as live, judged as `b`, which is undefined when they held no window). */
export function addHistoryBatch(t: GoLiveTally, edge: string, days: readonly string[], b: TallyBatch | undefined): GoLiveTally {
  if (!days.length) return t;
  const h = t.history ?? { edge, days: 0, batches: [] };
  const from = [...days].sort()[0];
  return { ...t, history: { edge: h.edge, from: h.from && h.from < from ? h.from : from, days: h.days + days.length, batches: b ? [...h.batches, b] : h.batches } };
}

/** A candidate's predictions on rows it never trained on (as research/trainMetaModel.ts judges its holdout). */
export function judgeRows(model: MetaModel, rows: DatasetRow[]): HoldoutJudged {
  if (model.params.tNu !== undefined) rows.forEach((r) => repriceRow(r, model.params.tNu));
  return {
    window: rows.map((r) => r.window), tauSec: rows.map((r) => r.tauSec), p: rows.map((r) => model.predict(r.fx, r.fv)),
    pMkt: rows.map((r) => model.marketProbability(r.mid)), mid: rows.map((r) => r.mid), y: rows.map((r) => r.label),
    w: rowWeights(rows, false), cut: 0,
  };
}

/** How the quotes between Kalshi's minute candles are filled in when a history day is played as live (Steven,
 *  Oct 28: as close to the real market as can be shown): `hold` the minute's quote stands until the next; `requote`
 *  the replay's own (the quote follows the index: research/history/historyReplay.ts requoteBetween); `worst` that, at
 *  the worse side of the minute so far; `noise` that, plus a Brownian bridge in log-odds pinned at the candles, of
 *  `sigma` per square-root second. research/replayFidelity.ts picks the one whose backtest is closest to the real
 *  quotes' on the recorded days (models/replay_fidelity.json); until it has, `worst`. */
export const QUOTE_FILLS = ['hold', 'requote', 'worst', 'noise'] as const;
export type QuoteFill = { how: (typeof QUOTE_FILLS)[number]; sigma?: number };

export function readQuoteFill(modelsDir: string): QuoteFill {
  const f = readJson<{ choice?: QuoteFill }>(path.join(modelsDir, 'replay_fidelity.json'))?.choice;
  return f && (QUOTE_FILLS as readonly string[]).includes(f.how) && (f.how !== 'noise' || (f.sigma ?? 0) > 0) ? f : { how: 'worst' };
}

type Book = { price: number; size: number };
export type Ev = { t: number; k: string; ticker?: string; tickers?: string[]; synth?: number; bids?: Book[]; asks?: Book[]; [key: string]: unknown };
const MIN = 60_000;
const logit = (p: number) => { const q = Math.min(0.995, Math.max(0.005, p)); return Math.log(q / (1 - q)); };

/** The bridge's value `s` ms into a minute (0 at both ends), at the quarter-minute prints the replay quotes at. */
function bridgeAt(ticker: string, minute: number, s: number, sigma: number): number {
  const k = Math.round(s / 15_000);
  if (k <= 0 || k >= 4) return 0;
  const z = normals((hashStr(ticker) ^ minute) >>> 0, 3);
  let x = 0;
  for (let j = 1; j <= k; j++) {
    const prev = (j - 1) * 15, at = j * 15;
    x = x * (60 - at) / (60 - prev) + sigma * Math.sqrt(((at - prev) * (60 - at)) / (60 - prev)) * z[j - 1];
  }
  return x;
}

/** Plays a replay day's records one at a time as the tally does: Kalshi's real contracts only (the stand-ins,
 *  `synth`, are dropped with all their records), the quotes between the minute candles (the books off the minute
 *  marks) filled in as `fill` says. Only quotes already seen count, so the model never reads a later one. */
export function quoteFiller(fill: QuoteFill): (e: Ev) => Ev | undefined {
  const synth = new Set<string>();
  const worst = new Map<string, { minute: number; bid: number; ask: number }>();
  return (e) => {
    if (e.k === 'market' && e.synth && e.ticker) synth.add(e.ticker);
    if (e.ticker && synth.has(e.ticker)) return undefined;
    if (e.k === 'alive' && e.tickers) {
      const tickers = e.tickers.filter((x) => !synth.has(x));
      return tickers.length ? { ...e, tickers } : undefined;
    }
    if (e.k !== 'book' || !e.bids?.length || !e.asks?.length || !e.ticker) return e;
    const minute = Math.floor(e.t / MIN), between = e.t % MIN !== 0;
    if (fill.how === 'hold') return between ? undefined : e;
    if (fill.how === 'noise' && between) {
      const bid = e.bids[0].price, ask = e.asks[0].price, w = Math.max(1, Math.round((ask - bid) * 100));
      const mid = 1 / (1 + Math.exp(-(logit((bid + ask) / 2) + bridgeAt(e.ticker, minute, e.t % MIN, fill.sigma ?? 0))));
      const b = Math.min(99 - w, Math.max(1, Math.round(mid * 100 - w / 2)));
      return { ...e, bids: [{ ...e.bids[0], price: b / 100 }, ...e.bids.slice(1)], asks: [{ ...e.asks[0], price: (b + w) / 100 }, ...e.asks.slice(1)] };
    }
    if (fill.how !== 'worst') return e;
    let w = worst.get(e.ticker);
    if (!w || w.minute !== minute) worst.set(e.ticker, (w = { minute, bid: Infinity, ask: -Infinity }));
    w.bid = Math.min(w.bid, e.bids[0].price); w.ask = Math.max(w.ask, e.asks[0].price);
    return { ...e, bids: [{ ...e.bids[0], price: w.bid }, ...e.bids.slice(1)], asks: [{ ...e.asks[0], price: w.ask }, ...e.asks.slice(1)] };
  };
}

/** A whole day through quoteFiller. */
export function fillQuotes(events: Ev[], fill: QuoteFill): Ev[] {
  const f = quoteFiller(fill);
  return events.map(f).filter((e): e is Ev => e !== undefined);
}

/** One day's file through quoteFiller, a line at a time (a whole recorded day is longer than the longest string V8
 *  allows, so it is never read into one). */
export async function fillDayFile(src: string, dst: string, fill: QuoteFill): Promise<void> {
  const f = quoteFiller(fill);
  const gz = zlib.createGzip({ level: 1 });
  const done = new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(dst);
    out.on('finish', resolve).on('error', reject);
    gz.on('error', reject).pipe(out);
  });
  let buf: string[] = [];
  const flush = async () => {
    if (!buf.length) return;
    const ok = gz.write(buf.join(''));
    buf = [];
    if (!ok) await new Promise((r) => gz.once('drain', r));
  };
  for await (const line of recordingLines(src)) {
    if (!line) continue;
    const e = f(JSON.parse(line) as Ev);
    if (e) buf.push(JSON.stringify(e) + '\n');
    if (buf.length >= 2000) await flush();
  }
  await flush();
  gz.end();
  await done;
}

/** Write the history days into `dir` as the tally plays them (quoteFiller), named as recordings are. */
export async function writeHistoryDays(replayDir: string, days: readonly string[], dir: string, fill: QuoteFill = { how: 'worst' }): Promise<void> {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const d of days) {
    const name = `md-${d}.jsonl.gz`;
    await fillDayFile(path.join(replayDir, name), path.join(dir, name), fill);
  }
}

/** The tally with `b` added; results older than TALLY_KEEP_DAYS before it are dropped. */
export function addBatch(t: GoLiveTally, b: TallyBatch): GoLiveTally {
  return { through: Math.max(t.through, b.to), batches: [...t.batches.filter((x) => x.to >= b.to - TALLY_KEEP_DAYS * DAY), b] };
}

/** What the go-live gates read off the tally, computed as the trainer and the backtest compute them for one holdout
 *  (bot/model/calibration.ts, research/backtest.ts), but with price slices 0.1 wide where one holdout's are equal-mass;
 *  over the recorded days and the history days together, with each source also on its own. Undefined while the tally
 *  is empty. */
export function tallyEvidence(t: GoLiveTally): TallyEvidence | undefined {
  const all = evidenceOf([...t.batches, ...(t.history?.batches ?? [])]);
  if (!all) return undefined;
  const rec = evidenceOf(t.batches), hist = evidenceOf(t.history?.batches ?? []);
  const { pnl: _pnl, ...ev } = all;
  return { ...ev, ...(rec ? { recorded: partOf(rec) } : {}), ...(hist ? { history: partOf(hist) } : {}) };
}

const partOf = (e: TallyEvidence & { pnl: number }): TallyPart => ({
  nWindows: e.nWindows, windowsTraded: e.windowsTraded, days: e.days, brierModel: e.brierModel, brierMarket: e.brierMarket,
  logLossModel: e.logLossModel!, logLossMarketCal: e.logLossMarketCal!, ...(e.netEdgeCiLow !== undefined ? { netEdgeCiLow: e.netEdgeCiLow } : {}), pnl: e.pnl,
});

function evidenceOf(batches: TallyBatch[]): (TallyEvidence & { pnl: number }) | undefined {
  const ws = batches.flatMap((b) => b.windows).sort((a, b) => a[0] - b[0]);
  if (!ws.length) return undefined;
  let n = 0, sw = 0, lm = 0, lc = 0, bm = 0, bk = 0;
  for (const x of ws) { n += x[1]; sw += x[2]; lm += x[3]; lc += x[4]; bm += x[5]; bk += x[6]; }
  const dm = dieboldMariano(ws.map((x) => (x[3] - x[4]) / x[2]));
  const sum = (bss: TallyBin[][]) => bss[0].map((_, k) => bss.reduce((a, bs) => a.map((v, j) => v + bs[k][j]) as TallyBin, [0, 0, 0, 0] as TallyBin));
  const price = sum(batches.map((b) => b.price));
  const tau = sum(batches.map((b) => b.tau));
  const err = (b: TallyBin) => Math.abs(b[2] / b[0] - b[1] / b[0]) * 100;
  // Reliability: the largest bucket error over buckets of 30+ rows. Slices: the error beyond 1.96 standard errors,
  // with the windows as the sample size (a window's snapshots share one outcome), over slices of 30+ windows.
  const calErr = Math.max(-Infinity, ...price.filter((b) => b[0] >= 30).map(err));
  const excess = Math.max(-Infinity, ...[...price, ...tau].filter((b) => b[3] >= 30).map((b) => {
    const mp = b[1] / b[0];
    return Math.max(0, err(b) - 196 * Math.sqrt(Math.max(1e-6, mp * (1 - mp)) / b[3]));
  }));
  const trades = batches.flatMap((b) => b.trades).sort((a, b) => a[0] - b[0]);
  const traded = trades.filter((x) => x[2] > 0);
  const edge = traded.length ? bootstrapMeanCi(traded.map((x) => x[1] / x[2])) : undefined;
  const dsr = trades.length > 2 ? deflatedSharpe(trades.map((x) => x[1]), Math.max(1, ...batches.map((b) => b.trials))) : undefined;
  const r = (x: number) => sig(x, 6);
  return {
    nWindows: ws.length,
    windowsTraded: traded.length,
    days: new Set(ws.map((x) => iso(x[0]).slice(0, 10))).size,
    models: new Set(batches.map((b) => b.model)).size,
    from: iso(ws[0][0]),
    through: iso(ws[ws.length - 1][0]),
    brierModel: r(bm / n),
    brierMarket: r(bk / n),
    maxCalibrationErrorPp: Number.isFinite(calErr) ? r(calErr) : 100,
    logLossModel: r(lm / sw),
    logLossMarketCal: r(lc / sw),
    dmPValue: Number.isFinite(dm.pValue) ? r(dm.pValue) : 1,
    maxExcessCalibrationPp: Number.isFinite(excess) ? r(excess) : 100,
    ...(edge && Number.isFinite(edge.lo) ? { netEdgeCiLow: r(edge.lo) } : {}),
    ...(dsr ? { deflatedSharpe: r(dsr.excess), dsrProbability: r(dsr.probability) } : {}),
    pnl: r(trades.reduce((a, x) => a + x[1], 0)),
  };
}

/** Put the tally's evidence in the candidate file's validation report, with `passed` as the gates judge it (the tally,
 *  and the candidate's own holdout against the calibrated market: bot/model/metaModel.ts liveBlockers). */
export function annotateTally(file: string, ev: TallyEvidence): { passed: boolean; blockers: string[] } {
  const params = JSON.parse(fs.readFileSync(file, 'utf8')) as MetaModelParams;
  if (!params.validation) return { passed: false, blockers: ['model has no validation report'] };
  params.validation = { ...params.validation, tally: ev, passed: true };
  const blockers = MetaModel.fromJson(JSON.stringify(params)).liveBlockers();
  params.validation.passed = blockers.length === 0;
  fs.writeFileSync(file, JSON.stringify(params, null, 2) + '\n');
  return { passed: params.validation.passed, blockers };
}
