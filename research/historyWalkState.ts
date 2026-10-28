// Where each history walk stands and who may walk it now (research/historyWalk.ts walks): read by the walk, the
// pipeline (its networks start from the walk's best one) and the laptop trainer, which takes its turns over SSH. Nothing
// here loads a network, so the trainer's own process stays small.

import fs from 'fs';
import path from 'path';

export const DAY = 86_400_000;
export const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => iso(Date.parse(`${d}T00:00:00Z`) + n * DAY);
export const daysFrom = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

export type WalkNet = 'crypto' | 'perps';
export const WALK_NETS: WalkNet[] = ['crypto', 'perps'];
/** The first day each network walks (the day before warms the replay up): crypto from the second day of Binance's
 *  1-minute spot history (BTC and ETH from 2017-08-17), perps from the second day of its first perpetual (BTCUSDT
 *  from 2019-09-08). */
export const WALK_START: Record<WalkNet, string> = { crypto: '2017-08-18', perps: '2019-09-09' };
/** The walk stays this many days behind the latest day: the daily training, started from its network, is judged on
 *  its newest days (the last fifth of AUTO_TRAIN_SNN_TRAIN_DAYS: 4 of 21), which that network must never have seen
 *  (research/pipeline.ts snn-<net>-train). */
export const WALK_HOLD_BACK_DAYS = 7;
/** A block's days: at least a holdout week and more (WALK_MIN_DAYS), at most WALK_MAX_DAYS. */
export const WALK_MIN_DAYS = 20;
export const WALK_MAX_DAYS = 90;
/** Seconds a day is taken to cost before one has been measured. */
export const WALK_FIRST_SEC_PER_DAY = 600;
/** Members walking together: fixed for the whole walk (another size would start it over). Each replays on a worker
 *  thread of its own, a fourth records the next day's tape. */
export const WALK_POPULATION = 3;

export interface WalkBlock {
  from: string; to: string;
  /** Days walked (judged and paused), of them judged, minutes the block took, who walked it and when. */
  days: number; judged: number; minutes: number; by: string; at: string;
  /** The elite after the block and its fitness on the block's last day. */
  elite?: number; fitness?: number;
}

export interface WalkState {
  version: 1; net: WalkNet;
  /** The first day not walked yet. */
  next: string;
  /** The stage the walk's networks run, fixed for the whole walk (another would start the population over). */
  stage?: string;
  /** Seconds a walked day takes, everything included (download, replay build, the walk): it sizes the next block. */
  secPerDay?: number;
  /** The elite (elite.json is its network) and its knobs: the daily training starts from both. */
  elite?: { member: number; hyper: Record<string, number>; through: string };
  blocks: WalkBlock[];
}

export const walkDir = (modelsDir: string, net: WalkNet) => path.join(modelsDir, 'work', 'history-walk', net);
/** The first day the walk may not walk yet on `today`. */
export const walkEnd = (today: string) => addDays(today, -WALK_HOLD_BACK_DAYS);

/** The walk's state (a new one at WALK_START). Its first day not walked yet is the population's own when the population
 *  got further (a run stopped after rounds it saved, before it wrote walk.json). */
export function readWalk(dir: string, net: WalkNet): WalkState {
  let st: WalkState = { version: 1, net, next: WALK_START[net], blocks: [] };
  try { const x = JSON.parse(fs.readFileSync(path.join(dir, 'walk.json'), 'utf8')) as WalkState; if (x.version === 1 && x.net === net) st = x; } catch { /* a new walk */ }
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'pbt', 'state.json'), 'utf8')) as { lastEvalTo?: number; layout?: string };
    if (p.layout === 'walk' && p.lastEvalTo && iso(p.lastEvalTo) > st.next) st.next = iso(p.lastEvalTo);
  } catch { /* no population yet */ }
  return st;
}

export function writeWalk(dir: string, st: WalkState): void {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'walk.json');
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(st, null, 1));
  fs.renameSync(`${f}.tmp`, f);
}

