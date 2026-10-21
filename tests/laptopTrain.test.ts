import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { test } from 'node:test';
import { loadConfig } from '../bot/config';
import { afterRound, championsGone, confirmPushed, CONTINUE_STEPS, fullRoundDone, readTrainerState, writeTrainerState, filesToPull, filesToPush, guideText, kalshiSweeps, laptopProfile, readSettings, writeSettings, LOCAL_ONLY_DIRS, localManifest, parseManifest, readPushes, roundOutcome, safeServerEnv, scoreboard, Server, serverLine } from '../research/laptopTrain';
import { dailyStats, type ReadinessFile } from '../research/readiness';
import { resourcePlan } from '../research/trainerResources';
import { tmpDir } from './helpers';

test('laptop trainer: manifests, what to copy down and what to send back', () => {
  const remote = parseManifest('models/model.json\t120\t1791300000.5\nrecordings/md-2026-10-06.jsonl.gz\t5000\t1791200000\nbad line\n../etc/passwd\t1\t1\n');
  assert.deepEqual(remote.map((f) => f.path), ['models/model.json', 'recordings/md-2026-10-06.jsonl.gz']);
  const local = new Map([['models/model.json', { path: 'models/model.json', size: 120, mtime: 1791300000500 + 1000 }]]);
  assert.deepEqual(filesToPull(remote, local).map((f) => f.path), ['recordings/md-2026-10-06.jsonl.gz'], 'same size, time within 2 s: already here');
  const mine = new Map([
    ['ta_net.json', { path: 'ta_net.json', size: 9, mtime: 2_000_000 }],
    ['model.json', { path: 'model.json', size: 9, mtime: 1_000_000 }],
    ['work/snnfill/crypto/x.jsonl', { path: 'work/snnfill/crypto/x.jsonl', size: 9, mtime: 3_000_000 }],
  ]);
  const server = [{ path: 'ta_net.json', size: 9, mtime: 1_000_000 }, { path: 'model.json', size: 9, mtime: 5_000_000 }];
  assert.deepEqual(filesToPush(mine, server).map((f) => f.path), ['ta_net.json'], 'newer here only; never a newer server file; no bulky backfills');
  // Newer wins both ways: a file changed here (a model, the ledger, a tournament) is never overwritten by an older server copy.
  const srv = [{ path: 'models/a.json', size: 5, mtime: 10_000 }, { path: 'models/b.json', size: 7, mtime: 50_000 }];
  const loc = new Map([['models/a.json', { path: 'models/a.json', size: 9, mtime: 20_000 }], ['models/b.json', { path: 'models/b.json', size: 9, mtime: 20_000 }]]);
  assert.deepEqual(filesToPull(srv, loc).map((f) => f.path), ['models/b.json']);
  // A Kalshi series' index stays this machine's once it has one (the server lists 60 days, the laptop 365); new
  // day files still come down, and a missing index is still pulled.
  const kIdx = 'history/kalshi/KXBTC15M/.index.json', kDay = 'history/kalshi/KXBTC15M/2026-10-01.jsonl';
  const srvK = [{ path: kIdx, size: 9, mtime: 90_000 }, { path: kDay, size: 9, mtime: 90_000 }];
  assert.deepEqual(filesToPull(srvK, new Map([[kIdx, { path: kIdx, size: 5, mtime: 10_000 }]])).map((f) => f.path), [kDay]);
  assert.deepEqual(filesToPull(srvK, new Map()).map((f) => f.path), [kIdx, kDay]);
  // Never sent: links to replay days, caches the server rebuilds, logs, partial writes.
  const files = ['work/perp-dataset/2021-01-01.json.gz', 'work/perp-dataset-rec/x.gz', 'work/perp-backtest-days/md-2021-01-01.jsonl.gz', 'work/sweep-replay/md-2021-01-01.jsonl.gz', 'work/vol-replay/a', 'work/readiness-days/b', 'work/tanet-cache/BTC.bin',
    'logs/pipeline-laptop.log', 'x.json.tmp', 'work/history-ledger.json', 'readiness.json', 'work/snnpbt/perps/state.json', 'archive/ta_net/v1.json'];
  const all = new Map(files.map((f) => [f, { path: f, size: 1, mtime: 9_000_000 }]));
  assert.deepEqual(filesToPush(all, []).map((f) => f.path).sort(), ['archive/ta_net/v1.json', 'readiness.json', 'work/history-ledger.json', 'work/snnpbt/perps/state.json']);
  // The conditioning champion: sent only when written in this session; a copy rolled back on the server goes here too.
  const champ = new Map([['conditioning_champion.json', { path: 'conditioning_champion.json', size: 1, mtime: 5_000 }], ['conditioning_champion.prev.json', { path: 'conditioning_champion.prev.json', size: 1, mtime: 9_000 }]]);
  assert.deepEqual(filesToPush(champ, [], 8_000).map((f) => f.path), ['conditioning_champion.prev.json'], 'an older champion is not resurrected after a rollback');
  const here = new Map([['models/conditioning_champion.json', { path: 'models/conditioning_champion.json', size: 1, mtime: 5_000 }], ['models/a.json', { path: 'models/a.json', size: 1, mtime: 5_000 }]]);
  assert.deepEqual(championsGone([{ path: 'models/conditioning_champion.prev.json', size: 1, mtime: 1 }], here), ['models/conditioning_champion.json']);
  assert.deepEqual(championsGone([{ path: 'models/conditioning_champion.json', size: 1, mtime: 1 }], here), []);
});

