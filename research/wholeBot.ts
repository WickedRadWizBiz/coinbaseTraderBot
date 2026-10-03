// Whole-bot replay: the bot's recorded days with every money-making component in the loop, trading
// from ONE pot of capital under one daily loss stop.
//
//   npm run research:whole-bot -- --recordings data/recordings --history data/history \
//       --setup-oos data/models/setup_oos.json --model data/models/model.json [--perps-share 0.5]
//
// Kalshi contracts: the production backtester (research/backtest.ts) over the recordings, so features,
// the MLP, fair value, the strategy's entry / exit rules, Kelly / target-EV sizing, tiers, the vault
// and the risk limits all run as live (the SNN blend enters through the MLP's logged inputs).
// Perps: the fast / slow setup lanes (research/trainSetupModel.ts backtestLanes: queues, re-checks,
// one position per coin, risk per trade, leverage caps, fees and funding) over the same days, on the
// setups' walk-forward scores (each scored by a model that never saw it; the setup trainer exports
// them) and the 15-minute candles of the history store.
// Shared: the capital split between the two (perpsShare of the total), and a combined daily loss
// stop: once the day's realised P&L of both together reaches -dailyLossFrac of the day's capital, no
// new trade opens that day (trades are dropped by their entry time; Kalshi windows by their open).
//
// The result is a P&L per day for each part and in total. The sweep optimizer's "bot" target tunes
// the shared settings on it (research/sweep.ts).

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Config, StrategyConfig } from '../bot/config';
import type { MetaModel } from '../bot/model/metaModel';
import { DEFAULT_LANES, type LaneBookParams } from '../bot/setups/lanes';
import type { SetupOosFile } from './trainSetupModel';
import { linkDays, recordingFiles, type RecordingDay } from '../bot/marketdata/recordingFiles';

const DAY = 86_400_000;
const M15 = 900_000;

export interface WholeBotSettings {
  /** Total capital (Kalshi bankroll + perps margin). */
  totalUsd: number;
  /** Share of the total in the perps margin account. */
  perpsShare: number;
  /** Combined daily loss stop (fraction of the day's starting capital). */
  dailyLossFrac: number;
  strategy: StrategyConfig;
  book: LaneBookParams;
}

export interface DayPnl { day: string; kalshi: number; perps: number; total: number; stopped: boolean; kalshiTrades: number; perpsTrades: number }
export interface WholeBotResult { days: DayPnl[]; kalshiUsd: number; perpsUsd: number; totalUsd: number; dropped: number }

/** Everything that stays the same across runs with different settings (loaded once). */
export interface WholeBotData {
  cfg: Config;
  model: MetaModel;
  /** Recorded day files per window name, linked into temp folders for the backtester. */
  dirs: Record<string, string>;
  days: Record<string, RecordingDay[]>;
  setups?: { file: SetupOosFile; assets: Map<string, unknown> };
}

/** Recorded days in a folder, sorted (plain or gzipped day files). */
export const recordedDays = (dir: string): RecordingDay[] => recordingFiles(dir);
const dayOf = (f: RecordingDay) => f.day;

export async function loadWholeBot(o: { recordings: string; history: string; setupOos?: string; modelPath?: string; split?: Record<string, [number, number]>; log?: (m: string) => void }): Promise<WholeBotData> {
  const log = o.log ?? ((m: string) => console.log(`[whole-bot] ${m}`));
  const { loadConfig } = await import('../bot/config');
  const { MetaModel } = await import('../bot/model/metaModel');
  const cfg = loadConfig({ ...process.env, DASHBOARD_TOKEN: process.env.DASHBOARD_TOKEN ?? 'x'.repeat(32), TRADING_MODE: 'paper' });
  const model = o.modelPath && fs.existsSync(o.modelPath) ? MetaModel.load(o.modelPath) : MetaModel.identity();
  const all = recordedDays(o.recordings);
  const split = o.split ?? { all: [0, 1] };
  const dirs: Record<string, string> = {}, days: Record<string, RecordingDay[]> = {};
  for (const [w, [a, b]] of Object.entries(split)) {
    days[w] = all.slice(Math.floor(all.length * a), Math.floor(all.length * b));
    dirs[w] = fs.mkdtempSync(path.join(os.tmpdir(), `wholebot-${w}-`));
    linkDays(days[w], dirs[w]);
  }
  let setups: WholeBotData['setups'];
  if (o.setupOos && fs.existsSync(o.setupOos)) {
    const file = JSON.parse(fs.readFileSync(o.setupOos, 'utf8')) as SetupOosFile;
    const { loadAssetBars } = await import('./trainSetupModel');
    const assets = new Map<string, unknown>();
    for (const a of [...new Set(file.events.map((e) => e.asset))]) { const A = loadAssetBars(o.history, a); if (A) assets.set(a, A); }
    setups = { file, assets };
    log(`perps: ${file.events.length} out-of-sample setups ${file.from}..${file.to} over ${assets.size} coin(s)`);
  } else log('perps: no setup export (the setup trainer writes it: --oos-out / the pipeline\'s setup_oos.json): the replay covers Kalshi only');
  log(`kalshi: ${all.length} recorded day(s) ${all.length ? `${dayOf(all[0])}..${dayOf(all[all.length - 1])}` : ''}`);
  return { cfg, model, dirs, days, setups };
}

