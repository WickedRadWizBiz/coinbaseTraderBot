// Kalshi trading fees (fee schedule PDF) with the exchange's fee rounding (API docs: "Fee Rounding"):
//   model fee  taker = M_taker * 0.07   * C * P * (1 - P)
//              maker = M_maker * 0.0175 * C * P * (1 - P)
//   trade fee  = model fee rounded UP to $0.000001
//   rounding   = what brings the balance change (C x P plus the trade fee) back onto the member's
//                balance grid: $0.01 for non-direct members (FCM-cleared, the default here), $0.0001
//                for direct members (KALSHI_BALANCE_PRECISION)
//   net fee    = trade fee + rounding fee (- rebates of accumulated rounding, which only ever lower it)
// With whole-cent prices and whole contracts this is the familiar "round the fee up to the next cent";
// sub-cent prices and fractional contracts are where the rounding term matters. No settlement fee.
// Multiplier defaults: taker M=1; maker M=0 unless the series is listed in the non-standard table.
// Always prefer the multipliers the series API reports (and its scheduled fee changes) and the
// `average_fee_paid` the exchange returns on each order/fill.

export interface FeeSchedule {
  takerMultiplier: number;
  makerMultiplier: number;
  /** The member's balance precision in dollars (0.01 non-direct, 0.0001 direct). */
  balancePrecision?: number;
}

export const DEFAULT_FEES: FeeSchedule = { takerMultiplier: 1, makerMultiplier: 0 };

const TAKER_RATE = 0.07;
const MAKER_RATE = 0.0175;
let defaultPrecision = 0.01;
/** Set the balance precision used when a schedule doesn't carry one (config: KALSHI_BALANCE_PRECISION). */
export function setBalancePrecision(p: number): void { if (p === 0.01 || p === 0.0001) defaultPrecision = p; }

/** Net fee in dollars for one fill of `count` contracts at side price `price` (the payer's price):
 *  ceil_6dp(model fee), plus the rounding that puts (count x price + fee) back on the balance grid. */
function feeDollars(rate: number, multiplier: number, count: number, price: number, precision: number): number {
  if (!(count > 0) || !(multiplier > 0)) return 0;
  if (!(price > 0 && price < 1)) return 0;
  // Integer micro-dollars: count has 2 dp and price 4 dp, so count x price is exact at 6 dp.
  const model = multiplier * rate * count * price * (1 - price) * 1e6;
  const trade = Math.ceil(Math.round(model * 1e3) / 1e3);
  const notional = Math.round(count * price * 1e6);
  const grid = Math.round(precision * 1e6);
  const charged = Math.ceil((notional + trade) / grid) * grid;
  return (charged - notional) / 1e6;
}

export function takerFee(count: number, price: number, fees: FeeSchedule = DEFAULT_FEES): number {
  return feeDollars(TAKER_RATE, fees.takerMultiplier, count, price, fees.balancePrecision ?? defaultPrecision);
}

export function makerFee(count: number, price: number, fees: FeeSchedule = DEFAULT_FEES): number {
  return feeDollars(MAKER_RATE, fees.makerMultiplier, count, price, fees.balancePrecision ?? defaultPrecision);
}

export function orderFee(count: number, price: number, isTaker: boolean, fees: FeeSchedule = DEFAULT_FEES): number {
  return isTaker ? takerFee(count, price, fees) : makerFee(count, price, fees);
}

/** Per-contract fee used for edge and sizing decisions. Uses the rounded fee on
 * the actual order size so small orders carry their true (rounded-up) cost. */
export function perContractFee(count: number, price: number, isTaker: boolean, fees: FeeSchedule = DEFAULT_FEES): number {
  if (!(count > 0)) return 0;
  return orderFee(count, price, isTaker, fees) / count;
}
