import assert from 'node:assert/strict';
import path from 'path';
import { test } from 'node:test';
import { DEFAULT_FEES } from '../bot/fees';
import { OrderBook } from '../bot/marketdata/orderBook';
import { Oms } from '../bot/oms/oms';
import { PaperExchange } from '../bot/paper/paperExchange';
import { BalanceMonitor, fillCashDelta, settleCashDelta } from '../bot/vault/balanceMonitor';
import { nextUsOpen, prevUsOpen, Vault, type VaultConfig } from '../bot/vault/vault';
import { tmpAudit, tmpDir } from './helpers';

const T = (iso: string) => Date.parse(iso);
const CFG: VaultConfig = { enabled: true, quotaUsd: 100, winShare: 0.5, pocketShare: 0.1, quotaReset: 'session', dailyGoalUsd: 100 };

test('US open boundaries are DST-correct and skip weekends', () => {
  assert.equal(nextUsOpen(T('2026-07-15T14:00:00Z')), T('2026-07-16T13:30:00Z')); // EDT
  assert.equal(nextUsOpen(T('2026-01-15T14:00:00Z')), T('2026-01-15T14:30:00Z')); // EST, same day
  assert.equal(nextUsOpen(T('2026-07-17T15:00:00Z')), T('2026-07-20T13:30:00Z')); // Friday -> Monday
  assert.equal(prevUsOpen(T('2026-07-15T14:00:00Z')), T('2026-07-15T13:30:00Z'));
});

test('50% of wins vaulted until the $100 quota, then 10% pocketed; crossing win split', () => {
  let now = T('2026-07-15T14:00:00Z'); // London/NY overlap began 13:30
  const v = new Vault(CFG, undefined, () => now);
  v.onSettled(40, 'A');
  assert.equal(v.vaultTotal, 20);
  assert.equal(v.pocketTotal, 0);
  now = T('2026-07-15T14:30:00Z');
  v.onSettled(200, 'B'); // wants 100 vault, 80 fits; remaining 20% of the win -> 10% pocket = $4
  assert.equal(v.vaultTotal, 100);
  assert.equal(v.pocketTotal, 4);
  assert.equal(v.status().phase, 'pocketing');
  now = T('2026-07-15T15:00:00Z');
  v.onSettled(50, 'C'); // quota met: no vaulting, pocket 10%
  assert.equal(v.vaultTotal, 100);
  assert.equal(v.pocketTotal, 9);
  v.onSettled(-30, 'D'); // losses never touch vault or pocket
  assert.equal(v.reserved(), 109);
});

test('quota resets when the next market session opens; vaulting resumes', () => {
  let now = T('2026-07-15T14:00:00Z');
  const v = new Vault(CFG, undefined, () => now);
  v.onSettled(300, 'A'); // quota filled in the overlap session
  assert.equal(v.status().phase, 'pocketing');
  now = T('2026-07-15T15:40:00Z'); // London closed 15:30 UTC -> New York session
  v.tick();
  assert.equal(v.status().phase, 'vaulting');
  v.onSettled(10, 'B');
  assert.equal(v.vaultTotal, 105);
});

test('us_open reset mode: one quota per US-open-to-US-open day', () => {
  let now = T('2026-07-15T14:00:00Z');
  const v = new Vault({ ...CFG, quotaReset: 'us_open' }, undefined, () => now);
  v.onSettled(300, 'A');
  now = T('2026-07-15T20:30:00Z'); // new session (twilight) but same US day
  v.onSettled(10, 'B');
  assert.equal(v.vaultTotal, 100, 'no new quota until the next US open');
  now = T('2026-07-16T13:31:00Z');
  v.onSettled(10, 'C');
  assert.equal(v.vaultTotal, 105);
});

test('pocket is released at the next US market open (Friday pockets release Monday)', () => {
  let now = T('2026-07-17T14:00:00Z'); // Friday, overlap
  const v = new Vault(CFG, undefined, () => now);
  v.onSettled(220, 'A'); // vault 100 (quota), pocket = 10% of the post-quota part of the win
  const pocket = v.pocketTotal;
  assert.ok(pocket > 0);
  now = T('2026-07-18T15:00:00Z'); v.tick(); // Saturday
  assert.equal(v.pocketTotal, pocket);
  now = T('2026-07-20T13:29:00Z'); v.tick(); // Monday just before the open
  assert.equal(v.pocketTotal, pocket);
  now = T('2026-07-20T13:30:00Z'); v.tick();
  assert.equal(v.pocketTotal, 0);
  assert.equal(v.vaultTotal, 100, 'vault is never released');
  assert.equal(v.status().events[0].kind, 'release');
});

