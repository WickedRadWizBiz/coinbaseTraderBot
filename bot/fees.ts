// Kalshi trading fees (fee schedule PDF):
//   taker = round_up(M_taker * 0.07   * C * P * (1 - P))
//   maker = round_up(M_maker * 0.0175 * C * P * (1 - P))
// rounded up to the next cent per order. No settlement fee.
// Multiplier defaults: taker M=1; maker M=0 unless the series is listed in the
// non-standard table. Always prefer the multipliers the series API reports and
// the `average_fee_paid` the exchange returns on each order/fill.

export interface FeeSchedule {
  takerMultiplier: number;
  makerMultiplier: number;
}

export const DEFAULT_FEES: FeeSchedule = { takerMultiplier: 1, makerMultiplier: 0 };

const TAKER_RATE = 0.07;
const MAKER_RATE = 0.0175;

/** Fee in dollars for one order of `count` contracts at YES-or-NO price `price`. */
function feeDollars(rate: number, multiplier: number, count: number, price: number): number {
  if (!(count > 0) || !(multiplier > 0)) return 0;
  if (!(price > 0 && price < 1)) return 0;
  // Work in integer hundred-thousandths of a cent to avoid float drift before ceil.
  const raw = multiplier * rate * count * price * (1 - price) * 100; // cents
  const cents = Math.ceil(Math.round(raw * 1e5) / 1e5);
  return cents / 100;
}

export function takerFee(count: number, price: number, fees: FeeSchedule = DEFAULT_FEES): number {
  return feeDollars(TAKER_RATE, fees.takerMultiplier, count, price);
}

export function makerFee(count: number, price: number, fees: FeeSchedule = DEFAULT_FEES): number {
  return feeDollars(MAKER_RATE, fees.makerMultiplier, count, price);
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
