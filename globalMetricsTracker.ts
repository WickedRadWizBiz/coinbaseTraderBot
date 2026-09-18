export class GlobalMetricsTracker {
  public usdtDominance: number = 7.0; 
  public usdtDominanceSignal: 'UP' | 'DOWN' | 'NEUTRAL' = 'NEUTRAL';
  public lastDominance: number = 7.0;
  
  // Store 1-minute historical closes: { timestamp, close }
  public history: { time: number; val: number }[] = [];

  private pollingInterval: NodeJS.Timeout | null = null;

  start() {
    this.fetchMetrics();
    this.pollingInterval = setInterval(() => this.fetchMetrics(), 60000); 
  }

  stop() {
    if (this.pollingInterval) clearInterval(this.pollingInterval);
  }

  async fetchMetrics() {
    try {
      const res = await fetch('https://api.coingecko.com/api/v3/global', { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.data && data.data.market_cap_percentage && data.data.market_cap_percentage.usdt) {
        const newUsdtD = data.data.market_cap_percentage.usdt;
        
        if (this.lastDominance > 0 && this.lastDominance !== 7.0) {
            const diff = newUsdtD - this.lastDominance;
            if (diff > 0.005) this.usdtDominanceSignal = 'UP';
            else if (diff < -0.005) this.usdtDominanceSignal = 'DOWN';
            else this.usdtDominanceSignal = 'NEUTRAL';
        }
        
        this.lastDominance = this.usdtDominance;
        this.usdtDominance = newUsdtD;
        
        // Add to history
        const now = Date.now();
        this.history.push({ time: now, val: newUsdtD });
        // Keep up to 240 minutes of data
        if (this.history.length > 240) {
          this.history.shift();
        }
      }
    } catch (e) {}
  }

  // Calculate RSI 7 for sub-30min timeframes
  private aggregateCloses(intervalMin: number): number[] {
    const grouped = new Map<number, number>();
    for (const d of this.history) {
      const bucket = Math.floor(d.time / (intervalMin * 60000));
      grouped.set(bucket, d.val);
    }
    return Array.from(grouped.entries()).sort((a,b) => a[0] - b[0]).map(x => x[1]);
  }

  private calculateRSI(closes: number[], period: number = 7): number | null {
    if (closes.length <= period) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff > 0) gains += diff;
      else losses -= diff;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? -diff : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  public getUsdtDominanceRsiStatus(): 'OVERBOUGHT_MULTI' | 'OVERSOLD_MULTI' | 'NEUTRAL' {
    const timeframes = [1, 5, 15]; // 1m, 5m, 15m
    let overboughtCount = 0;
    let oversoldCount = 0;

    for (const tf of timeframes) {
      const closes = this.aggregateCloses(tf);
      const rsi = this.calculateRSI(closes, 7);
      if (rsi !== null) {
        if (rsi >= 70) overboughtCount++;
        else if (rsi <= 30) oversoldCount++;
      }
    }

    if (overboughtCount >= 2) return 'OVERBOUGHT_MULTI';
    if (oversoldCount >= 2) return 'OVERSOLD_MULTI';
    return 'NEUTRAL';
  }
}

export const globalMetricsTracker = new GlobalMetricsTracker();
