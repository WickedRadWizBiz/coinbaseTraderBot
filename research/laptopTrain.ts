// Laptop trainer: the full training pipeline (research/pipeline.ts) on your own computer, until it stops
// improving or reaches the target (or for as many hours as you give it), with bigger budgets than the server
// or the daily remote job can afford. Nothing here trains a model itself: every module is trained, judged
// and promoted (champion vs challenger) by the pipeline's own steps, in the pipeline's order.
//
//   1. pull     (optional, SSH) the bot's data from the server, like the remote-training workflow: the
//               last N days of recordings, the candle history, the models directory (pipeline state,
//               tournaments in progress) and the rest of ~/bot/data; plus bot.env WITHOUT credentials
//   2. history  every crypto asset's spot history from Binance Vision and Coinbase (years of candles) and
//               a year of Kalshi's settled contracts
//   3. rounds   round 1 runs every step; each later round is one tournament generation per network on weeks
//               of history it has never trained on (research/historyLedger.ts), a contest on held-out weeks,
//               the models that read the networks retrained, and the readiness check: the whole bot on
//               days nothing was fitted or tuned on (research/readiness.ts). Each module is promoted only
//               when it beats the one in use (AUTO_TRAIN_CHAMPION). Every 24 hours a round runs every step
//               again (new history, new recordings from the server: new weeks to train on).
//   4. push     (optional, SSH) after every round that made a model better, and at the end: the models
//               directory to the server, newer files only; the running bot hot-swaps every model that
//               changed (no restart)
//
//   It stops by itself when the whole bot reaches the target (TRAIN_TARGET_DAILY_PCT of TRAIN_TARGET_POOL_USD
//   a day, the 95% interval's lower end, with a drawdown of at most TRAIN_TARGET_MAX_DD_PCT, over 30+ held-out
//   days), when TRAIN_PLATEAU_ROUNDS rounds in a row improve nothing (no challenger beat the model in use, no
//   tournament still running), or when no fresh history is left and the round improved nothing. Progress
//   is in trainer-data/STATUS.txt (and rounds.jsonl); trainer-data/GUIDE.txt says what good scores look like.
//
//   Windows:  double-click Train.cmd (the release zip ships Node and the bundled trainer)
//   anywhere: node --import tsx research/laptopTrain.ts [--hours 0] [--host 1.2.3.4 --key C:\keys\lightsail.pem]
//
//   --hours N      0 (default) = until it stops by itself; N > 0 = also stop after N hours (the last round
//                  is not started if it would overrun much)
//   --data DIR     where data, history and models live (default ./trainer-data, kept between runs)
//   --host H --user U --port P --key FILE    the server and its SSH key (Lightsail: the instance's .pem)
//   --days N       recorded days to copy (default 45)      --no-pull / --no-push      --only a,b (steps)
//   --setup        ask the questions again (server, key)
//
// CPU only: the networks are small TypeScript models (no GPU framework); the pipeline runs on one core
// per step. A long run is checkpointed after every step, so stopping (Ctrl+C) loses at most the step in
// progress; the next run continues the tournaments where they stopped.

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { pipelineCommand } from '../bot/autotrain';
import { loadConfig } from '../bot/config';
import type { ReadinessFile } from './readiness';

export interface TrainerSettings { host?: string; user?: string; port?: number; key?: string }
export interface RemoteFile { path: string; size: number; mtime: number }

/** Steps that continue a tournament or depend on one: what rounds after the first repeat. */
export const CONTINUE_STEPS = ['ta_net', 'ta_net_oos', 'rule_book', 'gp', 'setups', 'sweep', 'snn', 'vol_model', 'dataset', 'mlp', 'perps', 'readiness'];

/** Never sent to the server: links to replay days, caches it rebuilds, backfills, logs, partial writes. */
const NO_PUSH = /^(work\/(snnfill|perp-dataset[^/]*|perp-backtest-days|sweep-replay|vol-replay|readiness-days|tanet-cache)\/|logs\/)|\.tmp$/;

/** `find -printf '%P\t%s\t%T@\n'` output -> files (mtime in ms). */
export function parseManifest(text: string): RemoteFile[] {
  return text.split('\n').flatMap((l) => {
    const [p, s, t] = l.split('\t');
    const size = Number(s), mtime = Math.round(Number(t) * 1000);
    return p && Number.isFinite(size) && Number.isFinite(mtime) && !p.includes('..') ? [{ path: p, size, mtime }] : [];
  });
}

