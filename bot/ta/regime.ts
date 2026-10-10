// Market regime for strategy switching (bot/strategy/playbook.ts): the coin's character (bot/ta/character.ts:
// calm / trending / volatile-idiosyncratic / volatile-systemic) crossed with the dominant-cycle state of the
// hourly closes, from Ehlers' Hilbert transform as TA-Lib implements it:
//
//   HT_TRENDMODE   1 = the market trends, 0 = it cycles (Ehlers' trend-vs-cycle decision on the dominant cycle)
//   HT_DCPERIOD    the dominant cycle period in bars (shown, not used to switch)
//
// Both run on log closes (scale-free: the same thresholds hold for BTC at $60,000 and DOGE at $0.10), on closed
// hourly bars only, and the mode is the majority of the last 3 bars (one bar's flip is not a new regime). Without
// TA-Lib the mode is unknown and the regime is the character alone.
//
// RegimeTracker adds hysteresis: a new regime is adopted only after it held for `confirm` consecutive hourly
// updates; until then the previous one stays (so a market changing character does not whipsaw the playbook).

import { characterOf, type Character, type CharacterInputs } from './character';
import type { Candle } from './indicators';
import { tl } from './talib';

export type CycleMode = 'trend' | 'cycle';
export interface RegimeState { character: Character; mode?: CycleMode; period?: number; key: string; why: string; x: CharacterInputs }

/** Bars the Hilbert transform is given (it needs ~63 to warm up). */
const HT_BARS = 200;

export const regimeKey = (character: Character, mode?: CycleMode) => (mode ? `${character}:${mode}` : character);

/** Dominant-cycle state of closed hourly bars (undefined without TA-Lib or with too few bars). */
export function cycleState(h1: Candle[]): { mode?: CycleMode; period?: number } {
  const w = h1.slice(-HT_BARS);
  if (w.length < 80) return {};
  const inReal = w.map((c) => Math.log(c.c));
  const tm = tl('HT_TRENDMODE', { inReal }).outInteger;
  const dc = tl('HT_DCPERIOD', { inReal }).outReal;
  const last3 = (tm ?? []).slice(-3).filter((v) => Number.isFinite(v));
  const mode: CycleMode | undefined = last3.length === 3 ? (last3.filter((v) => v === 1).length >= 2 ? 'trend' : 'cycle') : undefined;
  const p = dc?.[dc.length - 1];
  return { mode, period: Number.isFinite(p) ? +p!.toFixed(1) : undefined };
}

/** The regime of a coin from closed bars: its character and its dominant-cycle mode. */
export function regimeOf(h1: Candle[], d1: Candle[], others: Candle[][], volFc?: number): RegimeState {
  const c = characterOf(h1, d1, others, volFc);
  const cy = cycleState(h1);
  return { character: c.cls, mode: cy.mode, period: cy.period, key: regimeKey(c.cls, cy.mode), why: `${c.why}${cy.mode ? `; Hilbert: ${cy.mode} (cycle ${cy.period ?? '?'} h)` : ''}`, x: c.x };
}

/** Hysteresis: the confirmed regime changes only after a new one held for `confirm` updates in a row. */
export class RegimeTracker {
  confirmed?: string;
  since?: number;
  private pending?: { key: string; n: number };
  constructor(private readonly confirm = 2) {}

  update(key: string, now: number): string {
    if (this.confirmed === undefined) { this.confirmed = key; this.since = now; return key; }
    if (key === this.confirmed) { this.pending = undefined; return key; }
    this.pending = this.pending?.key === key ? { key, n: this.pending.n + 1 } : { key, n: 1 };
    if (this.pending.n >= this.confirm) { this.confirmed = key; this.since = now; this.pending = undefined; }
    return this.confirmed;
  }

  status() { return { confirmed: this.confirmed ?? null, since: this.since ?? null, pending: this.pending ? { key: this.pending.key, held: this.pending.n, need: this.confirm } : null }; }
}