test('withdrawals come out of the vault first, then the pocket, then trading cash', () => {
  let now = T('2026-07-15T14:00:00Z');
  const v = new Vault(CFG, undefined, () => now);
  v.onSettled(300, 'A'); // vault 100, pocket 10% of 1/3 of 300 = 10
  assert.deepEqual([v.vaultTotal, v.pocketTotal], [100, 10]);
  assert.deepEqual(v.onWithdrawal(60, 'detected'), { fromVault: 60, fromPocket: 0, fromTrading: 0 });
  assert.deepEqual(v.onWithdrawal(55, 'manual'), { fromVault: 40, fromPocket: 10, fromTrading: 5 });
  assert.equal(v.reserved(), 0);
});

test('vault state persists across restarts', () => {
  const file = path.join(tmpDir(), 'vault.json');
  const now = () => T('2026-07-15T14:00:00Z');
  new Vault(CFG, file, now).onSettled(40, 'A');
  assert.equal(new Vault(CFG, file, now).vaultTotal, 20);
});

test('disabled vault reserves nothing', () => {
  const v = new Vault({ ...CFG, enabled: false }, undefined, () => T('2026-07-15T14:00:00Z'));
  v.onSettled(500, 'A');
  assert.equal(v.reserved(), 0);
});

// ---- Withdrawal detection ------------------------------------------------------

test('cash accounting matches the exchange collateral model exactly (paper exchange)', async () => {
  const book = new OrderBook('T');
  book.applySnapshot({ bids: [{ price: 0.4, size: 50 }], asks: [{ price: 0.45, size: 50 }] }, Date.now());
  const ex = new PaperExchange(undefined, 100, () => book, () => DEFAULT_FEES);
  const oms = new Oms({ gateway: ex, audit: tmpAudit(), statePath: path.join(tmpDir(), 'o.json'), feesFor: () => DEFAULT_FEES, sleep: async () => undefined });
  const mon = new BalanceMonitor();
  mon.check(await ex.getBalance(), true);
  ex.on('fill', (f) => oms.onFill(f));
  oms.on('fill', (f, _r, fee, after) => mon.onCash(fillCashDelta(f.side, f.count, f.price, fee, after - (f.side === 'bid' ? f.count : -f.count))));
  oms.on('settled', (e) => mon.onCash(settleCashDelta(e.positionBefore, e.result)));
  const ioc = (side: 'bid' | 'ask', count: number, price: number) => ({ ticker: 'T', side, count, price, timeInForce: 'immediate_or_cancel' as const, postOnly: false, reduceOnly: false, purpose: 'entry' as const, asset: 'BTC', windowCloseTs: 0, fairValue: 0.5, modelId: 'm', decisionId: 'd' });
  await oms.submit(ioc('bid', 10, 0.45)); // buy 10 YES
  await oms.submit(ioc('ask', 15, 0.4));  // sell 10 YES, then 5 NO
  ex.settle('T', 'no');
  oms.settle('T', 'no');
  assert.deepEqual(mon.check(await ex.getBalance(), true), {}, 'no unexplained cash');
  assert.ok(Math.abs(mon.state.expected! - (await ex.getBalance())) < 1e-9);
});

test('withdrawal booked only when stable across two quiet checks; deposits too', () => {
  const m = new BalanceMonitor();
  m.check(200, true);
  assert.deepEqual(m.check(150, true), {}, 'first sighting: could be a race');
  assert.deepEqual(m.check(150, false), {}, 'not quiet: settlement may be in flight');
  assert.deepEqual(m.check(150, true), { withdrawal: 50 });
  assert.deepEqual(m.check(150, true), {});
  m.check(175, true);
  assert.deepEqual(m.check(175, true), { deposit: 25 });
  m.check(175.02, true);
  assert.deepEqual(m.check(175.02, true), {}, 'sub-threshold noise ignored');
});

test('a transient race that resolves is never booked', () => {
  const m = new BalanceMonitor();
  m.check(100, true);
  assert.deepEqual(m.check(96, true), {}); // fill landed after the fill replay
  m.onCash(-4);                            // next reconciliation replays it
  assert.deepEqual(m.check(96, true), {});
});

test('daily goal: per-session quotas accumulate toward $100/day and may exceed it; resets at US open', () => {
  let now = T('2026-07-15T14:00:00Z');
  const v = new Vault(CFG, undefined, () => now);
  v.onSettled(120, 'A'); // overlap session: $60 vaulted
  assert.equal(v.status().dailyVaulted, 60);
  assert.equal(v.status().dailyGoalMet, false);
  now = T('2026-07-15T16:00:00Z'); // New York session: fresh session quota
  v.onSettled(200, 'B'); // $100 more vaulted
  assert.equal(v.status().dailyVaulted, 160);
  assert.equal(v.status().dailyGoalMet, true, 'over the daily goal is fine');
  now = T('2026-07-16T13:31:00Z'); v.tick(); // next US open: new day
  assert.equal(v.status().dailyVaulted, 0);
  assert.equal(v.vaultTotal, 160, 'the vault itself keeps everything');
});
