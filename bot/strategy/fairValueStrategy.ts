// Strategy: price the contract, then
//  1. MAKER (default): rest post_only quotes around the decision probability
//     q, fee-free on series with a zero maker multiplier, skewed against
//     inventory, pulled on fast index moves and outside the entry window.
//     Relaxed spec: bid at floor(q_adj - e_min - buffer), where the buffer is
//     the adverse-selection haircut measured from 60 s markouts. A quote sizing
//     wants is at least minQuoteContracts (within the per-order caps and the
//     risk room left): Kalshi rounds each order's fee up to the cent, so a small
//     position pays more a contract to sell. A quote due to expire on the
//     exchange is placed again.
//  2. TAKER (optional): cross only when q beats the touch by the taker fee
//     plus minEdge plus takerBuffer (5c in the relaxed spec), then hold.
//  3. EXIT: never a percentage stop. Take-profit: a winner runs. Its floor is
//     profitTargetPct of what a contract cost (price plus entry fee; 10% by
//     default), at least profitTarget a contract, net of the entry's fees and
//     this exit's taker fee. Once selling would bank the floor the position is
//     armed, and it is sold at the bid when it falls back from its best (the
//     best price its side could have been sold at since it was opened or added
//     to): profitGiveBack of the best gain given back (a third by default), or
//     into the last tick above the floor. Never below the floor, whatever the
//     model thinks the contract is worth. Benched by its scoreboard against
//     holding to settlement (takeProfitBenched, bot/strategy/takeProfitBench.ts),
//     it sells nothing. Model exit: sell at the bid when the bid minus
//     the taker fee beats q + exitMargin (the market overpays, or the model
//     turned against the position). Mode B adds a resting maker take-profit at
//     entry + TP, never offered below what the model thinks the position is
//     worth. Inside the final minute positions ride to settlement.
//
// q is the model probability, or with target-EV sizing q_adj = p_mkt_cal +
// kappa * (p_model - p_mkt_cal): the model shrunk toward the calibrated market.
//
// Pure function: no I/O. The engine turns plans into risk-checked orders.

import type { StrategyConfig } from '../config';
import { orderFee, type FeeSchedule } from '../fees';
import type { BookSide, TimeInForce } from '../kalshi/types';
import type { OrderPurpose } from '../oms/orderState';
import { evThresholds, kellySize, targetEvSize } from '../sizing/kelly';
import { quotaCall } from '../risk/quotaPacer';
import { ceilToTick, floorCount, floorToTick, round } from '../util/num';

export interface RestingQuote {
  clientOrderId: string;
  price: number;
  remaining: number;
  /** When the exchange expires it (unix seconds). */
  expiresSec?: number;
}

export interface MarketView {
  ticker: string;
  pYes: number;
  /** The spot fair value of YES: the contract priced off the index (bot/model/fairValue.ts priceContract), before the model,
   *  the SNN, the TA and the rules move it. The loser exits' measure (cfg.loserExits); unset: those that need it are off. */
  pFair?: number;
  bestBid?: { price: number; size: number };
  bestAsk?: { price: number; size: number };
  position: number;
  bankroll: number;
  /** Remaining room under the per-order risk cap (dollars). */
  maxOrderRiskUsd: number;
  /** Risk room left under the window and total caps and in free cash (dollars): a quote is only raised to the
   *  minimum size inside it. Unbounded when not given. */
  newRiskRoomUsd?: number;
  /** Paper order size (PAPER_ORDER_FRAC of the bankroll, or PAPER_ORDER_USD): a trade sizing wants (contracts > 0)
   *  buys about this many dollars of contracts, within maxOrderRiskUsd, the risk room and maxContracts. Undefined = the
   *  sized amount. */
  fixedOrderUsd?: number;
  /** The order band (ORDER_USD_MIN / ORDER_USD_MAX, paper and live): a trade sizing wants (contracts > 0) stakes the
   *  sized amount clamped to [min, max] dollars, within maxOrderRiskUsd, the risk room and maxContracts; skipped when
   *  those cannot fit the minimum. Undefined = the sized amount. */
  orderBandUsd?: { min: number; max: number };
  /** Exit curve rest mode: the side price at which the held position's sell rests (the curve's swing-top estimate).
   *  Undefined = no resting curve sell. */
  curveRestSidePrice?: number;
  /** Hunt mode's sell-wall ask (HUNT_WALL_ASK, bot/strategy/exitPolicies.ts): the side price at which the hunted position's
   *  sell rests, joined behind a top-of-book sell wall. Undefined = none. Placed while the hunt blocks every other reduction. */
  huntRestSidePrice?: number;
  maxContracts: number;
  minSidePrice: number;
  tauSec: number;
  noEntryBeforeCloseSec: number;
  fastMove: boolean;
  tickSize: number;
  fees: FeeSchedule;
  restingBid?: RestingQuote;
  restingAsk?: RestingQuote;
  nowSec: number;
  closeSec: number;
  /** Calibrated market probability of YES (p_mkt_cal); target-EV sizing shrinks toward it. */
  pMarket?: number;
  /** Model uncertainty: std of P(YES) across ensemble members. */
  pStd?: number;
  /** Maker adverse-selection buffer in dollars (added to minEdge for quotes). */
  makerBuffer?: number;
  /** Average entry price of the side currently held (profit target, Mode B take-profit). */
  entrySidePrice?: number;
  /** Fees already paid, a contract held (the profit target nets them out). */
  entryFeePerContract?: number;
  /** Best price the held side could have been sold at (its bid) since the position was opened, reversed or added to:
   *  the take-profit's high-water mark (ProfitPeaks). Without it the current bid is the best seen. */
  profitPeakSidePrice?: number;
  /** Why the take-profit is benched (bot/strategy/takeProfitBench.ts): it sells nothing; the model exit still runs. */
  takeProfitBenched?: string;
  /** Entry window open (contract kind, time to close, maintenance). Default: tau >= noEntryBeforeCloseSec. */
  entryWindowOpen?: boolean;
  /** Exits allowed (false in the final minute: ride to settlement). Default true. */
  exitWindowOpen?: boolean;
  /** Inside the last STRATEGY_NO_EXIT_BEFORE_CLOSE_FRAC of the contract's window (Steven's rule, Oct 29): a position in profit
   *  after fees rides to settlement (no exit sells it); one that is not keeps its exits. Default false. */
  settleShare?: boolean;
}

