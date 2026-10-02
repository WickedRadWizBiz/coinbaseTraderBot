// Multi-timeframe network for the TA network (bot/ta/taNet.ts). Three branches read three
// granularities WITHOUT flattening them into one vector, then merge:
//
//   micro  15-minute bars  -> 1-D convolution (kernel 3) + mean/last pooling   microstructure, noise filter
//   trend  hourly TA steps -> GRU over the last 12 hours                        intraday / multi-day momentum
//   macro  daily TA steps  -> attention over the last 30 days (query = today)   regime, support/resistance
//
//   concat(gMicro*micro, gTrend*trend, gMacro*macro) -> dense tanh -> [logit up 1h, logit up 4h, vol 4h]
//
// The branch gates g* are hyperparameters the population tournament mutates ("shift weight between
// the 15m and daily branches"). All parameters live in one flat Float64Array (cheap to clone, one
// Adam state). Forward runs live; forward + backward (hand-written, checked against finite
// differences in tests/branchNet.test.ts) run in training.

export interface BranchDims {
  /** micro: steps, features per step, conv kernel width, filters. */
  mT: number; mF: number; kW: number; mC: number;
  /** trend: steps, features per step, GRU hidden size. */
  tT: number; tF: number; tH: number;
  /** macro: steps (days), features per day, embedding size. */
  dT: number; dF: number; dE: number;
  /** merge hidden size; outputs (3). */
  hM: number; nOut: number;
}

export interface BranchGates { micro: number; trend: number; macro: number }

interface Layout { [name: string]: { off: number; n: number } }

export function branchLayout(d: BranchDims): { layout: Layout; size: number } {
  const L: Layout = {};
  let off = 0;
  const add = (name: string, n: number) => { L[name] = { off, n }; off += n; };
  add('Wc', d.mC * d.kW * d.mF); add('bc', d.mC);
  for (const g of ['z', 'r', 'h']) { add(`W${g}`, d.tH * d.tF); add(`U${g}`, d.tH * d.tH); add(`b${g}`, d.tH); }
  add('We', d.dE * d.dF); add('be', d.dE); add('Wq', d.dE * d.dE); add('Wk', d.dE * d.dE);
  const nIn = 2 * d.mC + d.tH + 2 * d.dE;
  add('W1', d.hM * nIn); add('b1', d.hM);
  add('W2', d.nOut * d.hM); add('b2', d.nOut);
  return { layout: L, size: off };
}

/** Deterministic initialisation (same seed -> identical networks). */
export function initBranchParams(d: BranchDims, seed: number): Float64Array {
  const { layout, size } = branchLayout(d);
  const p = new Float64Array(size);
  let s = seed >>> 0 || 1;
  const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const fill = (name: string, fanIn: number) => { const { off, n } = layout[name]; const a = 1 / Math.sqrt(fanIn); for (let i = 0; i < n; i++) p[off + i] = (r() * 2 - 1) * a; };
  fill('Wc', d.kW * d.mF);
  for (const g of ['z', 'r', 'h']) { fill(`W${g}`, d.tF); fill(`U${g}`, d.tH); }
  fill('We', d.dF); fill('Wq', d.dE); fill('Wk', d.dE);
  fill('W1', 2 * d.mC + d.tH + 2 * d.dE);
  // Output layer starts at zero: an untrained network predicts the base rate / zero vol change.
  return p;
}

export interface BranchInput {
  /** mT x mF (row-major), normalised; missing -> 0. */
  micro: Float64Array;
  /** tT x tF, oldest first. */
  trend: Float64Array;
  /** dT x dF, oldest first. */
  macro: Float64Array;
}

const sig = (x: number) => 1 / (1 + Math.exp(-x));

export interface BranchCache {
  conv: Float64Array; u: Float64Array; m: Float64Array; out: Float64Array;
  gh: Float64Array; gz: Float64Array; gr: Float64Array; ghh: Float64Array;
  e: Float64Array; q: Float64Array; k: Float64Array; a: Float64Array;
}

