// Multi-timeframe network for the TA network (bot/ta/taNet.ts). Five branches read five views of
// the market WITHOUT flattening them into one vector, then merge:
//
//   micro    last 32 fifteen-minute bars -> fractal convolution block (columns see 3 / 7 / 31 bars)
//   swing    last 48 hourly bars          -> fractal convolution block (candles / structure / swings)
//   trend    last 12 hourly TA steps      -> GRU (the coin's hourly / 4h TA library, step by step)
//   macro    last 30 daily TA steps       -> attention, today as the query (regime, levels)
//   context  one vector at the forecast hour -> dense tanh (15m TA library, BTC / market / BTCDOM,
//            the BTC.D x USDT.D quadrant, TA on the daily dominance charts). Read once rather than at
//            every GRU step: the same information for far fewer weights.
//
//   concat(g x branch outputs) -> dense tanh -> [logit up 1h, logit up 4h, vol 4h]
//
// Fractal blocks (bot/ta/fractal.ts) are FractalNet-style: parallel columns of causal convolutions
// of depth 1, 2 and 4 (dilated), joined by averaging, regularised by drop-path. Branch gates g and
// the drop-path rates are hyperparameters the population tournament mutates; whole branches are
// also dropped during training (inverted scaling), so no branch can carry the others. All
// parameters live in one flat Float64Array. Backward is hand-written and checked against finite
// differences in tests/branchNet.test.ts.

import { buildFractal, fractalBackward, fractalForward, type FCache, type FractalPlan, type FractalSpec, type JoinMask } from './fractal';

export interface BranchDims {
  /** micro: 15m steps, features per step, fractal channels. */
  mT: number; mF: number; mC: number;
  /** swing: hourly bars, features per bar, fractal channels. */
  sT: number; sF: number; sC: number;
  /** fractal depth (3 = columns of 1, 2, 4 convolutions). */
  fDepth: number;
  /** trend: steps, features per step, GRU hidden size. */
  tT: number; tF: number; tH: number;
  /** macro: steps (days), features per day, embedding size. */
  dT: number; dF: number; dE: number;
  /** context: features, hidden size. */
  cF: number; cH: number;
  /** merge hidden size; outputs (3). */
  hM: number; nOut: number;
}

export interface BranchGates { micro: number; swing: number; trend: number; macro: number; ctx: number }

interface Layout { [name: string]: { off: number; n: number } }

const KERNEL = 3;
export const fractalSpecs = (d: BranchDims): { micro: FractalSpec; swing: FractalSpec } => ({
  micro: { depth: d.fDepth, channels: d.mC, kernel: KERNEL }, swing: { depth: d.fDepth, channels: d.sC, kernel: KERNEL },
});
const planCache = new Map<string, FractalPlan>();
export function fractalPlan(spec: FractalSpec): FractalPlan {
  const k = `${spec.depth}|${spec.channels}|${spec.kernel}`;
  let p = planCache.get(k);
  if (!p) { p = buildFractal(spec); planCache.set(k, p); }
  return p;
}

export function branchLayout(d: BranchDims): { layout: Layout; size: number } {
  const L: Layout = {};
  let off = 0;
  const add = (name: string, n: number) => { L[name] = { off, n }; off += n; };
  const fs = fractalSpecs(d);
  add('Wpm', d.mC * d.mF); add('bpm', d.mC); add('Fm', fractalPlan(fs.micro).params);
  add('Wps', d.sC * d.sF); add('bps', d.sC); add('Fs', fractalPlan(fs.swing).params);
  for (const g of ['z', 'r', 'h']) { add(`W${g}`, d.tH * d.tF); add(`U${g}`, d.tH * d.tH); add(`b${g}`, d.tH); }
  add('We', d.dE * d.dF); add('be', d.dE); add('Wq', d.dE * d.dE); add('Wk', d.dE * d.dE);
  add('Wc', d.cH * d.cF); add('bc', d.cH);
  const nIn = mergeWidth(d);
  add('W1', d.hM * nIn); add('b1', d.hM);
  add('W2', d.nOut * d.hM); add('b2', d.nOut);
  return { layout: L, size: off };
}

const mergeWidth = (d: BranchDims) => 2 * d.mC + 2 * d.sC + d.tH + 2 * d.dE + d.cH;
const convOff = (base: number, ch: number) => (id: number) => base + id * (ch * KERNEL * ch + ch);

