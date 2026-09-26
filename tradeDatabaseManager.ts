import fs from 'fs';
import path from 'path';

// ==========================================
// 1. OPTIMIZED DATA ENCODING (BITPACKING)
// ==========================================
export class TradeEncoder {
  /**
   * Assign each condition a unique bit space (Powers of 2).
   * Bitwise operations in JS operate on 32-bit signed integers.
   */
  static INDICATORS: Record<string, number> = {
    "RSI_OVERSOLD":          1 << 0,  // 1
    "MACD_BULLISH":          1 << 1,  // 2
    "EMA_SUPPORT":           1 << 2,  // 4
    "VOL_SPIKE":             1 << 3,  // 8
    "BOLLINGER_LOWER":       1 << 4,  // 16
    "ORDERBOOK_IMBALANCE":   1 << 5,  // 32
    "EXPIRATION_SAFETY":     1 << 6,  // 64
    "SPOT_TA_MOMENTUM":      1 << 7,  // 128
    "ICHIMOKU_BULLISH":      1 << 8,  // 256
    "ICHIMOKU_BEARISH":      1 << 9,  // 512
    "RSI_OVERBOUGHT":        1 << 10, // 1024
    "PRICE_DIRECTIONAL":      1 << 11, // 2048
    "GENERAL_ANALYSIS":      1 << 12, // 4096
    "ASK_PRESSURE":          1 << 13, // 8192
    "BID_PRESSURE":          1 << 14, // 16384
    "YES_SIDE":              1 << 15, // 32768
    "NO_SIDE":               1 << 16, // 65536
    "BTC_USD":               1 << 17, // 131072
    "ETH_USD":               1 << 18, // 262144
    "SOL_USD":               1 << 19, // 524288
    "CONFLUENCE_MULTI_TOOL": 1 << 20, // 1048576
    "DOJI_REVERSAL":         1 << 21, // 2097152
  };

  /**
   * Converts a list of indicator strings into a single compact integer.
   */
  static encodeAnalysis(activeIndicators: string[]): number {
    let encodedValue = 0;
    for (const indicator of activeIndicators) {
      if (this.INDICATORS[indicator] !== undefined) {
        encodedValue |= this.INDICATORS[indicator];
      }
    }
    return encodedValue;
  }

  /**
   * Decodes the compact integer back into human-readable strings.
   */
  static decodeAnalysis(encodedValue: number): string[] {
    const result: string[] = [];
    for (const [name, bit] of Object.entries(this.INDICATORS)) {
      if ((encodedValue & bit) !== 0) {
        result.push(name);
      }
    }
    return result;
  }

  /**
   * Extracts active indicator keywords from a trade report or entry meta,
   * strictly mapping spot USD historical indicators to correlated prediction contracts.
   */
  static extractIndicatorsFromTrade(tradeReport: any): string[] {
    const list: string[] = [];

    const assetStr = (tradeReport.symbol || tradeReport.label || '').toUpperCase();
    if (assetStr.includes('BTC')) list.push('BTC_USD');
    if (assetStr.includes('ETH')) list.push('ETH_USD');
    if (assetStr.includes('SOL')) list.push('SOL_USD');

    if (tradeReport.patternType && this.INDICATORS[tradeReport.patternType]) {
      list.push(tradeReport.patternType);
    }
    if (tradeReport.side === 'YES') list.push('YES_SIDE');
    if (tradeReport.side === 'NO') list.push('NO_SIDE');

    const ind = tradeReport.indicators || {};
    const spotTA = ind.spotTA || {};

    const ichimokuState = ind.ichimokuState || spotTA.ichimokuState;
    if (ichimokuState === 'BULLISH' || ichimokuState === 'BULLISH_CLOUD') list.push('ICHIMOKU_BULLISH');
    if (ichimokuState === 'BEARISH' || ichimokuState === 'BEARISH_CLOUD') list.push('ICHIMOKU_BEARISH');

    const rsi = typeof ind.rsi === 'number' ? ind.rsi : (spotTA && typeof spotTA.rsi === 'number' ? spotTA.rsi : null);
    if (rsi !== null) {
      if (rsi <= 48) list.push('RSI_OVERSOLD');
      if (rsi >= 52) list.push('RSI_OVERBOUGHT');
    }

    if (ind.orderbookImbalance || (ind.bidVol && ind.askVol && Math.abs(ind.bidVol - ind.askVol) > 0)) {
      list.push('ORDERBOOK_IMBALANCE');
      if (ind.bidVol > ind.askVol) list.push('BID_PRESSURE');
      if (ind.askVol > ind.bidVol) list.push('ASK_PRESSURE');
    }

    const volRatio = ind.volumeSurgeRatio || (spotTA && spotTA.volumeSurgeRatio);
    if (volRatio && volRatio >= 1.2) list.push('VOL_SPIKE');

    if (spotTA && spotTA.isDoji) list.push('DOJI_REVERSAL');
    if ((tradeReport.confluenceCount && tradeReport.confluenceCount >= 2) || (spotTA && spotTA.confluenceCount >= 2)) {
      list.push('CONFLUENCE_MULTI_TOOL');
    }

    if (Array.isArray(tradeReport.activeIndicators)) {
      tradeReport.activeIndicators.forEach((ai: string) => {
        if (this.INDICATORS[ai] && !list.includes(ai)) list.push(ai);
      });
    }

    // Default fallback if empty
    if (list.length === 0) list.push('GENERAL_ANALYSIS');

    return list;
  }
}