export interface OrderPlan {
  side: BookSide;
  price: number;
  count: number;
  timeInForce: TimeInForce;
  postOnly: boolean;
  reduceOnly: boolean;
  purpose: OrderPurpose;
  expirationTime?: number;
  edge: number;
  why: string;
  /** Adversarial conviction boost applied to this entry's size (1 = none); widens its per-order caps. */
  boost?: number;
  /** A protective exit (the take-profit's last tick above its floor): the exit-in-profit curve never holds it. */
  protective?: boolean;
}

export interface StrategyOutput {
  place: OrderPlan[];
  cancel: Array<{ clientOrderId: string; reason: string }>;
  notes: string[];
  /** PACER_FLOOR: the held position's profit covers what the hour needs while another exit rule aims higher (`why`); the
   *  caller arms its floor at `usd` (bot/risk/quotaPacer.ts QuotaFloors) and passes it back as opts.pacerFloor. */
  pacerArm?: { usd: number; why: string };
}

/** Decision probability of YES: the model, or shrunk toward the calibrated market under target-EV sizing. */
export function decisionProbability(v: Pick<MarketView, 'pYes' | 'pMarket'>, cfg: Pick<StrategyConfig, 'sizing' | 'kappa'>): number {
  if (cfg.sizing !== 'target_ev' || v.pMarket === undefined) return v.pYes;
  return v.pMarket + cfg.kappa * (v.pYes - v.pMarket);
}

/** `opts.exits: false` disables the built-in model exit (another exit policy
 * manages the position). `opts.blockReductions: true` suppresses every order
 * that would reduce the current position (the opposite-side quote and
 * opposite-side takes), used while a winner is being run under the confluence
 * ratchet. `opts.entries: false` evaluates exits only and leaves resting quotes
 * untouched (relaxed cadence between scheduled evaluations). */
/** A position's whole profit after fees if sold at its side's bid now: `cost` is the side-terms cost a contract, entry fee in
 *  (undefined: unknown), `bid`/`ask` the YES book's top (a NO position sells at 1 - ask). Undefined when flat or unknown. */
export function positionNetAtBid(position: number, cost: number | undefined, bid: { price: number } | undefined, ask: { price: number } | undefined, fees?: FeeSchedule): number | undefined {
  if (cost === undefined) return undefined;
  if (position > 0 && bid) return position * (bid.price - cost) - orderFee(position, bid.price, true, fees);
  if (position < 0 && ask) {
    const noBid = round(1 - ask.price, 4);
    return -position * (noBid - cost) - orderFee(-position, noBid, true, fees);
  }
  return undefined;
}

/** The whole position's profit after fees if sold at its side's bid now (undefined: flat, no cost basis or no bid). The quota
 *  snipe's measure (bot/risk/quotaPacer.ts), shared with the engine's group judgement. */
export function netProfitAtBid(v: MarketView): number | undefined {
  const cost = v.entrySidePrice !== undefined ? v.entrySidePrice + (v.entryFeePerContract ?? 0) : undefined;
  return positionNetAtBid(v.position, cost, v.bestBid, v.bestAsk, v.fees);
}

/** Steven's rule (Oct 29): inside the last share of the window a position in profit after fees rides to settlement. */
export function ridesToSettlement(v: MarketView): boolean {
  return v.exitWindowOpen !== false && v.settleShare === true && v.position !== 0 && (netProfitAtBid(v) ?? 0) > 1e-9;
}

/** Steven's settlement rule (Oct 31: nothing rides to settlement unless it is in the last share of its window and in profit)
 *  and the sizing lab's loser exits (cfg.loserExits, section L). A position not in profit after fees at its side's bid is sold
 *  there, the top bid's size: inside the last share of the window or the final minute (the window cut), and anywhere once
 *  the spot fair value of its side is below the bid less the taker fee a contract less the margin (the loser cut: the index
 *  moves before Kalshi does, so it sells at once). Undefined: no such sale (in profit, no bid, no cost basis, or off). */
