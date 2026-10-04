import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_FEES } from '../bot/fees';
import { IndexTracker } from '../bot/marketdata/indexTracker';
import { OrderBook } from '../bot/marketdata/orderBook';
import { AsiaRangeTracker, computeFeatureMap, FeatureContext, MicroTracker } from '../bot/model/featureEngine';
import { fairValue } from '../bot/model/fairValue';
import { sessionAt, sessionState, zoneTime } from '../bot/model/sessions';
import { huntBlockedBySession, parseSessionRisk, sessionRiskFor } from '../bot/model/sessionRisk';
import { BUCKETS_PER_DAY, effectiveSigma, fitVolProfile, seasonalVarianceRatio, type VolProfile } from '../bot/model/volSeasonality';
import { ConfluenceRatchetExit } from '../bot/strategy/exitPolicies';
import { validateVolProfile } from '../research/sessions';

const T = (iso: string) => Date.parse(iso);

test('sessions follow local exchange hours through US and UK daylight-saving changes', () => {
  // Summer (EDT/BST): NYSE opens 13:30 UTC, London open -> overlap.
  assert.equal(sessionAt(T('2026-07-15T13:30:00Z')), 'london_ny_overlap');
  // Winter (EST/GMT): 13:30 UTC is before the NYSE open -> London only.
  assert.equal(sessionAt(T('2026-01-15T13:30:00Z')), 'london');
  assert.equal(sessionAt(T('2026-01-15T14:30:00Z')), 'london_ny_overlap');
  // March 2026 gap: US on EDT (from Mar 8), UK still on GMT (until Mar 29).
  assert.equal(sessionAt(T('2026-03-16T13:30:00Z')), 'london_ny_overlap');
  assert.equal(sessionAt(T('2026-03-16T16:30:00Z')), 'new_york');
  // Twilight after the NY close, Asia from the Tokyo open, weekends in UTC.
  assert.equal(sessionAt(T('2026-07-15T20:30:00Z')), 'twilight');
  assert.equal(sessionAt(T('2026-07-16T00:30:00Z')), 'asia');
  assert.equal(sessionAt(T('2026-09-26T12:00:00Z')), 'weekend');
});

test('session state reports transitions, the US-open window and Monday Asia open', () => {
  const s = sessionState(T('2026-07-15T13:40:00Z'));
  assert.equal(s.usOpenWindow, true);
  assert.equal(s.since, T('2026-07-15T13:30:00Z'));
  assert.equal(s.next?.key, 'new_york');
  assert.equal(s.next?.at, T('2026-07-15T15:30:00Z')); // London closes 16:30 BST
  assert.ok(Math.abs(s.minutesSinceTransition - 10) < 1e-9);
  assert.equal(sessionState(T('2026-07-15T14:10:00Z')).usOpenWindow, false);
  assert.equal(sessionState(T('2026-09-28T01:00:00Z')).mondayAsiaOpen, true);
  assert.equal(sessionState(T('2026-09-29T01:00:00Z')).mondayAsiaOpen, false);
  assert.equal(zoneTime(T('2026-07-15T13:30:00Z'), 'America/New_York').hhmm, '09:30');
});

test('session risk profile: validated, reduce-only, stricter value wins in the US-open window', () => {
  assert.throws(() => parseSessionRisk('{"asia":{"sizeMult":1.5}}'), /sizeMult/);
  assert.throws(() => parseSessionRisk('{"mars":{}}'), /unknown session/);
  const p = parseSessionRisk('{"london_ny_overlap":{"sizeMult":0.8,"minEdgeAdd":0.005},"us_open":{"sizeMult":0.5,"minEdgeAdd":0.01}}');
  const inOpen = sessionRiskFor(p, sessionState(T('2026-07-15T13:40:00Z')));
  assert.deepEqual({ s: inOpen.sizeMult, e: inOpen.minEdgeAdd }, { s: 0.5, e: 0.01 });
  assert.deepEqual(inOpen.applied, ['london_ny_overlap', 'us_open']);
  const later = sessionRiskFor(p, sessionState(T('2026-07-15T14:40:00Z')));
  assert.equal(later.sizeMult, 0.8);
  assert.equal(sessionRiskFor({}, sessionState(T('2026-07-15T14:40:00Z'))).sizeMult, 1);
});

