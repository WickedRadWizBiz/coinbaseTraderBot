import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../bot/config';
import { RiskGateway } from '../bot/risk/riskGateway';
import { defaultTiers, tierAt, validateTiers } from '../bot/risk/sizingTiers';

const cfg = () => loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32) });

test('daily stop: the dollar ceiling scales with the tier and with the account instead of one flat number', () => {
  const c = cfg();
  const t = c.sizingTiers;
  assert.deepEqual(t.map((p) => p.dailyLossUsd), [4, 5, c.risk.dailyLossLimitUsd]);
  const gw = new RiskGateway(c.risk);
  const stop = (bank: number) => { const tier = tierAt(t, bank); return gw.dailyLossLimit(bank, { dailyLossLimitFrac: tier.dailyLossFrac, dailyLossLimitUsd: tier.dailyLossUsd }); };
  assert.equal(stop(20), 4);
  assert.equal(stop(50), 5);
  assert.ok(Math.abs(stop(100) - 3) < 1e-9, 'normal tier: 3% of $100');
  // Above the last tier the fraction binds: a $1,000 account risks 3% ($30), not a flat $5.
  assert.ok(Math.abs(stop(1000) - 30) < 1e-9, `${stop(1000)}`);
  // The ceiling itself grows with the high-water mark and is continuous at the boundaries.
  assert.ok(tierAt(t, 1000).dailyLossUsd > 10 * tierAt(t, 100).dailyLossUsd - 1e-9);
  assert.ok(Math.abs(tierAt(t, 49.99).dailyLossUsd - tierAt(t, 50.01).dailyLossUsd) < 0.01);
  assert.ok(Math.abs(tierAt(t, 99.99).dailyLossUsd - tierAt(t, 100.01).dailyLossUsd) < 0.01);
  // Custom ladders without the field get the fraction at their anchor.
  const old = validateTiers([{ ...defaultTiers(c)[0], bankroll: 40, dailyLossFrac: 0.1, dailyLossUsd: undefined as never }]);
  assert.equal(old[0].dailyLossUsd, 4);
});

import { DEFAULT_VAULT, Vault, vaultRamp } from '../bot/vault/vault';

test('vault graduation ramp: a $20 account keeps its wins to compound; skimming phases in to the full rate at $100', () => {
  const cfgV = { ...DEFAULT_VAULT };
  assert.equal(vaultRamp(cfgV, 12), 0);
  assert.equal(vaultRamp(cfgV, 20), 0);
  assert.equal(vaultRamp(cfgV, 100), 1);
  assert.equal(vaultRamp(cfgV, 5000), 1);
  const mid = vaultRamp(cfgV, 50);
  assert.ok(Math.abs(mid - Math.log(2.5) / Math.log(5)) < 1e-12 && mid > 0.5 && mid < 0.6, `${mid}`);
  assert.ok(vaultRamp(cfgV, 30) < vaultRamp(cfgV, 50) && vaultRamp(cfgV, 50) < vaultRamp(cfgV, 80), 'monotone');
  assert.equal(vaultRamp({ rampFullUsd: 0 }, 20), 1, 'ramp off');
  assert.equal(vaultRamp({}, 20), 1, 'unset = off');

  const t = Date.parse('2026-09-30T15:00:00Z');
  const v = new Vault(cfgV, undefined, () => t);
  v.onSettled(2, 'A', t, 20);
  assert.equal(v.vaultTotal, 0, 'nothing vaulted at the $20 start');
  assert.equal(v.reserved(), 0);
  assert.equal(v.status(t).events[0].kind, 'skip');
  v.onSettled(10, 'B', t, 50);
  assert.ok(Math.abs(v.vaultTotal - 0.5 * mid * 10) < 0.01, `vaulted ${v.vaultTotal}`);
  const before = v.vaultTotal;
  v.onSettled(10, 'C', t, 120);
  assert.ok(Math.abs(v.vaultTotal - before - 5) < 0.01, 'full 50% once graduated');
  assert.equal(v.status(t).ramp.lastFactor, 1);
  // A reference is optional (full rules, as before).
  const v2 = new Vault(cfgV, undefined, () => t);
  v2.onSettled(10, 'D', t);
  assert.equal(v2.vaultTotal, 5);
});

import { IndexTracker } from '../bot/marketdata/indexTracker';
import { fairValue } from '../bot/model/fairValue';