export function loserExit(v: MarketView, cfg: Pick<StrategyConfig, 'loserExits'>): OrderPlan | undefined {
  const L = cfg.loserExits;
  if (!L || (!L.cut && !L.window) || v.position === 0) return undefined;
  const long = v.position > 0;
  const top = long ? v.bestBid : v.bestAsk;
  if (!top || !(top.size > 0)) return undefined;
  const net = netProfitAtBid(v);
  if (net === undefined || net > 1e-9) return undefined;
  const sideBid = long ? top.price : round(1 - top.price, 4);
  const n = round(Math.min(Math.abs(v.position), top.size), 2);
  if (!(n > 0)) return undefined;
  const fee = orderFee(n, sideBid, true, v.fees) / n;
  const fvSide = v.pFair === undefined ? undefined : long ? v.pFair : 1 - v.pFair;
  const held = `${Math.abs(v.position)}${long ? '' : ' NO'}`;
  let why: string | undefined;
  if (L.window && (v.settleShare === true || v.exitWindowOpen === false)) {
    why = `loser window cut: ${net.toFixed(2)} net after fees on ${held} at bid ${sideBid.toFixed(2)}, ${Math.round(v.tauSec)} s to the close (only a position in profit rides to settlement)`;
  } else if (L.cut && fvSide !== undefined && fvSide < sideBid - fee - L.cutMargin - 1e-9) {
    why = `loser cut: fair value ${fvSide.toFixed(3)} < bid ${sideBid.toFixed(2)} - fee ${fee.toFixed(3)} - ${L.cutMargin}, ${net.toFixed(2)} net after fees on ${held}`;
  }
  if (!why) return undefined;
  return { side: long ? 'ask' : 'bid', price: top.price, count: n, timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: true, purpose: 'exit',
    edge: fvSide === undefined ? 0 : sideBid - fee - fvSide, why };
}

/** FV_ENTRY_GATE (cfg.loserExits): an entry's side, bought at `cost` a contract with `fee`, must leave the spot fair value of
 *  that side at least the margin above cost plus fee. True when the gate is off or no fair value is known. */
export function fvGatePasses(pFair: number | undefined, side: 'yes' | 'no', cost: number, fee: number, cfg: Pick<StrategyConfig, 'loserExits'>): boolean {
  const L = cfg.loserExits;
  if (!L?.gate || pFair === undefined) return true;
  return (side === 'yes' ? pFair : 1 - pFair) >= cost + fee + L.gateMargin - 1e-9;
}

/** The fair value gate on a finished plan (after the fill model turns quotes into crosses and paper adds its training trades):
 *  drops each order that opens or adds to a position at a cost the gate refuses. An order that only reduces the position is
 *  kept. Returns how many were dropped. */
export function applyFvGate(plan: StrategyOutput, pFair: number | undefined, position: number, fees: FeeSchedule | undefined, cfg: Pick<StrategyConfig, 'loserExits'>): number {
  if (!cfg.loserExits?.gate || pFair === undefined) return 0;
  const before = plan.place.length;
  plan.place = plan.place.filter((p) => {
    if (p.reduceOnly || p.purpose === 'exit' || !(p.count > 0)) return true;
    const buysYes = p.side === 'bid';
    if (buysYes ? position < 0 && p.count <= -position + 1e-9 : position > 0 && p.count <= position + 1e-9) return true;
    const cost = buysYes ? p.price : round(1 - p.price, 4);
    const ok = fvGatePasses(pFair, buysYes ? 'yes' : 'no', cost, orderFee(p.count, cost, !p.postOnly, fees) / p.count, cfg);
    if (!ok) plan.notes.push(`fair value gate: dropped ${p.purpose} ${buysYes ? 'YES' : 'NO'} at ${cost.toFixed(2)} (fair value ${(buysYes ? pFair : 1 - pFair).toFixed(3)} under cost + fee + ${cfg.loserExits!.gateMargin})`);
    return ok;
  });
  return before - plan.place.length;
}

