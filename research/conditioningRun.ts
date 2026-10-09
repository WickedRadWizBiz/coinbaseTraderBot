// Conditioning mode, the run (research/conditioning.ts is the tournament): which days are unseen, the market
// character of each, the windows of a trial, the instances, and their evaluation in worker threads.
//
//   unseen days   history-replay days whose ISO week no network has trained on (models/work/history-ledger.json),
//                 outside the decision model's fitting span; days earlier conditioning runs played least first,
//                 and never a day twice within a run (each retrial gets new days)
//   character     each day as it turned out: the next 24 hours of BTC against its last 180 daily ranges and the
//                 other coins (bot/ta/character.ts realisedCharacter); Tiers C / B / A / S play days of their kind
//   windows       Tiers 1-3: consecutive days where possible; Tiers C-S: days of the tier's character (when too
//                 few are left, other days fill in and the report says so)
//   instances     the whole bot's trading settings, varied: Kalshi minimum edge, maker / taker buffers, the fill
//                 model's floor, an aggression scale on the sizing tiers (Kelly fraction and risk per order and
//                 window), and the perps setups' risk per trade (a fraction of equity), positions, minimum target
//                 and daily loss stop. The trained models are the ones the normal run produced; conditioning
//                 decides how the bot trades with them. Trial 0: the live settings and random variants;
//                 retrials: the best quarter of the earlier trials varied, the rest new random ones.
//   output        models/conditioning_report.json (every trial, the saved Tier 3+ instances, the best);
//                 an Elite Champion goes to models/conditioning_champion.json (the previous one kept as
//                 conditioning_champion.prev.json), which the live bot applies (bot/strategy/conditioningOverlay.ts).

import fs from 'fs';
import path from 'path';
import type { Character } from '../bot/ta/character';
import { realisedCharacter } from '../bot/ta/character';
import type { Candle } from '../bot/ta/indicators';
import { recordingFiles, type RecordingDay } from '../bot/marketdata/recordingFiles';
import { DEFAULT_RULES, runConditioning, TIERS, WINDOW_DAYS, type ConditioningResult, type ConditioningRules, type InstanceRecord, type Stage, type WindowResult } from './conditioning';
import { isoWeek, type HistoryLedger } from './historyLedger';
import { loadHistory } from './history/candles';
import type { WholeBotData, WholeBotSettings } from './wholeBot';
import { WorkerPool, workerScript } from './workerPool';
import { progress } from './progress';

const DAY = 86_400_000;

// ---- Instances -------------------------------------------------------------------------------------------

