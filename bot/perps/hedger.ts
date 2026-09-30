// Perp executor: drives each perp position to ONE combined target made of
//   (1) the stage-2 delta hedge of the binary book (a risk reducer), and
//   (2) the stage-3 directional position from PerpTrader (bot/perps/perpTrader.ts),
// and keeps the directional position's exchange-side stop-loss in place.
//
// Hedge component. Each binary's price sensitivity to the underlying, dP/dS (per $1 of index),
// is measured by the engine by re-pricing at S +/- 0.05%. Per asset:
//     E = sum(position_yes x dP/dS)            underlying units ($ P&L per $1 move)
//     dollar delta = E x S                     the blueprint's Delta$
//     target perp position = -E / u            u = underlying units per contract
// u comes from the market itself (perp price / index price: perp prices are per contract, the
// exchange's notional is |qty| x mark). Rules:
//  - Hedge only when |dollar delta| >= minDollarDelta AND the target is at least
//    one contract step; rebalance only when the gap exceeds max(1 step, 25% of target)
//    (hysteresis: gamma near expiry makes hedges stale fast, and every trade costs 5-12 bps).
//  - Contracts closing within `excludeTauSec` are excluded (nearly decided, unstable delta).
//  - The hedge never exceeds the exposure it offsets and never exceeds maxNotionalUsd per asset.
//
// Execution (both components):
//  - Entries and ordinary reductions are post-only maker orders joining the touch, re-priced every
//    repriceSec. Resting reductions are plain post-only orders sized to the position: Kalshi
//    accepts reduce_only ONLY on immediate-or-cancel / fill-or-kill orders.
//  - A reduction left unfilled for takerAfterSec, or an URGENT one (stop, kill switch, perp daily
//    loss), crosses the spread reduce-only (IOC).
//  - A flip (long -> short) closes first; the new side opens on the next tick.
//  - While new risk is halted only reductions are allowed.
//  - Pre-trade checks on every order: quote freshness, a price collar around the mid, and a
//    per-order notional cap.

import type { AuditLog } from '../audit/auditLog';
import { logger } from '../util/log';
import type { PerpHub } from './perpData';
import type { PerpGateway, PerpOrder, PerpPosition } from './perpRest';

const log = logger('perp-executor');

export interface BinaryExposure { asset: string; ticker: string; position: number; dPdS: number; tauSec: number }

export interface HedgeParams {
  minDollarDelta: number;
  maxNotionalUsd: number;
  excludeTauSec: number;
  repriceSec: number;
  takerAfterSec: number;
}

export interface ExecRiskParams {
  /** Perp quote must be this fresh to send an order (ms). */
  maxQuoteAgeMs: number;
  /** Order price must be within this many bps of the mid. */
  collarBps: number;
  /** Largest single order, in dollars of notional. */
  maxOrderNotionalUsd: number;
}

export const DEFAULT_EXEC_RISK: ExecRiskParams = { maxQuoteAgeMs: 20_000, collarBps: 150, maxOrderNotionalUsd: 5_000 };

export interface HedgeTarget { asset: string; ticker: string; exposure: number; dollarDelta: number; target: number; current: number; diff: number; act: boolean; reason: string }

/** Directional target from PerpTrader. */
export interface DirTarget { asset: string; ticker: string; target: number; urgent: boolean; reason: string; stopPrice?: number }

/** One ticker's combined target. */
export interface ExecTarget { asset: string; ticker: string; hedge: number; directional: number; target: number; current: number; diff: number; act: boolean; urgent: boolean; reason: string }

/** Underlying units per contract (perp price / index price), when both are known. */
export type UnitsFn = (asset: string) => number | undefined;

/**
 * Pure: desired hedge per asset. `held` is the hedge currently held (for hysteresis). With `units`
 * the contract's exposure is measured from prices; without it the contract size is used and the
 * perp price is treated as the underlying price (legacy fixtures).
 */
