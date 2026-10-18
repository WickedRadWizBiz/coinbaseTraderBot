// Trains the Librarian (bot/ta/librarian.ts): the oracle strategy head and the regime-transition head on every TA
// library reading the TA network reads, walk-forward over the whole history, graded against persistence.
//
//   rows        every LIB_STRIDE_H-th closed hourly bar of each coin with a TA row (the TA network's row cache,
//               research/trainTaNet.ts buildData: the same values live and in research)
//   labels      strategy: what each family's position earned over the next LIB_HORIZON_H hours after a round trip,
//               softmaxed in units of the coin's volatility (sigma_1h x sqrt(horizon) / 2): the soft oracle label;
//               transition: whether the coin's confirmed daily regime (research/transitions.ts) changes within
//               LIB_TRANSITION_H hours
//   walk        the first fit on LIB_FIRST_DAYS of history, then a refit every LIB_STEP_DAYS on every row whose labels
//               had closed by then (warm start), each fit forecasting every hour of the next step, unseen
//   grading     on the walk's forecasts only:
//                 strategy: one decision per horizon per coin, position = sum of weight x family position, minus the
//                 turnover cost; against the regime-persistence playbook (the mean oracle weights of the coin's
//                 current regime in the rows the fit saw) and against the winner-persistence playbook (the family
//                 that paid over the last horizon). Compared at equal risk: it validates when its Sharpe ratio beats
//                 both and its edge over the regime playbook, on returns scaled to the same volatility, has a daily
//                 bootstrap 95% lower bound above 0, on 60+ days.
//                 transition: log loss against the hazard by days since the coin's last change (from the rows the
//                 fit saw); validates when the daily improvement's 95% lower bound is above 0 on 500+ rows.
//   output      params: the final fit on every row, with both heads' validation; <history>/.librarian/forecasts.json:
//               the walk's forecasts per coin and hour (the setup scorer's "librarian" inputs)
//
//   npm run research:librarian -- --history data/history [--out params/librarian.json]

import fs from 'fs';
import path from 'path';
import { LIB_FEE_RT, LIB_HORIZON_H, LIB_INPUTS, LIB_SCHEMA, LIB_STRATEGIES, LIB_TRANSITION_H, librarianPredict, rowPositions, softmax, type LibrarianParams } from '../bot/ta/librarian';
import { TANET_FEATURES } from '../bot/ta/taNet';
import { storedAssets } from './history/candles';
import { transitionsOf } from './selection';
import { regimeDayLabels } from './transitions';
import { buildDataParallel, dayBootstrap, type TaNetData } from './trainTaNet';
import { workerCount } from './workerPool';

const H = 3_600_000;
const D = 86_400_000;
export const LIB_STRIDE_H = 3;
export const LIB_FIRST_DAYS = 730;
export const LIB_STEP_DAYS = 91;
const K = LIB_STRATEGIES.length;
const NIN = LIB_INPUTS.length;
const NF = TANET_FEATURES.length;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** One labelled row. */
export interface LibRow {
  a: number; r: number; ts: number;
  pos: number[];
  /** Each family's net log return over the horizon, and the soft oracle label. */
  R: number[]; y: number[];
  fwd: number;
  /** 1 / 0, NaN without day labels to the end of the window. */
  trans: number;
  regime: string;
  /** Days since the coin's last confirmed regime change (as known at ts; NaN before the first). */
  since: number;
}

