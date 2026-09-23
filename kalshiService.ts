import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { latencyAdaptiveEngine } from './latencyAdaptiveEngine';
import { kalshiRateLimiter, RateLimitTier } from './kalshiRateLimiter';

function scanEnvFilesForKeys(): { keyId: string; secret: string } {
  const candidateFiles = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../.env'),
    '/home/ubuntu/coinbaseTraderBot/.env',
    '/home/ubuntu/.env'
  ];

  let foundKey = '';
  let foundSecret = '';

  for (const filePath of candidateFiles) {
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');

        // Look for multiline or single line RSA key
        const rsaMatch = content.match(/(?:KALSHI_API_SECRET|KALSHI_PRIVATE_KEY|KALSHI_SECRET)\s*=\s*(["'][\s\S]*?["']|-----BEGIN[\s\S]*?-----END[^\n\r]*|[^\r\n]+)/);
        if (rsaMatch && rsaMatch[1] && !foundSecret) {
          let val = rsaMatch[1].trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          foundSecret = val;
        }

        const keyIdMatch = content.match(/(?:KALSHI_API_KEY|KALSHI_KEY_ID|KALSHI_KEY)\s*=\s*["']?([a-zA-Z0-9_\-\.]+)["']?/);
        if (keyIdMatch && keyIdMatch[1] && !foundKey) {
          foundKey = keyIdMatch[1].trim();
        }
      } catch (err) {
        // Ignore file read error
      }
    }
  }

  return { keyId: foundKey, secret: foundSecret };
}

export class KalshiService {
  private keyId: string = '';
  private secretRaw: string = '';
  private privateKey: crypto.KeyObject | null = null;
  private initError: string | null = null;
  private lastApiStatus: { success: boolean; statusText?: string; balance?: number; error?: string; timestamp?: number } | null = null;
  private baseUrl = 'https://external-api.kalshi.com/trade-api/v2';
  private fallbackBaseUrl = 'https://api.elections.kalshi.com/trade-api/v2';

  constructor() {
    this.reloadCredentials();
    // Auto-discover account rate limits after a brief delay if keys are configured
    setTimeout(() => {
      if (this.isConfigured()) {
        this.fetchAccountLimits().catch(() => {});
      }
    }, 2000);
  }

  public reloadCredentials() {
    const fromFiles = scanEnvFilesForKeys();
    this.keyId = process.env.KALSHI_API_KEY || process.env.KALSHI_KEY_ID || process.env.KALSHI_KEY || fromFiles.keyId || '';
    this.secretRaw = process.env.KALSHI_API_SECRET || process.env.KALSHI_PRIVATE_KEY || process.env.KALSHI_SECRET || fromFiles.secret || '';
    this.initPrivateKey();
  }

  public updateCredentials(keyId: string, secret: string, saveToDisk = true) {
    this.keyId = keyId.trim();
    this.secretRaw = secret.trim();
    process.env.KALSHI_API_KEY = this.keyId;
    process.env.KALSHI_API_SECRET = this.secretRaw;
    this.initPrivateKey();

    if (saveToDisk) {
      try {
        const envPath = path.resolve(process.cwd(), '.env');
        let existing = '';
        if (fs.existsSync(envPath)) {
          existing = fs.readFileSync(envPath, 'utf-8');
        }

        // Clean existing entries
        existing = existing.replace(/(?:KALSHI_API_KEY|KALSHI_KEY_ID|KALSHI_KEY)\s*=.*\n?/g, '');
        existing = existing.replace(/(?:KALSHI_API_SECRET|KALSHI_PRIVATE_KEY|KALSHI_SECRET)\s*=(?:["'][\s\S]*?["']|-----BEGIN[\s\S]*?-----END[^\n\r]*|[^\r\n]+)\n?/g, '');

        const formattedSecret = this.secretRaw.includes('\n')
          ? `"${this.secretRaw.replace(/\n/g, '\\n')}"`
          : `"${this.secretRaw}"`;

        const newEnvContent = `${existing.trim()}\n\nKALSHI_API_KEY="${this.keyId}"\nKALSHI_API_SECRET=${formattedSecret}\n`;
        fs.writeFileSync(envPath, newEnvContent, 'utf-8');
        console.log('[KALSHI] Saved updated Kalshi credentials to .env');
      } catch (err) {
        console.error('[KALSHI] Failed to write to .env:', err);
      }
    }

    if (this.isConfigured()) {
      this.fetchAccountLimits().catch(() => {});
    }
  }

  private initPrivateKey() {
    this.initError = null;
    if (!this.keyId || !this.secretRaw) {
      this.initError = 'Missing Key ID or Private Key in environment or .env';
      this.privateKey = null;
      return;
    }

    try {
      let pem = this.secretRaw.trim();
      
      // Strip outer wrapping double or single quotes if present from .env
      if ((pem.startsWith('"') && pem.endsWith('"')) || (pem.startsWith("'") && pem.endsWith("'"))) {
        pem = pem.slice(1, -1);
      }

      // Normalize carriage returns and escaped newlines
      pem = pem.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r\n/g, '\n');
      
      if (pem.includes('-----BEGIN') && !pem.includes('\n')) {
        pem = pem.replace(/(-----BEGIN[^-]+-----)\s*/, '$1\n');
        pem = pem.replace(/\s*(-----END[^-]+-----)/, '\n$1');
        const parts = pem.split('\n');
        if (parts.length === 3) {
           const base64 = parts[1].replace(/\s+/g, '');
           parts[1] = base64.match(/.{1,64}/g)?.join('\n') || base64;
           pem = parts.join('\n');
        }
      } else if (!pem.includes('-----BEGIN')) {
        if (pem.length > 100) {
            const base64 = pem.replace(/\s+/g, '');
            pem = '-----BEGIN RSA PRIVATE KEY-----\n' + (base64.match(/.{1,64}/g)?.join('\n') || base64) + '\n-----END RSA PRIVATE KEY-----';
        }
      }

      try {
        this.privateKey = crypto.createPrivateKey(pem);
      } catch (e1: any) {
        // If RSA PKCS#1 failed, try wrapping as PKCS#8
        if (pem.includes('BEGIN RSA PRIVATE KEY')) {
          const altPem = pem.replace(/BEGIN RSA PRIVATE KEY/g, 'BEGIN PRIVATE KEY').replace(/END RSA PRIVATE KEY/g, 'END PRIVATE KEY');
          this.privateKey = crypto.createPrivateKey(altPem);
        } else if (pem.includes('BEGIN PRIVATE KEY')) {
          const altPem = pem.replace(/BEGIN PRIVATE KEY/g, 'BEGIN RSA PRIVATE KEY').replace(/END PRIVATE KEY/g, 'END RSA PRIVATE KEY');
          this.privateKey = crypto.createPrivateKey(altPem);
        } else {
          throw e1;
        }
      }

      console.log('[KALSHI] Initialized Kalshi RSA private key successfully.');
      this.initError = null;
    } catch (err: any) {
      console.error('[KALSHI] Error initializing Kalshi private key:', err?.message || err);
      this.initError = `RSA Key Parsing Error: ${err?.message || err}`;
      this.privateKey = null;
    }
  }

  public isConfigured(): boolean {
    if (!this.privateKey || !this.keyId) {
      this.reloadCredentials();
    }
    return !!(this.keyId && this.secretRaw && this.privateKey);
  }

  public getDiagnostic() {
    return {
      hasKeyId: Boolean(this.keyId),
      keyIdMasked: this.keyId ? `${this.keyId.substring(0, 4)}...${this.keyId.substring(this.keyId.length - 4)}` : 'NOT_FOUND',
      hasSecret: Boolean(this.secretRaw),
      secretLength: this.secretRaw ? this.secretRaw.length : 0,
      privateKeyLoaded: Boolean(this.privateKey),
      initError: this.initError,
      lastApiStatus: this.lastApiStatus,
      isConfigured: this.isConfigured()
    };
  }

  private signRequest(method: string, path: string): { timestamp: string, signature: string } {
    const timestamp = Date.now().toString();
    const msg = timestamp + method.toUpperCase() + path;
    
    // RSA-PSS with SHA-256
    const signature = crypto.sign(
      'sha256',
      Buffer.from(msg),
      {
        key: this.privateKey!,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
      }
    ).toString('base64');
    
    return { timestamp, signature };
  }

  /**
   * Fetches account limits dynamically from Kalshi API and updates the Token Bucket Engine
   */
  public async fetchAccountLimits(): Promise<{ success: boolean; tier?: RateLimitTier; limits?: any; error?: string }> {
    if (!this.isConfigured()) return { success: false, error: 'Kalshi API not configured' };

    const method = 'GET';
    const path = '/account/limits';
    const { timestamp, signature } = this.signRequest(method, '/trade-api/v2' + path);

    const tryEndpoints = [this.baseUrl, this.fallbackBaseUrl];
    let lastError = '';

    for (const host of tryEndpoints) {
      try {
        const res = await kalshiRateLimiter.execute(
          () => fetch(host + path, {
            method,
            headers: {
              'Accept': 'application/json',
              'KALSHI-ACCESS-KEY': this.keyId,
              'KALSHI-ACCESS-TIMESTAMP': timestamp,
              'KALSHI-ACCESS-SIGNATURE': signature
            }
          }),
          { path, method, priority: 'NORMAL' }
        );

        if (res.ok) {
          const data: any = await res.json();
          const tierName = data.tier || data.usage_tier || data.level || (data.read_limit >= 300 ? 'Advanced' : 'Basic');
          if (tierName && typeof tierName === 'string') {
            const capitalized = (tierName.charAt(0).toUpperCase() + tierName.slice(1).toLowerCase()) as RateLimitTier;
            kalshiRateLimiter.setTier(capitalized, true, data);
            return { success: true, tier: capitalized, limits: data };
          }
          kalshiRateLimiter.setTier('Basic', true, data);
          return { success: true, limits: data };
        }
        const txt = await res.text();
        let parsed: any = null;
        try { parsed = JSON.parse(txt); } catch (_) {}
        lastError = parsed?.message || parsed?.error || `HTTP ${res.status}: ${txt}`;
      } catch (e: any) {
        lastError = e.message;
      }
    }

    return { success: false, error: lastError };
  }

  /**
   * Calls the Upgrade Account API Usage Level endpoint to promote to Advanced
   * Docs: https://docs.kalshi.com/api-reference/account/upgrade-account-api-usage-level
   * Rule: At least one of the user's last 100 Predictions orders must have been created via API.
   */
  public async upgradeApiUsageLevel(): Promise<{ success: boolean; message?: string; error?: string }> {
    if (!this.isConfigured()) return { success: false, error: 'Kalshi API not configured' };

    const method = 'POST';
    const path = '/account/api_usage_level/upgrade';
    const { timestamp, signature } = this.signRequest(method, '/trade-api/v2' + path);

    const tryEndpoints = [this.baseUrl, this.fallbackBaseUrl];
    let lastError = '';

    for (const host of tryEndpoints) {
      try {
        const res = await kalshiRateLimiter.execute(
          () => fetch(host + path, {
            method,
            headers: {
              'Accept': 'application/json',
              'KALSHI-ACCESS-KEY': this.keyId,
              'KALSHI-ACCESS-TIMESTAMP': timestamp,
              'KALSHI-ACCESS-SIGNATURE': signature
            }
          }),
          { path, method, priority: 'CRITICAL' }
        );

        if (res.ok) {
          kalshiRateLimiter.setTier('Advanced', true);
          await this.fetchAccountLimits();
          return {
            success: true,
            message: 'Successfully upgraded account usage level to Advanced (300 Read / 300 Write TPS, 3x Burst) via Kalshi API'
          };
        }

        const txt = await res.text();
        let parsed: any = null;
        try { parsed = JSON.parse(txt); } catch (_) {}
        const errorDesc = parsed?.message || parsed?.error || txt;
        lastError = `HTTP ${res.status}: ${errorDesc}`;

        // If client-side / eligibility error returned from official Kalshi host, return immediately
        if (res.status === 400 || res.status === 403 || res.status === 401) {
          return { success: false, error: lastError };
        }
      } catch (e: any) {
        lastError = e.message;
      }
    }

    return { success: false, error: lastError };
  }

  public async getBalance(): Promise<{ success: boolean; balance?: number; breakdown?: any[]; error?: string }> {
    if (!this.isConfigured()) {
      const err = this.initError || 'Kalshi API credentials not found or unparsed';
      this.lastApiStatus = { success: false, error: err, timestamp: Date.now() };
      return { success: false, error: err };
    }

    const tryEndpoints = [this.baseUrl, this.fallbackBaseUrl];
    let lastError = '';

    for (const host of tryEndpoints) {
      try {
        const method = 'GET';
        const path = '/portfolio/balance';

        const { timestamp, signature } = this.signRequest(method, '/trade-api/v2' + path);

        const tBalStart = Date.now();
        const res = await kalshiRateLimiter.execute(
          () => fetch(host + path, {
            method,
            headers: {
              'Content-Type': 'application/json',
              'KALSHI-ACCESS-KEY': this.keyId,
              'KALSHI-ACCESS-TIMESTAMP': timestamp,
              'KALSHI-ACCESS-SIGNATURE': signature
            }
          }),
          { path, method, priority: 'NORMAL' }
        );
        const tBalElapsed = Date.now() - tBalStart;
        if (tBalElapsed > 0) latencyAdaptiveEngine.recordKalshiDataLatency(tBalElapsed);

        if (!res.ok) {
          const txt = await res.text();
          lastError = `HTTP ${res.status}: ${txt}`;
          console.error(`[KALSHI BALANCE ERROR on ${host}]`, lastError);
          continue;
        }

        const data: any = await res.json();
        // Kalshi balances are returned in cents (e.g., 2500 cents = $25.00)
        let rawBal = data.balance !== undefined ? data.balance : (data.available_balance !== undefined ? data.available_balance : data.cash);
        if (typeof rawBal !== 'number') rawBal = 0;
        const balanceDollars = rawBal > 1000000 ? rawBal / 10000 : rawBal / 100; // handle cents vs centicents
        
        this.lastApiStatus = { success: true, balance: balanceDollars, statusText: 'Connected & Authenticated', timestamp: Date.now() };
        return { success: true, balance: balanceDollars, breakdown: data.balance_breakdown || [] };
      } catch (e: any) {
        lastError = e.message || String(e);
      }
    }

    this.lastApiStatus = { success: false, error: lastError, timestamp: Date.now() };
    return { success: false, error: lastError };
  }

  /**
   * Directly transfers funds between Kalshi Exchange Shards (e.g. Shard 0 Main -> Shard 2 Crypto).
   * Amount is in US Dollars (e.g. 20.00). Amount in API request is converted to centicents (1 USD = 10,000 centicents).
   */
  public async transferShardBalance(sourceShard: number, destShard: number, amountDollars: number): Promise<{ success: boolean; transfer_id?: string; error?: string }> {
    if (!this.isConfigured()) return { success: false, error: 'Kalshi API not configured' };

    try {
      const method = 'POST';
      const path = '/portfolio/intra_exchange_instance_transfer';
      
      // Convert USD to centicents (1 USD = 10,000 centicents = 100 cents * 100)
      const centicents = Math.round(amountDollars * 10000);

      const payload = {
        source: 'event_contract',
        destination: 'event_contract',
        source_exchange_shard: sourceShard,
        destination_exchange_shard: destShard,
        amount: centicents
      };

      const { timestamp, signature } = this.signRequest(method, '/trade-api/v2' + path);

      const res = await kalshiRateLimiter.execute(
        () => fetch(this.baseUrl + path, {
          method,
          headers: {
            'Content-Type': 'application/json',
            'KALSHI-ACCESS-KEY': this.keyId,
            'KALSHI-ACCESS-TIMESTAMP': timestamp,
            'KALSHI-ACCESS-SIGNATURE': signature
          },
          body: JSON.stringify(payload)
        }),
        { path, method, priority: 'HIGH', shardId: destShard }
      );

      if (!res.ok) {
        const txt = await res.text();
        console.error('[KALSHI SHARD TRANSFER ERROR] HTTP', res.status, txt);
        return { success: false, error: `HTTP ${res.status}: ${txt}` };
      }

      const data: any = await res.json();
      console.log(`[KALSHI SHARD TRANSFER] Transferred $${amountDollars.toFixed(2)} from Shard ${sourceShard} -> Shard ${destShard}. Transfer ID:`, data.transfer_id);
      return { success: true, transfer_id: data.transfer_id };
    } catch (e: any) {
      console.error('[KALSHI SHARD TRANSFER ERROR]', e.message);
      return { success: false, error: e.message };
    }
  }

  /**
   * Ensures Shard 2 (Crypto/Commodities) has sufficient trading balance by transferring from Shard 0 if needed.
   */
  public async ensureCryptoShardFunded(minDollars: number = 20): Promise<{ success: boolean; error?: string }> {
    const balRes = await this.getBalance();
    if (!balRes.success || !balRes.breakdown) {
      return { success: false, error: balRes.error || 'Failed to fetch balance breakdown' };
    }

    const shard0 = balRes.breakdown.find((b: any) => b.exchange_index === 0);
    const shard2 = balRes.breakdown.find((b: any) => b.exchange_index === 2);

    const s0Bal = shard0 ? parseFloat(shard0.balance) : 0;
    const s2Bal = shard2 ? parseFloat(shard2.balance) : 0;

    console.log(`[KALSHI SHARD CHECK] Shard 0: $${s0Bal.toFixed(2)}, Shard 2 (Crypto): $${s2Bal.toFixed(2)}`);

    if (s2Bal < minDollars && s0Bal > 1) {
      const transferAmount = Math.min(s0Bal - 1, minDollars - s2Bal);
      if (transferAmount > 0.50) {
        console.log(`[KALSHI AUTO-FUND] Moving $${transferAmount.toFixed(2)} from Shard 0 to Shard 2 (Crypto)...`);
        return this.transferShardBalance(0, 2, transferAmount);
      }
    }

    return { success: true };
  }

  public async getPositions(): Promise<{
    success: boolean;
    market_positions?: any[];
    event_positions?: any[];
    error?: string;
  }> {
    if (!this.isConfigured()) return { success: false, error: 'Kalshi API not configured' };

    const tryEndpoints = [this.baseUrl, this.fallbackBaseUrl];
    let lastError = '';

    for (const host of tryEndpoints) {
      try {
        const method = 'GET';
        const path = '/portfolio/positions';
        const { timestamp, signature } = this.signRequest(method, '/trade-api/v2' + path);

        const tPosStart = Date.now();
        const res = await kalshiRateLimiter.execute(
          () => fetch(host + path, {
            method,
            headers: {
              'Content-Type': 'application/json',
              'KALSHI-ACCESS-KEY': this.keyId,
              'KALSHI-ACCESS-TIMESTAMP': timestamp,
              'KALSHI-ACCESS-SIGNATURE': signature
            }
          }),
          { path, method, priority: 'NORMAL' }
        );
        const tPosElapsed = Date.now() - tPosStart;
        if (tPosElapsed > 0) latencyAdaptiveEngine.recordKalshiDataLatency(tPosElapsed);

        if (!res.ok) {
          const txt = await res.text();
          lastError = `HTTP ${res.status}: ${txt}`;
          continue;
        }

        const data: any = await res.json();
        return {
          success: true,
          market_positions: data.market_positions || [],
          event_positions: data.event_positions || []
        };
      } catch (e: any) {
        lastError = e.message || String(e);
      }
    }

    return { success: false, error: lastError };
  }

  public async getPortfolioSummary(): Promise<{
    success: boolean;
    cash: number;
    positions_value: number;
    portfolio_value: number;
    realized_pnl: number;
    unrealized_pnl: number;
    market_positions: any[];
    event_positions: any[];
    error?: string;
  }> {
    if (!this.isConfigured()) {
      return {
        success: false,
        cash: 0,
        positions_value: 0,
        portfolio_value: 0,
        realized_pnl: 0,
        unrealized_pnl: 0,
        market_positions: [],
        event_positions: [],
        error: 'Not configured'
      };
    }

    try {
      const [balRes, posRes] = await Promise.all([
        this.getBalance(),
        this.getPositions()
      ]);

      const cash = balRes.success && typeof balRes.balance === 'number' ? balRes.balance : 0;
      const marketPositions = posRes.success && Array.isArray(posRes.market_positions) ? posRes.market_positions : [];
      const eventPositions = posRes.success && Array.isArray(posRes.event_positions) ? posRes.event_positions : [];

      let positionsValue = 0;
      let realizedPnl = 0;
      let unrealizedPnl = 0;

      for (const p of marketPositions) {
        const count = typeof p.position === 'number' ? p.position : (p.position_fp ? parseFloat(p.position_fp) : 0);
        if (count !== 0) {
          const exposure = typeof p.market_exposure_dollars === 'number' ? p.market_exposure_dollars
            : (typeof p.market_exposure === 'number' ? p.market_exposure / 100
            : (typeof p.current_value_dollars === 'number' ? p.current_value_dollars
            : Math.abs(count) * 0.50));
          positionsValue += exposure;

          const rPnl = typeof p.realized_pnl_dollars === 'number' ? p.realized_pnl_dollars
            : (typeof p.realized_pnl === 'number' ? p.realized_pnl / 100 : 0);
          realizedPnl += rPnl;

          const uPnl = typeof p.unrealized_pnl_dollars === 'number' ? p.unrealized_pnl_dollars
            : (typeof p.unrealized_pnl === 'number' ? p.unrealized_pnl / 100 : 0);
          unrealizedPnl += uPnl;
        }
      }

      const portfolioValue = cash + positionsValue;

      return {
        success: true,
        cash,
        positions_value: positionsValue,
        portfolio_value: portfolioValue,
        realized_pnl: realizedPnl,
        unrealized_pnl: unrealizedPnl,
        market_positions: marketPositions,
        event_positions: eventPositions
      };
    } catch (err: any) {
      return {
        success: false,
        cash: 0,
        positions_value: 0,
        portfolio_value: 0,
        realized_pnl: 0,
        unrealized_pnl: 0,
        market_positions: [],
        event_positions: [],
        error: err.message || String(err)
      };
    }
  }

  public async getOpenOrders(): Promise<{
    success: boolean;
    orders?: any[];
    error?: string;
  }> {
    if (!this.isConfigured()) return { success: false, error: 'Kalshi API not configured' };

    const tryEndpoints = [this.baseUrl, this.fallbackBaseUrl];
    let lastError = '';

    for (const host of tryEndpoints) {
      try {
        const method = 'GET';
        const path = '/portfolio/orders?status=resting';
        const { timestamp, signature } = this.signRequest(method, '/trade-api/v2' + path);

        const tOrdStart = Date.now();
        const res = await kalshiRateLimiter.execute(
          () => fetch(host + path, {
            method,
            headers: {
              'Content-Type': 'application/json',
              'KALSHI-ACCESS-KEY': this.keyId,
              'KALSHI-ACCESS-TIMESTAMP': timestamp,
              'KALSHI-ACCESS-SIGNATURE': signature
            }
          }),
          { path, method, priority: 'NORMAL' }
        );
        const tOrdElapsed = Date.now() - tOrdStart;
        if (tOrdElapsed > 0) latencyAdaptiveEngine.recordKalshiDataLatency(tOrdElapsed);

        if (!res.ok) {
          const txt = await res.text();
          lastError = `HTTP ${res.status}: ${txt}`;
          continue;
        }

        const data: any = await res.json();
        return {
          success: true,
          orders: data.orders || []
        };
      } catch (e: any) {
        lastError = e.message || String(e);
      }
    }

    return { success: false, error: lastError };
  }

  public async cancelOrder(orderId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.isConfigured()) return { success: false, error: 'Kalshi API not configured' };

    try {
      const method = 'DELETE';
      const path = `/portfolio/orders/${orderId}`;
      const { timestamp, signature } = this.signRequest(method, '/trade-api/v2' + path);

      const tCancelStart = Date.now();
      const res = await kalshiRateLimiter.execute(
        () => fetch(this.baseUrl + path, {
          method,
          headers: {
            'Content-Type': 'application/json',
            'KALSHI-ACCESS-KEY': this.keyId,
            'KALSHI-ACCESS-TIMESTAMP': timestamp,
            'KALSHI-ACCESS-SIGNATURE': signature
          }
        }),
        { path, method, priority: 'CRITICAL', isCancel: true }
      );
      const tCancelElapsed = Date.now() - tCancelStart;
      if (tCancelElapsed > 0) latencyAdaptiveEngine.recordKalshiOrderLatency(tCancelElapsed);

      if (!res.ok) {
        const txt = await res.text();
        return { success: false, error: `HTTP ${res.status}: ${txt}` };
      }

      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  public async placeOrder(
    ticker: string,
    action: 'buy' | 'sell',
    side: 'yes' | 'no',
    count: number,
    price?: number,
    retryCount = 0
  ): Promise<{ success: boolean; order_id?: string; order?: any; error?: string }> {
    if (!this.isConfigured()) return { success: false, error: 'Kalshi API not configured' };

    try {
      const isPerp = ticker.toUpperCase().endsWith('PERP');
      const orderCount = Math.max(1, Math.round(count));
      
      // Kalshi requires a valid RFC 4122 UUID v4 for client_order_id
      const clientOrderId = typeof crypto.randomUUID === 'function' 
        ? crypto.randomUUID() 
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
          });

      const tryEndpoints = [this.baseUrl, this.fallbackBaseUrl];
      let lastError = '';

      for (const host of tryEndpoints) {
        try {
          const method = 'POST';
          const path = isPerp ? '/margin/orders' : '/portfolio/orders';

          let payload: any;
          if (isPerp) {
            const limitPrice = typeof price === 'number' && !isNaN(price) && price > 0 ? price : 0.50;
            payload = {
              ticker,
              side: action === 'buy' ? 'bid' : 'ask',
              count: orderCount.toString(),
              type: 'limit',
              price: limitPrice.toString(),
              client_order_id: clientOrderId,
              post_only: false
            };
          } else {
            const yesPrice = typeof price === 'number' && !isNaN(price) && price > 0 
              ? Math.min(99, Math.max(1, Math.round(price * 100))) 
              : 50;

            payload = {
              ticker,
              action,
              type: 'limit',
              side,
              count: orderCount,
              client_order_id: clientOrderId,
              yes_price: yesPrice
            };
          }

          const { timestamp, signature } = this.signRequest(method, '/trade-api/v2' + path);

          const tOrdStart = Date.now();
          const res = await kalshiRateLimiter.execute(
            () => fetch(host + path, {
              method,
              headers: {
                'Content-Type': 'application/json',
                'KALSHI-ACCESS-KEY': this.keyId,
                'KALSHI-ACCESS-TIMESTAMP': timestamp,
                'KALSHI-ACCESS-SIGNATURE': signature
              },
              body: JSON.stringify(payload)
            }),
            { path, method, priority: 'HIGH', symbol: ticker }
          );
          const tOrdElapsed = Date.now() - tOrdStart;
          if (tOrdElapsed > 0) latencyAdaptiveEngine.recordKalshiOrderLatency(tOrdElapsed);

          if (!res.ok) {
            const txt = await res.text();
            lastError = `HTTP ${res.status}: ${txt}`;
            console.error(`[KALSHI ORDER ERROR on ${host}] HTTP ${res.status}:`, txt);

            // Shard 2 Auto-Healer: If error is about insufficient balance/margin on the target shard, auto-fund from Shard 0 and retry once
            if (
              retryCount === 0 &&
              isPerp &&
              (txt.includes('insufficient') || txt.includes('balance') || txt.includes('margin') || txt.includes('funds') || txt.includes('exchange_index'))
            ) {
              console.log('[KALSHI SHARD HEALER] Insufficient balance on shard. Moving funds...');
              const fundRes = await this.ensureCryptoShardFunded(20);
              if (fundRes.success) {
                await new Promise((r) => setTimeout(r, 1000));
                return this.placeOrder(ticker, action, side, count, price, retryCount + 1);
              }
            }
            continue;
          }

          const data: any = await res.json();
          const orderObj = data.order || data;
          const orderId = orderObj.order_id || orderObj.client_order_id || clientOrderId;

          console.log(`[KALSHI LIVE ORDER SUCCESS] Placed ${action} ${side} on ${ticker} (ID: ${orderId})`);
          return { success: true, order_id: orderId, order: orderObj };
        } catch (e: any) {
          lastError = e.message || String(e);
        }
      }

      return { success: false, error: lastError };
    } catch (e: any) {
      console.error('[KALSHI ORDER ERROR]', e.message);
      return { success: false, error: e.message };
    }
  }

  public async getOrderBook(ticker: string): Promise<{ success: boolean; bids?: any[]; asks?: any[]; error?: string }> {
    try {
      const isPerp = ticker.toUpperCase().endsWith('PERP');
      const path = isPerp ? `/margin/markets/${ticker}/orderbook` : `/markets/${ticker}/orderbook`;
      const tObStart = Date.now();
      
      const res = await kalshiRateLimiter.execute(
        () => fetch(this.baseUrl + path, { method: 'GET' }),
        { path, method: 'GET', priority: 'LOW', symbol: ticker }
      );
      
      const tObElapsed = Date.now() - tObStart;
      if (tObElapsed > 0) latencyAdaptiveEngine.recordKalshiDataLatency(tObElapsed);
      if (!res.ok) {
        const txt = await res.text();
        return { success: false, error: `HTTP ${res.status}: ${txt}` };
      }
      const data: any = await res.json();
      if (isPerp && data.orderbook) {
        const bids = (data.orderbook.bids || []).map((b: any) => ({ price: parseFloat(b[0]), size: parseFloat(b[1]) })).sort((a: any, b: any) => b.price - a.price);
        const asks = (data.orderbook.asks || []).map((a: any) => ({ price: parseFloat(a[0]), size: parseFloat(a[1]) })).sort((a: any, b: any) => a.price - b.price);
        return { success: true, bids, asks };
      }
      const ob = data.orderbook || data.orderbook_fp || {};
      const bids: any[] = [];
      const asks: any[] = [];
      const yesBids = ob.yes_dollars || ob.yes || [];
      const noBids = ob.no_dollars || ob.no || [];
      yesBids.forEach((lvl: any) => {
        const rawP = parseFloat(lvl[0]);
        const price = rawP > 1 ? rawP / 100 : rawP;
        bids.push({ price, size: parseFloat(lvl[1]) });
      });
      noBids.forEach((lvl: any) => {
        const rawP = parseFloat(lvl[0]);
        const normP = rawP > 1 ? rawP / 100 : rawP;
        asks.push({ price: parseFloat((1.0 - normP).toFixed(4)), size: parseFloat(lvl[1]) });
      });
      bids.sort((a: any, b: any) => b.price - a.price);
      asks.sort((a: any, b: any) => a.price - b.price);
      return { success: true, bids, asks };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }
}

export const kalshiService = new KalshiService();
