// deploy/cross_study.py replays the bot's positions through a Python port of the exit curve and the taker fee: the
// port has to read a book exactly as bot/strategy/sinuousExit.ts and bot/fees.ts do. Skipped without a python3.
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { test } from 'node:test';
import { takerFee } from '../bot/fees';
import type { BookLevel } from '../bot/kalshi/types';
import { SinuousExitTracker, type CurveProfile } from '../bot/strategy/sinuousExit';
import { tmpDir } from './helpers';

const python = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import json'], { encoding: 'utf8' }).status === 0);

test('exit study: the Python curve and taker fee match the bot\'s on a random book', { skip: !python && 'no python' }, () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (const [profile, sign] of [['crypto_15m', 1], ['crypto_15m', -1], ['crypto_1h', 1]] as Array<[CurveProfile, 1 | -1]>) {
    const tr = new SinuousExitTracker(profile);
    const obs: Array<{ now: number; sign: number; bid: [number, number] | null; ask: [number, number] | null; tau: number }> = [];
    const want: Array<Record<string, number | undefined> | null> = [];
    let p = 0.5, now = 1_761_000_000_000;
    for (let i = 0; i < 700; i++) {
      // A gap that restarts the curve, a repeated timestamp, and the last minutes before the close.
      now += i === 250 ? 90_000 : i === 300 ? 0 : 1000;
      const tau = Math.max(5, 900 - i * 1.3);
      p = Math.min(0.97, Math.max(0.03, p + (rnd() - 0.5) * 0.04));
      const spread = [0.01, 0.02, 0.03, 0.06][Math.floor(rnd() * 4)];
      const bid: BookLevel | undefined = i % 97 === 5 ? undefined : { price: +Math.max(0.01, p - spread / 2).toFixed(2), size: 1 + Math.floor(rnd() * 200) };
      const ask: BookLevel | undefined = i % 89 === 7 || i === 400 ? undefined : { price: +Math.min(0.99, p + spread / 2).toFixed(2), size: 1 + Math.floor(rnd() * 200) };
      const r = tr.update({ now, sign, bid: i === 400 ? undefined : bid, ask, entrySidePrice: 0.4, entryFeePer: 0.01, exitFeePer: 0.01, tauSec: tau, minNetProfit: 0.015 });
      obs.push({ now, sign, bid: i === 400 || !bid ? null : [bid.price, bid.size], ask: ask ? [ask.price, ask.size] : null, tau });
      want.push(r.reason === 'NO_BOOK' ? null : { micro: r.micro, curve: r.curve, projected: r.projected, velocity: r.velocity, z: r.z, swingTop: tr.swingTop(0.5) });
    }
    const fees: Array<[number, number]> = [[1, 0.5], [10, 0.45], [20, 0.07], [7.5, 0.93], [3, 0.01], [100, 0.5], [13.37, 0.6612]];
    const file = path.join(tmpDir(), `series-${profile}-${sign}.json`);
    fs.writeFileSync(file, JSON.stringify({ profile, band: 0.5, obs, fees }));
    const run = spawnSync(python!, ['-I', path.join('deploy', 'cross_study.py'), '--selftest', file], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const got = JSON.parse(run.stdout) as { readings: Array<Record<string, number | null> | null>; fees: number[] };
    assert.equal(got.readings.length, want.length);
    want.forEach((w, i) => {
      const g = got.readings[i];
      if (w === null) { assert.equal(g, null, `tick ${i}: no book`); return; }
      assert.ok(g, `tick ${i}: a reading`);
      for (const [k, tol] of [['micro', 1.01e-4], ['curve', 1.01e-4], ['projected', 1.01e-4], ['velocity', 1.01e-5], ['z', 0.0101]] as const) {
        const a: number | undefined = w[k];
        const b: number | null | undefined = g[k];
        if (a === undefined) { assert.equal(b, null, `tick ${i} ${k}`); continue; }
        assert.ok(b !== null && Math.abs(a - b) <= tol, `${profile} ${sign} tick ${i} ${k}: bot ${a}, study ${b}`);
      }
      if (w.swingTop === undefined) assert.equal(g.swingTop, null, `tick ${i} swing top`);
      else assert.ok(g.swingTop !== null && Math.abs(w.swingTop - g.swingTop) < 1e-8, `tick ${i} swing top: bot ${w.swingTop}, study ${g.swingTop}`);
    });
    fees.forEach(([c, px], i) => assert.ok(Math.abs(got.fees[i] - takerFee(c, px, { takerMultiplier: 1, makerMultiplier: 0, balancePrecision: 0.01 })) < 1e-9, `fee ${c} @ ${px}: bot ${takerFee(c, px, { takerMultiplier: 1, makerMultiplier: 0, balancePrecision: 0.01 })}, study ${got.fees[i]}`));
  }
});
