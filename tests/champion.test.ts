import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { test } from 'node:test';
import { archiveModel, championDecision, promoteIfChampion, validatedParts } from '../research/champion';
import { calibrated, fitPlatt } from '../bot/ta/taNet';
import { blendVersions } from '../bot/ta/taNetEnsemble';
import { tmpDir } from './helpers';

test('champion: a worse retrain never replaces a better live model', () => {
  assert.equal(championDecision(undefined, { validatedParts: 0 }).promote, true, 'nothing live: promote');
  assert.equal(championDecision({ validatedParts: 1, score: 0.95 }, { validatedParts: 1, score: 0.97 }).promote, false, 'worse on the same data');
  assert.equal(championDecision({ validatedParts: 1, score: 0.97 }, { validatedParts: 0, score: 0.95 }).promote, true, 'same-data score decides over validated parts');
  assert.equal(championDecision({ validatedParts: 2 }, { validatedParts: 1 }).promote, false, 'fewer validated parts');
  assert.equal(championDecision({ validatedParts: 1 }, { validatedParts: 1 }).promote, true, 'tie: fresher data');
});

test('champion: promote archives the replaced model; a rejected candidate leaves the live file alone', () => {
  const dir = tmpDir();
  const live = path.join(dir, 'ta_net.json'), cand = path.join(dir, 'cand.json');
  const net = (version: string, validated: boolean[]) => JSON.stringify({ version, heads: Object.fromEntries(['up_1h', 'up_4h', 'vol_4h'].map((k, i) => [k, { validation: { validated: validated[i] } }])) });
  fs.writeFileSync(live, net('old', [false, false, true]));
  fs.writeFileSync(cand, net('weak', [false, false, false]));
  assert.equal(validatedParts('ta_net', live), 1);
  const no = promoteIfChampion({ dir, kind: 'ta_net', candidate: cand, live, enabled: true });
  assert.equal(no.promote, false);
  assert.match(fs.readFileSync(live, 'utf8'), /"old"/);
  fs.writeFileSync(cand, net('better', [true, false, true]));
  const yes = promoteIfChampion({ dir, kind: 'ta_net', candidate: cand, live, enabled: true });
  assert.equal(yes.promote, true);
  assert.match(fs.readFileSync(live, 'utf8'), /"better"/);
  assert.ok(yes.archived && fs.readFileSync(yes.archived, 'utf8').includes('"old"'), 'replaced model archived');
  // Gate off: the candidate always wins.
  fs.writeFileSync(cand, net('weak2', [false, false, false]));
  assert.equal(promoteIfChampion({ dir, kind: 'ta_net', candidate: cand, live, enabled: false }).promote, true);
  // The archive keeps only the newest N.
  for (let i = 0; i < 5; i++) archiveModel(dir, 'x', live, 3, Date.UTC(2026, 0, 1 + i));
  assert.equal(fs.readdirSync(path.join(dir, 'archive', 'x')).length, 3);
});

test('calibration: overconfident probabilities are shrunk and score better', () => {
  // True P(up) = 0.5 + 0.04 * s; the model says 0.5 + 0.25 * s (six times too confident).
  let seed = 3;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const ps: number[] = [], ys: number[] = [];
  for (let i = 0; i < 6000; i++) { const s = rnd() * 2 - 1; ps.push(0.5 + 0.25 * s); ys.push(rnd() < 0.5 + 0.04 * s ? 1 : 0); }
  const c = fitPlatt(ps, ys);
  assert.ok(c.a < 0.6 && c.a > 0, `a ${c.a}`);
  assert.ok(c.after < c.before, `${c.after} < ${c.before}`);
  assert.equal(calibrated(0.7, undefined), 0.7);
  assert.ok(Math.abs(calibrated(0.7, c) - 0.5) < Math.abs(0.7 - 0.5));
});

test('ensemble: versions that keep performing gain weight; nothing is thrown away', () => {
  const v = (up1: number, skill: number, validated = false) => ({ up1, up4: up1, skill1: skill, skill4: skill, graded1: 100, graded4: 100, validated1: validated, validated4: validated });
  const r = blendVersions([
    { version: 'champ', prior: 1, champion: true, v: v(0.52, -0.01), vol4h: 0.1 },
    { version: 'old', prior: 0.5, champion: false, v: v(0.6, 0.03, true), vol4h: 0.3 },
  ])!;
  const w = Object.fromEntries(r.weights.map((x) => [x.version, x.weight]));
  assert.ok(w.old > w.champ, `the performing archived version outweighs the failing champion: ${JSON.stringify(w)}`);
  assert.ok(r.view.up1! > 0.56, 'blend leans to the performing version');
  assert.equal(r.view.validated1, true, 'validated when the weight behind it is the majority');
  // Ungraded versions: priors decide.
  const u = blendVersions([{ version: 'a', prior: 1, champion: true, v: { up1: 0.6 } }, { version: 'b', prior: 0.5, champion: false, v: { up1: 0.3 } }])!;
  assert.ok(Math.abs(u.view.up1! - 0.5) < 1e-9);
});