test('official settlement average: the mean of sixty one-per-second values, observable only as the marks pass', () => {
  const end = 1_800_000_060_000;
  const official = new IndexTracker('BTC');
  const continuous = new IndexTracker('BTC', undefined, undefined, 'continuous');
  // A print every 0.5 s: price = 100 + second-of-window, stepping mid-second as well.
  for (let ms = -62_000; ms <= 1_000; ms += 500) {
    const v = 100 + Math.max(0, Math.floor((ms + 60_000) / 1000));
    official.add(v, end + ms); continuous.add(v, end + ms);
  }
  // Marks are end-59s ... end; the value at the mark is the last print at or before it: 100 + (k) for mark k=1..60 -> 101..160.
  const full = official.settlement(end, end)!;
  assert.equal(full.n, 60);
  assert.equal(full.avg, (101 + 160) / 2);
  // Mid-window: only the marks that have passed count.
  const part = official.settlement(end, end - 30_500)!;
  assert.equal(part.n, 29);
  assert.equal(part.avg, (101 + 129) / 2);
  assert.equal(official.settlement(end, end - 61_000), undefined, 'no mark has passed yet');
  // The continuous mode is the old time-weighted average over the elapsed part.
  const c = continuous.settlement(end, end)!;
  assert.equal(c.n, 60);
  assert.ok(Math.abs(c.avg - continuous.average(end - 60_000, end)!.avg) < 1e-9);
  assert.ok(Math.abs(c.avg - full.avg) < 1.01, 'the two definitions differ by less than a second of drift');
  // A hole in the feed makes the window unusable rather than invented.
  const holey = new IndexTracker('BTC');
  for (let ms = -62_000; ms <= 0; ms += 500) if (ms < -30_000 || ms > -20_000) holey.add(100, end + ms);
  assert.equal(holey.settlement(end, end), undefined);
});

test('pricer: with discrete samples the observed count fixes that many of the sixty values', () => {
  const base = { strike: 100, sigmaPerSqrtSec: 1e-4 };
  // Half observed at 101 against a strike of 100: YES needs the rest to average >= 99 -> very likely.
  const half = fairValue({ ...base, spot: 101, tauSec: 30, observedAvg: 101, observedCount: 30 })!;
  assert.equal(half.regime, 'in_window');
  assert.ok(half.pYes > 0.99);
  // A thin cushion: the other 30 values must average >= 99.98 against a 0.03 sigma: likely, not certain.
  const thin = fairValue({ ...base, spot: 100, tauSec: 30, observedAvg: 100.02, observedCount: 30 })!;
  assert.ok(thin.pYes > 0.5 && thin.pYes < 0.99, `${thin.pYes}`);
  // A complete window is determined, with ties going to YES.
  assert.equal(fairValue({ ...base, spot: 100, tauSec: 0, observedAvg: 100, observedCount: 60 })!.pYes, 0.9999);
  assert.equal(fairValue({ ...base, spot: 100, tauSec: 0, observedAvg: 99.99, observedCount: 60 })!.regime, 'determined');
  // Without a count the continuous formula still applies (and agrees closely at mid-window).
  const cont = fairValue({ ...base, spot: 100, tauSec: 30, observedAvg: 100.02 })!;
  assert.ok(Math.abs(cont.pYes - thin.pYes) < 0.02, `${cont.pYes} vs ${thin.pYes}`);
});

import { ClockSkewMonitor } from '../bot/risk/clockSkew';
import { KalshiRest } from '../bot/kalshi/rest';