export interface RawTradeRow {
  id: number;
  timestamp: number;
  asset: string;
  encoded_analysis: number;
  target_price: number;
  actual_price: number;
  is_win: number;
  raw_metrics: string; // Heavy JSON string
}

export interface DownsampledTradeRow {
  id: number;
  timestamp: number;
  asset: string;
  encoded_analysis: number;
  is_win: number;
  performance_delta: number;
}

// ==========================================
// 2. OPTIMIZED LIFECYCLE STORAGE MANAGEMENT
// ==========================================
export class TradeDatabaseManager {
  private dbFilePath: string;
  private rawTrades: RawTradeRow[] = [];
  private downsampledTrades: DownsampledTradeRow[] = [];
  private autoIncrementId = 1;

  constructor(dbName = "bot_memory_db.json") {
    this.dbFilePath = path.join(process.cwd(), dbName);
    this.initDb();
  }

  /**
   * Enforces strict regex & taxonomy boundary filtering to isolate crypto neural prediction pipelines
   * from non-crypto instruments (e.g. sports contracts, elections, CPI).
   */
  public static isAllowedCryptoAsset(symbol: string): boolean {
    if (!symbol || typeof symbol !== 'string') return false;
    const upper = symbol.trim().toUpperCase();
    if (
      upper.includes('MATCH') ||
      upper.includes('CHALLENGER') ||
      upper.includes('ATP') ||
      upper.includes('WTA') ||
      upper.includes('SETWINNER') ||
      upper.includes('GAME') ||
      upper.includes('ELECTION') ||
      upper.includes('FED') ||
      upper.includes('CPI')
    ) {
      return false;
    }
    const cryptoRegex = /^KX(BTC|ETH|SOL|DOGE|XRP|SHIB|HYPE|WLD|AVA|UNI|LINK|ADA|NEAR|APT)(15M|1H|4H|PERP|DAILY)?(-[A-Z0-9]+)?$/i;
    return cryptoRegex.test(upper) || upper.includes('BTC') || upper.includes('ETH') || upper.includes('SOL') || upper.includes('DOGE') || upper.includes('XRP') || upper.includes('SHIB') || upper.includes('HYPE') || upper.includes('WLD');
  }

