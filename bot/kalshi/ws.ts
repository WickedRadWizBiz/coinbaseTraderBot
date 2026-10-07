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

/** CF Benchmarks indices Kalshi streams at 5 Hz (200 ms vendor frames) on cfbenchmarks_value_5hz. */
export const CF_5HZ_IDS = ['BRTI', 'ETHUSD_RTI', 'SOLUSD_RTI', 'XRPUSD_RTI', 'DOGEUSD_RTI'];

/** What the index feed actually delivered (dashboard / diagnostics): every stage counted, so a feed that
 *  connects but yields nothing shows exactly where the values are lost. */
export interface IndexFeedStats {
  received: number; parsed: number; dropped: number;
  /** Index ids seen in parsed messages, with counts. */
  ids: Record<string, number>;
  /** Index ids Kalshi says are available (indexlist), when it answered. */
  available: string[] | null;
  lastRaw: string | null; lastDropped: string | null; lastTs: number | null;
  /** Vendor timestamp -> handled here, last sample (ms; includes clock offset): the index's true age. */
  lagMs: number | null;
  /** Kalshi's send stamp -> handled here (network + local queueing), and the vendor -> Kalshi part. */
  transitMs: number | null;
  vendorMs: number | null;
  /** Subscription acknowledgements and errors, newest last. */
  control: string[];
  unknownTypes: Record<string, number>;
}

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
  /** The newest sample of how late Kalshi's data reaches us: precise = Kalshi's own send stamp (index
   *  messages), else a trade's exchange time (whole seconds). `at` is when it was taken. */
  private lag?: { ms: number; at: number; precise: boolean };
  readonly indexStats: IndexFeedStats = { received: 0, parsed: 0, dropped: 0, ids: {}, available: null, lastRaw: null, lastDropped: null, lastTs: null, lagMs: null, transitMs: null, vendorMs: null, control: [], unknownTypes: {} };
  private readonly listRequested = new Set<number>();

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
    // No permessage-deflate: the ws library inflates compressed frames one at a time through the zlib
    // thread pool, and every later frame (book deltas, the index, the pong) waits for each round trip, so
    // a burst of compressed messages delayed everything behind it by up to a second on a busy box.
    const ws = new WebSocket(this.url, { headers, perMessageDeflate: false });
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
    ws.on('pong', () => { this.lastMessageTs = Date.now(); if (this.pingSentAt) recordLatency('kalshiWs', Date.now() - this.pingSentAt); });
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
    // The index (private channels: need the signed connection). The 5 Hz channel for the indices Kalshi
    // publishes at 200 ms, the 1 Hz channel for every configured index (duplicates are dropped downstream).
    if (this.indexIds.length) {
      const fast = this.indexIds.filter((id) => CF_5HZ_IDS.includes(id.toUpperCase()));
      if (fast.length) this.send('subscribe', { channels: ['cfbenchmarks_value_5hz'], index_ids: fast });
      this.send('subscribe', { channels: ['cfbenchmarks_value'], index_ids: this.indexIds });
    }
  }

  /** Force a fresh snapshot for one market after a gap. */
  resnapshot(ticker: string): void {
    this.send('subscribe', { channels: ['orderbook_delta'], market_tickers: [ticker] });
  }

  private send(cmd: string, params: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ id: this.msgId++, cmd, params }));
  }

  private noteLag(ms: number, precise: boolean): void {
    const now = this.lastMessageTs;
    // A precise sample from the last 5 s outranks the coarse trade-based one.
    if (!precise && this.lag?.precise && now - this.lag.at < 5000) return;
    this.lag = { ms: Math.max(0, ms), at: now, precise };
  }

  /** How far behind real time Kalshi's data reaches us (ms): a backlog of frames, or a stalled event loop,
   *  shows here first. From a sample taken in the last 5 s; undefined when there is none. */
  feedLagMs(now = Date.now()): number | undefined {
    return this.lag && now - this.lag.at <= 5000 ? this.lag.ms : undefined;
  }

  private onMessage(text: string): void {
    this.lastMessageTs = Date.now();
    let env: any;
    try { env = JSON.parse(text); } catch { return; }
    const type: string = env.type;
    const msg = env.msg ?? {};
    const sid: number | undefined = env.sid;
    // One-way delay, Kalshi's send stamp to here (index messages carry it): the latency that matters,
    // unlike the ping round trip, which also waits behind every frame queued ahead of the pong.
    if (env.sending_ts_ms !== undefined) {
      const sent = Number(env.sending_ts_ms);
      if (Number.isFinite(sent) && sent > 0) { const t = this.lastMessageTs - sent; this.indexStats.transitMs = t; recordLatency('kalshiTransit', t); this.noteLag(t, true); }
    }

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
          const ts = tsMs(msg.ts);
          // Trade times are whole seconds: the trade may have printed up to 1 s after its stamp.
          if (msg.ts !== undefined && msg.ts !== null) this.noteLag(this.lastMessageTs - ts - 1000, false);
          this.emit('trade', { ticker: String(msg.market_ticker), price, count, takerSide: msg.taker_side, ts });
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
          const st = this.indexStats;
          st.received++;
          if (st.received <= 3 || st.received % 500 === 0) st.lastRaw = text.slice(0, 600);
          const rows = Array.isArray(msg.values) ? msg.values : Array.isArray(msg.indices) ? msg.indices : [msg];
          let ok = 0;
          for (const r of rows) {
            const p = parseIndexRow(r, msg);
            if (!p) continue;
            ok++;
            st.ids[p.indexId] = (st.ids[p.indexId] ?? 0) + 1;
            st.lastTs = p.ts;
            st.lagMs = Date.now() - p.ts;
            const kalshiAt = Number(r?.received_at);
            if (Number.isFinite(kalshiAt) && kalshiAt > 0) st.vendorMs = tsMs(kalshiAt) - p.ts;
            recordLatency('kalshiIndex', st.lagMs);
            this.emit('index', p);
          }
          if (ok) st.parsed++;
          else {
            st.dropped++;
            st.lastDropped = text.slice(0, 600);
            if (st.dropped <= 3) log.warn('index message not understood (logged for the first 3)', { raw: text.slice(0, 600) });
          }
          break;
        }
        case 'cfbenchmarks_value_indexlist':
        case 'cfbenchmarks_value_5hz_indexlist': {
          const ids = msg.index_ids ?? msg.indices ?? [];
          this.indexStats.available = Array.isArray(ids) ? ids.map(String) : null;
          log.info('index list', { type, ids: this.indexStats.available });
          break;
        }
        case 'subscribed':
        case 'ok':
        case 'unsubscribed': {
          this.control(`${type} ${JSON.stringify(msg).slice(0, 200)}`);
          // Ask which indices the index channel offers (answered as *_indexlist), once per subscription.
          const ch = String(msg.channel ?? '');
          const sidNum = Number(msg.sid ?? sid);
          if (type === 'subscribed' && ch.startsWith('cfbenchmarks') && Number.isFinite(sidNum) && !this.listRequested.has(sidNum)) {
            this.listRequested.add(sidNum);
            this.send('update_subscription', { sids: [sidNum], action: 'indexlist' });
          }
          break;
        }
        case 'market_lifecycle_v2':
        case 'market_lifecycle':
          this.emit('lifecycle', { ticker: String(msg.market_ticker), event: String(msg.event_type ?? msg.status), result: msg.result, ts: Date.now(), ...(msg.price_ranges ? { priceRanges: msg.price_ranges } : {}) });
          break;
        case 'error':
          this.control(`error ${JSON.stringify(env).slice(0, 300)}`);
          log.error('server error message', env);
          break;
        default:
          this.indexStats.unknownTypes[type] = (this.indexStats.unknownTypes[type] ?? 0) + 1;
          break;
      }
    } catch (e) {
      log.error('failed to handle message', { type, error: String(e) });
      if (type === 'orderbook_delta' && msg.market_ticker) this.emit('book_gap', { ticker: String(msg.market_ticker), sid: sid ?? -1 });
    }
  }

  private control(line: string): void {
    const c = this.indexStats.control;
    c.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
    if (c.length > 12) c.shift();
  }
}