/** Deterministic initialisation (same seed -> identical networks). */
export function initBranchParams(d: BranchDims, seed: number): Float64Array {
  const { layout, size } = branchLayout(d);
  const p = new Float64Array(size);
  let s = seed >>> 0 || 1;
  const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const fill = (name: string, fanIn: number, from = 0, n?: number) => { const { off } = layout[name]; const len = n ?? layout[name].n; const a = 1 / Math.sqrt(fanIn); for (let i = 0; i < len; i++) p[off + from + i] = (r() * 2 - 1) * a; };
  fill('Wpm', d.mF); fill('Wps', d.sF);
  for (const [name, ch] of [['Fm', d.mC], ['Fs', d.sC]] as const) {
    const per = ch * KERNEL * ch + ch;
    const n = layout[name].n / per;
    for (let c = 0; c < n; c++) fill(name, KERNEL * ch, c * per, ch * KERNEL * ch);
  }
  for (const g of ['z', 'r', 'h']) { fill(`W${g}`, d.tF); fill(`U${g}`, d.tH); }
  fill('We', d.dF); fill('Wq', d.dE); fill('Wk', d.dE);
  if (d.cF > 0 && d.cH > 0) fill('Wc', d.cF);
  fill('W1', mergeWidth(d));
  // Output layer starts at zero: an untrained network predicts the base rate / zero vol change.
  return p;
}

export interface BranchInput {
  /** mT x mF (row-major), normalised; missing -> 0. */
  micro: Float64Array;
  /** sT x sF hourly bars, oldest first. */
  swing: Float64Array;
  /** tT x tF, oldest first. */
  trend: Float64Array;
  /** dT x dF, oldest first. */
  macro: Float64Array;
  /** cF context features at the forecast hour. */
  ctx: Float64Array;
}

/** Training-time structure noise: drop-path masks inside the fractal blocks and whole-branch drops. */
export interface BranchDrop {
  micro?: JoinMask;
  swing?: JoinMask;
  /** Kept branches [micro, swing, trend, macro, context] and the keep probability (inverted scaling). */
  branches?: [boolean, boolean, boolean, boolean, boolean];
  keep?: number;
}

const sig = (x: number) => 1 / (1 + Math.exp(-x));

export interface BranchCache {
  pm: Float64Array; fm: Float64Array; cm: FCache;
  ps: Float64Array; fsy: Float64Array; cs: FCache;
  u: Float64Array; m: Float64Array; out: Float64Array;
  gh: Float64Array; gz: Float64Array; gr: Float64Array; ghh: Float64Array;
  e: Float64Array; q: Float64Array; k: Float64Array; a: Float64Array;
  hc: Float64Array;
  scale: [number, number, number, number, number];
}

/** 1x1 input projection + tanh: raw T x F -> T x C. */
function project(p: Float64Array, wOff: number, bOff: number, x: Float64Array, T: number, F: number, C: number): Float64Array {
  const y = new Float64Array(T * C);
  for (let t = 0; t < T; t++) for (let c = 0; c < C; c++) {
    let a = p[bOff + c];
    for (let f = 0; f < F; f++) a += p[wOff + c * F + f] * x[t * F + f];
    y[t * C + c] = Math.tanh(a);
  }
  return y;
}