export function hedgeTargets(
  exposures: BinaryExposure[], hub: PerpHub, held: Map<string, number>, p: HedgeParams, now: number, units?: UnitsFn,
): HedgeTarget[] {
  const byAsset = new Map<string, number>();
  for (const e of exposures) {
    if (e.tauSec < p.excludeTauSec || !Number.isFinite(e.dPdS)) continue;
    byAsset.set(e.asset, (byAsset.get(e.asset) ?? 0) + e.position * e.dPdS);
  }
  const out: HedgeTarget[] = [];
  const assets = new Set([...byAsset.keys(), ...[...hub.byAsset.entries()].filter(([, s]) => s.latest && (held.get(s.latest.ticker) ?? 0) !== 0).map(([a]) => a)]);
  for (const asset of assets) {
    const st = hub.get(asset);
    const l = st?.latest;
    const Sp = st?.price(now, 60_000);
    const u = units?.(asset) ?? l?.contractSize;
    if (!l || !Sp || !u) {
      out.push({ asset, ticker: l?.ticker ?? '', exposure: byAsset.get(asset) ?? 0, dollarDelta: NaN, target: 0, current: 0, diff: 0, act: false, reason: 'no perp market / price / contract size' });
      continue;
    }
    const underlying = units?.(asset) !== undefined ? Sp / u : Sp;
    const perContract = u * underlying;
    const step = l.fractional ? 0.01 : 1;
    const E = byAsset.get(asset) ?? 0;
    const current = held.get(l.ticker) ?? 0;
    const dollarDelta = E * underlying;
    let target = 0;
    let reason = 'exposure below threshold: flat';
    if (Math.abs(dollarDelta) >= p.minDollarDelta) {
      const raw = -E / u;
      const capped = Math.sign(raw) * Math.min(Math.abs(raw), p.maxNotionalUsd / perContract);
      target = Math.sign(capped) * Math.floor(Math.abs(capped) / step + 1e-9) * step;
      reason = Math.abs(capped) < Math.abs(raw) ? 'hedging (capped at max notional)' : 'hedging';
    }
    // Keep an existing hedge while exposure is still on the same side and above half the threshold (hysteresis).
    if (target === 0 && current !== 0 && Math.sign(current) === -Math.sign(E) && Math.abs(dollarDelta) >= p.minDollarDelta / 2) {
      target = Math.sign(current) * Math.min(Math.abs(current), Math.floor(Math.abs(E / u) / step + 1e-9) * step);
      reason = 'holding hedge (hysteresis)';
    }
    const diff = +(target - current).toFixed(4);
    const act = Math.abs(diff) >= step - 1e-9 && Math.abs(diff) >= Math.max(step, 0.25 * Math.abs(target)) - 1e-9 || (target === 0 && current !== 0);
    out.push({ asset, ticker: l.ticker, exposure: E, dollarDelta, target, current, diff, act, reason });
  }
  return out;
}

export interface DirectionalContext { positions: Map<string, PerpPosition>; hedge: HedgeTarget[]; now: number }

export class PerpHedger {
  private orders = new Map<string, { order: PerpOrder; placedTs: number; reduce: boolean; firstTs: number }>();
  private positions = new Map<string, PerpPosition>();
  /** Hedge component currently intended per ticker (the rest of the position is directional). */
  private hedgeHeld = new Map<string, number>();
  private stops = new Map<string, number>();
  private lastTick = 0;
  last: HedgeTarget[] = [];
  lastExec: ExecTarget[] = [];
  lastError?: string;

  constructor(private readonly d: {
    gateway: PerpGateway; hub: PerpHub; params: HedgeParams; audit?: AuditLog; now?: () => number;
    units?: UnitsFn; risk?: Partial<ExecRiskParams>; minTickMs?: number;
  }) {}

  private get now() { return (this.d.now ?? Date.now)(); }
  private get risk(): ExecRiskParams { return { ...DEFAULT_EXEC_RISK, ...this.d.risk }; }

  get gateway(): PerpGateway { return this.d.gateway; }
  positionOf(ticker: string): PerpPosition | undefined { return this.positions.get(ticker); }
  hedgeOf(ticker: string): number { return this.hedgeHeld.get(ticker) ?? 0; }

  async sync(): Promise<void> {
    const pos = await this.d.gateway.getPositions();
    this.positions = new Map(pos.map((p: PerpPosition) => [p.ticker, p]));
    const open = await this.d.gateway.getOpenOrders();
    const ids = new Set(open.map((o) => o.orderId));
    for (const [t, o] of this.orders) if (!ids.has(o.order.orderId)) this.orders.delete(t);
  }