export function decide(v: MarketView, cfg: StrategyConfig, opts: {
  exits?: boolean; blockReductions?: boolean; entries?: boolean; profitMandate?: number; pacerUsd?: number; pacerGroup?: { sumUsd: number; members: number };
  /** PACER_FLOOR: the position's armed floor in dollars (QuotaFloors); why a rule outside this function rides a winner (the
   *  hunt trailing its stop, from the engine); set sell prices of rules outside it (side terms, e.g. the TA's take-profit). */
  pacerFloor?: number; pacerHigher?: string; higherTargets?: Array<{ why: string; sidePrice: number }>;
} = {}): StrategyOutput {
  const out: StrategyOutput = { place: [], cancel: [], notes: [] };
  const tick = v.tickSize;
  const bid = v.bestBid;
  const ask = v.bestAsk;
  const q = decisionProbability(v, cfg);
  const targetEv = cfg.sizing === 'target_ev';
  // Probabilities for the PURCHASED side: YES -> (q, p_mkt), NO -> (1 - q, 1 - p_mkt).
  const sized = (side: 'yes' | 'no', cost: number, fee: number, maxContracts: number) => {
    const qm = side === 'yes' ? v.pYes : 1 - v.pYes;
    if (targetEv && v.pMarket !== undefined) {
      const qk = side === 'yes' ? v.pMarket : 1 - v.pMarket;
      return targetEvSize({ qModel: qm, qMarket: qk, cost, feePerContract: fee, bankroll: v.bankroll, maxRiskUsd: v.maxOrderRiskUsd, maxContracts },
        { kappa: cfg.kappa, kellyFraction: cfg.kellyFraction, ...evThresholds(cfg, v.bankroll, v.maxOrderRiskUsd), minEdge: cfg.minEdge });
    }
    return kellySize({ q: side === 'yes' ? q : 1 - q, cost, feePerContract: fee, bankroll: v.bankroll, kellyFraction: cfg.kellyFraction, maxRiskUsd: v.maxOrderRiskUsd, maxContracts });
  };
  // Sizing decides whether a trade is worth taking; a paper order size (PAPER_ORDER_FRAC / PAPER_ORDER_USD) or the order
  // band (ORDER_USD_MIN / ORDER_USD_MAX: the sized stake clamped into it) then decides how much.
  const size = (side: 'yes' | 'no', cost: number, fee: number, maxContracts: number) => {
    const k = sized(side, cost, fee, maxContracts);
    if (!(k.contracts > 0)) return k;
    const room = Math.min(v.maxOrderRiskUsd, v.newRiskRoomUsd ?? Infinity);
    if (v.fixedOrderUsd! > 0) {
      const usd = Math.min(v.fixedOrderUsd!, room);
      const contracts = floorCount(Math.min(maxContracts, usd / (cost + fee)));
      return contracts > 0 ? { ...k, contracts, riskUsd: contracts * (cost + fee) } : k;
    }
    const b = v.orderBandUsd;
    if (!b) return k;
    const unit = cost + fee;
    const inBand = (usd: number) => {
      const contracts = floorCount(Math.min(maxContracts, usd / unit));
      return contracts > 0 && contracts * unit >= b.min - 0.01 ? { ...k, contracts, riskUsd: contracts * unit } : undefined;
    };
    // Never below the band. When the risk room cannot fit even the minimum, the minimum still goes out, for the risk
    // gateway to refuse with its reason (free cash on the market's shard, the window or total cap); when the contract
    // cap cannot fit it, nothing.
    return inBand(Math.min(Math.max(k.contracts * unit, b.min), b.max, room)) ?? inBand(b.min) ?? { ...k, contracts: 0, riskUsd: 0 };
  };
  // A maker quote sizing wants (contracts > 0) is at least minQuoteContracts, as far as the per-order caps and the risk
  // room left allow; never smaller than sizing asked for.
  const quoteSize = (contracts: number, cost: number, fee: number) => {
    const min = cfg.minQuoteContracts ?? 0;
    if (!(contracts > 0) || contracts >= min) return contracts;
    const room = Math.min(v.maxOrderRiskUsd, v.newRiskRoomUsd ?? Infinity);
    return Math.max(contracts, floorCount(Math.min(min, v.maxContracts, room / (cost + fee))));
  };

  // ---- Exits (risk-reducing, allowed in every style) ------------------------
  // The final minute and the last share of the window (settleShare) hold a position in profit after fees; under the loser exits
  // (cfg.loserExits, Steven's rule of Oct 31) one that is not is sold, and the loser cut sells one the index has turned on.
  const riding = ridesToSettlement(v);
  const cut = loserExit(v, cfg);
  if (cut) out.place.push(cut);
  const exitWindow = v.exitWindowOpen !== false && !riding && !cut;
  if (v.exitWindowOpen === false && v.position !== 0 && !cut) out.notes.push('final minute: riding to settlement');
  if (riding) out.notes.push('final share of the window, in profit after fees: riding to settlement');
  const exits = opts.exits !== false && exitWindow;
  const margin = cfg.exitMargin ?? cfg.takerBuffer;
  // Take-profit: what selling the held side at its touch banks a contract over its cost, net of every fee. The floor is
  // the larger of the cents minimum and the percentage of what a contract cost (price plus the entry fee). A winner
  // runs: once the best gain since the position was opened reached the floor it is sold when the gain falls back,
  // either by profitGiveBack of the best or into the last tick above the floor (protective: the curve never holds
  // it), never below the floor. A price that gaps through the floor leaves the position to the model exit until it
  // is back above it. profitGiveBack 0: sold as soon as the floor is reached.
  const floor = v.entrySidePrice === undefined ? 0 : Math.max(cfg.profitTarget ?? 0, (cfg.profitTargetPct ?? 0) * (v.entrySidePrice + (v.entryFeePerContract ?? 0)));
  const banked = (sidePx: number, exitFee: number) => (floor > 0 ? sidePx - v.entrySidePrice! - (v.entryFeePerContract ?? 0) - exitFee : -Infinity);
  const giveBack = cfg.profitGiveBack ?? 0;
  const takeProfit = (n: number, sidePx: number, exitFee: number, label: string) => {
    const net = banked(sidePx, exitFee);
    const peak = v.profitPeakSidePrice;
    const best = peak !== undefined && peak > sidePx ? Math.max(net, banked(peak, orderFee(n, peak, true, v.fees) / n)) : net;
    if (!(best >= floor - 1e-9)) return { sell: false, protective: false, why: '' };
    if (v.takeProfitBenched) {
      out.notes.push(`take-profit benched${label}: +${net.toFixed(3)} now, best +${best.toFixed(3)}, not sold (${v.takeProfitBenched})`);
      return { sell: false, protective: false, why: '' };
    }
    const sellBelow = Math.max(best * (1 - giveBack), floor + tick);
    const lastTick = net <= floor + tick + 1e-9;
    const sell = net >= floor - 1e-9 && (giveBack <= 0 || (net < best - 1e-9 && (lastTick || net <= best * (1 - giveBack) + 1e-9)));
    if (!sell) {
      out.notes.push(`take-profit armed${label}: +${net.toFixed(3)} now, best +${best.toFixed(3)}; sells at or below +${Math.min(sellBelow, best).toFixed(3)}, never under the +${floor.toFixed(3)} floor`);
      return { sell: false, protective: false, why: '', riding: true };
    }
    return { sell, protective: lastTick && giveBack > 0, why: `take-profit${label}: +${net.toFixed(3)} a contract net of fees (best +${best.toFixed(3)}, floor +${floor.toFixed(3)})` };
  };
  // Steven's profit rules (Oct 29). The quota snipe (PACER, bot/risk/quotaPacer.ts): outside the last share of the window
  // (settleShare) a position whose whole net profit after fees, sold at the bid, covers opts.pacerUsd (what the rest of the
  // clock hour owes, clamped) is sold at the bid whatever the exit policy, the hunt or the model says; a thin bid takes what it
  // can and the rest is judged again next tick. Inside that final share a position in profit rides to settlement. The profit
  // mandate (PROFIT_MANDATE, off by default) sells any position whose side bid net of the exit fee clears its entry cost (fee
  // in) by opts.profitMandate; the caller leaves it undefined while a hunt trails its stop (the stop is that position's profit
  // take, bot/engine.ts) and when it is off. A take-profit that sells the same tick keeps its name (its bench scores it).
  // opts.pacerGroup (Steven's addition, Oct 30): this position is in profit after fees and, with the other positions in profit,
  // covers the target, so it is sold at the bid whatever its own net profit (bot/risk/quotaPacer.ts SnipeGroup).
  const mandateMin = opts.profitMandate;
  const cost = v.entrySidePrice !== undefined ? v.entrySidePrice + (v.entryFeePerContract ?? 0) : undefined;
  const mandate = mandateMin !== undefined && cost !== undefined && exitWindow;
  const pacerUsd = opts.pacerUsd;
  const sniping = pacerUsd !== undefined && cost !== undefined && exitWindow;
  // PACER_FLOOR (Steven, Oct 31): while another exit rule aims higher than the quota, the quota is the position's stop, not its
  // sale (bot/risk/quotaPacer.ts quotaCall): its profit covering the need arms a floor there, and the position is sold once the
  // profit falls below it. A set sell price above the bid and below the payout aims higher in either mode: the model exit's
  // (the value plus the margin and the fee), a resting sell (the curve's, the hunt's wall ask), a rule's target passed in. In
  // riding mode so does a rule riding a winner: the take-profit trailing its best, the hunt trailing its stop (from the
  // engine). A position held only for settlement does not aim higher (Steven's rule of Oct 29: the quota is taken then).
  const floorMode = cfg.pacer?.floor ?? 'off';
  const aimsHigher = (sideBid: number, modelPx: number, tp: { riding?: boolean } | undefined): string | undefined => {
    if (floorMode === 'off') return undefined;
    const set = (px: number | undefined) => px !== undefined && px > sideBid + 1e-9 && px <= 1 - tick + 1e-9;
    if (exits && set(modelPx)) return `the model's sell price ${modelPx.toFixed(2)}`;
    if (set(v.curveRestSidePrice)) return `the curve's sell resting at ${v.curveRestSidePrice!.toFixed(2)}`;
    if (set(v.huntRestSidePrice)) return `the hunt's sell resting at the wall ${v.huntRestSidePrice!.toFixed(2)}`;
    for (const t of opts.higherTargets ?? []) if (set(t.sidePrice)) return `${t.why} at ${t.sidePrice.toFixed(2)}`;
    if (floorMode !== 'riding' && floorMode !== 'trail') return undefined;
    if (exits && tp?.riding) return 'the take-profit riding its best';
    return opts.pacerHigher ?? (floorMode === 'trail' ? 'the quota trailing its best' : undefined);
  };
  const quota = (netUsd: number, sideBid: number, modelPx: number, tp: { sell: boolean; riding?: boolean } | undefined, selling: boolean) => {
    const higher = sniping && !selling ? aimsHigher(sideBid, modelPx, tp) : undefined;
    const cushion = (cfg.pacer?.floorTicks ?? 0) * tick * Math.abs(v.position);
    let call = sniping ? quotaCall(netUsd, pacerUsd, opts.pacerFloor, higher, floorMode === 'trail' ? cfg.pacer?.trailKeep : undefined, cushion) : {};
    if (call.sell === 'floor' && cfg.pacer?.floorConfirm === 'model') {
      // The model's value of the position: its side at the model's probability (q for YES, 1 - q for NO), after the exit fee.
      const modelNet = positionNetAtBid(v.position, cost, { price: q }, { price: q }, v.fees);
      if (modelNet !== undefined && modelNet >= opts.pacerFloor! - cushion - 1e-9) {
        out.notes.push(`quota floor held: +$${netUsd.toFixed(2)} net at bid ${sideBid.toFixed(2)} is below its $${opts.pacerFloor!.toFixed(2)} floor, but the model values the position at +$${modelNet.toFixed(2)}`);
        call = {};
      }
    }
    if (call.arm !== undefined) {
      out.pacerArm = { usd: call.arm, why: higher! };
      out.notes.push(`quota floor: +$${netUsd.toFixed(2)} net covers the $${call.arm.toFixed(2)} the hour needs; held for ${higher}, sold if the profit falls below its floor`);
    }
    return { call, grouped: opts.pacerGroup !== undefined && netUsd > 1e-9 && higher === undefined };
  };
  if ((exits || mandate || sniping) && v.position > 0 && bid) {
    const n = Math.min(v.position, bid.size);
    const fee = n > 0 ? orderFee(n, bid.price, true, v.fees) / n : 0;
    const edge = bid.price - q - fee;
    const tp = exits && n > 0 ? takeProfit(n, bid.price, fee, '') : undefined;
    const pm = mandate && n > 0 && bid.price - fee >= cost! + mandateMin! - 1e-9;
    const netUsd = sniping ? netProfitAtBid(v) ?? 0 : 0;
    const { call, grouped } = quota(netUsd, bid.price, q + fee + margin, tp, exits && (edge >= margin || tp?.sell === true));
    const snipe = sniping && n > 0 && (call.sell !== undefined || grouped);
    if (n > 0 && ((exits && (edge >= margin || tp?.sell)) || pm || snipe)) {
      out.place.push({ side: 'ask', price: bid.price, count: round(n, 2), timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: true, purpose: 'exit', edge,
        ...(tp?.sell && tp.protective ? { protective: true } : {}),
        why: tp?.sell ? tp.why : snipe ? (call.sell === 'floor' ? `quota snipe (floor): +$${netUsd.toFixed(2)} net on ${v.position} at bid ${bid.price} fell below its $${opts.pacerFloor!.toFixed(2)} floor`
            : call.sell === 'snipe' ? `quota snipe: +$${netUsd.toFixed(2)} net on ${v.position} at bid ${bid.price} covers the $${pacerUsd!.toFixed(2)} the hour needs`
            : `quota snipe (group): +$${netUsd.toFixed(2)} net on ${v.position} at bid ${bid.price}, with ${opts.pacerGroup!.members - 1} other position${opts.pacerGroup!.members === 2 ? '' : 's'} in profit (+$${opts.pacerGroup!.sumUsd.toFixed(2)} together) covers the $${pacerUsd!.toFixed(2)} the hour needs`)
          : exits && edge >= margin ? `bid ${bid.price} - fee > q ${q.toFixed(3)} + ${margin}` : `profit mandate exit: bid ${bid.price} - fee ${fee.toFixed(3)} >= cost ${cost!.toFixed(3)} + ${mandateMin}` });
    }
  } else if ((exits || mandate || sniping) && v.position < 0 && ask) {
    const n = Math.min(-v.position, ask.size);
    const noBid = round(1 - ask.price, 4);
    const fee = n > 0 ? orderFee(n, noBid, true, v.fees) / n : 0;
    const edge = q - ask.price - fee;
    const tp = exits && n > 0 ? takeProfit(n, noBid, fee, ' NO') : undefined;
    const pm = mandate && n > 0 && noBid - fee >= cost! + mandateMin! - 1e-9;
    const netUsd = sniping ? netProfitAtBid(v) ?? 0 : 0;
    const { call, grouped } = quota(netUsd, noBid, 1 - q + fee + margin, tp, exits && (edge >= margin || tp?.sell === true));
    const snipe = sniping && n > 0 && (call.sell !== undefined || grouped);
    if (n > 0 && ((exits && (edge >= margin || tp?.sell)) || pm || snipe)) {
      out.place.push({ side: 'bid', price: ask.price, count: round(n, 2), timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: true, purpose: 'exit', edge,
        ...(tp?.sell && tp.protective ? { protective: true } : {}),
        why: tp?.sell ? tp.why : snipe ? (call.sell === 'floor' ? `quota snipe (floor): +$${netUsd.toFixed(2)} net on ${-v.position} NO at bid ${noBid.toFixed(2)} fell below its $${opts.pacerFloor!.toFixed(2)} floor`
            : call.sell === 'snipe' ? `quota snipe: +$${netUsd.toFixed(2)} net on ${-v.position} NO at bid ${noBid.toFixed(2)} covers the $${pacerUsd!.toFixed(2)} the hour needs`
            : `quota snipe (group): +$${netUsd.toFixed(2)} net on ${-v.position} NO at bid ${noBid.toFixed(2)}, with ${opts.pacerGroup!.members - 1} other position${opts.pacerGroup!.members === 2 ? '' : 's'} in profit (+$${opts.pacerGroup!.sumUsd.toFixed(2)} together) covers the $${pacerUsd!.toFixed(2)} the hour needs`)
          : exits && edge >= margin ? `NO bid ${noBid.toFixed(2)} - fee > q + ${margin}` : `profit mandate exit: NO bid ${noBid.toFixed(2)} - fee ${fee.toFixed(3)} >= cost ${cost!.toFixed(3)} + ${mandateMin}` });
    }
  }

  if (opts.entries === false) return out;

  const entriesAllowed = (v.entryWindowOpen ?? true) && v.tauSec >= v.noEntryBeforeCloseSec;
  // Ensemble veto: the model's disagreement with the market must exceed its own uncertainty.
  const vetoed = v.pStd !== undefined && v.pMarket !== undefined && cfg.ensembleVetoSigmas > 0 && Math.abs(v.pYes - v.pMarket) < cfg.ensembleVetoSigmas * v.pStd;
  const newRisk = entriesAllowed && !vetoed;
  const quoteAllowed = newRisk && !v.fastMove;
  if (!entriesAllowed) out.notes.push('outside entry window');
  if (vetoed) out.notes.push(`ensemble veto: |p - p_mkt| < ${cfg.ensembleVetoSigmas} x ${v.pStd!.toFixed(3)}`);
  if (v.fastMove) out.notes.push('fast index move: quotes pulled');
  // FV_ENTRY_GATE (cfg.loserExits; the sizing lab, Oct 31): new risk only where the spot fair value of the side bought is at
  // least its cost with the fee plus the margin (the positions that rode to settlement losing were bad from the start).
  const gate = (side: 'yes' | 'no', cost: number, n: number, taker: boolean): boolean => {
    const fee = n > 0 ? orderFee(n, cost, taker, v.fees) / n : 0;
    if (fvGatePasses(v.pFair, side, cost, fee, cfg)) return true;
    out.notes.push(`fair value gate: ${side.toUpperCase()} fair value ${(side === 'yes' ? v.pFair! : 1 - v.pFair!).toFixed(3)} < ${cost.toFixed(2)} + fee ${fee.toFixed(3)} + ${cfg.loserExits!.gateMargin}`);
    return false;
  };

  // ---- Maker quotes -----------------------------------------------------------
  let desiredBid: OrderPlan | undefined;
  let desiredAsk: OrderPlan | undefined;
  const quoting = (cfg.style === 'maker' || cfg.style === 'both') && bid && ask;
  const offset = cfg.minEdge + (v.makerBuffer ?? 0);
  const expiry = Math.min(v.nowSec + cfg.orderTtlSec, v.closeSec - Math.max(1, Math.floor(v.noEntryBeforeCloseSec)));
  if (quoting && quoteAllowed) {
    const skewed = q - cfg.inventorySkewPerContract * v.position;

    // YES bid.
    let bp = floorToTick(skewed - offset, tick);
    bp = Math.min(bp, round(ask.price - tick, 4));
    if (bp >= v.minSidePrice && bp <= 1 - v.minSidePrice) {
      const fee = orderFee(1, bp, false, v.fees);
      const k = size('yes', bp, fee, v.maxContracts);
      const unwind = Math.max(0, -v.position);
      const fresh = k.contracts > 0 && gate('yes', bp, k.contracts, false) ? k.contracts : 0;
      const count = round(Math.min(v.maxContracts, quoteSize(fresh, bp, fee) + unwind), 2);
      if (count > 0) desiredBid = { side: 'bid', price: bp, count, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, purpose: 'quote', expirationTime: expiry, edge: q - bp - fee, why: 'maker bid' };
    }
    // YES ask (= NO bid at 1 - ap).
    let ap = ceilToTick(skewed + offset, tick);
    ap = Math.max(ap, round(bid.price + tick, 4));
    const noCost = round(1 - ap, 4);
    if (noCost >= v.minSidePrice && noCost <= 1 - v.minSidePrice) {
      const fee = orderFee(1, noCost, false, v.fees);
      const k = size('no', noCost, fee, v.maxContracts);
      const unwind = Math.max(0, v.position);
      const fresh = k.contracts > 0 && gate('no', noCost, k.contracts, false) ? k.contracts : 0;
      const count = round(Math.min(v.maxContracts, quoteSize(fresh, noCost, fee) + unwind), 2);
      if (count > 0) desiredAsk = { side: 'ask', price: ap, count, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, purpose: 'quote', expirationTime: expiry, edge: (1 - q) - noCost - fee, why: 'maker ask' };
    }
  }
  // Mode B: a resting maker take-profit on the held side at entry + TP, never below
  // the model's value of the position + exitMargin (then holding is better).
  if (quoting && cfg.exitPolicy === 'take_profit' && v.position !== 0 && v.entrySidePrice !== undefined && !opts.blockReductions) {
    const long = v.position > 0;
    const qSide = long ? q : 1 - q;
    const sidePx = Math.max(v.entrySidePrice + cfg.takeProfit, qSide + margin);
    const n = round(Math.abs(v.position), 2);
    if (sidePx < 1) {
      if (long) {
        const ap = Math.max(ceilToTick(sidePx, tick), round(bid!.price + tick, 4));
        desiredAsk = { side: 'ask', price: ap, count: n, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, purpose: 'quote', expirationTime: v.closeSec - 1, edge: ap - qSide, why: `take-profit ${ap}` };
      } else {
        const bp = Math.min(floorToTick(1 - sidePx, tick), round(ask!.price - tick, 4));
        desiredBid = { side: 'bid', price: bp, count: n, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, purpose: 'quote', expirationTime: v.closeSec - 1, edge: (1 - bp) - qSide, why: `take-profit NO ${round(1 - bp, 4)}` };
      }
    }
  }
  // Exit curve, rest mode (paper; the owner's choice on Oct 23): the held side's sell rests at the curve's estimate of
  // where the current swing tops out (SinuousExitGate.restTarget), never below the take-profit floor, in place of the
  // opposite-side maker quote and sized to the position exactly: a resting exit (purpose exit, post-only; Kalshi takes
  // reduce-only on immediate-or-cancel orders only). Not while an exit crosses the book this tick, nor while a hunt runs
  // the winner (blockReductions).
  let restSide: 'bid' | 'ask' | undefined;
  if (quoting && v.curveRestSidePrice !== undefined && v.position !== 0 && v.entrySidePrice !== undefined && !opts.blockReductions) {
    const exiting = out.place.some((p) => p.purpose === 'exit' && p.timeInForce === 'immediate_or_cancel');
    const n = round(Math.abs(v.position), 2);
    const cost = v.entrySidePrice + (v.entryFeePerContract ?? 0);
    const target = Math.min(0.99, Math.max(v.curveRestSidePrice, cost + floor));
    const net = (sidePx: number) => sidePx - cost - orderFee(n, sidePx, false, v.fees) / n;
    const why = (sidePx: number, no: string) => `exit curve: rest${no} ${sidePx} (+${net(sidePx).toFixed(3)} a contract net, swing top ${v.curveRestSidePrice!.toFixed(3)})`;
    if (v.position > 0) {
      const ap = Math.max(ceilToTick(target, tick), round(bid!.price + tick, 4));
      desiredAsk = !exiting && ap < 1 ? { side: 'ask', price: ap, count: n, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, purpose: 'exit', expirationTime: v.closeSec - 1, edge: ap - q, why: why(ap, '') } : undefined;
      restSide = 'ask';
    } else {
      const bp = Math.min(floorToTick(1 - target, tick), round(ask!.price - tick, 4));
      desiredBid = !exiting && bp > 0 ? { side: 'bid', price: bp, count: n, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, purpose: 'exit', expirationTime: v.closeSec - 1, edge: q - bp, why: why(round(1 - bp, 4), ' NO') } : undefined;
      restSide = 'bid';
    }
  }
  if (opts.blockReductions) {
    if (v.position > 0) desiredAsk = undefined;
    if (v.position < 0) desiredBid = undefined;
  }
  // Hunt mode's sell-wall ask (HUNT_WALL_ASK, bot/strategy/exitPolicies.ts): the hunted position's sell rests at the sell
  // wall's price (joined behind it, post-only, sized to the position) in the held side's quote slot, the one reduction a hunt
  // allows; pulled like the curve sell when an exit crosses the book this tick, and when the hunt stops asking for it.
  if (quoting && opts.blockReductions && v.huntRestSidePrice !== undefined && v.position !== 0) {
    const exiting = out.place.some((p) => p.purpose === 'exit' && p.timeInForce === 'immediate_or_cancel');
    const n = round(Math.abs(v.position), 2);
    const why = (sidePx: number, no: string) => `confluence ratchet wall ask${no} ${sidePx} (rests behind the sell wall at ${v.huntRestSidePrice!.toFixed(2)})`;
    if (v.position > 0) {
      const ap = Math.max(ceilToTick(v.huntRestSidePrice, tick), round(bid!.price + tick, 4));
      desiredAsk = !exiting && ap < 1 ? { side: 'ask', price: ap, count: n, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, purpose: 'exit', expirationTime: v.closeSec - 1, edge: ap - q, why: why(ap, '') } : undefined;
      restSide = 'ask';
    } else {
      const bp = Math.min(floorToTick(1 - v.huntRestSidePrice, tick), round(ask!.price - tick, 4));
      desiredBid = !exiting && bp > 0 ? { side: 'bid', price: bp, count: n, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, purpose: 'exit', expirationTime: v.closeSec - 1, edge: q - bp, why: why(round(1 - bp, 4), ' NO') } : undefined;
      restSide = 'bid';
    }
  }
  reconcileQuote(v.restingBid, desiredBid, cfg.requoteThreshold, v.nowSec, out, restSide === 'bid');
  reconcileQuote(v.restingAsk, desiredAsk, cfg.requoteThreshold, v.nowSec, out, restSide === 'ask');

  // ---- Selective taking -------------------------------------------------------
  if ((cfg.style === 'taker' || cfg.style === 'both') && newRisk && !v.fastMove && out.place.every((p) => p.purpose !== 'exit' || p.timeInForce !== 'immediate_or_cancel')) {
    const mayBuyYes = !(opts.blockReductions && v.position < 0);
    const mayBuyNo = !(opts.blockReductions && v.position > 0);
    if (mayBuyYes && ask && ask.price >= v.minSidePrice && ask.price <= 1 - v.minSidePrice) {
      const fee1 = orderFee(1, ask.price, true, v.fees);
      const k = size('yes', ask.price, fee1, Math.min(v.maxContracts, ask.size));
      if (k.contracts > 0) {
        const fee = orderFee(k.contracts, ask.price, true, v.fees) / k.contracts;
        const edge = q - ask.price - fee;
        if (edge >= cfg.takerBuffer + cfg.minEdge && gate('yes', ask.price, k.contracts, true)) {
          out.place.push({ side: 'bid', price: ask.price, count: k.contracts, timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: false, purpose: 'entry', edge, why: `take YES: q ${q.toFixed(3)} vs ask ${ask.price}` });
        }
      }
    }
    const noCost = bid ? round(1 - bid.price, 4) : 0;
    if (mayBuyNo && bid && noCost >= v.minSidePrice && noCost <= 1 - v.minSidePrice) {
      const fee1 = orderFee(1, noCost, true, v.fees);
      const k = size('no', noCost, fee1, Math.min(v.maxContracts, bid.size));
      if (k.contracts > 0) {
        const fee = orderFee(k.contracts, noCost, true, v.fees) / k.contracts;
        const edge = (1 - q) - noCost - fee;
        if (edge >= cfg.takerBuffer + cfg.minEdge && gate('no', noCost, k.contracts, true)) {
          out.place.push({ side: 'ask', price: bid.price, count: k.contracts, timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: false, purpose: 'entry', edge, why: `take NO: q ${q.toFixed(3)} vs bid ${bid.price}` });
        }
      }
    }
  }
  return out;
}