test('laptop trainer: every send is confirmed on the server and recorded; STATUS says where the models went', () => {
  const sent = [{ path: 'ta_net.json', size: 9, mtime: 2_000_000 }, { path: 'gp.json', size: 5, mtime: 2_000_000 }, { path: 'setups.json', size: 7, mtime: 2_000_000 }];
  const after = [{ path: 'ta_net.json', size: 9, mtime: 2_001_000 }, { path: 'gp.json', size: 4, mtime: 2_000_000 }, { path: 'rule_book.json', size: 3, mtime: 1 }];
  assert.deepEqual(confirmPushed(sent, after), { confirmed: 1, missing: ['gp.json', 'setups.json'] }, 'same size and time (2 s slack) or not confirmed');
  assert.match(serverLine({ connected: false }), /NOT SET.*stay on this laptop/);
  assert.match(serverLine({ host: '1.2.3.4', connected: false }), /did not answer/);
  assert.match(serverLine({ host: '1.2.3.4', connected: true }), /Nothing sent yet/);
  const at = Date.UTC(2026, 9, 21, 1, 10);
  assert.equal(serverLine({ host: '1.2.3.4', connected: true, last: { at, why: 'x', files: 3, mb: 1, confirmed: 3, missing: [] } }), 'Server: 1.2.3.4. Last send 2026-10-21 01:10 UTC: 3 file(s), 3 confirmed on the server.');
  assert.match(serverLine({ host: '1.2.3.4', connected: true, last: { at, why: 'x', files: 3, mb: 1, confirmed: 1, missing: ['gp.json', 'setups.json'] } }), /NOT confirmed: gp\.json, setups\.json/);
  assert.match(serverLine({ host: '1.2.3.4', connected: true, last: { at, why: 'x', files: 3, mb: 1, confirmed: 0, missing: [], error: 'the copy did not finish' } }), /FAILED/);
  const dir = tmpDir();
  assert.deepEqual(readPushes(dir), []);
  fs.writeFileSync(path.join(dir, 'pushes.jsonl'), JSON.stringify({ at, why: 'x', files: 1, mb: 0, confirmed: 1, missing: [] }) + '\n');
  assert.equal(readPushes(dir).at(-1)?.confirmed, 1);
});