/** Labelled rows from the TA network's data and each coin's daily regime labels. */
export function libRows(Dt: TaNetData, labels: Map<string, Map<string, string>>, o: { strideH?: number; horizonH?: number; transitionH?: number } = {}): LibRow[] {
  const stride = o.strideH ?? LIB_STRIDE_H, N = o.horizonH ?? LIB_HORIZON_H, TH = o.transitionH ?? LIB_TRANSITION_H;
  const out: LibRow[] = [];
  Dt.assets.forEach((ad, a) => {
    const lab = labels.get(ad.asset) ?? new Map<string, string>();
    const days = [...lab.keys()].sort();
    const tr = transitionsOf(days.map((d) => ({ ts: Date.parse(`${d}T00:00:00Z`), key: lab.get(d)! })), ad.asset);
    const lastDay = days.length ? Date.parse(`${days[days.length - 1]}T00:00:00Z`) : -Infinity;
    let ti = 0;
    for (let r = 0; r < ad.rowTs.length; r++) {
      const t = ad.rowTs[r];
      if (t % (stride * H) !== 0) continue;
      const i = ad.h1Idx.get(t), j = ad.h1Idx.get(t + N * H);
      if (i === undefined || j === undefined || i < 25) continue;
      let ss = 0, n = 0;
      for (let k = 0; k < 24; k++) { const p = ad.h1Idx.get(t - (k + 1) * H), q = ad.h1Idx.get(t - k * H); if (p === undefined || q === undefined) continue; ss += Math.log(ad.h1[q].c / ad.h1[p].c) ** 2; n++; }
      if (n < 20) continue;
      const sigma = Math.sqrt(ss / n);
      const fwd = Math.log(ad.h1[j].c / ad.h1[i].c);
      if (!Number.isFinite(fwd) || !(sigma > 0)) continue;
      const row = ad.X.subarray(r * NF, (r + 1) * NF);
      const pos = rowPositions(row);
      const R = pos.map((p) => p * fwd - LIB_FEE_RT * Math.abs(p));
      const tau = 0.5 * sigma * Math.sqrt(N);
      const y = softmax(R.map((v) => v / tau));
      // A change counts from the day its new label first held (it is confirmed a day later).
      while (ti < tr.length && tr[ti].ts + D <= t) ti++;
      const since = ti > 0 ? (t - tr[ti - 1].ts) / D : NaN;
      const trans = t + TH * H > lastDay + D ? NaN : tr.some((x) => x.ts > t && x.ts <= t + TH * H) ? 1 : 0;
      out.push({ a, r, ts: t, pos, R, y, fwd, trans, regime: lab.get(iso(t)) ?? '', since });
    }
  });
  return out.sort((x, y) => x.ts - y.ts || x.a - y.a);
}

/** The model inputs of row r of asset a (the TA row, then the family positions). */
const inputsOf = (Dt: TaNetData, a: number, r: number, out: Float64Array): Float64Array => {
  const X = Dt.assets[a].X, off = r * NF;
  for (let f = 0; f < NF; f++) out[f] = X[off + f];
  const pos = rowPositions(X.subarray(off, off + NF));
  for (let k = 0; k < 3; k++) out[NF + k] = pos[k];
  return out;
};

interface Fit { mean: Float64Array; std: Float64Array; W: Float64Array; b: Float64Array; wt: Float64Array; bt: number }

function norms(Dt: TaNetData, rows: LibRow[], ids: number[], cull?: ReadonlySet<number>): { mean: Float64Array; std: Float64Array } {
  const mean = new Float64Array(NIN), m2 = new Float64Array(NIN), cnt = new Float64Array(NIN), x = new Float64Array(NIN);
  const step = Math.max(1, Math.floor(ids.length / 20_000));
  for (let q = 0; q < ids.length; q += step) {
    const row = rows[ids[q]];
    inputsOf(Dt, row.a, row.r, x);
    for (let f = 0; f < NIN; f++) { const v = x[f]; if (!Number.isFinite(v)) continue; cnt[f]++; const d = v - mean[f]; mean[f] += d / cnt[f]; m2[f] += d * (v - mean[f]); }
  }
  const std = new Float64Array(NIN);
  // A culled input (research/oracleCull.ts) gets no spread: z = 0 in the fit and in every forecast, live too.
  for (let f = 0; f < NIN; f++) { const sd = cnt[f] > 10 ? Math.sqrt(m2[f] / (cnt[f] - 1)) : 0; std[f] = sd > 1e-9 && !cull?.has(f) ? sd : 0; }
  return { mean, std };
}

