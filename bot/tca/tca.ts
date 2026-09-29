// Transaction cost analysis. For every fill: model fair value at decision,
// limit price, fill price, fee, and the market mid 5 s / 30 s / 60 s later
// (markouts). Markouts are signed so positive = the market moved our way;
// consistently negative maker markouts mean we are being picked off
// (adverse selection).

import fs from 'fs';
import path from 'path';
import type { ExchangeFill } from '../kalshi/types';
import type { OrderRecord } from '../oms/orderState';

export interface TcaRecord {
  tradeId: string;
  ticker: string;
  side: 'bid' | 'ask';
  count: number;
  price: number;
  fee: number;
  isTaker: boolean;
  purpose?: string;
  limitPrice?: number;
  fairValueAtDecision?: number;
  modelId?: string;
  /** (q - cost - fee) per contract at decision fair value. */
  edgeAtDecision?: number;
  midAtFill?: number;
  markouts: Record<string, number | null>;
  ts: number;
}

const HORIZONS = [5, 30, 60];

export class Tca {
  private readonly recent: TcaRecord[] = [];
  private readonly file: string;

  constructor(dir: string, private readonly midOf: (ticker: string) => number | undefined) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'tca.jsonl');
  }

  onFill(f: ExchangeFill, order: OrderRecord | undefined, fee: number): void {
    const sign = f.side === 'bid' ? 1 : -1; // bought YES profits when YES mid rises
    const cost = f.side === 'bid' ? f.price : 1 - f.price;
    const q = order ? (f.side === 'bid' ? order.fairValue : 1 - order.fairValue) : undefined;
    const rec: TcaRecord = {
      tradeId: f.tradeId,
      ticker: f.ticker,
      side: f.side,
      count: f.count,
      price: f.price,
      fee,
      isTaker: f.isTaker,
      purpose: order?.purpose,
      limitPrice: order?.price,
      fairValueAtDecision: order?.fairValue,
      modelId: order?.modelId,
      edgeAtDecision: q !== undefined ? q - cost - fee / f.count : undefined,
      midAtFill: this.midOf(f.ticker),
      markouts: {},
      ts: f.ts,
    };
    this.recent.push(rec);
    if (this.recent.length > 2000) this.recent.shift();
    let pending = HORIZONS.length;
    for (const h of HORIZONS) {
      setTimeout(() => {
        const mid = this.midOf(f.ticker);
        rec.markouts[`${h}s`] = mid === undefined ? null : sign * (mid - f.price);
        if (--pending === 0) fs.appendFileSync(this.file, JSON.stringify(rec) + '\n', { mode: 0o600 });
      }, h * 1000).unref();
    }
  }

  summary(): Record<string, unknown> {
    const rows = this.recent;
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const by = (maker: boolean) => rows.filter((r) => r.isTaker !== maker);
    const block = (rs: TcaRecord[]) => ({
      fills: rs.length,
      contracts: rs.reduce((a, r) => a + r.count, 0),
      fees: rs.reduce((a, r) => a + r.fee, 0),
      avgEdgeAtDecision: avg(rs.map((r) => r.edgeAtDecision).filter((x): x is number => x !== undefined)),
      avgMarkout5s: avg(rs.map((r) => r.markouts['5s']).filter((x): x is number => typeof x === 'number')),
      avgMarkout30s: avg(rs.map((r) => r.markouts['30s']).filter((x): x is number => typeof x === 'number')),
      avgMarkout60s: avg(rs.map((r) => r.markouts['60s']).filter((x): x is number => typeof x === 'number')),
    });
    return { maker: block(by(true)), taker: block(by(false)), recent: rows.slice(-50).reverse() };
  }
}