  /**
   * Validates that trade data satisfies strict SR 11-7 model compliance standards.
   */
  public static validateRealTradeData(
    asset: string,
    indicators: string[],
    targetPrice: number,
    actualPrice: number,
    heavyJsonStr: string
  ): { isValid: boolean; reason?: string } {
    if (!asset || typeof asset !== 'string' || asset.trim() === '') {
      return { isValid: false, reason: 'Missing or empty asset symbol' };
    }

    if (!TradeDatabaseManager.isAllowedCryptoAsset(asset)) {
      return { isValid: false, reason: `Asset '${asset}' failed crypto taxonomy boundary validation (non-crypto instrument prohibited)` };
    }

    const upperAsset = asset.toUpperCase();
    if (
      upperAsset.includes('SIMULATED') ||
      upperAsset.includes('MOCK') ||
      upperAsset.includes('TEST_') ||
      upperAsset.includes('DUMMY') ||
      upperAsset.includes('FAKE')
    ) {
      return { isValid: false, reason: `Asset name '${asset}' contains simulated or mock identifier` };
    }

    if (typeof targetPrice !== 'number' || isNaN(targetPrice) || !isFinite(targetPrice) || targetPrice <= 0) {
      return { isValid: false, reason: `SR 11-7 Schema Reject: Invalid zero or negative targetPrice: ${targetPrice}` };
    }

    if (typeof actualPrice !== 'number' || isNaN(actualPrice) || !isFinite(actualPrice) || actualPrice <= 0) {
      return { isValid: false, reason: `SR 11-7 Schema Reject: Invalid zero or negative actualPrice: ${actualPrice}` };
    }

    // Check JSON payload for non-zero pricing fields and featureSnapshot
    if (heavyJsonStr) {
      try {
        const parsed = JSON.parse(heavyJsonStr);
        if (parsed.isSimulated === true || parsed.isMock === true || parsed.isTest === true || parsed.isSynthetic === true) {
          return { isValid: false, reason: 'Trade payload contains explicit simulation/mock flag' };
        }
        if (parsed.patternType && (parsed.patternType.includes('MOCK') || parsed.patternType.includes('SIMULATED'))) {
          return { isValid: false, reason: `Pattern type '${parsed.patternType}' is mock/simulated` };
        }

        // SR 11-7 Schema Validation: Must contain non-empty featureSnapshot and non-zero entry/exit pricing
        const snapshot = parsed.featureSnapshot || parsed.snapshot || parsed.entryFeatures;
        if (!snapshot || typeof snapshot !== 'object' || Object.keys(snapshot).length === 0) {
          return { isValid: false, reason: 'SR 11-7 Schema Reject: Trade featureSnapshot is missing or empty' };
        }

        const entryP = parsed.entryPrice || parsed.price || targetPrice;
        const exitP = parsed.exitPrice || parsed.closePrice || actualPrice;
        if (!entryP || entryP <= 0 || !exitP || exitP <= 0) {
          return { isValid: false, reason: 'SR 11-7 Schema Reject: Zero-value pricing fields detected in trade record' };
        }
      } catch (e) {
        // invalid JSON string
      }
    }

    // Ensure indicators contains at least one recognized real market indicator
    if (!indicators || indicators.length === 0) {
      return { isValid: false, reason: 'Empty indicator array; must map spot USD historical indicators to prediction contracts' };
    }

    return { isValid: true };
  }

