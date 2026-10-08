// Evolved trading formulas (genetic programming, research/gpIndicators.ts): the expression language, its
// vectorised evaluation over hourly bars, and the exposure it gives. Shared by the research that evolves the
// formulas and the live bot that reads the champions (bot/gp/gpSignals.ts), so both compute the same thing.
//
// A formula is a tree stored in prefix order (DEAP's PrimitiveTree): a list of tokens, each a function
// followed by its arguments. It maps the coins' hourly bars to a desired exposure for one coin:
//
//   inputs     per coin A of the formula's inputs (the coin itself and the cross-market coins, BTC and ETH by
//              default), from each closed hourly bar, scale-free so a formula means the same in every year:
//                A.c  log return of the bar (close / previous close)
//                A.o  log(open / close)      A.h  log(high / close)      A.l  log(low / close)
//                A.v  log(volume / mean volume of the last 24 bars)
//   constants  numbers in -1..1 (ephemeral constants, drawn when the tree is made)
//   functions  add sub mul div (protected: x / ~0 = x) sin cos tan tanh gt (a > b ? 1 : -1), and over a
//              window of the last w bars: lag<w> delta<w> (x - lag) mean<w> std<w> max<w> min<w> sum<w> z<w>
//              (x - mean) / std
//   output     the desired exposure: clipped to -1..+1 (-100 % short .. +100 % long), not-a-number -> 0
//   dead band  the position held only moves when the desired exposure is more than `band` (0.10) away from
//              it, so small wiggles of the formula do not pay fees (the video's 10 % no-trade band)
//
// Every window function looks back a fixed number of bars, so a formula's value at a bar depends on the last
// lookback(tokens) bars only: the live bot's 320 hourly bars give exactly what the research computed.

export type Token = string;

export const FIELDS = ['c', 'o', 'h', 'l', 'v'] as const;
export type Field = typeof FIELDS[number];
/** Bars before a field is defined (volume ratio: a 24-bar mean). */
const FIELD_LOOKBACK: Record<Field, number> = { c: 1, o: 0, h: 0, l: 0, v: 23 };

export const BINARY = ['add', 'sub', 'mul', 'div', 'gt'] as const;
export const UNARY = ['sin', 'cos', 'tan', 'tanh'] as const;
export const WINDOW_OPS = ['lag', 'delta', 'mean', 'std', 'max', 'min', 'sum', 'z'] as const;
export type WindowOp = typeof WINDOW_OPS[number];
/** Windows (bars) per window function: lags from one bar, statistics over at least three. */
export const LAG_WINDOWS = [1, 2, 4, 8, 24];
export const ROLL_WINDOWS = [3, 6, 12, 24, 48, 96];
export const windowsOf = (op: WindowOp) => (op === 'lag' || op === 'delta' ? LAG_WINDOWS : ROLL_WINDOWS);

/** Most bars a champion may look back (the live bot keeps 320 hourly bars per coin). */
export const MAX_LOOKBACK = 240;

export type Parsed =
  | { kind: 'bin'; op: typeof BINARY[number] }
  | { kind: 'un'; op: typeof UNARY[number] }
  | { kind: 'win'; op: WindowOp; w: number }
  | { kind: 'in'; asset: string; field: Field }
  | { kind: 'const'; v: number };

const WIN_RE = /^(lag|delta|mean|std|max|min|sum|z)(\d+)$/;
const IN_RE = /^([A-Z0-9]+)\.([cohlv])$/;
const cache = new Map<string, Parsed>();

export function parseToken(t: Token): Parsed {
  const hit = cache.get(t);
  if (hit) return hit;
  let p: Parsed;
  if ((BINARY as readonly string[]).includes(t)) p = { kind: 'bin', op: t as typeof BINARY[number] };
  else if ((UNARY as readonly string[]).includes(t)) p = { kind: 'un', op: t as typeof UNARY[number] };
  else {
    const w = WIN_RE.exec(t), i = IN_RE.exec(t);
    if (w) p = { kind: 'win', op: w[1] as WindowOp, w: Number(w[2]) };
    else if (i) p = { kind: 'in', asset: i[1], field: i[2] as Field };
    else if (t.trim() !== '' && Number.isFinite(Number(t))) p = { kind: 'const', v: Number(t) };
    else throw new Error(`unknown formula token ${JSON.stringify(t)}`);
  }
  if (cache.size < 50_000) cache.set(t, p);
  return p;
}