/** Forward pass; returns [logit up1h, logit up4h, vol4h] and the cache for backward. */
export function branchForward(d: BranchDims, p: Float64Array, g: BranchGates, x: BranchInput, L = branchLayout(d).layout, drop?: BranchDrop): { out: Float64Array; cache: BranchCache } {
  const fs = fractalSpecs(d);
  const keep = drop?.keep ?? 1;
  const on = drop?.branches ?? [true, true, true, true, true];
  const scale = on.map((b, i) => (b ? [g.micro, g.swing, g.trend, g.macro, g.ctx][i] / keep : 0)) as [number, number, number, number, number];
  const nIn = mergeWidth(d);
  const u = new Float64Array(nIn);
  // micro + swing: projection -> fractal block -> pooled (mean over bars, last bar)
  const pm = project(p, L.Wpm.off, L.bpm.off, x.micro, d.mT, d.mF, d.mC);
  const rm = fractalForward(fractalPlan(fs.micro), fs.micro, p, convOff(L.Fm.off, d.mC), pm, d.mT, drop?.micro);
  const ps = project(p, L.Wps.off, L.bps.off, x.swing, d.sT, d.sF, d.sC);
  const rs = fractalForward(fractalPlan(fs.swing), fs.swing, p, convOff(L.Fs.off, d.sC), ps, d.sT, drop?.swing);
  const pool = (y: Float64Array, T: number, C: number, at: number, sc: number) => {
    for (let c = 0; c < C; c++) {
      let s = 0;
      for (let t = 0; t < T; t++) s += y[t * C + c];
      u[at + c] = sc * (s / T);
      u[at + C + c] = sc * y[(T - 1) * C + c];
    }
  };
  pool(rm.y, d.mT, d.mC, 0, scale[0]);
  pool(rs.y, d.sT, d.sC, 2 * d.mC, scale[1]);
  const tOff = 2 * d.mC + 2 * d.sC;
  // trend: GRU
  const H = d.tH, F = d.tF;
  const gh = new Float64Array((d.tT + 1) * H), gz = new Float64Array(d.tT * H), gr = new Float64Array(d.tT * H), ghh = new Float64Array(d.tT * H);
  for (let s = 0; s < d.tT; s++) {
    const hp = s * H, xo = s * F;
    for (let j = 0; j < H; j++) {
      let az = p[L.bz.off + j], ar = p[L.br.off + j];
      const wz = L.Wz.off + j * F, wr = L.Wr.off + j * F, uz = L.Uz.off + j * H, ur = L.Ur.off + j * H;
      for (let f = 0; f < F; f++) { const xv = x.trend[xo + f]; az += p[wz + f] * xv; ar += p[wr + f] * xv; }
      for (let i = 0; i < H; i++) { const hv = gh[hp + i]; az += p[uz + i] * hv; ar += p[ur + i] * hv; }
      gz[s * H + j] = sig(az); gr[s * H + j] = sig(ar);
    }
    for (let j = 0; j < H; j++) {
      let ah = p[L.bh.off + j];
      const wh = L.Wh.off + j * F, uh = L.Uh.off + j * H;
      for (let f = 0; f < F; f++) ah += p[wh + f] * x.trend[xo + f];
      for (let i = 0; i < H; i++) ah += p[uh + i] * gr[s * H + i] * gh[hp + i];
      const hh = Math.tanh(ah);
      ghh[s * H + j] = hh;
      const z = gz[s * H + j];
      gh[(s + 1) * H + j] = (1 - z) * gh[hp + j] + z * hh;
    }
  }
  for (let j = 0; j < H; j++) u[tOff + j] = scale[2] * gh[d.tT * H + j];
  // macro: embeddings, attention with today's embedding as the query
  const E = d.dE, D = d.dF;
  const e = new Float64Array(d.dT * E), q = new Float64Array(E), k = new Float64Array(d.dT * E), a = new Float64Array(d.dT);
  for (let t = 0; t < d.dT; t++) for (let j = 0; j < E; j++) {
    let s = p[L.be.off + j];
    const w = L.We.off + j * D, xo = t * D;
    for (let f = 0; f < D; f++) s += p[w + f] * x.macro[xo + f];
    e[t * E + j] = Math.tanh(s);
  }
  const last = (d.dT - 1) * E;
  for (let j = 0; j < E; j++) { let s = 0; for (let i = 0; i < E; i++) s += p[L.Wq.off + j * E + i] * e[last + i]; q[j] = s; }
  const sc = 1 / Math.sqrt(E);
  let mx = -Infinity;
  for (let t = 0; t < d.dT; t++) {
    for (let j = 0; j < E; j++) { let s = 0; for (let i = 0; i < E; i++) s += p[L.Wk.off + j * E + i] * e[t * E + i]; k[t * E + j] = s; }
    let s = 0;
    for (let j = 0; j < E; j++) s += q[j] * k[t * E + j];
    a[t] = s * sc;
    mx = Math.max(mx, a[t]);
  }
  let z = 0;
  for (let t = 0; t < d.dT; t++) { a[t] = Math.exp(a[t] - mx); z += a[t]; }
  for (let t = 0; t < d.dT; t++) a[t] /= z;
  const o0 = tOff + H;
  for (let j = 0; j < E; j++) {
    let s = 0;
    for (let t = 0; t < d.dT; t++) s += a[t] * e[t * E + j];
    u[o0 + j] = scale[3] * s;
    u[o0 + E + j] = scale[3] * e[last + j];
  }
  // context: one dense tanh layer over the forecast hour's vector
  const cOff = o0 + 2 * E, hc = new Float64Array(d.cH);
  for (let j = 0; j < d.cH; j++) {
    let s = p[L.bc.off + j];
    const w = L.Wc.off + j * d.cF;
    for (let f = 0; f < d.cF; f++) s += p[w + f] * x.ctx[f];
    hc[j] = Math.tanh(s);
    u[cOff + j] = scale[4] * hc[j];
  }
  // merge
  const m = new Float64Array(d.hM);
  for (let j = 0; j < d.hM; j++) { let s = p[L.b1.off + j]; const w = L.W1.off + j * nIn; for (let i = 0; i < nIn; i++) s += p[w + i] * u[i]; m[j] = Math.tanh(s); }
  const out = new Float64Array(d.nOut);
  for (let o = 0; o < d.nOut; o++) { let s = p[L.b2.off + o]; const w = L.W2.off + o * d.hM; for (let j = 0; j < d.hM; j++) s += p[w + j] * m[j]; out[o] = s; }
  return { out, cache: { pm, fm: rm.y, cm: rm.cache, ps, fsy: rs.y, cs: rs.cache, u, m, out, gh, gz, gr, ghh, e, q, k, a, hc, scale } };
}