const zInto = (x: Float64Array, mean: Float64Array, std: Float64Array, z: Float64Array) => { for (let f = 0; f < NIN; f++) { const v = x[f]; z[f] = Number.isFinite(v) && std[f] > 0 ? Math.max(-6, Math.min(6, (v - mean[f]) / std[f])) : 0; } return z; };
const sigm = (v: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, v))));

/** Minibatch Adam on both heads (soft cross-entropy and log loss, L2), warm-started from `init`. */
export function fitLibrarian(Dt: TaNetData, rows: LibRow[], ids: number[], o: { epochs: number; init?: Fit; lr?: number; l2?: number; batch?: number; seed?: number; cull?: ReadonlySet<number> }): Fit {
  const { mean, std } = norms(Dt, rows, ids, o.cull);
  const W = o.init ? Float64Array.from(o.init.W) : new Float64Array(K * NIN), b = o.init ? Float64Array.from(o.init.b) : new Float64Array(K);
  const wt = o.init ? Float64Array.from(o.init.wt) : new Float64Array(NIN);
  let bt = o.init?.bt ?? 0;
  const P = K * NIN + K + NIN + 1;
  const m = new Float64Array(P), v = new Float64Array(P), g = new Float64Array(P);
  // Batches scale with the data (at least ~100 steps an epoch), so a short history still gets enough steps.
  const lr = o.lr ?? 5e-3, l2 = o.l2 ?? 1e-3, B = o.batch ?? Math.max(32, Math.min(256, Math.floor(ids.length / 100)));
  let s = (o.seed ?? 7) >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const x = new Float64Array(NIN), z = new Float64Array(NIN), lg = new Array(K).fill(0);
  let step = 0;
  const order = [...ids];
  for (let ep = 0; ep < o.epochs; ep++) {
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (let q0 = 0; q0 < order.length; q0 += B) {
      g.fill(0);
      const q1 = Math.min(order.length, q0 + B), nb = q1 - q0;
      let nt = 0;
      for (let q = q0; q < q1; q++) {
        const row = rows[order[q]];
        zInto(inputsOf(Dt, row.a, row.r, x), mean, std, z);
        for (let k = 0; k < K; k++) { let a = b[k]; const off = k * NIN; for (let f = 0; f < NIN; f++) a += W[off + f] * z[f]; lg[k] = a; }
        const p = softmax(lg);
        for (let k = 0; k < K; k++) { const e = p[k] - row.y[k], off = k * NIN; for (let f = 0; f < NIN; f++) g[off + f] += e * z[f]; g[K * NIN + k] += e; }
        if (Number.isFinite(row.trans)) {
          let a = bt; for (let f = 0; f < NIN; f++) a += wt[f] * z[f];
          const e = sigm(a) - row.trans, off = K * NIN + K;
          for (let f = 0; f < NIN; f++) g[off + f] += e * z[f];
          g[P - 1] += e; nt++;
        }
      }
      step++;
      const c1 = 1 - 0.9 ** step, c2 = 1 - 0.999 ** step;
      const upd = (k: number, w: number, n: number, decay: boolean) => {
        const gk = g[k] / Math.max(1, n) + (decay ? l2 * w : 0);
        m[k] = 0.9 * m[k] + 0.1 * gk; v[k] = 0.999 * v[k] + 0.001 * gk * gk;
        return w - (lr * m[k] / c1) / (Math.sqrt(v[k] / c2) + 1e-8);
      };
      for (let k = 0; k < K * NIN; k++) W[k] = upd(k, W[k], nb, true);
      for (let k = 0; k < K; k++) b[k] = upd(K * NIN + k, b[k], nb, false);
      if (nt) {
        for (let f = 0; f < NIN; f++) wt[f] = upd(K * NIN + K + f, wt[f], nt, true);
        bt = upd(P - 1, bt, nt, false);
      }
    }
  }
  return { mean, std, W, b, wt, bt };
}

