// In-bot automation: runs the training pipeline (research/pipeline.ts) on a schedule in a child
// process at low CPU priority, and hot-swaps whatever it promotes (meta-model, SNN, perp model,
// volatility profile, tennis model) into the running engine without a restart. The MLP, perps and
// tennis models read the SNN's outputs, so a new SNN automatically re-runs their training.

import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AuditLog } from './audit/auditLog';
import type { Alerter } from './alerts/alerter';
import type { Config } from './config';
import type { Engine } from './engine';
import { MetaModel } from './model/metaModel';
import { loadVolProfile } from './model/volSeasonality';
import { PerpModel } from './perps/perpSignal';
import type { PerpTrader } from './perps/perpTrader';
import { createSnnUnit } from './snn';
import type { SnnDomain } from './snn/params';
import { VolModel } from './model/volModel';
import { FillModel } from './tca/fillModel';
import { TennisFairModel } from './tennis/tennisFair';
import { activeTaNet, setTaNet, TaNet, taNetFileSchema, TANET_SCHEMA } from './ta/taNet';
import { logger } from './util/log';

const log = logger('autotrain');

export const MODEL_FILES = { mlp: 'model.json', perp: 'perp_model.json', snn_crypto: 'snn_crypto.json', snn_perps: 'snn_perps.json', snn_tennis: 'snn_tennis.json', vol: 'vol_profile.json', vol_model: 'vol_model.json', tennis: 'tennis_model.json', fill: 'fill_model.json', ta_net: 'ta_net.json' } as const;
type Kind = keyof typeof MODEL_FILES;

/** The file the bot should load for each model: the pipeline's promoted copy in AUTO_TRAIN_DIR
 *  when it exists, else the configured params/ path. A promoted TA network with an older input schema
 *  (written before an update changed the network) is skipped for the shipped one until the pipeline
 *  has retrained it. */
export function resolveModelPaths(cfg: Readonly<Config>): Record<Kind, string> {
  const pick = (k: Kind, fallback: string) => {
    const p = path.join(cfg.autoTrain.dir, MODEL_FILES[k]);
    if (!fs.existsSync(p)) return fallback;
    return k === 'ta_net' && taNetFileSchema(p) !== TANET_SCHEMA && fs.existsSync(fallback) ? fallback : p;
  };
  return {
    mlp: pick('mlp', cfg.paramsPath), perp: pick('perp', cfg.perps.modelPath),
    snn_crypto: pick('snn_crypto', cfg.snn.domains.crypto.modelPath), snn_perps: pick('snn_perps', cfg.snn.domains.perps.modelPath), snn_tennis: pick('snn_tennis', cfg.snn.domains.tennis.modelPath),
    vol: pick('vol', cfg.strategy.volProfilePath), vol_model: pick('vol_model', cfg.strategy.volModelPath), tennis: pick('tennis', cfg.tennis.modelPath), fill: pick('fill', cfg.strategy.fillModelPath), ta_net: pick('ta_net', cfg.taNet.modelPath),
  };
}

/** How to launch the pipeline: the bundled dist/pipeline.cjs in production, the TS source under tsx in development. */
export function pipelineCommand(entry = process.argv[1] ?? ''): { cmd: string; args: string[] } {
  if (entry.endsWith('.cjs')) return { cmd: process.execPath, args: [path.join(path.dirname(entry), 'pipeline.cjs')] };
  return { cmd: process.execPath, args: ['--import', 'tsx', path.resolve('research/pipeline.ts')] };
}

export interface AutoTrainStatus {
  mode: string; running: boolean; lastStart: number | null; lastExit: { code: number | null; ts: number; args: string[] } | null;
  nextRun: number | null; logFile: string | null; models: Record<string, { path: string; mtime: number | null; id?: string }>;
  swaps: { kind: string; ts: number; detail: string }[]; state: unknown;
}

export class AutoTrainer {
  private child?: ChildProcess;
  private timer?: NodeJS.Timeout;
  private lastStart = 0;
  private lastExit: AutoTrainStatus['lastExit'] = null;
  private logFile: string | null = null;
  private readonly mtimes = new Map<string, number | null>();
  private readonly swaps: AutoTrainStatus['swaps'] = [];
  private readonly retrainFor = new Set<string>();
  private queued?: string[];

  constructor(private readonly d: {
    cfg: Readonly<Config>; engine: Engine; audit: AuditLog; alerter: Alerter; perpTrader?: PerpTrader;
    now?: () => number; command?: { cmd: string; args: string[] };
  }) {}

  private get now() { return (this.d.now ?? Date.now)(); }