test('laptop trainer: what counts as progress, when it stops by itself, the scoreboard, the guide', () => {
  assert.ok(CONTINUE_STEPS.includes('readiness'), 'every round ends with the readiness check');
  const steps = [
    { step: 'ta_net', ok: true, detail: { promoted: false, complete: false } },
    { step: 'snn-perps-train', ok: true, detail: { promoted: true, improved: true } },
    { step: 'mlp', ok: true, detail: { promoted: true, improved: false } },
    { step: 'vol', ok: true, detail: { promoted: true } },
    { step: 'perps', ok: false },
    { step: 'snn-crypto-pbt', ok: true, skipped: 'every training week has been used by this network' },
  ];
  const out = roundOutcome(steps);
  assert.deepEqual(out, { improved: ['snn-perps-train'], inProgress: ['ta_net'], failed: ['perps'] });
  const none = { improved: [], inProgress: [], failed: [] };
  const ledger = (fresh: number) => [
    { net: 'snn-crypto', weeks: 300, trained: 260 - fresh, fresh, holdout: 40, judged: 4, generations: 50 },
    { net: 'snn-perps', weeks: 280, trained: 245 - fresh, fresh, holdout: 35, judged: 4, generations: 49 },
  ];
  const R = (o: Partial<ReadinessFile> = {}): ReadinessFile => ({ at: new Date().toISOString(), target: { poolUsd: 200, dailyPct: 50, maxDdPct: 10, minDays: 30 }, met: false, why: ['daily return 0.30%'], components: [], ledger: ledger(20), ...o });
  // A round that improved a model, or has a tournament still running, resets the count; others count up.
  assert.deepEqual(afterRound({ outcome: out, readiness: R(), plateau: 2, plateauRounds: 3 }), { plateau: 0 });
  assert.deepEqual(afterRound({ outcome: { ...none, inProgress: ['ta_net'] }, readiness: R(), plateau: 2, plateauRounds: 3 }), { plateau: 0 });
  assert.deepEqual(afterRound({ outcome: none, readiness: R(), plateau: 1, plateauRounds: 3 }), { plateau: 2 });
  assert.match(afterRound({ outcome: none, readiness: R(), plateau: 2, plateauRounds: 3 }).stop!, /no progress in 3 round/);
  assert.match(afterRound({ outcome: none, readiness: R({ ledger: ledger(0) }), plateau: 0, plateauRounds: 3 }).stop!, /no fresh history left/);
  assert.equal(afterRound({ outcome: out, readiness: R({ ledger: ledger(0) }), plateau: 0, plateauRounds: 3 }).stop, undefined, 'no fresh weeks, but this round improved a model');
  const st = dailyStats(Array.from({ length: 40 }, (_, i) => 100 + (i % 5)), 200, Array.from({ length: 40 }, (_, i) => `2026-08-${String(1 + (i % 28)).padStart(2, '0')}`));
  const wb = { ...st, window: 'history replay (real Kalshi contracts): 40 day(s)', kalshiUsd: 2500, perpsUsd: 1580, solid: true, solidWhy: [] };
  assert.match(afterRound({ outcome: none, readiness: R({ met: true, why: [], wholeBot: wb }), plateau: 0, plateauRounds: 3 }).stop!, /target reached: the whole bot made \+51\.00% a day/);
  const board = scoreboard({ round: 4, hours: 30.5, outcome: out, readiness: R({ wholeBot: { ...wb, solid: false, solidWhy: ['Sharpe 1.20 < 2'] } }), plateau: 0, plateauRounds: 3 });
  assert.ok(board.some((l) => /^Whole bot on 40 held-out day\(s\)/.test(l)));
  assert.ok(board.some((l) => /\+51\.00% a day \(\$102\.00 a day/.test(l)));
  assert.ok(board.some((l) => /solid: not yet \(Sharpe 1\.20 < 2\)/.test(l)));
  assert.ok(board.some((l) => /^Target 50% a day \(\$100\.00 on \$200\).*not met/.test(l)));
  assert.ok(board.some((l) => /^This round improved: snn-perps-train; still running: ta_net; FAILED: perps/.test(l)));
  assert.ok(board.some((l) => /^History ledger, snn-crypto: 240 of 260 training weeks used \(20 fresh\)/.test(l)));
  // The guide: the honest note about a 50%-a-day target, the realistic bar, how long to train.
  const g = guideText({ poolUsd: 200, dailyPct: 50, maxDdPct: 10, plateauRounds: 3 });
  assert.match(g, /\$100\.00/);
  assert.match(g, /191,751x in 30 days/);
  assert.match(g, /No trading system keeps that up/);
  assert.match(g, /at least 3 rounds/);
  assert.match(g, /2 to 4 weeks/);
  const g2 = guideText({ poolUsd: 200, dailyPct: 0.5, maxDdPct: 10, plateauRounds: 3 });
  assert.doesNotMatch(g2, /No trading system/);
  assert.match(g2, /\$1\.00\)/);
  assert.match(g2, /1\.16x in 30 days/);
  // Until it stops: each round sized like a day's budget, the sweep (a proposal) weekly.
  const c = laptopProfile(0, 16, true, resourcePlan('balanced', 16, 32768));
  assert.deepEqual([c.AUTO_TRAIN_SNN_PBT_DAYS, c.AUTO_TRAIN_SNN_TRAIN_DAYS, c.SWEEP_EVERY_DAYS, c.SWEEP_HOURS, c.TRAIN_WORKERS], ['36', '24', '7', '2', '8']);
});

