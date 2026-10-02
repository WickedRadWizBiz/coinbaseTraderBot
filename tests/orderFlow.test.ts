// Order flow and leverage-demand features: taker-buy volume (tb) through the history store (Binance
// column 10, donor enrichment, aggregation), the live Coinbase trade feed (buckets only reported when
// the feed covered the whole bar), the candle store, the imbalance features; perps funding delta and
// open-interest acceleration.
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { test } from 'node:test';
import { TakerFlowFeed } from '../bot/marketdata/takerFlow';
import { assetFeatureMap } from '../bot/model/featureEngine';
import { PerpHub } from '../bot/perps/perpData';
import { aggregate, CandleSet, fromRow, takerImbalance, toRow } from '../bot/ta/candleStore';
import type { Candle } from '../bot/ta/indicators';
import { aggregateCandles, loadSeries, readSeries, seriesPath, writeSeries } from '../research/history/candles';
import { parseCandleCsv } from '../research/history/csvFormats';

const H = 3_600_000, Q = 900_000;
const T0 = Date.UTC(2026, 0, 5);

test('taker imbalance: 2 tb / v - 1, NaN when any bar lacks the split', () => {
  const bars: Candle[] = [{ ts: 0, o: 1, h: 1, l: 1, c: 1, v: 10, tb: 8 }, { ts: H, o: 1, h: 1, l: 1, c: 1, v: 10, tb: 2 }];
  assert.ok(Math.abs(takerImbalance(bars.slice(0, 1)) - 0.6) < 1e-12);
  assert.equal(takerImbalance(bars), 0);
  assert.ok(Number.isNaN(takerImbalance([...bars, { ts: 2 * H, o: 1, h: 1, l: 1, c: 1, v: 5 }])));
  const r = toRow(bars[0]);
  assert.equal(r.length, 7);
  assert.equal(fromRow(r).tb, 8);
  assert.equal(toRow({ ts: 0, o: 1, h: 1, l: 1, c: 1, v: 1 }).length, 6);
});

test('history: Binance column 10 parsed, tb stored/read, aggregated, donated to bars without it', () => {
  const lines = Array.from({ length: 8 }, (_, k) => [T0 + k * H, 100, 101, 99, 100.5, 10, T0 + (k + 1) * H - 1, 1000, 50, 6 + (k % 2), 600, 0].join(','));
  const parsed = parseCandleCsv(lines.join('\n'), 'BTCUSDT-1h-2026-01.csv');
  assert.equal(parsed.candles[0].tb, 6);
  assert.equal(parsed.candles[1].tb, 7);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-'));
  const fb = seriesPath(dir, 'binance', 'BTC', '1h');
  writeSeries(fb, parsed.candles);
  assert.match(fs.readFileSync(fb, 'utf8').split('\n')[0], /,tb$/);
  assert.deepEqual(readSeries(fb).map((c) => c.tb), parsed.candles.map((c) => c.tb));
  const h4 = aggregateCandles(parsed.candles, H, 4 * H);
  assert.equal(h4[0].tb, 6 + 7 + 6 + 7);
  assert.equal(aggregate(parsed.candles, 4 * H)[0].tb, 26);
  // Coinbase bars (no split, different volume) take precedence but borrow Binance's taker-buy share.
  writeSeries(seriesPath(dir, 'coinbase', 'BTC', '1h'), parsed.candles.slice(0, 4).map((c) => ({ ts: c.ts, o: c.o, h: c.h, l: c.l, c: c.c, v: 20 })));
  const s = loadSeries(dir, 'BTC', '1h');
  assert.equal(s.candles[0].v, 20);
  assert.ok(Math.abs(s.candles[0].tb! - 12) < 1e-9, 'tb = 20 x 6/10');
  assert.equal(s.candles[5].tb, 7);
});

