// Live model health (institutional blueprint 6.5 / 8.4): the model must keep
// beating the calibrated market on log loss out of sample.
//
// At every entry-eligible decision the engine records (P_model, P_market_cal)
// for the contract; when the contract settles, the last recorded pair is
// scored. Contracts closing together are one settlement window (one outcome
// variable per asset/time), so scores are averaged per window. Over the most
// recent windows we test the loss differential d = LL_model - LL_market with a
// Diebold-Mariano statistic; if the model is significantly WORSE (one-sided
// p < 0.05 with at least minWindows windows) new risk halts until a reviewed
// redeploy. Also reports the realized advantage for the dashboard.

import { readJson, writeJsonAtomic } from '../util/persist';
import { normCdf } from '../util/num';

interface Snap { pModel: number; pMarket: number; closeTs: number }
interface WindowScore { closeTs: number; d: number; n: number }

export interface ModelHealthState { windows: WindowScore[] }

const ll = (p: number, y: number) => { const q = Math.min(1 - 1e-6, Math.max(1e-6, p)); return y ? -Math.log(q) : -Math.log(1 - q); };

export class ModelHealth {
  private readonly snaps = new Map<string, Snap>();
  private st: ModelHealthState;

  constructor(private readonly p: { minWindows: number; keep?: number }, private readonly file?: string) {
    this.st = (file && readJson<ModelHealthState>(file, { quarantine: true })) || { windows: [] };
  }

  record(ticker: string, pModel: number, pMarket: number, closeTs: number): void {
    this.snaps.set(ticker, { pModel, pMarket, closeTs });
  }

  onResult(ticker: string, result: 'yes' | 'no'): void {
    const s = this.snaps.get(ticker);
    if (!s) return;
    this.snaps.delete(ticker);
    const y = result === 'yes' ? 1 : 0;
    const d = ll(s.pModel, y) - ll(s.pMarket, y);
    const w = this.st.windows.find((x) => x.closeTs === s.closeTs);
    if (w) { w.d = (w.d * w.n + d) / (w.n + 1); w.n++; } else this.st.windows.push({ closeTs: s.closeTs, d, n: 1 });
    this.st.windows.sort((a, b) => a.closeTs - b.closeTs);
    const keep = this.p.keep ?? 500;
    if (this.st.windows.length > keep) this.st.windows = this.st.windows.slice(-keep);
    if (this.file) writeJsonAtomic(this.file, this.st);
  }

  status() {
    const d = this.st.windows.map((w) => w.d);
    const n = d.length;
    if (n < 10) return { windows: n, advantage: null as number | null, pWorse: null as number | null, halt: false };
    const m = d.reduce((a, b) => a + b, 0) / n;
    const L = Math.floor(Math.cbrt(n));
    const g = (k: number) => { let s = 0; for (let t = k; t < n; t++) s += (d[t] - m) * (d[t - k] - m); return s / n; };
    let v = g(0);
    for (let k = 1; k <= L; k++) v += 2 * (1 - k / (L + 1)) * g(k);
    const stat = m / Math.sqrt(Math.max(1e-18, v / n));
    const pWorse = 1 - normCdf(stat);
    // advantage > 0: model log loss lower than the calibrated market's.
    return { windows: n, advantage: -m, pWorse, halt: n >= this.p.minWindows && pWorse < 0.05 };
  }

  forget(ticker: string): void { this.snaps.delete(ticker); }
}