test('hunt guard blocks twilight, weekend and the minutes around session changes', () => {
  assert.match(huntBlockedBySession(sessionState(T('2026-07-15T21:00:00Z')), 10)!, /twilight/);
  assert.match(huntBlockedBySession(sessionState(T('2026-09-26T12:00:00Z')), 10)!, /weekend/);
  assert.match(huntBlockedBySession(sessionState(T('2026-07-15T13:25:00Z')), 10)!, /min to/);
  assert.match(huntBlockedBySession(sessionState(T('2026-07-15T13:35:00Z')), 10)!, /min into/);
  assert.equal(huntBlockedBySession(sessionState(T('2026-07-15T14:45:00Z')), 10), undefined);
});

test('an active hunt takes its locked profit at the bid when the session turns unsafe', () => {
  const b = new OrderBook('T');
  b.applySnapshot({ bids: [{ price: 0.6, size: 8 }], asks: [{ price: 0.63, size: 10 }] }, 0);
  const h = new ConfluenceRatchetExit({ targetMargin: 0.02, minConfluence: 2 });
  const up = (o: object) => h.update({ position: 5, qSide: 0.55, sideBid: 0.6, confluence: 3, book: b, now: 0, tick: 0.01, fees: DEFAULT_FEES, ...o });
  up({ sideBid: 0.5, confluence: 0 });
  assert.equal(up({ sessionBlocked: 'weekend liquidity' }).mode, 'fair_value', 'cannot activate while blocked');
  assert.equal(up({}).mode, 'hunt');
  const d = up({ sessionBlocked: 'twilight liquidity' });
  assert.equal(d.event, 'profit_take_session');
  assert.deepEqual([d.plan?.side, d.plan?.price], ['ask', 0.6]);
});

// ---- Intraday volatility profile ---------------------------------------------

function seasonalReturns(days: number, nyBoost = 2): Array<{ ts: number; asset: string; r: number }> {
  let seed = 11;
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const out: Array<{ ts: number; asset: string; r: number }> = [];
  const start = T('2026-06-01T00:00:00Z'); // Monday
  for (let m = 0; m < days * 1440; m++) {
    const ts = start + m * 60_000;
    const k = sessionState(ts).key;
    const sd = (k === 'new_york' || k === 'london_ny_overlap' ? nyBoost : 1) * 0.001;
    out.push({ ts, asset: 'BTC', r: sd * gauss() });
  }
  return out;
}

test('fitted profile recovers higher variance during New York hours', () => {
  const p = fitVolProfile(seasonalReturns(10));
  const a = p.assets.BTC;
  assert.equal(a.weekday.length, BUCKETS_PER_DAY);
  const nyBucket = a.weekday[Math.floor((11 * 60) / 30)];   // 11:00 ET
  const nightBucket = a.weekday[Math.floor((22 * 60) / 30)]; // 22:00 ET
  assert.ok(nyBucket / nightBucket > 2.5, `ratio ${nyBucket / nightBucket}`); // true variance ratio 4, shrunk
});

test('seasonal ratio raises sigma ahead of a high-volatility window and is clamped', () => {
  const flat = new Array(BUCKETS_PER_DAY).fill(1);
  const spikey = flat.map((_, i) => (i === 19 ? 6 : 1)); // 09:30-10:00 ET bucket
  const p: VolProfile = { version: 't', tz: 'America/New_York', bucketMinutes: 30, fittedAt: '', assets: { '*': { weekday: spikey, weekend: flat, days: 30 } } };
  const now = T('2026-07-15T13:25:00Z'); // 09:25 ET, contract closes 09:40 ET
  const r = seasonalVarianceRatio(p, 'BTC', now, now + 15 * 60_000, 866);
  assert.ok(r > 1.5 && r <= 2, `ratio ${r}`);
  assert.ok(effectiveSigma(1e-4, p, 'BTC', now, now + 15 * 60_000) > 1.2e-4);
  assert.equal(effectiveSigma(1e-4, undefined, 'BTC', now, now + 1), 1e-4);
});

