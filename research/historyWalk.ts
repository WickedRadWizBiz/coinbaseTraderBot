// History walk: each spiking network (crypto, perps) walks the years of history in time order, from the first day of
// its data to a week before the latest day, a block of days per run, as if time had flowed without a stop. Every member
// of its population keeps its whole state from one block to the next (the network, its clock and pending tags: the
// population's checkpoints), and the replay is built on from the builder's own end-of-day state (open contracts,
// volatility estimates, the price bridge), so a block boundary looks to the networks like any midnight.
//
// Where it stands lives on the server (models/work/history-walk/<net>/), shared by the laptop trainer and GitHub
// (.github/workflows/history-walk.yml), which take turns under a lease (one walker per network at a time, so no day is
// walked twice):
//   walk.json        the first day not walked yet, the blocks walked, the measured time per day (it sizes the next
//                    block), the walk's stage and the elite's knobs
//   pbt/             the population (research/snnPbt.ts, walk mode): each member's network state and knobs
//   replay-state/    the replay builder's end-of-day state of the day before the last day walked: the next block is
//                    built on from it (research/history/historyReplay.ts), its first day warming the replay up
//   elite.json       the walk's best network as a model file: the daily training (research/pipeline.ts
//                    snn-<net>-train) starts from it
//
// A block: its Binance archives downloaded (data.binance.vision; from the server only Kalshi's day files for it, put
// in the history folder by the caller), its replay days built, then the population walks it (runSnnPbt with `walk`):
// a round per day, each member judged on the day before it learns from it, the weakest taking over the best one's
// state and the others' knobs moving a little, as in every tournament; the holdout weeks (research/historyLedger.ts
// inHoldoutWeek) played through with learning paused, so no network ever learned from them. The run stops at a day
// boundary when its time is up, and the walk goes on from there next time.
//
// The walk stays WALK_HOLD_BACK_DAYS behind the latest day: the daily training goes on from its best network over the
// latest weeks and is judged on the newest days, which that network must never have seen.
//
//   node --import tsx research/historyWalk.ts plan --net crypto [--minutes 240]
//   node --import tsx research/historyWalk.ts run --net crypto [--minutes 240] [--work <scratch folder>]
//   node --import tsx research/historyWalk.ts status
//   node --import tsx research/historyWalk.ts lease take|give --net crypto --holder github-123 [--ttl-min 360]
//     (prints the shell command to run on the server)

import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig, paperEnv } from '../bot/config';
import type { HistTf } from '../bot/marketdata/historyStore';
import { SnnNetwork, type SnnCheckpoint } from '../bot/snn/network';
import { DEFAULT_SNN, domainParams, stageFlags, withFlags, type Stage } from '../bot/snn/params';
import { withSnnHyper } from '../bot/snn/population';
import { storedAssets } from './history/candles';
import { downloadBinance, downloadBinanceFunding, downloadBinanceOpenInterest } from './history/binanceVision';
import { buildHistoryReplay } from './history/historyReplay';
import { inHoldoutWeek } from './historyLedger';
import { runSnnPbt } from './snnPbt';
import { regimeTransitions } from './transitions';
import { workerCount } from './workerPool';

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => iso(Date.parse(`${d}T00:00:00Z`) + n * DAY);
const daysFrom = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

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
/** Coins the networks' tournaments judge regime changes on (research/pipeline.ts). */
const SNN_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];

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

export interface WalkResult {
  net: WalkNet; caughtUp: boolean;
  from?: string; walkedTo?: string; days?: number; judged?: number; behind?: number;
  minutes: { download: number; build: number; walk: number; total: number };
  downloadMb?: number; elite?: { member: number; fitness?: number }; population?: number; workers?: number;
  /** Share of the walk's steps on the days it learns from in which the health monitor froze a member's learning. */
  frozen?: number;
}

/** Walks the next block of one network (see the header). `historyDir` holds what the caller brought from the server
 *  (Kalshi's day files for the block, the dominance series); the Binance archives are downloaded into it. */
