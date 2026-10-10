// The trainer window: progress bars and time estimates from the pipeline's output (research/trainerProgress.ts),
// the update check and installer script (research/trainerUpdate.ts), the window's server (research/trainerUi.ts),
// the pipeline's progress lines (research/progress.ts) and its "sweep everything" option.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { explain, formatEta, planFrom, RoundProgress, type StepTiming } from '../research/trainerProgress';
import { applyScript, checkForUpdate, shaOf } from '../research/trainerUpdate';
import { TrainerUi } from '../research/trainerUi';
import { progress } from '../research/progress';
import { loadConfig } from '../bot/config';
import { runPipeline } from '../research/pipeline';
import { tmpDir } from './helpers';

const MIN = 60_000;
const past: StepTiming[][] = [
  [{ step: 'history', ms: 40 * MIN }, { step: 'history_replay', ms: 10 * MIN }, { step: 'ta_net', ms: 30 * MIN }, { step: 'mlp', ms: 10 * MIN }, { step: 'readiness', ms: 2 * MIN }],
  [{ step: 'ta_net', ms: 20 * MIN }, { step: 'gp', ms: 8 * MIN, skipped: true }, { step: 'mlp', ms: 6 * MIN }, { step: 'readiness', ms: 2 * MIN }],
];

test('progress: the plan and durations come from the last rounds of the same kind', () => {
  const full = planFrom(past, true), cont = planFrom(past, false);
  assert.deepEqual(full.plan, ['history', 'history_replay', 'ta_net', 'mlp', 'readiness']);
  assert.deepEqual(cont.plan, ['ta_net', 'mlp', 'readiness'], 'a skipped step is not planned');
  assert.equal(full.expect.get('ta_net'), 30 * MIN, 'median of the runs that did work');
  assert.equal(full.expect.get('gp'), undefined, 'a skipped run says nothing about its duration');
});

test('progress: bars and time left follow the pipeline output and the steps\' own progress lines', () => {
  let t = 0;
  const p = new RoundProgress(past, true, () => t);
  p.line('[pipeline] history: running...\n');
  t = 10 * MIN;
  let v = p.view();
  assert.equal(v.step, 'history');
  assert.match(v.explanation, /Downloading what is missing/);
  assert.ok(v.downloads.pct > 15 && v.downloads.pct < 25, `10 of the usual 40 min of downloads: ${v.downloads.pct}`);
  assert.equal(v.training.pct, 0);
  // The step reports its own progress: 1,000 of 4,000 contracts in 5 minutes -> 15 minutes left for it.
  p.line('[progress] {"task":"Kalshi KXBTC15M contracts","done":0,"total":4000}');
  t = 15 * MIN;
  p.line('[progress] {"task":"Kalshi KXBTC15M contracts","done":1000,"total":4000}');
  v = p.view();
  assert.equal(v.current.task, 'Kalshi KXBTC15M contracts: 1,000 of 4,000');
  assert.equal(v.current.etaSec, 15 * 60);
  assert.equal(v.downloads.etaSec, (15 + 10) * 60, 'this step\'s 15 min plus the replay\'s usual 10');
  assert.ok(!v.log.some((l) => l.startsWith('[progress]')), 'progress lines are not shown as output');
  p.line('[pipeline] history: done in 900 s');
  p.line('[pipeline] history_replay: skipped (nothing new)');
  v = p.view();
  assert.equal(v.downloads.pct, 100); assert.equal(v.downloads.etaSec, 0);
  assert.equal(v.training.etaSec, (30 + 10 + 2) * 60);
  p.line('[pipeline] ta_net: running...');
  t += 60 * MIN;
  v = p.view();
  assert.ok(v.training.pct <= 99 && v.training.etaSec! > 0, 'a step running past its usual time is never shown finished');
  assert.equal(formatEta(3900), '1 h 5 min'); assert.equal(formatEta(30), 'under a minute'); assert.equal(formatEta(null), 'estimating...');
  for (const s of ['history', 'gp', 'snn-crypto-pbt', 'snn-perps-train', 'sweep-bot', 'readiness', 'pull', 'push']) assert.ok(explain(s).length > 20, s);
});

