// Dashboard controls: PLAY / STOP (persisted, blocks new entries, cancels resting orders) and the
// PAPER / LIVE switch (validated, rewrites bot.env, restarts); the env-file editor; the latency registry.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApi, type ApiDeps } from '../bot/api/server';
import { loadConfig } from '../bot/config';
import { RunControl } from '../bot/control';
import { updateEnvFile } from '../bot/util/envFile';
import { latencySnapshot, recordLatency } from '../bot/util/latency';

async function serve(env: Record<string, string>, extra: Partial<ApiDeps> = {}) {
  const cfg = loadConfig(env);
  const base0 = { cfg, startedAt: Date.now(), audit: { write: () => undefined }, ...extra } as unknown as ApiDeps;
  const deps = new Proxy(base0, { get: (t, k) => (k in t ? (t as any)[k] : undefined) });
  const srv = createApi(deps).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api`;
  const post = async (p: string, body: unknown) => { const r = await fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() as any }; };
  return { post, close: () => srv.close() };
}

test('env file editor: rewrites keys in place, appends new ones, keeps comments and permissions', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'env-')), 'bot.env');
  fs.writeFileSync(f, '# comment\nTRADING_MODE=paper\nPORT=3000\n', { mode: 0o600 });
  updateEnvFile(f, { TRADING_MODE: 'live', KALSHI_ENV: 'prod' });
  assert.equal(fs.readFileSync(f, 'utf8'), '# comment\nTRADING_MODE=live\nPORT=3000\nKALSHI_ENV=prod\n');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});

test('PLAY / STOP: persisted, stopping cancels resting orders', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-'));
  const control = new RunControl(path.join(dir, 'control.json'));
  let cancelled = 0;
  const s = await serve({}, { control, oms: { cancelAll: async () => { cancelled++; } } as never });
  try {
    const r = await s.post('/run', { active: false });
    assert.equal(r.json.run.active, false);
    assert.equal(cancelled, 1);
    assert.equal(new RunControl(path.join(dir, 'control.json')).active, false, 'survives a restart');
    assert.equal((await s.post('/run', { active: true })).json.run.active, true);
  } finally { s.close(); }
});

test('PAPER / LIVE: live needs the confirmation and settings that would start; then bot.env is rewritten and the bot restarts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-'));
  const envFile = path.join(dir, 'bot.env');
  fs.writeFileSync(envFile, 'TRADING_MODE=paper\n', { mode: 0o600 });
  let restarts = 0;
  const s = await serve({ BOT_ENV_FILE: envFile }, { restart: () => { restarts++; } });
  const saved = { ...process.env };
  try {
    assert.equal((await s.post('/mode', { mode: 'live' })).status, 400, 'no double-tap confirmation');
    const noKeys = await s.post('/mode', { mode: 'live', confirm: 'LIVE' });
    assert.equal(noKeys.status, 400);
    assert.match(noKeys.json.error, /KALSHI_KEY_ID/);
    assert.equal(fs.readFileSync(envFile, 'utf8'), 'TRADING_MODE=paper\n', 'nothing written when the switch would fail');
    const key = path.join(dir, 'key.pem');
    fs.writeFileSync(key, 'x', { mode: 0o600 });
    process.env.KALSHI_KEY_ID = 'k'; process.env.KALSHI_PRIVATE_KEY_PATH = key;
    const ok = await s.post('/mode', { mode: 'live', confirm: 'LIVE' });
    assert.equal(ok.status, 200);
    const text = fs.readFileSync(envFile, 'utf8');
    assert.match(text, /TRADING_MODE=live/); assert.match(text, /KALSHI_ENV=prod/); assert.match(text, /LIVE_TRADING_ACKNOWLEDGED=I_ACCEPT_REAL_MONEY_RISK/);
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(restarts, 1);
  } finally { process.env = saved; s.close(); }
});

test('latency registry: smoothed per channel, null when stale', () => {
  recordLatency('kalshiWs', 100, 1000); recordLatency('kalshiWs', 200, 2000);
  assert.equal(latencySnapshot(3000).kalshiWs, 120);
  assert.equal(latencySnapshot(1000 + 400_000).kalshiWs, null);
});