test('live trade feed: maker side sell = taker buy; only bars the feed fully covered are reported', () => {
  let now = T0 - 60_000;
  const f = new TakerFlowFeed(['BTC'], 'wss://example', () => now);
  f.onMessage({ type: 'subscriptions' });
  const iso = (t: number) => new Date(t).toISOString();
  for (let k = 0; k < 4; k++) {
    f.onMessage({ type: 'match', product_id: 'BTC-USD', size: '3', side: 'sell', time: iso(T0 + k * Q + 1000) });
    f.onMessage({ type: 'match', product_id: 'BTC-USD', size: '1', side: 'buy', time: iso(T0 + k * Q + 2000) });
  }
  f.onMessage({ type: 'match', product_id: 'ETH-USD', size: '5', side: 'sell', time: iso(T0 + 1000) });
  assert.equal(f.takerBuy('BTC', T0, H, 100), undefined, 'the bar has not closed yet');
  now = T0 + H + 1000;
  assert.equal(f.takerBuy('BTC', T0, H, 100), 75, 'candle volume x taker-buy share (3 of 4)');
  assert.equal(f.takerBuy('BTC', T0, Q, 8), 6);
  assert.equal(f.takerBuy('BTC', T0 + H, Q, 8), undefined, 'no trades counted');

  // Connected mid-bar: that bar is incomplete; the next one is fine.
  now = T0 + 5 * 60_000;
  const g = new TakerFlowFeed(['BTC'], 'wss://example', () => now);
  g.onMessage({ type: 'subscriptions' });
  g.onMessage({ type: 'match', product_id: 'BTC-USD', size: '1', side: 'sell', time: iso(T0 + 6 * 60_000) });
  g.onMessage({ type: 'match', product_id: 'BTC-USD', size: '1', side: 'buy', time: iso(T0 + Q + 1000) });
  now = T0 + 2 * Q + 1;
  assert.equal(g.takerBuy('BTC', T0, Q, 1), undefined);
  assert.equal(g.takerBuy('BTC', T0 + Q, Q, 10), 0);
});

test('candle store keeps feed tb across REST refreshes; imbalance features from candles', () => {
  const set = new CandleSet('BTC');
  const bars = Array.from({ length: 30 }, (_, k): Candle => ({ ts: T0 + k * H, o: 100, h: 101, l: 99, c: 100 + (k % 3), v: 10, tb: k < 29 ? 5 : 9 }));
  const now = T0 + 30 * H + 60_000;
  set.add('1h', bars, now);
  // A REST refresh of the last bar without the split keeps the feed's tb.
  set.add('1h', [{ ...bars[29], tb: undefined }], now);
  assert.equal(set.bars['1h']!.at(-1)!.tb, 9);
  assert.equal(set.bars['4h']!.at(-1)!.tb, 4 * 5, 'last complete 4h bar');
  const f = assetFeatureMap('BTC', now, { candles: set });
  assert.ok(Math.abs(f.ta_taker_imb_1h - 0.8) < 1e-12);
  assert.ok(Math.abs(f.ta_taker_imb_4h - (2 * 24 / 40 - 1)) < 1e-12);
  assert.ok(Number.isNaN(assetFeatureMap('BTC', now + 10 * H, { candles: set }).ta_taker_imb_1h), 'stale candles');
  assert.ok(Number.isNaN(f.ta_taker_imb_15m), 'no 15m bars');
});

test('perps: funding delta over 4 h and open-interest acceleration', () => {
  const hub = new PerpHub();
  const t0 = 1_800_000_000_000;
  for (let s = 0; s <= 5 * 3600; s += 10) {
    const ts = t0 + s * 1000;
    // Funding estimate rises 1 bp per hour; OI grows slowly for the first hours, then fast.
    const oi = s < 4 * 3600 ? 1000 + s / 100 : 1000 + 144 + (s - 4 * 3600) / 10;
    hub.apply({ ticker: 'BTC-PERP', asset: 'BTC', ts, bid: 100_000, ask: 100_010, openInterest: oi, fundingRate: 0.0001 + (s / 3600) * 0.0001 });
  }
  const st = hub.get('BTC')!;
  assert.ok(st.funding.length <= 601, `at most one funding point a minute (${st.funding.length})`);
  const now = t0 + 5 * 3600 * 1000;
  const f = assetFeatureMap('BTC', now, { perp: st });
  assert.ok(Math.abs(f.funding_delta_4h - 4) < 0.05, `funding delta ${f.funding_delta_4h}`);
  assert.ok(f.perp_oi_accel_1h > 0, `OI accelerating: ${f.perp_oi_accel_1h}`);
  assert.ok(Number.isNaN(assetFeatureMap('BTC', now, {}).funding_delta_4h));
});
