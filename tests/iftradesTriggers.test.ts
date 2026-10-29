import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoinTriggers, gradeHorizons, IFTRADES_TRIGGERS } from '../research/iftradesTriggers';
import { triggerContracts } from '../research/taContractStudy';
import type { DatasetRow } from '../research/buildDataset';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 5);

/** 1-minute bars following a close path. */
const bars = (closes: number[]) => closes.map((c, i) => ({ ts: T0 + i * MIN, o: c, h: c * 1.0005, l: c * 0.9995, c, v: 1 }));

test('iftrades triggers: a sharp drop fires the dip buys and the RSI extremes at the next bar close, with the mirror on a rise', () => {
  // Nine flat days, then a 5% fall over the last four hours.
  const n = 9 * DAY / MIN;
  const closes = Array.from({ length: n }, (_, i) => (i < n - 240 ? 100 : 100 * (1 - 0.05 * (i - (n - 240)) / 240)));
  const c = new CoinTriggers(bars(closes));
  const t = T0 + n * MIN;
  const f = c.at(t);
  for (const k of IFTRADES_TRIGGERS) assert.ok(k in f, k);
  assert.equal(f.if_dip_2_1h, 0, 'the last hour alone fell 1.3%'); assert.equal(f.if_dip_2_4h, 1); assert.equal(f.if_dip_3_4h, 1); assert.equal(f.if_dip_4_4h, 1); assert.equal(f.if_dip_2_1d, 1); assert.equal(f.if_dip_3_1w, 1);
  assert.equal(f.if_rsi20_15m, 1, 'RSI(14) on 15m bars is near zero after a one-way fall');
  assert.equal(f.if_rsi20_5m, 1);
  assert.equal(f.if_px_sma72h, -1, 'the close sits below its 72-hour average');
  // Before the fall nothing fired.
  const before = c.at(T0 + (n - 300) * MIN);
  assert.equal(before.if_dip_2_1h, 0); assert.equal(before.if_rsi20_15m, 0);
  // Mirror image: a 5% rise.
  const up = new CoinTriggers(bars(closes.map((x, i) => (i < n - 240 ? 100 : 200 - x))));
  const g = up.at(t);
  assert.equal(g.if_dip_3_4h, -1); assert.equal(g.if_rsi20_15m, -1); assert.equal(g.if_px_sma72h, 1);
  // The look-up never peeks: asking at a time before any bar closed gives NaN, not a value.
  assert.ok(Number.isNaN(c.at(T0 + 3 * MIN).if_rsi20_1h));
});

test('iftrades triggers: horizon grades read the forward spot path in the firing direction and skip overlapping firings', () => {
  const n = 3 * DAY / MIN;
  // Flat, a 3% fall over one hour (fires dip_2_1h with side +1), then a 3% recovery over the next hour, then flat.
  const closes = Array.from({ length: n }, (_, i) => {
    const a = DAY / MIN, b = a + 60, d = b + 60;
    if (i < a) return 100; if (i < b) return 100 * (1 - 0.03 * (i - a) / 60); if (i < d) return 97 * (1 + 0.03 * (i - b) / 60); return 99.91;
  });
  const coins = new Map([['BTC', new CoinTriggers(bars(closes))]]);
  const g = gradeHorizons(coins, [60]).find((x) => x.trigger === 'if_dip_2_1h' && x.side === 1 && x.horizonMin === 60)!;
  assert.ok(g.n >= 1 && g.n <= 3, `${g.n} non-overlapping firings on the 15m grid across the hour after the fall`);
  assert.ok(g.meanBps > 0, 'the recovery is a gain for the dip buy');
});

test('iftrades triggers: the contract table takes one row per contract and compares Up share with the fair value', () => {
  const row = (window: number, t: number, label: 0 | 1, trig: number): DatasetRow => ({ t, ticker: `X-${window}`, asset: 'BTC', window, tauSec: 900, fv: 0.5, mid: 0.5, bid: 0.49, ask: 0.51, sigma: 1e-4, spot: 100, strike: 100, label, labelSource: 'computed', fx: { if_rsi20_15m: trig } } as unknown as DatasetRow);
  const rows: DatasetRow[] = [];
  for (let w = 0; w < 10; w++) { rows.push(row(w, w * 1000, 1, 1)); rows.push(row(w, w * 1000 + 60, 1, 0)); }
  for (let w = 10; w < 14; w++) rows.push(row(w, w * 1000, 0, -1));
  const t = triggerContracts(rows);
  const up = t.find((x) => x.trigger === 'if_rsi20_15m' && x.side === 1)!, dn = t.find((x) => x.trigger === 'if_rsi20_15m' && x.side === -1)!;
  assert.equal(up.contracts, 10); assert.equal(up.upShare, 1); assert.ok(up.z > 3);
  assert.equal(dn.contracts, 4); assert.equal(dn.upShare, 0);
  assert.equal(t.find((x) => x.trigger === 'if_dip_2_1h' && x.side === 1)!.contracts, 0);
});