export async function runWholeBot(D: WholeBotData, window: string, s: WholeBotSettings, cache?: Map<string, unknown>): Promise<WholeBotResult> {
  const files = D.days[window] ?? [];
  if (!files.length) return { days: [], kalshiUsd: 0, perpsUsd: 0, totalUsd: 0, dropped: 0 };
  const from = Date.parse(`${dayOf(files[0])}T00:00:00Z`), to = Date.parse(`${dayOf(files[files.length - 1])}T00:00:00Z`) + DAY;
  const kalshiUsd0 = s.totalUsd * (1 - s.perpsShare), perpsUsd0 = s.totalUsd * s.perpsShare;
  // Each part's realised P&L events: [time it lands, usd, time the trade opened, part].
  type Ev = { ts: number; usd: number; open: number; part: 'kalshi' | 'perps' };
  const evs: Ev[] = [];

  // Kalshi through the production backtester (cached per strategy settings and bankroll).
  if (kalshiUsd0 > 0) {
    const key = `k|${window}|${kalshiUsd0.toFixed(2)}|${JSON.stringify(s.strategy)}`;
    let wins = cache?.get(key) as Array<[number, number]> | undefined;
    if (!wins) {
      const { runBacktest } = await import('./backtest');
      const S = s.strategy;
      const res = await runBacktest(D.dirs[window], D.model, { ...S }, D.cfg.risk, kalshiUsd0, {
        sessionRisk: S.sessionRisk, huntSessionGuard: S.huntSessionGuard, huntTransitionBufferMin: S.huntTransitionBufferMin,
        vault: D.cfg.vault.enabled ? D.cfg.vault : undefined, sizingTiers: D.cfg.sizingTiers,
      });
      wins = [...res.windows.entries()].filter(([, w]) => w.contracts > 0).map(([ts, w]) => [ts, w.pnl]);
      cache?.set(key, wins);
    }
    for (const [ts, usd] of wins) evs.push({ ts, usd, open: ts - M15, part: 'kalshi' });
  }

  // Perps setup lanes on the walk-forward scores.
  if (perpsUsd0 > 0 && D.setups) {
    const key = `p|${window}|${perpsUsd0.toFixed(2)}|${JSON.stringify(s.book)}`;
    let trades = cache?.get(key) as Array<[number, number, number]> | undefined;
    if (!trades) {
      const { backtestLanes } = await import('./trainSetupModel');
      const { DEFAULT_COSTS } = await import('../bot/setups/exits');
      const ev = D.setups.file.events.filter((e) => e.at >= from && e.at < to).map((e) => ({ ...e, x: new Float32Array(0) }));
      const scores = Float64Array.from(ev, (e) => e.score);
      const out = backtestLanes(D.setups.assets as Parameters<typeof backtestLanes>[0], ev, scores, s.book, DEFAULT_COSTS, perpsUsd0, from, to);
      trades = out.map((t) => [t.exitTs, t.usd, t.entryTs]);
      cache?.set(key, trades);
    }
    for (const [ts, usd, open] of trades) evs.push({ ts, usd, open, part: 'perps' });
  }

  // Combined daily loss stop, in time order.
  evs.sort((a, b) => a.ts - b.ts);
  const byDay = new Map<string, DayPnl>();
  const stopAt = new Map<string, number>();
  let dropped = 0;
  for (const f of files) byDay.set(dayOf(f), { day: dayOf(f), kalshi: 0, perps: 0, total: 0, stopped: false, kalshiTrades: 0, perpsTrades: 0 });
  for (const e of evs) {
    const d = new Date(e.open).toISOString().slice(0, 10);
    const row = byDay.get(d);
    if (!row) continue;
    const stop = stopAt.get(d);
    if (stop !== undefined && e.open > stop) { dropped++; continue; }
    row[e.part] += e.usd; row.total += e.usd;
    if (e.part === 'kalshi') row.kalshiTrades++; else row.perpsTrades++;
    if (stop === undefined && s.dailyLossFrac > 0 && row.total <= -s.dailyLossFrac * s.totalUsd) { stopAt.set(d, e.ts); row.stopped = true; }
  }
  const days = [...byDay.values()];
  return { days, kalshiUsd: days.reduce((a, r) => a + r.kalshi, 0), perpsUsd: days.reduce((a, r) => a + r.perps, 0), totalUsd: days.reduce((a, r) => a + r.total, 0), dropped };
}