/** A resting quote this close to its exchange expiry (seconds) is replaced rather than left to lapse. */
const EXPIRY_LEAD_SEC = 1;

/** `exact`: the resting order is a position's exit, requoted whenever its size differs from the position's. */
function reconcileQuote(resting: RestingQuote | undefined, desired: OrderPlan | undefined, threshold: number, nowSec: number, out: StrategyOutput, exact = false): void {
  if (resting && !desired) {
    out.cancel.push({ clientOrderId: resting.clientOrderId, reason: 'quote no longer wanted' });
    return;
  }
  if (!desired) return;
  if (!resting) {
    out.place.push(desired);
    return;
  }
  const moved = Math.abs(resting.price - desired.price) >= threshold - 1e-9;
  // Only requote size when it shrinks materially (never chase size up and lose queue priority); an exit matches the
  // position exactly, so it never sells more than is held.
  const shrink = exact ? Math.abs(desired.count - resting.remaining) > 1e-9 : desired.count < resting.remaining * 0.5;
  // A quote at its exchange expiry is placed again, when the replacement would outlive it (not at the close, where both end together).
  const expiring = resting.expiresSec !== undefined && resting.expiresSec - nowSec <= EXPIRY_LEAD_SEC && (desired.expirationTime ?? Infinity) > resting.expiresSec;
  if (moved || shrink || expiring) {
    out.cancel.push({ clientOrderId: resting.clientOrderId, reason: moved ? `requote ${resting.price} -> ${desired.price}` : shrink ? 'size shrink' : 'quote expiring' });
    out.place.push(desired);
  }
}
