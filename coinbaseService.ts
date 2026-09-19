import crypto from 'crypto';
import 'dotenv/config';

export interface CoinbaseBalanceResult {
  usdCash: number;
  usdcCash: number;
  totalCashPool: number;
  portfolioName: string;
  accountsCount: number;
  lastUpdated: number;
  connected: boolean;
  error?: string;
}

class CoinbaseService {
  private keyName: string;
  private secretRaw: string;
  private privateKey: crypto.KeyObject | null = null;
  private cachedCashPool: CoinbaseBalanceResult = {
    usdCash: 0,
    usdcCash: 0,
    totalCashPool: 0,
    portfolioName: 'Default',
    accountsCount: 0,
    lastUpdated: 0,
    connected: false
  };
  private isFetching = false;

  constructor() {
    this.keyName = process.env.COINBASE_API_KEY || process.env.CDP_API_KEY_NAME || process.env.COINBASE_KEY || '';
    this.secretRaw = process.env.COINBASE_API_SECRET || process.env.CDP_API_PRIVATE_KEY || process.env.COINBASE_SECRET || '';
    this.initPrivateKey();
  }

  private initPrivateKey() {
    this.keyName = this.keyName || process.env.COINBASE_API_KEY || process.env.CDP_API_KEY_NAME || process.env.COINBASE_KEY || '';
    this.secretRaw = this.secretRaw || process.env.COINBASE_API_SECRET || process.env.CDP_API_PRIVATE_KEY || process.env.COINBASE_SECRET || '';
    
    if (!this.keyName || !this.secretRaw) {
      return;
    }
    try {
      let rawSecret = this.secretRaw.trim();
      if ((rawSecret.startsWith('"') && rawSecret.endsWith('"')) || (rawSecret.startsWith("'") && rawSecret.endsWith("'"))) {
        rawSecret = rawSecret.slice(1, -1);
      }
      const rawBuf = Buffer.from(rawSecret, 'base64');
      const seed = rawBuf.subarray(0, 32);
      const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
      const pkcs8Key = Buffer.concat([pkcs8Prefix, seed]);
      const pem = '-----BEGIN PRIVATE KEY-----\n' + pkcs8Key.toString('base64').match(/.{1,64}/g)?.join('\n') + '\n-----END PRIVATE KEY-----';
      this.privateKey = crypto.createPrivateKey(pem);
      console.log('[COINBASE] Initialized Coinbase CDP Ed25519 signing key successfully.');
    } catch (err) {
      console.error('[COINBASE] Error initializing Coinbase CDP private key:', err);
      this.privateKey = null;
    }
  }

  public isConfigured(): boolean {
    if (!this.privateKey || !this.keyName) {
      this.initPrivateKey();
    }
    return !!(this.keyName && this.secretRaw && this.privateKey);
  }

