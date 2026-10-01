// Stage 3: LIVE directional perpetual-futures trading.
//
// Decision per asset (decidePerp, pure):
//   mu        expected return over the horizon H (bps): the validated PerpModel, else the momentum
//             prior (pilot size only)
//   costs     entry + exit maker fees, plus funding over H in the position's direction (positive
//             funding: longs pay, shorts receive; Kalshi funds every 8 h, capped at +/-2%)
//   net(dir)  = dir x mu - 2 x maker - funding(dir)
//   enter     the side with net >= entryEdgeBps
//   hold      while dir x mu - maker(exit) - funding >= exitEdgeBps and the hold is not older than
//             maxHoldMin without a fresh entry-strength signal (hysteresis: no churn on small moves)
//   size      fractional Kelly for a continuous bet: leverage = kelly x net / sigma_H^2, capped by
//               maxLeverage, half the exchange's leverage estimate, 0.5 / stop distance (the stop
//               must sit well inside the liquidation distance), per-asset and total notional caps;
//               an unvalidated signal is capped at the pilot limits
//   stop      max(stopAtrMult x 1h ATR, minStopBps) from the entry, placed ON THE EXCHANGE
//             (Kalshi exit trigger on the liquidation mark) so it protects the position even if the
//             bot is down; the bot also flattens itself if the touch crosses the stop
// Account guards (PerpTrader): perp daily loss stop on margin-account equity (flattens and halts
// for the rest of the UTC day), cooldown after a stop-out, kill switch / halts flatten urgently,
// minimum equity for new entries, optional hard requirement of a validated model.

import type { AuditLog } from '../audit/auditLog';
import type { CandleSet } from '../ta/candleStore';
import type { BarStore } from '../model/featureEngine';
import type { DirTarget, DirectionalContext } from './hedger';
import type { PerpHub } from './perpData';
import type { PerpGateway } from './perpRest';
import { perpFeatures, priorMuBps, type PerpFeatureSources, type PerpModel } from './perpSignal';

export interface PerpTraderParams {
  horizonMin: number;
  entryEdgeBps: number;
  exitEdgeBps: number;
  kellyFraction: number;
  maxLeverage: number;
  maxNotionalUsd: number;
  maxTotalNotionalUsd: number;
  stopAtrMult: number;
  minStopBps: number;
  maxHoldMin: number;
  dailyLossFrac: number;
  cooldownMin: number;
  pilotMaxNotionalUsd: number;
  pilotMaxLeverage: number;
  priorIc: number;
  makerBps: number;
  requireValidation: boolean;
  minEquityUsd: number;
}

export interface PerpDecisionInput {
  asset: string;
  ticker: string;
  muBps?: number;
  sigmaHBps?: number;
  validated: boolean;
  source: 'model' | 'prior' | 'none';
  bid?: number;
  ask?: number;
  fundingRate?: number;
  /** Directional position held now (contracts, signed) and its entry. */
  current: number;
  entryPrice?: number;
  heldMin?: number;
  equity: number;
  /** 1h ATR as a fraction of price. */
  atrFrac?: number;
  marketLeverage?: number;
  step: number;
  /** Directional notional already used on other assets (dollars). */
  otherNotional: number;
  /** Reason new risk is not allowed (flatten urgently when set). */
  halt?: string;
  /** New entries not allowed (existing positions are still managed). */
  noEntry?: string;
}

export interface PerpDecision { target: number; urgent: boolean; reason: string; stopPrice?: number; netEdgeBps?: number; leverage?: number }

const floorStep = (x: number, step: number) => Math.sign(x) * Math.floor(Math.abs(x) / step + 1e-9) * step;

