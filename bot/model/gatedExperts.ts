// Two experts and a gate (the 4th-generation spec's 6.3, as reviewed): a trend expert (momentum, the TA library,
// the TA network) and a microstructure expert (order-flow imbalance, toxicity, depth, trade bursts), mixed by a
// smooth coefficient
//
//     gamma(t) = sigmoid(g0 + g . drivers)        drivers: how fast volatility is changing (dsigma/dt proxies)
//                                                 and the SNN governor level
//     output   = base + (1 - gamma) x trendExpert + gamma x microExpert
//
// so that when volatility turns abruptly the weight moves from the lagging trend readings to the real-time order
// flow. Both experts are linear on z-scored inputs (missing inputs read as the training mean); the gate is fitted
// with them, jointly, by full-batch Adam with L2 and early stopping on a validation split. It lives in the
// recordings-trained decision layer (the take model, the perps model) because the microstructure inputs exist
// only in the recordings; it is one candidate among the others there and is used only when it wins on held-out
// data.

export interface GatedExperts {
  loss: 'logistic' | 'squared';
  /** Indices into the input vector: trend expert, microstructure expert, gate drivers. */
  trend: number[];
  micro: number[];
  drivers: number[];
  /** z-scoring per input index (full vector). */
  mean: number[];
  std: number[];
  wT: number[]; bT: number;
  wM: number[]; bM: number;
  g: number[]; g0: number;
  /** Mean gamma on the training rows (how much the micro expert carried on average). */
  meanGamma?: number;
}

const sig = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
const zOf = (m: { mean: number[]; std: number[] }, x: number[], i: number) => { const v = x[i]; return Number.isFinite(v) && m.std[i] > 0 ? Math.max(-5, Math.min(5, (v - m.mean[i]) / m.std[i])) : 0; };

/** The model's output (a logit for logistic, a value for squared) on input vector `x` around `base`, and gamma. */
export function gatedPredict(m: GatedExperts, x: number[], base = 0): { y: number; gamma: number; trend: number; micro: number } {
  let zT = m.bT, zM = m.bM, zg = m.g0;
  m.trend.forEach((i, k) => { zT += m.wT[k] * zOf(m, x, i); });
  m.micro.forEach((i, k) => { zM += m.wM[k] * zOf(m, x, i); });
  m.drivers.forEach((i, k) => { zg += m.g[k] * zOf(m, x, i); });
  const gamma = sig(zg);
  return { y: base + (1 - gamma) * zT + gamma * zM, gamma, trend: zT, micro: zM };
}

export interface GatedFitOpts {
  loss: 'logistic' | 'squared';
  trend: number[]; micro: number[]; drivers: number[];
  /** Offsets per row (e.g. the fair-value logit the take model corrects). */
  base?: number[];
  val?: { X: number[][]; y: number[]; base?: number[] };
  l2?: number; lr?: number; epochs?: number; patience?: number;
}

function lossOf(m: GatedExperts, X: number[][], y: number[], base?: number[]): number {
  let s = 0;
  for (let r = 0; r < X.length; r++) {
    const o = gatedPredict(m, X[r], base?.[r] ?? 0).y;
    if (m.loss === 'logistic') { const p = Math.min(1 - 1e-6, Math.max(1e-6, sig(o))); s -= y[r] ? Math.log(p) : Math.log(1 - p); }
    else s += (o - y[r]) ** 2;
  }
  return s / Math.max(1, X.length);
}

