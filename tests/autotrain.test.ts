// Automation: blender persistence keyed to the meta-model, hot-swapping, the scheduler, the
// MLP-change -> SNN re-run hook, and the pipeline end to end on synthetic recordings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Alerter } from '../bot/alerts/alerter';
import { AutoTrainer, MODEL_FILES, resolveModelPaths } from '../bot/autotrain';
import { loadConfig } from '../bot/config';
import type { Engine } from '../bot/engine';
import { MetaModel } from '../bot/model/metaModel';
import { taNetFileSchema, TANET_SCHEMA } from '../bot/ta/taNet';
import { DEFAULT_BLENDER, SnnBlender } from '../bot/snn/blender';
import { acceptedChain, recordingDays, runPipeline } from '../research/pipeline';
import { SnnNetwork } from '../bot/snn/network';
import { DEFAULT_SNN, versionHash, withFlags } from '../bot/snn/params';
import { writeSyntheticRecordings } from '../research/synthetic';
import { tmpAudit, tmpDir } from './helpers';

const T0 = Date.UTC(2026, 5, 1);
const cfgFor = (dir: string, extra: Record<string, string> = {}) => loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), DATA_DIR: dir, ...extra });

function filled(n = 5): SnnBlender {
  const b = new SnnBlender({ ...DEFAULT_BLENDER, recordEverySec: 0 });
  for (let i = 0; i < n; i++) { b.record({ ticker: `t${i}`, eventKey: `e${i}`, ts: T0 + i, pModel: 0.5, pSnn: 0.6, c: 1 }); b.settle(`t${i}`, 1); }
  return b;
}

test('blender history survives a restart, and is discarded when the meta-model changed', () => {
  const file = path.join(tmpDir(), 'blender.json');
  const a = filled();
  a.bindModel('mlp-A');
  for (let i = 0; i < 3; i++) { a.record({ ticker: `x${i}`, eventKey: 'e', ts: T0, pModel: 0.4, pSnn: 0.7, c: 1 }); a.settle(`x${i}`, 0); }
  a.save(file);
  const b = new SnnBlender({ ...DEFAULT_BLENDER, recordEverySec: 0 });
  assert.equal(b.load(file, 'mlp-A'), 'loaded');
  assert.equal(b.settled.length, 3, 'same model: history kept');
  const c = new SnnBlender();
  assert.equal(c.load(file, 'mlp-B'), 'reset');
  assert.equal(c.settled.length, 0, 'new model: pairs hold the old p_model, so they are dropped');
  assert.equal(new SnnBlender().load(path.join(tmpDir(), 'none.json'), 'mlp-A'), 'none');
  // Swapping the model in a live blender resets it and alpha starts over.
  assert.equal(b.bindModel('mlp-A'), false);
  assert.equal(b.bindModel('mlp-C'), true);
  assert.equal(b.settled.length, 0);
  assert.equal(b.alpha().alpha, 0);
});

test('model paths: the pipeline-promoted copy wins over params/', () => {
  const dir = tmpDir();
  const cfg = cfgFor(dir);
  assert.equal(resolveModelPaths(cfg).mlp, cfg.paramsPath);
  fs.mkdirSync(cfg.autoTrain.dir, { recursive: true });
  fs.writeFileSync(path.join(cfg.autoTrain.dir, MODEL_FILES.mlp), JSON.stringify(MetaModel.identity().params));
  assert.equal(resolveModelPaths(cfg).mlp, path.join(cfg.autoTrain.dir, 'model.json'));
  // A promoted TA network with an older input schema is skipped for the shipped one (when it exists).
  const shipped = path.join(dir, 'ta_net_shipped.json');
  const tcfg = cfgFor(dir, { TA_NET_PATH: shipped });
  const promotedTa = path.join(tcfg.autoTrain.dir, MODEL_FILES.ta_net);
  fs.writeFileSync(promotedTa, JSON.stringify({ version: 'tanet2-old', schema: '2', weights: [] }));
  assert.equal(taNetFileSchema(promotedTa), '2');
  assert.equal(resolveModelPaths(tcfg).ta_net, promotedTa, 'nothing shipped: keep the promoted file (the loader reports the mismatch)');
  fs.writeFileSync(shipped, JSON.stringify({ version: 'tanet3-new', schema: TANET_SCHEMA, weights: [] }));
  assert.equal(resolveModelPaths(tcfg).ta_net, shipped);
  fs.writeFileSync(promotedTa, JSON.stringify({ version: 'tanet3-retrained', schema: TANET_SCHEMA, weights: [] }));
  assert.equal(resolveModelPaths(tcfg).ta_net, promotedTa, 'retrained by the pipeline: the promoted copy wins again');
  assert.equal(taNetFileSchema(path.join(dir, 'missing.json')), undefined);
});

