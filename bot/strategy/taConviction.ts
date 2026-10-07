// TA conviction overlay: how the TA network (trained on years of historical candles) and the TA /
// confluence readings steer crypto trading on top of the mathematical fair value.
//
//  1. Pricing tilt. The fair value is the math (Student-t / lognormal model of the index); the TA
//     network's direction forecasts add a drift to it. A forecast P(up over H) is the drift a random
//     walk would need to be up with that probability: z = Phi^-1(P), i.e. an expected move of z sigma
//     over H, or z * sqrt(tau / H) sigma over a contract's remaining life tau. The contract is re-priced
//     with the index moved by weight x reliability x that drift, so the side the network favours is
//     worth more than the math alone says (and the other side less). The shift is capped (maxShift).
//  2. Reliability. Each head counts by what it has proven: a head that passed the blind walk-forward
//     test counts fully; one that did not counts by its own rolling skill on the last graded calls
//     (1 - Brier / 0.25 over up to 168 hourly calls): no better than a coin flip -> no influence; better
//     -> up to full weight. Before 24 graded calls an unvalidated head counts half in paper and not at
//     all in live mode.
//  3. Breadth. The share of TA / confluence signals agreeing with the trade's direction (TA network 1h
//     and 4h, the confluence count, the multi-timeframe trend / momentum rules, RSI and EMA stack):
//     the more agree, the larger the conviction multiplier on the Kelly size (bot/strategy/adversary.ts).
//  4. Altcoin risk-on rule. An altcoin (every asset but BTC by default), when USDT.D is falling and RSI
//     is above 50, is selected first and sized at altBoost x (2.5x) its normal Kelly size, for trades
//     long the underlying (YES on up / above, a perp long): that is the setup the rule describes.
//  5. Selection priority. Markets are evaluated (and setups entered) in priority order: altcoin
//     risk-on first, then by TA conviction, so they get the shared risk budget first.
//  6. Rule book and character. The rules that passed the walk-forward study for the coin's current
//     character join the signals as one combined reading (bot/strategy/ruleBook.ts); in a volatile-
//     systemic market (everything moving together) the conviction boosts stand aside.

import { clamp, normInv } from '../util/num';

/** The TA network's direction readings for an asset (see TaNetOutput). */
export interface TaNetView {
  up1?: number; up4?: number;
  skill1?: number; skill4?: number;
  graded1?: number; graded4?: number;
  validated1?: boolean; validated4?: boolean;
  /** Validated volatility forecast: log(next-4h realised vol / last-24h realised vol); undefined when no
   *  version's vol head is validated. */
  vol4h?: number;
}

export interface ConvictionConfig {
  /** Weight of the TA network's drift in pricing (0 = off, 1 = its full forecast). */
  weight: number;
  /** Largest move of the fair value the tilt may make (probability points). */
  maxShift: number;
  /** Largest |z| a forecast may contribute (z = 0.5 is P(up) = 0.69). */
  maxZ: number;
  /** Live mode: unvalidated heads speak only once their graded skill is positive. */
  live: boolean;
  /** Altcoin risk-on rule. */
  altBoost: number;
  altUsdtdMaxZ: number;
  altRsiMin: number;
  /** Assets that are not altcoins. */
  nonAlts: string[];
}

const H = 3600;
const MIN_GRADED = 24;

/** How much a head counts (0..1). */
export function reliability(validated: boolean | undefined, skill: number | undefined, graded: number | undefined, live: boolean): number {
  const g = graded ?? 0;
  const s = skill !== undefined && Number.isFinite(skill) ? skill : undefined;
  if (validated) return s !== undefined && g >= MIN_GRADED && s < -0.02 ? 0.5 : 1;
  if (s === undefined || g < MIN_GRADED) return live ? 0 : 0.5;
  if (s <= 0) return 0;
  return Math.min(1, 0.5 + s * 25);
}