/** Fit both experts and the gate jointly. Returns undefined with too few rows. */
export function fitGatedExperts(X: number[][], y: number[], o: GatedFitOpts): GatedExperts | undefined {
  const n = X.length;
  if (n < 50) return undefined;
  const d = X[0].length;
  const mean = new Array(d).fill(0), std = new Array(d).fill(1);
  for (let i = 0; i < d; i++) {
    const v = X.map((r) => r[i]).filter(Number.isFinite);
    if (v.length < 10) { std[i] = 0; continue; }
    const mu = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, v.length - 1));
    mean[i] = mu; std[i] = sd > 1e-12 ? sd : 0;
  }
  // Squared loss: scale the targets so one learning rate serves both losses.
  const ys = o.loss === 'squared' ? Math.max(1e-9, Math.sqrt(y.reduce((a, b) => a + b * b, 0) / n)) : 1;
  const yy = y.map((v) => v / ys), bb = o.base?.map((v) => v / ys);
  const m: GatedExperts = {
    loss: o.loss, trend: [...o.trend], micro: [...o.micro], drivers: [...o.drivers], mean, std,
    wT: new Array(o.trend.length).fill(0), bT: 0, wM: new Array(o.micro.length).fill(0), bM: 0, g: new Array(o.drivers.length).fill(0), g0: 0,
  };
  // Pre-z-scored inputs.
  const Z = X.map((r) => ({ t: m.trend.map((i) => zOf(m, r, i)), u: m.micro.map((i) => zOf(m, r, i)), g: m.drivers.map((i) => zOf(m, r, i)) }));
  const nP = m.wT.length + 1 + m.wM.length + 1 + m.g.length + 1;
  const params = () => [...m.wT, m.bT, ...m.wM, m.bM, ...m.g, m.g0];
  const setParams = (p: number[]) => {
    let k = 0;
    for (let i = 0; i < m.wT.length; i++) m.wT[i] = p[k++];
    m.bT = p[k++];
    for (let i = 0; i < m.wM.length; i++) m.wM[i] = p[k++];
    m.bM = p[k++];
    for (let i = 0; i < m.g.length; i++) m.g[i] = p[k++];
    m.g0 = p[k++];
  };
  const l2 = o.l2 ?? 1e-3, lr = o.lr ?? 0.03, epochs = o.epochs ?? 600, patience = o.patience ?? 40;
  const mA = new Array(nP).fill(0), vA = new Array(nP).fill(0);
  const scaled = (mm: GatedExperts): GatedExperts => (ys === 1 ? mm : { ...mm, wT: mm.wT.map((w) => w * ys), bT: mm.bT * ys, wM: mm.wM.map((w) => w * ys), bM: mm.bM * ys });
  let best = { loss: Infinity, p: params() }, since = 0;
  for (let ep = 1; ep <= epochs; ep++) {
    const grad = new Array(nP).fill(0);
    for (let r = 0; r < n; r++) {
      const z = Z[r];
      let zT = m.bT, zM = m.bM, zg = m.g0;
      for (let k = 0; k < z.t.length; k++) zT += m.wT[k] * z.t[k];
      for (let k = 0; k < z.u.length; k++) zM += m.wM[k] * z.u[k];
      for (let k = 0; k < z.g.length; k++) zg += m.g[k] * z.g[k];
      const gm = sig(zg);
      const out = (bb?.[r] ?? 0) + (1 - gm) * zT + gm * zM;
      const e = o.loss === 'logistic' ? sig(out) - yy[r] : 2 * (out - yy[r]);
      let k = 0;
      for (let j = 0; j < z.t.length; j++) grad[k++] += e * (1 - gm) * z.t[j];
      grad[k++] += e * (1 - gm);
      for (let j = 0; j < z.u.length; j++) grad[k++] += e * gm * z.u[j];
      grad[k++] += e * gm;
      const dg = e * (zM - zT) * gm * (1 - gm);
      for (let j = 0; j < z.g.length; j++) grad[k++] += dg * z.g[j];
      grad[k++] += dg;
    }
    const p = params();
    for (let k = 0; k < nP; k++) {
      const gk = grad[k] / n + l2 * p[k];
      mA[k] = 0.9 * mA[k] + 0.1 * gk; vA[k] = 0.999 * vA[k] + 0.001 * gk * gk;
      p[k] -= (lr * (mA[k] / (1 - 0.9 ** ep))) / (Math.sqrt(vA[k] / (1 - 0.999 ** ep)) + 1e-8);
    }
    setParams(p);
    if (o.val && ep % 5 === 0) {
      const vl = lossOf(scaled(m), o.val.X, o.val.y, o.val.base);
      if (vl < best.loss - 1e-6) { best = { loss: vl, p: params() }; since = 0; } else if ((since += 5) >= patience) break;
    }
  }
  if (o.val && Number.isFinite(best.loss)) setParams(best.p);
  const out = scaled(m);
  out.meanGamma = X.reduce((s, r) => s + gatedPredict(out, r).gamma, 0) / n;
  return out;
}

/** The fitted model's loss on rows (log loss or mean squared error). */
export function gatedLoss(m: GatedExperts, X: number[][], y: number[], base?: number[]): number { return lossOf(m, X, y, base); }