const toParams = (f: Fit, extra: Partial<LibrarianParams>): LibrarianParams => ({
  schema: LIB_SCHEMA, version: extra.version ?? 'lib', trainedAt: extra.trainedAt ?? new Date().toISOString(), inputs: LIB_INPUTS,
  horizonH: LIB_HORIZON_H, transitionH: LIB_TRANSITION_H, feeRt: LIB_FEE_RT, mean: Array.from(f.mean), std: Array.from(f.std),
  strategy: { W: Array.from({ length: K }, (_, k) => Array.from(f.W.subarray(k * NIN, (k + 1) * NIN))), b: Array.from(f.b), validation: extra.strategy?.validation ?? { validated: false, why: 'not graded', rows: 0, days: 0 } },
  transition: { w: Array.from(f.wt), b: f.bt, validation: extra.transition?.validation ?? { validated: false, why: 'not graded', rows: 0, days: 0 } },
  regimeTable: extra.regimeTable,
  ...(extra.cull?.length ? { cull: extra.cull } : {}),
});

/** Mean oracle weights per regime key (keys with 30+ rows) and overall. */
export function regimeTable(rows: LibRow[], ids: number[]): Record<string, number[]> {
  const acc = new Map<string, { s: number[]; n: number }>();
  for (const i of ids) for (const k of ['*', rows[i].regime]) { if (!k) continue; const e = acc.get(k) ?? { s: new Array(K).fill(0), n: 0 }; rows[i].y.forEach((v, j) => { e.s[j] += v; }); e.n++; acc.set(k, e); }
  const out: Record<string, number[]> = {};
  for (const [k, e] of acc) if (e.n >= 30 || k === '*') out[k] = e.s.map((v) => v / Math.max(1, e.n));
  return out;
}

const SINCE_BUCKETS = [3, 7, 14, 30, Infinity];
const bucketOf = (since: number) => (Number.isFinite(since) ? SINCE_BUCKETS.findIndex((b) => since < b) : SINCE_BUCKETS.length);
/** P(change within the window) by days-since bucket (smoothed toward the overall rate). */
export function hazardTable(rows: LibRow[], ids: number[]): number[] {
  const n = new Array(SINCE_BUCKETS.length + 1).fill(0), y = new Array(SINCE_BUCKETS.length + 1).fill(0);
  let N = 0, Y = 0;
  for (const i of ids) { const r = rows[i]; if (!Number.isFinite(r.trans)) continue; const k = bucketOf(r.since); n[k]++; y[k] += r.trans; N++; Y += r.trans; }
  const base = N ? Y / N : 0.1;
  return n.map((nk, k) => (y[k] + 20 * base) / (nk + 20));
}

/** A walk-forward forecast: [w x4, net, vsBook, transition]. */
export type LibForecast = [number, number, number, number, number, number, number];

export interface LibWalk {
  /** Forecasts per asset index: hourly bar open time -> forecast (every hour of each step, not only labelled rows). */
  forecasts: Array<Map<number, LibForecast>>;
  /** Per labelled row id: the regime table and hazard of the fit that forecast it. */
  tables: Map<number, { regime: Record<string, number[]>; hazard: number[] }>;
  refits: number; from: number;
  last?: Fit;
}

