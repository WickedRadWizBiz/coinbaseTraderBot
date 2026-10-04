// Session research: measure, fit, validate, recommend.
//   npm run research:sessions -- --recordings data/recordings [--out params/vol_profile.json] [--no-backtest]
//
// 1. Per-session market statistics from recordings: index volatility, Kalshi
//    spread and top-of-book depth, trade activity.
// 2. Intraday volatility profile (Andersen-Bollerslev style): fitted on the
//    first 70% of days, validated on the last 30% by re-pricing every sample
//    with and without the seasonal adjustment (Brier / log loss vs settlement).
//    `validation.improved` is true only if both improve out of sample with at
//    least MIN_HOLDOUT_DAYS days. The profile is then refitted on all data.
//    Production applies it only when improved (and VOL_SEASONALITY=true).
// 3. Fee-inclusive backtest broken down by session, and a recommended
//    SESSION_RISK JSON (reduce-only multipliers) with the evidence behind it.
//    Recommendations are printed, never applied automatically.

import fs from 'fs';
import path from 'path';
import { loadConfig } from '../bot/config';
import { brier, logLoss } from '../bot/model/calibration';
import { fairValue } from '../bot/model/fairValue';
import { MetaModel } from '../bot/model/metaModel';
import { SESSION_KEYS, sessionState, type SessionKey } from '../bot/model/sessions';
import type { SessionRiskProfile } from '../bot/model/sessionRisk';
import { effectiveSigma, fitVolProfile, type VolProfile } from '../bot/model/volSeasonality';
import { runBacktest } from './backtest';
import { buildDataset, type DatasetRow } from './buildDataset';
import { readRecordings, ReplayState } from './replay';
import { bootstrapMeanCi } from './stats';

export const MIN_HOLDOUT_DAYS = 5;

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export interface SessionStats {
  session: SessionKey;
  hours: number;
  /** Index volatility per sqrt(second), from 1-minute returns (pooled assets). */
  sigmaPerSqrtSec: number | null;
  medianSpread: number | null;
  medianTopDepth: number | null;
  tradesPerHour: number | null;
}

export interface SessionResearch {
  stats: SessionStats[];
  returns: Array<{ ts: number; asset: string; r: number }>;
}

/** One pass over the recordings: 1-minute returns and per-session liquidity samples. */
export async function measureSessions(dir: string): Promise<SessionResearch> {
  const st = new ReplayState();
  const returns: Array<{ ts: number; asset: string; r: number }> = [];
  const lastVal = new Map<string, number>();
  const curMin = new Map<string, number>();
  const prevClose = new Map<string, number>();
  const spreads = new Map<SessionKey, number[]>();
  const depths = new Map<SessionKey, number[]>();
  const minutes = new Map<SessionKey, Set<number>>();
  const trades = new Map<SessionKey, number>();
  let nextSample = 0;

  for await (const e of readRecordings(dir)) {
    st.apply(e);
    if (e.k === 'index') {
      const ts = e.ts ?? e.t;
      const mnt = Math.floor(ts / 60_000);
      const cm = curMin.get(e.asset);
      if (cm === undefined) { curMin.set(e.asset, mnt); }
      else if (mnt > cm) {
        // Minute `cm` closed at lastVal; a return needs the previous minute's close.
        const close = lastVal.get(e.asset)!;
        const pc = prevClose.get(e.asset);
        if (pc !== undefined) returns.push({ ts: cm * 60_000, asset: e.asset, r: Math.log(close / pc) });
        if (mnt === cm + 1) prevClose.set(e.asset, close);
        else prevClose.delete(e.asset); // gap: restart the return chain
        curMin.set(e.asset, mnt);
      }
      lastVal.set(e.asset, e.value);
      const k = sessionState(ts).key;
      (minutes.get(k) ?? minutes.set(k, new Set()).get(k)!).add(mnt);
    }
    if (e.k === 'trade') {
      const k = sessionState(e.ts ?? e.t).key;
      trades.set(k, (trades.get(k) ?? 0) + 1);
    }
    if (st.now >= nextSample) {
      nextSample = st.now + 10_000;
      const k = sessionState(st.now).key;
      for (const [t, b] of st.books) {
        const m = st.markets.get(t);
        if (!m || m.recordOnly || st.now < m.openTime || st.now >= m.closeTime || !b.isUsable(st.now, 5000)) continue;
        const bb = b.bestBid(), ba = b.bestAsk();
        if (!bb || !ba) continue;
        (spreads.get(k) ?? spreads.set(k, []).get(k)!).push(ba.price - bb.price);
        (depths.get(k) ?? depths.set(k, []).get(k)!).push((bb.size + ba.size) / 2);
      }
    }
  }

  const stats: SessionStats[] = SESSION_KEYS.map((k) => {
    const rs = returns.filter((x) => sessionState(x.ts).key === k);
    const hours = (minutes.get(k)?.size ?? 0) / 60;
    return {
      session: k,
      hours: +hours.toFixed(1),
      sigmaPerSqrtSec: rs.length > 30 ? Math.sqrt(rs.reduce((a, x) => a + x.r * x.r, 0) / rs.length / 60) : null,
      medianSpread: spreads.get(k)?.length ? median(spreads.get(k)!) : null,
      medianTopDepth: depths.get(k)?.length ? median(depths.get(k)!) : null,
      tradesPerHour: hours > 0 ? (trades.get(k) ?? 0) / hours : null,
    };
  });
  return { stats, returns };
}