export function decidePerp(i: PerpDecisionInput, p: PerpTraderParams): PerpDecision {
  const cur = i.current;
  const curDir = Math.sign(cur);
  if (i.halt) return { target: 0, urgent: cur !== 0, reason: `flatten: ${i.halt}` };
  if (i.bid === undefined || i.ask === undefined || !(i.ask >= i.bid)) return { target: cur, urgent: false, reason: 'no two-sided perp quote: hold' };
  const mid = (i.bid + i.ask) / 2;
  const stopFrac = Math.max((p.stopAtrMult * (i.atrFrac ?? 0)), p.minStopBps / 1e4);
  const stopFor = (dir: number, entry: number) => +(entry * (1 - dir * stopFrac)).toFixed(4);
  // Our own stop check (the exchange trigger is the primary one).
  if (curDir !== 0 && i.entryPrice) {
    const stop = stopFor(curDir, i.entryPrice);
    if (curDir > 0 ? i.bid <= stop : i.ask >= stop) return { target: 0, urgent: true, reason: `stop hit at ${stop}`, stopPrice: stop };
  }
  if (i.muBps === undefined || !(i.sigmaHBps && i.sigmaHBps > 0)) {
    return { target: 0, urgent: false, reason: `no signal (${i.source}): flat` };
  }
  const fundingBps = (dir: number) => dir * (i.fundingRate ?? 0) * 1e4 * (p.horizonMin / 480);
  const entryNet = (dir: number) => dir * i.muBps! - 2 * p.makerBps - fundingBps(dir);
  const holdNet = (dir: number) => dir * i.muBps! - p.makerBps - fundingBps(dir);

  let dir = 0;
  let net = 0;
  let why = '';
  const best = entryNet(1) >= entryNet(-1) ? 1 : -1;
  if (curDir !== 0) {
    const stale = (i.heldMin ?? 0) > p.maxHoldMin && entryNet(curDir) < p.entryEdgeBps;
    if (!stale && holdNet(curDir) >= p.exitEdgeBps) { dir = curDir; net = holdNet(curDir); why = 'hold'; }
    else if (!i.noEntry && entryNet(-curDir) >= p.entryEdgeBps) { dir = -curDir; net = entryNet(-curDir); why = 'reverse'; }
    else return { target: 0, urgent: false, reason: stale ? `held ${Math.round(i.heldMin ?? 0)} min without a fresh signal: exit` : `edge gone (${holdNet(curDir).toFixed(1)} bps < ${p.exitEdgeBps}): exit`, netEdgeBps: holdNet(curDir) };
  } else if (i.noEntry) {
    return { target: 0, urgent: false, reason: `no new entries: ${i.noEntry}` };
  } else if (entryNet(best) >= p.entryEdgeBps) {
    dir = best; net = entryNet(best); why = 'enter';
  } else {
    return { target: 0, urgent: false, reason: `edge ${entryNet(best).toFixed(1)} bps below entry threshold ${p.entryEdgeBps} (mu ${i.muBps.toFixed(1)} bps, costs ${(2 * p.makerBps + fundingBps(best)).toFixed(1)} bps)`, netEdgeBps: entryNet(best) };
  }

  // Size: fractional Kelly on the net edge, with every cap.
  const sigma = i.sigmaHBps / 1e4;
  const kellyLev = (p.kellyFraction * Math.max(0, net) / 1e4) / (sigma * sigma);
  const caps = [
    p.maxLeverage,
    i.marketLeverage && i.marketLeverage > 0 ? 0.5 * i.marketLeverage : Infinity,
    0.5 / stopFrac,
    i.validated ? Infinity : p.pilotMaxLeverage,
  ];
  const lev = Math.min(kellyLev, ...caps);
  let notional = lev * i.equity;
  notional = Math.min(notional, i.validated ? p.maxNotionalUsd : p.pilotMaxNotionalUsd, Math.max(0, p.maxTotalNotionalUsd - i.otherNotional));
  const target = floorStep(dir * notional / mid, i.step);
  if (target === 0) return { target: 0, urgent: false, reason: `${why}: size below one contract step (notional $${notional.toFixed(2)})`, netEdgeBps: net };
  const entry = curDir === dir && i.entryPrice ? i.entryPrice : mid;
  return {
    target, urgent: false, stopPrice: stopFor(dir, entry), netEdgeBps: net, leverage: lev,
    reason: `${why} ${dir > 0 ? 'long' : 'short'}: net edge ${net.toFixed(1)} bps (${i.source}${i.validated ? '' : ', pilot size'}), ${lev.toFixed(2)}x`,
  };
}