/** The walk: first fit on `firstDays`, refit every `stepDays` (labels must have closed before each refit). */
export function walkLibrarian(Dt: TaNetData, rows: LibRow[], o: { firstDays?: number; stepDays?: number; epochsFirst?: number; epochsStep?: number; cull?: ReadonlySet<number>; log?: (m: string) => void } = {}): LibWalk {
  const log = o.log ?? (() => {});
  const forecasts = Dt.assets.map(() => new Map<number, LibForecast>());
  const tables = new Map<number, { regime: Record<string, number[]>; hazard: number[] }>();
  if (!rows.length) return { forecasts, tables, refits: 0, from: NaN };
  const t0 = rows[0].ts, tEnd = Math.max(...Dt.assets.map((a) => a.rowTs[a.rowTs.length - 1] ?? 0)) + H;
  const embargo = Math.max(LIB_HORIZON_H, LIB_TRANSITION_H) * H;
  const from = t0 + (o.firstDays ?? LIB_FIRST_DAYS) * D, step = (o.stepDays ?? LIB_STEP_DAYS) * D;
  let fit: Fit | undefined, refits = 0;
  const ri = new Map<string, number>(rows.map((r, i) => [`${r.a}:${r.ts}`, i]));
  for (let cut = from; cut < tEnd; cut += step) {
    const ids: number[] = [];
    for (let i = 0; i < rows.length && rows[i].ts < cut; i++) if (rows[i].ts + embargo <= cut) ids.push(i);
    if (ids.length < 500) continue;
    const started = Date.now();
    fit = fitLibrarian(Dt, rows, ids, { epochs: fit ? (o.epochsStep ?? 2) : (o.epochsFirst ?? 6), init: fit, seed: refits + 1, cull: o.cull });
    refits++;
    const p = toParams(fit, {});
    const tab = { regime: regimeTable(rows, ids), hazard: hazardTable(rows, ids) };
    let n = 0;
    Dt.assets.forEach((ad, a) => {
      for (let r = 0; r < ad.rowTs.length; r++) {
        const t = ad.rowTs[r];
        if (t < cut || t >= cut + step) continue;
        const rd = librarianPredict(p, ad.X.subarray(r * NF, (r + 1) * NF));
        forecasts[a].set(t, [...rd.w, rd.net, rd.vsBook, rd.transition].map((v) => +v.toFixed(4)) as LibForecast);
        const id = ri.get(`${a}:${t}`);
        if (id !== undefined) tables.set(id, tab);
        n++;
      }
    });
    log(`[librarian] fit ${refits} through ${iso(cut)} on ${ids.length} rows (${((Date.now() - started) / 1000).toFixed(0)} s), forecast ${n} hours`);
  }
  return { forecasts, tables, refits, from, last: fit };
}

export interface LibGrade {
  strategy: { validated: boolean; why: string; rows: number; days: number; decisions: number; lib: number; regime: number; winner: number; sharpeLib: number; sharpeRegime: number; sharpeWinner: number; edgeLo: number; edgeMean: number; ceLib: number; ceRegime: number };
  transition: { validated: boolean; why: string; rows: number; days: number; llLib: number; llHazard: number; brierLib: number; brierHazard: number; gainLo: number; rate: number };
}

