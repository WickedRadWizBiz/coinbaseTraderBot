// Intraday volatility periodicity (Andersen & Bollerslev, 1997), for crypto
// documented by Eross et al. (2019), Wang, Liu & Hsu (2020) and Hansen, Kim &
// Kimbrough (JFEC 2024): variance is systematically higher in European/US
// hours and at the US equity open, lower after the US close and at weekends.
//
// The EWMA volatility in IndexTracker looks backwards, so at a scheduled
// high-volatility time (e.g. 09:30 ET) it understates the variance the next
// 15 minutes will bring, and in quiet hours it overstates it. With a seasonal
// variance factor f(t) (mean 1), the variance over the contract's remaining
// life is
//     sigma_ewma^2 * mean f over [now, close] / mean f over the EWMA lookback
// so fair value uses sigma_eff = sigma_ewma * sqrt(ratio), clamped.
//
// The profile is ESTIMATED from recorded data by research:sessions (30-minute
// buckets of New York local time, weekday vs weekend, shrunk toward 1 when a
// bucket has little data) and validated out of sample; production applies it
// only when its validation shows fair-value accuracy improved.

import fs from 'fs';
import { zoneTime } from './sessions';

export const BUCKET_MINUTES = 30;
export const BUCKETS_PER_DAY = (24 * 60) / BUCKET_MINUTES;

export interface VolProfileValidation {
  improved: boolean;
  holdoutDays: number;
  brierWithout: number;
  brierWith: number;
  logLossWithout: number;
  logLossWith: number;
  evaluatedAt: string;
}

export interface VolProfile {
  version: string;
  tz: 'America/New_York';
  bucketMinutes: number;
  /** Per asset (plus '*' pooled): variance factors, mean ~1. */
  assets: Record<string, { weekday: number[]; weekend: number[]; days: number }>;
  fittedAt: string;
  validation?: VolProfileValidation;
}

export function bucketIndex(ts: number): { weekend: boolean; bucket: number } {
  const utcDay = new Date(ts).getUTCDay();
  const ny = zoneTime(ts, 'America/New_York');
  return { weekend: utcDay === 0 || utcDay === 6, bucket: Math.min(BUCKETS_PER_DAY - 1, Math.floor(ny.minutes / BUCKET_MINUTES)) };
}

export function factorAt(p: VolProfile, asset: string, ts: number): number {
  const a = p.assets[asset] ?? p.assets['*'];
  if (!a) return 1;
  const b = bucketIndex(ts);
  const f = (b.weekend ? a.weekend : a.weekday)[b.bucket];
  return Number.isFinite(f) && f > 0 ? f : 1;
}

function meanFactor(p: VolProfile, asset: string, from: number, to: number): number {
  if (to <= from) return factorAt(p, asset, from);
  let s = 0, n = 0;
  for (let t = from; t < to; t += 60_000) { s += factorAt(p, asset, t); n++; }
  return n ? s / n : 1;
}

export const RATIO_MIN = 0.5;
export const RATIO_MAX = 2.0;

/** Variance ratio (future window vs EWMA lookback), clamped to [0.5, 2]. */
export function seasonalVarianceRatio(p: VolProfile, asset: string, now: number, closeTs: number, lookbackSec: number): number {
  const fut = meanFactor(p, asset, now, Math.max(now + 60_000, closeTs));
  const past = meanFactor(p, asset, now - lookbackSec * 1000, now);
  const r = past > 0 ? fut / past : 1;
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, r));
}

/** EWMA half-life 300 s: mean age ~ halfLife/ln2; use twice that as the lookback. */
export const EWMA_LOOKBACK_SEC = Math.round((2 * 300) / Math.LN2);

export function loadVolProfile(file: string): VolProfile | undefined {
  if (!fs.existsSync(file)) return undefined;
  const p = JSON.parse(fs.readFileSync(file, 'utf8')) as VolProfile;
  if (p.bucketMinutes !== BUCKET_MINUTES || p.tz !== 'America/New_York' || !p.assets) throw new Error(`invalid vol profile ${file}`);
  for (const [k, a] of Object.entries(p.assets)) {
    if (a.weekday.length !== BUCKETS_PER_DAY || a.weekend.length !== BUCKETS_PER_DAY) throw new Error(`vol profile ${k}: wrong bucket count`);
    if ([...a.weekday, ...a.weekend].some((f) => !(f > 0) || !Number.isFinite(f))) throw new Error(`vol profile ${k}: non-positive factor`);
  }
  return p;
}

/**
 * Fit from 1-minute log returns: mean squared return per bucket / overall mean,
 * shrunk toward 1 with prior weight `k` observations (partial pooling).
 */
export function fitVolProfile(returns: Array<{ ts: number; asset: string; r: number }>, k = 60): VolProfile {
  const byAsset = new Map<string, Array<{ ts: number; r: number }>>();
  for (const x of returns) {
    for (const key of [x.asset, '*']) {
      const arr = byAsset.get(key) ?? [];
      arr.push({ ts: x.ts, r: x.r });
      byAsset.set(key, arr);
    }
  }
  const assets: VolProfile['assets'] = {};
  for (const [asset, rs] of byAsset) {
    const overall = rs.reduce((s, x) => s + x.r * x.r, 0) / Math.max(1, rs.length);
    const sum = { weekday: new Array(BUCKETS_PER_DAY).fill(0), weekend: new Array(BUCKETS_PER_DAY).fill(0) };
    const cnt = { weekday: new Array(BUCKETS_PER_DAY).fill(0), weekend: new Array(BUCKETS_PER_DAY).fill(0) };
    const days = new Set<string>();
    for (const x of rs) {
      const b = bucketIndex(x.ts);
      const side = b.weekend ? 'weekend' : 'weekday';
      sum[side][b.bucket] += x.r * x.r;
      cnt[side][b.bucket] += 1;
      days.add(new Date(x.ts).toISOString().slice(0, 10));
    }
    const shrink = (side: 'weekday' | 'weekend') => sum[side].map((s, i) => {
      const n = cnt[side][i];
      const raw = n && overall > 0 ? s / n / overall : 1;
      return (n * raw + k) / (n + k);
    });
    const wd = shrink('weekday'), we = shrink('weekend');
    // Renormalise so the time-weighted mean factor is 1.
    const m = (wd.reduce((a, b) => a + b, 0) * 5 + we.reduce((a, b) => a + b, 0) * 2) / (7 * BUCKETS_PER_DAY);
    assets[asset] = { weekday: wd.map((f) => f / m), weekend: we.map((f) => f / m), days: days.size };
  }
  return { version: `volprofile-${new Date().toISOString().slice(0, 10)}`, tz: 'America/New_York', bucketMinutes: BUCKET_MINUTES, assets, fittedAt: new Date().toISOString() };
}

/** Seasonally adjusted volatility for pricing; returns sigma unchanged without a profile. */
export function effectiveSigma(sigma: number, p: VolProfile | undefined, asset: string, now: number, closeTs: number): number {
  return p ? sigma * Math.sqrt(seasonalVarianceRatio(p, asset, now, closeTs, EWMA_LOOKBACK_SEC)) : sigma;
}