test('clock skew: Date-header intervals narrow the offset; halts only when confidently beyond the limit', () => {
  const t0 = 1_800_000_000_000;
  const feed = (m: ClockSkewMonitor, offset: number, n: number, start = t0) => {
    // The server clock is `offset` ms ahead; Date is truncated to the second; ~60 ms round trips at random phases.
    for (let i = 0; i < n; i++) {
      const sent = start + i * 7_300 + (i * 137) % 900;
      const recv = sent + 60;
      const serverNow = sent + 30 + offset;
      m.observe(Math.floor(serverNow / 1000) * 1000, sent, recv);
    }
  };
  const ok = new ClockSkewMonitor();
  feed(ok, 150, 40);
  const e = ok.estimate(t0 + 300_000)!;
  assert.ok(e.hi - e.lo < 400, `intervals intersect to ${e.hi - e.lo} ms`);
  assert.ok(Math.abs(e.offsetMs - 150) < 200, `${e.offsetMs}`);
  assert.equal(ok.haltReason(t0 + 300_000), undefined);

  const behind = new ClockSkewMonitor();
  feed(behind, 5_000, 6);
  assert.match(behind.haltReason(t0 + 60_000)!, /5\.\d s behind Kalshi/);
  const ahead = new ClockSkewMonitor();
  feed(ahead, -4_200, 6);
  assert.match(ahead.haltReason(t0 + 60_000)!, /ahead of Kalshi/);

  // A drift inside the limit only warns.
  const drift = new ClockSkewMonitor();
  feed(drift, 1_400, 10);
  assert.equal(drift.haltReason(t0 + 90_000), undefined);
  assert.match(drift.warning(t0 + 90_000)!, /drifting/);

  // One unlucky sample (1 s of header truncation + latency) is not enough to halt.
  const noisy = new ClockSkewMonitor();
  noisy.observe(t0 + 2_100, t0, t0 + 50); // offset somewhere in [2050, 3100]: confidently > 2000? lo = 2050 -> yes
  assert.ok(noisy.haltReason(t0 + 1000));
  const edge = new ClockSkewMonitor();
  edge.observe(t0 + 1_500, t0, t0 + 50); // [1450, 2500]: could be 1.5 s: no halt
  assert.equal(edge.haltReason(t0 + 1000), undefined);

  // The clock is stepped (NTP): old intervals no longer intersect, the newest win.
  const step = new ClockSkewMonitor();
  feed(step, 3_000, 8);
  feed(step, 0, 6, t0 + 70_000);
  const s = step.estimate(t0 + 140_000)!;
  assert.ok(Math.abs(s.offsetMs) < 600, `${s.offsetMs}`);
  // No verdict without recent data.
  assert.equal(behind.haltReason(t0 + 3_600_000), undefined);
  assert.equal(new ClockSkewMonitor().haltReason(t0), undefined);
});

test('REST reports each response Date header to the skew guard; responses without one are ignored', async () => {
  const seen: number[][] = [];
  const mk = (headers: Record<string, string>) => new KalshiRest({
    baseUrl: 'https://x.test/trade-api/v2',
    fetchImpl: (async () => new Response('{"markets":[]}', { status: 200, headers })) as unknown as typeof fetch,
    onServerDate: (d, s, r) => seen.push([d, s, r]),
  });
  await mk({ date: 'Wed, 30 Sep 2026 12:00:05 GMT' }).getOpenMarkets('KXBTC15M');
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], Date.parse('2026-09-30T12:00:05Z'));
  assert.ok(seen[0][2] >= seen[0][1]);
  await mk({}).getOpenMarkets('KXBTC15M');
  assert.equal(seen.length, 1);
});

import fs from 'fs';
import path from 'path';
import { MarketData, Recorder } from '../bot/marketdata/marketData';
import type { MarketInfo } from '../bot/kalshi/types';
import { ReplayState, readRecordings } from '../research/replay';
import { ladderQuotes } from '../bot/model/ladder';
import { tmpDir } from './helpers';

test('record-only series: recorded with results, never traded, never a ladder sibling', async () => {
  const dir = tmpDir();
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40), DATA_DIR: dir, DOMINANCE_FEED: 'false', SPOT_FEED: 'false', PERPS_FEED: 'false', TA_CANDLES: 'false', STRATEGY_SERIES: 'KXBTC15M', RECORD_SERIES: 'KXBTC15M,KXWEATHER,KXETH', TENNIS_ENABLED: 'false', RECORD_MAX_MARKETS: '2' });
  assert.deepEqual(cfg.strategy.recordSeries, ['KXBTC15M', 'KXWEATHER', 'KXETH']);
  const now = Date.now();
  const mk = (series: string, n: number, closeIn: number, extra: Partial<MarketInfo> = {}): MarketInfo => ({ ticker: `${series}-${n}`, seriesTicker: series, eventTicker: `${series}-E`, status: 'open', openTime: now - 60_000, closeTime: now + closeIn, tickSize: 0.01, ...extra });
  const catalog: Record<string, MarketInfo[]> = {
    KXBTC15M: [mk('KXBTC15M', 1, 600_000, { floorStrike: 60000 })],
    KXWEATHER: [mk('KXWEATHER', 1, 600_000), mk('KXWEATHER', 2, 600_000), mk('KXWEATHER', 3, 600_000)],
    KXETH: [mk('KXETH', 1, 600_000, { capStrike: 3000, floorStrike: 2900, strikeType: 'between' })],
  };
  const results = new Map<string, string>();
  const rest = {
    getSeriesFees: async () => ({ takerMultiplier: 1, makerMultiplier: 1 }),
    getOpenMarkets: async (s: string) => catalog[s] ?? [],
    getMarket: async (t: string) => ({ ...(Object.values(catalog).flat().find((m) => m.ticker === t)!), result: results.get(t) ?? '' }),
  } as never;
  const recDir = path.join(dir, 'rec');
  const md = new MarketData(cfg, rest, undefined, new Recorder(recDir));
  await md.refreshCatalog(now);
  const rec = [...md.markets.values()].filter((m) => m.recordOnly);
  assert.equal(rec.length, 2, 'capped at RECORD_MAX_MARKETS, and the traded series is not duplicated');
  assert.ok(md.markets.get('KXBTC15M-1') && !md.markets.get('KXBTC15M-1')!.recordOnly);
  assert.deepEqual(md.activeMarkets(now).map((m) => m.ticker), ['KXBTC15M-1'], 'only the traded series is tradable');
  assert.equal(md.recordedMarkets(now).length, 3);
  // Never a ladder sibling.
  assert.equal(ladderQuotes([...md.markets.values()], () => undefined, rec[0].asset, rec[0].closeTime).length, 0);
  // After close, the official result is fetched and recorded once.
  for (const m of rec) results.set(m.ticker, 'yes');
  await md.refreshCatalog(now + 700_000);
  await md.refreshCatalog(now + 700_000);
  md.stop();
  await new Promise((r) => setTimeout(r, 50));
  const ev: Array<Record<string, any>> = [];
  for await (const e of readRecordings(recDir)) ev.push(e);
  const market = ev.filter((e) => e.k === 'market' && e.recordOnly);
  assert.equal(market.length, 2);
  assert.equal(ev.filter((e) => e.k === 'result').length, 2, 'one result per record-only market');
  const st = new ReplayState();
  for (const e of ev) st.apply(e as never);
  assert.ok([...st.markets.values()].filter((m) => m.recordOnly).length === 2);
  assert.equal([...st.results.values()].filter((r) => r === 'yes').length, 2);
});

