import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import path from 'path';
import { test } from 'node:test';
import { loadConfig } from '../bot/config';
import type { KalshiRest } from '../bot/kalshi/rest';
import type { KalshiWs } from '../bot/kalshi/ws';
import { IndexTracker } from '../bot/marketdata/indexTracker';
import { MarketData, Recorder } from '../bot/marketdata/marketData';
import { OrderBook } from '../bot/marketdata/orderBook';
import { ALL_FEATURES, computeFeatureMap, FEATURES, FeatureContext, MicroTracker } from '../bot/model/featureEngine';
import { readRecordings, ReplayState } from '../research/replay';
import { tmpDir } from './helpers';

function trendingIndex(now: number, seconds: number, drift: number): IndexTracker {
  const t = new IndexTracker('BTC');
  for (let s = seconds; s >= 0; s--) t.add(60000 * Math.exp(-drift * s), now - s * 1000);
  return t;
}

function ctx(over: Partial<FeatureContext> = {}): FeatureContext {
  const now = Date.parse('2026-09-29T14:00:00Z');
  const book = new OrderBook('T');
  book.applySnapshot({ bids: [{ price: 0.5, size: 30 }, { price: 0.49, size: 10 }], asks: [{ price: 0.53, size: 10 }] }, now);
  return { now, fairValue: 0.55, mid: 0.515, tauSec: 300, sigmaPerSqrtSec: 2e-4, referenceSigma: 2e-4, inWindow: false, book, index: trendingIndex(now, 1800, 1e-5), ...over };
}

test('every registered feature is finite or NaN, never throws', () => {
  const f = computeFeatureMap(ctx());
  assert.deepEqual(Object.keys(f).sort(), [...ALL_FEATURES].sort());
  for (const [k, v] of Object.entries(f)) assert.ok(Number.isFinite(v) || Number.isNaN(v), k);
  // Microstructure and spot features are unavailable without their data.
  assert.ok(Number.isNaN(f.tfi_60s));
  assert.ok(Number.isNaN(f.spot_basis_bps));
});

test('momentum features point the right way on a rising index', () => {
  const f = computeFeatureMap(ctx());
  assert.ok(f.ret_60s_z > 0 && f.ret_300s_z > 0);
  assert.ok(f.rsi_60 > 0.9, `rsi ${f.rsi_60}`);
  assert.ok(f.kaufman_er_120 > 0.99);
  assert.ok(f.tenkan_dist > 0 && f.kijun_dist > 0);
  const down = computeFeatureMap(ctx({ index: trendingIndex(ctx().now, 1800, -1e-5) }));
  assert.ok(down.ret_60s_z < 0 && down.rsi_60 < -0.9);
});

test('momentum features are NaN when history is too short (no invented data)', () => {
  const f = computeFeatureMap(ctx({ index: trendingIndex(ctx().now, 100, 1e-5) }));
  assert.ok(Number.isFinite(f.ret_60s_z));
  assert.ok(Number.isNaN(f.ret_300s_z));
  assert.ok(Number.isNaN(f.kijun_dist));
});

test('order-flow imbalance, trade flow and VPIN', () => {
  const c = ctx();
  const book = new OrderBook('T');
  const micro = new MicroTracker();
  const t0 = c.now - 20_000;
  book.applySnapshot({ bids: [{ price: 0.5, size: 10 }], asks: [{ price: 0.53, size: 10 }] }, t0);
  micro.onBook(book, t0);
  book.applyDelta('bid', 0.5, 15, t0 + 1000); // bid size grows: buy pressure
  micro.onBook(book, t0 + 1000);
  book.applyDelta('bid', 0.51, 5, t0 + 2000); // bid steps up
  micro.onBook(book, t0 + 2000);
  for (let i = 0; i < 20; i++) micro.onTrade(3, i % 4 === 0 ? 'no' : 'yes', c.now - 50_000 + i * 2000);
  const f = computeFeatureMap({ ...c, book, micro });
  assert.ok(f.ofi_30s > 0, `ofi ${f.ofi_30s}`);
  assert.ok(Math.abs(f.tfi_60s - 0.5) < 1e-9, `tfi ${f.tfi_60s}`);
  assert.ok(f.vpin_300s >= 0 && f.vpin_300s <= 1);
  assert.ok(f.trade_intensity_60s > 0);
});

test('spot lead-lag features', () => {
  const c = ctx();
  const spot = trendingIndex(c.now, 60, 3e-5); // spot rising faster than the index
  const f = computeFeatureMap({ ...c, spot });
  assert.ok(f.spot_lead_10s_z > 0);
  assert.ok(Number.isFinite(f.spot_basis_bps));
});

test('every feature has a group and description', () => {
  for (const [k, v] of Object.entries(FEATURES)) assert.ok(v.group && v.description, k);
});

test('production and research replay compute identical features from the same events', async () => {
  const dir = tmpDir();
  const recDir = path.join(dir, 'rec');
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40), DATA_DIR: dir, SPOT_FEED: 'false' });
  const ws = Object.assign(new EventEmitter(), { connect() {}, close() {}, setMarkets() {} }) as unknown as KalshiWs;
  const rest = { getSeriesFees: async () => undefined, getOpenMarkets: async () => [] } as unknown as KalshiRest;
  const rec = new Recorder(recDir);
  const md = new MarketData(cfg, rest, ws, rec);
  md.start();
  const now = Date.now();
  const T = 'KXBTC15M-P';
  const emit = (ev: string, e: unknown) => (ws as unknown as EventEmitter).emit(ev, e);
  for (let s = 400; s >= 0; s--) emit('index', { indexId: 'BRTI', value: 60000 + (400 - s) * 0.7 + (s % 7), ts: now - s * 1000 });
  emit('book_snapshot', { ticker: T, bids: [{ price: 0.5, size: 20 }], asks: [{ price: 0.54, size: 12 }], ts: now - 30_000 });
  emit('book_delta', { ticker: T, side: 'bid', price: 0.51, delta: 6, ts: now - 20_000 });
  emit('book_delta', { ticker: T, side: 'ask', price: 0.54, delta: -4, ts: now - 10_000 });
  for (let i = 0; i < 15; i++) emit('trade', { ticker: T, price: 0.52, count: 2 + i, takerSide: i % 3 ? 'yes' : 'no', ts: now - 40_000 + i * 2000 });
  rec.close();
  await new Promise((r) => setTimeout(r, 100));

  const st = new ReplayState();
  for await (const e of readRecordings(recDir)) st.apply(e);

  const base = { now, fairValue: 0.56, mid: 0.525, tauSec: 200, sigmaPerSqrtSec: 1e-4, referenceSigma: 1e-4, inWindow: false };
  const live = computeFeatureMap({ ...base, book: md.book(T), micro: md.features.micro.get(T), index: md.index.get('BTC')!, spot: md.spot.get('BTC') });
  const replay = computeFeatureMap({ ...base, book: st.book(T), micro: st.features.micro.get(T), index: st.index.get('BTC')!, spot: st.spot.get('BTC') });
  for (const k of ALL_FEATURES) {
    const a = live[k], b = replay[k];
    assert.ok((Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-12, `${k}: live ${a} vs replay ${b}`);
  }
  assert.ok(Number.isFinite(live.ofi_30s) && Number.isFinite(live.tfi_60s), 'microstructure features populated');
});
