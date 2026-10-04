// Kalshi WebSocket client: order book deltas, public trades, our fills and
// order updates, market lifecycle, and the CF Benchmarks index Kalshi settles
// on. Detects per-subscription sequence gaps and requests a resnapshot;
// reconnects with backoff and emits `reconnected` so the reconciler runs.

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { logger } from '../util/log';
import { parseCount, parseDollars } from '../util/num';
import type { KalshiSigner } from './auth';
import type { BookLevel, ExchangeFill, ExchangeOrder } from './types';
import { parseFill, parseOrder, yesPrice } from './wire';
import { recordLatency } from '../util/latency';

const log = logger('kalshi-ws');

export interface WsEvents {
  book_snapshot: (e: { ticker: string; bids: BookLevel[]; asks: BookLevel[]; ts: number }) => void;
  book_delta: (e: { ticker: string; side: 'bid' | 'ask'; price: number; delta: number; ts: number }) => void;
  book_gap: (e: { ticker?: string; sid: number }) => void;
  trade: (e: { ticker: string; price: number; count: number; takerSide: 'yes' | 'no' | undefined; ts: number }) => void;
  fill: (e: ExchangeFill) => void;
  user_order: (e: ExchangeOrder) => void;
  index: (e: { indexId: string; value: number; ts: number }) => void;
  lifecycle: (e: { ticker: string; event: string; result?: string; ts: number; priceRanges?: unknown }) => void;
  connected: () => void;
  reconnected: () => void;
  disconnected: () => void;
}

export class KalshiWs extends EventEmitter {
  private ws: WebSocket | null = null;
  private msgId = 1;
  private readonly lastSeq = new Map<number, number>();
  private readonly sidTicker = new Map<number, string>();
  private tickers = new Set<string>();
  private everConnected = false;
  private backoffMs = 1000;
  private closed = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private pingSentAt = 0;
  lastMessageTs = 0;

  constructor(
    private readonly url: string,
    private readonly signer: KalshiSigner | undefined,
    private readonly indexIds: string[],
  ) {
    super();
  }

  override on<K extends keyof WsEvents>(event: K, fn: WsEvents[K]): this {
    return super.on(event, fn);
  }