/** Re-price dataset rows with a seasonal profile and compare accuracy. */
export function validateVolProfile(p: VolProfile, rows: DatasetRow[]): { brierWithout: number; brierWith: number; logLossWithout: number; logLossWith: number } {
  const y = rows.map((r) => r.label);
  const without = rows.map((r) => r.fv);
  const withP = rows.map((r) => {
    const s = effectiveSigma(r.sigma, p, r.asset, r.t, r.window);
    return fairValue({ spot: r.spot, strike: r.strike, sigmaPerSqrtSec: s, tauSec: r.tauSec, observedAvg: r.observedAvg })?.pYes ?? r.fv;
  });
  return { brierWithout: brier(without, y), brierWith: brier(withP, y), logLossWithout: logLoss(without, y), logLossWith: logLoss(withP, y) };
}

/** Fit on the first 70% of days, validate on the rest, refit on everything. */
export async function fitAndValidateVolProfile(dir: string, returns: SessionResearch['returns']): Promise<VolProfile> {
  const days = [...new Set(returns.map((x) => new Date(x.ts).toISOString().slice(0, 10)))].sort();
  const cutDay = days[Math.floor(days.length * 0.7)] ?? days[days.length - 1];
  const train = returns.filter((x) => new Date(x.ts).toISOString().slice(0, 10) < cutDay);
  const holdoutDays = days.filter((d) => d >= cutDay).length;
  const rows = (await buildDataset(dir, 15)).filter((r) => new Date(r.t).toISOString().slice(0, 10) >= cutDay);
  const trial = fitVolProfile(train.length ? train : returns);
  const v = rows.length ? validateVolProfile(trial, rows) : { brierWithout: NaN, brierWith: NaN, logLossWithout: NaN, logLossWith: NaN };
  const improved = holdoutDays >= MIN_HOLDOUT_DAYS && v.brierWith < v.brierWithout && v.logLossWith <= v.logLossWithout;
  const final = fitVolProfile(returns);
  final.validation = { improved, holdoutDays, ...v, evaluatedAt: new Date().toISOString() };
  return final;
}

