// Connecting the setup trader to the rest of the bot: TA network inputs (masking), the volatility trail,
// the walk-forward forecast lookup, the setup journal and the self-activating SNN gate, and the
// gzipped recordings every reader must handle.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adaptToVol, VOL_ADAPT, type SetupSignal } from '../bot/setups/detectors';
import { applyMask, CHAR_SETUP_KEYS, characterFeatures, maskedIndices, SETUP_BASE_FEATURES, SETUP_FEATURES, tanetFeatures, TANET_SETUP_KEYS } from '../bot/setups/features';
import { readJournalTrades, SetupJournal, type JournalTrade } from '../bot/setups/journal';
import { compressOldRecordings, recordingDayList, recordingFiles, recordingLines } from '../bot/marketdata/recordingFiles';
import { OosIndex } from '../research/taNetOos';
import { studySnnGate, SNN_GATE_MIN_TRADES } from '../research/setupSnnStudy';
import { readRecordings } from '../research/replay';

const H = 3_600_000;
const sig = (o: Partial<SetupSignal> = {}): SetupSignal => ({ asset: 'BTC', lane: 'fast', kind: 'burst', tf: '1h', dir: 1, ts: 0, ref: 100, stop: 98, atr: 1, plan: { trailAtr: 3, maxBars: 16, trailFromStart: true }, info: { rsi: 60, pctB: 0.8, flow: 0.6, bandwidth: 0.05, volRatio: 2 }, ...o });

test('setup features: TA network and character inputs sit after the candle inputs and are blanked unless their group is on', () => {
  assert.deepEqual(SETUP_FEATURES.slice(SETUP_BASE_FEATURES.length), [...TANET_SETUP_KEYS, ...CHAR_SETUP_KEYS]);
  const m: Record<string, number> = {};
  tanetFeatures(m, -1, { up1: 0.6, up4: 0.3, vol: 0.2 });
  assert.ok(Math.abs(m.tn_up1 - 0.1) < 1e-12 && Math.abs(m.o_tn_up1 + 0.1) < 1e-12, 'oriented by the side');
  assert.ok(Math.abs(m.o_tn_up4 - 0.2) < 1e-12);
  tanetFeatures(m, 1, undefined);
  assert.ok(Number.isNaN(m.tn_vol) && Number.isNaN(m.o_tn_up1));
  const off = maskedIndices([]), on = maskedIndices(['tanet', 'character']);
  assert.equal(off.length, TANET_SETUP_KEYS.length + CHAR_SETUP_KEYS.length);
  assert.equal(on.length, 0);
  assert.equal(maskedIndices(['tanet']).length, CHAR_SETUP_KEYS.length, 'tanet on: only the character group blanked');
  characterFeatures(m, { cls: 'trending', x: { rvPct: 0.4, corr: 0.5, hurst: 0.6, er: 0.35, adx: 28, bbRank: 0.5 } });
  assert.equal(m.ch_trending, 1); assert.equal(m.ch_calm, 0); assert.equal(m.ch_er, 0.35);
  characterFeatures(m, undefined);
  assert.ok(Number.isNaN(m.ch_trending) && Number.isNaN(m.ch_hurst));
  const x = SETUP_FEATURES.map((_, i) => i);
  const masked = applyMask(x, off);
  assert.ok(off.every((i) => Number.isNaN(masked[i])));
  assert.equal(masked[0], 0);
  assert.equal(x[off[0]], off[0], 'the input is not modified');
});

test('volatility trail: off by default; scales fast-lane trails by exp(k x vol), clamped; slow lane untouched', () => {
  assert.equal(VOL_ADAPT.trailK, 0);
  const s = sig();
  assert.equal(adaptToVol(s, 0.5), s);
  assert.equal(adaptToVol(s, 0.2, 1).plan.trailAtr, 3 * Math.exp(0.2));
  assert.equal(adaptToVol(s, 3, 1).plan.trailAtr, 3 * 1.5);
  assert.equal(adaptToVol(s, -3, 1).plan.trailAtr, 3 * 0.67);
  assert.equal(adaptToVol(s, NaN, 1), s);
  const slow = sig({ lane: 'slow', tf: '1d' });
  assert.equal(adaptToVol(slow, 0.5, 1), slow);
  assert.equal(s.plan.trailAtr, 3, 'the original signal is not modified');
});

test('walk-forward forecast lookup: the forecast made at the last hourly bar closed by t', () => {
  const ix = new OosIndex({ schema: '5', source: 'x', through: 0, assets: { BTC: [[10 * H, 0.6, 0.55, 0.1], [11 * H, 0.4, 0.45, -0.2]] } });
  assert.equal(ix.at('BTC', 12 * H)?.up1, 0.4, 'at 12:00 the bar that opened 11:00 has just closed');
  assert.equal(ix.at('BTC', 12 * H - 1)?.up1, 0.6, 'one ms before, only the 10:00 bar is closed');
  assert.equal(ix.at('BTC', 11 * H + 15 * 60_000)?.vol, 0.1, 'a 15m setup at 11:15 reads the 10:00 bar');
  assert.equal(ix.at('ETH', 12 * H), undefined);
  assert.equal(new OosIndex(undefined).at('BTC', 12 * H), undefined);
});