/** The live settings as a whole-bot setting set. */
export function settingsFromConfig(cfg: Config, setupBook?: LaneBookParams): WholeBotSettings {
  const P = cfg.perps;
  const base: LaneBookParams = setupBook ?? JSON.parse(JSON.stringify(DEFAULT_LANES));
  const book: LaneBookParams = {
    ...base,
    fast: { ...base.fast, maxPositions: P.setupFastMax, riskFrac: P.setupFastRisk, riskUsd: P.setupFastRiskUsd },
    slow: { ...base.slow, maxPositions: P.setupSlowMax, riskFrac: P.setupSlowRisk, riskUsd: P.setupSlowRiskUsd },
    maxLeverage: P.setupMaxLeverage, maxAssetLeverage: P.setupMaxAssetLeverage, minTargetUsd: P.setupMinTargetUsd, roundTripFee: (2 * P.takerFeeBps + 2) / 1e4,
  };
  const total = cfg.paperBankrollUsd + P.paperBalanceUsd;
  return { totalUsd: total, perpsShare: total > 0 ? P.paperBalanceUsd / total : 0, dailyLossFrac: P.dailyLossFrac, strategy: { ...cfg.strategy }, book };
}

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }

export async function wholeBotMain(argOf: (k: string, d: string) => string = cliArg): Promise<WholeBotResult> {
  const D = await loadWholeBot({ recordings: argOf('recordings', 'data/recordings'), history: argOf('history', 'data/history'), setupOos: argOf('setup-oos', 'data/models/setup_oos.json'), modelPath: argOf('model', 'data/models/model.json') });
  const { SetupModel } = await import('../bot/setups/setupModel');
  let book: LaneBookParams | undefined;
  try { book = SetupModel.load(argOf('setup-model', D.cfg.perps.setupModelPath))?.params.book; } catch { book = undefined; }
  const s = settingsFromConfig(D.cfg, book);
  const share = argOf('perps-share', '');
  if (share) s.perpsShare = Number(share);
  const r = await runWholeBot(D, 'all', s);
  for (const d of r.days) console.log(`${d.day}: kalshi ${d.kalshi >= 0 ? '+' : ''}$${d.kalshi.toFixed(2)} (${d.kalshiTrades}) | perps ${d.perps >= 0 ? '+' : ''}$${d.perps.toFixed(2)} (${d.perpsTrades}) | total ${d.total >= 0 ? '+' : ''}$${d.total.toFixed(2)}${d.stopped ? ' (daily stop)' : ''}`);
  console.log(`[whole-bot] ${r.days.length} day(s) on $${s.totalUsd.toFixed(0)} (perps ${(100 * s.perpsShare).toFixed(0)}%): kalshi $${r.kalshiUsd.toFixed(2)}, perps $${r.perpsUsd.toFixed(2)}, total $${r.totalUsd.toFixed(2)} ($${(r.totalUsd / Math.max(1, r.days.length)).toFixed(2)}/day); ${r.dropped} trade(s) blocked by the daily stop`);
  return r;
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) void wholeBotMain().catch((e) => { console.error(e); process.exitCode = 1; });
