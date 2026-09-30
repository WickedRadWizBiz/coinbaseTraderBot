// Stage 2: delta-hedge the binary book with Kalshi perps (a risk reducer, not
// a directional strategy).
//
// Each binary's price sensitivity to the underlying, dP/dS (per $1 of index),
// is measured by the engine by re-pricing at S +/- 0.05%. Per asset:
//     E = sum(position_yes x dP/dS)            underlying units ($ P&L per $1 move)
//     dollar delta = E x S                     the blueprint's Delta$
//     target perp position = -E / contractSize (contracts)
// Rules:
//  - Hedge only when |dollar delta| >= minDollarDelta AND the target is at least
//    one contract; rebalance only when the gap exceeds max(1 step, 25% of target)
//    (hysteresis: gamma near expiry makes hedges stale fast, and every trade
//    costs 5-12 bps).
//  - Contracts closing within `excludeTauSec` are excluded (nearly decided,
//    unstable delta).
//  - The hedge never exceeds the exposure it offsets and never exceeds
//    maxNotionalUsd per asset, so it cannot become a directional position.
//  - Entries are post-only maker orders joining the touch, re-priced every
//    repriceSec. A REDUCTION left unfilled for takerAfterSec (e.g. the binaries
//    settled and the hedge is now naked) crosses the spread reduce-only.
//  - While the kill switch is engaged only reductions are allowed.

import type { AuditLog } from '../audit/auditLog';
import { logger } from '../util/log';
import type { PerpHub } from './perpData';
import type { PerpGateway, PerpOrder, PerpPosition } from './perpRest';

const log = logger('perp-hedger');

export interface BinaryExposure { asset: string; ticker: string; position: number; dPdS: number; tauSec: number }

export interface HedgeParams {
  minDollarDelta: number;
  maxNotionalUsd: number;
  excludeTauSec: number;
  repriceSec: number;
  takerAfterSec: number;
}

export interface HedgeTarget { asset: string; ticker: string; exposure: number; dollarDelta: number; target: number; current: number; diff: number; act: boolean; reason: string }

/** Pure: desired perp position per asset given binary exposures and current perp positions. */
export function hedgeTargets(
  exposures: BinaryExposure[], hub: PerpHub, positions: Map<string, number>, p: HedgeParams, now: number,
): HedgeTarget[] {
  const byAsset = new Map<string, number>();
  for (const e of exposures) {
    if (e.tauSec < p.excludeTauSec || !Number.isFinite(e.dPdS)) continue;
    byAsset.set(e.asset, (byAsset.get(e.asset) ?? 0) + e.position * e.dPdS);
  }
  const out: HedgeTarget[] = [];
  const assets = new Set([...byAsset.keys(), ...[...hub.byAsset.entries()].filter(([, s]) => s.latest && (positions.get(s.latest.ticker) ?? 0) !== 0).map(([a]) => a)]);
  for (const asset of assets) {
    const st = hub.get(asset);
    const l = st?.latest;
    const S = st?.price(now, 60_000);
    if (!l || !S || !l.contractSize) {
      out.push({ asset, ticker: l?.ticker ?? '', exposure: byAsset.get(asset) ?? 0, dollarDelta: NaN, target: 0, current: 0, diff: 0, act: false, reason: 'no perp market / price / contract size' });
      continue;
    }
    const step = l.fractional ? 0.01 : 1;
    const E = byAsset.get(asset) ?? 0;
    const current = positions.get(l.ticker) ?? 0;
    const dollarDelta = E * S;
    let target = 0;
    let reason = 'exposure below threshold: flat';
    if (Math.abs(dollarDelta) >= p.minDollarDelta) {
      const raw = -E / l.contractSize;
      const capped = Math.sign(raw) * Math.min(Math.abs(raw), p.maxNotionalUsd / (S * l.contractSize));
      target = Math.sign(capped) * Math.floor(Math.abs(capped) / step + 1e-9) * step;
      reason = Math.abs(capped) < Math.abs(raw) ? 'hedging (capped at max notional)' : 'hedging';
    }
    // Keep an existing hedge while exposure is still on the same side and above half the threshold (hysteresis).
    if (target === 0 && current !== 0 && Math.sign(current) === -Math.sign(E) && Math.abs(dollarDelta) >= p.minDollarDelta / 2) {
      target = Math.sign(current) * Math.min(Math.abs(current), Math.floor(Math.abs(E / l.contractSize) / step + 1e-9) * step);
      reason = 'holding hedge (hysteresis)';
    }
    const diff = +(target - current).toFixed(4);
    const act = Math.abs(diff) >= step - 1e-9 && Math.abs(diff) >= Math.max(step, 0.25 * Math.abs(target)) - 1e-9 || (target === 0 && current !== 0);
    out.push({ asset, ticker: l.ticker, exposure: E, dollarDelta, target, current, diff, act, reason });
  }
  return out;
}

