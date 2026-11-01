import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { test } from 'node:test';
import { depthStudy } from '../research/depthStudy';
import { tmpDir } from './helpers';

const D0 = Date.UTC(2026, 9, 20);
const MIN = 60_000;

test('the depth study splits the trade flow by where the mid goes over each quarter-minute', async () => {
  const dir = tmpDir();
  const lines: object[] = [{ t: D0 - MIN, k: 'market', ticker: 'KXBTC15M-A', series: 'KXBTC15M', kind: 'updown', closeTime: D0 + 60 * MIN }];
  const book = (t: number, bid: number) => ({ t, k: 'book', ticker: 'KXBTC15M-A', bids: [{ price: +bid.toFixed(2), size: 50 }], asks: [{ price: +(bid + 0.02).toFixed(2), size: 50 }] });
  // Quarter-minutes in fours: a rise with three YES takers, a still one with one trade a side, a fall with three NO
  // takers, a still one again (the quote moves late in its quarter-minute, after the trades that move it).
  lines.push(book(D0 - 1000, 0.45));
  for (let q = 0; q < 48; q++) {
    const t = D0 + q * 15_000, phase = q % 4, bid = phase === 0 || phase === 3 ? 0.45 : 0.46;
    if (phase === 0 || phase === 2) {
      const yes = phase === 0;
      for (let i = 1; i <= 3; i++) lines.push({ t: t + i * 3000, k: 'trade', ticker: 'KXBTC15M-A', price: 0.46, count: 2, takerSide: yes ? 'yes' : 'no', ts: t + i * 3000 });
      lines.push(book(t + 12_000, yes ? 0.46 : 0.45));
    } else for (const side of ['yes', 'no']) lines.push({ t: t + 5000, k: 'trade', ticker: 'KXBTC15M-A', price: bid, count: 1, takerSide: side, ts: t + 5000 });
  }
  lines.push({ t: D0 + 60 * MIN + 1, k: 'result', ticker: 'KXBTC15M-A', result: 'yes' });
  const file = path.join(dir, 'md-2026-10-20.jsonl.gz');
  fs.writeFileSync(file, zlib.gzipSync(lines.map((e) => JSON.stringify(e)).join('\n') + '\n'));
  const r = await depthStudy([file]);
  const sum = (k: number) => r.shape.reduce((a, c) => ({ segs: a.segs + c.byMove[k].segs, trades: a.trades + c.byMove[k].tradesPerSec * c.byMove[k].segs * 15, yes: a.yes + (c.byMove[k].takerYesShare ?? 0) * c.byMove[k].tradesPerSec * c.byMove[k].segs * 15 }), { segs: 0, trades: 0, yes: 0 });
  const up = sum(2), flat = sum(1), down = sum(0);
  assert.ok(up.segs >= 10 && down.segs >= 10 && flat.segs >= 20, `${up.segs} up, ${flat.segs} flat, ${down.segs} down`);
  assert.ok(Math.abs(up.yes / up.trades - 1) < 1e-6, 'the rises were all YES takers');
  assert.ok(Math.abs(down.yes / down.trades) < 1e-6, 'the falls were all NO takers');
  assert.ok(Math.abs(flat.yes / flat.trades - 0.5) < 0.01, 'the still quarter-minutes, one of each');
  assert.ok(up.trades / up.segs > flat.trades / flat.segs);
});