export interface CondParam { name: string; values: number[]; get(s: WholeBotSettings): number; set(s: WholeBotSettings, v: number): void }
export const COND_PARAMS: CondParam[] = [
  { name: 'STRATEGY_MIN_EDGE', values: [0.01, 0.015, 0.02, 0.03, 0.04, 0.05, 0.06], get: (s) => s.strategy.minEdge, set: (s, v) => { s.strategy.minEdge = v; } },
  { name: 'STRATEGY_TAKER_BUFFER', values: [0, 0.005, 0.01, 0.02, 0.03], get: (s) => s.strategy.takerBuffer, set: (s, v) => { s.strategy.takerBuffer = v; } },
  { name: 'STRATEGY_MAKER_BUFFER', values: [0, 0.005, 0.01, 0.02], get: (s) => s.strategy.makerBuffer, set: (s, v) => { s.strategy.makerBuffer = v; } },
  { name: 'FILL_MIN_EV', values: [0, 0.002, 0.005, 0.01], get: (s) => s.strategy.fillMinEv, set: (s, v) => { s.strategy.fillMinEv = v; } },
  { name: 'tierScale', values: [0.5, 0.75, 1, 1.25, 1.5, 2, 3], get: (s) => s.tierScale ?? 1, set: (s, v) => { s.tierScale = v; } },
  { name: 'SETUP_FAST_RISK', values: [0.0025, 0.004, 0.006, 0.01, 0.02, 0.03], get: (s) => s.book.fast.riskFrac, set: (s, v) => { s.book.fast.riskFrac = v; s.book.fast.riskUsd = 0; } },
  { name: 'SETUP_SLOW_RISK', values: [0.002, 0.004, 0.006, 0.01, 0.02], get: (s) => s.book.slow.riskFrac, set: (s, v) => { s.book.slow.riskFrac = v; s.book.slow.riskUsd = 0; } },
  { name: 'SETUP_FAST_MAX_POSITIONS', values: [1, 2, 3, 5], get: (s) => s.book.fast.maxPositions, set: (s, v) => { s.book.fast.maxPositions = v; } },
  { name: 'SETUP_SLOW_MAX_POSITIONS', values: [0, 1, 2, 3], get: (s) => s.book.slow.maxPositions, set: (s, v) => { s.book.slow.maxPositions = v; } },
  { name: 'SETUP_MIN_TARGET_USD', values: [0, 1, 2, 3, 5], get: (s) => s.book.minTargetUsd ?? 0, set: (s, v) => { s.book.minTargetUsd = v; } },
  { name: 'PERPS_DAILY_LOSS_FRAC', values: [0.03, 0.05, 0.1, 0.2, 0.35], get: (s) => s.dailyLossFrac, set: (s, v) => { s.dailyLossFrac = v; } },
];

/** A seeded random number generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = <T>(xs: T[], r: () => number): T => xs[Math.floor(r() * xs.length)];

/** Every parameter drawn at random. */
export function randomSettings(base: WholeBotSettings, r: () => number): WholeBotSettings {
  const s = structuredClone(base);
  for (const p of COND_PARAMS) p.set(s, pick(p.values, r));
  return s;
}

/** 1 to 3 parameters moved one step up or down their grid. */
export function mutateSettings(base: WholeBotSettings, r: () => number): WholeBotSettings {
  const s = structuredClone(base);
  const n = 1 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const p = pick(COND_PARAMS, r);
    const cur = p.get(s);
    let k = p.values.findIndex((v) => v >= cur - 1e-12);
    if (k < 0) k = p.values.length - 1;
    k = Math.max(0, Math.min(p.values.length - 1, k + (r() < 0.5 ? -1 : 1)));
    p.set(s, p.values[k]);
  }
  return s;
}

/** The parameters of a setting set, by name (for the report and the live overlay). */
export const paramsOf = (s: WholeBotSettings): Record<string, number> => Object.fromEntries(COND_PARAMS.map((p) => [p.name, +p.get(s).toFixed(6)]));

export function instancesFor(trial: number, n: number, live: WholeBotSettings, prev: Array<InstanceRecord<WholeBotSettings>>, seed: number): Array<{ id: string; settings: WholeBotSettings; origin: string }> {
  const r = rng(seed + trial * 7919);
  const out: Array<{ id: string; settings: WholeBotSettings; origin: string }> = [];
  if (trial === 0) out.push({ id: 't0-live', settings: structuredClone(live), origin: 'the live settings' });
  const keep = trial ? prev.slice(0, Math.max(1, Math.round(n / 4))) : [];
  for (const p of keep) if (out.length < n) out.push({ id: `t${trial}-${out.length}`, settings: mutateSettings(p.settings, r), origin: `varied from ${p.id}` });
  while (out.length < n) out.push({ id: `t${trial}-${out.length}`, settings: randomSettings(live, r), origin: 'random' });
  return out;
}

// ---- Days ------------------------------------------------------------------------------------------------

