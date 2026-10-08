// The trainer window: `laptopTrain --ui` (what Train.cmd starts) serves research/trainerUiPage.ts on this
// computer only (127.0.0.1) and opens it as an app window (Edge's app mode on Windows, the default browser
// elsewhere). From it you choose how the run trains (continue, or sweep everything again), how long, and your
// server; it shows the downloads and the training as progress bars with time estimates
// (research/trainerProgress.ts), says what the step in progress is doing, and offers new versions of the
// trainer (research/trainerUpdate.ts), installing one only when you say yes.
//
// Only this computer can reach it, and only through the window it opened: every request carries a random token
// made at start (and the Host header must be the loopback address), so a web page elsewhere cannot drive it.

import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { readSettings, runTrainer, writeSettings, type TrainerSettings } from './laptopTrain';
import { readRounds, RoundProgress, type ProgressView } from './trainerProgress';
import { checkForUpdate, currentVersion, downloadAndStage, RELEASE_PAGE, runApplyScript, type UpdateInfo } from './trainerUpdate';
import { TRAINER_PAGE } from './trainerUiPage';
import path from 'path';

export interface UiState {
  phase: 'idle' | 'running' | 'stopping';
  mode: 'continue' | 'full'; hours: number; round: number;
  progress: ProgressView | null; board: string[];
  lastStop: string | null; lastError: string | null;
  settings: TrainerSettings; version: string | null;
  update: (UpdateInfo & { dismissed?: boolean; installing?: string; page: string }) | null;
}

export class TrainerUi {
  readonly token = crypto.randomBytes(24).toString('hex');
  state: UiState;
  private tracker: RoundProgress | null = null;
  private child: ChildProcess | undefined;
  private stopFlag = false;
  private server?: http.Server;

  constructor(private readonly o: { dataDir: string; check?: () => Promise<UpdateInfo>; install?: (u: UpdateInfo) => Promise<void>; run?: typeof runTrainer }) {
    this.state = { phase: 'idle', mode: 'continue', hours: 0, round: 0, progress: null, board: [], lastStop: null, lastError: null, settings: readSettings(o.dataDir), version: currentVersion(), update: null };
  }

  /** Start a run (the window's Start button). */
  start(req: { mode?: string; hours?: number; host?: string; user?: string; key?: string }): { ok: boolean; error?: string } {
    if (this.state.phase !== 'idle') return { ok: false, error: 'already training' };
    const hours = Number(req.hours ?? 0);
    if (!(hours >= 0) || hours > 24 * 365) return { ok: false, error: 'hours must be 0 (until it stops by itself) or a number of hours' };
    const settings: TrainerSettings = { ...this.state.settings, host: req.host?.trim() || undefined, user: req.user?.trim() || 'ubuntu', key: req.key?.trim() || undefined };
    if (settings.host && !settings.key) return { ok: false, error: 'a server needs its SSH key file' };
    writeSettings(this.o.dataDir, settings);
    Object.assign(this.state, { phase: 'running', mode: req.mode === 'full' ? 'full' : 'continue', hours, round: 0, settings, lastStop: null, lastError: null, board: [] });
    this.stopFlag = false;
    const models = path.join(this.o.dataDir, 'models');
    const run = this.o.run ?? runTrainer;
    void run({
      hours, dataDir: this.o.dataDir, settings, sweepAll: this.state.mode === 'full',
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
      .finally(() => { this.state.phase = 'idle'; this.child = undefined; });
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

  snapshot(): UiState {
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
