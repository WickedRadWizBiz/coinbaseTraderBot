// Readiness: how the whole bot does on days nothing was tuned on, against the target the continuous trainer
// stops at, plus where every model stands. Written to models/readiness.json by the pipeline's last step.
//
//   whole bot   Kalshi contracts through the production backtester and the perps setup lanes on walk-forward
//               scores, one pot of capital, one daily loss stop (research/wholeBot.ts), over the newest 15% of
//               the replay days that hold Kalshi's real contracts: the sweep never tunes on them, the setup
//               scores there come from models that never saw them, the SNN outputs are prequential. On a pool
//               of TRAIN_TARGET_POOL_USD (default $200).
//   per day     in percent of the pool: the mean and its 95% bootstrap interval, the median, the share of
//               winning days, the worst day, the largest drawdown of the equity curve, the annualised Sharpe.
//   target      TRAIN_TARGET_DAILY_PCT (default 50: $100 a day on $200) with the interval's lower end at or
//               above it, a drawdown of at most TRAIN_TARGET_MAX_DD_PCT (default 10), over at least 30 days.
//   solid       what a sound bot shows (see SOLID): a positive mean whose interval stays above zero, a
//               drawdown within 15%, a Sharpe of 2 or more, over 30 days or more.

import fs from 'fs';
import path from 'path';
import { validatedParts } from './champion';
import { bootstrapMeanCi } from './stats';
import type { Block, HistoryLedger } from './historyLedger';

export interface ReadinessTarget { poolUsd: number; dailyPct: number; maxDdPct: number; minDays: number }
export interface DailyStats {
  days: number; from?: string; to?: string;
  meanPct: number; ciLoPct: number; ciHiPct: number; medianPct: number; winDaysPct: number; worstDayPct: number; maxDdPct: number; sharpe: number;
  totalUsd: number; perDayUsd: number;
}

/** What a sound bot shows on held-out days (realistic, after fees). */
export const SOLID = { minDays: 30, maxDdPct: 15, sharpe: 2 };

