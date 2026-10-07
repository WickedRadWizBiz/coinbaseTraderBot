// Market-wide context for the directional system: breadth across the tracked coins, traditional-market
// risk gauges, and each coin's character (bot/ta/character.ts). Pure functions (shared with the offline
// rule study, research/ruleBook.ts) plus a live holder the bot refreshes as hourly candles close.
//
//   breadth  share of coins whose daily close is above their 20- / 50-day SMA, and
//            (new 20-day highs - new 20-day lows) / coins
//   risk     5-day log changes of DXY, US10Y, VIX and HYG (TradingView daily bars in the history
//            store, refreshed by the training pipeline; a series older than 5 days is ignored)

import fs from 'fs';
import type { Candle } from './indicators';
import type { CandleSet } from './candleStore';
import type { MacroInput } from './analyzer';
import { characterOf, type Character, type CharacterInputs } from './character';
import { loadIndexSeries } from '../marketdata/historyStore';

const D = 86_400_000;
export const RISK_SERIES = { dxy: 'DXY', us10y: 'US10Y', vix: 'VIX', hyg: 'HYG' } as const;
export type RiskKey = keyof typeof RISK_SERIES;

const closedBy = (cs: Candle[], t: number, period = D) => { let lo = 0, hi = cs.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (cs[m].ts + period <= t) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; };

/** Breadth from daily candles per coin, using bars closed by `t` (default: all). */
export function breadthOf(d1s: Candle[][], t = Infinity): MacroInput['breadth'] | undefined {
  let n = 0, a20 = 0, a50 = 0, hi = 0, lo = 0;
  for (const cs of d1s) {
    const j = Number.isFinite(t) ? closedBy(cs, t) : cs.length - 1;
    if (j < 50) continue;
    let s20 = 0, s50 = 0, mx = -Infinity, mn = Infinity;
    for (let k = j - 49; k <= j; k++) { s50 += cs[k].c; if (k > j - 20) s20 += cs[k].c; }
    for (let k = j - 20; k < j; k++) { mx = Math.max(mx, cs[k].h); mn = Math.min(mn, cs[k].l); }
    const c = cs[j].c;
    n++;
    if (c > s20 / 20) a20++;
    if (c > s50 / 50) a50++;
    if (cs[j].h > mx) hi++;
    if (cs[j].l < mn) lo++;
  }
  return n >= 2 ? { above20: a20 / n, above50: a50 / n, hiLo: (hi - lo) / n } : undefined;
}

/** 5-day log changes of the risk gauges, bars closed by `t` (stale series ignored). */
export function riskOf(series: Partial<Record<RiskKey, Candle[]>>, t = Infinity, days = 5, maxAgeDays = 5): MacroInput['risk'] | undefined {
  const out: NonNullable<MacroInput['risk']> = {};
  let any = false;
  for (const k of Object.keys(RISK_SERIES) as RiskKey[]) {
    const cs = series[k];
    if (!cs?.length) continue;
    const j = Number.isFinite(t) ? closedBy(cs, t) : cs.length - 1;
    if (j < days) continue;
    if (Number.isFinite(t) && t - (cs[j].ts + D) > maxAgeDays * D) continue;
    const a = cs[j - days].c, b = cs[j].c;
    if (a > 0 && b > 0) { out[k] = Math.log(b / a); any = true; }
  }
  return any ? out : undefined;
}

export interface CoinCharacter { cls: Character; why: string; x: CharacterInputs; ts: number }

/** Live holder: recomputed when a new hourly candle closes on any coin (at most every 5 minutes). */
export class MarketContext {
  private chars = new Map<string, CoinCharacter>();
  private breadth?: MacroInput['breadth'];
  private risk?: MacroInput['risk'];
  private riskAt = 0;
  private key = '';
  private at = 0;
  version = 0;

  constructor(private readonly histDir?: string) {}

  update(sets: Iterable<CandleSet>, now: number, volFc?: (asset: string) => number | undefined): void {
    const list = [...sets].filter((s) => (s.bars['1h']?.length ?? 0) >= 30);
    const key = list.map((s) => `${s.asset}:${s.lastTs('1h') ?? 0}:${s.lastTs('1d') ?? 0}`).join('|');
    if (key === this.key || now - this.at < 300_000) return;
    this.key = key; this.at = now;
    const h1 = new Map(list.map((s) => [s.asset, s.bars['1h']!]));
    for (const s of list) {
      const others = list.filter((o) => o !== s).map((o) => h1.get(o.asset)!);
      try { this.chars.set(s.asset, { ...characterOf(s.bars['1h']!, s.bars['1d'] ?? [], others, volFc?.(s.asset)), ts: now }); } catch { /* skipped */ }
    }
    this.breadth = breadthOf(list.map((s) => s.bars['1d'] ?? []));
    if (this.histDir && now - this.riskAt >= 3_600_000 && fs.existsSync(this.histDir)) {
      this.riskAt = now;
      const series: Partial<Record<RiskKey, Candle[]>> = {};
      for (const [k, name] of Object.entries(RISK_SERIES) as Array<[RiskKey, string]>) {
        try { const cs = loadIndexSeries(this.histDir, name, '1d').candles; if (cs.length) series[k] = cs; } catch { /* absent */ }
      }
      this.risk = riskOf(series, now);
    }
    this.version++;
  }

  /** Breadth and risk for the analyzer's macro rules. */
  macro(): Pick<MacroInput, 'breadth' | 'risk'> & { ctx: number } { return { breadth: this.breadth, risk: this.risk, ctx: this.version }; }
  character(asset: string): CoinCharacter | undefined { return this.chars.get(asset.toUpperCase()) ?? this.chars.get(asset); }

  status() {
    return {
      breadth: this.breadth ?? null, risk: this.risk ?? null,
      characters: Object.fromEntries([...this.chars].map(([a, c]) => [a, { cls: c.cls, why: c.why, rvPct: round(c.x.rvPct), corr: round(c.x.corr), hurst: round(c.x.hurst), er: round(c.x.er), adx: round(c.x.adx, 1) }])),
    };
  }
}

const round = (x: number, d = 3) => (Number.isFinite(x) ? +x.toFixed(d) : null);

let ctx: MarketContext | undefined;
export function setMarketContext(c: MarketContext | undefined): void { ctx = c; }
export function marketContext(): MarketContext | undefined { return ctx; }
