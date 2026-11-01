// The mid-anchored take gate (job 3 of the TA rework, Oct 31): meta-labeling (Lopez de Prado) on the bot's own entries.
// The fair-value take gate (bot/model/takeModel.ts) learns a residual on the fair value, which Kalshi's mid beats on log
// loss; this one starts from the market's own price for the bought side and learns, from the bot's past entry fills,
// how the TA readings, the iftrades-style trend state, dominance and the order flow move the chance that the side wins.
// The TA pieces never pick the side here: the strategy does. They only decide whether an entry is worth its price.
//
//   P(win) = sigmoid(logit(mid for the side) + b + sum_i w_i z_i),  z_i = (x_i - mean_i) / std_i, a missing x_i -> 0
//
// An entry is skipped when P(win) < price + taker fee (none for a post-only order) + margin. Trained by research/taJobs.ts
// (train-gate) on the days before the split and used only when its held-out log loss beat the mid's. Off unless
// TAKE_MID_GATE names a params file; the same in paper and live.

import fs from 'fs';
import { takerFee, type FeeSchedule } from '../fees';
import { reversalVotes } from '../strategy/reversalLean';

export interface MidGateParams {
  features: string[];
  mean: number[];
  std: number[];
  w: number[];
  b: number;
  /** Held-out check: entries, log loss of the mid alone and of the gate, and whether the gate won. */
  validation: { n: number; logLossMid: number; logLossGate: number; validated: boolean; from?: string; to?: string };
}

const lg = (p: number) => { const q = Math.min(1 - 1e-4, Math.max(1e-4, p)); return Math.log(q / (1 - q)); };

/** The gate's input names (each oriented to the bought side where it has a direction). */
export const MID_GATE_FEATURES = [
  'fv_minus_mid', 'price_minus_mid', 'spread', 'tau_min', 'post_only',
  'bb_pctb_300', 'rsi_14_1m', 'rsi_60', 'ret_60s_z', 'ret_300s_z', 'macd_hist_z', 'reversal_votes',
  'tfi_60s', 'ofi_30s', 'depth_imbalance_5', 'microprice_drift',
  'tanet_up_1h', 'tanet_up_4h', 'conf_count', 'usdtd_ret_15m_z',
  'vol_ratio_15m_4h', 'trade_intensity_60s', 'kaufman_er_120',
] as const;

/** Inputs for an entry on `side` at side price `price`, with the YES mid and decision probability at the decision. */
export function midGateInputs(side: 'yes' | 'no', price: number, postOnly: boolean, pYes: number, midYes: number, spread: number, tauSec: number, f: Record<string, number>): { x: number[]; midSide: number } {
  const s = side === 'yes' ? 1 : -1;
  const midSide = side === 'yes' ? midYes : 1 - midYes;
  const pSide = side === 'yes' ? pYes : 1 - pYes;
  const o = (k: string, c = 0) => (Number.isFinite(f[k]) ? s * (f[k] - c) : NaN);
  const r = (k: string) => (Number.isFinite(f[k]) ? f[k] : NaN);
  const x = [
    pSide - midSide, price - midSide, spread, tauSec / 60, postOnly ? 1 : 0,
    o('bb_pctb_300', 0.5), o('rsi_14_1m', 50), o('rsi_60', 50), o('ret_60s_z'), o('ret_300s_z'), o('macd_hist_z'), s * reversalVotes(f),
    o('tfi_60s'), o('ofi_30s'), o('depth_imbalance_5'), o('microprice_drift'),
    o('tanet_up_1h', 0.5), o('tanet_up_4h', 0.5), o('conf_count'), Number.isFinite(f.usdtd_ret_15m_z) ? -s * f.usdtd_ret_15m_z : NaN,
    r('vol_ratio_15m_4h'), r('trade_intensity_60s'), r('kaufman_er_120'),
  ];
  return { x, midSide };
}

export function midGateProbability(p: MidGateParams, x: number[], midSide: number): number {
  let z = lg(midSide) + p.b;
  for (let i = 0; i < p.w.length; i++) { const v = x[i]; if (Number.isFinite(v) && p.std[i] > 0) z += p.w[i] * Math.max(-6, Math.min(6, (v - p.mean[i]) / p.std[i])); }
  return 1 / (1 + Math.exp(-z));
}

/** Fit by Newton steps on the log loss with an L2 penalty `lambda` (the mid's logit is an offset, not a weight). */
export function fitMidGate(rows: Array<{ x: number[]; midSide: number; won: boolean; weight?: number }>, lambda = 5): Omit<MidGateParams, 'validation'> {
  const k = MID_GATE_FEATURES.length;
  const mean = new Array(k).fill(0), std = new Array(k).fill(1);
  for (let i = 0; i < k; i++) {
    const v = rows.map((r) => r.x[i]).filter(Number.isFinite);
    if (v.length < 20) { std[i] = 0; continue; }
    mean[i] = v.reduce((a, b) => a + b, 0) / v.length;
    std[i] = Math.sqrt(v.reduce((a, b) => a + (b - mean[i]) ** 2, 0) / v.length) || 0;
  }
  const Z = rows.map((r) => r.x.map((v, i) => (Number.isFinite(v) && std[i] > 0 ? Math.max(-6, Math.min(6, (v - mean[i]) / std[i])) : 0)));
  const off = rows.map((r) => lg(r.midSide));
  let th = new Array(k + 1).fill(0); // [w..., b]
  for (let it = 0; it < 25; it++) {
    const g = new Array(k + 1).fill(0);
    const H = Array.from({ length: k + 1 }, () => new Array(k + 1).fill(0));
    for (let n = 0; n < rows.length; n++) {
      const wt = rows[n].weight ?? 1;
      let z = off[n] + th[k];
      for (let i = 0; i < k; i++) z += th[i] * Z[n][i];
      const p = 1 / (1 + Math.exp(-z));
      const e = (p - (rows[n].won ? 1 : 0)) * wt, h = Math.max(1e-9, p * (1 - p)) * wt;
      const zi = [...Z[n], 1];
      for (let a = 0; a <= k; a++) { g[a] += e * zi[a]; if (zi[a] !== 0) for (let c = 0; c <= k; c++) H[a][c] += h * zi[a] * zi[c]; }
    }
    for (let a = 0; a < k; a++) { g[a] += lambda * th[a]; H[a][a] += lambda; }
    H[k][k] += 1e-6;
    const d = solve(H, g);
    if (!d) break;
    th = th.map((t, i) => t - d[i]);
    if (d.reduce((a, v) => a + Math.abs(v), 0) < 1e-8) break;
  }
  return { features: [...MID_GATE_FEATURES], mean, std, w: th.slice(0, k), b: th[k] };
}