/** Timestamp in ms from seconds, ms, us or ns since the epoch, or an ISO string (now when missing). */
export function tsMs(v: unknown): number {
  if (typeof v === 'string' && !/^\d+(\.\d+)?$/.test(v)) { const t = Date.parse(v); return Number.isFinite(t) ? t : Date.now(); }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  if (n > 1e17) return Math.round(n / 1e6);
  if (n > 1e14) return Math.round(n / 1e3);
  return n < 1e12 ? n * 1000 : n;
}

const firstNum = (o: any, keys: string[]): number | undefined => {
  for (const k of keys) { const v = parseCount(o?.[k]); if (v !== undefined && v > 0) return v; }
  return undefined;
};

const VALUE_KEYS = ['value_usd', 'value', 'price', 'index_value', 'value_dollars', 'last', 'v', 'val'];

/** One index value from a cfbenchmarks message. Kalshi's form (October 2026):
 *    {index_id: 'BRTI', value_usd: '86526.25000000', source_ts_ms, received_at, data: '<vendor JSON string>'}
 *  Other field names are tried too, and the vendor JSON in `data` when the outer fields are missing. */
export function parseIndexRow(r: any, parent: any = {}): { indexId: string; value: number; ts: number } | undefined {
  let src = r?.data && typeof r.data === 'object' ? { ...r, ...r.data } : r;
  let value = firstNum(src, VALUE_KEYS);
  if (value === undefined && typeof r?.data === 'string') {
    try { const d = JSON.parse(r.data); if (d && typeof d === 'object') { src = { ...d, ...r }; value = firstNum(d, VALUE_KEYS); } } catch { /* not JSON */ }
  }
  const idRaw = src?.index_id ?? src?.index ?? src?.symbol ?? src?.id ?? src?.index_name ?? src?.ticker ?? parent?.index_id ?? parent?.index;
  if (value === undefined || idRaw === undefined || idRaw === null || String(idRaw) === '') return undefined;
  return { indexId: String(idRaw).toUpperCase(), value, ts: tsMs(src?.source_ts_ms ?? src?.ts ?? src?.timestamp ?? src?.time ?? parent?.ts ?? parent?.timestamp) };
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
