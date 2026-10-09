// The trainer window: `laptopTrain --ui` (what Train.cmd starts) serves research/trainerUiPage.ts on this
// computer only (127.0.0.1) and opens it as an app window (Edge's app mode on Windows, the default browser
// elsewhere). From it you choose how the run trains (continue, or sweep everything again), how long, and your
// server; it shows the downloads and the training as progress bars with time estimates
// (research/trainerProgress.ts), says what the step in progress is doing, and offers new versions of the
// trainer (research/trainerUpdate.ts), installing one only when you say yes. Below, a leaderboard of every
// tournament's champion on its bracket (research/trainerLeaderboard.ts).
//
// Only this computer can reach it, and only through the window it opened: every request carries a random token
// made at start (and the Host header must be the loopback address), so a web page elsewhere cannot drive it.

import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import { readSettings, runTrainer, writeSettings, type TrainerSettings } from './laptopTrain';
import { readRounds, RoundProgress, type ProgressView } from './trainerProgress';
import { checkForUpdate, currentVersion, downloadAndStage, RELEASE_PAGE, runApplyScript, type UpdateInfo } from './trainerUpdate';
import { TRAINER_PAGE } from './trainerUiPage';
import { leaderboard, type Bracket } from './trainerLeaderboard';
import path from 'path';

export interface UiState {
  phase: 'idle' | 'running' | 'stopping';
  mode: 'continue' | 'full' | 'conditioning'; hours: number; round: number;
  /** Conditioning mode: whether it may start (a normal training run finished since the last conditioning run), and
   *  the last result. */
  conditioning: ConditioningView;
  progress: ProgressView | null; board: string[];
  lastStop: string | null; lastError: string | null;
  settings: TrainerSettings; version: string | null;
  update: (UpdateInfo & { dismissed?: boolean; installing?: string; page: string }) | null;
}

export interface ConditioningView { ready: boolean; why: string; last: { at: string; elite: string | null; best: string | null; bestPassed: number; windows: number } | null }

const readJsonFile = (f: string): any => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };

/** Conditioning may start once a normal run (continue or sweep everything) has finished since the last conditioning
 *  run: it pressure-tests the freshly trained bot. */
let viewCache: { key: string; v: ConditioningView } | undefined;
export function conditioningView(models: string): ConditioningView {
  const mt = (f: string) => { try { return fs.statSync(path.join(models, f)).mtimeMs; } catch { return 0; } };
  const key = `${models}|${mt('pipeline_state.json')}|${mt('conditioning_report.json')}`;
  if (viewCache?.key === key) return viewCache.v;
  const v = conditioningViewNow(models);
  viewCache = { key, v };
  return v;
}

function conditioningViewNow(models: string): ConditioningView {
  const state = readJsonFile(path.join(models, 'pipeline_state.json'));
  const rep = readJsonFile(path.join(models, 'conditioning_report.json'));
  const lastRun = Number(state?.lastRun) || 0;
  const lastCond = rep?.at ? Date.parse(rep.at) : 0;
  const last = rep ? { at: rep.at, elite: rep.elite?.id ?? null, best: rep.best?.id ?? null, bestPassed: rep.best?.passed ?? 0, windows: rep.trials?.[0]?.stages?.length ?? 0 } : null;
  if (!lastRun) return { ready: false, why: 'train the bot the normal way first (Start): conditioning tests a freshly trained bot', last };
  if (lastCond && lastCond >= lastRun) return { ready: false, why: 'conditioned since the last training: train again the normal way first', last };
  return { ready: true, why: `ready: trained ${new Date(lastRun).toISOString().slice(0, 16).replace('T', ' ')} UTC`, last };
}

export class TrainerUi {
  readonly token = crypto.randomBytes(24).toString('hex');
  state: UiState;
  private tracker: RoundProgress | null = null;
  private child: ChildProcess | undefined;
  private stopFlag = false;
  private server?: http.Server;
  private board?: { at: number; brackets: Bracket[] };