/** Local files under `root` with the same shape (forward-slash relative paths). */
export function localManifest(root: string): Map<string, RemoteFile> {
  const out = new Map<string, RemoteFile>();
  const walk = (dir: string, rel: string) => {
    let ents: fs.Dirent[] = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile()) { const st = fs.statSync(path.join(dir, e.name)); out.set(r, { path: r, size: st.size, mtime: Math.round(st.mtimeMs) }); }
    }
  };
  walk(root, '');
  return out;
}

/** Server files to copy down: missing here, or newer on the server (2 s slack for file systems). A file
 *  changed here since (a model, the ledger, a tournament's state) is never overwritten by an older copy. */
export function filesToPull(remote: RemoteFile[], local: Map<string, RemoteFile>): RemoteFile[] {
  return remote.filter((f) => { const l = local.get(f.path); return !l || f.mtime > l.mtime + 2000; });
}

/** Local model files to send up: newer than the server's copy (never overwrite a newer server file). */
export function filesToPush(local: Map<string, RemoteFile>, remote: RemoteFile[]): RemoteFile[] {
  const r = new Map(remote.map((f) => [f.path, f]));
  return [...local.values()].filter((f) => { const s = r.get(f.path); return !s || f.mtime > s.mtime + 2000; })
    .filter((f) => !NO_PUSH.test(f.path));
}

/** bot.env lines safe to train with: no credentials, no server paths or network settings. */
export function safeServerEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!m || /KEY|SECRET|TOKEN|PASSWORD|PRIVATE|PEM|CREDENTIAL/.test(m[1]) || /^(BIND_HOST|ALLOW_NON_LOOPBACK|PORT|DATA_DIR|AUTO_TRAIN.*DIR|HISTORY_DIR)$/.test(m[1])) continue;
    const v = m[2].replace(/^["']|["']$/g, '');
    if (/^(\/|~|[A-Za-z]:\\)/.test(v)) continue;
    out[m[1]] = v;
  }
  return out;
}

/** The laptop profile: bigger budgets than the server's defaults. Anything already set (your own
 *  environment, then the server's bot.env) wins over these. `continuous`: rounds until the trainer stops by
 *  itself, each sized like a day's budget (a tournament generation of about 5 weeks), the sweep weekly (a
 *  proposal: it improves no model). */
export function laptopProfile(remainingHours: number, cores = os.cpus().length, continuous = false): Record<string, string> {
  if (continuous) return { ...laptopProfile(24, cores), SWEEP_HOURS: '2', SWEEP_EVERY_DAYS: '7' };
  const h = (x: number) => String(+Math.max(0.1, x).toFixed(2));
  // One worker thread per core but one; tournaments field about one network per worker (more candidates).
  const workers = Math.max(1, cores - 1);
  // A replayed day costs a network a few minutes (it steps every market second): a tournament round is one
  // day per member, all members at once; training is one network going over its window about twice. Both
  // windows grow with the budget (a 12-hour run: 30 tournament days, 14 training days).
  const pbtDays = Math.round(Math.min(365, Math.max(30, 1.5 * remainingHours)));
  const trainDays = Math.round(Math.min(120, Math.max(14, remainingHours)));
  return {
    TRADING_MODE: 'paper', AUTO_TRAIN: 'off', AUTO_TRAIN_CHAMPION: 'true',
    HISTORY_AUTO_UPDATE: 'true', TV_FILL: 'false',
    // All of the 1-minute spot / perp history (from each coin's first Binance month) replayed through the
    // recording-based steps; the memory that takes.
    HISTORY_REPLAY: 'true', HISTORY_REPLAY_YEARS: '0', NODE_OPTIONS: '--max-old-space-size=8192',
    KALSHI_HISTORY_BUDGET_MIN: '600', KALSHI_HISTORY_DAYS: '365',
    // TA network: retrain every round, more tournament rounds per run, every hourly sample, two years of training data.
    TA_NET_RETRAIN_DAYS: '0', TA_NET_MAX_ROUNDS_PER_RUN: '400', TA_NET_STRIDE: '1', TA_NET_TRAIN_MONTHS: '24',
    TA_NET_OOS_HOURS: h(Math.min(12, remainingHours / 4)),
    SWEEP_HOURS: h(Math.min(12, remainingHours / 4)), SWEEP_EVERY_DAYS: '1',
    AUTO_TRAIN_SNN_PBT_EVERY_DAYS: '0', AUTO_TRAIN_SNN_TRAIN_DAYS: String(trainDays), AUTO_TRAIN_SNN_PBT_DAYS: String(pbtDays),
    TRAIN_WORKERS: String(workers), AUTO_TRAIN_SNN_PBT_POPULATION: String(Math.min(32, Math.max(3, workers))),
    // Genetic programming every round, with the video's population (15,000 formulas) on a machine with the cores for it.
    GP_EVERY_DAYS: '0', GP_POPULATION: String(Math.min(15000, Math.max(2000, 2000 * workers))),
  };
}