function fakeEngine() {
  let model = MetaModel.identity();
  const calls: string[] = [];
  const e = {
    get model() { return model; },
    setModel(m: MetaModel) { model = m; calls.push(`model:${m.id}`); },
    setVolProfile() { calls.push('vol'); },
    snn: { units: {} as Record<string, unknown> },
    setSnnUnit(domain: string, u: unknown) { calls.push(`snn:${domain}`); e.snn.units[domain] = u; },
    saveSnnBlender() { /* noop */ }, setTennisFair() { calls.push('tennis'); },
    setVolModel(m: unknown) { calls.push(`vol_model:${m ? 'set' : 'none'}`); }, setFillModel(m: { validated: boolean } | undefined) { calls.push(`fill:${m?.validated ? 'active' : 'inactive'}`); },
  };
  return { engine: e as unknown as Engine, calls };
}

test('hot swap: a new model.json goes live in the running engine; a new SNN retrains the models that read it', async () => {
  const dir = tmpDir();
  const cfg = cfgFor(dir, { AUTO_TRAIN: 'off', SNN_WORKER: 'false' });
  const { engine, calls } = fakeEngine();
  const audit = tmpAudit();
  let now = T0;
  const t = new AutoTrainer({ cfg, engine, audit, alerter: new Alerter([], audit), now: () => now, command: { cmd: process.execPath, args: ['-e', 'setTimeout(()=>{}, 50)'] } });
  t.start();
  t.stop();
  // Pipeline promotes a new MLP: swapped in, nothing else re-runs (the MLP reads the SNN, not vice versa).
  fs.mkdirSync(cfg.autoTrain.dir, { recursive: true });
  const p = { ...MetaModel.identity().params, version: 'mlp-new', kind: 'identity' as const };
  fs.writeFileSync(path.join(cfg.autoTrain.dir, 'model.json'), JSON.stringify(p));
  now = Date.now() + 10_000;
  await t.watch();
  assert.ok(calls.some((c) => c.startsWith('model:')), `swapped: ${calls}`);
  assert.equal(t.status().running, false);
  await t.watch();
  assert.equal(calls.filter((c) => c.startsWith('model:')).length, 1, 'same file: no second swap');
  // A new crypto network: swapped in alone, and only its consumer (dataset + MLP) is retrained.
  const sp = withFlags({ ...DEFAULT_SNN, nE: 16, nI: 4, nL1: 8 }, {});
  const net = new SnnNetwork(sp);
  net.step(T0, [{ key: 'BTC-15m', asset: 'BTC', price: 60000 }]);
  fs.writeFileSync(path.join(cfg.autoTrain.dir, 'snn_crypto.json'), JSON.stringify({ ...net.exportModel('t'), version: versionHash(sp) }));
  now = Date.now() + 10_000;
  await t.watch();
  assert.ok(calls.includes('snn:crypto'), `snn swapped: ${calls}`);
  assert.ok(!calls.includes('snn:perps') && !calls.includes('snn:tennis'), 'the other networks are untouched');
  assert.equal(t.status().running, true, 'retrain launched');
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(t.status().lastExit!.args, ['--only', 'dataset,mlp']);
  await ((engine as any).snn.units.crypto as { host: { stop(): Promise<void> } } | undefined)?.host.stop();
});

test('scheduler: daily at the configured UTC hour, once per day', () => {
  const dir = tmpDir();
  const cfg = cfgFor(dir, { AUTO_TRAIN: 'daily', AUTO_TRAIN_HOUR_UTC: '6' });
  const { engine } = fakeEngine();
  const audit = tmpAudit();
  const t = new AutoTrainer({ cfg, engine, audit, alerter: new Alerter([], audit) });
  const at = (h: number) => Date.UTC(2026, 5, 1, h);
  assert.equal(t.nextRun(at(3)), at(6));
  assert.equal(t.nextRun(at(7)), at(6), 'missed today: due now');
  fs.mkdirSync(cfg.autoTrain.dir, { recursive: true });
  fs.writeFileSync(path.join(cfg.autoTrain.dir, 'pipeline_state.json'), JSON.stringify({ lastRun: at(6) + 1000 }));
  assert.equal(t.nextRun(at(7)), at(6) + 86_400_000, 'already ran today: tomorrow');
  assert.equal(new AutoTrainer({ cfg: cfgFor(dir, { AUTO_TRAIN: 'off' }), engine, audit, alerter: new Alerter([], audit) }).nextRun(at(7)), null);
});