/** Each day's character as it turned out (BTC's next 24 hours against its daily ranges and the other coins). */
export function dayCharacters(historyDir: string, days: string[], assets = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE']): Map<string, Character> {
  const out = new Map<string, Character>();
  const h = assets.map((a) => loadHistory(historyDir, a, ['1h', '1d']));
  const btc = h[0];
  if (!btc['1h']?.length || !btc['1d']?.length) return out;
  const idx = (cs: Candle[], t: number) => { let lo = 0, hi = cs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (cs[m].ts < t) lo = m + 1; else hi = m; } return lo; };
  for (const d of days) {
    const t = Date.parse(`${d}T00:00:00Z`);
    const i = idx(btc['1h'], t);
    const fwd = btc['1h'].slice(i, i + 25);
    if (fwd.length < 25) continue;
    const d1 = btc['1d'].slice(Math.max(0, idx(btc['1d'], t) - 180), idx(btc['1d'], t));
    if (d1.length < 30) continue;
    const others = h.slice(1).map((x) => { const c = x['1h'] ?? []; const j = idx(c, t); return c.slice(j, j + 25); }).filter((c) => c.length >= 25);
    out.set(d, realisedCharacter(fwd, d1, others));
  }
  return out;
}

/** Replay days no network trained on (by ISO week, from the history ledger), outside the decision model's fitting span. */
export function unseenDays(days: string[], ledger: Pick<HistoryLedger, 'names' | 'use'> | undefined, fitted: (d: string) => boolean): string[] {
  const nets = ledger ? ledger.names().filter((n) => n !== 'conditioning') : [];
  return days.filter((d) => !fitted(d) && nets.every((n) => ledger!.use(n, isoWeek(d)).trained === 0));
}

/** The 21 windows of a trial from days not used yet in this run; undefined when Tiers 1-3 cannot be filled. */
export function allocateStages(o: { pool: string[]; used: Set<string>; characters: Map<string, Character>; judged: (d: string) => number; seed: number; notes?: string[] }): Stage[] | undefined {
  const r = rng(o.seed);
  const order = new Map(o.pool.map((d) => [d, r()]));
  // Least played by earlier conditioning runs first, then a seeded shuffle.
  const free = () => o.pool.filter((d) => !o.used.has(d)).sort((a, b) => o.judged(a) - o.judged(b) || order.get(a)! - order.get(b)!);
  const consecutive = (n: number): string[] | undefined => {
    const set = new Set(o.pool.filter((d) => !o.used.has(d)));
    for (const d of free()) {
      const run = Array.from({ length: n }, (_, k) => new Date(Date.parse(`${d}T00:00:00Z`) + k * DAY).toISOString().slice(0, 10));
      if (run.every((x) => set.has(x))) return run;
    }
    return undefined;
  };
  const stages: Stage[] = [];
  let index = 0;
  for (const [ti, t] of TIERS.entries()) {
    for (const [wi, n] of WINDOW_DAYS.entries()) {
      let days: string[] | undefined;
      if (!t.regime) days = consecutive(n) ?? (free().length >= n ? free().slice(0, n) : undefined);
      else {
        const kind = free().filter((d) => o.characters.get(d) === t.regime);
        days = kind.slice(0, n);
        if (days.length < n) {
          const fill = free().filter((d) => !days!.includes(d)).slice(0, n - days.length);
          o.notes?.push(`Tier ${t.name} ${n}-day: ${days.length} ${t.regime} day(s) left, ${fill.length} other day(s) filled in`);
          days = [...days, ...fill];
        }
        if (days.length < n) days = undefined;
      }
      // Out of unseen days: no trial without Tiers 1-3; past them, the trial runs short (it can rank, not crown).
      if (!days) { if (ti <= 2) return undefined; o.notes?.push(`no unseen days left from Tier ${t.name} on: this trial cannot crown an Elite`); return stages; }
      for (const d of days) o.used.add(d);
      stages.push({ index: index++, tier: ti, win: wi, cash: t.cash, days: days.slice().sort() });
    }
  }
  return stages;
}

// ---- Evaluation ------------------------------------------------------------------------------------------

