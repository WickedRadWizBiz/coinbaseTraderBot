// The meta-model's go-live record, kept across the daily runs (Steven, Oct 28). The recordings hold 20 days and the
// gates want 1,000 held-out settlement windows and 1,000 traded ones, so no single run can show them. A run's
// candidate never trains on its holdout, the newest windows of its dataset (research/trainMetaModel.ts): the holdout
// windows no candidate judged before are added here, with what the candidate's backtest made on them, good results
// and bad, and the gates are judged on everything added so far. The next run's holdout reaches back to the first
// window after the last one added (--holdout-from), so every window is judged once, by the first candidate that
// never trained on it. Only results are kept, not the days: per window its losses and P&L, per run the calibration
// bins.

import fs from 'fs';
import { MetaModel, type MetaModelParams, type TallyEvidence } from '../bot/model/metaModel';
import { readJson } from '../bot/util/persist';
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

/** `through`: the last window judged. */
export interface GoLiveTally { through: number; batches: TallyBatch[] }

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

/** The tally with `b` added; results older than TALLY_KEEP_DAYS before it are dropped. */
export function addBatch(t: GoLiveTally, b: TallyBatch): GoLiveTally {
  return { through: Math.max(t.through, b.to), batches: [...t.batches.filter((x) => x.to >= b.to - TALLY_KEEP_DAYS * DAY), b] };
}

/** What the go-live gates read off the tally, computed as the trainer and the backtest compute them for one holdout
 *  (bot/model/calibration.ts, research/backtest.ts), but with price slices 0.1 wide where one holdout's are equal-mass;
 *  undefined while the tally is empty. */
export function tallyEvidence(t: GoLiveTally): TallyEvidence | undefined {
  const ws = t.batches.flatMap((b) => b.windows).sort((a, b) => a[0] - b[0]);
  if (!ws.length) return undefined;
  let n = 0, sw = 0, lm = 0, lc = 0, bm = 0, bk = 0;
  for (const x of ws) { n += x[1]; sw += x[2]; lm += x[3]; lc += x[4]; bm += x[5]; bk += x[6]; }
  const dm = dieboldMariano(ws.map((x) => (x[3] - x[4]) / x[2]));
  const sum = (bss: TallyBin[][]) => bss[0].map((_, k) => bss.reduce((a, bs) => a.map((v, j) => v + bs[k][j]) as TallyBin, [0, 0, 0, 0] as TallyBin));
  const price = sum(t.batches.map((b) => b.price));
  const tau = sum(t.batches.map((b) => b.tau));
  const err = (b: TallyBin) => Math.abs(b[2] / b[0] - b[1] / b[0]) * 100;
  // Reliability: the largest bucket error over buckets of 30+ rows. Slices: the error beyond 1.96 standard errors,
  // with the windows as the sample size (a window's snapshots share one outcome), over slices of 30+ windows.
  const calErr = Math.max(-Infinity, ...price.filter((b) => b[0] >= 30).map(err));
  const excess = Math.max(-Infinity, ...[...price, ...tau].filter((b) => b[3] >= 30).map((b) => {
    const mp = b[1] / b[0];
    return Math.max(0, err(b) - 196 * Math.sqrt(Math.max(1e-6, mp * (1 - mp)) / b[3]));
  }));
  const trades = t.batches.flatMap((b) => b.trades).sort((a, b) => a[0] - b[0]);
  const traded = trades.filter((x) => x[2] > 0);
  const edge = traded.length ? bootstrapMeanCi(traded.map((x) => x[1] / x[2])) : undefined;
  const dsr = trades.length > 2 ? deflatedSharpe(trades.map((x) => x[1]), Math.max(1, ...t.batches.map((b) => b.trials))) : undefined;
  const r = (x: number) => sig(x, 6);
  return {
    nWindows: ws.length,
    windowsTraded: traded.length,
    days: new Set(ws.map((x) => iso(x[0]).slice(0, 10))).size,
    models: t.batches.length,
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