  start(): void {
    // Remember what is loaded now so only later changes trigger a swap.
    for (const p of Object.values(resolveModelPaths(this.d.cfg))) this.mtimes.set(p, mtime(p));
    for (const k of Object.keys(MODEL_FILES) as Kind[]) { const p = path.join(this.d.cfg.autoTrain.dir, MODEL_FILES[k]); this.mtimes.set(p, mtime(p)); }
    this.timer = setInterval(() => void this.tick(), this.d.cfg.autoTrain.watchSec * 1000);
    this.timer.unref();
    log.info('auto-train started', { mode: this.d.cfg.autoTrain.mode, hourUtc: this.d.cfg.autoTrain.hourUtc, dir: this.d.cfg.autoTrain.dir });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.child?.kill('SIGTERM');
  }

  /** Next scheduled run (daily at hourUtc), or null when off. */
  nextRun(now = this.now): number | null {
    if (this.d.cfg.autoTrain.mode !== 'daily') return null;
    const d = new Date(now);
    let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), this.d.cfg.autoTrain.hourUtc);
    const last = this.state().lastRun ?? 0;
    if (t <= now && last >= t) t += 86_400_000;
    return t;
  }

  state(): { lastRun?: number; mlpId?: string; snnVersions?: Partial<Record<SnnDomain, string>>; trainedWithSnn?: Partial<Record<SnnDomain, string>>; taNetVersion?: string; trainedWithTaNet?: string; lastReport?: string } {
    try { return JSON.parse(fs.readFileSync(path.join(this.d.cfg.autoTrain.dir, 'pipeline_state.json'), 'utf8')); } catch { return {}; }
  }

  async tick(): Promise<void> {
    await this.watch();
    const next = this.nextRun();
    if (next !== null && this.now >= next && !this.child && this.now - this.lastStart > 3_600_000) this.run([]);
  }

  /** Launch the pipeline (args e.g. ['--only', 'snn']). Queued if one is already running. */
  run(args: string[]): boolean {
    if (this.child) { this.queued = args; return false; }
    const { cmd, args: base } = this.d.command ?? pipelineCommand();
    const logs = path.join(this.d.cfg.autoTrain.dir, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    this.logFile = path.join(logs, `pipeline-${new Date(this.now).toISOString().replace(/[:.]/g, '-')}.log`);
    const out = fs.openSync(this.logFile, 'a');
    this.lastStart = this.now;
    const child = spawn(cmd, [...base, ...args], { cwd: process.cwd(), env: process.env, stdio: ['ignore', out, out] });
    this.child = child;
    // Training must never starve the trading loop: lowest CPU priority.
    try { if (child.pid) os.setPriority(child.pid, 19); } catch { /* not permitted: run at normal priority */ }
    this.d.audit.write('config', { event: 'pipeline_start', args, log: this.logFile });
    log.info('pipeline started', { args, log: this.logFile });
    child.on('exit', (code) => {
      fs.closeSync(out);
      this.child = undefined;
      this.lastExit = { code, ts: this.now, args };
      this.d.audit.write('config', { event: 'pipeline_exit', code, args, report: this.state().lastReport ?? null });
      if (code !== 0) this.d.alerter.notify('warn', 'pipeline', `Training pipeline exited with code ${code}; see ${this.logFile}`);
      void this.watch();
      if (this.queued) { const q = this.queued; this.queued = undefined; this.run(q); }
    });
    return true;
  }

  /** Poll the model files; hot-swap whatever changed. */
  async watch(): Promise<void> {
    const paths = resolveModelPaths(this.d.cfg);
    for (const k of ['ta_net', 'snn_crypto', 'snn_perps', 'snn_tennis', 'vol_model', 'mlp', 'vol', 'perp', 'tennis', 'fill'] as Kind[]) {
      const p = paths[k], m = mtime(p);
      if (m === null || this.mtimes.get(p) === m) continue;
      // Do not load a file the pipeline is still writing (promotion is a copy; wait one poll).
      if (this.now - m < 2_000) continue;
      this.mtimes.set(p, m);
      try { await this.swap(k, p); } catch (e) { log.error('hot swap failed', { kind: k, path: p, error: String(e) }); this.d.audit.write('error', { where: 'hot_swap', kind: k, path: p, error: String(e) }); }
    }
  }

  private record(kind: string, detail: string): void {
    this.swaps.unshift({ kind, ts: this.now, detail });
    this.swaps.length = Math.min(this.swaps.length, 20);
  }

  private async swap(kind: Kind, file: string): Promise<void> {
    const { engine, cfg } = this.d;
    if (kind === 'mlp') {
      const m = MetaModel.load(file);
      if (m.id === engine.model.id) return;
      engine.setModel(m);
      this.record('mlp', `${m.id} (${m.params.kind}${m.params.features.some((f) => f.startsWith('snn_')) ? ', reads SNN' : ''}${m.params.take?.validation.validated ? ', take gate on' : ''})`);
    } else if (kind === 'vol') {
      const vp = loadVolProfile(file);
      const apply = vp && cfg.strategy.volSeasonality && vp.validation?.improved ? vp : undefined;
      engine.setVolProfile(apply);
      this.record('vol', apply ? `applied ${vp!.version}` : 'loaded, not applied (validation did not improve or VOL_SEASONALITY off)');
    } else if (kind === 'perp') {
      const m = PerpModel.load(file);
      if (!m || !this.d.perpTrader) return;
      this.d.perpTrader.setModel(m);
      this.record('perp', `${m.params.version} (validated=${m.validated()})`);
    } else if (kind === 'tennis') {
      const m = TennisFairModel.load(file);
      engine.setTennisFair(m);
      this.record('tennis', m ? `${m.params.version} (validated=${m.validated}, ${m.params.validation.matches} matches)` : 'removed');
    } else if (kind === 'vol_model') {
      const m = VolModel.load(file);
      engine.setVolModel(m && cfg.strategy.volModel ? m : undefined);
      this.record('vol_model', m ? `${m.params.version} (validated=${m.validated})` : 'removed');
    } else if (kind === 'fill') {
      const m = FillModel.load(file);
      engine.setFillModel(m);
      this.record('fill', m ? `${m.params.version} (validated=${m.validated}, ${m.params.validation.quotes} quotes)` : 'removed');
    } else if (kind === 'ta_net') {
      if (!cfg.taNet.enabled) return;
      const n = TaNet.load(file);
      setTaNet(n, cfg.taNet.requireValidated);
      if (n) activeTaNet()?.enableForwardTest(path.join(cfg.dataDir, 'ta_net_forward.json'), this.now, { days: cfg.taNet.forwardDays, muteOnFail: cfg.taNet.muteOnForwardFail });
      const v = n?.version;
      this.record('ta_net', n ? `${v} (validated heads: ${n.active(true).join(', ') || 'none'})` : 'removed');
      // The models that read its forecasts were trained on the previous network: retrain them.
      if (v && cfg.autoTrain.onModelChange && this.state().trainedWithTaNet !== v && !this.child && !this.retrainFor.has(`ta_net:${v}`)) {
        this.retrainFor.add(`ta_net:${v}`);
        log.info('TA network changed: retraining the models that read it', { taNet: v });
        this.run(['--only', 'vol_model,dataset,mlp,perps']);
      }
    } else if (kind.startsWith('snn_')) {
      const domain = kind.slice(4) as SnnDomain;
      if (cfg.snn.mode === 'off' || !cfg.snn.domains[domain].enabled || !engine.snn) return;
      const old = engine.snn.units[domain];
      const next = createSnnUnit(cfg.snn, domain, file);
      await next.host.start();
      engine.setSnnUnit(domain, next);
      await old?.host.stop();
      const v = next.model?.version ?? next.host.version;
      this.record(kind, `${v} (${next.model?.notes ?? 'untrained'})`);
      // The models that read this network were trained on its previous outputs: retrain them.
      const consumers: Record<SnnDomain, string> = { crypto: 'dataset,mlp', perps: 'perps', tennis: 'tennis' };
      if (cfg.autoTrain.onModelChange && this.state().trainedWithSnn?.[domain] !== v && !this.child && !this.retrainFor.has(`${domain}:${v}`)) {
        this.retrainFor.add(`${domain}:${v}`);
        log.info('SNN changed: retraining the models that read it', { domain, snn: v });
        this.run(['--only', consumers[domain]]);
      }
    }
    this.d.audit.write('config', { event: 'hot_swap', kind, file });
    log.info('hot-swapped', { kind, file });
  }

  status(): AutoTrainStatus {
    const paths = resolveModelPaths(this.d.cfg);
    return {
      mode: this.d.cfg.autoTrain.mode, running: Boolean(this.child), lastStart: this.lastStart || null, lastExit: this.lastExit,
      nextRun: this.nextRun(), logFile: this.logFile,
      models: Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, { path: p, mtime: mtime(p), ...(k === 'mlp' ? { id: this.d.engine.model.id } : {}) }])),
      swaps: this.swaps, state: this.state(),
    };
  }
}

function mtime(p: string): number | null {
  try { return fs.statSync(p).mtimeMs; } catch { return null; }
}