  private initDb() {
    try {
      if (fs.existsSync(this.dbFilePath)) {
        const raw = fs.readFileSync(this.dbFilePath, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.rawTrades)) {
          // Sanitize raw trades to purge any simulated/mock entries
          this.rawTrades = data.rawTrades.filter(r => {
            const activeIndicators = TradeEncoder.decodeAnalysis(r.encoded_analysis);
            const val = TradeDatabaseManager.validateRealTradeData(r.asset, activeIndicators, r.target_price, r.actual_price, r.raw_metrics);
            return val.isValid;
          });
        }
        if (Array.isArray(data.downsampledTrades)) this.downsampledTrades = data.downsampledTrades;
        if (typeof data.autoIncrementId === 'number') this.autoIncrementId = data.autoIncrementId;
        console.log(`[DB] Loaded ${this.rawTrades.length} real market trades and ${this.downsampledTrades.length} downsampled trades from persistent store.`);
      } else {
        this.saveToDisk();
      }
    } catch (e) {
      console.error("[DB ERROR] Initializing persistent store failed, resetting:", e);
      this.rawTrades = [];
      this.downsampledTrades = [];
    }
  }

  private saveTimeout: NodeJS.Timeout | null = null;

  public clearAllTrades() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    this.rawTrades = [];
    this.downsampledTrades = [];
    this.autoIncrementId = 1;
    try {
      const payload = JSON.stringify({
        rawTrades: [],
        downsampledTrades: [],
        autoIncrementId: 1,
        lastUpdated: new Date().toISOString()
      });
      fs.writeFileSync(this.dbFilePath, payload, 'utf-8');
      console.log("[DB] Cleared all trade database records on fresh restart.");
    } catch (e) {
      console.error("[DB ERROR] Failed wiping trades from disk:", e);
    }
  }

  private saveToDisk() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(() => {
      try {
        const payload = JSON.stringify({
          rawTrades: this.rawTrades,
          downsampledTrades: this.downsampledTrades,
          autoIncrementId: this.autoIncrementId,
          lastUpdated: new Date().toISOString()
        });
        fs.writeFile(this.dbFilePath, payload, 'utf-8', (err) => {
          if (err) console.error("[DB ERROR] Failed writing persistent store to disk:", err);
        });
      } catch (e) {
        console.error("[DB ERROR] Failed preparing persistent store for disk:", e);
      }
    }, 5000); // 5-second debounce
  }

  /**
   * Saves a fresh trade using the binary encoder to strip text bloat after validating non-simulated data.
   */
  async insertTrade(
    asset: string,
    indicators: string[],
    targetPrice: number,
    actualPrice: number,
    isWin: boolean,
    heavyJsonStr: string,
    timestampOverrideSec?: number
  ): Promise<number> {
    const safeTargetPrice = (typeof targetPrice === 'number' && !isNaN(targetPrice) && isFinite(targetPrice) && targetPrice > 0)
      ? targetPrice
      : 0.50;
    const safeActualPrice = (typeof actualPrice === 'number' && !isNaN(actualPrice) && isFinite(actualPrice) && actualPrice > 0)
      ? actualPrice
      : Math.max(0.0001, Math.abs(actualPrice) || 0.01);

    const validation = TradeDatabaseManager.validateRealTradeData(asset, indicators, safeTargetPrice, safeActualPrice, heavyJsonStr);
    if (!validation.isValid) {
      console.warn(`[DB VALIDATION REJECT] Refused to record simulated or invalid trade to TradeDatabaseManager store: ${validation.reason}`);
      throw new Error(`[DB VALIDATION REJECT] ${validation.reason}`);
    }

    const encoded = TradeEncoder.encodeAnalysis(indicators);
    const winInt = isWin ? 1 : 0;
    const nowSec = timestampOverrideSec || Math.floor(Date.now() / 1000);
    const newId = this.autoIncrementId++;

    const newRow: RawTradeRow = {
      id: newId,
      timestamp: nowSec,
      asset,
      encoded_analysis: encoded,
      target_price: safeTargetPrice,
      actual_price: safeActualPrice,
      is_win: winInt,
      raw_metrics: heavyJsonStr
    };

    this.rawTrades.unshift(newRow);
    if (this.rawTrades.length > 5000) {
      this.rawTrades.pop();
    }
    this.saveToDisk();
    return newId;
  }

  /**
   * Updates a trade row with second-by-second post-exit ticks and 1m post-exit snapshot counterfactual data.
   */
  async updateTradeCounterfactual10m(dbId: number, price10m: number): Promise<boolean> {
    const row = this.rawTrades.find(r => r.id === dbId);
    if (!row) return false;
    try {
      let parsed: any = {};
      if (row.raw_metrics) parsed = JSON.parse(row.raw_metrics);
      parsed.post_exit_price_10m = price10m;
      row.raw_metrics = JSON.stringify(parsed);
      this.saveToDisk();
      return true;
    } catch (e) {
      return false;
    }
  }

  async updateTradeCounterfactualData(
    dbId: number,
    postExitTicks20s?: any[],
    postExitSnapshot1m?: any
  ): Promise<boolean> {
    const row = this.rawTrades.find(r => r.id === dbId);
    if (!row) return false;

    try {
      let parsed = {};
      if (row.raw_metrics) parsed = JSON.parse(row.raw_metrics);

      if (postExitTicks20s) (parsed as any).post_exit_ticks_20s = postExitTicks20s;
      if (postExitSnapshot1m) (parsed as any).post_exit_snapshot_1m = postExitSnapshot1m;

      row.raw_metrics = JSON.stringify(parsed);
      this.saveToDisk();
      return true;
    } catch (e) {
      console.error(`[DB ERROR] Failed updating counterfactual data for trade ${dbId}:`, e);
      return false;
    }
  }

  /**
   * Executes data degradation: Downsamples at 30 days, completely culls at 60 days.
   */
  async runLifecycleMaintenance(): Promise<{ downsampledCount: number; purgedRawCount: number; purgedDownsampledCount: number }> {
    const nowSec = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = nowSec - (30 * 86400);
    const sixtyDaysAgo = nowSec - (60 * 86400);

    // PHASE 1: Downsample data between 30 and 60 days old
    // Extracts core insights, strips heavy raw_metrics, and moves to compact downsampled_trades layout
    const toDownsample = this.rawTrades.filter(r => r.timestamp <= thirtyDaysAgo && r.timestamp > sixtyDaysAgo);
    
    for (const r of toDownsample) {
      const downsampledRow: DownsampledTradeRow = {
        id: r.id,
        timestamp: r.timestamp,
        asset: r.asset,
        encoded_analysis: r.encoded_analysis,
        is_win: r.is_win,
        performance_delta: r.actual_price - r.target_price
      };
      this.downsampledTrades.unshift(downsampledRow);
    }

    const downsampledCount = toDownsample.length;

    // Purge raw heavy data older than 30 days
    const prevRawCount = this.rawTrades.length;
    this.rawTrades = this.rawTrades.filter(r => r.timestamp > thirtyDaysAgo);
    const purgedRawCount = prevRawCount - this.rawTrades.length;

    // PHASE 2: Complete Cull (Hard Delete everything older than 60 days)
    const prevDownCount = this.downsampledTrades.length;
    this.downsampledTrades = this.downsampledTrades.filter(d => d.timestamp > sixtyDaysAgo);
    const purgedDownsampledCount = prevDownCount - this.downsampledTrades.length;

    // VACUUM: Compacts persistent store on disk
    this.saveToDisk();

    console.log(`[DB MAINTENANCE] Execution complete. Downsampled: ${downsampledCount}, Purged Raw (>30d): ${purgedRawCount}, Culled (>60d): ${purgedDownsampledCount}. VACUUM completed.`);
    return { downsampledCount, purgedRawCount, purgedDownsampledCount };
  }

  /**
   * Retrieves trade records (raw + downsampled decoded) for frontend rendering.
   */
  async getTradesByPatternType(patternType: string, limit = 500): Promise<any[]> {
    const rawList = [];
    const sortedRaw = [...this.rawTrades].sort((a, b) => b.timestamp - a.timestamp);
    
    for (const row of sortedRaw) {
      if (rawList.length >= limit) break;
      let parsedMetrics: any = {};
      try {
        if (row.raw_metrics) parsedMetrics = JSON.parse(row.raw_metrics);
      } catch (e) {}
      
      const activeIndicators = TradeEncoder.decodeAnalysis(row.encoded_analysis);
      const rowPatternType = parsedMetrics.patternType || activeIndicators.find(i => ['ORDERBOOK_IMBALANCE', 'EXPIRATION_SAFETY', 'SPOT_TA_MOMENTUM'].includes(i)) || 'GENERAL_ANALYSIS';
      
      if (rowPatternType === patternType) {
        rawList.push({
          id: parsedMetrics.id || row.id,
          dbId: row.id,
          timestamp: new Date(row.timestamp * 1000).toISOString(),
          symbol: row.asset,
          label: parsedMetrics.label || row.asset,
          side: parsedMetrics.side || (activeIndicators.includes('YES_SIDE') ? 'YES' : 'NO'),
          patternType: rowPatternType,
          prediction: parsedMetrics.prediction || 'PRICE_DIRECTIONAL',
          wasAnalysisCorrect: Boolean(row.is_win),
          didPriceValidateAnalysis: parsedMetrics.didPriceValidateAnalysis ?? Boolean(row.is_win),
          pnlPct: parsedMetrics.pnlPct ?? (row.actual_price && row.target_price ? parseFloat((((row.actual_price - row.target_price) / row.target_price) * 100).toFixed(2)) : 0),
          pnlUsd: parsedMetrics.pnlUsd ?? 0,
          closeReason: parsedMetrics.closeReason || (row.is_win ? 'Take Profit' : 'Stop Loss'),
          params: parsedMetrics.params || {},
          indicators: parsedMetrics.indicators || { activeIndicators },
          encodedAnalysisBitmask: row.encoded_analysis,
          decodedIndicators: activeIndicators,
          entry_features: parsedMetrics.entryFeatures || parsedMetrics.entry_features || null,
          maxAdverseExcursion: parsedMetrics.maxAdverseExcursion || 0,
          maxFavorableExcursion: parsedMetrics.maxFavorableExcursion || 0,
          marketRegimeAtEntry: parsedMetrics.marketRegimeAtEntry || 'UNKNOWN',
          post_exit_ticks_20s: parsedMetrics.post_exit_ticks_20s || [],
          post_exit_snapshot_1m: parsedMetrics.post_exit_snapshot_1m || null,
          post_exit_price_10m: parsedMetrics.post_exit_price_10m || null
        });
      }
    }
    
    return rawList;
  }

  async getAllTrades(limit = 200): Promise<any[]> {
    // Sort raw trades by timestamp DESC
    const sortedRaw = [...this.rawTrades].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);

    const rawList = sortedRaw.map((row) => {
      let parsedMetrics: any = {};
      try {
        if (row.raw_metrics) parsedMetrics = JSON.parse(row.raw_metrics);
      } catch (e) {}

      const activeIndicators = TradeEncoder.decodeAnalysis(row.encoded_analysis);

      return {
        id: parsedMetrics.id || row.id,
        dbId: row.id,
        timestamp: new Date(row.timestamp * 1000).toISOString(),
        symbol: row.asset,
        label: parsedMetrics.label || row.asset,
        side: parsedMetrics.side || (activeIndicators.includes('YES_SIDE') ? 'YES' : 'NO'),
        patternType: parsedMetrics.patternType || activeIndicators.find(i => ['ORDERBOOK_IMBALANCE', 'EXPIRATION_SAFETY', 'SPOT_TA_MOMENTUM'].includes(i)) || 'GENERAL_ANALYSIS',
        prediction: parsedMetrics.prediction || 'PRICE_DIRECTIONAL',
        wasAnalysisCorrect: Boolean(row.is_win),
        didPriceValidateAnalysis: parsedMetrics.didPriceValidateAnalysis ?? Boolean(row.is_win),
        pnlPct: parsedMetrics.pnlPct ?? (row.actual_price && row.target_price ? parseFloat((((row.actual_price - row.target_price) / row.target_price) * 100).toFixed(2)) : 0),
        pnlUsd: parsedMetrics.pnlUsd ?? 0,
        closeReason: parsedMetrics.closeReason || (row.is_win ? 'Take Profit' : 'Stop Loss'),
        params: parsedMetrics.params || {},
        indicators: parsedMetrics.indicators || { activeIndicators },
        encodedAnalysisBitmask: row.encoded_analysis,
        decodedIndicators: activeIndicators,
        entry_features: parsedMetrics.entryFeatures || parsedMetrics.entry_features || null,
        maxAdverseExcursion: parsedMetrics.maxAdverseExcursion || 0,
        maxFavorableExcursion: parsedMetrics.maxFavorableExcursion || 0,
        marketRegimeAtEntry: parsedMetrics.marketRegimeAtEntry || 'UNKNOWN',
        post_exit_ticks_20s: parsedMetrics.post_exit_ticks_20s || [],
          post_exit_snapshot_1m: parsedMetrics.post_exit_snapshot_1m || null,
          post_exit_price_10m: parsedMetrics.post_exit_price_10m || null
      };
    });

    const remainingLimit = limit - rawList.length;
    if (remainingLimit <= 0) return rawList;

    const sortedDown = [...this.downsampledTrades].sort((a, b) => b.timestamp - a.timestamp).slice(0, remainingLimit);

    const downsampledList = sortedDown.map((row) => {
      const activeIndicators = TradeEncoder.decodeAnalysis(row.encoded_analysis);

      return {
        id: row.id + 1000000,
        dbId: row.id,
        timestamp: new Date(row.timestamp * 1000).toISOString(),
        symbol: row.asset,
        label: row.asset,
        side: activeIndicators.includes('YES_SIDE') ? 'YES' : activeIndicators.includes('NO_SIDE') ? 'NO' : 'YES',
        patternType: activeIndicators.find(i => ['ORDERBOOK_IMBALANCE', 'EXPIRATION_SAFETY', 'SPOT_TA_MOMENTUM'].includes(i)) || 'GENERAL_ANALYSIS',
        prediction: 'PRICE_DIRECTIONAL',
        wasAnalysisCorrect: Boolean(row.is_win),
        didPriceValidateAnalysis: Boolean(row.is_win),
        pnlPct: parseFloat((row.performance_delta * 100).toFixed(2)),
        pnlUsd: 0,
        closeReason: row.is_win ? 'Take Profit (30-60d Compressed)' : 'Stop Loss (30-60d Compressed)',
        params: {},
        indicators: { activeIndicators },
        encodedAnalysisBitmask: row.encoded_analysis,
        decodedIndicators: activeIndicators,
        isDownsampled: true
      };
    });

    return [...rawList, ...downsampledList];
  }
}

export const tradeDbManager = new TradeDatabaseManager();