  async tick(exposures: BinaryExposure[], opts: { reduceOnly?: boolean; directional?: (c: DirectionalContext) => Promise<DirTarget[]> } = {}): Promise<void> {
    const now = this.now;
    if (now - this.lastTick < (this.d.minTickMs ?? 5_000)) return;
    this.lastTick = now;
    try {
      // Positions and resting orders are re-read every tick: a decision is never made on a stale position.
      await this.sync();
      this.last = hedgeTargets(exposures, this.d.hub, this.hedgeHeld, this.d.params, now, this.d.units);
      const dir = opts.directional ? await opts.directional({ positions: this.positions, hedge: this.last, now }) : [];
      this.lastExec = this.combine(this.last, dir);
      for (const h of this.last) if (h.ticker) this.hedgeHeld.set(h.ticker, h.target);
      for (const t of this.lastExec) await this.work(t, now, Boolean(opts.reduceOnly));
      await this.manageStops(dir);
      this.lastError = undefined;
    } catch (e) {
      this.lastError = String(e);
      log.warn('perp tick failed', { error: String(e) });
    }
  }

  private combine(hedge: HedgeTarget[], dir: DirTarget[]): ExecTarget[] {
    const tickers = new Map<string, string>();
    for (const h of hedge) if (h.ticker) tickers.set(h.ticker, h.asset);
    for (const d of dir) tickers.set(d.ticker, d.asset);
    // Any open position nobody wants any more is unwound (e.g. trading was switched off).
    for (const [t, p] of this.positions) if (p.position !== 0 && !tickers.has(t)) {
      const asset = [...this.d.hub.byAsset.entries()].find(([, s]) => s.latest?.ticker === t)?.[0];
      if (asset) tickers.set(t, asset);
    }
    const out: ExecTarget[] = [];
    for (const [ticker, asset] of tickers) {
      const h = hedge.find((x) => x.ticker === ticker);
      const d = dir.find((x) => x.ticker === ticker);
      const l = this.d.hub.get(asset)?.latest;
      const step = l?.fractional ? 0.01 : 1;
      const current = this.positions.get(ticker)?.position ?? 0;
      const target = +((h?.target ?? 0) + (d?.target ?? 0)).toFixed(4);
      const diff = +(target - current).toFixed(4);
      const reducing = current !== 0 && Math.sign(diff) === -Math.sign(current);
      const urgent = Boolean(d?.urgent) && reducing;
      const act = Math.abs(diff) >= step - 1e-9 && (Math.abs(diff) >= Math.max(step, 0.25 * Math.abs(target)) - 1e-9 || (target === 0 && current !== 0) || urgent);
      out.push({ asset, ticker, hedge: h?.target ?? 0, directional: d?.target ?? 0, target, current, diff, act, urgent, reason: [d?.reason, h?.reason].filter(Boolean).join(' | ') || 'unmanaged position: unwind' });
    }
    return out;
  }

  private async cancelResting(ticker: string): Promise<void> {
    const r = this.orders.get(ticker);
    if (!r) return;
    try { await this.d.gateway.cancelOrder(r.order.orderId); } catch { /* reconciled on next sync */ }
    this.orders.delete(ticker);
  }