  public signCDPToken(method?: string, requestPath?: string): string | null {
    if (!this.privateKey || !this.keyName) return null;
    try {
      const header = {
        alg: 'EdDSA',
        kid: this.keyName,
        nonce: crypto.randomBytes(16).toString('hex'),
        typ: 'JWT'
      };

      const payload: any = {
        iss: 'cdp',
        nbf: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 120,
        sub: this.keyName
      };

      if (method && requestPath) {
        const pathWithoutQuery = requestPath.split('?')[0];
        payload.uri = method.toUpperCase() + ' api.coinbase.com' + pathWithoutQuery;
      }

      const b64u = (obj: any) => Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)).toString('base64url');
      const msg = b64u(header) + '.' + b64u(payload);
      const sig = crypto.sign(null, Buffer.from(msg), this.privateKey).toString('base64url');
      return msg + '.' + sig;
    } catch (err) {
      console.error('[COINBASE] Failed to sign CDP JWT token:', err);
      return null;
    }
  }

  /**
   * Fetch real cash pool balances (USD + USDC) from Coinbase Advanced Trade / Brokerage API
   */
  public async fetchRealCashPool(force = false): Promise<CoinbaseBalanceResult> {
    const now = Date.now();
    // Cache for 10 seconds unless forced
    if (!force && this.cachedCashPool.lastUpdated > 0 && now - this.cachedCashPool.lastUpdated < 10000) {
      return this.cachedCashPool;
    }

    if (!this.isConfigured()) {
      return {
        ...this.cachedCashPool,
        connected: false,
        error: 'Coinbase API credentials not configured in environment'
      };
    }

    if (this.isFetching) {
      return this.cachedCashPool;
    }

    this.isFetching = true;
    try {
      let hasNext = true;
      let cursor = '';
      let allAccounts: any[] = [];
      let pageCount = 0;

      while (hasNext && pageCount < 4) {
        pageCount++;
        const path = '/api/v3/brokerage/accounts?limit=250' + (cursor ? '&cursor=' + cursor : '');
        const token = this.signCDPToken('GET', path);
        if (!token) break;

        const res = await fetch('https://api.coinbase.com' + path, {
          headers: { 'Authorization': 'Bearer ' + token },
          signal: AbortSignal.timeout(6000)
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Coinbase API returned HTTP ${res.status}: ${errText.substring(0, 100)}`);
        }

        const data: any = await res.json();
        if (Array.isArray(data.accounts)) {
          allAccounts.push(...data.accounts);
        }
        hasNext = !!data.has_next && !!data.cursor;
        cursor = data.cursor || '';
      }

      // Extract USD cash and USDC cash
      const usdAcc = allAccounts.find(a => a.currency === 'USD' && a.type === 'ACCOUNT_TYPE_FIAT');
      const usdcAcc = allAccounts.find(a => a.currency === 'USDC');

      const usdCash = parseFloat(usdAcc?.available_balance?.value || '0');
      const usdcCash = parseFloat(usdcAcc?.available_balance?.value || '0');
      const totalCashPool = Math.max(0, usdCash + usdcCash);

      this.cachedCashPool = {
        usdCash: Number(usdCash.toFixed(2)),
        usdcCash: Number(usdcCash.toFixed(2)),
        totalCashPool: Number(totalCashPool.toFixed(2)),
        portfolioName: usdAcc?.name || 'Default Portfolio',
        accountsCount: allAccounts.length,
        lastUpdated: Date.now(),
        connected: true
      };

      return this.cachedCashPool;
    } catch (err: any) {
      console.error('[COINBASE] Error fetching live accounts from Coinbase:', err?.message || err);
      this.cachedCashPool = {
        ...this.cachedCashPool,
        connected: false,
        error: err?.message || 'Failed to reach Coinbase API'
      };
      return this.cachedCashPool;
    } finally {
      this.isFetching = false;
    }
  }

  public getCachedCashPool(): CoinbaseBalanceResult {
    return this.cachedCashPool;
  }

  public async placeOrder(product_id: string, side: 'BUY' | 'SELL', size: number, price?: number): Promise<{ success: boolean; order_id?: string; error?: string }> {
    if (!this.isConfigured()) {
      return { success: false, error: 'Coinbase API not configured' };
    }
    try {
      const path = '/api/v3/brokerage/orders';
      const token = this.signCDPToken('POST', path);
      if (!token) {
        return { success: false, error: 'Failed to sign CDP JWT token for order' };
      }

      const orderPayload: any = {
        client_order_id: 'cb_bot_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
        product_id: product_id.includes('-') ? product_id : product_id + '-USD',
        side: side.toUpperCase(),
        order_configuration: {
          market_market_ioc: price ? undefined : { base_size: size.toString() },
          limit_limit_gtc: price ? { base_size: size.toString(), limit_price: price.toString(), post_only: false } : undefined
        }
      };

      // Fallback to market order if limit config isn't fully set
      if (!orderPayload.order_configuration.limit_limit_gtc && !orderPayload.order_configuration.market_market_ioc) {
        orderPayload.order_configuration = {
          market_market_ioc: { quote_size: (size * (price || 1)).toString() }
        };
      }

      const res = await fetch('https://api.coinbase.com' + path, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(orderPayload),
        signal: AbortSignal.timeout(8000)
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Coinbase Order API HTTP ${res.status}: ${errText.substring(0, 150)}`);
      }

      const data: any = await res.json();
      const success = !!data.success || !!data.order_id || data.success_response;
      return {
        success: true,
        order_id: data.success_response?.order_id || data.order_id || 'submitted'
      };
    } catch (err: any) {
      console.error('[COINBASE ORDER ERROR]', err?.message || err);
      return { success: false, error: err?.message || 'Order execution failed' };
    }
  }

  public async checkApiStatus(): Promise<{
    configured: boolean;
    restWorking: boolean;
    cashPoolUsd: number;
    accountsFound: number;
    error?: string;
  }> {
    if (!this.isConfigured()) {
      return {
        configured: false,
        restWorking: false,
        cashPoolUsd: 0,
        accountsFound: 0,
        error: 'Credentials missing or invalid'
      };
    }
    const result = await this.fetchRealCashPool(true);
    return {
      configured: true,
      restWorking: result.connected,
      cashPoolUsd: result.totalCashPool,
      accountsFound: result.accountsCount,
      error: result.error
    };
  }
}

export const coinbaseService = new CoinbaseService();
