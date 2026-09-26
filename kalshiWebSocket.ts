import WebSocket from 'ws';
import crypto from 'crypto';
import { latencyAdaptiveEngine } from './latencyAdaptiveEngine';
import { kalshiService } from './kalshiService';

export interface KalshiWsPriceUpdate {
  symbol: string;
  price?: number;
  yesBid?: number;
  yesAsk?: number;
  volume?: number;
  timestamp: number;
}

export interface KalshiWsOrderBookUpdate {
  symbol: string;
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  timestamp: number;
  isSnapshot?: boolean;
}

export type KalshiWsOrderBookHandler = (update: KalshiWsOrderBookUpdate) => void;
export type KalshiWsTickerHandler = (update: KalshiWsPriceUpdate) => void;

export class KalshiWebSocketManager {
  private ws: WebSocket | null = null;
  private wsUrl = 'wss://trading-api.kalshi.com/trade-api/ws/v2';
  private fallbackWsUrl = 'wss://api.elections.kalshi.com/trade-api/ws/v2';
  private activeUrl = this.wsUrl;
  
  private subscribedTickers: Set<string> = new Set();
  private isConnected: boolean = false;
  private isConnecting: boolean = false;
  private reconnectAttempts: number = 0;
  private reconnectTimer: any = null;
  private pingInterval: any = null;
  private msgIdCounter: number = 1;
  private lastPingSentTime: number = 0;
  private lastPingMsgId: number = 0;
  private isPingPending: boolean = false;

  private orderBookHandlers: KalshiWsOrderBookHandler[] = [];
  private tickerHandlers: KalshiWsTickerHandler[] = [];

  // In-memory local orderbook cache for delta reconstruction
  private orderBooks: Map<string, {
    bids: Map<number, number>; // price -> size
    asks: Map<number, number>; // price -> size
  }> = new Map();

  constructor() {}

  public onOrderBook(handler: KalshiWsOrderBookHandler) {
    this.orderBookHandlers.push(handler);
  }

  public onTicker(handler: KalshiWsTickerHandler) {
    this.tickerHandlers.push(handler);
  }

  public getIsConnected(): boolean {
    return this.isConnected;
  }

  public getSubscribedCount(): number {
    return this.subscribedTickers.size;
  }

  /**
   * Generates RSA-PSS authentication headers for Kalshi WebSocket connection
   */
  private generateAuthHeaders(): Record<string, string> {
    const diagnostic = kalshiService.getDiagnostic();
    if (!diagnostic.isConfigured) {
      return {};
    }

    try {
      const timestamp = Date.now().toString();
      const method = 'GET';
      const path = '/trade-api/ws/v2';
      const msg = timestamp + method + path;

      // Access private key directly or through sign utility
      const keyObj = (kalshiService as any).privateKey as crypto.KeyObject | null;
      const keyId = (kalshiService as any).keyId as string || '';

      if (!keyObj || !keyId) return {};

      const signature = crypto.sign(
        'sha256',
        Buffer.from(msg),
        {
          key: keyObj,
          padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
          saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
        }
      ).toString('base64');

      return {
        'KALSHI-ACCESS-KEY': keyId,
        'KALSHI-ACCESS-TIMESTAMP': timestamp,
        'KALSHI-ACCESS-SIGNATURE': signature,
        'User-Agent': 'Nostratech-Kalshi-Client/2.0 (AWS us-east-1)'
      };
    } catch (e: any) {
      console.warn('[KALSHI WS] Could not generate RSA signature for WebSocket handshake:', e?.message || e);
      return {};
    }
  }

  /**
   * Starts and connects the Kalshi WebSocket client
   */
  public start(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.connect();
  }

  /**
   * Force reconnect when credentials or keys are updated
   */
  public reconnectWithNewCredentials(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
    this.isConnected = false;
    this.isConnecting = false;
    console.log('[KALSHI WS] Reconnecting with refreshed credentials...');
    this.connect();
  }