/** Grade the walk's forecasts against the persistence baselines. */
export function gradeLibrarian(rows: LibRow[], walk: LibWalk, o: { minDays?: number; minRows?: number } = {}): LibGrade {
  const N = LIB_HORIZON_H;
  // ---- strategy: one decision per horizon per coin ----
  const dec = rows.map((r, i) => ({ r, i })).filter(({ r, i }) => r.ts % (N * H) === 0 && walk.tables.has(i) && walk.forecasts[r.a].has(r.ts));
  const byAsset = new Map<number, typeof dec>();
  for (const d of dec) { const l = byAsset.get(d.r.a) ?? []; l.push(d); byAsset.set(d.r.a, l); }
  const ts: number[] = [], lib: number[] = [], reg: number[] = [], win: number[] = [];
  let ceL = 0, ceR = 0, nCe = 0;
  for (const list of byAsset.values()) {
    list.sort((a, b) => a.r.ts - b.r.ts);
    let pl = 0, pr = 0, pw = 0;
    let prev: LibRow | undefined;
    for (const { r, i } of list) {
      if (prev && r.ts - prev.ts !== N * H) { pl = pr = pw = 0; prev = undefined; }
      const f = walk.forecasts[r.a].get(r.ts)!;
      const tab = walk.tables.get(i)!.regime;
      const wr = tab[r.regime] ?? tab['*'];
      const L = r.pos.reduce((s, p, k) => s + f[k] * p, 0);
      const Rg = r.pos.reduce((s, p, k) => s + wr[k] * p, 0);
      const best = prev ? prev.R.indexOf(Math.max(...prev.R)) : 3;
      const Wn = r.pos[best];
      const c = LIB_FEE_RT / 2;
      ts.push(r.ts);
      lib.push(L * r.fwd - c * Math.abs(L - pl));
      reg.push(Rg * r.fwd - c * Math.abs(Rg - pr));
      win.push(Wn * r.fwd - c * Math.abs(Wn - pw));
      pl = L; pr = Rg; pw = Wn; prev = r;
      for (let k = 0; k < K; k++) { ceL -= r.y[k] * Math.log(Math.max(1e-9, f[k])); ceR -= r.y[k] * Math.log(Math.max(1e-9, wr[k])); }
      nCe++;
    }
  }
  const sum = (x: number[]) => x.reduce((a, b) => a + b, 0);
  const sd = (x: number[]) => { const m = sum(x) / Math.max(1, x.length); return Math.sqrt(x.reduce((a, v) => a + (v - m) ** 2, 0) / Math.max(1, x.length - 1)); };
  const days = new Set(ts.map((t) => Math.floor(t / D))).size;
  // At equal risk: soft weights take smaller positions than a playbook that bets everything on one family, so the
  // playbooks are compared by Sharpe ratio and the edge on returns scaled to the same volatility.
  const vL = sd(lib) || 1, vR = sd(reg) || 1, vW = sd(win) || 1;
  const shp = (x: number[], v: number) => (x.length ? sum(x) / x.length / v : NaN);
  const shL = shp(lib, vL), shR = shp(reg, vR), shW = shp(win, vW);
  const edge = dayBootstrap(lib.map((v, k) => v / vL - reg[k] / vR), ts);
  const minDays = o.minDays ?? 60;
  const sWhy = days < minDays ? `${days} graded day(s), need ${minDays}`
    : !(shL > shR) ? `Sharpe ${shL.toFixed(3)}/decision vs the regime playbook's ${shR.toFixed(3)}`
    : !(shL > shW) ? `Sharpe ${shL.toFixed(3)}/decision vs the last winner's ${shW.toFixed(3)}`
    : !(edge.lo > 0) ? `vol-matched edge over the regime playbook ${edge.mean.toFixed(3)}/decision, 95% lower bound ${edge.lo.toFixed(3)} <= 0`
    : `Sharpe ${shL.toFixed(3)}/decision vs ${shR.toFixed(3)} (regime) and ${shW.toFixed(3)} (last winner); vol-matched edge lower bound ${edge.lo.toFixed(3)} > 0`;
  const strategy = {
    validated: days >= minDays && shL > shR && shL > shW && edge.lo > 0, why: sWhy, rows: nCe, days, decisions: lib.length,
    lib: +sum(lib).toFixed(4), regime: +sum(reg).toFixed(4), winner: +sum(win).toFixed(4), sharpeLib: shL, sharpeRegime: shR, sharpeWinner: shW,
    edgeLo: edge.lo, edgeMean: edge.mean, ceLib: nCe ? ceL / nCe : NaN, ceRegime: nCe ? ceR / nCe : NaN,
  };
  // ---- transition: log loss against the days-since hazard ----
  const tt: number[] = [], gain: number[] = [];
  let llL = 0, llH = 0, bL = 0, bH = 0, nT = 0, yT = 0;
  rows.forEach((r, i) => {
    if (!Number.isFinite(r.trans) || !walk.tables.has(i)) return;
    const f = walk.forecasts[r.a].get(r.ts);
    if (!f) return;
    const p = Math.min(1 - 1e-6, Math.max(1e-6, f[6])), h = Math.min(1 - 1e-6, Math.max(1e-6, walk.tables.get(i)!.hazard[bucketOf(r.since)]));
    const l = -(r.trans ? Math.log(p) : Math.log(1 - p)), lh = -(r.trans ? Math.log(h) : Math.log(1 - h));
    llL += l; llH += lh; bL += (p - r.trans) ** 2; bH += (h - r.trans) ** 2; nT++; yT += r.trans;
    tt.push(r.ts); gain.push(lh - l);
  });
  const g = dayBootstrap(gain, tt);
  const tDays = new Set(tt.map((t) => Math.floor(t / D))).size;
  const minRows = o.minRows ?? 500;
  const tWhy = nT < minRows ? `${nT} graded row(s), need ${minRows}`
    : !(g.lo > 0) ? `log loss ${(llL / nT).toFixed(4)} vs the hazard's ${(llH / nT).toFixed(4)}; improvement lower bound ${g.lo.toExponential(2)} <= 0`
    : `log loss ${(llL / nT).toFixed(4)} vs the hazard's ${(llH / nT).toFixed(4)}; improvement lower bound ${g.lo.toExponential(2)} > 0`;
  const transition = {
    validated: nT >= minRows && g.lo > 0, why: tWhy, rows: nT, days: tDays, llLib: nT ? llL / nT : NaN, llHazard: nT ? llH / nT : NaN,
    brierLib: nT ? bL / nT : NaN, brierHazard: nT ? bH / nT : NaN, gainLo: g.lo, rate: nT ? yT / nT : NaN,
  };
  return { strategy, transition };
}