/** Forward pass; returns [logit up1h, logit up4h, vol4h] and the cache for backward. */
export function branchForward(d: BranchDims, p: Float64Array, g: BranchGates, x: BranchInput, L = branchLayout(d).layout): { out: Float64Array; cache: BranchCache } {
  const P = d.mT - d.kW + 1;
  // micro: conv + tanh, pooled (mean over positions, last position)
  const conv = new Float64Array(P * d.mC);
  const Wc = L.Wc.off, bc = L.bc.off;
  for (let t = 0; t < P; t++) for (let c = 0; c < d.mC; c++) {
    let a = p[bc + c];
    const wb = Wc + c * d.kW * d.mF;
    for (let k = 0; k < d.kW; k++) { const xb = (t + k) * d.mF, wk = wb + k * d.mF; for (let f = 0; f < d.mF; f++) a += p[wk + f] * x.micro[xb + f]; }
    conv[t * d.mC + c] = Math.tanh(a);
  }
  const nIn = 2 * d.mC + d.tH + 2 * d.dE;
  const u = new Float64Array(nIn);
  for (let c = 0; c < d.mC; c++) {
    let s = 0;
    for (let t = 0; t < P; t++) s += conv[t * d.mC + c];
    u[c] = g.micro * (s / P);
    u[d.mC + c] = g.micro * conv[(P - 1) * d.mC + c];
  }
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
  for (let j = 0; j < H; j++) u[2 * d.mC + j] = g.trend * gh[d.tT * H + j];
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
  const o0 = 2 * d.mC + H;
  for (let j = 0; j < E; j++) {
    let s = 0;
    for (let t = 0; t < d.dT; t++) s += a[t] * e[t * E + j];
    u[o0 + j] = g.macro * s;
    u[o0 + E + j] = g.macro * e[last + j];
  }
  // merge
  const m = new Float64Array(d.hM);
  for (let j = 0; j < d.hM; j++) { let s = p[L.b1.off + j]; const w = L.W1.off + j * nIn; for (let i = 0; i < nIn; i++) s += p[w + i] * u[i]; m[j] = Math.tanh(s); }
  const out = new Float64Array(d.nOut);
  for (let o = 0; o < d.nOut; o++) { let s = p[L.b2.off + o]; const w = L.W2.off + o * d.hM; for (let j = 0; j < d.hM; j++) s += p[w + j] * m[j]; out[o] = s; }
  return { out, cache: { conv, u, m, out, gh, gz, gr, ghh, e, q, k, a } };
}

/** Accumulate dLoss/dParams into `grad` given dLoss/dOut. */
export function branchBackward(d: BranchDims, p: Float64Array, g: BranchGates, x: BranchInput, c: BranchCache, dOut: ArrayLike<number>, grad: Float64Array, L = branchLayout(d).layout): void {
  const nIn = 2 * d.mC + d.tH + 2 * d.dE;
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
  // micro
  const P = d.mT - d.kW + 1;
  for (let t = 0; t < P; t++) for (let ch = 0; ch < d.mC; ch++) {
    let dy = g.micro * du[ch] / P;
    if (t === P - 1) dy += g.micro * du[d.mC + ch];
    const y = c.conv[t * d.mC + ch];
    const da = dy * (1 - y * y);
    if (!da) continue;
    grad[L.bc.off + ch] += da;
    const wb = L.Wc.off + ch * d.kW * d.mF;
    for (let k = 0; k < d.kW; k++) { const xb = (t + k) * d.mF, wk = wb + k * d.mF; for (let f = 0; f < d.mF; f++) grad[wk + f] += da * x.micro[xb + f]; }
  }
  // trend: BPTT
  const H = d.tH, F = d.tF;
  let dh = new Float64Array(H);
  for (let j = 0; j < H; j++) dh[j] = g.trend * du[2 * d.mC + j];
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
  const o0 = 2 * d.mC + H;
  const dctx = new Float64Array(E), de = new Float64Array(T * E);
  const last = (T - 1) * E;
  for (let j = 0; j < E; j++) { dctx[j] = g.macro * du[o0 + j]; de[last + j] += g.macro * du[o0 + E + j]; }
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