test('stage selection: the highest stage whose whole chain S1..Sk was accepted', () => {
  const v = (name: string, accepted: boolean) => ({ mechanism: name, accepted }) as never;
  assert.equal(acceptedChain([v('S1 tags', true), v('S2 dendrites', true), v('S3 x', false), v('S4 y', true)]), 2);
  assert.equal(acceptedChain([v('S1 tags', false), v('S2 dendrites', true)]), 0);
});

test('pipeline end to end: SNN first, backfilled SNN outputs, then the MLP trained on them; promoted and recorded', async () => {
  const dir = tmpDir();
  const rec = path.join(dir, 'recordings');
  writeSyntheticRecordings(rec, { windows: 10, seed: 7 });
  assert.equal(recordingDays(rec).length, 1);
  const cfg = cfgFor(dir, { AUTO_TRAIN_ABLATION_DAYS: '1' });
  const logs: string[] = [];
  // Progress is checkpointed after every step: by the time the backfill starts, the crypto network the
  // training step promoted is already on disk (a run cut short by a restart keeps it).
  let midRun: { snnVersions?: Record<string, string> } | undefined;
  const statePath = path.join(cfg.autoTrain.dir, 'pipeline_state.json');
  const r = await runPipeline({ cfg, only: ['snn', 'dataset', 'mlp', 'perps', 'tennis'], ablationOnly: 'S1', log: (m) => {
    logs.push(m);
    if (m.startsWith('snn-crypto-backfill: running') && fs.existsSync(statePath)) midRun = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  }, now: T0 });
  assert.ok(midRun?.snnVersions?.crypto, 'state saved mid-run');
  const order = r.steps.map((s) => s.step);
  assert.deepEqual(order, ['snn-crypto-ablation', 'snn-crypto-pbt', 'snn-crypto-train', 'snn-crypto-backfill', 'snn-perps-ablation', 'snn-perps-pbt', 'snn-perps-train', 'snn-perps-backfill', 'snn-tennis', 'dataset', 'mlp', 'perps', 'tennis'], 'every network before the models that read it');
  const by = Object.fromEntries(r.steps.map((s) => [s.step, s]));
  assert.ok(r.steps.every((s) => s.ok), JSON.stringify(r.steps.map((s) => [s.step, s.ok, s.skipped, s.error?.slice(0, 300)])));
  assert.match(String(by.perps.skipped), /no perp quotes/, 'no perp data: skipped, not failed');
  assert.match(String(by.tennis.skipped), /tennis matches/, 'no tennis data: skipped, not failed');
  // The backfill wrote prequential 'snn' events the dataset joined as features.
  for (const [d, want, never] of [['crypto', 'BTC-15m', 'BTC-240m'], ['perps', 'BTC-240m', 'BTC-15m']] as const) {
    const fill = path.join(cfg.autoTrain.dir, 'work', 'snnfill', d);
    const files = fs.readdirSync(fill).filter((f) => f.startsWith('snnfill-'));
    assert.equal(files.length, 1);
    const first = JSON.parse(fs.readFileSync(path.join(fill, files[0]), 'utf8').split('\n')[0]);
    assert.equal(first.k, 'snn'); assert.equal(first.d, d);
    assert.ok(first.dirs.some((x: unknown[]) => x[0] === want), `${d} network calls ${want}`);
    assert.ok(!first.dirs.some((x: unknown[]) => x[0] === never), `${d} network has no ${never} column`);
    assert.equal(first.dirs[0].length, 9, 'each call carries its confidence (skill, calConf, contractSkill, surprise, G)');
    if (d === 'perps') assert.deepEqual(first.c, {}, 'the perps network scores no contracts');
  }
  const rows = fs.readFileSync(path.join(cfg.autoTrain.dir, 'work', 'dataset.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.filter((x) => Number.isFinite(x.fx.snn_up_15m)).length > rows.length * 0.5, 'SNN direction available as an MLP input');
  const mlp = MetaModel.load(path.join(cfg.autoTrain.dir, 'model.json'));
  assert.equal(mlp.params.kind, 'mlp', 'MLP-only default');
  assert.ok(r.state.snnVersions?.crypto && r.state.snnVersions?.perps);
  assert.equal(r.state.trainedWithSnn?.crypto, r.state.snnVersions?.crypto, 'the promoted MLP was trained on the promoted crypto network\'s outputs');
  assert.ok(fs.existsSync(path.join(cfg.autoTrain.dir, 'snn_crypto.json')) && fs.existsSync(path.join(cfg.autoTrain.dir, 'snn_perps.json')));
  assert.notEqual(r.state.snnVersions?.crypto, r.state.snnVersions?.perps, 'separate networks with their own params');
  assert.ok(fs.existsSync(r.report));
  assert.equal(JSON.parse(fs.readFileSync(r.report, 'utf8')).complete, true);
  // Re-running the SNN steps soon after: ablation not due, training up to date, backfill incremental.
  const again = await runPipeline({ cfg, only: ['snn'], ablationOnly: 'S1', log: () => undefined, now: T0 + 3_600_000 });
  for (const d of ['crypto', 'perps']) {
    assert.match(String(again.steps.find((s) => s.step === `snn-${d}-ablation`)!.skipped), /not due/);
    assert.match(String(again.steps.find((s) => s.step === `snn-${d}-train`)!.skipped), /up to date/);
  }
});

test('pipeline readiness: the whole bot on its held-out days in % of the pool, every model\'s state, the target', async () => {
  const dir = tmpDir();
  const rec = path.join(dir, 'recordings');
  for (let d = 0; d < 7; d++) {
    writeSyntheticRecordings(rec, { windows: 4, seed: 40 + d, start: T0 + d * 86_400_000 });
    // Each day its own contracts (the synthetic writer names them SYN-0.. every day).
    const f = path.join(rec, `md-${new Date(T0 + d * 86_400_000).toISOString().slice(0, 10)}.jsonl`);
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replaceAll('"SYN-', `"SYN${d}-`));
  }
  const cfg = cfgFor(dir, { TRAIN_TARGET_DAILY_PCT: '0.5' });
  const r = await runPipeline({ cfg, only: ['readiness'], log: () => undefined, now: T0 + 8 * 86_400_000 });
  const step = r.steps.find((s) => s.step === 'readiness')!;
  assert.ok(step.ok && !step.skipped, JSON.stringify(step).slice(0, 600));
  const f = JSON.parse(fs.readFileSync(path.join(cfg.autoTrain.dir, 'readiness.json'), 'utf8'));
  assert.deepEqual(f.target, { poolUsd: 200, dailyPct: 0.5, maxDdPct: 10, minDays: 30 });
  assert.equal(f.wholeBot.days, 2, 'the newest 15% of 7 recorded days');
  assert.match(f.wholeBot.window, /^recordings: 2 day\(s\) 2026-06-06\.\.2026-06-07/);
  assert.ok(Number.isFinite(f.wholeBot.meanPct) && Number.isFinite(f.wholeBot.maxDdPct));
  assert.equal(f.met, false);
  assert.ok(f.why.some((w: string) => /2 held-out day\(s\), need 30/.test(w)));
  assert.deepEqual(f.components.map((c: { name: string }) => c.name), ['ta_net', 'setups', 'mlp', 'perp', 'vol_model', 'tennis', 'snn_crypto', 'snn_perps', 'snn_tennis']);
  assert.ok(f.components.every((c: { present: boolean }) => !c.present), 'nothing trained in this folder yet');
  assert.deepEqual(f.ledger, []);
  assert.ok(!fs.existsSync(path.join(cfg.autoTrain.dir, 'work', 'readiness-days')), 'the day links are removed');
});

test('remote mode: models copied in by the training workflow are hot-swapped; this machine never runs the pipeline', async () => {
  const dir = tmpDir();
  const cfg = cfgFor(dir, { AUTO_TRAIN: 'remote', SNN_WORKER: 'false' });
  const { engine, calls } = fakeEngine();
  const audit = tmpAudit();
  let now = T0;
  const t = new AutoTrainer({ cfg, engine, audit, alerter: new Alerter([], audit), now: () => now, command: { cmd: process.execPath, args: ['-e', 'setTimeout(()=>{}, 50)'] } });
  t.start();
  t.stop();
  assert.equal(t.nextRun(T0), null, 'no schedule here');
  assert.equal(t.run([]), false, 'a run request is refused');
  await t.tick();
  assert.equal(t.status().running, false);
  fs.mkdirSync(cfg.autoTrain.dir, { recursive: true });
  fs.writeFileSync(path.join(cfg.autoTrain.dir, 'model.json'), JSON.stringify({ ...MetaModel.identity().params, version: 'mlp-remote', kind: 'identity' as const }));
  now = Date.now() + 10_000;
  await t.watch();
  assert.ok(calls.some((c) => c.startsWith('model:')), `swapped: ${calls}`);
  assert.equal(t.status().running, false);
});