function solve(A: number[][], b: number[]): number[] | undefined {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return undefined;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}

const cache = new Map<string, MidGateParams | null>();
/** The params file, read once (null when missing or unreadable: the gate is off). */
export function loadMidGate(file: string): MidGateParams | null {
  if (!file) return null;
  if (!cache.has(file)) { try { cache.set(file, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { cache.set(file, null); } }
  return cache.get(file)!;
}

export interface MidGateCtx {
  pYes: number; mid: number; features: Record<string, number>; tauSec: number; bid: number; ask: number; margin: number; fees?: FeeSchedule;
  /** Flip (TAKE_MID_FLIP, Steven's Nov 1 rule: turn what loses into profit): a skipped entry's other side is bought instead,
   *  post-only at that side's best bid, when the gate gives it P(win) >= its price + margin. On the round 2 audit the
   *  skipped entries won 24% at 27c (-3c a contract); the other side of them is the favourite that the longshot buyer
   *  pays for (Burgi, Deng & Whelan 2026). Maker quotes only (they lost; the taker entries won), and only while flat or
   *  already on the flipped side. */
  flip?: boolean;
  position?: number;
}

/** Drop the entry orders (takes and maker entry quotes) the gate says are not worth their price. Exits always pass. */
type GateOrder = { side: 'bid' | 'ask'; price: number; postOnly: boolean; reduceOnly: boolean; purpose: string; why: string; count?: number; timeInForce?: string };
export function applyMidGate<T extends GateOrder>(plan: { place: T[]; notes: string[] }, p: MidGateParams | null, c: MidGateCtx): number {
  if (!p || !p.validation.validated) return 0;
  let skipped = 0;
  const flips: Array<{ o: T; side: 'yes' | 'no'; price: number }> = [];
  plan.place = plan.place.filter((o) => {
    if (o.reduceOnly || o.purpose === 'exit' || (o.purpose === 'quote' && !o.why.startsWith('maker '))) return true;
    const side = o.side === 'bid' ? 'yes' : 'no';
    const price = side === 'yes' ? o.price : 1 - o.price;
    const { x, midSide } = midGateInputs(side, price, o.postOnly, c.pYes, c.mid, c.ask - c.bid, c.tauSec, c.features);
    const q = midGateProbability(p, x, midSide);
    const breakeven = price + (o.postOnly ? 0 : takerFee(1, price, c.fees)) + c.margin;
    if (q >= breakeven) return true;
    skipped++;
    plan.notes.push(`mid gate: skip ${side.toUpperCase()} @ ${price.toFixed(2)} (P(win) ${q.toFixed(3)} < ${breakeven.toFixed(3)})`);
    if (c.flip && o.purpose === 'quote') flips.push({ o, side, price }); // a maker quote keeps its expiry when flipped
    return false;
  });
  for (const { o, side, price } of flips) {
    const other = side === 'yes' ? 'no' : 'yes';
    const pos = c.position ?? 0;
    if (pos !== 0 && (other === 'yes') !== (pos > 0)) continue;
    const bookSide = other === 'yes' ? 'bid' : 'ask';
    if (plan.place.some((x) => x.side === bookSide && !x.reduceOnly)) continue;
    const yesPrice = other === 'yes' ? c.bid : c.ask; // join the other side's best bid
    const oPrice = other === 'yes' ? yesPrice : 1 - yesPrice;
    if (!(oPrice > 0.01 && oPrice < 0.99)) continue;
    const { x, midSide } = midGateInputs(other, oPrice, true, c.pYes, c.mid, c.ask - c.bid, c.tauSec, c.features);
    const q = midGateProbability(p, x, midSide);
    if (q < oPrice + c.margin) continue;
    const count = Math.max(1, Math.floor((o.count ?? 1) * price / oPrice));
    plan.place.push({ ...o, side: bookSide, price: Math.round(yesPrice * 100) / 100, count, postOnly: true, purpose: 'quote', reduceOnly: false, why: `maker flip: ${other.toUpperCase()} @ ${oPrice.toFixed(2)} instead of ${side.toUpperCase()} @ ${price.toFixed(2)} (P(win) ${q.toFixed(3)})` } as T);
    plan.notes.push(`mid gate: flip to ${other.toUpperCase()} @ ${oPrice.toFixed(2)} (P(win) ${q.toFixed(3)})`);
  }
  return skipped;
}