export const arity = (t: Token): number => { const p = parseToken(t); return p.kind === 'bin' ? 2 : p.kind === 'un' || p.kind === 'win' ? 1 : 0; };

/** End (exclusive) of the subtree starting at index i. */
export function subtreeEnd(tokens: Token[], i: number): number {
  let need = 1, j = i;
  while (need > 0) {
    if (j >= tokens.length) throw new Error('truncated formula');
    need += arity(tokens[j]) - 1;
    j++;
  }
  return j;
}

/** A well-formed formula: one complete tree, every token known. */
export function isValid(tokens: Token[]): boolean {
  try { return tokens.length > 0 && subtreeEnd(tokens, 0) === tokens.length; } catch { return false; }
}

/** Depth of the tree (a single input or constant is 0). */
export function depthOf(tokens: Token[]): number {
  let max = 0;
  const stack: number[] = [0];
  for (const t of tokens) {
    const d = stack.pop()!;
    max = Math.max(max, d);
    for (let k = 0; k < arity(t); k++) stack.push(d + 1);
  }
  return max;
}

/** Bars the formula looks back past the current one. */
export function lookbackOf(tokens: Token[], i = 0): number {
  const p = parseToken(tokens[i]);
  if (p.kind === 'const') return 0;
  if (p.kind === 'in') return FIELD_LOOKBACK[p.field];
  if (p.kind === 'un') return lookbackOf(tokens, i + 1);
  if (p.kind === 'win') return (p.op === 'lag' || p.op === 'delta' ? p.w : p.w - 1) + lookbackOf(tokens, i + 1);
  const j = subtreeEnd(tokens, i + 1);
  return Math.max(lookbackOf(tokens, i + 1), lookbackOf(tokens, j));
}

/** Coins the formula reads. */
export function assetsOf(tokens: Token[]): string[] {
  return [...new Set(tokens.map(parseToken).flatMap((p) => (p.kind === 'in' ? [p.asset] : [])))].sort();
}

/** Readable form: infix arithmetic, function calls for the rest. */
export function formulaText(tokens: Token[]): string {
  const go = (i: number): [string, number] => {
    const p = parseToken(tokens[i]);
    if (p.kind === 'const') return [String(+p.v.toFixed(4)), i + 1];
    if (p.kind === 'in') return [tokens[i], i + 1];
    if (p.kind === 'un' || p.kind === 'win') { const [a, j] = go(i + 1); return [`${tokens[i]}(${a})`, j]; }
    const [a, j] = go(i + 1), [b, k] = go(j);
    const sym = { add: '+', sub: '-', mul: '*', div: '/' } as Record<string, string>;
    return [sym[p.op] ? `(${a} ${sym[p.op]} ${b})` : `${p.op}(${a}, ${b})`, k];
  };
  const s = go(0)[0];
  return ['add', 'sub', 'mul', 'div'].includes(tokens[0]) ? s.slice(1, -1) : s;
}

// ---- Inputs --------------------------------------------------------------------------------------

/** One closed hourly bar (the candle store's shape). */
export interface Bar { ts: number; o: number; h: number; l: number; c: number; v: number }

/** Input columns over a timeline: `A.f` -> one value per bar. */
export interface Inputs { n: number; ts: Float64Array; cols: Map<string, Float64Array> }

/**
 * The inputs on the target coin's timeline: every other coin aligned to it by time (its latest bar opened at
 * or before each target bar; a missing bar repeats the last close, with no range and no volume). Bars of a
 * coin that has not started yet are not-a-number.
 */
