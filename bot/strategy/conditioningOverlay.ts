// The conditioning champion in the live bot: the trading settings of the instance that passed every window of
// conditioning mode on unseen days and made more there than the live settings did (research/conditioningRun.ts,
// <AUTO_TRAIN_DIR>/conditioning_champion.json, sent by the trainer with the models).
//
//   at startup     its settings replace the configured ones (the configuration is loaded again with them, before
//                  anything is built): the Kalshi strategy's
//                  minimum edge, maker / taker buffers and fill-model floor, an aggression scale on the sizing tiers
//                  (Kelly fraction and risk per order and window), and the perps setups' risk per trade (a fraction
//                  of equity; the fixed-dollar risk is cleared), positions, minimum target and daily loss stop.
//                  Only these names are read, each clamped to the range conditioning tests.
//   a new champion the bot restarts once to apply it (checked every minute; the perps traders take their settings
//                  when they are built)
//   rollback       the dashboard puts the previous champion back (conditioning_champion.prev.json; with none, the
//                  configured settings) and restarts
//
// CONDITIONING_APPLY=false ignores the file.

import fs from 'fs';
import path from 'path';
import type { Config } from '../config';
import { scaledTiers } from '../risk/sizingTiers';

export interface ChampionFile { schema: string; version: string; at: string; id: string; origin?: string; windows?: number; totalUsd?: number; liveTotalUsd?: number; params: Record<string, number> }

/** Each setting's name in the bot's environment and the range it may take (inside the configuration's own). */
const SETTINGS: Record<string, { min: number; max: number; env: (v: number, base: Config) => Record<string, string> }> = {
  STRATEGY_MIN_EDGE: { min: 0.005, max: 0.1, env: (v) => ({ STRATEGY_MIN_EDGE: String(v) }) },
  STRATEGY_TAKER_BUFFER: { min: 0, max: 0.05, env: (v) => ({ STRATEGY_TAKER_BUFFER: String(v) }) },
  STRATEGY_MAKER_BUFFER: { min: 0, max: 0.05, env: (v) => ({ STRATEGY_MAKER_BUFFER: String(v) }) },
  FILL_MIN_EV: { min: 0, max: 0.02, env: (v) => ({ FILL_MIN_EV: String(v) }) },
  tierScale: { min: 0.25, max: 3, env: (v, base) => ({ SIZING_TIERS: JSON.stringify(scaledTiers(base.sizingTiers, v)) }) },
  SETUP_FAST_RISK: { min: 0.0005, max: 0.05, env: (v) => ({ SETUP_FAST_RISK: String(v), SETUP_FAST_RISK_USD: '0' }) },
  SETUP_SLOW_RISK: { min: 0.0005, max: 0.05, env: (v) => ({ SETUP_SLOW_RISK: String(v), SETUP_SLOW_RISK_USD: '0' }) },
  SETUP_FAST_MAX_POSITIONS: { min: 0, max: 10, env: (v) => ({ SETUP_FAST_MAX_POSITIONS: String(Math.round(v)) }) },
  SETUP_SLOW_MAX_POSITIONS: { min: 0, max: 10, env: (v) => ({ SETUP_SLOW_MAX_POSITIONS: String(Math.round(v)) }) },
  SETUP_MIN_TARGET_USD: { min: 0, max: 50, env: (v) => ({ SETUP_MIN_TARGET_USD: String(v) }) },
  PERPS_DAILY_LOSS_FRAC: { min: 0.01, max: 0.5, env: (v) => ({ PERP_DAILY_LOSS_FRAC: String(v) }) },
};

export const championPath = (dir: string) => path.join(dir, 'conditioning_champion.json');
export const previousPath = (dir: string) => path.join(dir, 'conditioning_champion.prev.json');

export function readChampion(file: string): ChampionFile | undefined {
  try {
    const f = JSON.parse(fs.readFileSync(file, 'utf8')) as ChampionFile;
    return f?.schema === 'conditioning1' && typeof f.version === 'string' && f.params && typeof f.params === 'object' ? f : undefined;
  } catch { return undefined; }
}

let applied: { version: string; at: string; id: string; params: Record<string, number>; skipped: string[] } | undefined;
export const appliedChampion = () => applied;

/** The champion's settings as environment values over the configured ones (the bot reloads its configuration with
 *  them, so its own range checks and the sizing-tier validation apply); each clamped, other names ignored. */
export function championEnv(f: ChampionFile, base: Config): { env: Record<string, string>; params: Record<string, number>; skipped: string[] } {
  const env: Record<string, string> = {}, params: Record<string, number> = {}, skipped: string[] = [];
  for (const [name, raw] of Object.entries(f.params)) {
    const s = SETTINGS[name];
    if (!s || typeof raw !== 'number' || !Number.isFinite(raw)) { skipped.push(name); continue; }
    const v = Math.min(s.max, Math.max(s.min, raw));
    Object.assign(env, s.env(v, base));
    params[name] = v;
  }
  return { env, params, skipped };
}

/** Record what the running bot applied (for the status and the change watcher). */
export function markApplied(f: ChampionFile, params: Record<string, number>, skipped: string[]): void {
  applied = { version: f.version, at: f.at, id: f.id, params, skipped };
}

/** Status for the dashboard. */
export function conditioningStatus(dir: string): { applied: typeof applied | null; available: string | null; previous: string | null } {
  return { applied: applied ?? null, available: readChampion(championPath(dir))?.version ?? null, previous: readChampion(previousPath(dir))?.version ?? null };
}

/** Put the previous champion back (or, with none, remove the champion: the configured settings return). */
export function rollbackChampion(dir: string): { to: string | null } {
  const cur = championPath(dir), prev = previousPath(dir);
  const back = readChampion(prev);
  if (back) {
    const tmp = `${cur}.${process.pid}.tmp`;
    fs.copyFileSync(prev, tmp);
    if (fs.existsSync(cur)) fs.renameSync(cur, path.join(dir, `conditioning_champion.rolled-back-${Date.now()}.json`));
    fs.renameSync(tmp, cur);
    fs.rmSync(prev, { force: true });
    return { to: back.version };
  }
  if (fs.existsSync(cur)) fs.renameSync(cur, path.join(dir, `conditioning_champion.rolled-back-${Date.now()}.json`));
  return { to: null };
}

/** Calls onChange when the champion file holds a different version than the one applied (or appears / goes). */
export function watchChampion(dir: string, onChange: (version: string | null) => void, everyMs = 60_000): NodeJS.Timeout {
  return setInterval(() => {
    const v = readChampion(championPath(dir))?.version ?? null;
    if (v !== (applied?.version ?? null)) onChange(v);
  }, everyMs).unref();
}
