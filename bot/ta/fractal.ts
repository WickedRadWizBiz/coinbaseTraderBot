// Fractal convolution block (FractalNet, Larsson et al. 2016; the "fractal" half of a fractal SNN)
// over a sequence of bars, with drop-path. Expansion rule:
//
//   f_1(z)     = conv(z)
//   f_{C+1}(z) = join( conv(z), f_C( f_C'(z) ) )          (join = mean of the active inputs)
//
// With C = 3 the block holds three columns of causal convolutions (kernel 3) of depth 1, 2 and 4,
// joined where they meet. Convolutions deeper in a column are dilated (1, 2, 4, 8), so the columns
// see the last 3, 7 and 31 bars: single-candle patterns, short structure (a few bars), and swing /
// chart-pattern scale. Every convolution has its own weights (no sharing), 7 in total.
//
// Drop-path regularisation (training only): at every join each input is dropped with probability
// pJoin (at least one is kept), so no column can lean on another; "column" mode keeps exactly one
// column through the whole block (used to measure what each depth contributes on its own).

export type FNode =
  | { t: 'conv'; id: number; col: number; idx: number; dil: number }
  | { t: 'seq'; a: FNode; b: FNode }
  | { t: 'join'; id: number; level: number; kids: [FNode, FNode] };

export interface FractalSpec { depth: number; channels: number; kernel: number }

export interface FractalPlan { root: FNode; convs: Array<{ id: number; col: number; idx: number; dil: number }>; joins: number; params: number }

/** Build the expansion tree: conv ids, their column (1 = shallowest) and position in the column. */
export function buildFractal(spec: FractalSpec): FractalPlan {
  let nextConv = 0, nextJoin = 0;
  const convs: FractalPlan['convs'] = [];
  const mk = (C: number, colShift: number, idxOffset: (col: number) => number): FNode => {
    if (C === 1) {
      const col = 1 + colShift, idx = idxOffset(1);
      const n = { t: 'conv' as const, id: nextConv++, col, idx, dil: 2 ** idx };
      convs.push({ id: n.id, col, idx, dil: n.dil });
      return n;
    }
    const shallow = mk(1, colShift, () => idxOffset(1));
    // Deep part: f_C'(z) first, then f_C. Relative column c of a half is column c + 1 here; a column
    // of the second half continues the same column of the first half, so its positions are offset by
    // that column's depth (2^(c-1)) in the first half.
    const first = mk(C - 1, colShift + 1, (c) => idxOffset(c + 1));
    const second = mk(C - 1, colShift + 1, (c) => idxOffset(c + 1) + 2 ** (c - 1));
    return { t: 'join', id: nextJoin++, level: C, kids: [shallow, { t: 'seq', a: first, b: second }] };
  };
  const root = mk(spec.depth, 0, () => 0);
  const per = spec.channels * spec.kernel * spec.channels + spec.channels;
  return { root, convs, joins: nextJoin, params: convs.length * per };
}

/** Which inputs of each join are active. undefined = all (inference). */
export type JoinMask = Map<number, [boolean, boolean]>;

/** Local drop-path: each join input dropped with probability p, at least one kept. */
export function localDropMask(plan: FractalPlan, p: number, rand: () => number): JoinMask {
  const m: JoinMask = new Map();
  for (let j = 0; j < plan.joins; j++) {
    let a = rand() >= p, b = rand() >= p;
    if (!a && !b) { if (rand() < 0.5) a = true; else b = true; }
    m.set(j, [a, b]);
  }
  return m;
}

/** Keep exactly one column (1 = shallowest ... depth) through the whole block. */
export function columnMask(plan: FractalPlan, column: number): JoinMask {
  const m: JoinMask = new Map();
  const walk = (n: FNode, col: number) => {
    if (n.t === 'conv') return;
    if (n.t === 'seq') { walk(n.a, col); walk(n.b, col); return; }
    if (col <= 1) { m.set(n.id, [true, false]); walk(n.kids[0], 1); return; }
    m.set(n.id, [false, true]);
    walk(n.kids[1], col - 1);
  };
  walk(plan.root, column);
  return m;
}

interface ConvCache { t: 'conv'; x: Float64Array; y: Float64Array }
interface SeqCache { t: 'seq'; a: FCache; b: FCache }
interface JoinCache { t: 'join'; kids: Array<FCache | undefined>; active: [boolean, boolean] }
export type FCache = ConvCache | SeqCache | JoinCache;