export interface CondTask { replayDir: string; historyDir: string; setupOos?: string; modelPath?: string; window: string; days: string[]; settings: WholeBotSettings }

let loaded: { key: string; D: WholeBotData; cache: Map<string, unknown>; windows: Set<string> } | undefined;

/** One instance over one window (in a worker thread, or in this process with one worker). */
export async function evaluateTask(t: CondTask): Promise<WindowResult> {
  const { loadWholeBot, addWindow, runWholeBot } = await import('./wholeBot');
  const key = `${t.replayDir}|${t.historyDir}|${t.setupOos}|${t.modelPath}`;
  if (loaded?.key !== key) {
    const D = await loadWholeBot({ recordings: t.replayDir, history: t.historyDir, setupOos: t.setupOos, modelPath: t.modelPath, split: {}, log: () => undefined });
    loaded = { key, D, cache: new Map(), windows: new Set() };
  }
  if (!loaded.windows.has(t.window)) {
    const files = recordingFiles(t.replayDir).filter((f) => t.days.includes(f.day));
    addWindow(loaded.D, t.window, files);
    loaded.windows.add(t.window);
  }
  const r = await runWholeBot(loaded.D, t.window, t.settings, loaded.cache);
  return { pnl: +r.totalUsd.toFixed(2), minPnl: +r.minTotal.toFixed(2), trades: r.days.reduce((a, d) => a + d.kalshiTrades + d.perpsTrades, 0) };
}

// ---- The step --------------------------------------------------------------------------------------------

export interface ChampionFile {
  schema: 'conditioning1'; version: string; at: string; trial: number; id: string; origin: string;
  windows: number; totalUsd: number; liveTotalUsd: number;
  /** The settings to apply, by setting name (the bot's environment names; tierScale scales the sizing tiers). */
  params: Record<string, number>;
}

export interface ConditioningStepResult { elite?: string; best?: string; bestPassed: number; trials: number; windows: number; notes: string[]; champion?: string }