interface ReportStep { step: string; ok: boolean; skipped?: string; ms?: number; detail?: { promoted?: boolean; improved?: boolean; complete?: boolean; ga?: { generation: number; sinceOffspringWon: number } } }
export interface RoundOutcome { improved: string[]; inProgress: string[]; failed: string[] }

/** What a round's pipeline report says: the steps whose model got better (a challenger that beat the one in
 *  use, or the first of its kind: the pipeline's `improved`), the tournaments still running, the failures. */
export function roundOutcome(steps: ReportStep[]): RoundOutcome {
  const ran = steps.filter((s) => s.ok && !s.skipped);
  return {
    improved: ran.filter((s) => s.detail?.improved === true).map((s) => s.step),
    inProgress: ran.filter((s) => s.detail?.complete === false).map((s) => s.step),
    failed: steps.filter((s) => !s.ok).map((s) => s.step),
  };
}

/** After a round: why to stop, if it should, and how many rounds in a row have now improved nothing. */
export function afterRound(o: { outcome: RoundOutcome; readiness?: ReadinessFile; plateau: number; plateauRounds: number }): { stop?: string; plateau: number } {
  const r = o.readiness;
  if (r?.met && r.wholeBot) {
    return { stop: `target reached: the whole bot made ${pct(r.wholeBot.meanPct)} a day (95% interval from ${pct(r.wholeBot.ciLoPct)}), max drawdown ${r.wholeBot.maxDdPct.toFixed(1)}%, over ${r.wholeBot.days} held-out days on $${r.target.poolUsd}`, plateau: 0 };
  }
  const progress = o.outcome.improved.length > 0 || o.outcome.inProgress.length > 0;
  const plateau = progress ? 0 : o.plateau + 1;
  const nets = (r?.ledger ?? []).filter((l) => /^snn-(crypto|perps)$/.test(l.net));
  if (!progress && nets.length && nets.every((l) => l.fresh === 0)) {
    return { stop: `no fresh history left: ${nets.map((l) => l.net).join(' and ')} have trained on every week of it, and this round improved nothing (new weeks arrive as time passes: run it again in a few weeks)`, plateau };
  }
  if (plateau >= o.plateauRounds) {
    return { stop: `no progress in ${plateau} round(s) in a row: no challenger beat the model in use and no tournament is still running (TRAIN_PLATEAU_ROUNDS=${o.plateauRounds})`, plateau };
  }
  return { plateau };
}