/** Accumulate dLoss/dParams into `grad` given dLoss/dOut. */
export function branchBackward(d: BranchDims, p: Float64Array, g: BranchGates, x: BranchInput, c: BranchCache, dOut: ArrayLike<number>, grad: Float64Array, L = branchLayout(d).layout): void {
  void g;
  const fs = fractalSpecs(d);
  const nIn = mergeWidth(d);
  const dm = new Float64Array(d.hM);
  for (let o = 0; o < d.nOut; o++) {
    const go = dOut[o];
    if (!go) continue;
    grad[L.b2.off + o] += go;
    const w = L.W2.off + o * d.hM;
    for (let j = 0; j < d.hM; j++) { grad[w + j] += go * c.m[j]; dm[j] += go * p[w + j]; }
  }
  const du = new Float64Array(nIn);
  for (let j = 0; j < d.hM; j++) {
    const da = dm[j] * (1 - c.m[j] * c.m[j]);
    if (!da) continue;
    grad[L.b1.off + j] += da;
    const w = L.W1.off + j * nIn;
    for (let i = 0; i < nIn; i++) { grad[w + i] += da * c.u[i]; du[i] += da * p[w + i]; }
  }
  // micro + swing: pooled -> fractal -> projection
  const fracBack = (yPool: Float64Array, T: number, C: number, at: number, sc: number, plan: FractalPlan, spec: FractalSpec, base: number, cache: FCache, proj: Float64Array, raw: Float64Array, F: number, wOff: number, bOff: number) => {
    if (!sc) return;
    const dy = new Float64Array(T * C);
    for (let ch = 0; ch < C; ch++) {
      const dMean = (sc * du[at + ch]) / T;
      for (let t = 0; t < T; t++) dy[t * C + ch] += dMean;
      dy[(T - 1) * C + ch] += sc * du[at + C + ch];
    }
    void yPool;
    const dProj = fractalBackward(plan, spec, p, convOff(base, C), cache, dy, T, grad);
    for (let t = 0; t < T; t++) for (let ch = 0; ch < C; ch++) {
      const v = proj[t * C + ch];
      const da = dProj[t * C + ch] * (1 - v * v);
      if (!da) continue;
      grad[bOff + ch] += da;
      for (let f = 0; f < F; f++) grad[wOff + ch * F + f] += da * raw[t * F + f];
    }
  };
  fracBack(c.fm, d.mT, d.mC, 0, c.scale[0], fractalPlan(fs.micro), fs.micro, L.Fm.off, c.cm, c.pm, x.micro, d.mF, L.Wpm.off, L.bpm.off);
  fracBack(c.fsy, d.sT, d.sC, 2 * d.mC, c.scale[1], fractalPlan(fs.swing), fs.swing, L.Fs.off, c.cs, c.ps, x.swing, d.sF, L.Wps.off, L.bps.off);
  const tOff = 2 * d.mC + 2 * d.sC;
  // trend: BPTT
  const H = d.tH, F = d.tF;
  let dh = new Float64Array(H);
  for (let j = 0; j < H; j++) dh[j] = c.scale[2] * du[tOff + j];
  const drh = new Float64Array(H);
  for (let s = d.tT - 1; s >= 0; s--) {
    const hp = s * H, xo = s * F;
    const dhp = new Float64Array(H);
    drh.fill(0);
    for (let j = 0; j < H; j++) {
      const z = c.gz[s * H + j], hh = c.ghh[s * H + j], hprev = c.gh[hp + j];
      const dhh = dh[j] * z;
      dhp[j] += dh[j] * (1 - z);
      const dah = dhh * (1 - hh * hh);
      if (dah) {
        grad[L.bh.off + j] += dah;
        const wh = L.Wh.off + j * F, uh = L.Uh.off + j * H;
        for (let f = 0; f < F; f++) grad[wh + f] += dah * x.trend[xo + f];
        for (let i = 0; i < H; i++) { const rh = c.gr[s * H + i] * c.gh[hp + i]; grad[uh + i] += dah * rh; drh[i] += dah * p[uh + i]; }
      }
      const daz = dh[j] * (hh - hprev) * z * (1 - z);
      if (daz) {
        grad[L.bz.off + j] += daz;
        const wz = L.Wz.off + j * F, uz = L.Uz.off + j * H;
        for (let f = 0; f < F; f++) grad[wz + f] += daz * x.trend[xo + f];
        for (let i = 0; i < H; i++) { grad[uz + i] += daz * c.gh[hp + i]; dhp[i] += daz * p[uz + i]; }
      }
    }
    for (let i = 0; i < H; i++) {
      const r = c.gr[s * H + i];
      dhp[i] += drh[i] * r;
      const dar = drh[i] * c.gh[hp + i] * r * (1 - r);
      if (!dar) continue;
      grad[L.br.off + i] += dar;
      const wr = L.Wr.off + i * F, ur = L.Ur.off + i * H;
      for (let f = 0; f < F; f++) grad[wr + f] += dar * x.trend[xo + f];
      for (let k = 0; k < H; k++) { grad[ur + k] += dar * c.gh[hp + k]; dhp[k] += dar * p[ur + k]; }
    }
    dh = dhp;
  }
  // macro
  const E = d.dE, D = d.dF, T = d.dT;
  const o0 = tOff + H;
  // context
  const cOff = o0 + 2 * E;
  for (let j = 0; j < d.cH; j++) {
    const dac = c.scale[4] * du[cOff + j] * (1 - c.hc[j] * c.hc[j]);
    if (!dac) continue;
    grad[L.bc.off + j] += dac;
    const w = L.Wc.off + j * d.cF;
    for (let f = 0; f < d.cF; f++) grad[w + f] += dac * x.ctx[f];
  }
  const dctx = new Float64Array(E), de = new Float64Array(T * E);
  const last = (T - 1) * E;
  for (let j = 0; j < E; j++) { dctx[j] = c.scale[3] * du[o0 + j]; de[last + j] += c.scale[3] * du[o0 + E + j]; }
  const da = new Float64Array(T);
  let sumAda = 0;
  for (let t = 0; t < T; t++) {
    let s = 0;
    for (let j = 0; j < E; j++) { s += dctx[j] * c.e[t * E + j]; de[t * E + j] += c.a[t] * dctx[j]; }
    da[t] = s;
    sumAda += c.a[t] * s;
  }
  const sc = 1 / Math.sqrt(E);
  const dq = new Float64Array(E);
  for (let t = 0; t < T; t++) {
    const ds = c.a[t] * (da[t] - sumAda) * sc;
    if (!ds) continue;
    for (let j = 0; j < E; j++) {
      dq[j] += ds * c.k[t * E + j];
      const dk = ds * c.q[j];
      const w = L.Wk.off + j * E;
      for (let i = 0; i < E; i++) { grad[w + i] += dk * c.e[t * E + i]; de[t * E + i] += dk * p[w + i]; }
    }
  }
  for (let j = 0; j < E; j++) {
    const w = L.Wq.off + j * E;
    for (let i = 0; i < E; i++) { grad[w + i] += dq[j] * c.e[last + i]; de[last + i] += dq[j] * p[w + i]; }
  }
  for (let t = 0; t < T; t++) for (let j = 0; j < E; j++) {
    const ev = c.e[t * E + j];
    const dae = de[t * E + j] * (1 - ev * ev);
    if (!dae) continue;
    grad[L.be.off + j] += dae;
    const w = L.We.off + j * D, xo = t * D;
    for (let f = 0; f < D; f++) grad[w + f] += dae * x.macro[xo + f];
  }
}

/** Multi-task loss on one sample: BCE(up1) + BCE(up4) + volWeight * 0.5 (vol - y)^2; NaN targets skipped.
 *  Returns the loss and dLoss/dOut. */
export function branchLoss(out: ArrayLike<number>, y: [number, number, number], volWeight: number): { loss: number; dOut: Float64Array } {
  const dOut = new Float64Array(3);
  let loss = 0;
  for (let o = 0; o < 2; o++) {
    if (!Number.isFinite(y[o])) continue;
    const pr = sig(out[o]);
    loss += -(y[o] ? Math.log(Math.max(1e-12, pr)) : Math.log(Math.max(1e-12, 1 - pr)));
    dOut[o] = pr - y[o];
  }
  if (Number.isFinite(y[2])) { const e = out[2] - y[2]; loss += volWeight * 0.5 * e * e; dOut[2] = volWeight * e; }
  return { loss, dOut };
}