test('updates: a new build is offered when the release was built from another commit; the installer keeps trainer-data', async () => {
  assert.equal(shaOf('built 2026-10-08 15:00:00Z from 0123456789abcdef0123456789abcdef01234567'), '0123456789abcdef0123456789abcdef01234567');
  assert.equal(shaOf('Unzip, double-click Train.cmd. Built from abcdef1234567.'), 'abcdef1234567');
  const release = (sha: string) => (async () => new Response(JSON.stringify({ body: `Built from ${sha}.`, published_at: '2026-10-08T15:30:00Z', assets: [{ name: 'KalshiTrainer-windows.zip', browser_download_url: 'https://github.com/WickedRadWizBiz/coinbaseTraderBot/releases/download/trainer-latest/KalshiTrainer-windows.zip' }] }))) as unknown as typeof fetch;
  const root = tmpDir();
  const newer = await checkForUpdate({ fetchImpl: release('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), current: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', root, platform: 'win32' });
  assert.equal(newer.available, true); assert.equal(newer.canInstall, true);
  const same = await checkForUpdate({ fetchImpl: release('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), current: 'aaaaaaa', root, platform: 'win32' });
  assert.equal(same.available, false, 'a short and a full commit id of the same build match');
  const mac = await checkForUpdate({ fetchImpl: release('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), current: 'aaaaaaa', root, platform: 'darwin' });
  assert.equal(mac.available, true); assert.equal(mac.canInstall, false, 'outside Windows the window links the release page');
  const down = await checkForUpdate({ fetchImpl: (async () => new Response('no', { status: 503 })) as unknown as typeof fetch, current: 'aaaaaaa', root });
  assert.equal(down.available, false); assert.match(down.error!, /503/);
  const script = applyScript('C:\\KalshiTrainer', 'C:\\KalshiTrainer\\update\\KalshiTrainer-windows.zip', 4242);
  assert.match(script, /PID eq 4242/, 'waits for the trainer to exit');
  assert.match(script, /Expand-Archive/);
  assert.match(script, /robocopy .* \/XD trainer-data update/, 'never touches the data');
  assert.match(script, /start "" "C:\\KalshiTrainer\\Train\.cmd"/);
});

const call = (port: number, method: string, p: string, o: { token?: string; host?: string; body?: unknown } = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(o.token ? { 'X-Trainer-Token': o.token } : {}), ...(o.host ? { Host: o.host } : {}), 'Content-Type': 'application/json' } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b })); });
  req.on('error', reject);
  req.end(o.body ? JSON.stringify(o.body) : undefined);
});

test('window server: only this computer, only with the token; start, progress, stop, the update prompt', async () => {
  const dataDir = tmpDir();
  let release!: () => void;
  let killed = false;
  let seen: { hours: number; sweepAll?: boolean; host?: string } | undefined;
  const ui = new TrainerUi({
    dataDir,
    check: async () => ({ current: 'aaaaaaa', latest: 'bbbbbbb', publishedAt: null, available: true, canInstall: true, downloadUrl: 'x', checkedAt: null }),
    install: async () => undefined,
    run: async (o) => {
      seen = { hours: o.hours, sweepAll: o.sweepAll, host: o.settings.host };
      o.hooks!.roundStart!(1, true, true);
      o.hooks!.phase!('pipeline');
      o.hooks!.child!({ kill: () => { killed = true; release(); return true; } } as never);
      o.hooks!.line!('[pipeline] history: running...');
      await new Promise<void>((r) => { release = r; });
      return { why: o.hooks!.stopRequested!() ? 'stopped' : 'finished' };
    },
  });
  const url = await ui.listen(0);
  const port = Number(new URL(url).port), token = new URL(url).searchParams.get('t')!;
  try {
    assert.equal((await call(port, 'GET', `/?t=${token}`)).status, 200);
    assert.match((await call(port, 'GET', `/?t=${token}`)).body, /KALSHI TRAINER/);
    assert.equal((await call(port, 'GET', '/?t=wrong')).status, 403);
    assert.equal((await call(port, 'GET', '/api/state')).status, 403, 'no token, no state');
    assert.equal((await call(port, 'GET', `/?t=${token}`, { host: 'evil.example' })).status, 403, 'another host name (DNS rebinding) is refused');
    assert.equal(JSON.parse((await call(port, 'POST', '/api/start', { token, body: { host: '1.2.3.4' } })).body).error, 'a server needs its SSH key file');
    const started = JSON.parse((await call(port, 'POST', '/api/start', { token, body: { mode: 'full', hours: 3 } })).body);
    assert.equal(started.ok, true);
    assert.deepEqual(seen, { hours: 3, sweepAll: true, host: undefined });
    let st = JSON.parse((await call(port, 'GET', '/api/state', { token })).body);
    assert.equal(st.phase, 'running'); assert.equal(st.round, 1); assert.equal(st.progress.step, 'history');
    assert.equal(JSON.parse((await call(port, 'POST', '/api/start', { token, body: {} })).body).error, 'already training');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'trainer.json'), 'utf8')).user, 'ubuntu');
    await ui.checkUpdate();
    st = JSON.parse((await call(port, 'GET', '/api/state', { token })).body);
    assert.equal(st.update.available, true);
    await call(port, 'POST', '/api/update/later', { token });
    st = JSON.parse((await call(port, 'GET', '/api/state', { token })).body);
    assert.equal(st.update.dismissed, true, '"Not now" hides it');
    await ui.checkUpdate();
    assert.equal(ui.state.update!.dismissed, true, 'still hidden for the same version');
    assert.equal(JSON.parse((await call(port, 'POST', '/api/stop', { token })).body).ok, true);
    assert.equal(killed, true, 'Stop ends the pipeline in progress');
    await new Promise((r) => setTimeout(r, 20));
    st = JSON.parse((await call(port, 'GET', '/api/state', { token })).body);
    assert.equal(st.phase, 'idle'); assert.equal(st.lastStop, 'stopped by you');
  } finally { ui.close(); }
});

