// BTC.D and USDT.D through a replayed day, rebuilt the way the live bot rebuilds them
// (bot/marketdata/dominance.ts): anchored to real dominance readings and moved between them by prices.
//
//   anchors   the stored BTC.D / USDT.D series (TradingView's history and the bot's own hourly bars,
//             spliced by loadIndexSeries) at the finest timeframe there is: hourly where it reaches (the
//             last ~200 days and the bot's own bars), else 4-hourly (~2 years), else daily (back to 2013).
//             A bar's close is the dominance at its close time and is used from then on, never earlier.
//   between   BTC's market cap moves with BTC's price, USDT's stays put (its supply barely moves within
//             a day), and every other coin's moves with the replayed alts (cap-weighted; with BTC when
//             no alt trades), as the live rebuild moves the long tail with its covered basket:
//               BTC.D  = 100 Db r_btc / (Db r_btc + Du + (1 - Db - Du) r_alt)
//               USDT.D = 100 Du       / (Db r_btc + Du + (1 - Db - Du) r_alt)
//             with Db, Du the anchor's fractions and r the price relatives since it.
//   seams     a new anchor seldom lands exactly where the moved value has drifted: the gap is closed
//             geometrically over an hour, so no step appears that the dominance features would read as
//             a move.
// No anchor (before the series start, or a hole of more than 2.5 days) gives no value, as the live feed
// gives none when its inputs are stale.

import { loadIndexSeries, type HistTf } from '../../bot/marketdata/historyStore';

const HOUR = 3_600_000, DAY = 86_400_000;
const TF_MS: Partial<Record<HistTf, number>> = { '1h': HOUR, '4h': 4 * HOUR, '1d': DAY };

/** A dominance reading at `t` (a bar's close), in percent; USDT.D null where its series has nothing near. */
export interface DomAnchor { t: number; btcd: number; usdtd: number | null }

/** Weights of the replayed alts in the "everything else" basket (roughly their market caps). */
export const ALT_WEIGHTS: Record<string, number> = { ETH: 0.6, XRP: 0.15, SOL: 0.15, DOGE: 0.1 };
const OTHER_ALT_WEIGHT = 0.05;
/** How long a new anchor takes to fully replace the moved value. */
export const DOM_BLEND_MS = HOUR;
/** Longest an anchor is used for. */
export const DOM_MAX_STALE_MS = 2.5 * DAY;

/** Close values by close time: every hourly close, then the 4-hourly and daily closes of bars with no finer
 *  close inside them (where finer bars exist the store builds the coarser ones from them, a partial group's
 *  close sitting at the bar's end hours after it was printed; and the finer closes say more anyway). */
function closes(dir: string, asset: string): Map<number, number> {
  const out = new Map<number, number>();
  let finer: number[] = [];
  for (const tf of ['1h', '4h', '1d'] as const) {
    let cs;
    try { cs = loadIndexSeries(dir, asset, tf).candles; } catch { continue; }
    const ms = TF_MS[tf]!, added: number[] = [];
    // Any finer close in (t - ms, t]?
    const inside = (t: number) => { let lo = 0, hi = finer.length; while (lo < hi) { const m = (lo + hi) >> 1; if (finer[m] <= t - ms) lo = m + 1; else hi = m; } return lo < finer.length && finer[lo] <= t; };
    for (const c of cs) {
      const t = c.ts + ms;
      if (c.c > 0 && !inside(t)) { out.set(t, c.c); added.push(t); }
    }
    finer = [...finer, ...added].sort((x, y) => x - y);
  }
  return out;
}

/** The anchors in time order (empty without a stored BTC.D series). */
export function dominanceAnchors(dir: string): DomAnchor[] {
  const b = closes(dir, 'BTC.D'), u = closes(dir, 'USDT.D');
  const ut = [...u.keys()].sort((x, y) => x - y);
  const out: DomAnchor[] = [];
  let j = -1;
  for (const t of [...b.keys()].sort((x, y) => x - y)) {
    while (j + 1 < ut.length && ut[j + 1] <= t) j++;
    out.push({ t, btcd: b.get(t)!, usdtd: j >= 0 && t - ut[j] <= 26 * HOUR ? u.get(ut[j])! : null });
  }
  return out;
}

/** Anchors closing in (from, to]: a replay day's input signature. */
export function anchorsIn(anchors: readonly DomAnchor[], from: number, to: number): number {
  const lb = (x: number) => { let lo = 0, hi = anchors.length; while (lo < hi) { const m = (lo + hi) >> 1; if (anchors[m].t <= x) lo = m + 1; else hi = m; } return lo; };
  return lb(to) - lb(from);
}

/** The rebuild's state between calls (and between replay days): the anchor in use, the prices when it
 *  took over, its fractions, and the seam being closed (factors and start). */
export interface DomState { a: number; px: Record<string, number>; db: number; du: number | null; cb: number; cu: number; at: number }

export class DominanceReplay {
  constructor(private readonly anchors: readonly DomAnchor[], public state?: DomState) {}

  /** BTC.D and USDT.D (percent) at `t` from the prices then (`px`: USDT price per asset). */
  at(t: number, px: Record<string, number>): { btcd: number; usdtd: number | null } | undefined {
    if (!(px.BTC > 0)) return undefined;
    const A = this.anchors;
    let s = this.state;
    let k = s ? s.a : -1;
    while (k + 1 < A.length && A[k + 1].t <= t) k++;
    if (k < 0) return undefined;
    if (!s || k !== s.a) {
      const old = s && t - A[s.a].t <= DOM_MAX_STALE_MS ? value(s, t, px) : undefined;
      const prices: Record<string, number> = {};
      for (const [a, p] of Object.entries(px)) if (p > 0) prices[a] = p;
      const next: DomState = { a: k, px: prices, db: A[k].btcd / 100, du: A[k].usdtd !== null ? A[k].usdtd! / 100 : null, cb: 1, cu: 1, at: t };
      if (old) {
        const fresh = value(next, t, px);
        next.cb = old.btcd / fresh.btcd;
        next.cu = old.usdtd !== null && fresh.usdtd !== null && fresh.usdtd > 0 ? old.usdtd / fresh.usdtd : 1;
      }
      this.state = s = next;
    }
    if (t - A[s.a].t > DOM_MAX_STALE_MS) return undefined;
    return value(s, t, px);
  }
}

function value(s: DomState, t: number, px: Record<string, number>): { btcd: number; usdtd: number | null } {
  const rb = px.BTC / s.px.BTC;
  let w = 0, r = 0;
  for (const [a, p0] of Object.entries(s.px)) {
    if (a === 'BTC' || !(px[a] > 0)) continue;
    const wa = ALT_WEIGHTS[a] ?? OTHER_ALT_WEIGHT;
    w += wa; r += (wa * px[a]) / p0;
  }
  const ra = w > 0 ? r / w : rb;
  const du = s.du ?? 0;
  const den = s.db * rb + du + Math.max(0, 1 - s.db - du) * ra;
  const f = Math.max(0, 1 - (t - s.at) / DOM_BLEND_MS);
  return {
    btcd: ((100 * s.db * rb) / den) * Math.pow(s.cb, f),
    usdtd: s.du === null ? null : ((100 * du) / den) * Math.pow(s.cu, f),
  };
}