test('laptop trainer: the server settings it trains with carry no credentials or server paths; budgets grow', () => {
  const env = safeServerEnv('KALSHI_API_KEY_ID=abc\nKALSHI_PRIVATE_KEY_PATH=/home/ubuntu/.kalshi/k.pem\nDASHBOARD_PASSWORD=hunter2\nSTRATEGY_MIN_EDGE=0.03\nDATA_DIR=/home/ubuntu/bot/data\nTRADING_MODE="paper"\n# comment\n');
  assert.deepEqual(env, { STRATEGY_MIN_EDGE: '0.03', TRADING_MODE: 'paper' });
  const p = laptopProfile(12);
  assert.equal(p.AUTO_TRAIN_CHAMPION, 'true');
  assert.equal(p.SWEEP_HOURS, '3');
  assert.ok(Number(p.KALSHI_HISTORY_DAYS) >= 365);
  assert.equal(p.HISTORY_REPLAY_YEARS, '0', 'the replay covers all of the history');
  assert.equal(loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), HISTORY_REPLAY_YEARS: '0' } as NodeJS.ProcessEnv).taNet.historyReplayYears, 0);
  // Threads and populations from the resource plan (balanced, 16 threads, 32 GB: half the threads).
  const q = laptopProfile(12, 16, false, resourcePlan('balanced', 16, 32768));
  assert.equal(q.TRAIN_WORKERS, '8');
  assert.equal(q.AUTO_TRAIN_SNN_PBT_POPULATION, '8');
  assert.equal(laptopProfile(12, 2).AUTO_TRAIN_SNN_PBT_POPULATION, '3', 'never fewer than the original three');
  // The networks' tournament and training windows grow with the budget.
  assert.deepEqual([p.AUTO_TRAIN_SNN_PBT_DAYS, p.AUTO_TRAIN_SNN_TRAIN_DAYS], ['30', '14']);
  const long = laptopProfile(96);
  assert.deepEqual([long.AUTO_TRAIN_SNN_PBT_DAYS, long.AUTO_TRAIN_SNN_TRAIN_DAYS], ['144', '96']);
  assert.equal(laptopProfile(1000).AUTO_TRAIN_SNN_PBT_DAYS, '365');
});

test('laptop trainer: pull and push stream files through ssh + tar (fake ssh running the command locally)', async () => {
  const root = tmpDir();
  const bin = path.join(root, 'bin'), home = path.join(root, 'server-home'), here = path.join(root, 'laptop');
  fs.mkdirSync(bin); fs.mkdirSync(path.join(home, 'bot/data/models'), { recursive: true }); fs.mkdirSync(path.join(home, 'bot/data/recordings'), { recursive: true });
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/bash\nfor a; do cmd="$a"; done\nHOME="${home}" exec bash -c "$cmd"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(home, 'bot/data/recordings/md-2026-10-06.jsonl'), 'a\n');
  fs.writeFileSync(path.join(home, 'bot/data/models/pipeline_state.json'), '{}');
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const srv = new Server({ host: 'h', user: 'u', port: 22, key: 'k' });
    const m = srv.run(`cd ~/bot/data && find . -type f -printf '%P\\t%s\\t%T@\\n'`);
    assert.ok(m.ok, m.err);
    const need = filesToPull(parseManifest(m.out), localManifest(here));
    assert.equal(need.length, 2);
    assert.ok(await srv.pull('~/bot/data', need.map((f) => f.path), here));
    assert.equal(fs.readFileSync(path.join(here, 'recordings/md-2026-10-06.jsonl'), 'utf8'), 'a\n');
    assert.equal(filesToPull(parseManifest(srv.run(`cd ~/bot/data && find . -type f -printf '%P\\t%s\\t%T@\\n'`).out), localManifest(here)).length, 0, 'second pull: nothing new');
    fs.mkdirSync(path.join(here, 'models/archive/ta_net'), { recursive: true });
    fs.writeFileSync(path.join(here, 'models/archive/ta_net/v1.json'), '{"v":1}');
    assert.ok(await srv.push(path.join(here, 'models'), ['archive/ta_net/v1.json'], '~/bot/data/models'));
    assert.equal(fs.readFileSync(path.join(home, 'bot/data/models/archive/ta_net/v1.json'), 'utf8'), '{"v":1}');
    assert.equal(filesToPull(parseManifest(srv.run(`cd ~/bot/data && find . -type f -printf '%P\\t%s\\t%T@\\n'`).out), localManifest(here)).length, 0, 'a pushed file keeps its time: the next pull does not copy it back');
  } finally { process.env.PATH = oldPath; }
});

