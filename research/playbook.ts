// Learns the strategy playbook (bot/strategy/playbook.ts): per market regime, how much weight each strategy family
// (Kalshi contracts, perps setups) should carry, from what each family earned in each coin's regime on whole-bot
// replay days (research/wholeBot.ts, byAsset).
//
//   labels     each coin's regime at the START of each day (bot/ta/regime.ts on bars closed before midnight: what
//              the live bot knows at that moment, no look-ahead), per coin: an altcoin can trend while BTC ranges
//   samples    per regime and family: that family's P&L on that coin that day (coin-days)
//   weights    per family, from the bootstrap 90% interval of the mean coin-day P&L in the regime:
//                upper bound below 0          0    (it loses there: no new risk)
//                mean below 0                 0.5  (likely loses: half)
//                lower bound above 0, and
//                better than the family overall   the family's maximum (Kalshi 1, perps 1.5)
//                otherwise                    1
//              with fewer than MIN_SAMPLES coin-days a regime keeps 1 (and falls back to its character's entry)
//   validation walk-forward: weights learned on the earlier 70% of days, applied to the later 30%; the playbook is
//              switched on only if that beats the static bot (more profit, drawdown at most 10% deeper, 10+ days).
//              Weights scale size, so a family's P&L is taken to scale with its weight (each day's stop starts
//              afresh; compounding inside a day is ignored). The entries written are learned on every day.

import type { Candle } from '../bot/ta/indicators';
import { regimeOf } from '../bot/ta/regime';
import { WEIGHT_RANGE, type PlaybookEntry, type PlaybookFile } from '../bot/strategy/playbook';
import { loadHistory } from './history/candles';

export const MIN_SAMPLES = 8;
const FAMILIES = ['kalshi', 'perps'] as const;
type Family = typeof FAMILIES[number];

export interface CoinDay { day: string; asset: string; regime: string; kalshi: number; perps: number }

const D = 86_400_000;

/** Each coin's regime at the start of each day, from bars closed before it. */
export function dayRegimes(historyDir: string, days: string[], assets: string[]): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const h = new Map(assets.map((a) => [a, loadHistory(historyDir, a, ['1h', '1d'])]));
  const upTo = (cs: Candle[] | undefined, t: number, period: number) => { if (!cs?.length) return []; let lo = 0, hi = cs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (cs[m].ts + period <= t) lo = m + 1; else hi = m; } return cs.slice(Math.max(0, lo - 400), lo); };
  for (const d of days) {
    const t = Date.parse(`${d}T00:00:00Z`);
    const h1 = new Map(assets.map((a) => [a, upTo(h.get(a)?.['1h'], t, 3_600_000)]));
    const row = new Map<string, string>();
    for (const a of assets) {
      const mine = h1.get(a)!;
      if (mine.length < 130) continue;
      const d1 = upTo(h.get(a)?.['1d'], t, D).slice(-200);
      if (d1.length < 30) continue;
      try { row.set(a, regimeOf(mine, d1, assets.filter((o) => o !== a).map((o) => h1.get(o)!).filter((x) => x.length >= 72)).key); } catch { /* skipped */ }
    }
    out.set(d, row);
  }
  return out;
}

/** Coin-day samples from a whole-bot result's byAsset and the day regimes. */
export function coinDays(byAsset: Record<string, Record<string, { kalshi: number; perps: number }>>, regimes: Map<string, Map<string, string>>): CoinDay[] {
  const out: CoinDay[] = [];
  for (const [day, row] of regimes) for (const [asset, regime] of row) {
    const r = byAsset[day]?.[asset];
    out.push({ day, asset, regime, kalshi: r?.kalshi ?? 0, perps: r?.perps ?? 0 });
  }
  return out;
}

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Bootstrap 90% interval of the mean. */
export function meanInterval(x: number[], n = 1000, seed = 7): { mean: number; lo: number; hi: number } {
  const mean = x.reduce((a, v) => a + v, 0) / Math.max(1, x.length);
  if (x.length < 2) return { mean, lo: -Infinity, hi: Infinity };
  const r = rng(seed), ms: number[] = [];
  for (let b = 0; b < n; b++) { let s = 0; for (let i = 0; i < x.length; i++) s += x[Math.floor(r() * x.length)]; ms.push(s / x.length); }
  ms.sort((a, b) => a - b);
  return { mean, lo: ms[Math.floor(0.05 * n)], hi: ms[Math.floor(0.95 * n)] };
}