export async function runWalk(o: {
  net: WalkNet; modelsDir: string; work: string; historyDir?: string; minutes: number; by: string; today?: string;
  workers?: number; log?: (m: string) => void; now?: () => number;
}): Promise<WalkResult> {
  const now = o.now ?? Date.now;
  const t0 = now();
  const log = o.log ?? ((m: string) => console.log(`[walk] ${m}`));
  const cfg = loadConfig(paperEnv(process.env));
  const A = cfg.autoTrain;
  const dir = walkDir(o.modelsDir, o.net);
  const st = readWalk(dir, o.net);
  st.stage ??= cfg.snn.domains[o.net].stage;
  const mins = (t: number) => (now() - t) / 60000;
  const plan = planBlock(st, { today: o.today ?? iso(now()), minutes: o.minutes });
  if (!plan) { log(`${o.net}: caught up (next day ${st.next}; the walk stays ${WALK_HOLD_BACK_DAYS} days behind the latest day)`); return { net: o.net, caughtUp: true, minutes: { download: 0, build: 0, walk: 0, total: mins(t0) } }; }
  const first = plan.days[0], last = plan.days[plan.days.length - 1];
  const deadline = t0 + o.minutes * 60_000;
  const hist = o.historyDir ?? path.join(o.work, 'history'), rep = path.join(o.work, 'replay');
  const assets = cfg.taNet.historyReplayAssets;
  log(`${o.net}: block ${first}..${last} (${plan.days.length} days; ${plan.behind} more to walk after it), stage ${st.stage}`);

  // 1. The block's archives: the 1-minute bars from the warm-up day; the candle feed's last 300 bars before it.
  let t = now();
  const month = (d: string) => d.slice(0, 7), toMonth = month(last);
  const quiet = () => undefined;
  const dl = async (intervals: HistTf[], from: string, markets: Array<'spot' | 'um'>, source?: string) =>
    (await downloadBinance({ out: hist, assets, intervals, markets, source, fromMonth: month(from), toMonth, log: quiet })).reduce((a, s) => a + s.fetched, 0);
  let files = await dl(['1m'], plan.warmUp, ['spot'], 'binance-1m');
  files += await dl(['15m', '1h'], addDays(plan.warmUp, -14), ['spot']) + await dl(['1d'], addDays(plan.warmUp, -310), ['spot']);
  if (o.net === 'perps') {
    files += await dl(['1m'], plan.warmUp, ['um']);
    files += (await downloadBinanceFunding({ out: hist, assets, fromMonth: month(plan.warmUp), toMonth, log: quiet })).reduce((a, s) => a + s.fetched, 0);
    files += (await downloadBinanceOpenInterest({ out: hist, assets, fromDay: plan.warmUp, toDay: last, log: quiet })).reduce((a, s) => a + s.fetched, 0);
  }
  const download = mins(t);
  log(`${o.net}: ${files} archive file(s) downloaded in ${download.toFixed(1)} min`);

  // 2. The replay days, built on from the builder's state at the end of the day before the warm-up day (none at the
  // walk's start: the warm-up day is then built fresh). Every day's state is added to the walk folder before the walk,
  // so a run stopped part-way still leaves the state the next block starts from.
  t = now();
  const states = path.join(rep, 'replay-states'), kept = path.join(dir, 'replay-state');
  fs.mkdirSync(states, { recursive: true });
  for (const f of fs.existsSync(kept) ? fs.readdirSync(kept) : []) fs.copyFileSync(path.join(kept, f), path.join(states, f));
  const built = await buildHistoryReplay({ historyDir: hist, outDir: rep, assets, fromDay: plan.warmUp, toDay: last, synthetic: o.net === 'crypto', keepAllStates: true, log: quiet });
  fs.mkdirSync(kept, { recursive: true });
  for (const d of [plan.warmUp, ...plan.days]) { const f = `${d}.json.gz`; if (fs.existsSync(path.join(states, f))) fs.copyFileSync(path.join(states, f), path.join(kept, f)); }
  const build = mins(t);
  log(`${o.net}: ${built.written} replay day(s) built in ${build.toFixed(1)} min (${built.assets.length} coins${built.resumed ? `, on from the end of ${built.resumed}` : ', fresh'}${built.synthetic ? `, ${built.synthetic} synthetic contracts` : ''})`);

  // 3. The walk. Each member on a worker thread of its own (TRAIN_WORKERS); its knobs mutate as in every tournament,
  // but no member ever restarts from nothing (each stays one continuous network).
  t = now();
  const workers = o.workers ?? workerCount();
  const coins = SNN_COINS.filter((a) => storedAssets(hist).includes(a));
  const transitions = regimeTransitions(hist, coins, Date.parse(`${first}T00:00:00Z`), Date.parse(`${last}T00:00:00Z`) + DAY, quiet);
  const res = await runSnnPbt({
    recordings: rep, domain: o.net, stage: st.stage as Stage, days: plan.days, allDays: [plan.warmUp, ...plan.days], layout: 'walk', walk: { paused: inHoldoutWeek },
    transitions, initDays: A.snnPbtInitDays, evalDays: 1, stateDir: path.join(dir, 'pbt'), restartEvery: 0, population: WALK_POPULATION, workers,
    genetic: { parents: A.gaParents, islands: A.gaIslands, breedEvery: A.gaBreedEvery, mutation: A.gaMutation }, tapeDir: path.join(o.work, 'tapes'),
    stop: () => now() >= deadline, log: (m) => log(`${o.net}: ${m}`),
  });
  const walk = mins(t);

  // 4. The elite as a model file for the daily training, and where the walk stands.
  const lastRound = res.log[res.log.length - 1];
  const fitness = lastRound?.ranking.find((x) => x.member === res.elite.member)?.fitness;
  if (res.walkedTo && fs.existsSync(path.join(dir, 'pbt', `m${res.elite.member}.json`))) {
    const cp = JSON.parse(fs.readFileSync(path.join(dir, 'pbt', `m${res.elite.member}.json`), 'utf8')) as SnnCheckpoint;
    const params = withSnnHyper(domainParams(o.net, withFlags({ ...DEFAULT_SNN }, stageFlags(st.stage as Stage))), res.elite.hyper);
    const net = new SnnNetwork(params);
    net.restore(cp, { allowParamChange: true });
    const f = path.join(dir, 'elite.json');
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(net.exportModel(`${o.net} history walk elite #${res.elite.member}, walked ${WALK_START[o.net]}..${addDays(res.walkedTo, -1)}`)));
    fs.renameSync(`${f}.tmp`, f);
    st.elite = { member: res.elite.member, hyper: res.elite.hyper, through: res.walkedTo };
  }
  const walkedTo = res.walkedTo && res.walkedTo > first ? res.walkedTo : undefined;
  const judged = walkedTo ? res.log.filter((r) => r.evalFrom >= first && r.evalFrom < walkedTo).length : 0;
  // Only the state the next block starts from stays: the end of the day before its warm-up day (this block's own
  // starting state when it walked nothing, e.g. a holdout week waiting for the day after it).
  const keep = `${addDays(walkedTo ?? first, -2)}.json.gz`;
  for (const f of fs.readdirSync(kept)) if (f !== keep) fs.rmSync(path.join(kept, f), { force: true });
  const total = mins(t0);
  writeWalk(dir, recordBlock(st, { from: first, walkedTo, judged, minutes: total, by: o.by, elite: res.elite.member, fitness }, now()));
  const days = walkedTo ? daysFrom(first, walkedTo) : 0;
  const frozen = res.frozen !== undefined ? `; learning frozen by the health monitor ${(100 * res.frozen).toFixed(1)}% of the time` : '';
  log(`${o.net}: walked ${days} day(s) (${judged} judged, ${days - judged} with learning paused) in ${walk.toFixed(1)} min; ${total.toFixed(1)} min in all; elite #${res.elite.member}${fitness !== undefined ? ` (fitness ${fitness.toFixed(2)} on its last day)` : ''}${frozen}`);
  return {
    net: o.net, caughtUp: false, from: first, walkedTo, days, judged, behind: walkedTo ? Math.max(0, daysFrom(walkedTo, walkEnd(o.today ?? iso(now())))) : plan.behind + plan.days.length,
    minutes: { download, build, walk, total }, elite: { member: res.elite.member, fitness }, population: WALK_POPULATION, workers, ...(res.frozen !== undefined ? { frozen: res.frozen } : {}),
  };
}

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const cfg = loadConfig(paperEnv(process.env));
  const models = cfg.autoTrain.dir;
  const net = cliArg('net', 'crypto') as WalkNet;
  if (cmd === 'lease') {
    const action = process.argv[3] as 'take' | 'give';
    if (action !== 'take' && action !== 'give') throw new Error('lease take|give');
    console.log(leaseCommand(action, net, cliArg('holder', 'laptop'), Number(cliArg('ttl-min', '360'))));
    return;
  }
  if (cmd === 'status') {
    for (const n of WALK_NETS) {
      const st = readWalk(walkDir(models, n), n);
      const left = Math.max(0, daysFrom(st.next, walkEnd(iso(Date.now()))));
      console.log(`${n}: next day ${st.next}, ${left} day(s) to walk (it stays ${WALK_HOLD_BACK_DAYS} days behind the latest day), ${st.blocks.length} block(s) walked${st.secPerDay ? `, ${(st.secPerDay / 60).toFixed(1)} min a day` : ''}`);
    }
    return;
  }
  if (!WALK_NETS.includes(net)) throw new Error(`--net crypto|perps (not ${net})`);
  const minutes = Number(cliArg('minutes', '240'));
  if (cmd === 'plan') {
    const p = planBlock(readWalk(walkDir(models, net), net), { today: iso(Date.now()), minutes });
    console.log(JSON.stringify(p ? { net, from: p.days[0], to: p.days[p.days.length - 1], warmUp: p.warmUp, days: p.days.length, behind: p.behind } : { net, caughtUp: true }));
    return;
  }
  if (cmd === 'run') {
    const work = cliArg('work', '') || fs.mkdtempSync(path.join(os.tmpdir(), `walk-${net}-`));
    const r = await runWalk({ net, modelsDir: models, work, historyDir: cliArg('history', '') || undefined, minutes, by: cliArg('by', 'laptop') });
    console.log(`WALK ${JSON.stringify(r)}`);
    return;
  }
  throw new Error('history walk: plan | run | status | lease take|give');
}

if (process.argv[1] && /historyWalk\.(ts|js|cjs)$/.test(process.argv[1])) void main().catch((e) => { console.error(`history walk failed: ${(e as Error).message}`); process.exitCode = 1; });