  constructor(private readonly o: { dataDir: string; check?: () => Promise<UpdateInfo>; install?: (u: UpdateInfo) => Promise<void>; run?: typeof runTrainer }) {
    this.state = { phase: 'idle', mode: 'continue', hours: 0, round: 0, progress: null, board: [], lastStop: null, lastError: null, settings: readSettings(o.dataDir), version: currentVersion(), update: null, conditioning: conditioningView(path.join(o.dataDir, 'models')) };
  }

  /** Start a run (the window's Start button). */
  start(req: { mode?: string; hours?: number; host?: string; user?: string; key?: string }): { ok: boolean; error?: string } {
    if (this.state.phase !== 'idle') return { ok: false, error: 'already training' };
    const hours = Number(req.hours ?? 0);
    if (!(hours >= 0) || hours > 24 * 365) return { ok: false, error: 'hours must be 0 (until it stops by itself) or a number of hours' };
    const settings: TrainerSettings = { ...this.state.settings, host: req.host?.trim() || undefined, user: req.user?.trim() || 'ubuntu', key: req.key?.trim() || undefined };
    if (settings.host && !settings.key) return { ok: false, error: 'a server needs its SSH key file' };
    const conditioning = req.mode === 'conditioning';
    if (conditioning) {
      const c = conditioningView(path.join(this.o.dataDir, 'models'));
      if (!c.ready) return { ok: false, error: c.why };
    }
    writeSettings(this.o.dataDir, settings);
    Object.assign(this.state, { phase: 'running', mode: conditioning ? 'conditioning' : req.mode === 'full' ? 'full' : 'continue', hours, round: 0, settings, lastStop: null, lastError: null, board: [] });
    this.stopFlag = false;
    const models = path.join(this.o.dataDir, 'models');
    const run = this.o.run ?? runTrainer;
    void run({
      hours, dataDir: this.o.dataDir, settings, sweepAll: this.state.mode === 'full', only: conditioning ? ['conditioning'] : undefined,
      hooks: {
        roundStart: (round, full) => { this.state.round = round; this.tracker = new RoundProgress(readRounds(models), full); },
        phase: (p) => { this.tracker ??= new RoundProgress(readRounds(models), true); this.tracker.setPhase(p); },
        line: (l) => this.tracker?.line(l),
        roundEnd: (board) => { this.state.board = board; },
        child: (c) => { this.child = c; },
        stopRequested: () => this.stopFlag,
      },
    }).then((r) => { this.state.lastStop = this.stopFlag ? 'stopped by you' : r.why ?? 'finished'; })
      .catch((e) => { this.state.lastError = (e as Error).message; this.state.lastStop = `error: ${(e as Error).message}`; })
      .finally(() => { this.state.phase = 'idle'; this.child = undefined; this.board = undefined; this.state.conditioning = conditioningView(models); });
    return { ok: true };
  }

  /** Stop now: the pipeline in progress is ended (finished steps and tournament rounds are kept). */
  stop(): { ok: boolean } {
    if (this.state.phase !== 'running') return { ok: false };
    this.stopFlag = true;
    this.state.phase = 'stopping';
    this.child?.kill();
    return { ok: true };
  }

  /** The champions brackets (the tournament files can be large: read at most every 30 s). */
  leaderboard(now = Date.now()): Bracket[] {
    if (!this.board || now - this.board.at > 30_000 || now < this.board.at) {
      let brackets: Bracket[] = [];
      try { brackets = leaderboard(path.join(this.o.dataDir, 'models')); } catch { /* unreadable: none */ }
      this.board = { at: now, brackets };
    }
    return this.board.brackets;
  }

  snapshot(): UiState {
    if (this.state.phase === 'idle') this.state.conditioning = conditioningView(path.join(this.o.dataDir, 'models'));
    return { ...this.state, progress: this.state.phase === 'idle' ? null : this.tracker?.view() ?? null };
  }

  async checkUpdate(): Promise<void> {
    const u = await (this.o.check ?? (() => checkForUpdate()))();
    const prev = this.state.update;
    this.state.update = { ...u, page: RELEASE_PAGE, dismissed: prev?.dismissed && prev.latest === u.latest ? true : undefined };
  }