test('the trainer\'s own Python and PyTorch are never compared with the server\'s files', () => {
  const d = tmpDir();
  for (const f of ['python-env/Lib/x.py', 'python-dist/cpython/python.exe', 'uv-cache/w.whl', 'models/python-env/y', 'a.txt']) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), '');
  }
  assert.deepEqual([...localManifest(d, LOCAL_ONLY_DIRS).keys()].sort(), ['a.txt', 'models/python-env/y']);
  assert.equal(localManifest(d).size, 5);
});

test('the TA network\'s row cache is never copied down; the laptop\'s own tournament is kept once it has one', () => {
  const srv = parseManifest(['models/work/tanet-cache/BTC.json\t10\t2000', 'models/work/tanet-cache/BTC.f32\t99\t2000', 'models/work/tanet-cache/torch-pack/meta.json\t5\t2000', 'models/work/tanet-population.json\t50\t2000', 'models/ta_net.json\t7\t2000'].join('\n'));
  const older = (p: string) => [p, { path: p, size: 1, mtime: 1_000_000 }] as const;
  assert.deepEqual(filesToPull(srv, new Map([older('models/work/tanet-population.json'), older('models/ta_net.json')])).map((f) => f.path), ['models/ta_net.json'], 'server copies are newer, but the cache and the laptop\'s tournament stay');
  assert.deepEqual(filesToPull(srv, new Map()).map((f) => f.path), ['models/work/tanet-population.json', 'models/ta_net.json'], 'a laptop without a tournament starts from the server\'s');
});

test('trainer state: a full round counts once its history and replay finished (also when stopped later); remembered between runs', () => {
  const done = (step: string, skipped?: string) => ({ step, ok: true, ...(skipped ? { skipped } : {}) });
  assert.equal(fullRoundDone([done('history'), done('history_replay'), done('snn', 'stop requested')]), true, 'stopped after the replay');
  assert.equal(fullRoundDone([done('history'), done('history_replay', 'stop requested')]), false, 'stopped before the replay');
  assert.equal(fullRoundDone([done('history', 'HISTORY_AUTO_UPDATE=false'), done('history_replay', 'HISTORY_REPLAY=false')]), true, 'turned off counts as done');
  assert.equal(fullRoundDone([{ step: 'history', ok: false }, done('history_replay')]), false);
  assert.equal(fullRoundDone([done('history_replay')], ['history_replay']), true, 'no-download mode needs the replay only');
  const dir = tmpDir();
  assert.deepEqual(readTrainerState(dir), {});
  writeTrainerState(dir, { lastFullAt: 123 });
  assert.equal(readTrainerState(dir).lastFullAt, 123);
});

test('Kalshi sweeps: off unless ticked (the kalshi and bot targets leave SWEEP_TARGETS; the others stay)', () => {
  const off = kalshiSweeps({ SWEEP_TARGETS: 'setups-long,kalshi,bot,setups-vol' }, false);
  assert.equal(off.SWEEP_TARGETS, 'setups-long,setups-vol');
  assert.equal(kalshiSweeps({ SWEEP_TARGETS: 'setups-long,kalshi' }, true).SWEEP_TARGETS, 'setups-long,kalshi');
  const dflt = kalshiSweeps({}, false).SWEEP_TARGETS!.split(',');
  assert.ok(dflt.length > 0 && !dflt.includes('kalshi') && !dflt.includes('bot') && dflt.includes('setups-long'));
  const dataDir = tmpDir();
  assert.equal(readSettings(dataDir).kalshiSweep, false, 'off by default');
  writeSettings(dataDir, { ...readSettings(dataDir), kalshiSweep: true });
  assert.equal(readSettings(dataDir).kalshiSweep, true, 'kept for the next run');
});