  connect(): void {
    this.closed = false;
    const path = new URL(this.url).pathname;
    const headers = this.signer ? this.signer.headers('GET', path) : {};
    const ws = new WebSocket(this.url, { headers });
    this.ws = ws;

    ws.on('open', () => {
      log.info('connected', { url: this.url });
      this.backoffMs = 1000;
      this.lastSeq.clear();
      this.sidTicker.clear();
      this.subscribeAll();
      this.pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) { this.pingSentAt = Date.now(); ws.ping(); } }, 10_000);
      this.emit(this.everConnected ? 'reconnected' : 'connected');
      this.everConnected = true;
    });
    ws.on('pong', () => { if (this.pingSentAt) recordLatency('kalshiWs', Date.now() - this.pingSentAt); });
    ws.on('message', (buf) => this.onMessage(buf.toString()));
    ws.on('close', (code) => {
      log.warn('closed', { code });
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.emit('disconnected');
      if (!this.closed) {
        setTimeout(() => this.connect(), this.backoffMs);
        this.backoffMs = Math.min(30_000, this.backoffMs * 2);
      }
    });
    ws.on('error', (err) => log.error('socket error', { error: String(err) }));
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  setMarkets(tickers: string[]): void {
    const next = new Set(tickers);
    const added = [...next].filter((t) => !this.tickers.has(t));
    this.tickers = next;
    if (added.length && this.ws?.readyState === WebSocket.OPEN) {
      this.send('subscribe', { channels: ['orderbook_delta', 'trade', 'market_lifecycle_v2'], market_tickers: added });
    }
  }

  private subscribeAll(): void {
    if (this.tickers.size) {
      this.send('subscribe', { channels: ['orderbook_delta', 'trade', 'market_lifecycle_v2'], market_tickers: [...this.tickers] });
    }
    if (this.signer) this.send('subscribe', { channels: ['fill', 'user_orders'] });
    if (this.indexIds.length) this.send('subscribe', { channels: ['cfbenchmarks_value'], index_ids: this.indexIds });
  }

  /** Force a fresh snapshot for one market after a gap. */
  resnapshot(ticker: string): void {
    this.send('subscribe', { channels: ['orderbook_delta'], market_tickers: [ticker] });
  }

  private send(cmd: string, params: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ id: this.msgId++, cmd, params }));
  }

  private onMessage(text: string): void {
    this.lastMessageTs = Date.now();
    let env: any;
    try { env = JSON.parse(text); } catch { return; }
    const type: string = env.type;
    const msg = env.msg ?? {};
    const sid: number | undefined = env.sid;

    if (sid !== undefined && typeof env.seq === 'number') {
      const prev = this.lastSeq.get(sid);
      if (type === 'orderbook_snapshot') {
        this.lastSeq.set(sid, env.seq);
      } else if (prev !== undefined && env.seq !== prev + 1) {
        log.warn('sequence gap', { sid, prev, seq: env.seq });
        this.lastSeq.delete(sid);
        this.emit('book_gap', { ticker: this.sidTicker.get(sid), sid });
        const t = this.sidTicker.get(sid) ?? msg.market_ticker;
        if (t) this.resnapshot(t);
        return;
      } else {
        this.lastSeq.set(sid, env.seq);
      }
    }

    try {
      switch (type) {
        case 'orderbook_snapshot': {
          const ticker = String(msg.market_ticker);
          if (sid !== undefined) this.sidTicker.set(sid, ticker);
          const yes = lv(msg.yes_dollars ?? msg.yes, !msg.yes_dollars);
          const no = lv(msg.no_dollars ?? msg.no, !msg.no_dollars);
          this.emit('book_snapshot', {
            ticker,
            bids: yes,
            asks: no.map((l) => ({ price: Math.round((1 - l.price) * 10000) / 10000, size: l.size })),
            ts: Date.now(),
          });
          break;
        }
        case 'orderbook_delta': {
          const ticker = String(msg.market_ticker);
          const rawPrice = parseDollars(msg.price_dollars) ?? parseDollars(msg.price, true);
          const delta = parseCount(msg.delta_fp) ?? parseCount(msg.delta);
          if (rawPrice === undefined || delta === undefined) throw new Error('bad delta');
          const isYes = String(msg.side).toLowerCase() === 'yes';
          this.emit('book_delta', {
            ticker,
            side: isYes ? 'bid' : 'ask',
            price: isYes ? rawPrice : Math.round((1 - rawPrice) * 10000) / 10000,
            delta,
            ts: Date.now(),
          });
          break;
        }
        case 'trade': {
          const price = yesPrice(msg);
          const count = parseCount(msg.count_fp) ?? parseCount(msg.count);
          if (price === undefined || count === undefined) break;
          this.emit('trade', { ticker: String(msg.market_ticker), price, count, takerSide: msg.taker_side, ts: tsMs(msg.ts) });
          break;
        }
        case 'fill':
          this.emit('fill', parseFill(msg));
          break;
        case 'user_order':
        case 'user_orders':
          this.emit('user_order', parseOrder(msg));
          break;
        case 'cfbenchmarks_value':
        case 'cfbenchmarks_value_5hz': {
          const value = parseCount(msg.value) ?? parseCount(msg.price);
          const indexId = String(msg.index_id ?? msg.index ?? msg.symbol ?? '');
          if (value !== undefined && value > 0 && indexId) this.emit('index', { indexId, value, ts: tsMs(msg.ts ?? msg.timestamp) });
          break;
        }
        case 'market_lifecycle_v2':
        case 'market_lifecycle':
          this.emit('lifecycle', { ticker: String(msg.market_ticker), event: String(msg.event_type ?? msg.status), result: msg.result, ts: Date.now(), ...(msg.price_ranges ? { priceRanges: msg.price_ranges } : {}) });
          break;
        case 'error':
          log.error('server error message', env);
          break;
        default:
          break;
      }
    } catch (e) {
      log.error('failed to handle message', { type, error: String(e) });
      if (type === 'orderbook_delta' && msg.market_ticker) this.emit('book_gap', { ticker: String(msg.market_ticker), sid: sid ?? -1 });
    }
  }
}

function tsMs(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return n < 1e12 ? n * 1000 : n;
}

function lv(rows: unknown, legacyCents: boolean): BookLevel[] {
  if (!Array.isArray(rows)) return [];
  const out: BookLevel[] = [];
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    const price = parseDollars(r[0], legacyCents && Number(r[0]) > 1);
    const size = parseCount(r[1]);
    if (price !== undefined && size !== undefined && size > 0) out.push({ price, size });
  }
  return out;
}