  private connect(): void {
    if (this.isConnecting) return;

    const diagnostic = kalshiService.getDiagnostic();
    if (!diagnostic.isConfigured) {
      latencyAdaptiveEngine.setConnectionMode('REST_KEEPALIVE');
      console.log('[KALSHI WS] API credentials not configured yet. Operating in high-performance Keep-Alive REST mode. Retrying credentials check in 15s...');
      
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.connect();
      }, 15000);
      return;
    }

    const headers = this.generateAuthHeaders();
    if (!headers || !headers['KALSHI-ACCESS-KEY'] || !headers['KALSHI-ACCESS-SIGNATURE']) {
      latencyAdaptiveEngine.setConnectionMode('REST_KEEPALIVE');
      console.log('[KALSHI WS] Missing or invalid RSA signing keys. Operating in Keep-Alive REST mode. Retrying credentials check in 30s...');
      
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.connect();
      }, 30000);
      return;
    }

    this.isConnecting = true;

    try {
      const targetUrl = this.activeUrl;
      console.log(`[KALSHI WS] Connecting to ${targetUrl}... (Subscribed tickers: ${this.subscribedTickers.size})`);

      this.ws = new WebSocket(targetUrl, {
        headers,
        handshakeTimeout: 8000,
        perMessageDeflate: false
      });

      let authFailed = false;

      this.ws.on('open', () => {
        this.isConnected = true;
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        latencyAdaptiveEngine.setConnectionMode('WEBSOCKET');
        console.log(`[KALSHI WS] Connected successfully. Connection Mode set to WEBSOCKET (10s quote freshness gate, <300ms wire gate).`);

        this.startHeartbeat();
        this.resubscribeAll();
      });

      this.ws.on('pong', () => {
        if (this.isPingPending && this.lastPingSentTime > 0) {
          const rtt = Date.now() - this.lastPingSentTime;
          this.isPingPending = false;
          if (rtt > 0 && rtt < 1500) {
            latencyAdaptiveEngine.recordKalshiWsLatency(rtt);
          }
        }
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (err: any) => {
        const errMsg = err?.message || String(err);
        if (errMsg.includes('401')) {
          authFailed = true;
          console.warn(`[KALSHI WS] Authentication failed (401 Unauthorized). Operating in REST_KEEPALIVE mode until API key/RSA credentials are re-configured.`);
        } else {
          console.warn(`[KALSHI WS] Connection error on ${this.activeUrl}:`, errMsg);
        }
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        if (authFailed || code === 4001) {
          this.isConnected = false;
          this.isConnecting = false;
          this.stopHeartbeat();
          latencyAdaptiveEngine.setConnectionMode('REST_KEEPALIVE');
          // On auth failure, back off for 60 seconds before retrying
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => {
            this.connect();
          }, 60000);
        } else {
          this.handleDisconnect(code, reason ? reason.toString() : '');
        }
      });

    } catch (err: any) {
      console.warn('[KALSHI WS] Failed to initiate WebSocket connection:', err?.message || err);
      this.handleDisconnect(1006, err?.message || 'Init Error');
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.lastPingSentTime = Date.now();
          this.isPingPending = true;
          this.ws.ping();
        } catch (_) {}
      }
    }, 4000);
  }

  private stopHeartbeat(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private handleDisconnect(code: number, reason: string): void {
    this.isConnected = false;
    this.isConnecting = false;
    this.stopHeartbeat();

    // Fall back immediately to Keep-Alive REST mode and scale latency gate to 1200ms
    latencyAdaptiveEngine.setConnectionMode('REST_KEEPALIVE');
    console.warn(`[KALSHI WS] Disconnected (Code: ${code}, Reason: ${reason || 'Unknown'}). Switched to REST_KEEPALIVE fallback (1200ms gate).`);

    // Toggle endpoint url on persistent failures
    if (this.reconnectAttempts > 2) {
      this.activeUrl = this.activeUrl === this.wsUrl ? this.fallbackWsUrl : this.wsUrl;
    }

    const backoffMs = Math.min(15000, 1000 * Math.pow(1.5, this.reconnectAttempts));
    this.reconnectAttempts++;

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      console.log(`[KALSHI WS] Reconnecting (Attempt ${this.reconnectAttempts}, backoff ${Math.round(backoffMs)}ms)...`);
      this.connect();
    }, backoffMs);
  }

  /**
   * Synchronizes subscriptions to track a list of market tickers
   */
  public syncSubscriptions(tickers: string[]): void {
    const validTickers = tickers.filter(t => Boolean(t && t.trim()));
    const newTickers: string[] = [];

    for (const t of validTickers) {
      if (!this.subscribedTickers.has(t)) {
        this.subscribedTickers.add(t);
        newTickers.push(t);
      }
    }

    if (newTickers.length > 0 && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendSubscription(newTickers);
    }
  }

  private resubscribeAll(): void {
    if (this.subscribedTickers.size === 0) return;
    const tickerList = Array.from(this.subscribedTickers);
    this.sendSubscription(tickerList);
  }

  private sendSubscription(tickers: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || tickers.length === 0) return;

    try {
      // Kalshi WS v2 subscription payload
      const subPayload = {
        id: this.msgIdCounter++,
        cmd: 'subscribe',
        params: {
          channels: ['orderbook_delta', 'ticker'],
          market_tickers: tickers
        }
      };

      this.ws.send(JSON.stringify(subPayload));
      console.log(`[KALSHI WS] Sent subscription command for ${tickers.length} tickers: [${tickers.slice(0, 4).join(', ')}${tickers.length > 4 ? '...' : ''}]`);
    } catch (err: any) {
      console.warn('[KALSHI WS] Failed to send subscription message:', err?.message || err);
    }
  }

  /**
   * Processes incoming WebSocket messages from Kalshi
   */
  private handleMessage(rawData: WebSocket.Data): void {
    try {
      const text = rawData.toString();
      const data = JSON.parse(text);

      if (!data) return;

      // Heartbeat or pong response
      if (data.type === 'pong' || data.cmd === 'pong' || (data.id && data.id === this.lastPingMsgId)) {
        if (this.lastPingSentTime > 0) {
          const rtt = Date.now() - this.lastPingSentTime;
          if (rtt > 0 && rtt < 3000) {
            latencyAdaptiveEngine.recordKalshiWsLatency(rtt);
          }
        }
        return;
      }

      const msgType = data.type || data.channel;
      const msg = data.msg || data.data || data;

      if (msgType === 'orderbook_snapshot') {
        this.handleOrderBookSnapshot(msg);
      } else if (msgType === 'orderbook_delta') {
        this.handleOrderBookDelta(msg);
      } else if (msgType === 'ticker') {
        this.handleTickerMessage(msg);
      }
    } catch (err: any) {
      // Ignore JSON parse errors on malformed frames
    }
  }

  private handleOrderBookSnapshot(msg: any): void {
    const symbol = msg.market_ticker || msg.ticker || msg.symbol;
    if (!symbol) return;

    const bidsMap = new Map<number, number>();
    const asksMap = new Map<number, number>();

    // Process raw snapshot bids/asks
    if (Array.isArray(msg.bids)) {
      for (const item of msg.bids) {
        const rawP = parseFloat(item[0] !== undefined ? item[0] : item.price);
        const normP = rawP > 1 ? rawP / 100 : rawP;
        const size = parseFloat(item[1] !== undefined ? item[1] : item.size);
        if (size > 0) bidsMap.set(normP, size);
      }
    }

    if (Array.isArray(msg.asks)) {
      for (const item of msg.asks) {
        const rawP = parseFloat(item[0] !== undefined ? item[0] : item.price);
        const normP = rawP > 1 ? rawP / 100 : rawP;
        const size = parseFloat(item[1] !== undefined ? item[1] : item.size);
        if (size > 0) asksMap.set(normP, size);
      }
    }

    // Support yes/no orderbook structure
    if (Array.isArray(msg.yes)) {
      for (const item of msg.yes) {
        const rawP = parseFloat(item[0]);
        const normP = rawP > 1 ? rawP / 100 : rawP;
        const size = parseFloat(item[1]);
        if (size > 0) bidsMap.set(normP, size);
      }
    }
    if (Array.isArray(msg.no)) {
      for (const item of msg.no) {
        const rawP = parseFloat(item[0]);
        const normP = rawP > 1 ? rawP / 100 : rawP;
        const askP = parseFloat((1.0 - normP).toFixed(4));
        const size = parseFloat(item[1]);
        if (size > 0) asksMap.set(askP, size);
      }
    }

    this.orderBooks.set(symbol, { bids: bidsMap, asks: asksMap });
    this.broadcastOrderBook(symbol, bidsMap, asksMap, true);
  }

  private handleOrderBookDelta(msg: any): void {
    const symbol = msg.market_ticker || msg.ticker || msg.symbol;
    if (!symbol) return;

    let book = this.orderBooks.get(symbol);
    if (!book) {
      book = { bids: new Map(), asks: new Map() };
      this.orderBooks.set(symbol, book);
    }

    const side = (msg.side || '').toLowerCase();
    const rawP = parseFloat(msg.price);
    const normP = rawP > 1 ? rawP / 100 : rawP;
    const delta = parseFloat(msg.delta || 0);

    const targetMap = (side === 'yes' || side === 'bid') ? book.bids : book.asks;
    const currentSize = targetMap.get(normP) || 0;
    const newSize = Math.max(0, currentSize + delta);

    if (newSize <= 0) {
      targetMap.delete(normP);
    } else {
      targetMap.set(normP, newSize);
    }

    this.broadcastOrderBook(symbol, book.bids, book.asks, false);
  }

  private broadcastOrderBook(symbol: string, bidsMap: Map<number, number>, asksMap: Map<number, number>, isSnapshot: boolean) {
    const bids = Array.from(bidsMap.entries())
      .map(([price, size]) => ({ price, size }))
      .sort((a, b) => b.price - a.price);

    const asks = Array.from(asksMap.entries())
      .map(([price, size]) => ({ price, size }))
      .sort((a, b) => a.price - b.price);

    const update: KalshiWsOrderBookUpdate = {
      symbol,
      bids,
      asks,
      timestamp: Date.now(),
      isSnapshot
    };

    for (const handler of this.orderBookHandlers) {
      try { handler(update); } catch (_) {}
    }
  }

  private handleTickerMessage(msg: any): void {
    const symbol = msg.market_ticker || msg.ticker || msg.symbol;
    if (!symbol) return;

    const rawP = msg.price !== undefined ? parseFloat(msg.price) : undefined;
    const price = rawP !== undefined ? (rawP > 1 ? rawP / 100 : rawP) : undefined;

    const rawBid = msg.yes_bid !== undefined ? parseFloat(msg.yes_bid) : undefined;
    const yesBid = rawBid !== undefined ? (rawBid > 1 ? rawBid / 100 : rawBid) : undefined;

    const rawAsk = msg.yes_ask !== undefined ? parseFloat(msg.yes_ask) : undefined;
    const yesAsk = rawAsk !== undefined ? (rawAsk > 1 ? rawAsk / 100 : rawAsk) : undefined;

    const update: KalshiWsPriceUpdate = {
      symbol,
      price,
      yesBid,
      yesAsk,
      volume: msg.volume !== undefined ? parseFloat(msg.volume) : undefined,
      timestamp: Date.now()
    };

    for (const handler of this.tickerHandlers) {
      try { handler(update); } catch (_) {}
    }
  }
}

export const kalshiWsManager = new KalshiWebSocketManager();