  private async work(t: ExecTarget, now: number, reduceOnlyMode: boolean): Promise<void> {
    const resting = this.orders.get(t.ticker);
    const st = this.d.hub.get(t.asset);
    const l = st?.latest;
    if (!t.act || !l || l.bid === undefined || l.ask === undefined) {
      if (resting) await this.cancelResting(t.ticker);
      return;
    }
    const side: 'bid' | 'ask' = t.diff > 0 ? 'bid' : 'ask';
    const reduce = t.current !== 0 && Math.sign(t.diff) === -Math.sign(t.current);
    if (reduceOnlyMode && !reduce) {
      if (resting) await this.cancelResting(t.ticker);
      return;
    }
    // A flip closes the existing side first.
    const count = +(reduce ? Math.min(Math.abs(t.diff), Math.abs(t.current)) : Math.abs(t.diff)).toFixed(4);
    const mid = (l.bid + l.ask) / 2;
    const fresh = now - (l.ts ?? 0) <= this.risk.maxQuoteAgeMs;
    if (!fresh && !reduce) {
      if (resting) await this.cancelResting(t.ticker);
      return; // never add risk on a stale quote
    }
    const firstTs = resting && resting.reduce === reduce && resting.order.side === side ? resting.firstTs : now;
    // Urgent reductions, and reductions that waited too long, cross the spread reduce-only (IOC).
    if (reduce && (t.urgent || now - firstTs >= this.d.params.takerAfterSec * 1000)) {
      if (resting) await this.cancelResting(t.ticker);
      const px = side === 'bid' ? l.ask : l.bid;
      const o = await this.d.gateway.createOrder({ ticker: t.ticker, side, count, price: px, clientOrderId: `perp-${t.ticker}-${now}-x`, postOnly: false, reduceOnly: true, timeInForce: 'immediate_or_cancel' });
      this.d.audit?.write('perp_order', { action: t.urgent ? 'urgent_reduce' : 'taker_reduce', ticker: t.ticker, side, count, price: px, target: t.target, current: t.current, reason: t.reason, status: o.status });
      return;
    }
    const price = side === 'bid' ? l.bid : l.ask; // join the touch: maker only
    if (Math.abs(price - mid) / mid * 1e4 > this.risk.collarBps) {
      if (resting) await this.cancelResting(t.ticker);
      log.warn('perp order outside price collar', { ticker: t.ticker, price, mid });
      return;
    }
    if (!reduce && count * price > this.risk.maxOrderNotionalUsd) {
      if (resting) await this.cancelResting(t.ticker);
      log.warn('perp order above the notional cap', { ticker: t.ticker, notional: count * price });
      return;
    }
    const same = resting && resting.order.side === side && resting.order.price === price && Math.abs(resting.order.remaining - count) < 1e-9 && now - resting.placedTs < this.d.params.repriceSec * 1000;
    if (same) return;
    if (resting) await this.cancelResting(t.ticker);
    const o = await this.d.gateway.createOrder({
      ticker: t.ticker, side, count, price, clientOrderId: `perp-${t.ticker}-${now}`, postOnly: true, reduceOnly: false,
      expirationTime: Math.floor(now / 1000) + Math.max(30, this.d.params.repriceSec * 2),
    });
    this.orders.set(t.ticker, { order: o, placedTs: now, reduce, firstTs });
    this.d.audit?.write('perp_order', { action: 'quote', ticker: t.ticker, side, count, price, reduce, target: t.target, hedge: t.hedge, directional: t.directional, current: t.current, reason: t.reason });
  }

  /** Keep the exchange-side stop-loss on each directional position; clear it once flat. */
  private async manageStops(dir: DirTarget[]): Promise<void> {
    const g = this.d.gateway;
    if (!g.setStopLoss || !g.clearStopLoss) return;
    for (const d of dir) {
      const pos = this.positions.get(d.ticker)?.position ?? 0;
      const prev = this.stops.get(d.ticker);
      if (pos !== 0 && d.stopPrice !== undefined && Math.sign(pos) === Math.sign(d.target || pos)) {
        const tick = this.d.hub.get(d.asset)?.latest?.tickSize ?? 0.01;
        if (prev === undefined || Math.abs(prev - d.stopPrice) >= tick - 1e-12) {
          await g.setStopLoss(d.ticker, d.stopPrice);
          this.stops.set(d.ticker, d.stopPrice);
          this.d.audit?.write('perp_order', { action: 'stop_set', ticker: d.ticker, stop: d.stopPrice, position: pos });
        }
      } else if (pos === 0 && prev !== undefined) {
        await g.clearStopLoss(d.ticker);
        this.stops.delete(d.ticker);
      }
    }
  }

  async cancelAll(reason: string): Promise<void> {
    for (const t of [...this.orders.keys()]) await this.cancelResting(t);
    this.d.audit?.write('perp_order', { action: 'cancel_all', reason });
  }

  status() {
    return {
      gateway: this.d.gateway.name, targets: this.last, combined: this.lastExec, restingOrders: [...this.orders.values()].map((o) => o.order),
      positions: Object.fromEntries([...this.positions].map(([t, p]) => [t, p.position])), stops: Object.fromEntries(this.stops), lastError: this.lastError ?? null,
    };
  }
}

/** The executor under its stage-3 name. */
export { PerpHedger as PerpExecutor };
