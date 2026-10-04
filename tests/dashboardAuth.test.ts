// Dashboard login: open without DASHBOARD_PASSWORD, password-protected with it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApi, type ApiDeps } from '../bot/api/server';
import { loadConfig } from '../bot/config';

async function serve(env: Record<string, string>) {
  const cfg = loadConfig(env);
  // /auth answers before any route touches the engine; the stub fails loudly if a test reaches further.
  const deps = new Proxy({ cfg, startedAt: Date.now() } as unknown as ApiDeps, { get: (t, k) => (k in t ? (t as any)[k] : new Proxy({}, { get: () => { throw new Error(`unexpected ${String(k)}`); } })) });
  const srv = createApi(deps).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api`;
  return { base, close: () => srv.close() };
}

test('no password: no login required, DASHBOARD_TOKEN is not needed', async () => {
  const cfg = loadConfig({});
  assert.equal(cfg.dashboardPassword, '');
  const s = await serve({});
  try {
    assert.deepEqual(await (await fetch(`${s.base}/auth`)).json(), { required: false });
  } finally { s.close(); }
});

test('with DASHBOARD_PASSWORD: routes need it as the bearer', async () => {
  const s = await serve({ DASHBOARD_PASSWORD: 'hunter2' });
  try {
    assert.deepEqual(await (await fetch(`${s.base}/auth`)).json(), { required: true });
    assert.equal((await fetch(`${s.base}/status`)).status, 401);
    assert.equal((await fetch(`${s.base}/status`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  } finally { s.close(); }
});
