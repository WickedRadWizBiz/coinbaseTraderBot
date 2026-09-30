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
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40), DATA_DIR: dir, SPOT_FEED: 'false', DOMINANCE_FEED: 'false', PERPS_FEED: 'false', TA_CANDLES: 'false' });
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
  for (let s = 1200; s >= 0; s -= 1) md.onDominance({ usdtd: 4.8 * Math.exp(-1e-6 * (1200 - s) + 1e-5 * (s % 5)), btcd: 55 + 0.001 * (s % 11), ts: now - s * 1000 });
  for (let i = 0; i < 15; i++) emit('trade', { ticker: T, price: 0.52, count: 2 + i, takerSide: i % 3 ? 'yes' : 'no', ts: now - 40_000 + i * 2000 });
  rec.close();
  await new Promise((r) => setTimeout(r, 100));

  const st = new ReplayState();
  for await (const e of readRecordings(recDir)) st.apply(e);

  const base = { now, fairValue: 0.56, mid: 0.525, tauSec: 200, sigmaPerSqrtSec: 1e-4, referenceSigma: 1e-4, inWindow: false };
  const live = computeFeatureMap({ ...base, book: md.book(T), micro: md.features.micro.get(T), index: md.index.get('BTC')!, spot: md.spot.get('BTC'), asset: 'BTC', usdtd: md.usdtd, btcd: md.btcd });
  const replay = computeFeatureMap({ ...base, book: st.book(T), micro: st.features.micro.get(T), index: st.index.get('BTC')!, spot: st.spot.get('BTC'), asset: 'BTC', usdtd: st.usdtd, btcd: st.btcd });
  for (const k of ALL_FEATURES) {
    const a = live[k], b = replay[k];
    assert.ok((Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-12, `${k}: live ${a} vs replay ${b}`);
  }
  assert.ok(Number.isFinite(live.ofi_30s) && Number.isFinite(live.tfi_60s), 'microstructure features populated');
  assert.ok(Number.isFinite(live.usdtd_ret_5m_z) && Number.isFinite(live.btcd_ret_15m_z), 'macro features populated');
});

import { agree } from '../bot/model/featureEngine';
import { explain, MetaModel } from '../bot/model/metaModel';

function domTracker(now: number, seconds: number, drift: number, start = 5): IndexTracker {
  const t = new IndexTracker('D', 90 * 60_000, 300);
  let seed = 3;
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let s = seconds; s >= 0; s--) t.add(start * Math.exp(-drift * s + 0.00002 * (rand() - 0.5)), now - s * 1000);
  return t;
}

test('agree(): fires only when all factors share a sign, signed by direction', () => {
  assert.ok(Math.abs(agree(2, 8) - 4) < 1e-12);
  assert.ok(Math.abs(agree(-2, -8) + 4) < 1e-12);
  assert.equal(agree(2, -8), 0);
  assert.equal(agree(0, 3), 0);
  assert.ok(Number.isNaN(agree(1, NaN)));
});

test('macro and confluence features: USDT.D falling + index rising + oversold RSI', () => {
  const base = ctx();
  const now = base.now;
  // Index: long decline (oversold on 1m RSI) then a sharp 60s bounce.
  const idx = new IndexTracker('BTC');
  for (let s = 1800; s >= 0; s--) {
    const v = s > 60 ? 60000 * Math.exp(-2e-5 * (1800 - s)) : 60000 * Math.exp(-2e-5 * 1740) * Math.exp(3e-4 * (60 - s) / 60);
    idx.add(v, now - s * 1000);
  }
  const usdtdFalling = domTracker(now, 3600, -2e-6); // falling over time
  const f = computeFeatureMap({ ...base, index: idx, asset: 'BTC', usdtd: usdtdFalling, btcd: domTracker(now, 3600, 0, 55) });
  assert.ok(f.usdtd_ret_5m_z < 0, `usdtd z ${f.usdtd_ret_5m_z}`);
  assert.ok(f.rsi_14_1m < -0.5, `rsi ${f.rsi_14_1m}`);
  assert.ok(f.ret_60s_z > 0);
  assert.ok(f.conf_riskon_momentum_rsi > 0, `conf3 ${f.conf_riskon_momentum_rsi}`);
  assert.ok(Number.isFinite(f.conf_count));
  // Same picture but USDT.D RISING: the three-way confluence switches off.
  const g = computeFeatureMap({ ...base, index: idx, asset: 'BTC', usdtd: domTracker(now, 3600, 2e-6), btcd: domTracker(now, 3600, 0, 55) });
  assert.equal(g.conf_riskon_momentum_rsi, 0);
});

test('BTC.D is oriented per asset: rising BTC.D is bullish for BTC, bearish for alts', () => {
  const base = ctx();
  const btcdUp = domTracker(base.now, 3600, 2e-6, 55);
  const forBtc = computeFeatureMap({ ...base, asset: 'BTC', btcd: btcdUp });
  const forEth = computeFeatureMap({ ...base, asset: 'ETH', btcd: btcdUp });
  assert.ok(forBtc.btcd_rel_5m_z > 0 && forEth.btcd_rel_5m_z < 0);
  assert.ok(Math.abs(forBtc.btcd_rel_5m_z + forEth.btcd_rel_5m_z) < 1e-12);
});

test('macro features are NaN without dominance data', () => {
  const f = computeFeatureMap(ctx());
  for (const k of ['usdtd_ret_5m_z', 'btcd_ret_5m_z', 'conf_riskon_momentum', 'conf_macro_pair']) assert.ok(Number.isNaN(f[k]), k);
});

test('explain() attributes the model shift to the confluence feature that caused it', () => {
  const feats = ['logit_fv', 'conf_riskon_momentum_rsi', 'spread'];
  const m = MetaModel.fromJson(JSON.stringify({
    version: 't', kind: 'mlp', features: feats, referenceSigma: 1e-4, residualFeature: 0,
    normalization: { mean: [0, 0, 0.03], std: [1, 1, 0.01] },
    layers: [{ weights: [[0, 0.4, 0]], bias: [0], activation: 'linear' }],
  }));
  const map = { logit_fv: 0, conf_riskon_momentum_rsi: 1.5, spread: 0.05 };
  const e = explain(m, map, 0.5);
  assert.ok(Math.abs(e.shiftFromFairValue - 0.6) < 1e-9);
  assert.equal(e.drivers[0].feature, 'conf_riskon_momentum_rsi');
  assert.ok(Math.abs(e.drivers[0].logitContribution - 0.6) < 1e-9);
});