export interface WalkPlan {
  /** The block's days (consecutive), the day before them (the replay's warm-up) and the days left to walk after it. */
  days: string[]; warmUp: string; behind: number;
}

/** The next block: from the first day not walked, as many days as `minutes` buys at the measured pace (between
 *  WALK_MIN_DAYS and WALK_MAX_DAYS), never into the days held back (walkEnd). None when the walk has caught up. */
export function planBlock(st: WalkState, o: { today: string; minutes: number; minDays?: number; maxDays?: number }): WalkPlan | undefined {
  const end = walkEnd(o.today);
  if (st.next >= end) return undefined;
  const left = daysFrom(st.next, end);
  const want = Math.floor((o.minutes * 60) / Math.max(1, st.secPerDay ?? WALK_FIRST_SEC_PER_DAY));
  const n = Math.min(left, Math.max(o.minDays ?? WALK_MIN_DAYS, Math.min(o.maxDays ?? WALK_MAX_DAYS, want)));
  const days = Array.from({ length: n }, (_, i) => addDays(st.next, i));
  return { days, warmUp: addDays(st.next, -1), behind: left - n };
}

/** A block walked (up to `walkedTo`, its first day not walked): the position moves on and the pace is measured. */
export function recordBlock(st: WalkState, b: { from: string; walkedTo?: string; judged: number; minutes: number; by: string; elite?: number; fitness?: number }, now = Date.now()): WalkState {
  const walked = b.walkedTo ? daysFrom(b.from, b.walkedTo) : 0;
  // A block that walked nothing (its time went on the download and the build) counts as one slow day.
  const per = (b.minutes * 60) / Math.max(1, walked);
  const out: WalkState = { ...st, next: b.walkedTo && b.walkedTo > st.next ? b.walkedTo : st.next, secPerDay: st.secPerDay ? 0.5 * st.secPerDay + 0.5 * per : per };
  if (walked > 0) out.blocks = [...st.blocks, { from: b.from, to: addDays(b.walkedTo!, -1), days: walked, judged: b.judged, minutes: Math.round(b.minutes), by: b.by, at: new Date(now).toISOString(), ...(b.elite !== undefined ? { elite: b.elite } : {}), ...(b.fitness !== undefined ? { fitness: b.fitness } : {}) }].slice(-500);
  return out;
}

/** The shell command (run on the server over ssh) that takes or gives back a network's walk lease: a file in
 *  ~/bot/data/locks holding "<expiry, epoch seconds> <holder>", changed under flock. Taking it fails (exit 3) while
 *  another holder has it unexpired; giving it back clears it only for its holder. */
export function leaseCommand(action: 'take' | 'give', net: WalkNet, holder: string, ttlMin = 360): string {
  if (!/^[A-Za-z0-9._-]+$/.test(holder)) throw new Error(`lease holder "${holder}": letters, digits, '.', '_' and '-' only`);
  if (!WALK_NETS.includes(net)) throw new Error(`no history walk for ${net}`);
  const f = `walk-${net}.lease`;
  const body = action === 'take'
    ? `now=$(date +%s); if [ -s ${f} ]; then read exp who < ${f}; if [ "\${exp:-0}" -gt "$now" ] && [ "$who" != "${holder}" ]; then echo "the ${net} walk is held by $who for $(( (exp - now) / 60 )) more minute(s)"; exit 3; fi; fi; echo "$((now + ${Math.round(ttlMin * 60)})) ${holder}" > ${f}; echo "${net} walk lease taken"`
    : `if [ -s ${f} ]; then read exp who < ${f}; if [ "$who" = "${holder}" ]; then rm -f ${f}; fi; fi; echo "${net} walk lease given back"`;
  return `mkdir -p ~/bot/data/locks && cd ~/bot/data/locks && exec 9>walk-${net}.lock && flock -w 60 9 && { ${body}; }`;
}