import { MetaModel } from '../bot/model/metaModel';
import { runBacktest } from '../research/backtest';
import { writeSyntheticRecordings } from '../research/synthetic';

test('backtest latency: orders and cancels arrive late against the later book and tape; cancels can lose the race', async () => {
  const dir = path.join(tmpDir(), 'rec');
  writeSyntheticRecordings(dir, { windows: 8, seed: 9, marketNoise: 0.05 });
  const c = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), STRATEGY_STYLE: 'both', STRATEGY_CADENCE: 'continuous' });
  const run = (latency?: { orderMs: number; cancelMs?: number; jitterMs?: number }) => runBacktest(dir, MetaModel.identity(), c.strategy, c.risk, 200, { exitPolicy: 'fair_value', latency });
  const base = await run();
  assert.equal(base.latency!.sent, 0, 'no latency by default: nothing is queued');
  assert.equal(base.latency!.cancelRaceFills, 0);
  // The synthetic tape prints once a second with that second's book (one instant, applied whole before the
  // bot acts): a cancel has to be in flight past the next second's print to lose the race.
  const slow = await run({ orderMs: 1500 });
  assert.ok(slow.latency!.sent > 100);
  assert.ok(slow.latency!.cancelRaceFills > 0, 'a quote the bot already cancelled still filled while the cancel was in flight');
  assert.ok(slow.latency!.cancelRaceContracts > 0);
  const slower = await run({ orderMs: 3000 });
  // The synthetic edge decays with delay: more latency, fewer and worse fills.
  assert.ok(base.pnl > slow.pnl && slow.pnl > slower.pnl, `${base.pnl} > ${slow.pnl} > ${slower.pnl}`);
  assert.ok(base.fills > slow.fills && slow.fills > slower.fills);
  // An independent cancel latency and seeded jitter: same inputs, same result.
  const j1 = await run({ orderMs: 800, cancelMs: 300, jitterMs: 600 });
  const j2 = await run({ orderMs: 800, cancelMs: 300, jitterMs: 600 });
  assert.deepEqual([j1.fills, j1.pnl, j1.latency!.cancelRaceFills], [j2.fills, j2.pnl, j2.latency!.cancelRaceFills]);
  assert.ok(Number.isFinite(j1.pnl));
});

test('recorder: messages that arrive after close() (sockets draining at shutdown) are dropped, not written to the ended stream', async () => {
  const dir = tmpDir();
  const rec = new Recorder(dir);
  rec.write('index', { asset: 'BTC', value: 1 });
  rec.close();
  const errors: unknown[] = [];
  const onErr = (e: unknown) => errors.push(e);
  process.on('uncaughtException', onErr);
  try {
    rec.write('index', { asset: 'BTC', value: 2 }); // used to emit ERR_STREAM_WRITE_AFTER_END: exit status 1
    await new Promise((r) => setTimeout(r, 50));
  } finally { process.off('uncaughtException', onErr); }
  assert.equal(errors.length, 0);
  const lines = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
});
