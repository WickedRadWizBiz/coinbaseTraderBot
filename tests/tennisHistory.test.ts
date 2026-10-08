import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { test } from 'node:test';
import { loadConfig } from '../bot/config';
import { DEFAULT_SNN, domainParams, stageFlags, withFlags } from '../bot/snn/params';
import { SnnNetwork } from '../bot/snn/network';
import { tennisColumnKey } from '../bot/snn/inputs';
import { buildHistoryReplay, replayTennisDays } from '../research/history/historyReplay';
import { downloadKalshiHistory, downloadKalshiTrades, loadKalshiHistory, loadKalshiTrades, parseTrade, retryAfterMs } from '../research/history/kalshiHistory';
import { readRecordings, ReplayState } from '../research/replay';
import { replaySnn } from '../research/snnReplay';
import { snnInteractions } from '../research/snnPbt';
import { buildTennisDataset } from '../research/trainTennisModel';

const TENNIS = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32) }).tennis;
const DAY0 = Date.parse('2026-03-02T00:00:00Z');
const MIN = 60_000;

test('kalshi trade tapes: both tiers, fixed-point fields, deduplicated, resumable; sports candles start an hour before the match', async () => {
  assert.deepEqual(parseTrade({ trade_id: 'a', created_time: '2026-03-02T12:00:05Z', yes_price_dollars: '0.6100', count_fp: '7.00', taker_side: 'no' }), [Date.parse('2026-03-02T12:00:05Z'), 0.61, 7, 0]);
  assert.deepEqual(parseTrade({ created_time: '2026-03-02T12:00:05Z', yes_price: 34, count: 2, taker_side: 'yes' })?.slice(1), [0.34, 2, 1], 'legacy cents');
  assert.equal(parseTrade({ created_time: '2026-03-02T12:00:05Z', yes_price_dollars: '0.5', count_fp: '1', taker_side: 'maybe' }), undefined);
  const now = Date.parse('2026-03-10T00:00:00Z');
  const start = Date.parse('2026-03-02T12:00:00Z');
  const mk = (t: string, close: string) => ({ ticker: t, event_ticker: 'KXATPMATCH-E1', title: 'Will Player A win the A vs B : Indian Wells match?', open_time: '2026-02-28T00:00:00Z', close_time: close, occurrence_datetime: '2026-03-02T12:00:00Z', result: 'yes', volume_fp: '500' });
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    const p = u.pathname;
    const body = p.endsWith('/historical/cutoff') ? { market_settled_ts: '2026-03-05T00:00:00Z', trades_created_ts: '2026-03-02T13:00:00Z' }
      : p.endsWith('/historical/markets') ? { markets: [mk('KXATPMATCH-E1-A', '2026-03-02T14:00:00Z')], cursor: '' }
        : p.endsWith('/markets') ? { markets: [], cursor: '' }
          : p.endsWith('/candlesticks') ? { candlesticks: [{ end_period_ts: start / 1000 + 60, yes_bid: { close_dollars: '0.6000' }, yes_ask: { close_dollars: '0.6200' } }] }
            : p.endsWith('/historical/trades') ? (u.searchParams.get('cursor')
              ? { trades: [{ trade_id: 't2', created_time: '2026-03-02T12:30:00Z', yes_price_dollars: '0.7000', count_fp: '3.00', taker_side: 'yes' }], cursor: '' }
              : { trades: [{ trade_id: 't1', created_time: '2026-03-02T12:10:00Z', yes_price_dollars: '0.6500', count_fp: '5.00', taker_side: 'yes' }], cursor: 'next' })
              : { trades: [{ trade_id: 't2', created_time: '2026-03-02T12:30:00Z', yes_price_dollars: '0.7000', count_fp: '3.00', taker_side: 'yes' }, { trade_id: 't3', created_time: '2026-03-02T13:40:00Z', yes_price_dollars: '0.9000', count_fp: '2.00', taker_side: 'no' }], cursor: '' };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
  }) as unknown as typeof fetch;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-'));
  await downloadKalshiHistory({ series: ['KXATPMATCH'], days: 30, out, fetchImpl, now, log: () => {} });
  const m = loadKalshiHistory(out, 'KXATPMATCH')[0];
  assert.equal(m.startTime, start);
  assert.match(m.title!, /Indian Wells/);
  const q = new URL(calls.find((u) => u.includes('/candlesticks'))!);
  assert.equal(Number(q.searchParams.get('start_ts')) * 1000, start - 3_600_000, 'candles from an hour before the match');
  const r = await downloadKalshiTrades({ series: ['KXATPMATCH'], out, fetchImpl, log: () => {} });
  assert.deepEqual([r.markets, r.trades], [1, 3], 'the overlap between the tiers is counted once');
  const tape = loadKalshiTrades(out, 'KXATPMATCH', ['2026-03-02']).get('KXATPMATCH-E1-A')!;
  assert.deepEqual(tape.map((t) => [t[1], t[2], t[3]]), [[0.65, 5, 1], [0.7, 3, 1], [0.9, 2, 0]]);
  const tq = new URL(calls.find((u) => u.includes('/historical/trades'))!);
  assert.equal(Number(tq.searchParams.get('min_ts')) * 1000, start - 120 * MIN, 'the tape from two hours before the start');
  const again = await downloadKalshiTrades({ series: ['KXATPMATCH'], out, fetchImpl, log: () => {} });
  assert.deepEqual([again.markets, again.skipped], [0, 1]);
});