const pct = (x: number | undefined) => (typeof x === 'number' && Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(2)}%` : 'n/a');
const usd = (x: number | undefined) => (typeof x === 'number' && Number.isFinite(x) ? `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}` : 'n/a');

/** The scoreboard printed after each round and written to STATUS.txt. */
export function scoreboard(o: { round: number; hours: number; outcome: RoundOutcome; readiness?: ReadinessFile; plateau: number; plateauRounds: number; stop?: string }): string[] {
  const r = o.readiness, w = r?.wholeBot;
  const L = [`Round ${o.round} done, ${o.hours.toFixed(1)} h into the run${o.stop ? `. STOPPING: ${o.stop}` : ''}`];
  if (r && w) {
    L.push(`Whole bot on ${w.days} held-out day(s), ${w.window}, $${r.target.poolUsd} pool:`);
    L.push(`  ${pct(w.meanPct)} a day (${usd(w.perDayUsd)} a day; 95% interval ${pct(w.ciLoPct)} to ${pct(w.ciHiPct)}), median day ${pct(w.medianPct)}, ${w.winDaysPct.toFixed(0)}% winning days, worst day ${pct(w.worstDayPct)}`);
    L.push(`  max drawdown ${w.maxDdPct.toFixed(1)}%, Sharpe ${Number.isFinite(w.sharpe) ? w.sharpe.toFixed(2) : 'n/a'}; in total Kalshi ${usd(w.kalshiUsd)}, perps ${usd(w.perpsUsd)}`);
    L.push(`  solid: ${w.solid ? 'YES' : `not yet (${w.solidWhy.join('; ')})`}`);
  } else L.push(`Whole bot: ${r?.note ?? 'no readiness check this round'}`);
  if (r) L.push(`Target ${r.target.dailyPct}% a day ($${((r.target.dailyPct / 100) * r.target.poolUsd).toFixed(2)} on $${r.target.poolUsd}), drawdown at most ${r.target.maxDdPct}%, ${r.target.minDays}+ days: ${r.met ? 'MET' : `not met (${r.why.join('; ')})`}`);
  L.push(`This round improved: ${o.outcome.improved.join(', ') || 'nothing'}${o.outcome.inProgress.length ? `; still running: ${o.outcome.inProgress.join(', ')}` : ''}${o.outcome.failed.length ? `; FAILED: ${o.outcome.failed.join(', ')}` : ''}`);
  for (const l of r?.ledger ?? []) L.push(`History ledger, ${l.net}: ${l.trained} of ${l.weeks - l.holdout} training weeks used (${l.fresh} fresh), ${l.holdout} held out (${l.judged} judged), ${l.generations} tournament generation(s)${l.lastContest ? `; last contest ${l.lastContest}` : ''}`);
  for (const c of r?.components ?? []) L.push(`Model ${c.name}: ${c.present ? `${c.validated ? 'validated' : 'not validated'}; ${c.detail}` : 'not trained yet'}`);
  L.push(`Rounds in a row without progress: ${o.plateau} of ${o.plateauRounds}`);
  return L;
}

/** What the trainer does, when it stops, and what good scores look like (printed at the start, GUIDE.txt). */
export function guideText(t: { poolUsd: number; dailyPct: number; maxDdPct: number; plateauRounds: number }): string {
  const month = (1 + t.dailyPct / 100) ** 30;
  const x = month >= 1e6 ? month.toExponential(1) : month >= 10 ? Math.round(month).toLocaleString('en-US') : month.toFixed(2);
  const goal = ((t.dailyPct / 100) * t.poolUsd).toFixed(2);
  return [
    'KALSHI BOT TRAINER: GUIDE',
    '',
    'Getting the bot ready for live trading',
    '  Let the trainer run until it stops by itself (Train.cmd: hours 0). Round 1 runs every step: it downloads',
    '  the history, replays all of it and trains every model once (a day or more on a 16-thread laptop). Every',
    '  later round runs one tournament generation per network on weeks of history that network has never',
    '  trained on. Then a contest on held-out weeks against the network in use, then a retrain of the models',
    '  that read the networks, then the readiness check (several hours a round). Give it at least 3 rounds.',
    '  Round 1 makes the first models; round 2 is the first where challengers must beat them; the scores mean',
    '  something only after that. Every round that makes a model better sends the models to your server, and',
    '  the bot swaps them in within a minute (no restart). A model is promoted only when it beats the one in use.',
    '  Then paper-trade on the server for 2 to 4 weeks. The dashboard\'s paper P&L should look like the',
    '  readiness check (same sign, similar size, drawdown no worse). Only then consider real money, and start',
    '  small.',
    '  After that the server\'s daily training keeps the models current. Run the trainer again every week or two:',
    '  it continues where it stopped, and only weeks no network has trained on count as fresh.',
    '',
    'When it stops by itself',
    `  - target reached: on days nothing was trained or tuned on, the whole bot makes at least ${t.dailyPct}% of`,
    `    $${t.poolUsd} a day ($${goal}). That is the lower end of the 95% interval, so it must hold consistently,`,
    `    not just on average. The drawdown must stay within ${t.maxDdPct}%, over 30 days or more.`,
    `  - ${t.plateauRounds} rounds in a row improve nothing (no challenger beats the model in use, no tournament`,
    '    still running): more rounds on the same history will not make it better.',
    '  - no fresh history is left for the networks and the round improved nothing.',
    '  Ctrl+C stops it after the step in progress; the next run continues from there.',
    '',
    'What good scores look like (after fees, on held-out days; STATUS.txt shows them after every round)',
    '  whole bot     mean daily return above 0 with the whole 95% interval above 0; 0.2% to 1% a day is very',
    '                good (0.5% a day compounds to about 6x in a year); Sharpe 2 or more; max drawdown no more',
    '                than 10-15%; 55% or more winning days; measured over 30+ days. STATUS.txt then shows',
    '                "solid: YES".',
    '  perps model   IC 0.02 to 0.05 or more with its lower bound above 0; net bps per trade above 0 after fees;',
    '                DSR 0.95 or more; the execution backtest passed',
    '  TA network    heads validated on the holdout; network DSR 0.95 or more',
    '  setups        both lanes validated (holdout and final window)',
    '  Kalshi MLP    log loss below the calibrated market\'s, DM p below 0.05',
    '  SNNs          challengers that win their contests on held-out weeks',
    '  Live results are usually worse than any backtest.',
    '',
    'About the target',
    `  ${t.dailyPct}% a day compounds to ${x}x in 30 days.`,
    ...(t.dailyPct >= 3 ? [
      '  No trading system keeps that up: the best funds make 20-40% a year, and a genuinely good bot on a',
      '  small account might make 0.2% to 1% a day. Expect the trainer to stop on "no progress" long before',
      '  it gets there. That stop is still a useful answer: the models are as good as this history can make',
    '  them.',
      '  To stop at a realistic bar instead, set TRAIN_TARGET_DAILY_PCT (for example 0.5) in trainer.env.',
    ] : []),
    '',
    'Settings: trainer-data\\trainer.env (TRAIN_TARGET_DAILY_PCT, TRAIN_TARGET_POOL_USD, TRAIN_TARGET_MAX_DD_PCT,',
    'TRAIN_PLATEAU_ROUNDS). Full documentation: docs/LAPTOP_TRAINING.md in the bot\'s repository.',
    '',
  ].join('\n');
}

/** trainer.env, written on the first run: your own settings for the trainer (no credentials). */
export const TRAINER_ENV_TEMPLATE = [
  '# Trainer settings, one KEY=VALUE per line (lines starting with # are ignored). Credentials and paths',
  '# are ignored here.',
  '#',
  '# Where the trainer stops: the whole bot earning this % of the pool a day on held-out days (the lower end',
  '# of the 95% interval), with at most this drawdown. Default 50% a day = $100 a day on $200.',
  '# TRAIN_TARGET_DAILY_PCT=0.5',
  '# TRAIN_TARGET_POOL_USD=200',
  '# TRAIN_TARGET_MAX_DD_PCT=10',
  '# Rounds in a row without progress before it stops:',
  '# TRAIN_PLATEAU_ROUNDS=3',
  '',
].join('\n');

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const log = (m: string) => console.log(`[trainer ${new Date().toISOString().slice(11, 19)}] ${m}`);

async function ask(rl: readline.Interface, q: string, def?: string): Promise<string> {
  const a = await new Promise<string>((res) => rl.question(def ? `${q} [${def}]: ` : `${q}: `, res));
  return a.trim() || def || '';
}

/** On Windows, OpenSSH refuses a key other users can read: keep a private copy readable by you only. */
function usableKey(key: string, dataDir: string): string {
  if (process.platform !== 'win32') { try { fs.chmodSync(key, 0o600); } catch { /* read-only medium */ } return key; }
  const copy = path.join(dataDir, 'ssh_key.pem');
  fs.copyFileSync(key, copy);
  spawnSync('icacls', [copy, '/inheritance:r', '/grant:r', `${os.userInfo().username}:R`], { stdio: 'ignore' });
  return copy;
}

export class Server {
  constructor(private readonly s: Required<TrainerSettings>) {}
  private base(): string[] { return ['-i', this.s.key, '-p', String(this.s.port), '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', '-o', 'BatchMode=yes', `${this.s.user}@${this.s.host}`]; }
  run(cmd: string): { ok: boolean; out: string; err: string } {
    const r = spawnSync('ssh', [...this.base(), cmd], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '') + (r.error ? String(r.error) : '') };
  }
  /** Stream `files` (relative to remoteDir) into localDir: remote tar | local tar. */
  async pull(remoteDir: string, files: string[], localDir: string): Promise<boolean> {
    fs.mkdirSync(localDir, { recursive: true });
    const ssh = spawn('ssh', [...this.base(), `cd ${remoteDir} && nice -n 19 tar -cf - --no-recursion -T - | nice -n 19 gzip -1`], { stdio: ['pipe', 'pipe', 'inherit'] });
    const tar = spawn('tar', ['-xzf', '-', '-C', localDir], { stdio: ['pipe', 'inherit', 'inherit'] });
    ssh.stdout!.pipe(tar.stdin!);
    ssh.stdin!.end(files.join('\n') + '\n');
    const [a, b] = await Promise.all([exit(ssh), exit(tar)]);
    return a === 0 && b === 0;
  }
  /** Stream local `files` (relative to localDir) into remoteDir, keeping their times (the next pull then
   *  sees them as the same files; the bot reloads a model whenever its file's time changes). */
  async push(localDir: string, files: string[], remoteDir: string): Promise<boolean> {
    const list = path.join(os.tmpdir(), `trainer-push-${process.pid}.txt`);
    fs.writeFileSync(list, files.join('\n') + '\n');
    const tar = spawn('tar', ['-czf', '-', '-C', localDir, '-T', list], { stdio: ['ignore', 'pipe', 'inherit'] });
    const ssh = spawn('ssh', [...this.base(), `mkdir -p ${remoteDir} && cd ${remoteDir} && nice -n 19 tar -xzf - --no-same-owner`], { stdio: ['pipe', 'inherit', 'inherit'] });
    tar.stdout!.pipe(ssh.stdin!);
    const [a, b] = await Promise.all([exit(tar), exit(ssh)]);
    fs.rmSync(list, { force: true });
    return a === 0 && b === 0;
  }
}

const exit = (c: ChildProcess) => new Promise<number>((res) => { c.on('close', (code) => res(code ?? 1)); c.on('error', () => res(1)); });

/** The pipeline's own command: the bundled pipeline.cjs next to this file, or the TS source under tsx. */
function pipelineCmd(): { cmd: string; args: string[] } {
  const entry = process.argv[1] ?? '';
  return entry.endsWith('.cjs') ? { cmd: process.execPath, args: [path.join(path.dirname(entry), 'pipeline.cjs')] } : pipelineCommand(entry);
}

async function runRound(env: NodeJS.ProcessEnv, only: string[] | undefined, logFile: string): Promise<number> {
  const { cmd, args } = pipelineCmd();
  const child = spawn(cmd, [...args, ...(only?.length ? ['--only', only.join(',')] : [])], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = fs.createWriteStream(logFile, { flags: 'a' });
  for (const s of [child.stdout!, child.stderr!]) s.on('data', (b: Buffer) => { process.stdout.write(b); out.write(b); });
  const code = await exit(child);
  out.end();
  return code;
}

/** The newest pipeline report written since `since` (one per round). */
function lastReport(models: string, since = 0): { steps?: ReportStep[] } | undefined {
  try {
    const dir = path.join(models, 'reports');
    const reps = fs.readdirSync(dir).filter((f) => /^pipeline-.*\.json$/.test(f)).sort();
    const f = path.join(dir, reps[reps.length - 1]);
    return fs.statSync(f).mtimeMs >= since ? JSON.parse(fs.readFileSync(f, 'utf8')) : undefined;
  } catch { return undefined; }
}

function reportSummary(r: { steps?: ReportStep[] } | undefined): string[] {
  const gen = (s: ReportStep) => (s.detail?.ga ? ` (genetic generation ${s.detail.ga.generation}${s.detail.ga.sinceOffspringWon ? `, ${s.detail.ga.sinceOffspringWon} since an offspring won` : ''})` : '');
  return (r?.steps ?? []).map((s) => `${s.step}: ${s.skipped ? `skipped (${s.skipped.slice(0, 90)})` : !s.ok ? 'FAILED' : s.detail?.improved ? 'IMPROVED' : s.detail?.promoted ? 'promoted (no better than the model in use)' : 'done'}${gen(s)} ${s.ms ? `${(s.ms / 60000).toFixed(1)} min` : ''}`);
}

/** models/readiness.json when this round's pipeline wrote it. */
function readReadiness(models: string, since: number): ReadinessFile | undefined {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(models, 'readiness.json'), 'utf8')) as ReadinessFile;
    return Date.parse(r.at) >= since - 1000 ? r : undefined;
  } catch { return undefined; }
}

const writeText = (file: string, text: string) => fs.writeFileSync(file, process.platform === 'win32' ? text.replace(/\r?\n/g, '\r\n') : text);

export async function laptopTrainMain(): Promise<void> {
  const t0 = Date.now();
  const hours = Number(argOf('hours') ?? 0);
  if (!(hours >= 0)) throw new Error('--hours must be 0 (train until it stops by itself) or a number of hours');
  const continuous = hours === 0;
  const deadline = continuous ? Infinity : t0 + hours * 3_600_000;
  const dataDir = path.resolve(argOf('data') ?? process.env.DATA_DIR ?? 'trainer-data');
  const models = path.join(dataDir, 'models');
  fs.mkdirSync(path.join(models, 'logs'), { recursive: true });
  const settingsFile = path.join(dataDir, 'trainer.json');
  let s: TrainerSettings = {};
  try { s = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { /* first run */ }
  s = { ...s, host: argOf('host') ?? s.host, user: argOf('user') ?? s.user ?? 'ubuntu', port: Number(argOf('port') ?? s.port ?? 22), key: argOf('key') ?? s.key };
  const wantSync = !(flag('no-pull') && flag('no-push'));
  if (wantSync && (flag('setup') || (!s.host && !fs.existsSync(settingsFile))) && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('\nThe trainer can copy your bot\'s recorded data from the server and send the trained models back (SSH).');
    console.log('Leave the server address empty to train on downloaded history only and keep the models here.\n');
    s.host = (await ask(rl, 'Server address (the Lightsail public IP)', s.host)) || undefined;
    if (s.host) {
      s.user = await ask(rl, 'SSH user', s.user ?? 'ubuntu');
      s.key = await ask(rl, 'Path to the SSH key file (Lightsail: Account > SSH keys > download the .pem)', s.key);
    }
    rl.close();
  }
  fs.writeFileSync(settingsFile, JSON.stringify({ host: s.host ?? null, user: s.user, port: s.port, key: s.key ?? null }, null, 1));
  // Your own trainer settings (the target, the plateau): over the server's and the laptop profile's.
  const userEnvFile = path.join(dataDir, 'trainer.env');
  if (!fs.existsSync(userEnvFile)) writeText(userEnvFile, TRAINER_ENV_TEMPLATE);
  const userEnv = safeServerEnv(fs.readFileSync(userEnvFile, 'utf8').replace(/\r/g, ''));
  console.log(`\nKalshi bot trainer: ${continuous ? 'until it stops by itself' : `${hours} h budget`}, data in ${dataDir}, ${os.cpus().length} CPU threads (tournaments run up to one network per thread at once; the GPU is not used).\n`);

  let server: Server | undefined;
  if (s.host && s.key && wantSync) {
    if (!fs.existsSync(s.key)) throw new Error(`SSH key not found: ${s.key}`);
    server = new Server({ host: s.host, user: s.user ?? 'ubuntu', port: s.port ?? 22, key: usableKey(s.key, dataDir) });
    const ping = server.run('true');
    if (!ping.ok) { log(`cannot reach ${s.host} over SSH (${ping.err.trim().slice(0, 300)}); training on history only, models stay here`); server = undefined; }
  }

  // ---- 1. pull (and the newest recordings again before every later full round) ----
  const pull = async (days: number, recordingsOnly: boolean) => {
    if (!server || flag('no-pull')) return;
    log(recordingsOnly ? `copying the bot's newest recordings (last ${days} days)...` : `copying the bot's data (recordings from the last ${days} days, history, models, state)...`);
    const what = recordingsOnly ? `-path './recordings/md-*' -mtime -${days}` : `\\( ! -path './recordings/md-*' -o -mtime -${days} \\) ! -path './audit*' ! -path './logs/*' ! -name '*.log' ! -path './.venv*'`;
    const m = server.run(`cd ~/bot/data && find . -type f ${what} ! -name '*.tmp' -printf '%P\\t%s\\t%T@\\n'`);
    if (!m.ok) { log(`listing the server's data failed: ${m.err.trim().slice(0, 300)}`); return; }
    const need = filesToPull(parseManifest(m.out), localManifest(dataDir));
    log(`${need.length} new or changed file(s), ${(need.reduce((a, f) => a + f.size, 0) / 1e6).toFixed(0)} MB`);
    for (let i = 0; i < need.length; i += 2000) {
      if (!(await server.pull('~/bot/data', need.slice(i, i + 2000).map((f) => f.path), dataDir))) { log('copy failed part-way; training with what arrived'); break; }
    }
  };
  let serverEnv: Record<string, string> = {};
  if (server && !flag('no-pull')) {
    await pull(Number(argOf('days') ?? 45), false);
    const env = server.run("grep -E '^[A-Z][A-Z0-9_]*=' ~/bot/bot.env");
    if (env.ok) { serverEnv = safeServerEnv(env.out); log(`using ${Object.keys(serverEnv).length} non-secret setting(s) from the server's bot.env`); }
  }

  // ---- 4. push: after every round that made a model better, and at the end ----
  const push = async (why: string) => {
    if (!server || flag('no-push')) return;
    const m = server.run(`mkdir -p ~/bot/data/models && cd ~/bot/data/models && find . -type f -printf '%P\\t%s\\t%T@\\n'`);
    if (!m.ok) { log(`listing the server's models failed: ${m.err.trim().slice(0, 300)}`); return; }
    const send = filesToPush(localManifest(models), parseManifest(m.out));
    if (!send.length) { log('no model newer than the server\'s'); return; }
    log(`${why}: sending ${send.length} file(s), ${(send.reduce((a, f) => a + f.size, 0) / 1e6).toFixed(1)} MB, to the server...`);
    const ok = await server.push(models, send.map((f) => f.path), '~/bot/data/models');
    log(ok ? 'models sent; the bot loads the ones that changed within a minute (no restart)' : 'sending failed; it is tried again after the next round that improves a model, and at the end');
  };

  // The server's settings, then the laptop's bigger budgets over them, then trainer.env, then anything set in
  // the environment.
  const envFor = (leftHours: number): NodeJS.ProcessEnv => ({ ...serverEnv, ...laptopProfile(leftHours, os.cpus().length, continuous), ...userEnv, ...process.env, DATA_DIR: dataDir, AUTO_TRAIN: 'off', TRADING_MODE: 'paper', DASHBOARD_TOKEN: process.env.DASHBOARD_TOKEN ?? 'x'.repeat(32) });
  const A = loadConfig(envFor(continuous ? 24 : hours)).autoTrain;
  const guide = guideText({ poolUsd: A.targetPoolUsd, dailyPct: A.targetDailyPct, maxDdPct: A.targetMaxDdPct, plateauRounds: A.plateauRounds });
  writeText(path.join(dataDir, 'GUIDE.txt'), guide);
  console.log(guide);

  // ---- 2-3. rounds ----
  const only = argOf('only')?.split(',').filter(Boolean);
  let stop = false, why: string | undefined;
  process.on('SIGINT', () => { if (stop) process.exit(130); stop = true; why = 'stopped with Ctrl+C'; log('stopping after the step in progress (Ctrl+C again to quit now)'); });
  const logFile = path.join(models, 'logs', `pipeline-laptop-${new Date(t0).toISOString().replace(/[:.]/g, '-')}.log`);
  let round = 0, lastMs = 0, lastFull = 0, plateau = 0;
  while (!stop) {
    const left = deadline - Date.now();
    if (round > 0 && (left < 15 * 60_000 || left < 0.6 * lastMs)) { why = `the ${hours} h budget is used up`; break; }
    round++;
    // Round 1 and then once a day: every step (new history, the replay extended, new recordings: new weeks).
    const full = !only && (round === 1 || Date.now() - lastFull >= 24 * 3_600_000);
    if (full && round > 1) await pull(2, true);
    if (full) lastFull = Date.now();
    const steps = only ?? (full ? undefined : CONTINUE_STEPS);
    log(`round ${round}: ${steps ? steps.join(', ') : 'every step'} (${continuous ? 'until it stops by itself' : `${(left / 3_600_000).toFixed(1)} h left`})`);
    const r0 = Date.now();
    const code = await runRound(envFor(continuous ? 24 : left / 3_600_000), steps, logFile);
    lastMs = Date.now() - r0;
    process.exitCode = code === 0 ? 0 : 1;
    log(`round ${round} finished in ${(lastMs / 60_000).toFixed(0)} min (exit ${code})`);
    const rep = lastReport(models, r0);
    for (const l of reportSummary(rep)) console.log(`   ${l}`);
    const outcome = roundOutcome(rep?.steps ?? []);
    const readiness = readReadiness(models, r0);
    const next = only ? { plateau } : afterRound({ outcome, readiness, plateau, plateauRounds: A.plateauRounds });
    plateau = next.plateau;
    const board = scoreboard({ round, hours: (Date.now() - t0) / 3_600_000, outcome, readiness, plateau, plateauRounds: A.plateauRounds, stop: next.stop });
    console.log('');
    for (const l of board) console.log(`   ${l}`);
    console.log('');
    try {
      writeText(path.join(dataDir, 'STATUS.txt'), [`Kalshi bot trainer, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, '', ...board, '', 'Steps this round:', ...reportSummary(rep).map((l) => `  ${l}`), '', 'What these numbers should look like: GUIDE.txt', ''].join('\n'));
      const w = readiness?.wholeBot;
      fs.appendFileSync(path.join(dataDir, 'rounds.jsonl'), JSON.stringify({ at: new Date().toISOString(), round, full, minutes: Math.round(lastMs / 60_000), ...outcome, met: readiness?.met ?? null, wholeBot: w ? { days: w.days, meanPct: w.meanPct, ciLoPct: w.ciLoPct, maxDdPct: w.maxDdPct, sharpe: w.sharpe, perDayUsd: w.perDayUsd, solid: w.solid } : null, plateau, stop: next.stop ?? null }) + '\n');
    } catch (e) { log(`could not write the status files: ${(e as Error).message}`); }
    if (outcome.improved.length && !only) await push(`round ${round} improved ${outcome.improved.join(', ')}`);
    if (only) break;
    if (next.stop) { why = next.stop; break; }
  }

  await push('end of the run');
  if (!server) log(`models are in ${models}${s.host ? '' : ' (no server set: run with --setup to add one)'}`);
  log(`done in ${((Date.now() - t0) / 3_600_000).toFixed(1)} h${why ? `: ${why}` : ''}`);
}

if (process.argv[1] && /laptopTrain\.(ts|cjs|js)$/.test(process.argv[1])) {
  laptopTrainMain().catch((e) => { console.error(`[trainer] ${(e as Error).message}`); process.exitCode = 1; });
}
