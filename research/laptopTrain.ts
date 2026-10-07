// Laptop trainer: the full training pipeline (research/pipeline.ts) on your own computer, for as many
// hours as you give it, with no time cap and bigger budgets than the server or the daily remote job can
// afford. Nothing here trains a model itself: every module is trained, judged and promoted (champion vs
// challenger) by the pipeline's own steps, in the pipeline's order.
//
//   1. pull     (optional, SSH) the bot's data from the server, like the remote-training workflow: the
//               last N days of recordings, the candle history, the models directory (pipeline state,
//               tournaments in progress) and the rest of ~/bot/data; plus bot.env WITHOUT credentials
//   2. history  every crypto asset's spot history from Binance Vision and Coinbase (years of candles) and
//               a year of Kalshi's settled contracts
//   3. rounds   round 1 runs every step; later rounds continue the tournaments (TA network, SNNs, setups,
//               sweeps) and retrain their consumers while time remains. Each module is promoted only when
//               it beats the one in use (AUTO_TRAIN_CHAMPION); the sweep ends each round on the whole bot.
//   4. push     (optional, SSH) the models directory back to the server, newer files only; the running
//               bot hot-swaps every model that changed (no restart)
//
//   Windows:  double-click Train.cmd (the release zip ships Node and the bundled trainer)
//   anywhere: node --import tsx research/laptopTrain.ts --hours 12 [--host 1.2.3.4 --key C:\keys\lightsail.pem]
//
//   --hours N      training budget (default 12); the last round is not started if it would overrun much
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

export interface TrainerSettings { host?: string; user?: string; port?: number; key?: string }
export interface RemoteFile { path: string; size: number; mtime: number }

/** Steps that continue a tournament or depend on one: what rounds after the first repeat. */
export const CONTINUE_STEPS = ['ta_net', 'ta_net_oos', 'rule_book', 'setups', 'sweep', 'snn', 'vol_model', 'dataset', 'mlp', 'perps'];

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

/** Server files to copy down: missing here, or a different size / time (2 s slack for file systems). */
export function filesToPull(remote: RemoteFile[], local: Map<string, RemoteFile>): RemoteFile[] {
  return remote.filter((f) => { const l = local.get(f.path); return !l || l.size !== f.size || Math.abs(l.mtime - f.mtime) > 2000; });
}