  /** You said yes: stop training if it runs, download, then hand over to the install script and exit. */
  async installUpdate(): Promise<{ ok: boolean; error?: string }> {
    const u = this.state.update;
    if (!u?.available || !u.canInstall) return { ok: false, error: 'no update to install here' };
    if (u.installing) return { ok: true };
    u.installing = 'downloading...';
    if (this.state.phase === 'running') this.stop();
    try {
      if (this.o.install) await this.o.install(u);
      else {
        const script = await downloadAndStage(u, { onProgress: (d, t) => { u.installing = `downloading ${t ? `${Math.round((100 * d) / t)}%` : `${(d / 1e6).toFixed(0)} MB`}...`; } });
        for (let i = 0; i < 600 && this.state.phase !== 'idle'; i++) await new Promise((r) => setTimeout(r, 100));
        u.installing = 'installing: the trainer restarts in a moment';
        runApplyScript(script);
        setTimeout(() => process.exit(3), 1500);
      }
      return { ok: true };
    } catch (e) { u.installing = undefined; return { ok: false, error: (e as Error).message }; }
  }

  /** The HTTP handler (exported for tests). */
  handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const send = (code: number, body: unknown, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' }); res.end(type === 'application/json' ? JSON.stringify(body) : String(body)); };
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
    if (host !== '127.0.0.1' && host !== 'localhost') return send(403, { error: 'host' });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/') return url.searchParams.get('t') === this.token ? send(200, TRAINER_PAGE, 'text/html; charset=utf-8') : send(403, 'Open the trainer from its own window (Train.cmd).', 'text/plain');
    if (req.headers['x-trainer-token'] !== this.token) return send(403, { error: 'token' });
    if (req.method === 'GET' && url.pathname === '/api/state') return send(200, this.snapshot());
    if (req.method === 'GET' && url.pathname === '/api/leaderboard') return send(200, this.leaderboard());
    if (req.method !== 'POST') return send(404, { error: 'not found' });
    let body: Record<string, unknown> = {};
    try { const raw = await new Promise<string>((r, j) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 65_536) j(new Error('too large')); }); req.on('end', () => r(b)); req.on('error', j); }); body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { error: 'bad request' }); }
    switch (url.pathname) {
      case '/api/start': return send(200, this.start(body as Parameters<TrainerUi['start']>[0]));
      case '/api/stop': return send(200, this.stop());
      case '/api/update/check': await this.checkUpdate(); return send(200, { ok: true });
      case '/api/update/later': if (this.state.update) this.state.update.dismissed = true; return send(200, { ok: true });
      case '/api/update/install': return send(200, await this.installUpdate());
      default: return send(404, { error: 'not found' });
    }
  };

  listen(port = 0): Promise<string> {
    this.server = http.createServer((q, r) => { void this.handle(q, r).catch(() => { try { r.writeHead(500); r.end(); } catch { /* closed */ } }); });
    return new Promise((resolve) => this.server!.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${(this.server!.address() as AddressInfo).port}/?t=${this.token}`)));
  }

  close(): void { this.server?.close(); }
}

/** Open the window: Edge's app mode on Windows (no address bar), the default browser elsewhere. */
export function openWindow(url: string): void {
  try {
    if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '""', 'msedge', `--app=${url}`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* the address is printed in the console */ }
}

export async function startTrainerUi(o: { dataDir: string; port?: number; open?: boolean }): Promise<TrainerUi> {
  const ui = new TrainerUi({ dataDir: o.dataDir });
  const url = await ui.listen(o.port ?? 0);
  console.log(`\nKalshi bot trainer: the window is at ${url}\nKeep this console open while it trains; closing it stops the trainer (finished steps are kept).\n`);
  if (o.open !== false) openWindow(url);
  void ui.checkUpdate();
  setInterval(() => void ui.checkUpdate(), 6 * 3_600_000).unref();
  return ui;
}
