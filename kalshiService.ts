import crypto from 'crypto';

export class KalshiService {
  private keyId: string;
  private secretRaw: string;
  private privateKey: crypto.KeyObject | null = null;
  private baseUrl = 'https://external-api.kalshi.com/trade-api/v2';

  constructor() {
    this.keyId = process.env.KALSHI_API_KEY || '';
    this.secretRaw = process.env.KALSHI_API_SECRET || '';
    this.initPrivateKey();
  }

  private initPrivateKey() {
    if (!this.keyId || !this.secretRaw) return;
    try {
      let pem = this.secretRaw;
      
      // Handle key pasted as a single line with literal \n
      pem = pem.replace(/\\n/g, '\n');
      
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
        if (pem.length > 200) {
            const base64 = pem.replace(/\s+/g, '');
            pem = '-----BEGIN RSA PRIVATE KEY-----\n' + (base64.match(/.{1,64}/g)?.join('\n') || base64) + '\n-----END RSA PRIVATE KEY-----';
        }
      }
      this.privateKey = crypto.createPrivateKey(pem);
      console.log('[KALSHI] Initialized Kalshi RSA private key successfully.');
    } catch (err) {
      console.error('[KALSHI] Error initializing Kalshi private key:', err);
    }
  }

  public isConfigured(): boolean {
    return !!(this.keyId && this.secretRaw && this.privateKey);
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

  public async getBalance(): Promise<{ success: boolean; balance?: number; breakdown?: any[]; error?: string }> {
    if (!this.isConfigured()) return { success: false, error: 'Kalshi API not configured' };

    try {
      const method = 'GET';
      const path = '/portfolio/balance';

      const { timestamp, signature } = this.signRequest(method, '/trade-api/v2' + path);

      const res = await fetch(this.baseUrl + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'KALSHI-ACCESS-KEY': this.keyId,
          'KALSHI-ACCESS-TIMESTAMP': timestamp,
          'KALSHI-ACCESS-SIGNATURE': signature
        }
      });

      if (!res.ok) {
        const txt = await res.text();
        console.error('[KALSHI BALANCE ERROR] HTTP', res.status, txt);
        return { success: false, error: `HTTP ${res.status}: ${txt}` };
      }

      const data: any = await res.json();
      const balanceDollars = (data.balance || 0) / 100;
      return { success: true, balance: balanceDollars, breakdown: data.balance_breakdown || [] };
    } catch (e: any) {
      console.error('[KALSHI BALANCE ERROR]', e.message);
      return { success: false, error: e.message };
    }
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

      const res = await fetch(this.baseUrl + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'KALSHI-ACCESS-KEY': this.keyId,
          'KALSHI-ACCESS-TIMESTAMP': timestamp,
          'KALSHI-ACCESS-SIGNATURE': signature
        },
        body: JSON.stringify(payload)
      });

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

  public async placeOrder(
    ticker: string, 
    action: 'buy' | 'sell', 
    side: 'yes' | 'no', 
    count: number, 
    price?: number,
    retryCount = 0
  ): Promise<{ success: boolean; order_id?: string; error?: string }> {
    if (!this.isConfigured()) return { success: false, error: 'Kalshi API not configured' };

    try {
      const isPerp = ticker.toUpperCase().endsWith('PERP');
      const method = 'POST';
      const path = '/portfolio/events/orders';
      
      let v2Side: 'bid' | 'ask' = 'bid';
      if (isPerp) {
        // For perpetuals: action buy -> bid, action sell -> ask
        v2Side = action === 'buy' ? 'bid' : 'ask';
      } else {
        if (action === 'buy' && side === 'yes') v2Side = 'bid';
        else if (action === 'buy' && side === 'no') v2Side = 'ask';
        else if (action === 'sell' && side === 'yes') v2Side = 'ask';
        else if (action === 'sell' && side === 'no') v2Side = 'bid';
      }

      let finalPrice = typeof price === 'number' && !isNaN(price) && price > 0 ? price : 0.50;
      if (!isPerp) {
        if (side === 'no') {
          finalPrice = 1.0 - finalPrice;
        }
        // Strictly clamp price to valid Kalshi market contract boundaries [0.01, 0.99] and round to 2 decimal places (cents)
        finalPrice = Math.round(Math.max(0.01, Math.min(0.99, finalPrice)) * 100) / 100;
      } else {
        // Perpetuals are quoted in actual dollar amounts
        finalPrice = Math.max(0.0001, Math.round(finalPrice * 10000) / 10000);
      }

      const payload: any = {
        ticker,
        side: v2Side,
        count: count.toString(),
        time_in_force: 'good_till_canceled',
        self_trade_prevention_type: 'taker_at_cross',
        client_order_id: 'kal_bot_' + Date.now() + '_' + Math.floor(Math.random()*1000),
        exchange_index: -1 // Auto-route across exchange shards (Shard 0 Elections, Shard 2 Crypto)
      };
      
      payload.price = isPerp ? finalPrice.toFixed(4) : finalPrice.toFixed(2);

      const { timestamp, signature } = this.signRequest(method, '/trade-api/v2' + path);

      const res = await fetch(this.baseUrl + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'KALSHI-ACCESS-KEY': this.keyId,
          'KALSHI-ACCESS-TIMESTAMP': timestamp,
          'KALSHI-ACCESS-SIGNATURE': signature
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const txt = await res.text();
        if (txt.includes('insufficient_balance') || txt.includes('insufficient_shard_balance')) {
          console.log('[KALSHI BALANCE NOTICE] Insufficient balance for live order submission:', txt);
        } else {
          console.error('[KALSHI ORDER ERROR] HTTP', res.status, txt);
        }

        // Auto-heal Kalshi Shard Allocation / insufficient balance on shard:
        if (
          retryCount === 0 &&
          (txt.includes('insufficient_shard_balance') || txt.includes('Exchange user not found') || txt.includes('insufficient_balance'))
        ) {
          console.log('[KALSHI SHARD HEALER] Insufficient shard balance detected. Funding Crypto Shard 2 directly...');
          const fundRes = await this.ensureCryptoShardFunded(20);
          if (fundRes.success) {
            await new Promise((r) => setTimeout(r, 1000));
            return this.placeOrder(ticker, action, side, count, price, retryCount + 1);
          }
        }

        return { success: false, error: `HTTP ${res.status}: ${txt}` };
      }

      const data: any = await res.json();
      console.log(`[KALSHI ORDER SUCCESS] Order placed successfully: ID ${data.order_id || data.client_order_id}`);
      return { success: true, order_id: data.order_id || data.order?.order_id || 'submitted' };
    } catch (e: any) {
      console.error('[KALSHI ORDER ERROR]', e.message);
      return { success: false, error: e.message };
    }
  }

  public async getOrderBook(ticker: string): Promise<{ success: boolean; bids?: any[]; asks?: any[]; error?: string }> {
    try {
      const isPerp = ticker.toUpperCase().endsWith('PERP');
      const path = isPerp ? `/margin/markets/${ticker}/orderbook` : `/markets/${ticker}/orderbook`;
      const res = await fetch(this.baseUrl + path, { method: 'GET' });
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
      const yesBids = ob.yes || ob.yes_dollars || [];
      const noBids = ob.no || ob.no_dollars || [];
      yesBids.forEach((lvl: any) => {
        bids.push({ price: parseFloat(lvl[0]), size: parseFloat(lvl[1]) });
      });
      noBids.forEach((lvl: any) => {
        asks.push({ price: parseFloat((1.0 - parseFloat(lvl[0])).toFixed(2)), size: parseFloat(lvl[1]) });
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
