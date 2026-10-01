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
});

function fakeEngine() {
  let model = MetaModel.identity();
  const calls: string[] = [];
  const e = {
    get model() { return model; },
    setModel(m: MetaModel) { model = m; calls.push(`model:${m.id}`); },
    setVolProfile() { calls.push('vol'); },
    snn: undefined, setSnn(x: unknown) { calls.push('snn'); (e as any).__lastSnn = x; }, saveSnnBlender() { /* noop */ }, setTennisFair() { calls.push('tennis'); },
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
  // A new SNN model: swapped in, and the MLP / perps / tennis retrain is launched.
  const sp = withFlags({ ...DEFAULT_SNN, nE: 16, nI: 4, nL1: 8 }, {});
  const net = new SnnNetwork(sp);
  net.step(T0, [{ key: 'BTC-15m', asset: 'BTC', price: 60000 }]);
  fs.writeFileSync(path.join(cfg.autoTrain.dir, 'snn_model.json'), JSON.stringify({ ...net.exportModel('t'), version: versionHash(sp) }));
  now = Date.now() + 10_000;
  await t.watch();
  assert.ok(calls.includes('snn'), `snn swapped: ${calls}`);
  assert.equal(t.status().running, true, 'retrain launched');
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(t.status().lastExit!.args, ['--only', 'dataset,mlp,perps,tennis']);
  await (engine as any).__lastSnn?.host.stop?.();
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
  const r = await runPipeline({ cfg, only: ['snn', 'dataset', 'mlp', 'perps', 'tennis'], ablationOnly: 'S1', log: (m) => logs.push(m), now: T0 });
  const order = r.steps.map((s) => s.step);
  assert.deepEqual(order, ['snn-ablation', 'snn-train', 'snn-backfill', 'dataset', 'mlp', 'perps', 'tennis'], 'SNN before the models that read it');
  const by = Object.fromEntries(r.steps.map((s) => [s.step, s]));
  assert.ok(r.steps.every((s) => s.ok), JSON.stringify(r.steps.map((s) => [s.step, s.ok, s.skipped, s.error?.slice(0, 300)])));
  assert.match(String(by.perps.skipped), /no perp quotes/, 'no perp data: skipped, not failed');
  assert.match(String(by.tennis.skipped), /tennis matches/, 'no tennis data: skipped, not failed');
  // The backfill wrote prequential 'snn' events the dataset joined as features.
  const fill = path.join(cfg.autoTrain.dir, 'work', 'snnfill');
  const files = fs.readdirSync(fill).filter((f) => f.startsWith('snnfill-'));
  assert.equal(files.length, 1);
  const first = JSON.parse(fs.readFileSync(path.join(fill, files[0]), 'utf8').split('\n')[0]);
  assert.equal(first.k, 'snn'); assert.ok(first.dirs.some((d: unknown[]) => d[0] === 'BTC-15m'));
  const rows = fs.readFileSync(path.join(cfg.autoTrain.dir, 'work', 'dataset.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.filter((x) => Number.isFinite(x.fx.snn_up_15m)).length > rows.length * 0.5, 'SNN direction available as an MLP input');
  const mlp = MetaModel.load(path.join(cfg.autoTrain.dir, 'model.json'));
  assert.equal(mlp.params.kind, 'mlp', 'MLP-only default');
  assert.equal(r.state.mlpTrainedWithSnn, r.state.snnVersion, 'the promoted MLP was trained on the promoted SNN\'s outputs');
  assert.ok(fs.existsSync(path.join(cfg.autoTrain.dir, 'snn_model.json')));
  assert.ok(fs.existsSync(r.report));
  // Re-running the SNN steps soon after: ablation not due, training up to date, backfill incremental.
  const again = await runPipeline({ cfg, only: ['snn'], ablationOnly: 'S1', log: () => undefined, now: T0 + 3_600_000 });
  assert.match(String(again.steps.find((s) => s.step === 'snn-ablation')!.skipped), /not due/);
  assert.match(String(again.steps.find((s) => s.step === 'snn-train')!.skipped), /up to date/);
});
