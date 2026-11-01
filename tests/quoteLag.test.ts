import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, contractTrades, gapAt, hourBlockCi, type Tick } from '../research/quoteLagStudy';

const S = 1000;
// Fair jumps 10c at t=100 s; the quote follows 5 s later. Spread 2c around the mid.
function lagged(lag: number): Tick[] {
  const out: Tick[] = [];
  for (let s = 0; s < 400; s++) {
    const fair = s >= 100 ? 0.6 : 0.5, mid = s >= 100 + lag ? 0.6 : 0.5;
    out.push({ t: s * S, fair, bid: mid - 0.01, ask: mid + 0.01 });
  }
  return out;
}

test('quote lag: the gap is the fair move the mid has not followed yet', () => {
  const tk = lagged(5);
  assert.equal(at(tk, 100 * S), 100);
  assert.ok(Math.abs(gapAt(tk, 101, 5)! - 0.1) < 1e-9, 'fair moved 10c, mid not yet');
  assert.ok(Math.abs(gapAt(tk, 110, 5)!) < 1e-9, 'caught up');
  assert.equal(gapAt(tk, 2, 5), undefined, 'not enough history');
});

test('quote lag: a lagging quote pays a taker in the gap direction; an instant one loses the spread and fees', () => {
  const close = 400 * S + 120 * S;
  const lag = contractTrades(lagged(10), close, 5, 0.04, 10, 20);
  assert.equal(lag.length, 1);
  assert.equal(lag[0].side, 'yes');
  assert.ok(lag[0].pnl > 0.04 && lag[0].pnl < 0.05, `bought at 51c, sold at 59c less two taker fees (~1.75c each): ${lag[0].pnl}`);
  const none = contractTrades(lagged(0), close, 5, 0.04, 10, 20);
  assert.equal(none.length, 0, 'no gap when the quote moves with fair');
  // No entry inside the last minute.
  assert.equal(contractTrades(lagged(10), 130 * S, 5, 0.04, 10, 20).length, 0);
});

test('quote lag: hour-block CI brackets the mean', () => {
  const tr = Array.from({ length: 200 }, (_, i) => ({ t: i * 600_000, pnl: (i % 3) - 0.9 }));
  const ci = hourBlockCi(tr);
  assert.ok(ci.lo <= ci.mean && ci.mean <= ci.hi);
});

test('quote lag adversary: a slower bot and a cent of slippage eat into the same trade', () => {
  const close = 400 * S + 120 * S;
  const fast = contractTrades(lagged(10), close, 5, 0.04, 10, 20, { latency: 1, slip: 0 })[0].pnl;
  const slow = contractTrades(lagged(10), close, 5, 0.04, 10, 20, { latency: 3, slip: 0 })[0].pnl;
  const slipped = contractTrades(lagged(10), close, 5, 0.04, 10, 20, { latency: 3, slip: 0.01 })[0].pnl;
  assert.ok(slipped < slow && slow <= fast, `${fast} ${slow} ${slipped}`);
  assert.ok(slow - slipped > 0.015 && slow - slipped < 0.03, 'about a cent each way, plus the fee on the worse price');
});