export interface PerpTraderDeps {
  params: PerpTraderParams;
  hub: PerpHub;
  gateway: PerpGateway;
  model?: PerpModel;
  /** Feature sources for an asset (index, 1-min bars, candles, dominance, perp state). */
  sources: (asset: string) => PerpFeatureSources & { bars?: BarStore; candles?: CandleSet };
  /** Index price per asset (underlying units per contract = perp price / index). */
  audit?: AuditLog;
}

export class PerpTrader {
  private equity?: { value: number; ts: number };
  private day?: { key: string; start: number };
  private dayHalt?: string;
  private readonly cooldownUntil = new Map<string, number>();
  private readonly heldSince = new Map<string, number>();
  private readonly lastDir = new Map<string, number>();
  /** Features are recomputed at most every featureEverySec per asset (they move on minute bars). */
  private readonly featCache = new Map<string, { ts: number; f: Record<string, number>; sigma1m?: number; atrFrac?: number }>();
  readonly lastDecisions = new Map<string, PerpDecision & { muBps?: number; sigmaHBps?: number; source: string; current: number }>();
  lastError?: string;

  constructor(private readonly d: PerpTraderDeps & { featureEverySec?: number }) {}

  private async refreshEquity(now: number): Promise<number | undefined> {
    if (this.equity && now - this.equity.ts < 30_000) return this.equity.value;
    if (!this.d.gateway.getBalance) return undefined;
    try {
      const b = await this.d.gateway.getBalance();
      this.equity = { value: b.equity, ts: now };
      const key = new Date(now).toISOString().slice(0, 10);
      if (this.day?.key !== key) { this.day = { key, start: b.equity }; this.dayHalt = undefined; }
      if (this.day.start > 0 && b.equity <= this.day.start * (1 - this.d.params.dailyLossFrac)) {
        this.dayHalt ??= `perp daily loss: equity $${b.equity.toFixed(2)} is ${((1 - b.equity / this.day.start) * 100).toFixed(1)}% below today's start`;
      }
      return b.equity;
    } catch (e) {
      this.lastError = `balance: ${String(e)}`;
      return this.equity?.value;
    }
  }

