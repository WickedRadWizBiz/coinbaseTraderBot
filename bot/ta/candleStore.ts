// Closed OHLCV candles of one spot USD pair on every library timeframe, plus a cached TA snapshot.
// Fed by the Coinbase candle poller live and by recorded `candles` events in replay, through the
// same FeatureHub, so training and live see identical inputs. In-progress candles are dropped on
// arrival: a candle only counts once its period has ended (no look-ahead). 4h candles are built
// from complete groups of four 1h candles aligned to 00/04/08/12/16/20 UTC.

import { computeStates, evaluate, TF_MS, type MacroInput, type TaSnapshot, type TfState } from './analyzer';
import type { Candle } from './indicators';
import type { Timeframe } from './knowledge';

/** Coinbase REST row: [time_sec, low, high, open, close, volume], plus the taker-buy volume when the
 *  live trade feed covered the whole bar (7th element). */
export type CandleRow = [number, number, number, number, number, number] | [number, number, number, number, number, number, number];

const MAX_BARS = 320;

export class CandleSet {
  readonly bars: Partial<Record<Timeframe, Candle[]>> = {};
  private version = 0;
  private states?: { version: number; tf: Partial<Record<Timeframe, TfState>> };
  private readonly snaps = new Map<string, TaSnapshot>();

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
      // A REST refresh never erases taker-buy volume the trade feed already attached.
      const row = r.tb === undefined && had?.tb !== undefined && had.v === r.v ? { ...r, tb: had.tb } : r;
      if (!had || had.c !== row.c || had.v !== row.v || had.h !== row.h || had.l !== row.l || had.tb !== row.tb) fresh.push(row);
      byTs.set(r.ts, row);
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
    const key = `${this.version}|${r1(macro?.usdtdChg)}|${r1(macro?.btcdChg)}|${macro?.ctx ?? ''}`;
    // A few macro variants are in use at once (features with the dominance inputs, the engine's rule
    // book without): keep the last four so they do not evict each other.
    let snap = this.snaps.get(key);
    if (!snap) {
      snap = evaluate(this.asset, this.states.tf, now, { ...macro, asset: this.asset });
      this.snaps.set(key, snap);
      if (this.snaps.size > 4) this.snaps.delete(this.snaps.keys().next().value!);
    }
    return snap;
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
      const tb = group.every((c) => c.tb !== undefined) ? group.reduce((s, c) => s + c.tb!, 0) : undefined;
      out.push({ ts: start, o: group[0].o, h: Math.max(...group.map((c) => c.h)), l: Math.min(...group.map((c) => c.l)), c: group[group.length - 1].c, v: group.reduce((s, c) => s + c.v, 0), ...(tb !== undefined ? { tb } : {}) });
    }
  }
  return out;
}

export const fromRow = (r: CandleRow): Candle => {
  const c: Candle = { ts: r[0] * 1000, l: r[1], h: r[2], o: r[3], c: r[4], v: r[5] };
  if (r.length > 6 && Number.isFinite(r[6])) c.tb = r[6] as number;
  return c;
};
export const toRow = (c: Candle): CandleRow => (c.tb !== undefined ? [c.ts / 1000, c.l, c.h, c.o, c.c, c.v, c.tb] : [c.ts / 1000, c.l, c.h, c.o, c.c, c.v]);

/** Taker order-flow imbalance of bars: 2 sum(tb) / sum(v) - 1 in [-1, 1]; NaN unless every bar has tb. */
export function takerImbalance(cs: Candle[]): number {
  let tb = 0, v = 0;
  for (const c of cs) { if (c.tb === undefined) return NaN; tb += c.tb; v += c.v; }
  return v > 0 ? Math.max(-1, Math.min(1, (2 * tb) / v - 1)) : NaN;
}