/** Local model files to send up: newer than the server's copy (never overwrite a newer server file). */
export function filesToPush(local: Map<string, RemoteFile>, remote: RemoteFile[]): RemoteFile[] {
  const r = new Map(remote.map((f) => [f.path, f]));
  return [...local.values()].filter((f) => { const s = r.get(f.path); return !s || f.mtime > s.mtime + 2000; })
    .filter((f) => !/\.tmp$/.test(f.path) && !f.path.startsWith('work/snnfill/'));
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
 *  environment, then the server's bot.env) wins over these. */
export function laptopProfile(remainingHours: number): Record<string, string> {
  const h = (x: number) => String(+Math.max(0.1, x).toFixed(2));
  return {
    TRADING_MODE: 'paper', AUTO_TRAIN: 'off', AUTO_TRAIN_CHAMPION: 'true',
    HISTORY_AUTO_UPDATE: 'true', TV_FILL: 'false',
    KALSHI_HISTORY_BUDGET_MIN: '600', KALSHI_HISTORY_DAYS: '365',
    // TA network: retrain every round, more tournament rounds per run, every hourly sample, two years of training data.
    TA_NET_RETRAIN_DAYS: '0', TA_NET_MAX_ROUNDS_PER_RUN: '400', TA_NET_STRIDE: '1', TA_NET_TRAIN_MONTHS: '24',
    TA_NET_OOS_HOURS: h(Math.min(12, remainingHours / 4)),
    SWEEP_HOURS: h(Math.min(12, remainingHours / 4)), SWEEP_EVERY_DAYS: '1',
    AUTO_TRAIN_SNN_PBT_EVERY_DAYS: '0', AUTO_TRAIN_SNN_TRAIN_DAYS: '45', AUTO_TRAIN_SNN_PBT_DAYS: '14',
  };
}

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
  /** Stream local `files` (relative to localDir) into remoteDir. */
  async push(localDir: string, files: string[], remoteDir: string): Promise<boolean> {
    const list = path.join(os.tmpdir(), `trainer-push-${process.pid}.txt`);
    fs.writeFileSync(list, files.join('\n') + '\n');
    const tar = spawn('tar', ['-czf', '-', '-C', localDir, '-T', list], { stdio: ['ignore', 'pipe', 'inherit'] });
    const ssh = spawn('ssh', [...this.base(), `mkdir -p ${remoteDir} && cd ${remoteDir} && nice -n 19 tar -xzf - -m --no-same-owner`], { stdio: ['pipe', 'inherit', 'inherit'] });
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

function lastReportSummary(models: string): string[] {
  try {
    const reps = fs.readdirSync(path.join(models, 'reports')).filter((f) => /^pipeline-.*\.json$/.test(f)).sort();
    const r = JSON.parse(fs.readFileSync(path.join(models, 'reports', reps[reps.length - 1]), 'utf8'));
    return (r.steps ?? []).map((s: { step: string; ok: boolean; skipped?: string; ms: number; detail?: { promoted?: boolean } }) =>
      `${s.step}: ${s.skipped ? `skipped (${s.skipped.slice(0, 90)})` : !s.ok ? 'FAILED' : s.detail?.promoted ? 'PROMOTED' : 'done'} ${s.ms ? `${(s.ms / 60000).toFixed(1)} min` : ''}`);
  } catch { return []; }
}

export async function laptopTrainMain(): Promise<void> {
  const t0 = Date.now();
  const hours = Number(argOf('hours') ?? 12);
  if (!(hours > 0)) throw new Error('--hours must be a positive number');
  const deadline = t0 + hours * 3_600_000;
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
  console.log(`\nKalshi bot trainer: ${hours} h budget, data in ${dataDir}, ${os.cpus().length} CPU threads (one per running step; the GPU is not used).\n`);

  let server: Server | undefined;
  if (s.host && s.key && wantSync) {
    if (!fs.existsSync(s.key)) throw new Error(`SSH key not found: ${s.key}`);
    server = new Server({ host: s.host, user: s.user ?? 'ubuntu', port: s.port ?? 22, key: usableKey(s.key, dataDir) });
    const ping = server.run('true');
    if (!ping.ok) { log(`cannot reach ${s.host} over SSH (${ping.err.trim().slice(0, 300)}); training on history only, models stay here`); server = undefined; }
  }

  // ---- 1. pull ----
  let serverEnv: Record<string, string> = {};
  if (server && !flag('no-pull')) {
    const days = Number(argOf('days') ?? 45);
    log(`copying the bot's data (recordings from the last ${days} days, history, models, state)...`);
    const m = server.run(`cd ~/bot/data && find . -type f \\( ! -path './recordings/md-*' -o -mtime -${days} \\) ! -path './audit*' ! -path './logs/*' ! -name '*.log' ! -path './.venv*' ! -name '*.tmp' -printf '%P\\t%s\\t%T@\\n'`);
    if (!m.ok) log(`listing the server's data failed: ${m.err.trim().slice(0, 300)}`);
    else {
      const need = filesToPull(parseManifest(m.out), localManifest(dataDir));
      const mb = need.reduce((a, f) => a + f.size, 0) / 1e6;
      log(`${need.length} new or changed file(s), ${mb.toFixed(0)} MB`);
      for (let i = 0; i < need.length; i += 2000) {
        if (!(await server.pull('~/bot/data', need.slice(i, i + 2000).map((f) => f.path), dataDir))) { log('copy failed part-way; training with what arrived'); break; }
      }
    }
    const env = server.run("grep -E '^[A-Z][A-Z0-9_]*=' ~/bot/bot.env");
    if (env.ok) { serverEnv = safeServerEnv(env.out); log(`using ${Object.keys(serverEnv).length} non-secret setting(s) from the server's bot.env`); }
  }

  // ---- 2-3. rounds ----
  const only = argOf('only')?.split(',').filter(Boolean);
  let stop = false;
  process.on('SIGINT', () => { if (stop) process.exit(130); stop = true; log('stopping after the step in progress (Ctrl+C again to quit now)'); });
  let round = 0, lastMs = 0;
  while (!stop) {
    const left = deadline - Date.now();
    if (round > 0 && (left < 15 * 60_000 || left < 0.6 * lastMs)) break;
    round++;
    // The server's settings, then the laptop's bigger budgets over them, then anything you set yourself.
    const env: NodeJS.ProcessEnv = { ...serverEnv, ...laptopProfile(left / 3_600_000), ...process.env, DATA_DIR: dataDir, AUTO_TRAIN: 'off', TRADING_MODE: 'paper', DASHBOARD_TOKEN: process.env.DASHBOARD_TOKEN ?? 'x'.repeat(32) };
    const steps = only ?? (round === 1 ? undefined : CONTINUE_STEPS);
    log(`round ${round}: ${steps ? steps.join(', ') : 'every step'} (${(left / 3_600_000).toFixed(1)} h left)`);
    const r0 = Date.now();
    const code = await runRound(env, steps, path.join(models, 'logs', `pipeline-laptop-${new Date(t0).toISOString().replace(/[:.]/g, '-')}.log`));
    lastMs = Date.now() - r0;
    process.exitCode = code === 0 ? 0 : 1;
    log(`round ${round} finished in ${(lastMs / 60_000).toFixed(0)} min (exit ${code})`);
    for (const l of lastReportSummary(models)) console.log(`   ${l}`);
    if (only) break;
  }

  // ---- 4. push ----
  if (server && !flag('no-push')) {
    const m = server.run(`mkdir -p ~/bot/data/models && cd ~/bot/data/models && find . -type f -printf '%P\\t%s\\t%T@\\n'`);
    const send = m.ok ? filesToPush(localManifest(models), parseManifest(m.out)) : [];
    if (!m.ok) log(`listing the server's models failed: ${m.err.trim().slice(0, 300)}`);
    else if (!send.length) log('no model newer than the server\'s');
    else {
      log(`sending ${send.length} file(s), ${(send.reduce((a, f) => a + f.size, 0) / 1e6).toFixed(1)} MB, to the server...`);
      const ok = await server.push(models, send.map((f) => f.path), '~/bot/data/models');
      log(ok ? 'models sent; the bot loads the ones that changed within a minute (no restart)' : 'sending failed; run again with --no-pull to retry');
    }
  } else log(`models are in ${models}${s.host ? '' : ' (no server set: run with --setup to add one)'}`);
  log(`done in ${((Date.now() - t0) / 3_600_000).toFixed(1)} h`);
}

if (process.argv[1] && /laptopTrain\.(ts|cjs|js)$/.test(process.argv[1])) {
  laptopTrainMain().catch((e) => { console.error(`[trainer] ${(e as Error).message}`); process.exitCode = 1; });
}