/** Kalshi history of two settled matches on 2026-03-02 (markets with minute candles, and their tapes). */
function writeTennisHistory(dir: string) {
  let seed = 5;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const kal = path.join(dir, 'kalshi', 'KXATPMATCH');
  fs.mkdirSync(path.join(kal, 'trades'), { recursive: true });
  const lines: string[] = [], tapes: string[] = [];
  for (const [i, startH, winA] of [[1, 10, true], [2, 15, false]] as const) {
    const start = DAY0 + startH * 3_600_000, close = start + 150 * MIN;
    let p = 0.62;
    const path_: Array<[number, number]> = [];
    for (let t = start - 60 * MIN; t <= close; t += 20_000) {
      if (t > start) {
        const left = (close - t) / (close - start);
        const target = winA ? 0.99 : 0.01;
        p += (target - p) * (left < 0.15 ? 0.05 : 0.004) + (rnd() - 0.5) * 0.03;
        p = Math.min(0.98, Math.max(0.02, p));
      }
      path_.push([t, p]);
    }
    for (const side of ['A', 'B'] as const) {
      const pa = (x: number) => (side === 'A' ? x : 1 - x);
      const candles = path_.filter(([t]) => t % MIN === 0).map(([t, x]) => ({ ts: t, bidC: +Math.max(0.01, pa(x) - 0.01).toFixed(2), askC: +Math.min(0.99, pa(x) + 0.01).toFixed(2), last: +pa(x).toFixed(2), volume: 5 }));
      const ticker = `KXATPMATCH-M${i}-${side}`;
      lines.push(JSON.stringify({ ticker, series: 'KXATPMATCH', event: `KXATPMATCH-M${i}`, openTime: start - 2 * 86_400_000, closeTime: close, strike: null, cap: null, title: `Will Player ${side}${i} win the match ${i} at Indian Wells?`, startTime: start, result: (side === 'A') === winA ? 'yes' : 'no', candles }));
      tapes.push(JSON.stringify({ ticker, trades: path_.filter(([t]) => t > start - 30 * MIN).map(([t, x]) => [t + 7000, +pa(x).toFixed(2), 3, rnd() < 0.5 ? 1 : 0]) }));
    }
  }
  fs.writeFileSync(path.join(kal, '2026-03-02.jsonl'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(kal, 'trades', '2026-03-02.jsonl'), tapes.join('\n') + '\n');
}

test('tennis history replay: real matches with their tape, a book that follows each trade, results; the tennis model and network train on it', async () => {
  const hist = fs.mkdtempSync(path.join(os.tmpdir(), 'th-')), out = path.join(hist, 'replay');
  writeTennisHistory(hist);
  const r = await buildHistoryReplay({ historyDir: hist, outDir: out, assets: [], fromDay: '2026-03-02', toDay: '2026-03-03', tennisSeries: ['KXATPMATCH'], log: () => {} });
  assert.equal(r.tennis, 4, 'two matches, two markets each');
  assert.deepEqual(replayTennisDays(out), ['2026-03-02']);
  const st = new ReplayState();
  let trades = 0, followed = 0, usableBetweenTrades = 0, last = 0;
  const results: Record<string, string> = {};
  let lastTrade: Record<string, any> | undefined;
  for await (const e of readRecordings(out)) {
    assert.ok(e.t >= last); last = e.t;
    st.apply(e);
    if (e.k === 'trade') { trades++; lastTrade = e; }
    if (e.k === 'book' && lastTrade && lastTrade.t === e.t && lastTrade.ticker === e.ticker) {
      // A YES taker lifted the ask at the trade price; a NO taker hit the bid.
      if (lastTrade.takerSide === 'yes' ? e.asks[0].price === lastTrade.price : e.bids[0].price === lastTrade.price) followed++;
    }
    if (e.k === 'alive' && e.tickers.every((t: string) => st.books.get(t)?.isUsable(e.t, 10_000))) usableBetweenTrades++;
    if (e.k === 'result') results[e.ticker] = e.result;
  }
  const m = st.markets.get('KXATPMATCH-M1-A') ?? [...st.markets.values()][0];
  assert.ok(trades > 1000 && followed > 0.95 * trades, `trades ${trades}, book follows ${followed}`);
  assert.ok(usableBetweenTrades > 500, 'quotes stand between trades');
  assert.deepEqual(results, { 'KXATPMATCH-M1-A': 'yes', 'KXATPMATCH-M1-B': 'no', 'KXATPMATCH-M2-A': 'no', 'KXATPMATCH-M2-B': 'yes' });
  assert.ok(m === undefined || m.kind === 'match');

  // The tennis model's rows, built with the engine's own inputs, labelled by the results.
  const rows = await buildTennisDataset(out, TENNIS, 60);
  assert.equal(new Set(rows.map((x) => x.event)).size, 2);
  assert.ok(rows.length > 100 && rows.every((x) => x.y === 0 || x.y === 1));

  // The tennis network: one column per match, P(A wins) scored and settled; each ended match folds into the template.
  const params = domainParams('tennis', withFlags({ ...DEFAULT_SNN }, stageFlags('S5')));
  const res = await replaySnn(out, { params, domain: 'tennis', tennis: TENNIS, skipModel: true, fromDay: '2026-03-02', toDay: '2026-03-03' });
  assert.ok(res.rows.length > 100 && res.rows.every((x) => x.kind === 'match'), `rows ${res.rows.length}`);
  assert.deepEqual(new Set(res.rows.map((x) => x.ticker)), new Set(['KXATPMATCH-M1-A', 'KXATPMATCH-M2-A']), 'oriented to player A');
  assert.equal(res.net.tennisTemplate?.n, 2, 'both matches learned into the template');
  assert.equal(res.net.columns.size, 0, 'ended match columns are dropped');
  assert.ok(snnInteractions(res.rows, 'tennis').length <= 2, 'at most one bet per match');
});

test('tennis template: a new match starts from what earlier matches learned; it survives checkpoints and the model file', () => {
  const params = domainParams('tennis', withFlags({ ...DEFAULT_SNN }, stageFlags('S5')));
  const net = new SnnNetwork(params);
  const key = tennisColumnKey('KXATPMATCH-X'), t0 = DAY0;
  const values = { mid: 0.6, momentum: 0.02, flow: 0.3, depth: 0.1, progress: 0.2, modelPA: 0.6, spread: 0.02 };
  for (let k = 0; k < 120; k++) net.step(t0 + k * 1000, [{ key, asset: 'TENNIS', price: 0.6 + 0.001 * k, values: { ...values, mid: 0.6 + 0.001 * k } }]);
  net.score([{ ticker: 'X-A', mid: 0.7, column: key, kind: 'match', d: 0.8, lifeFrac: 0.5, spot: 0, sigma: 0, tauSec: 0, lifeSec: 0, eventKey: 'X-A', tag: true }], t0 + 120_000);
  net.settle('X-A', 'yes', t0 + 200_000);
  const learned = net.readouts.get(key)!.wf.slice();
  net.removeColumn(key);
  assert.equal(net.tennisTemplate?.n, 1);
  assert.deepEqual(Array.from(net.tennisTemplate!.wf), Array.from(learned));
  // The next match starts from it, not from the prior.
  const k2 = tennisColumnKey('KXATPMATCH-Y');
  net.step(t0 + 300_000, [{ key: k2, asset: 'TENNIS', price: 0.5, values: { ...values, mid: 0.5 } }]);
  assert.deepEqual(Array.from(net.readouts.get(k2)!.wf), Array.from(learned));
  assert.deepEqual(Array.from(net.columns.get(k2)!.arrays().w1), Array.from(net.tennisTemplate!.arrays.w1));
  assert.deepEqual(Array.from(net.columns.get(k2)!.arrays().src), Array.from(new SnnNetwork(params).column(key, 'TENNIS')!.arrays().src), 'every match column has the same wiring, so the weights fit');
  // Checkpoint and model file round trips.
  const back = new SnnNetwork(params);
  back.restore(net.serialize());
  assert.equal(back.tennisTemplate?.n, 1);
  assert.deepEqual(Array.from(back.tennisTemplate!.wf), Array.from(learned));
  const fromFile = new SnnNetwork(params, { model: JSON.parse(JSON.stringify(net.exportModel())) });
  assert.deepEqual(Array.from(fromFile.tennisTemplate!.arrays.w1), Array.from(net.tennisTemplate!.arrays.w1));
});

test('kalshi history: one pace for every worker; a 429 pauses them all, then the market is fetched (not failed)', async () => {
  assert.equal(retryAfterMs('2'), 2000);
  assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 7_000), 3000);
  assert.equal(retryAfterMs(null), 0);
  assert.equal(retryAfterMs('soon'), 0);
  const now = Date.parse('2026-03-10T00:00:00Z');
  const markets = Array.from({ length: 12 }, (_, i) => ({ ticker: `KXBTC15M-M${i}`, event_ticker: 'KXBTC15M-E', open_time: '2026-03-09T00:00:00Z', close_time: `2026-03-09T${String(10 + i).padStart(2, '0')}:00:00Z`, result: 'yes', volume_fp: '50' }));
  const starts: Array<{ t: number; limited: boolean }> = [];
  let candleCalls = 0;
  const fetchImpl = (async (url: string) => {
    const p = new URL(url).pathname;
    if (p.endsWith('/candlesticks')) {
      candleCalls++;
      const limited = candleCalls === 4;
      starts.push({ t: Date.now(), limited });
      if (limited) return { ok: false, status: 429, headers: new Headers(), json: async () => ({}), text: async () => '{"error":{"code":"too_many_requests"}}' } as unknown as Response;
    }
    const body = p.endsWith('/historical/cutoff') ? { market_settled_ts: '2026-01-01T00:00:00Z' }
      : p.endsWith('/historical/markets') ? { markets: [], cursor: '' }
        : p.endsWith('/markets') ? { markets, cursor: '' }
          : { candlesticks: [{ end_period_ts: now / 1000 - 86_400, yes_bid: { close_dollars: '0.5' }, yes_ask: { close_dollars: '0.52' } }] };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
  }) as unknown as typeof fetch;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-'));
  const logs: string[] = [];
  const r = await downloadKalshiHistory({ series: ['KXBTC15M'], days: 30, out, fetchImpl, now, concurrency: 3, ratePerSec: 50, log: (m) => logs.push(m) });
  assert.equal(r.markets, 12);
  assert.equal(r.failed, 0, 'the rate-limited market was retried, not failed');
  const hit = starts.find((s) => s.limited)!;
  const after = starts.filter((s) => s.t > hit.t);
  // Only requests the other two workers already had under way may start before the pause ends.
  const during = after.filter((s) => s.t - hit.t < 900);
  assert.ok(after.length >= 8 && during.length <= 2, `every new request waited out the pause: ${after.map((s) => s.t - hit.t).join(', ')}`);
  assert.ok(logs.some((l) => /slow down 1 time/.test(l)));
});