export function buildInputs(target: string, bars: Record<string, Bar[]>): Inputs {
  const tb = bars[target] ?? [];
  const n = tb.length;
  const ts = new Float64Array(n);
  for (let i = 0; i < n; i++) ts[i] = tb[i].ts;
  const cols = new Map<string, Float64Array>();
  for (const [asset, bs] of Object.entries(bars)) {
    const c = new Float64Array(n).fill(NaN), o = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n), v = new Float64Array(n).fill(NaN);
    const close = new Float64Array(n).fill(NaN), vol = new Float64Array(n).fill(NaN);
    let j = -1;
    for (let i = 0; i < n; i++) {
      while (j + 1 < bs.length && bs[j + 1].ts <= ts[i]) j++;
      if (j < 0) { o[i] = h[i] = l[i] = NaN; continue; }
      const b = bs[j];
      close[i] = b.c;
      if (b.ts === ts[i]) { o[i] = Math.log(b.o / b.c); h[i] = Math.log(b.h / b.c); l[i] = Math.log(b.l / b.c); vol[i] = b.v; }
      else { o[i] = h[i] = l[i] = 0; vol[i] = 0; }
      if (i > 0 && close[i - 1] > 0) c[i] = Math.log(close[i] / close[i - 1]);
    }
    // Volume against its 24-bar mean (log; 0 when the coin traded nothing in the last day).
    let s = 0, nan = 0;
    for (let i = 0; i < n; i++) {
      const x = vol[i];
      if (Number.isNaN(x)) nan++; else s += x;
      if (i >= 24) { const y = vol[i - 24]; if (Number.isNaN(y)) nan--; else s -= y; }
      if (i >= 23 && nan === 0) { const m = s / 24; v[i] = m > 0 ? Math.log((x + 1e-9 * m) / m) : 0; }
    }
    cols.set(`${asset}.c`, c); cols.set(`${asset}.o`, o); cols.set(`${asset}.h`, h); cols.set(`${asset}.l`, l); cols.set(`${asset}.v`, v);
  }
  return { n, ts, cols };
}

// ---- Evaluation ----------------------------------------------------------------------------------

function windowed(op: WindowOp, w: number, x: Float64Array, n: number): Float64Array {
  const out = new Float64Array(n).fill(NaN);
  if (op === 'lag' || op === 'delta') {
    for (let i = w; i < n; i++) out[i] = op === 'lag' ? x[i - w] : x[i] - x[i - w];
    return out;
  }
  if (op === 'max' || op === 'min') {
    // Monotonic deque of indices; a not-a-number anywhere in the window gives not-a-number.
    const dq = new Int32Array(n);
    let head = 0, tail = 0, lastNan = -Infinity;
    const better = op === 'max' ? (a: number, b: number) => a >= b : (a: number, b: number) => a <= b;
    for (let i = 0; i < n; i++) {
      const xi = x[i];
      if (Number.isNaN(xi)) { lastNan = i; head = tail = 0; continue; }
      while (tail > head && better(xi, x[dq[tail - 1]])) tail--;
      dq[tail++] = i;
      while (dq[head] <= i - w) head++;
      if (i >= w - 1 && lastNan <= i - w) out[i] = x[dq[head]];
    }
    return out;
  }
  // Running sums over the window, re-summed every 1024 bars so rounding never drifts. The result must not depend
  // on how much history came before (the live bot has 320 bars, the research years), so where rounding would
  // decide it the window is computed directly: a constant window is exactly its value (std 0, z 0), and a
  // variance small against the mean (cancellation) is recomputed in two passes over the window.
  let s = 0, s2 = 0, nan = 0, run = 0;
  for (let i = 0; i < n; i++) {
    const xi = x[i];
    if (i > 0 && !(xi === x[i - 1])) run = i;
    if (Number.isNaN(xi)) nan++; else { s += xi; s2 += xi * xi; }
    if (i >= w) { const y = x[i - w]; if (Number.isNaN(y)) nan--; else { s -= y; s2 -= y * y; } }
    if ((i & 1023) === 1023 && i >= w - 1) { s = 0; s2 = 0; for (let k = i - w + 1; k <= i; k++) if (!Number.isNaN(x[k])) { s += x[k]; s2 += x[k] * x[k]; } }
    if (i < w - 1 || nan > 0) continue;
    if (i - run + 1 >= w) { out[i] = op === 'mean' ? xi : op === 'sum' ? xi * w : 0; continue; }
    let m = s / w;
    if (op === 'mean') { out[i] = m; continue; }
    if (op === 'sum') { out[i] = s; continue; }
    let v = (s2 - w * m * m) / (w - 1);
    if (!(v > 1e-8 * m * m)) {
      let d = 0;
      for (let k = i - w + 1; k <= i; k++) d += x[k];
      m = d / w; v = 0;
      for (let k = i - w + 1; k <= i; k++) v += (x[k] - m) ** 2;
      v /= w - 1;
    }
    const sd = Math.sqrt(Math.max(0, v));
    if (op === 'std') out[i] = sd;
    else out[i] = sd > 1e-9 * Math.abs(m) && sd > 0 ? (xi - m) / sd : 0;
  }
  return out;
}

