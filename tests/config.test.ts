import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { test } from 'node:test';
import { ConfigError, loadConfig, publicConfig } from '../bot/config';

const token = 'x'.repeat(40);

test('paper defaults are safe: loopback, demo, frozen', () => {
  const c = loadConfig({ DASHBOARD_TOKEN: token });
  assert.equal(c.mode, 'paper');
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.kalshiEnv, 'demo');
  assert.throws(() => { (c as any).mode = 'live'; });
  assert.throws(() => { (c.risk as any).maxContractsPerOrder = 1e6; });
});

test('dashboard login is optional (DASHBOARD_PASSWORD); no token needed', () => {
  assert.equal(loadConfig({}).dashboardPassword, '');
  assert.equal(loadConfig({ DASHBOARD_PASSWORD: ' pw ' }).dashboardPassword, 'pw');
});

test('refuses public bind unless explicitly allowed', () => {
  assert.throws(() => loadConfig({ DASHBOARD_TOKEN: token, BIND_HOST: '0.0.0.0' }), /loopback/);
  assert.equal(loadConfig({ DASHBOARD_TOKEN: token, BIND_HOST: '0.0.0.0', ALLOW_NON_LOOPBACK_BIND: 'true' }).host, '0.0.0.0');
});

test('live mode needs prod, credentials, a deploy-time acknowledgement, and no proxy index', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-'));
  const key = path.join(dir, 'k.pem');
  fs.writeFileSync(key, 'x', { mode: 0o600 });
  const base = { DASHBOARD_TOKEN: token, TRADING_MODE: 'live', KALSHI_KEY_ID: 'id', KALSHI_PRIVATE_KEY_PATH: key };
  assert.throws(() => loadConfig(base), /KALSHI_ENV=prod/);
  assert.throws(() => loadConfig({ ...base, KALSHI_ENV: 'prod' }), /LIVE_TRADING_ACKNOWLEDGED/);
  const ok = { ...base, KALSHI_ENV: 'prod', LIVE_TRADING_ACKNOWLEDGED: 'I_ACCEPT_REAL_MONEY_RISK' };
  assert.equal(loadConfig(ok).mode, 'live');
  assert.throws(() => loadConfig({ ...ok, ALLOW_PROXY_INDEX: 'true' }), /PROXY/);
  fs.chmodSync(key, 0o644);
  assert.throws(() => loadConfig(ok), /chmod 600/);
});

test('risk limits are range-checked and ordered', () => {
  assert.throws(() => loadConfig({ DASHBOARD_TOKEN: token, RISK_MAX_ORDER_FRAC: '0.5' }), ConfigError);
  assert.throws(() => loadConfig({ DASHBOARD_TOKEN: token, RISK_MAX_ORDER_FRAC: '0.04', RISK_MAX_WINDOW_FRAC: '0.03' }), ConfigError);
  assert.throws(() => loadConfig({ DASHBOARD_TOKEN: token, STRATEGY_SERIES: 'KXUNKNOWN' }), /asset mapping/);
});

test('public config redacts secrets', () => {
  const pc = JSON.stringify(publicConfig(loadConfig({ DASHBOARD_TOKEN: token, ALERT_TELEGRAM_TOKEN: 'secret-telegram' }) as any));
  assert.ok(!pc.includes(token));
  assert.ok(!pc.includes('secret-telegram'));
});