test('setup journal: opened and closed records join into trades with the readings at entry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
  const j = new SetupJournal(dir);
  const t0 = Date.UTC(2026, 9, 1, 12);
  j.signal({ ts: t0, asset: 'BTC', dir: 1, score: 0.9 });
  j.trade({ ts: t0, event: 'opened', asset: 'BTC', lane: 'fast', kind: 'burst', tf: '1h', dir: 1, entryTs: t0, snn_up1: 0.62, snn_up4: null, tn_up1: 0.55, tn_up4: 0.5, tn_vol: 0.1, pilot: true });
  j.trade({ ts: t0 + 86_400_000, event: 'closed', asset: 'BTC', lane: 'fast', kind: 'burst', tf: '1h', dir: 1, entryTs: t0, r: 1.5, usd: 3 });
  j.trade({ ts: t0, event: 'closed', asset: 'ETH', entryTs: 1, r: 1 }); // no opened record: ignored
  const ts = readJournalTrades(dir);
  assert.equal(ts.length, 1);
  assert.equal(ts[0].r, 1.5);
  assert.equal(ts[0].snn_up1, 0.62);
  assert.equal(ts[0].snn_up4, null);
  assert.equal(ts[0].pilot, true);
  assert.equal(fs.readdirSync(dir).length, 2, 'one file per UTC day');
});

test('SNN gate: collects until enough trades; switches on only when the trades it blocks lost money out of sample', () => {
  const mk = (n: number, f: (i: number) => { a: number; r: number }): JournalTrade[] => Array.from({ length: n }, (_, i) => {
    const { a, r } = f(i);
    return { asset: 'BTC', lane: 'fast', kind: 'burst', tf: '1h', dir: 1, entryTs: i * H, exitTs: i * H + 1, r, usd: r, tn_up1: null, tn_up4: null, tn_vol: null, snn_up1: 0.5 + a, snn_up4: null, snn_skill1: null, snn_skill4: null };
  });
  const few = studySnnGate(mk(SNN_GATE_MIN_TRADES - 1, () => ({ a: 0.1, r: 1 })));
  assert.equal(few.enabled, false);
  assert.match(few.reason, /collecting/);
  // Trades the SNN disagreed with lose, the others win: the gate turns on.
  const good = studySnnGate(mk(300, (i) => (i % 3 === 0 ? { a: -0.1, r: -1 + 0.01 * (i % 7) } : { a: 0.1, r: 0.8 + 0.01 * (i % 5) })));
  assert.equal(good.enabled, true, good.reason);
  assert.ok(good.minAgree && good.minAgree.fast > -0.1 && good.minAgree.fast <= 0.1);
  // No relation between agreement and outcome: stays off.
  const noise = studySnnGate(mk(300, (i) => ({ a: (i % 2 ? 0.1 : -0.1), r: (i * 7919) % 13 < 6 ? 1 : -1 })));
  assert.equal(noise.enabled, false, noise.reason);
});

test('recordings: old days are gzipped; listing, lines and replay read both forms', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  const now = Date.UTC(2026, 9, 10, 12);
  const write = (day: string, t: number) => fs.writeFileSync(path.join(dir, `md-${day}.jsonl`), `${JSON.stringify({ t, k: 'index', asset: 'BTC', value: 1 })}\n${JSON.stringify({ t: t + 1, k: 'index', asset: 'BTC', value: 2 })}\n`);
  write('2026-10-01', Date.UTC(2026, 9, 1)); write('2026-10-09', Date.UTC(2026, 9, 9)); write('2026-10-10', Date.UTC(2026, 9, 10));
  const done = await compressOldRecordings(dir, 2, now);
  assert.deepEqual(done, ['2026-10-01']);
  assert.ok(fs.existsSync(path.join(dir, 'md-2026-10-01.jsonl.gz')) && !fs.existsSync(path.join(dir, 'md-2026-10-01.jsonl')));
  assert.deepEqual(recordingDayList(dir), ['2026-10-01', '2026-10-09', '2026-10-10']);
  const lines: string[] = [];
  for await (const l of recordingLines(recordingFiles(dir)[0].file)) lines.push(l);
  assert.equal(lines.length, 2);
  let n = 0, last = 0;
  for await (const e of readRecordings(dir, '')) { n++; assert.ok(e.t >= last); last = e.t; }
  assert.equal(n, 6);
  assert.deepEqual(await compressOldRecordings(dir, 2, now), [], 'idempotent');
});