/** Expected move over `tauSec` in sigma units (of sigma * sqrt(tau)), signed: + = up. Undefined without a usable head. */
export function taDrift(v: TaNetView | undefined, tauSec: number, c: Pick<ConvictionConfig, 'maxZ' | 'live'>): { k: number; parts: string[] } | undefined {
  if (!v || !(tauSec > 0)) return undefined;
  const heads: Array<{ p?: number; r: number; hSec: number; name: string }> = [
    { p: v.up1, r: reliability(v.validated1, v.skill1, v.graded1, c.live), hSec: H, name: '1h' },
    { p: v.up4, r: reliability(v.validated4, v.skill4, v.graded4, c.live), hSec: 4 * H, name: '4h' },
  ];
  let num = 0, den = 0;
  const parts: string[] = [];
  for (const h of heads) {
    if (h.p === undefined || !Number.isFinite(h.p) || h.r <= 0) continue;
    const z = clamp(normInv(clamp(h.p, 1e-4, 1 - 1e-4)), -c.maxZ, c.maxZ);
    // Closer horizons speak louder: weight by how well H matches tau (1 at tau = H, 1/4 at 4x off).
    const match = Math.min(tauSec, h.hSec) / Math.max(tauSec, h.hSec);
    const w = h.r * Math.sqrt(match);
    num += w * z * Math.sqrt(tauSec / h.hSec) * h.r;
    den += w;
    parts.push(`${h.name} P(up) ${h.p.toFixed(3)} x${h.r.toFixed(2)}`);
  }
  if (!(den > 0)) return undefined;
  return { k: num / den, parts };
}

/** Signals oriented so + = bullish for the underlying. */
export function orientedSignals(f: Record<string, number>, v: TaNetView | undefined, live: boolean, rb?: { score: number; n: number }): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const add = (name: string, x: number | undefined, dead = 0) => { if (x !== undefined && Number.isFinite(x) && Math.abs(x) > dead) out.push([name, x]); };
  if (v) {
    if (reliability(v.validated1, v.skill1, v.graded1, live) > 0 && v.up1 !== undefined) add('TA net 1h', v.up1 - 0.5, 0.02);
    if (reliability(v.validated4, v.skill4, v.graded4, live) > 0 && v.up4 !== undefined) add('TA net 4h', v.up4 - 0.5, 0.02);
  }
  add('confluence count', f.conf_count);
  add('MTF trend', f.taconf_net_trend, 0.5);
  add('trend alignment', f.taconf_trend_alignment, 0.1);
  add('MTF momentum', f.taconf_mtf_momentum, 0.1);
  add('RSI 1h', f.ta_rsi_1h, 0.04);
  add('EMA stack 1h', f.ta_ema_stack_1h, 0.1);
  // The rules that passed the walk-forward study for this character (bot/strategy/ruleBook.ts).
  if (rb && rb.n > 0) add('rule book', rb.score, 0.1);
  return out;
}

/** Share of the TA / confluence signals agreeing with `dir` (+1 long the underlying, -1 short), net of
 *  those against it, over at least `minSignals`: 0 (none, or as many against) .. 1 (all agree). */
export function confluenceBreadth(signals: Array<[string, number]>, dir: number, minSignals = 4): { breadth: number; agree: string[]; oppose: string[] } {
  if (dir === 0) return { breadth: 0, agree: [], oppose: [] };
  const agree = signals.filter(([, x]) => Math.sign(x) === Math.sign(dir)).map(([n]) => n);
  const oppose = signals.filter(([, x]) => Math.sign(x) === -Math.sign(dir)).map(([n]) => n);
  return { breadth: clamp((agree.length - oppose.length) / Math.max(minSignals, signals.length), 0, 1), agree, oppose };
}

/** TA network's net direction (-1..1, reliability-weighted), for the adversary's TA-network attack. */
export function taNetDirection(v: TaNetView | undefined, live: boolean): number | undefined {
  if (!v) return undefined;
  let num = 0, den = 0;
  for (const [p, r] of [[v.up1, reliability(v.validated1, v.skill1, v.graded1, live)], [v.up4, reliability(v.validated4, v.skill4, v.graded4, live)]] as const) {
    if (p === undefined || !Number.isFinite(p) || r <= 0) continue;
    num += r * clamp((p - 0.5) * 10, -1, 1); den += r;
  }
  return den > 0 ? num / den : undefined;
}

export const isAltcoin = (asset: string, nonAlts: string[]) => !nonAlts.map((a) => a.toUpperCase()).includes(asset.toUpperCase());

/** The altcoin risk-on rule: USDT.D falling (15-min change below altUsdtdMaxZ sigma) and RSI above
 *  altRsiMin (RSI on the trade's timeframe, as (rsi - 50) / 50). */
