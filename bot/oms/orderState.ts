// Explicit order state machine.
//
//   PENDING_NEW ──ack──▶ ACKED ──fill──▶ PARTIALLY_FILLED ──fill──▶ FILLED
//        │                 │                    │
//        │                 └──cancel req──▶ CANCEL_PENDING ──▶ CANCELED
//        ├──reject──▶ REJECTED
//        └──timeout/network──▶ UNKNOWN ──(query by client_order_id)──▶ any
//   ACKED / PARTIALLY_FILLED ──ttl──▶ EXPIRED
//
// Terminal: FILLED, CANCELED, REJECTED, EXPIRED. Illegal transitions throw,
// which surfaces bugs instead of silently corrupting state.

import type { BookSide, TimeInForce } from '../kalshi/types';

export type OrderState =
  | 'PENDING_NEW' | 'UNKNOWN' | 'ACKED' | 'PARTIALLY_FILLED' | 'CANCEL_PENDING'
  | 'FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED';

export const TERMINAL: ReadonlySet<OrderState> = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);

const ALLOWED: Record<OrderState, OrderState[]> = {
  PENDING_NEW: ['ACKED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'UNKNOWN', 'CANCEL_PENDING', 'EXPIRED'],
  UNKNOWN: ['ACKED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'CANCEL_PENDING', 'EXPIRED', 'PENDING_NEW'],
  ACKED: ['PARTIALLY_FILLED', 'FILLED', 'CANCEL_PENDING', 'CANCELED', 'EXPIRED'],
  PARTIALLY_FILLED: ['PARTIALLY_FILLED', 'FILLED', 'CANCEL_PENDING', 'CANCELED', 'EXPIRED'],
  CANCEL_PENDING: ['CANCELED', 'FILLED', 'PARTIALLY_FILLED', 'EXPIRED', 'ACKED'],
  FILLED: [],
  CANCELED: [],
  REJECTED: [],
  EXPIRED: [],
};

export function canTransition(from: OrderState, to: OrderState): boolean {
  return from === to || ALLOWED[from].includes(to);
}

export type OrderPurpose = 'quote' | 'entry' | 'exit';

export interface OrderRecord {
  clientOrderId: string;
  orderId?: string;
  ticker: string;
  asset: string;
  windowCloseTs: number;
  side: BookSide;
  price: number;
  count: number;
  timeInForce: TimeInForce;
  postOnly: boolean;
  reduceOnly: boolean;
  expirationTime?: number;
  purpose: OrderPurpose;
  state: OrderState;
  /** Contracts filled according to fills we have applied to positions. */
  filledCount: number;
  /** Contracts filled according to the exchange's order status (may lead fills). */
  exchangeFillCount: number;
  remainingCount: number;
  feesPaid: number;
  avgFillPrice?: number;
  attempts: number;
  cancelRequested: boolean;
  createdTs: number;
  updatedTs: number;
  decisionId: string;
  modelId: string;
  fairValue: number;
  lastError?: string;
}

export function transition(o: OrderRecord, to: OrderState, now: number): void {
  if (!canTransition(o.state, to)) {
    throw new Error(`illegal order transition ${o.state} -> ${to} for ${o.clientOrderId}`);
  }
  o.state = to;
  o.updatedTs = now;
}

export function isLive(o: OrderRecord): boolean {
  return !TERMINAL.has(o.state);
}