export class PerpHedger {
  private orders = new Map<string, { order: PerpOrder; placedTs: number; reduce: boolean; firstTs: number }>();
  private positions = new Map<string, number>();
  private lastSync = 0;
  private lastTick = 0;
  last: HedgeTarget[] = [];
  lastError?: string;

  constructor(private readonly d: { gateway: PerpGateway; hub: PerpHub; params: HedgeParams; audit?: AuditLog; now?: () => number }) {}

  private get now() { return (this.d.now ?? Date.now)(); }

  async sync(): Promise<void> {
    const pos = await this.d.gateway.getPositions();
    this.positions = new Map(pos.map((p: PerpPosition) => [p.ticker, p.position]));
    const open = await this.d.gateway.getOpenOrders();
    const ids = new Set(open.map((o) => o.orderId));
    for (const [t, o] of this.orders) if (!ids.has(o.order.orderId)) this.orders.delete(t);
    this.lastSync = this.now;
  }

  async tick(exposures: BinaryExposure[], opts: { reduceOnly?: boolean } = {}): Promise<void> {
    const now = this.now;
    if (now - this.lastTick < 5_000) return;
    this.lastTick = now;
    try {
      // Positions and resting orders are re-read every tick (ticks are >= 5 s apart): a hedge decision
      // must never be made on a stale position.
      await this.sync();
      this.last = hedgeTargets(exposures, this.d.hub, this.positions, this.d.params, now);
      for (const t of this.last) await this.work(t, now, Boolean(opts.reduceOnly));
      this.lastError = undefined;
    } catch (e) {
      this.lastError = String(e);
      log.warn('hedge tick failed', { error: String(e) });
    }
  }

  private async work(t: HedgeTarget, now: number, reduceOnlyMode: boolean): Promise<void> {
    const resting = this.orders.get(t.ticker);
    const l = this.d.hub.get(t.asset)?.latest;
    if (!t.act || !l || l.bid === undefined || l.ask === undefined) {
      if (resting) { await this.d.gateway.cancelOrder(resting.order.orderId); this.orders.delete(t.ticker); }
      return;
    }
    const side: 'bid' | 'ask' = t.diff > 0 ? 'bid' : 'ask';
    const reduce = t.current !== 0 && Math.sign(t.diff) === -Math.sign(t.current) && Math.abs(t.diff) <= Math.abs(t.current) + 1e-9;
    if (reduceOnlyMode && !reduce) {
      if (resting) { await this.d.gateway.cancelOrder(resting.order.orderId); this.orders.delete(t.ticker); }
      return;
    }
    const count = Math.abs(t.diff);
    const firstTs = resting && resting.reduce === reduce && resting.order.side === side ? resting.firstTs : now;
    // A reduction that has waited too long crosses the spread (reduce-only IOC).
    if (reduce && now - firstTs >= this.d.params.takerAfterSec * 1000) {
      if (resting) { await this.d.gateway.cancelOrder(resting.order.orderId); this.orders.delete(t.ticker); }
      const px = side === 'bid' ? l.ask : l.bid;
      const o = await this.d.gateway.createOrder({ ticker: t.ticker, side, count, price: px, clientOrderId: `hedge-${t.ticker}-${now}-x`, postOnly: false, reduceOnly: true, timeInForce: 'immediate_or_cancel' });
      this.d.audit?.write('perp_hedge', { action: 'taker_unwind', ticker: t.ticker, side, count, price: px, target: t.target, current: t.current, status: o.status });
      this.lastSync = 0;
      return;
    }
    const price = side === 'bid' ? l.bid : l.ask; // join the touch: maker only
    const fresh = resting && resting.order.side === side && resting.order.price === price && Math.abs(resting.order.remaining - count) < 1e-9 && now - resting.placedTs < this.d.params.repriceSec * 1000;
    if (fresh) return;
    if (resting) { await this.d.gateway.cancelOrder(resting.order.orderId); this.orders.delete(t.ticker); }
    const o = await this.d.gateway.createOrder({
      ticker: t.ticker, side, count, price, clientOrderId: `hedge-${t.ticker}-${now}`, postOnly: true, reduceOnly: reduce,
      expirationTime: Math.floor(now / 1000) + Math.max(30, this.d.params.repriceSec * 2),
    });
    this.orders.set(t.ticker, { order: o, placedTs: now, reduce, firstTs });
    this.d.audit?.write('perp_hedge', { action: 'quote', ticker: t.ticker, side, count, price, reduce, target: t.target, current: t.current, dollarDelta: t.dollarDelta, reason: t.reason });
  }

  async cancelAll(reason: string): Promise<void> {
    for (const [t, o] of this.orders) {
      try { await this.d.gateway.cancelOrder(o.order.orderId); } catch { /* reconciled on next sync */ }
      this.orders.delete(t);
    }
    this.d.audit?.write('perp_hedge', { action: 'cancel_all', reason });
  }

  status() {
    return { gateway: this.d.gateway.name, targets: this.last, restingOrders: [...this.orders.values()].map((o) => o.order), positions: Object.fromEntries(this.positions), lastError: this.lastError ?? null };
  }
}
