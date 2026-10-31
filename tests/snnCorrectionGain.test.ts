import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CorrectionGain, replayGain } from '../bot/snn/correctionGain';
import { Xoshiro128 } from '../bot/snn/rng';

type Row = { eventKey: string; column: string; ts: number; kind: string; mid: number; volRatio: number; pSnn: number; y: 0 | 1 };
const brier = (p: number, y: number) => (p - y) ** 2;

/** Rows whose SNN correction is the truth in quiet markets and twice the truth (overcorrecting) in high volatility. */
function rows(n: number, seed = 5): Row[] {
  const r = new Xoshiro128(seed), out: Row[] = [];
  for (let i = 0; i < n; i++) {
    const mid = 0.3 + 0.4 * r.next(), edge = 0.1 * r.normal(), truth = Math.min(0.97, Math.max(0.03, mid + edge));
    const hot = i % 3 === 0, y: 0 | 1 = r.next() < truth ? 1 : 0;
    out.push({ eventKey: `E${i}`, column: 'BTC-15m', ts: i * 60_000, kind: 'greater', mid, volRatio: hot ? 2 : 1, pSnn: mid + (hot ? 2 : 1) * (truth - mid), y });
  }
  return out;
}

test('correction gain: learns about 1/2 where the SNN overcorrects 2x and about 1 where it is right', () => {
  const g = new CorrectionGain({ forget: 1, prior: 50 });
  for (const x of rows(8000)) g.update({ mid: x.mid, volRatio: x.volRatio, horizonMin: 15, kind: x.kind }, x.pSnn, x.y);
  const hot = g.gain({ mid: 0.5, volRatio: 2, horizonMin: 15, kind: 'greater' }), calm = g.gain({ mid: 0.5, volRatio: 1, horizonMin: 15, kind: 'greater' });
  assert.ok(Math.abs(hot - 0.5) < 0.15, `hot ${hot}`);
  assert.ok(Math.abs(calm - 1) < 0.2, `calm ${calm}`);
});

test('correction gain: with no data it trusts the SNN as is (gain 1) and stays inside its bounds', () => {
  const g = new CorrectionGain();
  assert.equal(g.gain({ mid: 0.9, volRatio: 3, horizonMin: 15, kind: 'updown' }), 1);
  const h = new CorrectionGain({ forget: 1, prior: 1, max: 3 });
  for (let i = 0; i < 500; i++) h.update({ mid: 0.5, volRatio: 1, horizonMin: 60, kind: 'greater' }, 0.49, 1); // always wrong way
  assert.equal(h.gain({ mid: 0.5, volRatio: 1, horizonMin: 60, kind: 'greater' }), 0);
});

test('correction gain replay: causal (an outcome is used only after its contract settles) and improves Brier on an overcorrecting SNN', () => {
  const rs = rows(6000);
  const out = replayGain(rs, { forget: 0.9995, prior: 200 });
  // The first row of every 15m window cannot have seen its own outcome: flipping all outcomes after row k changes nothing before.
  const k = 3000, flipped = rs.map((r, i) => (i >= k ? { ...r, y: (1 - r.y) as 0 | 1 } : r));
  const out2 = replayGain(flipped, { forget: 0.9995, prior: 200 });
  for (let i = 0; i < k + 14; i++) assert.equal(out2[i].pSnn, out[i].pSnn, `row ${i} saw the future`);
  assert.notEqual(out2[k + 40].pSnn, out[k + 40].pSnn);
  const raw = rs.reduce((s, r) => s + brier(r.pSnn, r.y), 0), gained = out.reduce((s, r) => s + brier(r.pSnn, r.y), 0);
  assert.ok(gained < raw, `gained ${gained} raw ${raw}`);
});