/** Daily statistics of a P&L series (USD per day) on a fixed pool. */
export function dailyStats(pnlUsd: number[], poolUsd: number, dates?: string[]): DailyStats {
  const pct = pnlUsd.map((x) => (100 * x) / poolUsd);
  const n = pct.length;
  const ci = bootstrapMeanCi(pct, 0.05, 2000, 7);
  const sorted = [...pct].sort((a, b) => a - b);
  let eq = poolUsd, peak = poolUsd, dd = 0;
  for (const x of pnlUsd) { eq += x; peak = Math.max(peak, eq); dd = Math.max(dd, peak > 0 ? (peak - eq) / peak : 0); }
  const mean = n ? pct.reduce((a, b) => a + b, 0) / n : NaN;
  const sd = n > 1 ? Math.sqrt(pct.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : NaN;
  const total = pnlUsd.reduce((a, b) => a + b, 0);
  return {
    days: n, from: dates?.[0], to: dates?.[dates.length - 1],
    meanPct: mean, ciLoPct: ci.lo, ciHiPct: ci.hi, medianPct: n ? sorted[Math.floor(n / 2)] : NaN, winDaysPct: n ? (100 * pct.filter((x) => x > 0).length) / n : NaN,
    worstDayPct: n ? sorted[0] : NaN, maxDdPct: 100 * dd, sharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : NaN, totalUsd: total, perDayUsd: n ? total / n : NaN,
  };
}

/** Has the target been met (consistently: the interval's lower end, not just the mean)? */
export function targetMet(s: DailyStats, t: ReadinessTarget): { met: boolean; why: string[] } {
  const why: string[] = [];
  if (s.days < t.minDays) why.push(`${s.days} held-out day(s), need ${t.minDays}`);
  if (!(s.ciLoPct >= t.dailyPct)) why.push(`daily return ${s.meanPct.toFixed(2)}% (95% interval from ${s.ciLoPct.toFixed(2)}%), target ${t.dailyPct}% a day ($${((t.dailyPct / 100) * t.poolUsd).toFixed(0)} on $${t.poolUsd})`);
  if (!(s.maxDdPct <= t.maxDdPct)) why.push(`max drawdown ${s.maxDdPct.toFixed(1)}%, target at most ${t.maxDdPct}%`);
  return { met: why.length === 0, why };
}

/** Does the whole bot look sound (SOLID)? */
export function solidWholeBot(s: DailyStats): { solid: boolean; why: string[] } {
  const why: string[] = [];
  if (s.days < SOLID.minDays) why.push(`${s.days} day(s) < ${SOLID.minDays}`);
  if (!(s.ciLoPct > 0)) why.push(`mean ${s.meanPct.toFixed(2)}%/day, interval reaches ${s.ciLoPct.toFixed(2)}% (not clearly above 0)`);
  if (!(s.maxDdPct <= SOLID.maxDdPct)) why.push(`drawdown ${s.maxDdPct.toFixed(1)}% > ${SOLID.maxDdPct}%`);
  if (!(s.sharpe >= SOLID.sharpe)) why.push(`Sharpe ${Number.isFinite(s.sharpe) ? s.sharpe.toFixed(2) : 'n/a'} < ${SOLID.sharpe}`);
  return { solid: why.length === 0, why };
}

export interface ComponentStatus { name: string; present: boolean; validated: boolean; version?: string; detail: string }

/** Every model's state from its file (present, version, validated parts, the key numbers). */
export function componentStatus(dir: string, files: Record<string, { kind: string; file: string }>): ComponentStatus[] {
  const read = (f: string): any => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };
  return Object.entries(files).map(([name, { kind, file }]) => {
    const p = read(file);
    if (!p) return { name, present: false, validated: false, detail: 'not trained yet' };
    const parts = validatedParts(kind, file) ?? 0;
    const v = p.validation ?? {};
    let detail: string;
    switch (kind) {
      case 'perp': detail = `IC ${num(v.ic, 3)} (lower bound ${num(v.icCiLo, 3)}), net ${num(v.pnlBpsPerTrade, 1)} bps/trade (lower bound ${num(v.pnlCiLo, 1)}), DSR ${num(v.dsrProbability, 3)}, backtest ${v.backtest ? (v.backtest.ok ? 'passed' : 'failed') : 'not run'}`; break;
      case 'ta_net': detail = `${parts} of 3 heads validated; network DSR ${num(p.network?.dsr?.probability, 3)}`; break;
      case 'setups': detail = `${parts} of 2 lanes validated`; break;
      case 'mlp': detail = `log loss ${num(v.logLossModel, 4)} vs the market's ${num(v.logLossMarketCal, 4)} (DM p ${num(v.dmPValue, 3)}) over ${v.nWindows ?? 0} windows`; break;
      case 'tennis': detail = `Brier ${num(v.brierModel, 4)} vs the market's ${num(v.brierMarket, 4)} on ${v.holdoutMatches ?? 0} held-out matches`; break;
      case 'snn': detail = `${p.notes?.split(';')[0] ?? 'trained'}, trained ${String(p.trainedAt ?? '').slice(0, 10)}`; break;
      default: detail = parts ? 'validated' : 'not validated';
    }
    return { name, present: true, validated: kind === 'snn' ? true : parts > 0, version: String(p.version ?? ''), detail };
  });
}

function num(x: unknown, d: number): string { return typeof x === 'number' && Number.isFinite(x) ? x.toFixed(d) : 'n/a'; }

export interface LedgerStatus { net: string; weeks: number; trained: number; fresh: number; holdout: number; judged: number; generations: number; lastContest?: string }

/** Each ledger network's position on its history (weeks trained, fresh weeks left, contests run). */
export function ledgerStatus(L: HistoryLedger, blocks: Record<string, Block[]>, latestDay: string): LedgerStatus[] {
  return L.names().map((net) => {
    const s = L.summary(net, blocks[net] ?? [], latestDay);
    const lastContest = L.lastOf(net, 'contest');
    return { net, weeks: s.weeks, trained: s.trained, fresh: s.fresh, holdout: s.holdout, judged: s.judged, generations: s.generations, lastContest: lastContest ? `${lastContest.done?.slice(0, 10) ?? ''} ${lastContest.note ?? ''}`.trim() : undefined };
  });
}

export interface ReadinessFile {
  at: string;
  target: ReadinessTarget;
  wholeBot?: DailyStats & { window: string; kalshiUsd: number; perpsUsd: number; solid: boolean; solidWhy: string[] };
  met: boolean;
  why: string[];
  components: ComponentStatus[];
  ledger: LedgerStatus[];
  note?: string;
}

export function writeReadiness(dir: string, r: ReadinessFile): void {
  const f = path.join(dir, 'readiness.json');
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(r, null, 1));
  fs.renameSync(`${f}.tmp`, f);
}