/** Reduce-only SESSION_RISK recommendation from a per-session backtest breakdown. */
export function recommendSessionRisk(
  perSessionWindowEdges: Map<string, number[]>,
  stats: SessionStats[],
  minWindows = 30,
): { profile: SessionRiskProfile; evidence: Array<Record<string, unknown>> } {
  const profile: SessionRiskProfile = {};
  const evidence: Array<Record<string, unknown>> = [];
  const allSpreads = stats.map((s) => s.medianSpread).filter((x): x is number => x !== null);
  const typicalSpread = allSpreads.length ? median(allSpreads) : NaN;
  for (const k of SESSION_KEYS) {
    const edges = perSessionWindowEdges.get(k) ?? [];
    const st = stats.find((s) => s.session === k);
    const row: Record<string, unknown> = { session: k, windowsTraded: edges.length };
    if (edges.length < minWindows) {
      row.recommendation = `insufficient data (< ${minWindows} traded windows): leave neutral`;
      evidence.push(row);
      continue;
    }
    const ci = bootstrapMeanCi(edges);
    Object.assign(row, { edgePerContract: +ci.mean.toFixed(4), ciLo: +ci.lo.toFixed(4), ciHi: +ci.hi.toFixed(4) });
    const entry: Record<string, number> = {};
    if (ci.hi < 0) entry.sizeMult = 0;            // reliably losing: no new risk
    else if (ci.lo < 0) entry.sizeMult = 0.5;     // not distinguishable from zero: halve
    if (st?.medianSpread != null && Number.isFinite(typicalSpread) && st.medianSpread > 1.5 * typicalSpread) entry.minEdgeAdd = 0.01;
    if (Object.keys(entry).length) profile[k] = entry;
    row.recommendation = Object.keys(entry).length ? entry : 'neutral';
    evidence.push(row);
  }
  return { profile, evidence };
}

export async function sessionsMain(argOf: (k: string, d: string) => string = cliArg, annotate: boolean = process.argv.includes('--annotate')) {
  const dir = argOf('recordings', 'data/recordings');
  const out = argOf('out', 'params/vol_profile.json');
  console.log(`measuring sessions in ${dir} ...`);
  const m = await measureSessions(dir);
  console.table(m.stats.map((s) => ({
    ...s,
    sigmaPerSqrtSec: s.sigmaPerSqrtSec === null ? null : +s.sigmaPerSqrtSec.toExponential(3),
    medianSpread: s.medianSpread === null ? null : +s.medianSpread.toFixed(3),
    medianTopDepth: s.medianTopDepth === null ? null : +s.medianTopDepth.toFixed(1),
    tradesPerHour: s.tradesPerHour === null ? null : +s.tradesPerHour.toFixed(1),
  })));

  const profile = await fitAndValidateVolProfile(dir, m.returns);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(profile, null, 2) + '\n');
  console.log('volatility profile validation (holdout days, fair value re-priced):', profile.validation);
  console.log(`wrote ${out} — production applies it only because validation.improved=${profile.validation?.improved}`);

  if (!process.argv.includes('--no-backtest') && argOf('no-backtest', '') !== '1') {
    const cfg = loadConfig({ ...process.env, DASHBOARD_TOKEN: process.env.DASHBOARD_TOKEN ?? 'x'.repeat(32), TRADING_MODE: 'paper' });
    const modelPath = argOf('model', 'params/model.json');
    const model = fs.existsSync(modelPath) ? MetaModel.load(modelPath) : MetaModel.identity();
    const bt = await runBacktest(dir, model, cfg.strategy, cfg.risk, cfg.paperBankrollUsd, {
      exitPolicy: 'fair_value', volProfile: profile.validation?.improved ? profile : undefined, applyVolSeasonality: Boolean(profile.validation?.improved),
    });
    const perSession = new Map<string, number[]>();
    for (const [close, w] of bt.windows) {
      if (w.contracts <= 0) continue;
      const k = sessionState(close - 15 * 60_000).key;
      (perSession.get(k) ?? perSession.set(k, []).get(k)!).push(w.pnl / w.contracts);
    }
    const rec = recommendSessionRisk(perSession, m.stats);
    console.log('per-session evidence (fee-inclusive net edge per contract, bootstrap 95% CI over windows):');
    console.table(rec.evidence);
    console.log('recommended SESSION_RISK (review, then set in the server .env):');
    console.log(`SESSION_RISK='${JSON.stringify(rec.profile)}'`);
  }
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) void sessionsMain();

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }
