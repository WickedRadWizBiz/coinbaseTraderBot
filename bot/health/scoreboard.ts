// The scoreboard: every price the bot could trade on, against the Kalshi market, on settled contracts the model never
// saw (the owner, Oct 29: "the right data flowing through the right channels asking the right questions"; the SNN plan's
// phase 0: one daily number per model against the mid, and every later gate reads from it).
//
// At every scheduled evaluation inside a crypto contract's entry window, traded or not, in paper and in live, the
// engine records the contract's prices: the market's calibrated mid, the math fair value, the trained meta-model, the
// bot's final price, the SNN's own probability and the TA network's tilt. When the contract settles each price is
// scored by its log loss (and Brier score). A contract's snapshots are averaged, and so are the contracts of one asset
// closing together: one outcome, one settlement window. Every live prediction precedes its label, so each window is
// out of sample for every model (the daily trainer fits on past recordings; the SNN learns prequentially).
//
// Over the kept windows each price is compared with the market and with the price it refines:
//   - mean log loss saved a window (+ = better than the baseline), a Diebold-Mariano one-sided p (modelHealth.ts),
//   - a day-block bootstrap 95% CI of that mean (days resampled with replacement, seeded: windows of one day share
//     the day's news, so they are not independent), and the verdict it gives: better, worse or undecided.
// The ledger (bot/health/moduleLedger.ts) shows a row per price, /api/modules and the daily module report carry them,
// and the per-day means keep a short history for the report.

import { dmStat, logLoss } from '../model/modelHealth';
import { Xoshiro128 } from '../snn/rng';
import { normCdf } from '../util/num';
import { readJson, writeJsonAtomic } from '../util/persist';

/** The prices scored. `market` is the baseline; `snn_blend` is derived: (1 - a) meta_model + a snn. */
export const SCOREBOARD_PRICES = ['fair_value', 'meta_model', 'bot_price', 'snn', 'snn_blend', 'ta_tilt'] as const;
export type ScoreboardPrice = typeof SCOREBOARD_PRICES[number];
export const SCOREBOARD_LABEL: Record<ScoreboardPrice, string> = {
  fair_value: 'math fair value', meta_model: 'meta-model', bot_price: "the bot's price", snn: 'SNN alone', snn_blend: 'SNN blended at alpha', ta_tilt: 'meta-model + TA tilt',
};
/** What each price is also compared with (the price it refines), besides the market. */
export const SCOREBOARD_REFINES: Partial<Record<ScoreboardPrice, ScoreboardPrice>> = { meta_model: 'fair_value', bot_price: 'meta_model', snn: 'meta_model', snn_blend: 'meta_model', ta_tilt: 'meta_model' };

export interface ScoreboardParams {
  /** Record and score (SCOREBOARD). */
  enabled: boolean;
  /** Settlement windows kept (the oldest drop off). */
  keep: number;
  /** The SNN's weight in the blended price (the component trial's weight, no confidence factor). */
  snnAlpha: number;
  /** Bootstrap resamples for the CI. */
  bootstrap: number;
}

export const DEFAULT_SCOREBOARD: ScoreboardParams = { enabled: true, keep: 3000, snnAlpha: 0.25, bootstrap: 400 };

/** A contract's prices at one evaluation (probabilities of YES); a missing price is not scored. */
export interface PriceSnapshot { market: number; fair_value: number; meta_model: number; bot_price: number; snn?: number; ta_tilt?: number }

type Loss = { ll: number; br: number };
interface Window {
  key: string; closeTs: number; day: string;
  /** Per price (market included): mean log loss and Brier over the window's contracts, each a mean over its snapshots. */
  loss: Partial<Record<ScoreboardPrice | 'market', Loss>>;
  n: number;
}
interface State { windows: Window[] }

export interface Comparison {
  baseline: ScoreboardPrice | 'market';
  /** Windows where both prices were scored. */
  windows: number;
  /** Mean log loss saved a window against the baseline (+ = better); Brier likewise. */
  saved: number | null; brierSaved: number | null;
  pBetter: number | null; pWorse: number | null;
  /** Day-block bootstrap 95% CI of `saved`, and the days it spans. */
  ci: [number, number] | null; days: number;
  verdict: 'better' | 'worse' | 'undecided' | 'too few';
}
export interface ScoreboardRow { price: ScoreboardPrice; label: string; vsMarket: Comparison; vsRefined: Comparison | null }
export interface ScoreboardStatus {
  windows: number; days: number; from: string | null; to: string | null; pending: number;
  rows: ScoreboardRow[];
  /** Per day: windows, and log loss saved a window against the market per price (the report's history). */
  byDay: Array<{ day: string; windows: number } & Partial<Record<ScoreboardPrice, number>>>;
}

const MIN_WINDOWS = 10, MIN_DAYS = 2;
const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const clamp01 = (p: number) => Math.min(1 - 1e-6, Math.max(1e-6, p));

/** Day-block bootstrap percentile CI of the mean of `d` (one value per window) with the windows' days as blocks. */
export function dayBlockCi(d: number[], days: string[], iters: number, level = 0.95): [number, number] | null {
  const byDay = new Map<string, number[]>();
  d.forEach((x, i) => { const l = byDay.get(days[i]); if (l) l.push(x); else byDay.set(days[i], [x]); });
  const blocks = [...byDay.values()];
  if (blocks.length < MIN_DAYS || d.length < MIN_WINDOWS) return null;
  const rng = new Xoshiro128([d.length, blocks.length, 0x5c0eb0a4, 0x1d]);
  const means: number[] = [];
  for (let b = 0; b < iters; b++) {
    let s = 0, n = 0;
    for (let k = 0; k < blocks.length; k++) { const blk = blocks[rng.int(blocks.length)]; for (const x of blk) { s += x; n++; } }
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  const q = (p: number) => means[Math.min(means.length - 1, Math.max(0, Math.floor(p * (means.length - 1))))];
  return [q((1 - level) / 2), q(1 - (1 - level) / 2)];
}

export class Scoreboard {
  private st: State;
  /** ticker -> settlement key and the snapshots waiting for its result. */
  private readonly snaps = new Map<string, { key: string; closeTs: number; rows: PriceSnapshot[] }>();
  private cache?: { n: number; last: string; status: ScoreboardStatus };

  constructor(readonly p: ScoreboardParams = DEFAULT_SCOREBOARD, private readonly file?: string) {
    const saved = file ? readJson<Partial<State>>(file, { quarantine: true }) : undefined;
    this.st = { windows: Array.isArray(saved?.windows) ? saved!.windows : [] };
  }

  /** One evaluation of a contract inside its entry window. */
  record(ticker: string, asset: string, closeTs: number, x: PriceSnapshot, now = Date.now()): void {
    if (!this.p.enabled) return;
    for (const k of ['market', 'fair_value', 'meta_model', 'bot_price'] as const) if (!Number.isFinite(x[k])) return;
    let s = this.snaps.get(ticker);
    if (!s) {
      // Contracts whose result never came (six hours past their close) are dropped.
      if (this.snaps.size >= 500) for (const [t, o] of this.snaps) if (o.closeTs < now - 6 * 3_600_000) this.snaps.delete(t);
      s = { key: `${asset}:${closeTs}`, closeTs, rows: [] };
      this.snaps.set(ticker, s);
    }
    s.rows.push(x);
  }

  /** The contract settled: score its snapshots and fold them into its settlement window. */
  onResult(ticker: string, result: 'yes' | 'no'): void {
    const s = this.snaps.get(ticker);
    if (!s) return;
    this.snaps.delete(ticker);
    const y = result === 'yes' ? 1 : 0;
    const loss: Window['loss'] = {};
    const add = (k: ScoreboardPrice | 'market', p: number | undefined) => {
      if (p === undefined || !Number.isFinite(p)) return;
      const q = clamp01(p);
      const l = loss[k] ?? (loss[k] = { ll: 0, br: 0 });
      l.ll += logLoss(q, y); l.br += (q - y) ** 2;
      (counts[k] = (counts[k] ?? 0) + 1);
    };
    const counts: Partial<Record<ScoreboardPrice | 'market', number>> = {};
    for (const r of s.rows) {
      add('market', r.market); add('fair_value', r.fair_value); add('meta_model', r.meta_model); add('bot_price', r.bot_price);
      add('snn', r.snn); add('ta_tilt', r.ta_tilt);
      if (r.snn !== undefined && Number.isFinite(r.snn)) add('snn_blend', (1 - this.p.snnAlpha) * r.meta_model + this.p.snnAlpha * r.snn);
    }
    for (const k of Object.keys(loss) as Array<keyof typeof loss>) { const n = counts[k]!; loss[k]!.ll /= n; loss[k]!.br /= n; }
    const w = this.st.windows.find((x) => x.key === s.key);
    if (w) {
      // Another contract of the same settlement: the window's loss is the mean over its contracts, price by price.
      for (const k of Object.keys(loss) as Array<keyof typeof loss>) {
        const a = w.loss[k], b = loss[k]!;
        w.loss[k] = a ? { ll: (a.ll * w.n + b.ll) / (w.n + 1), br: (a.br * w.n + b.br) / (w.n + 1) } : b;
      }
      w.n++;
    } else this.st.windows.push({ key: s.key, closeTs: s.closeTs, day: dayOf(s.closeTs), loss, n: 1 });
    this.st.windows.sort((a, b) => a.closeTs - b.closeTs || (a.key < b.key ? -1 : 1));
    if (this.st.windows.length > this.p.keep) this.st.windows = this.st.windows.slice(-this.p.keep);
    this.cache = undefined;
    if (this.file) writeJsonAtomic(this.file, this.st);
  }

  private compare(price: ScoreboardPrice, baseline: ScoreboardPrice | 'market'): Comparison {
    const d: number[] = [], b: number[] = [], days: string[] = [];
    for (const w of this.st.windows) {
      const a = w.loss[price], c = w.loss[baseline];
      if (!a || !c) continue;
      d.push(a.ll - c.ll); b.push(a.br - c.br); days.push(w.day);
    }
    const nDays = new Set(days).size;
    if (d.length < MIN_WINDOWS) return { baseline, windows: d.length, saved: null, brierSaved: null, pBetter: null, pWorse: null, ci: null, days: nDays, verdict: 'too few' };
    const { mean, stat } = dmStat(d);
    const ciRaw = dayBlockCi(d, days, this.p.bootstrap);
    // d = loss of the price minus the baseline's: saved = -d, and the CI flips with it.
    const ci: [number, number] | null = ciRaw ? [-ciRaw[1], -ciRaw[0]] : null;
    const verdict: Comparison['verdict'] = !ci ? 'too few' : ci[0] > 0 ? 'better' : ci[1] < 0 ? 'worse' : 'undecided';
    // As the trials: pBetter small = significantly better (stat far below 0), pWorse small = significantly worse.
    return { baseline, windows: d.length, saved: -mean, brierSaved: -b.reduce((s, x) => s + x, 0) / b.length, pBetter: normCdf(stat), pWorse: 1 - normCdf(stat), ci, days: nDays, verdict };
  }

  status(): ScoreboardStatus {
    const W = this.st.windows;
    const last = W.length ? W[W.length - 1].key : '';
    if (this.cache && this.cache.n === W.length && this.cache.last === last) return { ...this.cache.status, pending: this.snaps.size };
    const r5 = (x: number | null) => (x === null ? null : +x.toFixed(5));
    const round = (c: Comparison): Comparison => ({ ...c, saved: r5(c.saved), brierSaved: r5(c.brierSaved), pBetter: c.pBetter === null ? null : +c.pBetter.toFixed(4), pWorse: c.pWorse === null ? null : +c.pWorse.toFixed(4), ci: c.ci ? [r5(c.ci[0])!, r5(c.ci[1])!] : null });
    const rows: ScoreboardRow[] = SCOREBOARD_PRICES.map((price) => {
      const ref = SCOREBOARD_REFINES[price];
      return { price, label: price === 'snn_blend' ? `SNN blended at ${this.p.snnAlpha}` : SCOREBOARD_LABEL[price], vsMarket: round(this.compare(price, 'market')), vsRefined: ref ? round(this.compare(price, ref)) : null };
    });
    const byDayMap = new Map<string, { windows: number; sum: Partial<Record<ScoreboardPrice, { s: number; n: number }>> }>();
    for (const w of W) {
      const e = byDayMap.get(w.day) ?? { windows: 0, sum: {} };
      e.windows++;
      const m = w.loss.market;
      if (m) for (const k of SCOREBOARD_PRICES) { const a = w.loss[k]; if (!a) continue; const s = e.sum[k] ?? (e.sum[k] = { s: 0, n: 0 }); s.s += m.ll - a.ll; s.n++; }
      byDayMap.set(w.day, e);
    }
    const byDay = [...byDayMap.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-30).map(([day, e]) => {
      const row: ScoreboardStatus['byDay'][number] = { day, windows: e.windows };
      for (const k of SCOREBOARD_PRICES) { const s = e.sum[k]; if (s) row[k] = +(s.s / s.n).toFixed(5); }
      return row;
    });
    const status: ScoreboardStatus = { windows: W.length, days: byDayMap.size, from: W[0]?.day ?? null, to: W[W.length - 1]?.day ?? null, pending: this.snaps.size, rows, byDay };
    this.cache = { n: W.length, last, status };
    return status;
  }
}