  /** Directional targets for the executor (called after it has synced positions). */
  async targets(c: DirectionalContext, guards: { halt?: string; noEntry?: string }): Promise<DirTarget[]> {
    const P = this.d.params;
    const now = c.now;
    const equity = await this.refreshEquity(now);
    const out: DirTarget[] = [];
    let used = 0;
    const assets = [...this.d.hub.byAsset.entries()].filter(([, s]) => s.latest?.ticker);
    // Notional already committed per asset (directional part of each position).
    const dirOf = (ticker: string) => (c.positions.get(ticker)?.position ?? 0) - (c.hedge.find((h) => h.ticker === ticker)?.target ?? 0);
    for (const [, s] of assets) used += Math.abs(dirOf(s.latest!.ticker)) * (s.price(now, 60_000) ?? 0);
    for (const [asset, s] of assets) {
      const l = s.latest!;
      const ticker = l.ticker;
      const current = +dirOf(ticker).toFixed(4);
      const px = s.price(now, 60_000);
      // Track hold time and detect exchange-side stop-outs (position vanished while we wanted it).
      const prev = this.lastDir.get(ticker) ?? 0;
      if (current !== 0 && Math.sign(current) !== Math.sign(prev)) this.heldSince.set(ticker, now);
      if (current === 0) this.heldSince.delete(ticker);
      const last = this.lastDecisions.get(ticker);
      if (prev !== 0 && current === 0 && last && last.target !== 0 && Math.sign(last.target) === Math.sign(prev)) {
        this.cooldownUntil.set(asset, now + P.cooldownMin * 60_000); // closed without us asking: a stop fired
        this.d.audit?.write('perp_decision', { asset, ticker, event: 'stopped_out', previous: prev });
      }
      this.lastDir.set(ticker, current);

      let fc = this.featCache.get(asset);
      if (!fc || now - fc.ts >= (this.d.featureEverySec ?? 60) * 1000 || now < fc.ts) {
        const src = this.d.sources(asset);
        const sigma1mNow = src.bars?.sigma1m();
        const t1h = src.candles?.snapshot(now).tf['1h'];
        fc = { ts: now, f: perpFeatures(asset, now, src), sigma1m: sigma1mNow, atrFrac: t1h && t1h.close > 0 ? t1h.atr / t1h.close : sigma1mNow ? sigma1mNow * Math.sqrt(60) : undefined };
        this.featCache.set(asset, fc);
      }
      const { f, sigma1m, atrFrac } = fc;
      const sigmaHBps = sigma1m ? sigma1m * Math.sqrt(P.horizonMin) * 1e4 : atrFrac ? atrFrac * Math.sqrt(P.horizonMin / 60) * 1e4 : undefined;
      const model = this.d.model;
      const validated = Boolean(model?.validated());
      let muBps: number | undefined, source: 'model' | 'prior' | 'none' = 'none', sig = sigmaHBps;
      if (model) {
        const pr = model.predict(f);
        muBps = pr.muBps; source = 'model';
        sig = Math.max(pr.sigmaBps, sigmaHBps ?? 0) || undefined;
      } else {
        muBps = sigmaHBps ? priorMuBps(f, sigmaHBps, P.priorIc) : undefined;
        source = muBps === undefined ? 'none' : 'prior';
      }
      const cool = (this.cooldownUntil.get(asset) ?? 0) > now ? `cooldown after a stop-out until ${new Date(this.cooldownUntil.get(asset)!).toISOString()}` : undefined;
      const noEntry = guards.noEntry ?? cool
        ?? (equity === undefined ? 'margin equity unknown' : equity < P.minEquityUsd ? `margin equity $${equity.toFixed(2)} below $${P.minEquityUsd}` : undefined)
        ?? (P.requireValidation && !validated ? `perp model not validated (${model ? model.blockers().join('; ') : 'no params/perp_model.json'})` : undefined)
        ?? (l.isOpen === false ? 'market closed (schedule)' : undefined);
      const mine = Math.abs(current) * (px ?? 0);
      const dec = decidePerp({
        asset, ticker, muBps, sigmaHBps: sig, validated, source, bid: l.bid, ask: l.ask, fundingRate: l.fundingRate,
        current, entryPrice: current !== 0 ? c.positions.get(ticker)?.entryPrice : undefined,
        heldMin: this.heldSince.has(ticker) ? (now - this.heldSince.get(ticker)!) / 60_000 : undefined,
        equity: equity ?? 0, atrFrac, marketLeverage: l.leverage, step: l.fractional ? 0.01 : 1, otherNotional: used - mine,
        halt: guards.halt ?? this.dayHalt, noEntry,
      }, P);
      this.lastDecisions.set(ticker, { ...dec, muBps, sigmaHBps: sig, source, current });
      if (dec.target !== current || dec.urgent) this.d.audit?.write('perp_decision', { asset, ticker, current, target: dec.target, reason: dec.reason, muBps, sigmaHBps: sig, source, validated, equity, stop: dec.stopPrice });
      out.push({ asset, ticker, target: dec.target, urgent: dec.urgent, reason: dec.reason, stopPrice: dec.stopPrice });
    }
    return out;
  }

  /** Hot-swap the frozen perp model (automated pipeline). */
  setModel(model: PerpModel | undefined): void {
    (this.d as { model?: PerpModel }).model = model;
  }

  status() {
    const m = this.d.model;
    return {
      equity: this.equity?.value ?? null, dayStartEquity: this.day?.start ?? null, dayHalt: this.dayHalt ?? null,
      model: m ? { version: m.params.version, horizonMin: m.params.horizonMin, validated: m.validated(), blockers: m.blockers() } : null,
      signal: m ? 'model' : 'momentum prior (pilot size)',
      decisions: Object.fromEntries(this.lastDecisions),
      cooldowns: Object.fromEntries([...this.cooldownUntil].filter(([, t]) => t > Date.now())),
      lastError: this.lastError ?? null,
    };
  }
}
