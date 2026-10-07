import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { test } from 'node:test';
import { filesToPull, filesToPush, laptopProfile, localManifest, parseManifest, safeServerEnv, Server } from '../research/laptopTrain';
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
});

test('laptop trainer: the server settings it trains with carry no credentials or server paths; budgets grow', () => {
  const env = safeServerEnv('KALSHI_API_KEY_ID=abc\nKALSHI_PRIVATE_KEY_PATH=/home/ubuntu/.kalshi/k.pem\nDASHBOARD_PASSWORD=hunter2\nSTRATEGY_MIN_EDGE=0.03\nDATA_DIR=/home/ubuntu/bot/data\nTRADING_MODE="paper"\n# comment\n');
  assert.deepEqual(env, { STRATEGY_MIN_EDGE: '0.03', TRADING_MODE: 'paper' });
  const p = laptopProfile(12);
  assert.equal(p.AUTO_TRAIN_CHAMPION, 'true');
  assert.equal(p.SWEEP_HOURS, '3');
  assert.ok(Number(p.KALSHI_HISTORY_DAYS) >= 365);
  const q = laptopProfile(12, 16);
  assert.equal(q.TRAIN_WORKERS, '15');
  assert.equal(q.AUTO_TRAIN_SNN_PBT_POPULATION, '15');
  assert.equal(laptopProfile(12, 2).AUTO_TRAIN_SNN_PBT_POPULATION, '3', 'never fewer than the original three');
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
  } finally { process.env.PATH = oldPath; }
});