export const libDir = (hist: string) => path.join(hist, '.librarian');

export interface LibForecastFile { schema: string; version: string; through: number; assets: Record<string, Array<[number, ...LibForecast]>> }

export function loadLibForecasts(hist: string): LibForecastFile | undefined {
  try { const j = JSON.parse(fs.readFileSync(path.join(libDir(hist), 'forecasts.json'), 'utf8')) as LibForecastFile; return j.schema === LIB_SCHEMA ? j : undefined; } catch { return undefined; }
}

/** Lookup by asset: the forecast made at the close of the last hourly bar closed by t. */
export class LibIndex {
  private readonly by = new Map<string, Map<number, LibForecast>>();
  constructor(readonly f: LibForecastFile | undefined) {
    for (const [a, rows] of Object.entries(f?.assets ?? {})) this.by.set(a, new Map(rows.map(([t, ...v]) => [t, v as LibForecast])));
  }
  at(asset: string, t: number): { w: number[]; net: number; vsBook: number; transition: number } | undefined {
    const v = this.by.get(asset)?.get(Math.floor(t / H) * H - H);
    return v ? { w: v.slice(0, 4), net: v[4], vsBook: v[5], transition: v[6] } : undefined;
  }
}

export interface LibReport { params: LibrarianParams; grade: LibGrade; rows: number; refits: number; from: string; forecastHours: number }

