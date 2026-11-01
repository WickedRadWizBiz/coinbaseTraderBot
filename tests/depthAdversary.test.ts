import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { test } from 'node:test';
import { compareProbes, probeDays, probeStats, PROBES } from '../research/depthAdversary';
import { tmpDir } from './helpers';

const MIN = 60_000;

/** A recorded day of one 15-minute contract an hour: the touch 40/42 that steps two cents every 2 minutes. `kind`: a book
 *  whose prints hit the resting probes at random (no adverse selection); otherwise prints come only just before a move
 *  against the resting side (the real book's way), so a resting bid fills right before the price drops. */
function day(dir: string, name: string, kind: boolean): void {
  const lines: object[] = [];
  const D0 = Date.parse(`${name}T00:00:00Z`);
  for (let h = 0; h < 6; h++) {
    const open = D0 + h * 60 * MIN, close = open + 15 * MIN, ticker = `KXBTC15M-${h}`;
    lines.push({ t: open - MIN, k: 'market', ticker, series: 'KXBTC15M', asset: 'BTC', kind: 'updown', strike: 100_000, cap: null, openTime: open, closeTime: close });
    let bid = 0.40;
    for (let t = open; t < close; t += 1000) {
      const step = (t - open) % (2 * MIN) === 0 && t > open;
      if (step) {
        const down = Math.floor((t - open) / (2 * MIN)) % 2 === 1;
        if (!kind) {
          // Just before the move: a print at the side that is about to be run over (through our resting probe).
          const px = down ? bid - 0.02 : bid + 0.04;
          lines.push({ t: t - 1000, k: 'trade', ticker, price: +px.toFixed(2), count: 40, takerSide: down ? 'no' : 'yes', ts: t - 1000 });
        }
        bid = +(bid + (down ? -0.02 : 0.02)).toFixed(2);
      }
      if (t % 5000 === 0) lines.push({ t, k: 'book', ticker, bids: [{ price: bid, size: 50 }, { price: +(bid - 0.01).toFixed(2), size: 80 }], asks: [{ price: +(bid + 0.02).toFixed(2), size: 50 }, { price: +(bid + 0.03).toFixed(2), size: 80 }] });
      // The kind book: prints every 10 s alternately at the bid and at the ask, big enough to fill the queue and us.
      if (kind && t % 10_000 === 5000) { const yes = (t / 10_000) % 2 === 0; lines.push({ t, k: 'trade', ticker, price: +(yes ? bid + 0.02 : bid).toFixed(2), count: 80, takerSide: yes ? 'yes' : 'no', ts: t }); }
    }
    lines.push({ t: close + 1000, k: 'result', ticker, result: h % 2 === 0 ? 'yes' : 'no' });
  }
  fs.writeFileSync(path.join(dir, `md-${name}.jsonl.gz`), zlib.gzipSync(lines.map((e) => JSON.stringify(e)).join('\n') + '\n'));
}

test('the adversary\'s probes earn more on a book that fills them for free than on one that fills them before the price moves against them', async () => {
  const root = tmpDir();
  const real = path.join(root, 'real'), kind = path.join(root, 'kind');
  fs.mkdirSync(real); fs.mkdirSync(kind);
  for (const d of ['2026-10-20', '2026-10-21', '2026-10-22']) { day(real, d, false); day(kind, d, true); }
  const r = await probeDays(real), k = await probeDays(kind);
  assert.equal(r.length, 3);
  const rs = probeStats(r), ks = probeStats(k);
  for (const probe of PROBES) assert.ok(rs.find((x) => x.probe === probe)!.quoted > 0, `${probe} quoted`);
  const join = (s: typeof rs) => s.find((x) => x.probe === 'join')!;
  assert.ok(join(rs).n > 0, 'the real book fills the joined touch just before each move');
  assert.ok(join(ks).n > 0, 'the kind book fills it too');
  assert.ok(rs.find((x) => x.probe === 'taker')!.n > 0 && ks.find((x) => x.probe === 'taker')!.n > 0, 'the taker probe fills at once');
  // On the real book the joined touch is run over: a negative markout. On the kind book the fills are a coin flip.
  assert.ok(join(rs).markoutC < -0.5, `real join markout ${join(rs).markoutC}c`);
  assert.ok(join(ks).markoutC > join(rs).markoutC + 0.5, `kind join markout ${join(ks).markoutC}c`);
  const rows = compareProbes(r, { kind: k }, 100);
  assert.ok(rows.find((x) => x.probe === 'join')!.kinder, 'kind/join flagged');
  // A fill-in that is the real book is never kinder than it.
  assert.ok(compareProbes(r, { same: r }, 50).every((x) => !x.kinder));
});