export function altcoinRiskOn(asset: string, usdtdZ: number | undefined, rsi: number | undefined, c: Pick<ConvictionConfig, 'altUsdtdMaxZ' | 'altRsiMin' | 'nonAlts'>): { active: boolean; why: string } {
  if (!isAltcoin(asset, c.nonAlts)) return { active: false, why: `${asset} is not an altcoin` };
  if (usdtdZ === undefined || !Number.isFinite(usdtdZ)) return { active: false, why: 'USDT.D change unknown' };
  if (rsi === undefined || !Number.isFinite(rsi)) return { active: false, why: 'RSI unknown' };
  const rsiPct = 50 + 50 * rsi;
  if (!(usdtdZ < c.altUsdtdMaxZ)) return { active: false, why: `USDT.D not falling (${usdtdZ.toFixed(2)} sigma)` };
  if (!(rsiPct > c.altRsiMin)) return { active: false, why: `RSI ${rsiPct.toFixed(0)} not above ${c.altRsiMin}` };
  return { active: true, why: `altcoin risk-on: USDT.D falling (${usdtdZ.toFixed(2)} sigma), RSI ${rsiPct.toFixed(0)}` };
}

/** Selection priority (higher first): altcoin risk-on on top, then TA conviction strength. */
export function selectionPriority(altActive: boolean, taDir: number | undefined, breadthUp: number, breadthDown: number): number {
  return (altActive ? 10 : 0) + Math.abs(taDir ?? 0) + Math.max(breadthUp, breadthDown);
}

/** Conviction for a directional (perp) trade: TA / confluence breadth scales the size up to maxBoost x,
 *  the altcoin risk-on rule multiplies it by altBoost for longs; at most maxTotal x overall. */
export function directionalConviction(asset: string, dir: number, f: Record<string, number>, v: TaNetView | undefined,
  c: ConvictionConfig & { maxBoost: number; maxTotal: number; ruleBook?: { score: number; n: number }; standAside?: string }): { mult: number; priority: number; why: string } {
  const signals = orientedSignals(f, v, c.live, c.ruleBook);
  if (c.standAside) {
    const up0 = confluenceBreadth(signals, 1).breadth, dn0 = confluenceBreadth(signals, -1).breadth;
    return { mult: 1, priority: selectionPriority(false, taNetDirection(v, c.live), up0, dn0), why: `stand aside (${c.standAside}): no conviction boost` };
  }
  const b = confluenceBreadth(signals, dir);
  const taDir = taNetDirection(v, c.live);
  const alt = altcoinRiskOn(asset, f.usdtd_ret_15m_z, f.ta_rsi_1h, c);
  const confMult = 1 + (Math.max(1, c.maxBoost) - 1) * b.breadth;
  // Adversarial veto (perps have no per-entry adversary run): no altcoin boost when the TA network
  // calls the underlying against the trade, or more TA / confluence signals oppose it than agree.
  const veto = taDir !== undefined && Math.sign(taDir) === -Math.sign(dir) && Math.abs(taDir) >= 0.2 ? `TA network against (${taDir.toFixed(2)})`
    : b.oppose.length > b.agree.length ? `${b.oppose.length} TA / confluence signals against vs ${b.agree.length} for` : undefined;
  const altOn = alt.active && dir > 0 && !veto;
  const altMult = altOn ? c.altBoost : 1;
  const mult = Math.min(c.maxTotal, confMult * altMult);
  const why = [`breadth ${b.breadth.toFixed(2)} (${b.agree.length} agree${b.oppose.length ? `, ${b.oppose.length} against` : ''}) x${confMult.toFixed(2)}`,
    altOn ? `${alt.why} x${altMult}` : alt.active && dir > 0 ? `${alt.why}, boost vetoed: ${veto}` : undefined].filter(Boolean).join('; ');
  const up = confluenceBreadth(signals, 1).breadth, dn = confluenceBreadth(signals, -1).breadth;
  return { mult, priority: selectionPriority(altOn, taDir, up, dn), why };
}

/** TaNetView from a TA network output (raw heads with validation and graded skill). */
export function viewOf(o: { raw?: Partial<Record<60 | 240, number>>; rawSkill?: Partial<Record<60 | 240, number>>; rawGraded?: Partial<Record<60 | 240, number>>; validated?: Partial<Record<60 | 240, boolean>> } | undefined): TaNetView | undefined {
  if (!o) return undefined;
  return { up1: o.raw?.[60], up4: o.raw?.[240], skill1: o.rawSkill?.[60], skill4: o.rawSkill?.[240], graded1: o.rawGraded?.[60], graded4: o.rawGraded?.[240], validated1: o.validated?.[60], validated4: o.validated?.[240] };
}