/** Weights per regime (exact keys and character-level keys) from coin-day samples. */
export function learnWeights(samples: CoinDay[]): Record<string, PlaybookEntry> {
  const overall = Object.fromEntries(FAMILIES.map((f) => [f, samples.reduce((a, s) => a + s[f], 0) / Math.max(1, samples.length)])) as Record<Family, number>;
  const groups = new Map<string, CoinDay[]>();
  for (const s of samples) for (const k of new Set([s.regime, s.regime.split(':')[0]])) { const g = groups.get(k) ?? []; g.push(s); groups.set(k, g); }
  const out: Record<string, PlaybookEntry> = {};
  for (const [k, g] of [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (g.length < MIN_SAMPLES) continue;
    const e: PlaybookEntry = { kalshi: 1, perps: 1, days: g.length };
    const why: string[] = [];
    for (const f of FAMILIES) {
      const x = g.map((s) => s[f]);
      if (x.every((v) => v === 0)) continue;
      const ci = meanInterval(x);
      const top = WEIGHT_RANGE[f][1];
      const w = ci.hi < 0 ? 0 : ci.mean < 0 ? 0.5 : ci.lo > 0 && ci.mean > overall[f] ? top : 1;
      e[f] = w;
      why.push(`${f} $${ci.mean.toFixed(2)}/coin-day [${ci.lo.toFixed(2)}, ${ci.hi.toFixed(2)}] -> x${w}`);
    }
    e.why = why.join('; ');
    out[k] = e;
  }
  return out;
}

const lookup = (entries: Record<string, PlaybookEntry>, key: string) => entries[key] ?? entries[key.split(':')[0]];

/** Daily totals of the static bot and of the bot switched by `entries`. */
export function applyWeights(samples: CoinDay[], entries: Record<string, PlaybookEntry>): { days: string[]; static: number[]; switched: number[] } {
  const byDay = new Map<string, { s: number; w: number }>();
  for (const x of samples) {
    const e = lookup(entries, x.regime);
    const r = byDay.get(x.day) ?? { s: 0, w: 0 };
    r.s += x.kalshi + x.perps;
    r.w += x.kalshi * (e?.kalshi ?? 1) + x.perps * (e?.perps ?? 1);
    byDay.set(x.day, r);
  }
  const days = [...byDay.keys()].sort();
  return { days, static: days.map((d) => byDay.get(d)!.s), switched: days.map((d) => byDay.get(d)!.w) };
}

const maxDd = (pnl: number[]) => { let run = 0, peak = 0, dd = 0; for (const p of pnl) { run += p; peak = Math.max(peak, run); dd = Math.max(dd, peak - run); } return dd; };

/** The playbook: weights learned on every day, switched on only if weights learned on the earlier 70% beat the
 *  static bot on the later 30%. */
export function buildPlaybook(samples: CoinDay[], o: { version: string; at: string; trainFrac?: number; minValidationDays?: number }): PlaybookFile {
  const days = [...new Set(samples.map((s) => s.day))].sort();
  if (!days.length) return { schema: 'playbook1', version: o.version, at: o.at, enabled: false, entries: {}, validation: { days: 0, staticUsd: 0, switchedUsd: 0, staticMaxDdUsd: 0, switchedMaxDdUsd: 0, why: 'no replay days with regimes' } };
  const cut = days[Math.floor(days.length * (o.trainFrac ?? 0.7))];
  const train = samples.filter((s) => s.day < cut), test = samples.filter((s) => s.day >= cut);
  const early = learnWeights(train);
  const v = applyWeights(test, early);
  const sum = (x: number[]) => x.reduce((a, b) => a + b, 0);
  const staticUsd = sum(v.static), switchedUsd = sum(v.switched), sDd = maxDd(v.static), wDd = maxDd(v.switched);
  const minDays = o.minValidationDays ?? 10;
  const why = v.days.length < minDays ? `${v.days.length} validation day(s), need ${minDays}`
    : !(switchedUsd > staticUsd) ? `switching made $${switchedUsd.toFixed(2)} on the later ${v.days.length} days, the static bot $${staticUsd.toFixed(2)}`
    : wDd > sDd * 1.1 + 1e-9 ? `switching deepened the drawdown to $${wDd.toFixed(2)} (static $${sDd.toFixed(2)})`
    : `switching made $${switchedUsd.toFixed(2)} vs $${staticUsd.toFixed(2)} static on the later ${v.days.length} days (drawdown $${wDd.toFixed(2)} vs $${sDd.toFixed(2)})`;
  const enabled = v.days.length >= minDays && switchedUsd > staticUsd && wDd <= sDd * 1.1 + 1e-9;
  return {
    schema: 'playbook1', version: o.version, at: o.at, enabled, entries: learnWeights(samples),
    validation: { days: v.days.length, staticUsd: +staticUsd.toFixed(2), switchedUsd: +switchedUsd.toFixed(2), staticMaxDdUsd: +sDd.toFixed(2), switchedMaxDdUsd: +wDd.toFixed(2), why },
  };
}