test('progress lines: only when the trainer asks for them, at most one a second per task, always the last', () => {
  const out: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { out.push(s); return true; };
  try {
    delete process.env.TRAINER_PROGRESS;
    progress('t1', 1, 10, 0);
    process.env.TRAINER_PROGRESS = '1';
    progress('t2', 1, 10, 10_000); progress('t2', 2, 10, 10_500); progress('t2', 3, 10, 11_100); progress('t2', 10, 10, 11_200);
  } finally { (process.stdout as unknown as { write: typeof write }).write = write; delete process.env.TRAINER_PROGRESS; }
  assert.deepEqual(out.map((l) => JSON.parse(l.replace('[progress] ', '')).done), [1, 3, 10]);
});

test('pipeline --sweep-all: a step that is not due runs anyway', async () => {
  const dir = tmpDir();
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), DATA_DIR: dir });
  fs.mkdirSync(cfg.autoTrain.dir, { recursive: true });
  const now = Date.UTC(2026, 9, 1);
  fs.writeFileSync(path.join(cfg.autoTrain.dir, 'pipeline_state.json'), JSON.stringify({ ruleBookAt: now - 86_400_000 }));
  fs.writeFileSync(path.join(cfg.autoTrain.dir, 'rule_book.json'), '{}');
  fs.mkdirSync(path.join(dir, 'history', 'binance', 'BTC'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'history', 'binance', 'BTC', '1h.csv'), 'ts,o,h,l,c,v\n0,1,1,1,1,1\n');
  const normal = await runPipeline({ cfg, only: ['rule_book'], log: () => undefined, now });
  assert.match(normal.steps[0].skipped ?? '', /weekly/);
  const swept = await runPipeline({ cfg, only: ['rule_book'], log: () => undefined, now, forceAll: true });
  assert.ok(!/weekly/.test(swept.steps[0].skipped ?? ''), `ran (or found nothing to study), not skipped as not due: ${swept.steps[0].skipped}`);
});

test('leaderboard: each tournament as a bracket narrowing to its champion, with its distinctive settings; formulas by test Sharpe', async () => {
  const { leaderboard, distinctive } = await import('../research/trainerLeaderboard');
  const models = path.join(tmpDir(), 'models');
  fs.mkdirSync(path.join(models, 'work', 'snnpbt', 'crypto'), { recursive: true });
  const members = [0, 1, 2, 3, 4, 5].map((id) => ({ id, hyper: { lr: id === 2 ? 0.05 : 0.001, tau: 10 } }));
  const log = Array.from({ length: 6 }, (_, r) => ({ round: r, evalFrom: '2025-01-01', evalTo: '2025-01-07', elite: 2, ranking: [2, 0, 1, 3, 4, 5].map((member, j) => ({ member, fitness: 1 - j / 10, sortino: 2, maxDrawdown: 0.05 })) }));
  fs.writeFileSync(path.join(models, 'work', 'snnpbt', 'crypto', 'state.json'), JSON.stringify({ log, members, ga: { generation: 2 } }));
  fs.writeFileSync(path.join(models, 'work', 'tanet-population.json'), JSON.stringify({ log: log.slice(0, 2), members }));
  fs.writeFileSync(path.join(models, 'gp_indicators.json'), JSON.stringify({ champions: {
    BTC: { asset: 'BTC', formula: 'z48(ETH.c)', validated: true, test: { sharpe: 1.2, totalReturn: 0.4, maxDd: 0.1, trades: 50 }, history: [{ gen: 0, best: 0.1 }, { gen: 1, best: 0.3 }] },
    SOL: { asset: 'SOL', formula: 'SOL.c', validated: false, test: { sharpe: 0.2 }, history: [] } } }));
  const b = leaderboard(models);
  assert.deepEqual(b.map((x) => x.id), ['snn-crypto', 'ta_net', 'gp-BTC', 'gp-SOL'], 'most rounds won first, then formulas by test Sharpe');
  const snn = b[0];
  assert.deepEqual(snn.columns.map((c) => c.entrants.length), [8, 4, 2, 1].map((n) => Math.min(n, 6)), 'best 8 (of 6) -> 4 -> 2 -> champion');
  assert.equal(snn.champion.name, '#2');
  assert.equal(snn.champion.headline, 'won 6 of 6 rounds');
  assert.ok(snn.champion.attrs.some(([k, v]) => k === 'lr' && v.includes('▲')), 'its learning rate sets it apart');
  assert.deepEqual(b[1].columns.length, 2, 'a tournament with two rounds shows two columns');
  assert.equal(b[2].champion.validated, true);
  assert.deepEqual(distinctive({ a: 10, b: 1 }, [{ a: 1, b: 1 }, { a: 1, b: 1 }], 1), [['a', '10 ▲']]);
  assert.deepEqual(leaderboard(path.join(tmpDir(), 'none')), [], 'nothing trained yet: no brackets');
});

