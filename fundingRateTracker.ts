export class FundingRateTracker {
  public fundingRates: Record<string, number> = {};
  public isSqueezing: Record<string, 'LONG_SQUEEZE' | 'SHORT_SQUEEZE' | 'NEUTRAL'> = {};
  
  private pollingInterval: NodeJS.Timeout | null = null;
  // Thresholds: if funding > 0.015% (retail too long), risk of long squeeze (short advantage)
  // if funding < -0.015% (retail too short), risk of short squeeze (long advantage)
  private readonly SQUEEZE_THRESHOLD = 0.00015;

  start() {
    this.fetchFundingRates();
    // Poll Binance fapi (public endpoint) every 30 seconds
    this.pollingInterval = setInterval(() => this.fetchFundingRates(), 30000);
  }

  stop() {
    if (this.pollingInterval) clearInterval(this.pollingInterval);
  }

  async fetchFundingRates() {
    try {
      // Free public endpoint, no API key required
      const res = await fetch('https://fapi.binance.com/fapi/v1/premiumIndex', { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;
      const data = await res.json();
      
      if (Array.isArray(data)) {
        for (const item of data) {
          const symbol = item.symbol; // e.g. BTCUSDT
          if (symbol === 'BTCUSDT' || symbol === 'ETHUSDT' || symbol === 'SOLUSDT') {
            const baseAsset = symbol.replace('USDT', '');
            const rate = parseFloat(item.lastFundingRate);
            this.fundingRates[baseAsset] = rate;
            
            if (rate > this.SQUEEZE_THRESHOLD) {
              this.isSqueezing[baseAsset] = 'LONG_SQUEEZE'; // Bearish pressure
            } else if (rate < -this.SQUEEZE_THRESHOLD) {
              this.isSqueezing[baseAsset] = 'SHORT_SQUEEZE'; // Bullish pressure
            } else {
              this.isSqueezing[baseAsset] = 'NEUTRAL';
            }
          }
        }
      }
    } catch (e) {
      // Silently fail on network error
    }
  }

  getSqueezeRisk(asset: string): 'LONG_SQUEEZE' | 'SHORT_SQUEEZE' | 'NEUTRAL' {
    const key = asset.includes('SOL') ? 'SOL' : asset.includes('ETH') ? 'ETH' : asset.includes('BTC') ? 'BTC' : '';
    if (!key) return 'NEUTRAL';
    return this.isSqueezing[key] || 'NEUTRAL';
  }
}

export const fundingRateTracker = new FundingRateTracker();