export async function conditioningStep(o: {
  replayDir: string; historyDir: string; modelsDir: string; setupOos?: string; modelPath?: string; live: WholeBotSettings;
  ledger?: HistoryLedger; fitted: (d: string) => boolean; instances: number; workers: number; seed?: number;
  rules?: Partial<ConditioningRules>; log?: (m: string) => void; now?: number; stopped?: () => boolean;
}): Promise<ConditioningStepResult> {
  const log = o.log ?? ((m: string) => console.log(`[conditioning] ${m}`));
  const now = o.now ?? Date.now();
  const all = recordingFiles(o.replayDir).map((f: RecordingDay) => f.day);
  const pool = unseenDays(all, o.ledger, o.fitted);
  log(`${pool.length} unseen day(s) of the ${all.length} in the history replay (no network trained on their week; outside the decision model's fitting span)`);
  if (pool.length < 18) throw new Error(`only ${pool.length} unseen replay day(s): Tiers 1-3 alone need 18 (the history replay grows as the normal training runs)`);
  const characters = dayCharacters(o.historyDir, pool);
  const counts: Record<string, number> = {};
  for (const c of characters.values()) counts[c] = (counts[c] ?? 0) + 1;
  log(`market character of those days: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'unknown (no hourly history)'}`);
  const notes: string[] = [];
  const used = new Set<string>();
  const seed = o.seed ?? Math.floor(now / 1000);
  const judged = (d: string) => o.ledger?.use('conditioning', isoWeek(d)).judged ?? 0;
  const pool2 = o.workers > 1 ? new WorkerPool<CondTask, WindowResult>(workerScript('conditioningWorker'), o.workers) : undefined;
  let windowsPlayed = 0;
  const evaluate = async (settings: WholeBotSettings, stage: Stage): Promise<WindowResult> => {
    const t: CondTask = { replayDir: o.replayDir, historyDir: o.historyDir, setupOos: o.setupOos, modelPath: o.modelPath, window: `w-${stage.days.join('_')}`, days: stage.days, settings: { ...settings, totalUsd: stage.cash } };
    windowsPlayed++;
    return pool2 ? pool2.run(t) : evaluateTask(t);
  };
  let res: ConditioningResult<WholeBotSettings>;
  try {
    res = await runConditioning({
      rules: o.rules,
      stagesFor: (trial) => allocateStages({ pool, used, characters, judged, seed: seed + trial, notes }),
      instancesFor: (trial, prev) => instancesFor(trial, o.instances, o.live, prev, seed),
      baseline: o.live, evaluate, log, stopped: o.stopped,
      progress: (trial, done, total) => progress(`Conditioning trial ${trial + 1} windows`, done, total),
    });
  } finally {
    await pool2?.close();
  }
  // The weeks played, so later runs prefer others.
  if (o.ledger) {
    const weeks = [...new Set([...used].map(isoWeek))];
    o.ledger.markJudged('conditioning', weeks, now);
    o.ledger.save();
  }
  const rules = { ...DEFAULT_RULES, ...o.rules };
  const summarize = (r: InstanceRecord<WholeBotSettings>) => ({ id: r.id, origin: r.origin, passed: r.passed, wins: r.wins, wildcard: r.wildcard ?? false, culled: r.culled ?? null, totalUsd: +r.played.reduce((a, x) => a + x.pnl, 0).toFixed(2), worstUsd: +Math.min(0, ...r.played.map((x) => x.minPnl)).toFixed(2), params: paramsOf(r.settings), played: r.played });
  const report = {
    schema: 'conditioning-report1', at: new Date(now).toISOString(), rules, tiers: TIERS, windowDays: WINDOW_DAYS, unseenDays: pool.length, characters: counts, notes,
    elite: res.elite ? summarize(res.elite) : null, best: res.best ? summarize(res.best) : null,
    trials: res.trials.map((t) => ({ trial: t.trial, stages: t.stages, baseline: t.baseline, elite: t.elite?.id ?? null, best: t.best?.id ?? null, saved: t.saved.map(summarize), instances: t.instances.map(summarize) })),
  };
  fs.mkdirSync(o.modelsDir, { recursive: true });
  const write = (f: string, body: unknown) => { const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(body, null, 1)); fs.renameSync(tmp, f); };
  write(path.join(o.modelsDir, 'conditioning_report.json'), report);
  let champion: string | undefined;
  if (res.elite) {
    const trial = res.trials.find((t) => t.elite?.id === res.elite!.id)!;
    const file = path.join(o.modelsDir, 'conditioning_champion.json');
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(o.modelsDir, 'conditioning_champion.prev.json'));
    const body: ChampionFile = {
      schema: 'conditioning1', version: `cond-${new Date(now).toISOString().slice(0, 10)}-${res.elite.id}`, at: new Date(now).toISOString(), trial: trial.trial, id: res.elite.id, origin: res.elite.origin,
      windows: res.elite.played.length, totalUsd: +res.elite.played.reduce((a, x) => a + x.pnl, 0).toFixed(2), liveTotalUsd: +trial.baseline.reduce((a, x) => a + x.pnl, 0).toFixed(2),
      params: paramsOf(res.elite.settings),
    };
    write(file, body);
    champion = body.version;
    log(`Elite Champion ${res.elite.id}: $${body.totalUsd} over ${body.windows} windows (live settings $${body.liveTotalUsd}); it replaces the live settings (previous kept as conditioning_champion.prev.json)`);
  } else if (res.best) log(`no Elite Champion; the best got through ${res.best.passed} of ${res.trials[0]?.stages.length ?? 0} window(s): ${res.best.id} (${res.best.origin}); kept in conditioning_report.json, the live settings unchanged`);
  return { elite: res.elite?.id, best: res.best?.id, bestPassed: res.best?.passed ?? 0, trials: res.trials.length, windows: windowsPlayed, notes, champion };
}
