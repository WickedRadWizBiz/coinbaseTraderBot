import type { CreateOrderRequest, ExchangeFill, ExchangeGateway, ExchangeOrder, ExchangePosition } from '../bot/kalshi/types';

/** Scriptable in-memory exchange for OMS / recon tests. */
export class FakeGateway implements ExchangeGateway {
  readonly name = 'fake';
  orders: ExchangeOrder[] = [];
  fills: ExchangeFill[] = [];
  positions: ExchangePosition[] = [];
  balance = 100;
  creates: CreateOrderRequest[] = [];
  /** Hook to throw or alter behaviour per create call. */
  onCreate: (req: CreateOrderRequest, n: number) => ExchangeOrder | Error | 'land-then-throw' = (req) => this.accept(req);
  cancels: string[] = [];

  accept(req: CreateOrderRequest): ExchangeOrder {
    const o: ExchangeOrder = {
      orderId: `ex-${this.orders.length + 1}`, clientOrderId: req.clientOrderId, ticker: req.ticker, side: req.side,
      price: req.price, status: 'resting', fillCount: 0, remainingCount: req.count, initialCount: req.count,
    };
    this.orders.push(o);
    return { ...o };
  }

  async createOrder(req: CreateOrderRequest): Promise<ExchangeOrder> {
    this.creates.push(req);
    const r = this.onCreate(req, this.creates.length);
    if (r === 'land-then-throw') {
      this.accept(req);
      const { OrderStateUnknownError } = await import('../bot/kalshi/types');
      throw new OrderStateUnknownError('timeout');
    }
    if (r instanceof Error) throw r;
    return r;
  }
  async cancelOrder(orderId: string): Promise<void> {
    this.cancels.push(orderId);
    const o = this.orders.find((x) => x.orderId === orderId);
    if (o && o.status === 'resting') { o.status = 'canceled'; o.remainingCount = 0; }
  }
  async getOrder(orderId: string) { const o = this.orders.find((x) => x.orderId === orderId); return o ? { ...o } : undefined; }
  async findOrderByClientId(id: string) { const o = this.orders.find((x) => x.clientOrderId === id); return o ? { ...o } : undefined; }
  async getOpenOrders() { return this.orders.filter((o) => o.status === 'resting').map((o) => ({ ...o })); }
  async getFills(since: number) { return this.fills.filter((f) => f.ts >= since); }
  async getPositions() { return this.positions.map((p) => ({ ...p })); }
  async getBalance() { return this.balance; }
}