/** The formula over every bar of the inputs (raw, before clipping). An input the data lacks is not-a-number. */
export function evaluate(tokens: Token[], inp: Inputs): Float64Array {
  const n = inp.n;
  const go = (i: number): [Float64Array, number] => {
    const p = parseToken(tokens[i]);
    if (p.kind === 'const') return [new Float64Array(n).fill(p.v), i + 1];
    if (p.kind === 'in') { const col = inp.cols.get(tokens[i]); return [col ? col : new Float64Array(n).fill(NaN), i + 1]; }
    if (p.kind === 'win') { const [a, j] = go(i + 1); return [windowed(p.op, p.w, a, n), j]; }
    if (p.kind === 'un') {
      const [a, j] = go(i + 1);
      const out = new Float64Array(n);
      const f = p.op === 'sin' ? Math.sin : p.op === 'cos' ? Math.cos : p.op === 'tan' ? Math.tan : Math.tanh;
      for (let k = 0; k < n; k++) out[k] = f(a[k]);
      return [out, j];
    }
    const [a, j] = go(i + 1);
    const [b, k2] = go(j);
    const out = new Float64Array(n);
    switch (p.op) {
      case 'add': for (let k = 0; k < n; k++) out[k] = a[k] + b[k]; break;
      case 'sub': for (let k = 0; k < n; k++) out[k] = a[k] - b[k]; break;
      case 'mul': for (let k = 0; k < n; k++) out[k] = a[k] * b[k]; break;
      case 'div': for (let k = 0; k < n; k++) out[k] = Math.abs(b[k]) > 1e-8 ? a[k] / b[k] : a[k]; break;
      case 'gt': for (let k = 0; k < n; k++) out[k] = Number.isNaN(a[k]) || Number.isNaN(b[k]) ? NaN : a[k] > b[k] ? 1 : -1; break;
    }
    return [out, k2];
  };
  return go(0)[0];
}

/** Desired exposure per bar: clipped to -1..+1, not-a-number (warm-up, missing data) -> 0. */
export function desiredExposure(raw: Float64Array): Float64Array {
  const out = new Float64Array(raw.length);
  for (let i = 0; i < raw.length; i++) { const x = raw[i]; out[i] = Number.isNaN(x) ? 0 : x > 1 ? 1 : x < -1 ? -1 : x; }
  return out;
}

/** Exposure actually held: moves to the desired exposure only when that is more than `band` away. */
export function heldExposure(desired: Float64Array, band: number, start = 0): Float64Array {
  const out = new Float64Array(desired.length);
  let cur = start;
  for (let i = 0; i < desired.length; i++) {
    if (Math.abs(desired[i] - cur) > band) cur = desired[i];
    out[i] = cur;
  }
  return out;
}