test('validation re-prices rows; a flat profile changes nothing', () => {
  const flat = new Array(BUCKETS_PER_DAY).fill(1);
  const p: VolProfile = { version: 't', tz: 'America/New_York', bucketMinutes: 30, fittedAt: '', assets: { '*': { weekday: flat, weekend: flat, days: 1 } } };
  const rows = [99.6, 100.1, 100.5].map((spot, i) => ({
    t: T('2026-07-15T14:00:00Z'), ticker: 'X', asset: 'BTC', window: T('2026-07-15T14:10:00Z'), tauSec: 600,
    fv: fairValue({ spot, strike: 100, sigmaPerSqrtSec: 2e-4, tauSec: 600 })!.pYes, // as the dataset stores it
    mid: 0.5, bid: 0.49, ask: 0.51, sigma: 2e-4, spot, strike: 100, fx: {}, label: (i % 2) as 0 | 1, labelSource: 'official' as const,
  }));
  const v = validateVolProfile(p, rows);
  assert.ok(Math.abs(v.brierWith - v.brierWithout) < 1e-12);
});

// ---- Session features --------------------------------------------------------

function ctxAt(now: number, over: Partial<FeatureContext> = {}): FeatureContext {
  const book = new OrderBook('T');
  book.applySnapshot({ bids: [{ price: 0.5, size: 10 }], asks: [{ price: 0.52, size: 10 }] }, now);
  const index = new IndexTracker('BTC');
  for (let s = 600; s >= 0; s--) index.add(60000, now - s * 1000);
  return { now, fairValue: 0.5, mid: 0.51, tauSec: 600, sigmaPerSqrtSec: 1e-4, referenceSigma: 1e-4, inWindow: false, book, index, asset: 'BTC', ...over };
}

test('session one-hots are mutually exclusive and match the session clock', () => {
  for (const iso of ['2026-07-15T13:40:00Z', '2026-07-15T21:00:00Z', '2026-07-16T02:00:00Z', '2026-09-26T12:00:00Z']) {
    const f = computeFeatureMap(ctxAt(T(iso)));
    const hot = ['sess_asia', 'sess_london', 'sess_overlap', 'sess_new_york', 'sess_twilight', 'sess_weekend'].filter((k) => f[k] === 1);
    assert.equal(hot.length, 1, iso);
  }
  assert.equal(computeFeatureMap(ctxAt(T('2026-07-15T13:40:00Z'))).us_open_window, 1);
  assert.ok(Number.isNaN(computeFeatureMap(ctxAt(T('2026-07-15T13:40:00Z'))).vol_season_ratio), 'NaN without a profile');
});

test('Asian range: built during Asia, used in London/NY, breakout flagged', () => {
  const tr = new AsiaRangeTracker();
  const open = T('2026-07-16T00:00:00Z'); // Tokyo 09:00 Thursday
  for (let m = 0; m < 7 * 60; m += 1) tr.onIndex(60000 + 100 * Math.sin(m / 30), open + m * 60_000); // range ~59900..60100
  const idx = new IndexTracker('BTC');
  const now = T('2026-07-16T09:00:00Z'); // London
  for (let s = 60; s >= 0; s--) idx.add(60250, now - s * 1000);
  const f = computeFeatureMap(ctxAt(now, { index: idx, asiaRange: tr }));
  assert.equal(f.asia_range_break, 1);
  assert.ok(f.asia_range_pos > 1);
  // Still inside the Asian session: not available yet.
  assert.ok(Number.isNaN(computeFeatureMap(ctxAt(open + 3 * 3_600_000, { asiaRange: tr })).asia_range_pos));
});

test('Hawkes-style excitation rises with a burst of trades', () => {
  const c = ctxAt(T('2026-07-15T15:00:00Z'));
  const micro = new MicroTracker();
  for (let i = 0; i < 20; i++) micro.onTrade(2, 'yes', c.now - 290_000 + i * 14_000); // steady
  const steady = computeFeatureMap({ ...c, micro }).hawkes_excitation;
  for (let i = 0; i < 20; i++) micro.onTrade(5, 'yes', c.now - 5_000 + i * 200); // burst
  const burst = computeFeatureMap({ ...c, micro }).hawkes_excitation;
  assert.ok(burst > steady + 1, `steady ${steady} burst ${burst}`);
});