/** Forward through the block. x: T x channels (row-major). `off(id)` = parameter offset of conv id. */
export function fractalForward(plan: FractalPlan, spec: FractalSpec, p: Float64Array, off: (id: number) => number, x: Float64Array, T: number, mask?: JoinMask): { y: Float64Array; cache: FCache } {
  const C = spec.channels, K = spec.kernel;
  const run = (n: FNode, inp: Float64Array): { y: Float64Array; cache: FCache } => {
    if (n.t === 'conv') {
      const o0 = off(n.id), bOff = o0 + C * K * C;
      const y = new Float64Array(T * C);
      for (let t = 0; t < T; t++) for (let o = 0; o < C; o++) {
        let a = p[bOff + o];
        for (let k = 0; k < K; k++) {
          const src = t - (K - 1 - k) * n.dil;
          if (src < 0) continue;
          const w = o0 + (o * K + k) * C, xs = src * C;
          for (let i = 0; i < C; i++) a += p[w + i] * inp[xs + i];
        }
        y[t * C + o] = Math.tanh(a);
      }
      return { y, cache: { t: 'conv', x: inp, y } };
    }
    if (n.t === 'seq') {
      const a = run(n.a, inp), b = run(n.b, a.y);
      return { y: b.y, cache: { t: 'seq', a: a.cache, b: b.cache } };
    }
    const active = mask?.get(n.id) ?? [true, true];
    const nAct = (active[0] ? 1 : 0) + (active[1] ? 1 : 0);
    const y = new Float64Array(T * C);
    const kids: Array<FCache | undefined> = [undefined, undefined];
    for (let k = 0; k < 2; k++) {
      if (!active[k]) continue;
      const r = run(n.kids[k], inp);
      kids[k] = r.cache;
      for (let q = 0; q < y.length; q++) y[q] += r.y[q] / nAct;
    }
    return { y, cache: { t: 'join', kids, active } };
  };
  return run(plan.root, x);
}

/** Backward: accumulates parameter gradients, returns dLoss/dx. */
export function fractalBackward(plan: FractalPlan, spec: FractalSpec, p: Float64Array, off: (id: number) => number, cache: FCache, dy: Float64Array, T: number, grad: Float64Array): Float64Array {
  const C = spec.channels, K = spec.kernel;
  const back = (n: FNode, c: FCache, d: Float64Array): Float64Array => {
    if (n.t === 'conv' && c.t === 'conv') {
      const o0 = off(n.id), bOff = o0 + C * K * C;
      const dx = new Float64Array(T * C);
      for (let t = 0; t < T; t++) for (let o = 0; o < C; o++) {
        const yv = c.y[t * C + o];
        const da = d[t * C + o] * (1 - yv * yv);
        if (!da) continue;
        grad[bOff + o] += da;
        for (let k = 0; k < K; k++) {
          const src = t - (K - 1 - k) * n.dil;
          if (src < 0) continue;
          const w = o0 + (o * K + k) * C, xs = src * C;
          for (let i = 0; i < C; i++) { grad[w + i] += da * c.x[xs + i]; dx[xs + i] += da * p[w + i]; }
        }
      }
      return dx;
    }
    if (n.t === 'seq' && c.t === 'seq') return back(n.a, c.a, back(n.b, c.b, d));
    if (n.t === 'join' && c.t === 'join') {
      const nAct = (c.active[0] ? 1 : 0) + (c.active[1] ? 1 : 0);
      const dx = new Float64Array(T * C);
      for (let k = 0; k < 2; k++) {
        if (!c.active[k]) continue;
        const dk = d.map((v) => v / nAct);
        const r = back(n.kids[k], c.kids[k]!, dk);
        for (let q = 0; q < dx.length; q++) dx[q] += r[q];
      }
      return dx;
    }
    throw new Error('fractal cache does not match the plan');
  };
  return back(plan.root, cache, dy);
}

/** Receptive field (bars) of each column: 1 + (kernel - 1) x sum of its dilations. */
export function columnReach(plan: FractalPlan, spec: FractalSpec): number[] {
  const cols = Math.max(...plan.convs.map((c) => c.col));
  return Array.from({ length: cols }, (_, j) => 1 + (spec.kernel - 1) * plan.convs.filter((c) => c.col === j + 1).reduce((s, c) => s + c.dil, 0));
}