import { conditioningView } from '../research/trainerUi';
import { conditioningBracket } from '../research/trainerLeaderboard';

test('conditioning mode: greyed out until a normal training run finished since the last conditioning run; it runs only the conditioning step', async () => {
  const dataDir = tmpDir();
  const models = path.join(dataDir, 'models');
  fs.mkdirSync(models, { recursive: true });
  assert.equal(conditioningView(models).ready, false, 'never trained');
  const trainedAt = Date.parse('2026-10-09T10:00:00Z');
  fs.writeFileSync(path.join(models, 'pipeline_state.json'), JSON.stringify({ lastRun: trainedAt }));
  assert.equal(conditioningView(models).ready, true);
  let only: string[] | undefined;
  const ui = new TrainerUi({ dataDir, check: async () => ({ current: null, latest: null, publishedAt: null, available: false, canInstall: false, downloadUrl: null, checkedAt: null }), run: async (o) => { only = o.only; return { why: 'finished' }; } });
  assert.deepEqual(ui.start({ mode: 'conditioning' }), { ok: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(only, ['conditioning']);
  fs.writeFileSync(path.join(models, 'conditioning_report.json'), JSON.stringify({ at: '2026-10-09T12:00:00Z', best: { id: 't0-3', passed: 4 }, elite: null, trials: [{ stages: new Array(21) }] }));
  const v = conditioningView(models);
  assert.equal(v.ready, false, 'conditioned since the last training');
  assert.deepEqual(v.last, { at: '2026-10-09T12:00:00Z', elite: null, best: 't0-3', bestPassed: 4, windows: 21 });
  assert.match(ui.start({ mode: 'conditioning' }).error!, /train again the normal way first/);
  // Greyed out is a recommendation: confirmed in the window (force), it starts anyway.
  only = undefined;
  assert.deepEqual(ui.start({ mode: 'conditioning', force: true }), { ok: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(only, ['conditioning']);
});

test('conditioning bracket: one column per tier reached, the Elite Champion (or the best) on the card', () => {
  const tiers = [{ name: '1', cash: 1000 }, { name: '2', cash: 500 }, { name: '3', cash: 200 }, { name: 'C', cash: 100, regime: 'calm' }];
  const stages = tiers.flatMap((_, ti) => [0, 1, 2].map((wi) => ({ index: ti * 3 + wi, tier: ti, win: wi })));
  const inst = (id: string, n: number) => ({ id, origin: 'random', passed: n, wins: n, totalUsd: n * 100, worstUsd: -20, params: { tierScale: n }, played: stages.slice(0, n + 1).map((s, k) => ({ stage: s.index, passed: k < n, pnl: 100, minPnl: 0 })) });
  const b = conditioningBracket({ at: '2026-10-09T12:00:00Z', unseenDays: 300, tiers, windowDays: [3, 2, 1], elite: null, best: inst('a', 7), trials: [{ stages, instances: [inst('a', 7), inst('b', 2)] }] })!;
  assert.deepEqual(b.columns.map((c) => c.label), ['Tier 1 $1000', 'Tier 2 $500', 'Tier 3 $200']);
  assert.deepEqual(b.columns[0].entrants.map((e) => [e.name, e.won]), [['a', true], ['b', false]]);
  assert.match(b.champion.headline, /Best so far: 7 of 12 windows/);
  assert.equal(b.champion.validated, false);
});
