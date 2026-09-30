// Closed OHLCV candles of one spot USD pair on every library timeframe, plus a cached TA snapshot.
// Fed by the Coinbase candle poller live and by recorded `candles` events in replay, through the
// same FeatureHub, so training and live see identical inputs. In-progress candles are dropped on
// arrival: a candle only counts once its period has ended (no look-ahead). 4h candles are built
// from complete groups of four 1h candles aligned to 00/04/08/12/16/20 UTC.

import { computeStates, evaluate, TF_MS, type MacroInput, type TaSnapshot, type TfState } from './analyzer';
import type { Candle } from './indicators';
import type { Timeframe } from './knowledge';

/** Coinbase REST row: [time_sec, low, high, open, close, volume]. */
export type CandleRow = [number, number, number, number, number, number];

const MAX_BARS = 320;

export class CandleSet {
  readonly bars: Partial<Record<Timeframe, Candle[]>> = {};
  private version = 0;
  private states?: { version: number; tf: Partial<Record<Timeframe, TfState>> };
  private snap?: { key: string; snap: TaSnapshot };

  constructor(readonly asset: string) {}

  /** Merge candles for one timeframe (any order); returns the candles that were new. */
  add(tf: Timeframe, rows: Candle[], receivedTs: number): Candle[] {
    if (tf === '4h') return [];
    const cur = this.bars[tf] ?? [];
    const byTs = new Map(cur.map((c) => [c.ts, c]));
    const fresh: Candle[] = [];
    for (const r of rows) {
      if (!(r.ts + TF_MS[tf] <= receivedTs)) continue; // still forming
      if (!(r.h >= r.l) || !(r.c > 0)) continue;
      const had = byTs.get(r.ts);
      if (!had || had.c !== r.c || had.v !== r.v || had.h !== r.h || had.l !== r.l) fresh.push(r);
      byTs.set(r.ts, r);
    }
    if (!fresh.length) return [];
    const merged = [...byTs.values()].sort((a, b) => a.ts - b.ts).slice(-MAX_BARS);
    this.bars[tf] = merged;
    if (tf === '1h') this.bars['4h'] = aggregate(merged, TF_MS['4h']);
    this.version++;
    return fresh;
  }

  /** Latest closed candle time per timeframe. */
  lastTs(tf: Timeframe): number | undefined {
    const b = this.bars[tf];
    return b?.length ? b[b.length - 1].ts : undefined;
  }

  /** TA snapshot (indicators cached per candle update; rules re-evaluated when the macro input moves). */
  snapshot(now: number, macro?: MacroInput): TaSnapshot {
    if (!this.states || this.states.version !== this.version) this.states = { version: this.version, tf: computeStates(this.bars) };
    const r1 = (x?: number) => (x === undefined || !Number.isFinite(x) ? 'na' : x.toFixed(1));
    const key = `${this.version}|${r1(macro?.usdtdChg)}|${r1(macro?.btcdChg)}`;
    if (this.snap?.key !== key) this.snap = { key, snap: evaluate(this.asset, this.states.tf, now, { ...macro, asset: this.asset }) };
    return this.snap.snap;
  }
}

/** Complete, aligned groups of `ms` built from smaller candles. */
export function aggregate(cs: Candle[], ms: number): Candle[] {
  const out: Candle[] = [];
  const step = cs.length > 1 ? cs[1].ts - cs[0].ts : 0;
  if (!(step > 0)) return out;
  const per = Math.round(ms / step);
  let i = 0;
  while (i < cs.length) {
    const start = Math.floor(cs[i].ts / ms) * ms;
    const group: Candle[] = [];
    while (i < cs.length && cs[i].ts < start + ms) group.push(cs[i++]);
    if (group.length === per && group[0].ts === start) {
      out.push({ ts: start, o: group[0].o, h: Math.max(...group.map((c) => c.h)), l: Math.min(...group.map((c) => c.l)), c: group[group.length - 1].c, v: group.reduce((s, c) => s + c.v, 0) });
    }
  }
  return out;
}

export const fromRow = (r: CandleRow): Candle => ({ ts: r[0] * 1000, l: r[1], h: r[2], o: r[3], c: r[4], v: r[5] });
export const toRow = (c: Candle): CandleRow => [c.ts / 1000, c.l, c.h, c.o, c.c, c.v];