/** Rows, walk, grade, final fit; writes the forecasts file. */
export function trainLibrarianOn(Dt: TaNetData, labels: Map<string, Map<string, string>>, o: { hist?: string; cull?: string[]; log?: (m: string) => void; firstDays?: number; stepDays?: number; epochsFirst?: number; epochsStep?: number; epochsFinal?: number; minDays?: number; minRows?: number; strideH?: number } = {}): LibReport {
  const log = o.log ?? (() => {});
  const rows = libRows(Dt, labels, { strideH: o.strideH });
  if (rows.length < 1000) throw new Error(`only ${rows.length} labelled rows: the Librarian needs years of hourly history`);
  log(`[librarian] ${rows.length} labelled rows over ${Dt.assets.length} coin(s), ${iso(rows[0].ts)}..${iso(rows[rows.length - 1].ts)}; oracle weights ${LIB_STRATEGIES.map((s, k) => `${s} ${(rows.reduce((a, r) => a + r.y[k], 0) / rows.length).toFixed(2)}`).join(', ')}`);
  const cullNames = (o.cull ?? []).filter((k) => LIB_INPUTS.includes(k));
  const cull = new Set(cullNames.map((k) => LIB_INPUTS.indexOf(k)));
  if (cull.size) log(`[librarian] oracle cull: ${cull.size} input(s) switched off`);
  const walk = walkLibrarian(Dt, rows, { ...o, cull, log });
  const grade = gradeLibrarian(rows, walk, o);
  log(`[librarian] strategy head: ${grade.strategy.validated ? 'VALIDATED' : 'not validated'} (${grade.strategy.why})`);
  log(`[librarian] transition head: ${grade.transition.validated ? 'VALIDATED' : 'not validated'} (${grade.transition.why})`);
  const all = rows.map((_, i) => i);
  const final = fitLibrarian(Dt, rows, all, { epochs: o.epochsFinal ?? 4, init: walk.last, seed: 99, cull });
  const version = `lib-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
  const { why: sw, validated: sv, rows: sr, days: sd, ...sRest } = grade.strategy;
  const { why: tw, validated: tv, rows: tr, days: td, ...tRest } = grade.transition;
  const params = toParams(final, {
    version, regimeTable: regimeTable(rows, all), ...(cullNames.length ? { cull: cullNames } : {}),
    strategy: { W: [], b: [], validation: { validated: sv, why: sw, rows: sr, days: sd, ...sRest } },
    transition: { w: [], b: 0, validation: { validated: tv, why: tw, rows: tr, days: td, ...tRest } },
  });
  let hours = 0;
  if (o.hist) {
    const assets: LibForecastFile['assets'] = {};
    Dt.assets.forEach((ad, a) => { const m = walk.forecasts[a]; if (m.size) { assets[ad.asset] = [...m].sort((x, y) => x[0] - y[0]).map(([t, v]) => [t, ...v]); hours += m.size; } });
    fs.mkdirSync(libDir(o.hist), { recursive: true });
    const file = path.join(libDir(o.hist), 'forecasts.json'), tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ schema: LIB_SCHEMA, version, through: Math.max(...rows.map((r) => r.ts)), assets } satisfies LibForecastFile));
    fs.renameSync(tmp, file);
  }
  return { params, grade, rows: rows.length, refits: walk.refits, from: Number.isFinite(walk.from) ? iso(walk.from) : '', forecastHours: hours };
}

/** The whole job from a history directory: the TA network's rows (cached), the day regime labels (cached), train. */
export async function trainLibrarian(hist: string, o: { cacheDir?: string; assets?: string[]; cull?: string[]; log?: (m: string) => void } = {}): Promise<LibReport> {
  const log = o.log ?? console.log;
  const assets = o.assets?.length ? o.assets : storedAssets(hist);
  const Dt = await buildDataParallel(hist, assets, o.cacheDir ?? path.join(hist, '.tanet-cache'), log, workerCount());
  if (!Dt.assets.length) throw new Error('no coin has enough hourly and daily history for TA rows');
  const t0 = Math.min(...Dt.assets.map((a) => a.rowTs[0] ?? Infinity)), t1 = Math.max(...Dt.assets.map((a) => a.rowTs[a.rowTs.length - 1] ?? 0)) + D;
  const labels = regimeDayLabels(hist, Dt.assets.map((a) => a.asset), t0, t1, log);
  return trainLibrarianOn(Dt, labels, { hist, cull: o.cull, log });
}

export async function trainLibrarianMain(): Promise<void> {
  const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
  const hist = arg('history', 'data/history'), out = arg('out', 'params/librarian.json');
  const rep = await trainLibrarian(hist, { assets: arg('assets', '') ? arg('assets', '').split(',') : undefined });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(rep.params));
  console.log(JSON.stringify({ out, rows: rep.rows, refits: rep.refits, from: rep.from, forecastHours: rep.forecastHours, strategy: rep.grade.strategy, transition: rep.grade.transition }, null, 2));
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) trainLibrarianMain().catch((e) => { console.error(e); process.exitCode = 1; });
