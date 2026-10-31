/**
 * Correction gain: how much of the SNN's correction to the market to trust, learned from settled outcomes.
 *
 * The audit of the anchored crypto SNN (Oct 31) found its correction p_snn - mid has the right size only near 50c
 * (calibration slope b about 1.1) and is several times too big in high volatility (b 0.13), in the tails
 * (b about 0.3) and on 15m up/down contracts (b 0.10), while it is too timid on some quiet 15m columns (b about 3).
 * Instead of switching the SNN off there, this layer learns, per context, the least-squares gain g in
 *   y - mid = g * (p_snn - mid)
 * and prices at mid + g * (p_snn - mid). The SNN's readout keeps learning from its own (un-gained) probability, so
 * its tags and gradients are unchanged; the gain only sizes how far the bot's price moves off the mid, and it moves
 * back up on its own as the SNN's corrections start paying.
 *
 * g = beta . z, with z the context vector (bias, high vol, low vol, distance of the mid from 50c, 15m horizon,
 * up/down kind). beta is a ridge regression with a forgetting factor, pulled toward g = 1 (trust the SNN as is) by a
 * prior worth `prior` settled rows, and fed a row only once its contract has settled (the caller decides when).
 */

export interface GainContext { mid: number; volRatio: number; horizonMin: number; kind: string }
export interface GainOpts { prior?: number; forget?: number; min?: number; max?: number }

export const GAIN_FEATURES = ['bias', 'vol high', 'vol low', 'tail', '15m', 'updown'] as const;
const K = GAIN_FEATURES.length;
const clipMid = (m: number) => Math.min(0.98, Math.max(0.02, m));

export function gainFeatures(c: GainContext): number[] {
  const tail = Math.min(1, Math.abs(clipMid(c.mid) - 0.5) / 0.45);
  return [1, c.volRatio >= 1.25 ? 1 : 0, c.volRatio < 0.8 ? 1 : 0, tail, c.horizonMin <= 15 ? 1 : 0, c.kind === 'updown' ? 1 : 0];
}

export class CorrectionGain {
  private A: number[]; // K x K, row-major: sum of x^2 z z^T
  private b: number[]; // sum of x e z
  private xx = 0; private n = 0; // running mean of x^2 (scales the prior)
  readonly prior: number; readonly forget: number; readonly min: number; readonly max: number;

  constructor(o: GainOpts = {}) {
    this.prior = o.prior ?? 400; this.forget = o.forget ?? 0.9995; this.min = o.min ?? 0; this.max = o.max ?? 3;
    this.A = new Array(K * K).fill(0); this.b = new Array(K).fill(0);
  }

  /** Learn from one settled row: the SNN's probability, the market mid, and the outcome. */
  update(c: GainContext, pSnn: number, y: 0 | 1): void {
    const m = clipMid(c.mid), x = pSnn - m, e = y - m;
    if (!Number.isFinite(x) || !Number.isFinite(e)) return;
    const z = gainFeatures(c), f = this.forget;
    for (let i = 0; i < K * K; i++) this.A[i] *= f;
    for (let i = 0; i < K; i++) this.b[i] *= f;
    for (let i = 0; i < K; i++) {
      this.b[i] += x * e * z[i];
      for (let j = 0; j < K; j++) this.A[i * K + j] += x * x * z[i] * z[j];
    }
    this.xx = (this.xx * this.n + x * x) / (this.n + 1); this.n = Math.min(this.n + 1, 5000);
  }

  /** The current coefficients: ridge solution pulled toward beta0 = (1, 0, ..., 0). */
  beta(): number[] {
    const lam = this.prior * Math.max(this.xx, 1e-6);
    const M = this.A.slice(), v = this.b.slice();
    for (let i = 0; i < K; i++) M[i * K + i] += lam;
    v[0] += lam; // prior mean beta0 = e_0
    return solve(M, v, K);
  }

  gain(c: GainContext, beta = this.beta()): number {
    const z = gainFeatures(c);
    let g = 0;
    for (let i = 0; i < K; i++) g += beta[i] * z[i];
    return Math.min(this.max, Math.max(this.min, Number.isFinite(g) ? g : 1));
  }

  /** The bot's price: the mid moved by the gained correction. */
  apply(c: GainContext, pSnn: number, beta?: number[]): number {
    const m = clipMid(c.mid);
    return Math.min(0.999, Math.max(0.001, m + this.gain(c, beta) * (pSnn - m)));
  }

  toJSON() { return { A: this.A, b: this.b, xx: this.xx, n: this.n }; }
  load(s: { A: number[]; b: number[]; xx: number; n: number }): void {
    if (s?.A?.length === K * K && s.b?.length === K) { this.A = s.A.slice(); this.b = s.b.slice(); this.xx = s.xx; this.n = s.n; }
  }
}

/** Gaussian elimination with partial pivoting (K is tiny). */
function solve(M: number[], v: number[], n: number): number[] {
  const a = M.slice(), x = v.slice();
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r * n + c]) > Math.abs(a[p * n + c])) p = r;
    if (p !== c) { for (let j = 0; j < n; j++) [a[c * n + j], a[p * n + j]] = [a[p * n + j], a[c * n + j]]; [x[c], x[p]] = [x[p], x[c]]; }
    const d = a[c * n + c];
    if (Math.abs(d) < 1e-15) continue;
    for (let r = c + 1; r < n; r++) {
      const f = a[r * n + c] / d;
      if (!f) continue;
      for (let j = c; j < n; j++) a[r * n + j] -= f * a[c * n + j];
      x[r] -= f * x[c];
    }
  }
  const out = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r];
    for (let j = r + 1; j < n; j++) s -= a[r * n + j] * out[j];
    const d = a[r * n + r];
    out[r] = Math.abs(d) < 1e-15 ? (r === 0 ? 1 : 0) : s / d;
  }
  return out;
}

/** Replay the gain over recorded rows in time order, causally: a row's price uses only rows whose contracts settled
 *  before it (an event's outcome is released at its first row's time plus the column's horizon, which is at or after
 *  its close). Returns the rows with p_snn replaced by the gained price. */
export function replayGain<R extends { eventKey: string; column: string; ts: number; kind: string; mid: number; volRatio: number; pSnn: number; y: 0 | 1 }>(rows: R[], o: GainOpts = {}): R[] {
  const g = new CorrectionGain(o);
  const horizon = (col: string) => { const m = /-(\d+)m$/.exec(col); return m ? Number(m[1]) : 60; };
  const ctx = (r: R): GainContext => ({ mid: r.mid, volRatio: r.volRatio, horizonMin: horizon(r.column), kind: r.kind });
  const sorted = rows.map((r, i) => ({ r, i })).sort((a, b) => a.r.ts - b.r.ts || a.i - b.i);
  const first = new Map<string, number>();
  for (const { r } of sorted) if (!first.has(r.eventKey)) first.set(r.eventKey, r.ts);
  const pending = sorted.map(({ r }) => ({ r, at: first.get(r.eventKey)! + horizon(r.column) * 60_000 })).sort((a, b) => a.at - b.at);
  const out = new Array<R>(rows.length);
  let k = 0, beta = g.beta(), dirty = false;
  for (const { r, i } of sorted) {
    while (k < pending.length && pending[k].at <= r.ts) { const q = pending[k++].r; g.update(ctx(q), q.pSnn, q.y); dirty = true; }
    if (dirty) { beta = g.beta(); dirty = false; }
    out[i] = { ...r, pSnn: g.apply(ctx(r), r.pSnn, beta) };
  }
  return out;
}
