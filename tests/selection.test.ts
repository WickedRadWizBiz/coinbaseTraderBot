// Tournament selection (research/selection.ts): era-robust ranking, real-transition scoring, the PBO gate.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_ROBUST, pboGate, populationVariance, robustScore, tournamentPbo, transitionPenalty, transitionsOf } from '../research/selection';

const H = 3_600_000, D = 86_400_000;

test('era-robust score: steady beats spiky at the same mean; a short history is not favoured; worst-k', () => {
  const steady = [0.2, 0.22, 0.18, 0.21, 0.19, 0.2], spiky = [0.9, -0.5, 0.8, -0.4, 0.6, -0.2];
  const pv = populationVariance([steady, spiky], 6);
  assert.ok(robustScore(steady, pv) > robustScore(spiky, pv));
  // One great block: shrunk toward the population's spread, it does not outrank a steady six-block record.
  assert.ok(robustScore([0.25], pv) < robustScore(steady, pv) + 0.05);
  assert.ok(robustScore([0.25], pv) < 0.25);
  // Only the window counts.
  assert.equal(robustScore([-9, ...steady], pv), robustScore(steady, pv));
  // Worst-k: the mean of the two worst blocks.
  assert.ok(Math.abs(robustScore(spiky, pv, { ...DEFAULT_ROBUST, worstK: 2 }) - (-0.45)) < 1e-12);
  assert.equal(robustScore([], pv), -Infinity);
});

test('transitions: confirmed changes only (a one-label flicker is not a transition)', () => {
  const l = (keys: string[]) => keys.map((key, i) => ({ ts: i * D, key }));
  assert.deepEqual(transitionsOf(l(['calm', 'calm', 'trending', 'calm', 'trending', 'trending', 'trending']), 'BTC').map((t) => [t.ts / D, t.from, t.to, t.asset]), [[4, 'calm', 'trending', 'BTC']]);
  assert.deepEqual(transitionsOf(l(['a', 'b', 'b', 'c', 'c']), undefined, 2).map((t) => t.to), ['b', 'c']);
});

test('transition penalty: drawdown and turnover after each transition, per coin; sitting it out costs nothing', () => {
  const t0 = 10 * D;
  const tr = [{ ts: t0, asset: 'BTC', from: 'calm', to: 'trending' }, { ts: t0 + 5 * D, asset: 'ETH', from: 'trending', to: 'calm' }];
  const xs = [
    { ts: t0 + H, ret: 0.01, cost: 0.001, group: 'BTC' },
    { ts: t0 + 2 * H, ret: -0.03, cost: 0.001, group: 'BTC' },   // peak 0.01 -> -0.02: drawdown 0.03
    { ts: t0 + 3 * H, ret: 0.05, cost: 0.001, group: 'ETH' },    // another coin: not this transition's
    { ts: t0 + 30 * H, ret: -0.2, cost: 0.001, group: 'BTC' },   // after the 24 h window
  ];
  const p = transitionPenalty(xs, tr, { windowMs: 24 * H, ddWeight: 2, costWeight: 2, from: 0, to: 30 * D, assetOf: (x) => x.group });
  assert.equal(p.transitions, 2);
  assert.ok(Math.abs(p.meanDd - 0.03 / 2) < 1e-12, `${p.meanDd}`);
  assert.ok(Math.abs(p.meanCost - 0.002 / 2) < 1e-12);
  assert.ok(Math.abs(p.penalty - (2 * 0.015 + 2 * 0.001)) < 1e-12);
  assert.equal(transitionPenalty([], tr, { windowMs: 24 * H, ddWeight: 2, costWeight: 2, from: 0, to: 30 * D }).penalty, 0);
  assert.equal(transitionPenalty(xs, tr, { windowMs: 24 * H, ddWeight: 2, costWeight: 2, from: 20 * D, to: 30 * D }).transitions, 0, 'none in the window');
});

test('PBO: pure noise reads around one half; a member that is truly better reads low; the gate', () => {
  let x = 3; const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32) - 0.5;
  const log = (edge: number) => Array.from({ length: 32 }, () => ({ ranking: Array.from({ length: 6 }, (_, m) => ({ member: m, fitness: rnd() + (m === 0 ? edge : 0) })) }));
  const noise = tournamentPbo(log(0));
  assert.ok(noise.pbo > 0.2 && noise.pbo < 0.8, `${noise.pbo}`);
  const real = tournamentPbo(log(1.5));
  assert.ok(real.pbo < 0.05, `${real.pbo}`);
  assert.equal(real.rounds, 32); assert.equal(real.members, 6);
  assert.equal(pboGate(real).ok, true);
  assert.equal(pboGate({ pbo: 0.4, rounds: 32 }).ok, false);
  const short = tournamentPbo(log(0).slice(0, 3));
  assert.ok(Number.isNaN(short.pbo));
  assert.equal(pboGate(short).ok, true, 'not measurable yet: reported, not blocking');
});

test('tournament: rounds are ranked on the era-robust score of each lineage; clones inherit the block history', async () => {
  const { runPbt, walkForwardRounds } = await import('../research/pbt');
  const rounds = walkForwardRounds(0, 12 * 30 * D, 30 * D, 30 * D, 30 * D);
  // Fitness by the member's kind: steady, spiky (alternating), bad.
  const fit = (kind: string, r: number) => (kind === 'steady' ? 0.2 : kind === 'spiky' ? (r % 2 === 0 ? 0.9 : -0.5) : -0.3);
  const run = (robust?: false) => runPbt<{ kind: string }>({
    base: { k: 1 }, spec: { k: { min: 0.1, max: 10 } }, rounds, population: 3, seed: 1, ...(robust === false ? { robust: false } : {}),
    hooks: {
      init: (_h, m) => ({ kind: ['steady', 'spiky', 'bad'][m] }),
      clone: (s) => ({ ...s }),
      train: (s) => s,
      evaluate: (s, _h, r) => ({ report: { fitness: fit(s.kind, r.index), sortino: 0, maxDrawdown: 0, costs: 0, netReturn: 0, interactions: 0, independent: 0, days: 30 }, interactions: [] }),
    },
  });
  const res = await run();
  for (const e of res.log) {
    const rs = e.ranking.map((x) => x.robust!);
    assert.ok(rs.every((v, i) => i === 0 || v <= rs[i - 1] + 1e-12), `round ${e.round}: ${rs}`);
  }
  // Blocks: every member carries one per round of its lineage (clones take the donor's).
  assert.ok(res.members.every((m) => m.blocks!.length === rounds.length), res.members.map((m) => m.blocks!.length).join());
  // Without it, each round is ranked on its own fitness.
  const plain = await run(false);
  for (const e of plain.log) { const f = e.ranking.map((x) => x.fitness); assert.ok(f.every((v, i) => i === 0 || v <= f[i - 1])); assert.equal(e.ranking[0].robust, undefined); }
});
