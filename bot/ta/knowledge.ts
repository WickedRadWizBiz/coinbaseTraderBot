// The TA knowledge library: what each indicator is, how it is computed, which timeframes it is
// meant for, what its states mean for price action, how indicators combine into confluence, and
// how strong the evidence behind each idea is.
//
// Sources: the operator's reference "Quantitative Technical Analysis in Cryptocurrency Markets:
// Mathematical Formulations, Indicators, and Multi-Dimensional Confluence" (the PDF), cross-checked
// against the original authors and the empirical literature cited per entry. Evidence ratings:
//   strong       - replicated, out-of-sample, after costs, in crypto
//   moderate     - peer-reviewed support in crypto or a well-identified mechanism
//   weak         - mixed or mostly negative peer-reviewed evidence
//   practitioner - widely used, little or no peer-reviewed support
// No rule is trusted because it is listed here: the rules are CANDIDATES. The meta-model learns
// their weights walk-forward (ta / taconf feature groups) and research/taStudy.ts measures each
// rule's forward-return hit rate with a false-discovery-rate correction; the study result is what
// the dashboard shows next to each live signal.

import type { MacroInput, TfState } from './analyzer';

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
export type Category = 'trend' | 'volatility' | 'momentum' | 'volume' | 'microstructure' | 'structure' | 'macro' | 'onchain';
export type Evidence = 'strong' | 'moderate' | 'weak' | 'practitioner';

export interface KnowledgeEntry {
  id: string;
  name: string;
  category: Category;
  author?: string;
  formula: string;
  params: string;
  /** Timeframes the reference recommends. */
  bestTimeframes: Timeframe[] | string;
  /** What the bot computes it on (closed candles of the Coinbase spot USD pair). */
  botTimeframes: Timeframe[];
  states: Array<{ when: string; meaning: string; bias: 'bullish' | 'bearish' | 'neutral' | 'volatility' | 'context' }>;
  caveats: string[];
  evidence: { rating: Evidence; notes: string; sources: string[] };
  implemented: boolean;
}

const PDF = 'Operator reference: Quantitative Technical Analysis in Cryptocurrency Markets (PDF)';
const HU21 = 'Hudson & Urquhart (2021), Technical trading and cryptocurrencies, Annals of Operations Research: ~15,000 rules, significant predictability with multiple-testing controls';
const DETZEL = 'Detzel, Liu, Strauss, Zhou & Zhu (2021), Learning and predictability via technical analysis: evidence from bitcoin and stocks with hard-to-value fundamentals, Financial Management: price-to-MA ratios predict BTC returns out of sample';
const CORBET = 'Corbet, Eraslan, Lucey & Sensoy (2019), The effectiveness of technical trading rules in cryptocurrency markets, Finance Research Letters';
const GERRITSEN = 'Gerritsen, Bouri, Ramezanifar & Roubaud (2020), The profitability of technical trading rules in the Bitcoin market, Finance Research Letters: trading-range breakout rules profitable';
const BLL92 = 'Brock, Lakonishok & LeBaron (1992), Simple technical trading rules and the stochastic properties of stock returns, Journal of Finance';
const PARK_IRWIN = 'Park & Irwin (2007), What do we know about the profitability of technical analysis?, Journal of Economic Surveys: profits in older data, fading in recent decades; data snooping a major concern';
const STW99 = 'Sullivan, Timmermann & White (1999), Data-snooping, technical trading rule performance, and the bootstrap, Journal of Finance';
const BS12 = 'Bajgrowicz & Scaillet (2012), Technical trading revisited: false discoveries, persistence tests, and transaction costs, Journal of Financial Economics';
const OSLER03 = 'Osler (2003), Currency orders and exchange rate dynamics: an explanation for the predictive success of technical analysis, Journal of Finance: take-profits cluster at round numbers, stop-losses just beyond them';
const OSLER05 = 'Osler (2005), Stop-loss orders and price cascades in currency markets, Journal of International Money and Finance';
const BEO94 = "Blume, Easley & O'Hara (1994), Market statistics and technical analysis: the role of volume, Journal of Finance";
const LMW00 = 'Lo, Mamaysky & Wang (2000), Foundations of technical analysis, Journal of Finance: chart patterns carry incremental information';
const MYR06 = 'Marshall, Young & Rose (2006), Candlestick technical trading strategies: can they create value for investors?, Journal of Banking & Finance: no value in US equities';
const SUW22 = 'Shen, Urquhart & Wang (2022), Bitcoin intraday time series momentum, Financial Review';
const WILDER = 'Wilder (1978), New Concepts in Technical Trading Systems';

export const KNOWLEDGE: KnowledgeEntry[] = [
  // ---- 1. Trend overlays ----
  {
    id: 'moving_averages', name: 'Simple & exponential moving averages', category: 'trend', author: 'classical',
    formula: 'SMA_n = (1/n) sum P_i;  EMA_t = (P_t - EMA_{t-1}) x a + EMA_{t-1},  a = 2/(n+1)',
    params: 'EMA 12/21/26/50; SMA 50/200', bestTimeframes: 'SMA 50/100/200 on 1D/1W; EMA 12/21/26 on 1H/4H', botTimeframes: ['15m', '1h', '4h', '1d'],
    states: [
      { when: 'price > EMA21 > EMA50 (> SMA200)', meaning: 'Stacked uptrend: dips toward the fast EMA are bought.', bias: 'bullish' },
      { when: 'price < EMA21 < EMA50 (< SMA200)', meaning: 'Stacked downtrend: rallies into the fast EMA are sold.', bias: 'bearish' },
      { when: 'SMA50 crosses above SMA200 (golden cross)', meaning: 'Macro regime shift to bullish.', bias: 'bullish' },
      { when: 'SMA50 crosses below SMA200 (death cross)', meaning: 'Macro regime shift to bearish.', bias: 'bearish' },
      { when: 'price far above/below its MA (price-to-MA ratio)', meaning: 'Trend strength; extreme ratios also mean stretched.', bias: 'context' },
    ],
    caveats: ['Lagging by construction; whipsaws in ranges (check ADX).', 'Golden/death crosses are rare on the timeframes that matter for 15-minute contracts: context, not a trigger.'],
    evidence: { rating: 'moderate', notes: 'MA rules are the best-supported TA family in crypto.', sources: [HU21, DETZEL, CORBET, BLL92, PDF] },
    implemented: true,
  },
  {
    id: 'adx', name: 'Average Directional Index (+DI / -DI)', category: 'trend', author: 'J. Welles Wilder',
    formula: '+DM = H - H_prev, -DM = L_prev - L (the larger, if > 0); +DI = 100 RMA14(+DM)/RMA14(TR); DX = 100 |+DI - -DI| / (+DI + -DI); ADX = RMA14(DX)',
    params: '14', bestTimeframes: ['4h', '1d'], botTimeframes: ['15m', '1h', '4h'],
    states: [
      { when: 'ADX > 25 and rising, +DI > -DI', meaning: 'Strong, accelerating uptrend: counter-trend traders get trapped.', bias: 'bullish' },
      { when: 'ADX > 25 and rising, -DI > +DI', meaning: 'Strong, accelerating downtrend.', bias: 'bearish' },
      { when: 'ADX < 20', meaning: 'No trend: breakouts fail often, oscillator mean-reversion works better.', bias: 'context' },
    ],
    caveats: ['Non-directional: direction comes from the DIs.', 'Noisy below 1H.'],
    evidence: { rating: 'practitioner', notes: 'Used here as a regime filter (trend vs range) rather than a signal.', sources: [WILDER, PDF] },
    implemented: true,
  },
  {
    id: 'ichimoku', name: 'Ichimoku Kinko Hyo', category: 'trend', author: 'Goichi Hosoda',
    formula: 'Tenkan = (HH9+LL9)/2; Kijun = (HH26+LL26)/2; Span A = (Tenkan+Kijun)/2 shifted +26; Span B = (HH52+LL52)/2 shifted +26; Chikou = close shifted -26',
    params: '9 / 26 / 52, shift 26', bestTimeframes: ['1d', '4h'], botTimeframes: ['1h', '4h', '1d'],
    states: [
      { when: 'price above the cloud, Tenkan > Kijun, future cloud green', meaning: 'Bullish equilibrium: the cloud is a thick support floor.', bias: 'bullish' },
      { when: 'price below the cloud, Tenkan < Kijun, future cloud red', meaning: 'Bearish equilibrium: the cloud is resistance.', bias: 'bearish' },
      { when: 'Tenkan crosses Kijun on the cloud side of price', meaning: 'Momentum turning with the trend.', bias: 'context' },
      { when: 'thin cloud', meaning: 'Weak support/resistance: prone to rapid breaks.', bias: 'volatility' },
    ],
    caveats: ['The reference warns intraday (15m) Ichimoku gives excessive false signals: the bot only uses 1H and slower.'],
    evidence: { rating: 'practitioner', notes: 'Limited peer-reviewed testing.', sources: [PDF] },
    implemented: true,
  },
  // ---- 2. Volatility ----
  {
    id: 'bollinger', name: 'Bollinger Bands, %B, bandwidth and the squeeze', category: 'volatility', author: 'John Bollinger',
    formula: 'MB = SMA20; UB/LB = MB +/- 2 sigma20; %B = (P - LB)/(UB - LB); bandwidth = (UB - LB)/MB; squeeze = BB inside Keltner (EMA20 +/- 1.5 ATR10)',
    params: '20, 2; Keltner 20, 1.5 x ATR10', bestTimeframes: ['4h', '1d'], botTimeframes: ['5m', '15m', '1h', '4h'],
    states: [
      { when: '%B > 1 in a range (ADX < 20)', meaning: 'Statistically stretched above the mean: reversion likely.', bias: 'bearish' },
      { when: '%B < 0 in a range', meaning: 'Stretched below the mean: bounce likely.', bias: 'bullish' },
      { when: '%B > 1 with ADX > 25 (band walk)', meaning: 'In a strong trend price rides the band: not a sell signal.', bias: 'bullish' },
      { when: 'squeeze (bands inside Keltner / bandwidth at a low percentile)', meaning: 'Volatility compression: a violent expansion usually follows.', bias: 'volatility' },
      { when: 'squeeze releases', meaning: 'Expansion has begun in the direction of the break.', bias: 'context' },
    ],
    caveats: ['Micro timeframes give meaningless band breaches.', 'Squeezes predict volatility, not direction.'],
    evidence: { rating: 'weak', notes: 'Volatility clustering (the squeeze logic) is well established; band-touch reversion is mixed.', sources: [PDF, PARK_IRWIN] },
    implemented: true,
  },
  {
    id: 'atr', name: 'Average True Range', category: 'volatility', author: 'J. Welles Wilder',
    formula: 'TR = max(H - L, |H - C_prev|, |L - C_prev|); ATR = RMA14(TR)',
    params: '14', bestTimeframes: ['1h', '4h', '1d'], botTimeframes: ['1m', '5m', '15m', '1h', '4h', '1d'],
    states: [
      { when: 'ATR at a high percentile', meaning: 'Large swings: smaller size, wider stops (entry +/- 2 ATR).', bias: 'volatility' },
      { when: 'ATR at a low percentile', meaning: 'Compression: often precedes an explosive move.', bias: 'volatility' },
    ],
    caveats: ['No direction. The bot uses ATR to normalise every distance (FVGs, round numbers, VWAP).'],
    evidence: { rating: 'moderate', notes: 'Volatility persistence is one of the most robust facts in finance.', sources: [WILDER, PDF] },
    implemented: true,
  },
  // ---- 3. Momentum ----
  {
    id: 'rsi', name: 'Relative Strength Index', category: 'momentum', author: 'J. Welles Wilder',
    formula: 'RSI = 100 - 100/(1 + RS), RS = RMA14(gains)/RMA14(losses)',
    params: '14; levels 30/50/70', bestTimeframes: '15m day trading, 4H swing, 1D macro', botTimeframes: ['5m', '15m', '1h', '4h'],
    states: [
      { when: 'RSI > 70', meaning: 'Overbought: reversal or consolidation risk (can stay embedded in FOMO trends).', bias: 'bearish' },
      { when: 'RSI < 30', meaning: 'Oversold: bounce potential.', bias: 'bullish' },
      { when: 'price higher high, RSI lower high (bearish divergence)', meaning: 'Buyers exhausted: reversal highly probable per the reference.', bias: 'bearish' },
      { when: 'price lower low, RSI higher low (bullish divergence)', meaning: 'Selling velocity exhausted.', bias: 'bullish' },
      { when: 'hidden divergence (price HL, RSI LL)', meaning: 'Trend continuation after a pullback.', bias: 'context' },
      { when: 'RSI crosses 50', meaning: 'Momentum regime flips.', bias: 'context' },
    ],
    caveats: ['Overbought/oversold fades lose in trends: the bot damps them when ADX > 25.'],
    evidence: { rating: 'weak', notes: 'Oscillator rules have mixed evidence; divergence is practitioner lore.', sources: [WILDER, PARK_IRWIN, PDF] },
    implemented: true,
  },
  {
    id: 'macd', name: 'MACD', category: 'momentum', author: 'Gerald Appel',
    formula: 'MACD = EMA12 - EMA26; signal = EMA9(MACD); histogram = MACD - signal',
    params: '12 / 26 / 9', bestTimeframes: ['4h', '1d'], botTimeframes: ['15m', '1h', '4h'],
    states: [
      { when: 'MACD crosses above signal (stronger below zero)', meaning: 'Bullish momentum shift.', bias: 'bullish' },
      { when: 'MACD crosses below signal (stronger above zero)', meaning: 'Bearish momentum shift.', bias: 'bearish' },
      { when: 'negative histogram shrinking', meaning: 'Bearish momentum decelerating: often precedes a bullish cross.', bias: 'bullish' },
      { when: 'positive histogram shrinking', meaning: 'Bullish momentum decelerating.', bias: 'bearish' },
      { when: 'histogram divergence vs price', meaning: 'Momentum fading against the price extreme.', bias: 'context' },
    ],
    caveats: ['Whipsaws below 1H per the reference; 15m is included only as a confluence member.'],
    evidence: { rating: 'weak', notes: 'MACD is an EMA-difference rule; the MA-rule evidence partly carries over.', sources: [PDF, HU21] },
    implemented: true,
  },
  {
    id: 'stochastic', name: 'Stochastic oscillator & Williams %R', category: 'momentum', author: 'George Lane; Larry Williams',
    formula: '%K = 100 (C - LL14)/(HH14 - LL14); %D = SMA3(%K); %R = -100 (HH14 - C)/(HH14 - LL14)',
    params: '14, 3; levels 20/80 and -80/-20', bestTimeframes: ['15m', '1h'], botTimeframes: ['5m', '15m', '1h'],
    states: [
      { when: '%K crosses above %D below 20', meaning: 'Buy signal in a range.', bias: 'bullish' },
      { when: '%K crosses below %D above 80', meaning: 'Sell signal in a range.', bias: 'bearish' },
      { when: '%R < -80 / > -20', meaning: 'Oversold / overbought.', bias: 'context' },
    ],
    caveats: ['Precise in ranges, pinned at extremes in trends: used only with ADX < 20.'],
    evidence: { rating: 'weak', notes: '', sources: [PDF, PARK_IRWIN] },
    implemented: true,
  },
  // ---- 4. Volume and money flow ----
  {
    id: 'obv', name: 'On-Balance Volume', category: 'volume', author: 'Joe Granville',
    formula: 'OBV += V if close up, -= V if close down',
    params: 'slope over 20 bars / (20 x avg volume)', bestTimeframes: ['1d', '1h'], botTimeframes: ['1h', '4h'],
    states: [
      { when: 'OBV rising while price is flat', meaning: 'Quiet accumulation: upside resolution probable.', bias: 'bullish' },
      { when: 'new price high without a new OBV high', meaning: 'Rally lacks demand: bull-trap warning.', bias: 'bearish' },
    ],
    caveats: ['The reference notes intraday OBV is distorted by market-maker volume; single-venue (Coinbase) volume is a sample of the market.'],
    evidence: { rating: 'practitioner', notes: 'Volume does carry information about price moves.', sources: [BEO94, PDF] },
    implemented: true,
  },
  {
    id: 'money_flow', name: 'Chaikin Money Flow & Money Flow Index', category: 'volume', author: 'Marc Chaikin; Gene Quong & Avrum Soudack',
    formula: 'CMF = sum20(((C-L)-(H-C))/(H-L) x V) / sum20(V);  MFI = 100 - 100/(1 + pos14(TP x V)/neg14(TP x V))',
    params: 'CMF 20, MFI 14', bestTimeframes: ['4h', '1d'], botTimeframes: ['15m', '1h', '4h'],
    states: [
      { when: 'CMF > 0 sustained', meaning: 'Closing in the upper half of ranges on volume: accumulation.', bias: 'bullish' },
      { when: 'CMF < 0 sustained', meaning: 'Distribution.', bias: 'bearish' },
      { when: 'MFI > 80 / < 20', meaning: 'Volume-weighted overbought / oversold.', bias: 'context' },
      { when: 'price rising while MFI falls', meaning: 'Volume behind the rally deteriorating: top risk.', bias: 'bearish' },
    ],
    caveats: [],
    evidence: { rating: 'practitioner', notes: '', sources: [BEO94, PDF] },
    implemented: true,
  },
  // ---- 5. Microstructure / order flow ----
  {
    id: 'volume_profile', name: 'Volume profile (POC, value area, HVN/LVN, 80% rule)', category: 'microstructure', author: 'Market Profile (Steidlmayer)',
    formula: 'Volume per price bin; POC = max bin; value area = bins grown from the POC to 70% of volume (VAL..VAH); node = bin volume / mean bin',
    params: '96 bars, 40 bins, 70%', bestTimeframes: 'FRVP intraday (15m, 1H), VPVR daily', botTimeframes: ['15m', '1h'],
    states: [
      { when: 'price near a high-volume node / the POC', meaning: 'Fair-value magnet: price gravitates to it.', bias: 'context' },
      { when: 'price inside a low-volume node', meaning: 'Liquidity vacuum: price slices through fast.', bias: 'volatility' },
      { when: 'opened outside the value area, two closes back inside', meaning: '80% rule: rotation to the opposite edge of value is likely.', bias: 'context' },
      { when: 'accepted above VAH / below VAL', meaning: 'Value migrating: breakout acceptance.', bias: 'context' },
    ],
    caveats: ['The "80%" is practitioner folklore: the bot measures its actual hit rate.', 'Built from one venue\'s candles, spreading each candle\'s volume over its range (an approximation of tick-level profiles).'],
    evidence: { rating: 'practitioner', notes: '', sources: [PDF] },
    implemented: true,
  },
  {
    id: 'vwap', name: 'VWAP (session / anchored)', category: 'microstructure',
    formula: 'VWAP = sum(TP x V)/sum(V), TP = (H+L+C)/3, reset at 00:00 UTC',
    params: 'session = UTC day', bestTimeframes: 'intraday session VWAP; anchored on 1D', botTimeframes: ['5m', '15m', '1h'],
    states: [
      { when: 'price above VWAP', meaning: 'Intraday buyers in control; VWAP is support.', bias: 'bullish' },
      { when: 'price below VWAP', meaning: 'Sellers in control; VWAP is resistance.', bias: 'bearish' },
    ],
    caveats: ['Crypto trades 24/7: the "session" is a convention (UTC day).'],
    evidence: { rating: 'practitioner', notes: 'The institutional execution benchmark; its S/R role is practitioner knowledge.', sources: [PDF] },
    implemented: true,
  },
  // ---- 6. Structure / smart money ----
  {
    id: 'market_structure', name: 'Market structure: swings, BOS, CHoCH', category: 'structure', author: 'Dow theory / SMC',
    formula: 'Fractal swings (3 bars each side, confirmed); HH+HL = up, LH+LL = down; BOS = close through the last swing with the trend; CHoCH = against it',
    params: 'fractal 3/3', bestTimeframes: 'Daily levels, 15m confirmation', botTimeframes: ['5m', '15m', '1h', '4h'],
    states: [
      { when: 'higher highs and higher lows', meaning: 'Uptrend structure.', bias: 'bullish' },
      { when: 'break of structure with the trend', meaning: 'Continuation.', bias: 'context' },
      { when: 'change of character (first break against the trend)', meaning: 'Reversal confirmation after a sweep.', bias: 'context' },
    ],
    caveats: ['Swings are confirmed 3 bars late by design (no look-ahead).'],
    evidence: { rating: 'practitioner', notes: 'Chart patterns do carry some information.', sources: [LMW00, PDF] },
    implemented: true,
  },
  {
    id: 'liquidity', name: 'Liquidity sweeps, true breakouts, equal highs/lows, fair value gaps', category: 'structure', author: 'SMC / ICT',
    formula: 'Sweep: wick through the prior swing, close back inside, wick >= 50% of range. True breakout: body >= 60% of range closing beyond the swing on >= 1.5x average volume. FVG: bar(i-2).high < bar(i).low (bullish), unfilled.',
    params: 'last 3 bars; volume x1.5; equal levels within 0.15 ATR', bestTimeframes: 'Daily levels, 15m execution', botTimeframes: ['15m', '1h', '4h'],
    states: [
      { when: 'sweep of lows then close back above', meaning: 'Stops harvested; institutions filled: violent reversal up.', bias: 'bullish' },
      { when: 'sweep of highs then close back below', meaning: 'Bull stops/breakout buyers trapped: reversal down.', bias: 'bearish' },
      { when: 'true breakout (solid body, volume)', meaning: 'Genuine range expansion: continuation.', bias: 'context' },
      { when: 'equal highs/lows', meaning: 'Resting stop liquidity: a sweep target.', bias: 'context' },
      { when: 'price retesting an unfilled FVG', meaning: 'Imbalance zone: entry on the pullback.', bias: 'context' },
    ],
    caveats: ['The sweep mechanism (stop clusters beyond obvious levels cascade) is documented in FX order books; the full SMC playbook is not peer-reviewed.'],
    evidence: { rating: 'practitioner', notes: 'Mechanism supported by stop-loss clustering research.', sources: [OSLER03, OSLER05, PDF] },
    implemented: true,
  },
  {
    id: 'breakout', name: 'Trading-range (Donchian) breakout', category: 'structure', author: 'Donchian / Brock et al.',
    formula: 'close > highest high (or < lowest low) of the prior 20 bars',
    params: '20', bestTimeframes: ['1h', '4h', '1d'], botTimeframes: ['15m', '1h', '4h'],
    states: [{ when: 'close beyond the 20-bar range', meaning: 'Breakout: trend continuation in that direction.', bias: 'context' }],
    caveats: ['Many breakouts fail (see sweeps): confirm with volume / true-breakout body.'],
    evidence: { rating: 'moderate', notes: 'TRB rules are among the few with crypto support.', sources: [GERRITSEN, BLL92, HU21] },
    implemented: true,
  },
  {
    id: 'divergence', name: 'Divergences (RSI, MACD histogram, OBV, MFI)', category: 'momentum',
    formula: 'Last two confirmed swing lows (highs): price LL (HH) while the oscillator makes HL (LH) = regular; price HL (LH) while the oscillator makes LL (HH) = hidden',
    params: 'swings within 10 bars', bestTimeframes: ['1h', '4h'], botTimeframes: ['15m', '1h', '4h'],
    states: [
      { when: 'regular bullish divergence', meaning: 'Downside momentum exhausted.', bias: 'bullish' },
      { when: 'regular bearish divergence', meaning: 'Upside momentum exhausted.', bias: 'bearish' },
      { when: 'hidden divergence', meaning: 'Pullback within a trend likely to resume.', bias: 'context' },
    ],
    caveats: ['Divergences can persist; the reference uses them as one leg of a confluence, never alone.'],
    evidence: { rating: 'practitioner', notes: '', sources: [PDF] },
    implemented: true,
  },
  {
    id: 'candles', name: 'Candlestick patterns (engulfing, doji, pin bar)', category: 'structure',
    formula: 'Engulfing: body engulfs the prior opposite body; doji: body <= 10% of range; pin bar: wick >= 2x body and >= 60% of range',
    params: '', bestTimeframes: 'at key levels', botTimeframes: ['15m', '1h', '4h'],
    states: [
      { when: 'bullish engulfing / hammer at support', meaning: 'Buyers reclaimed control.', bias: 'bullish' },
      { when: 'bearish engulfing / shooting star at resistance', meaning: 'Sellers reclaimed control.', bias: 'bearish' },
      { when: 'doji', meaning: 'Indecision / momentum exhaustion.', bias: 'context' },
    ],
    caveats: ['Stand-alone candlestick rules have tested poorly: kept only as confluence context.'],
    evidence: { rating: 'weak', notes: '', sources: [MYR06, PDF] },
    implemented: true,
  },
  {
    id: 'round_numbers', name: 'Round-number levels', category: 'microstructure', author: 'Osler',
    formula: 'Nearest multiple of 10^(floor(log10 P) - 1): $1,000 for BTC, $100 for ETH, $10 for SOL',
    params: '', bestTimeframes: 'all', botTimeframes: ['15m', '1h'],
    states: [
      { when: 'price just crossed a round number', meaning: 'Stops clustered just beyond it trigger: the move accelerates.', bias: 'context' },
      { when: 'price approaching a round number', meaning: 'Take-profit orders cluster at it: stall/reversal risk.', bias: 'context' },
    ],
    caveats: [],
    evidence: { rating: 'moderate', notes: 'Documented in FX dealer order books.', sources: [OSLER03, OSLER05] },
    implemented: true,
  },
  {
    id: 'intraday_momentum', name: 'Intraday time-series momentum', category: 'momentum',
    formula: 'Sign of the early-session return predicts the late-session return',
    params: '', bestTimeframes: 'intraday', botTimeframes: ['15m', '1h'],
    states: [{ when: 'strong early-session move', meaning: 'Tends to continue into the session close.', bias: 'context' }],
    caveats: ['Captured by the existing ret_* features and the momentum_state rule.'],
    evidence: { rating: 'moderate', notes: '', sources: [SUW22] },
    implemented: true,
  },
  // ---- 7. On-chain (documented, not tradable at 15m/1h) ----
  {
    id: 'mvrv_z', name: 'MVRV Z-score', category: 'onchain',
    formula: 'Z = (market value - realized value) / sigma(market value)', params: 'thresholds +7 (tops), < 0.1 (bottoms)',
    bestTimeframes: 'weekly / monthly', botTimeframes: [],
    states: [{ when: 'Z > 7', meaning: 'Euphoric cycle top.', bias: 'bearish' }, { when: 'Z < 0.1', meaning: 'Capitulation bottom.', bias: 'bullish' }],
    caveats: ['Cycle-scale (months): no information at a 15-minute or 1-hour horizon; needs an on-chain data provider.'],
    evidence: { rating: 'practitioner', notes: 'Few cycles of history.', sources: [PDF] }, implemented: false,
  },
  {
    id: 'nvt', name: 'NVT ratio / signal', category: 'onchain',
    formula: 'NVT = market cap / daily on-chain USD volume; signal uses a 90-day MA of volume', params: '> 150 = overvalued',
    bestTimeframes: ['1d'], botTimeframes: [],
    states: [{ when: 'NVT high', meaning: 'Price outpacing on-chain utility.', bias: 'bearish' }, { when: 'NVT low', meaning: 'Undervalued vs usage.', bias: 'bullish' }],
    caveats: ['Daily/weekly valuation metric; not used for intraday contracts.'],
    evidence: { rating: 'practitioner', notes: '', sources: [PDF] }, implemented: false,
  },
  {
    id: 'chart_patterns', name: 'Classic chart patterns (double top/bottom, head and shoulders, flags, triangles, trendline retests)', category: 'structure', author: 'Edwards & Magee; Bulkowski',
    formula: 'From confirmed swings: double top = two highs within 0.5 ATR, close through the trough between; H&S = head 0.5 ATR above shoulders within 1 ATR, close through the neckline; flag = >= 4 ATR impulse in <= 10 bars, 4-15 bar pause inside half of it, close out of the pause with the impulse; triangle = converging swing lines, close out of them; trendline retest = broken swing trendline revisited and rejected',
    params: 'swings 3/3; ATR 14; signals live for 3 bars after completion', bestTimeframes: ['1h', '4h', '1d'], botTimeframes: ['15m', '1h', '4h', '1d'],
    states: [
      { when: 'double bottom / inverse H&S completes', meaning: 'Selling exhausted at a tested low: reversal up.', bias: 'bullish' },
      { when: 'double top / H&S completes', meaning: 'Buying exhausted at a tested high: reversal down.', bias: 'bearish' },
      { when: 'flag or triangle breaks with the prior move', meaning: 'Pause resolved in the trend direction: continuation.', bias: 'context' },
      { when: 'broken trendline retested and rejected', meaning: 'Old support became resistance (or the reverse): the break is confirmed.', bias: 'context' },
    ],
    caveats: ['Pattern definitions are a judgement call; these are fixed and mechanical so they can be backtested, and only those that pass the walk-forward rule study (research/ruleBook.ts) count.'],
    evidence: { rating: 'moderate', notes: 'Kernel-smoothed pattern detection carries incremental information (Lo, Mamaysky & Wang); crypto results vary by period.', sources: [LMW00, PDF] },
    implemented: true,
  },
  {
    id: 'rsi_regime', name: 'RSI regime rules: Cardwell range shift, Connors RSI(2) pullbacks', category: 'momentum', author: 'Andrew Cardwell; Larry Connors',
    formula: 'Range shift: over 60 bars RSI holds >= 38 and reaches >= 68 (bull range) or holds <= 62 and reaches <= 32 (bear range). RSI(2): price above its 200-bar average and RSI(2) < 10 = buy the dip; below it and RSI(2) > 90 = sell the rip.',
    params: 'RSI 14 / 60 bars; RSI 2 with SMA 200', bestTimeframes: ['1h', '4h', '1d'], botTimeframes: ['1h', '4h', '1d'],
    states: [
      { when: 'bull range (RSI 40-80)', meaning: 'Uptrend momentum regime: oversold is ~40, not 30.', bias: 'bullish' },
      { when: 'bear range (RSI 20-60)', meaning: 'Downtrend momentum regime: overbought is ~60, not 70.', bias: 'bearish' },
      { when: 'RSI(2) extreme against the 200-bar trend', meaning: 'Short-term pullback inside the trend: mean-reverts in the trend direction.', bias: 'context' },
    ],
    caveats: ['RSI(2) was documented on equity indices; crypto trends harder, so it only counts where the rule study shows it holds.'],
    evidence: { rating: 'practitioner', notes: 'Widely used; tested here walk-forward by character.', sources: [WILDER, PDF] },
    implemented: true,
  },
  {
    id: 'breadth', name: 'Market breadth (coins above their 20 / 50-day averages, new highs vs lows)', category: 'macro',
    formula: 'Share of tracked coins whose daily close is above their 20- and 50-day SMA; (new 20-day highs - new 20-day lows) / coins',
    params: '20 / 50 days', bestTimeframes: ['1d'], botTimeframes: ['1d'],
    states: [
      { when: '>= 70 % above the 50-day and >= 60 % above the 20-day', meaning: 'Broad participation: trend is healthy.', bias: 'bullish' },
      { when: '<= 30 % above the 50-day and <= 40 % above the 20-day', meaning: 'Broad weakness: rallies are suspect.', bias: 'bearish' },
      { when: 'new highs outnumber new lows by 40 %+', meaning: 'Breadth thrust.', bias: 'bullish' },
    ],
    caveats: ['Crypto has few liquid coins and they are highly correlated, so breadth is closer to a market-trend gauge than in equities.'],
    evidence: { rating: 'practitioner', notes: 'Equity-market breadth adapted; tested by the rule study.', sources: [PDF] },
    implemented: true,
  },
  {
    id: 'macro_risk', name: 'Traditional risk gauges: DXY, US 10-year yield, VIX, high-yield bonds', category: 'macro',
    formula: '5-day log changes (TradingView daily bars); risk-on = dollar down, VIX down, HYG up, yields down (each vote beyond a dead band)',
    params: '5 days; dead band 0.5 % (VIX 5 %)', bestTimeframes: ['1d'], botTimeframes: ['1d'],
    states: [
      { when: '>= 3 of 4 gauges risk-on', meaning: 'Liquidity tailwind for crypto.', bias: 'bullish' },
      { when: '>= 3 of 4 gauges risk-off', meaning: 'Dollar / volatility headwind.', bias: 'bearish' },
    ],
    caveats: ['Daily data, refreshed by the training pipeline (no live feed): context for daily decisions, not for 15-minute contracts.'],
    evidence: { rating: 'moderate', notes: 'Crypto co-moves with global risk appetite since 2020.', sources: [PDF] },
    implemented: true,
  },
  // ---- 9. Cross-asset macro ----
  {
    id: 'dominance_matrix', name: 'BTC.D x USDT.D liquidity rotation matrix', category: 'macro',
    formula: 'BTC.D = BTC mcap / total; USDT.D = USDT mcap / total (the bot tracks both live)',
    params: 'recent change, sigma-scaled; |z| > 0.5 counts as rising/falling', bestTimeframes: ['1h', '4h', '1d'], botTimeframes: ['1h'],
    states: [
      { when: 'USDT.D up + BTC.D up', meaning: 'Severe risk-off: everything sold, alts worst.', bias: 'bearish' },
      { when: 'USDT.D down + BTC.D up', meaning: 'Risk-on for Bitcoin; alts stagnate.', bias: 'context' },
      { when: 'USDT.D down + BTC.D down', meaning: 'Altseason: capital cascades into alts.', bias: 'bullish' },
      { when: 'USDT.D up + BTC.D down', meaning: 'Macro distribution out of BTC into cash.', bias: 'bearish' },
    ],
    caveats: ['Spot-ETF flows now move BTC.D independently of alt rotation.', 'The bot\'s dominance series is a live proxy (Binance prices anchored to CoinGecko caps).'],
    evidence: { rating: 'practitioner', notes: '', sources: [PDF] },
    implemented: true,
  },
  // ---- Method ----
  {
    id: 'data_snooping', name: 'Validation discipline (why nothing here is trusted untested)', category: 'macro',
    formula: 'Every rule x timeframe x horizon is a hypothesis; forward-return hit rates are tested with a bootstrap and a Benjamini-Hochberg false-discovery-rate cut',
    params: 'FDR 10%', bestTimeframes: 'n/a', botTimeframes: [],
    states: [{ when: 'a rule survives the FDR cut out of sample', meaning: 'Its measured edge is shown next to the live signal and the model may weight it.', bias: 'context' }],
    caveats: ['Transaction costs and the contract payoff, not raw hit rate, decide tradability: the meta-model makes that call.'],
    evidence: { rating: 'strong', notes: 'Searching many rules without correction manufactures false edges.', sources: [STW99, BS12, PARK_IRWIN] },
    implemented: true,
  },
];

// ---- Rules: live, evaluable states of the indicators above ----------------------------------

export interface RuleDef {
  id: string;
  /** KNOWLEDGE entry id. */
  indicator: string;
  timeframes: Timeframe[];
  kind: 'trend' | 'reversal' | 'continuation' | 'volatility' | 'regime';
  bullish: string;
  bearish: string;
  neutral?: string;
  evaluate: (s: TfState, all: Partial<Record<Timeframe, TfState>>, macro?: MacroInput) => { dir: -1 | 0 | 1; strength: number } | undefined;
}

const f = Number.isFinite;
const sgn = (x: number): -1 | 0 | 1 => (x > 0 ? 1 : x < 0 ? -1 : 0);
const on = (dir: -1 | 0 | 1, strength: number) => (dir !== 0 || strength > 0 ? { dir, strength } : undefined);
const ranging = (s: TfState) => f(s.adx) && s.adx < 20;
const trending = (s: TfState) => f(s.adx) && s.adx > 25;

export const RULES: RuleDef[] = [
  // Trend
  { id: 'ema_stack', indicator: 'moving_averages', timeframes: ['15m', '1h', '4h'], kind: 'trend',
    bullish: 'Price > EMA21 > EMA50: stacked uptrend.', bearish: 'Price < EMA21 < EMA50: stacked downtrend.',
    evaluate: (s) => {
      if (!f(s.ema50)) return undefined;
      const up = s.close > s.ema21 && s.ema21 > s.ema50, dn = s.close < s.ema21 && s.ema21 < s.ema50;
      const bonus = f(s.sma200) ? ((up && s.ema50 > s.sma200) || (dn && s.ema50 < s.sma200) ? 1 : 0.6) : 0.8;
      return up ? on(1, bonus) : dn ? on(-1, bonus) : undefined;
    } },
  { id: 'ma_regime', indicator: 'moving_averages', timeframes: ['4h', '1d'], kind: 'regime',
    bullish: 'Price above the 200-period SMA: long-term uptrend regime.', bearish: 'Price below the 200-period SMA: long-term downtrend regime.',
    evaluate: (s) => (f(s.sma200) ? on(sgn(s.close - s.sma200), Math.min(1, Math.abs(s.close - s.sma200) / (3 * s.atr))) : undefined) },
  { id: 'golden_death_cross', indicator: 'moving_averages', timeframes: ['1h', '4h', '1d'], kind: 'trend',
    bullish: 'Golden cross: SMA50 crossed above SMA200.', bearish: 'Death cross: SMA50 crossed below SMA200.',
    evaluate: (s) => {
      const d = s.sma50 - s.sma200;
      if (!f(d) || !f(s.smaDiffPrev)) return undefined;
      return s.smaDiffPrev <= 0 && d > 0 ? on(1, 1) : s.smaDiffPrev >= 0 && d < 0 ? on(-1, 1) : undefined;
    } },
  { id: 'price_to_ma', indicator: 'moving_averages', timeframes: ['1h', '4h', '1d'], kind: 'trend',
    bullish: 'Price above its 50-period MA (price-to-MA ratio > 1): trend support (Detzel et al.).', bearish: 'Price below its 50-period MA.',
    evaluate: (s) => (f(s.sma50) && s.atr > 0 ? on(sgn(s.close - s.sma50), Math.min(1, Math.abs(s.close - s.sma50) / (2 * s.atr))) : undefined) },
  { id: 'adx_trend', indicator: 'adx', timeframes: ['15m', '1h', '4h'], kind: 'trend',
    bullish: 'ADX > 25 and rising with +DI > -DI: strong uptrend.', bearish: 'ADX > 25 and rising with -DI > +DI: strong downtrend.',
    evaluate: (s) => (trending(s) && s.adx > s.adxPrev ? on(sgn(s.plusDI - s.minusDI), Math.min(1, (s.adx - 25) / 20 + 0.3)) : undefined) },
  { id: 'adx_range', indicator: 'adx', timeframes: ['15m', '1h', '4h'], kind: 'regime',
    bullish: '', bearish: '', neutral: 'ADX < 20: no trend; favour mean reversion, distrust breakouts.',
    evaluate: (s) => (ranging(s) ? on(0, Math.min(1, (20 - s.adx) / 10 + 0.3)) : undefined) },
  { id: 'ichimoku_cloud', indicator: 'ichimoku', timeframes: ['1h', '4h', '1d'], kind: 'trend',
    bullish: 'Above the Ichimoku cloud with Tenkan > Kijun: bullish equilibrium.', bearish: 'Below the cloud with Tenkan < Kijun: bearish equilibrium.',
    evaluate: (s) => {
      const c = s.cloud;
      if (!c) return undefined;
      if (c.above) return on(1, (c.tenkanAboveKijun ? 0.6 : 0.3) + (c.futureBull ? 0.4 : 0));
      if (c.below) return on(-1, (!c.tenkanAboveKijun ? 0.6 : 0.3) + (!c.futureBull ? 0.4 : 0));
      return undefined;
    } },
  { id: 'ichimoku_tk_cross', indicator: 'ichimoku', timeframes: ['1h', '4h'], kind: 'continuation',
    bullish: 'Tenkan crossed above Kijun above the cloud.', bearish: 'Tenkan crossed below Kijun below the cloud.',
    evaluate: (s) => (s.cloud && ((s.cloud.tkCross > 0 && s.cloud.above) || (s.cloud.tkCross < 0 && s.cloud.below)) ? on(s.cloud.tkCross, 1) : undefined) },
  // Volatility
  { id: 'bb_reversion', indicator: 'bollinger', timeframes: ['5m', '15m', '1h'], kind: 'reversal',
    bullish: 'Below the lower Bollinger band in a range: stretched, bounce likely.', bearish: 'Above the upper band in a range: stretched, reversion likely.',
    evaluate: (s) => (ranging(s) && f(s.bbPctB) ? (s.bbPctB < 0 ? on(1, Math.min(1, 0.5 - s.bbPctB)) : s.bbPctB > 1 ? on(-1, Math.min(1, s.bbPctB - 0.5)) : undefined) : undefined) },
  { id: 'bb_band_walk', indicator: 'bollinger', timeframes: ['15m', '1h', '4h'], kind: 'continuation',
    bullish: 'Walking the upper band in a strong trend: momentum, not a sell.', bearish: 'Walking the lower band in a strong downtrend.',
    evaluate: (s) => (trending(s) && f(s.bbPctB) ? (s.bbPctB > 1 && s.plusDI > s.minusDI ? on(1, 0.7) : s.bbPctB < 0 && s.minusDI > s.plusDI ? on(-1, 0.7) : undefined) : undefined) },
  { id: 'squeeze', indicator: 'bollinger', timeframes: ['15m', '1h', '4h'], kind: 'volatility',
    bullish: '', bearish: '', neutral: 'Bollinger squeeze: volatility compressed, an expansion is due (direction unknown).',
    evaluate: (s) => (s.squeeze || (f(s.bbBandwidthRank) && s.bbBandwidthRank <= 0.1) ? on(0, s.squeeze ? 1 : 0.6) : undefined) },
  { id: 'squeeze_release', indicator: 'bollinger', timeframes: ['15m', '1h', '4h'], kind: 'continuation',
    bullish: 'Squeeze released upward: expansion has begun to the upside.', bearish: 'Squeeze released downward.',
    evaluate: (s) => (s.squeezePrev && !s.squeeze && f(s.chgAtr) ? on(sgn(s.macdHist || s.chgAtr), 1) : undefined) },
  { id: 'atr_regime', indicator: 'atr', timeframes: ['15m', '1h'], kind: 'volatility',
    bullish: '', bearish: '', neutral: 'ATR at an extreme percentile: volatility regime change (size and stops adapt).',
    evaluate: (s) => (f(s.atrRank) && (s.atrRank >= 0.9 || s.atrRank <= 0.1) ? on(0, Math.abs(s.atrRank - 0.5) * 2) : undefined) },
  // Momentum
  { id: 'rsi_extreme', indicator: 'rsi', timeframes: ['5m', '15m', '1h', '4h'], kind: 'reversal',
    bullish: 'RSI < 30: oversold.', bearish: 'RSI > 70: overbought.',
    evaluate: (s) => {
      if (!f(s.rsi)) return undefined;
      const damp = trending(s) ? 0.3 : 1; // embedded in trends (FOMO)
      return s.rsi < 30 ? on(1, damp * Math.min(1, (30 - s.rsi) / 15 + 0.3)) : s.rsi > 70 ? on(-1, damp * Math.min(1, (s.rsi - 70) / 15 + 0.3)) : undefined;
    } },
  { id: 'rsi_divergence', indicator: 'divergence', timeframes: ['15m', '1h', '4h'], kind: 'reversal',
    bullish: 'Bullish RSI divergence: price lower low, RSI higher low (selling exhausted).', bearish: 'Bearish RSI divergence: price higher high, RSI lower high (buying exhausted).',
    evaluate: (s) => (s.divRsi.regular ? on(s.divRsi.regular, 1) : undefined) },
  { id: 'rsi_hidden_divergence', indicator: 'divergence', timeframes: ['1h', '4h'], kind: 'continuation',
    bullish: 'Hidden bullish RSI divergence: uptrend pullback likely to resume.', bearish: 'Hidden bearish RSI divergence: downtrend likely to resume.',
    evaluate: (s) => (s.divRsi.hidden ? on(s.divRsi.hidden, 0.6) : undefined) },
  { id: 'momentum_state', indicator: 'rsi', timeframes: ['15m', '1h', '4h'], kind: 'trend',
    bullish: 'RSI > 50 and MACD histogram > 0: bullish momentum regime.', bearish: 'RSI < 50 and MACD histogram < 0: bearish momentum regime.',
    evaluate: (s) => (f(s.rsi) && f(s.macdHist) ? (s.rsi > 50 && s.macdHist > 0 ? on(1, Math.min(1, 0.4 + (s.rsi - 50) / 40)) : s.rsi < 50 && s.macdHist < 0 ? on(-1, Math.min(1, 0.4 + (50 - s.rsi) / 40)) : undefined) : undefined) },
  { id: 'macd_cross', indicator: 'macd', timeframes: ['15m', '1h', '4h'], kind: 'reversal',
    bullish: 'MACD crossed above its signal line (strongest below zero).', bearish: 'MACD crossed below its signal line (strongest above zero).',
    evaluate: (s) => (s.macdCross ? on(s.macdCross, (s.macdCross > 0 && s.macdLine < 0) || (s.macdCross < 0 && s.macdLine > 0) ? 1 : 0.6) : undefined) },
  { id: 'macd_hist_shift', indicator: 'macd', timeframes: ['15m', '1h', '4h'], kind: 'reversal',
    bullish: 'Negative MACD histogram shrinking: bearish momentum decelerating.', bearish: 'Positive MACD histogram shrinking: bullish momentum decelerating.',
    evaluate: (s) => (f(s.macdHist) && f(s.macdHistPrev) ? (s.macdHist < 0 && s.macdHist > s.macdHistPrev ? on(1, 0.5) : s.macdHist > 0 && s.macdHist < s.macdHistPrev ? on(-1, 0.5) : undefined) : undefined) },
  { id: 'macd_divergence', indicator: 'divergence', timeframes: ['1h', '4h'], kind: 'reversal',
    bullish: 'Bullish MACD-histogram divergence.', bearish: 'Bearish MACD-histogram divergence.',
    evaluate: (s) => (s.divMacd.regular ? on(s.divMacd.regular, 0.8) : undefined) },
  { id: 'stoch_cross_extreme', indicator: 'stochastic', timeframes: ['5m', '15m', '1h'], kind: 'reversal',
    bullish: 'Stochastic %K crossed above %D below 20.', bearish: 'Stochastic %K crossed below %D above 80.',
    evaluate: (s) => (s.stochCross > 0 && s.stochK < 25 ? on(1, ranging(s) ? 1 : 0.4) : s.stochCross < 0 && s.stochK > 75 ? on(-1, ranging(s) ? 1 : 0.4) : undefined) },
  { id: 'williams_extreme', indicator: 'stochastic', timeframes: ['5m', '15m', '1h'], kind: 'reversal',
    bullish: 'Williams %R below -80: oversold.', bearish: 'Williams %R above -20: overbought.',
    evaluate: (s) => (!f(s.willR) ? undefined : s.willR < -80 ? on(1, ranging(s) ? 0.6 : 0.25) : s.willR > -20 ? on(-1, ranging(s) ? 0.6 : 0.25) : undefined) },
  // Volume
  { id: 'obv_trend', indicator: 'obv', timeframes: ['1h', '4h'], kind: 'trend',
    bullish: 'OBV rising: volume flowing in (accumulation if price is flat).', bearish: 'OBV falling: distribution.',
    evaluate: (s) => (f(s.obvSlope) && Math.abs(s.obvSlope) > 0.1 ? on(sgn(s.obvSlope), Math.min(1, Math.abs(s.obvSlope) / 0.5) * (f(s.chg20Atr) && Math.abs(s.chg20Atr) < 1 ? 1 : 0.6)) : undefined) },
  { id: 'obv_divergence', indicator: 'divergence', timeframes: ['1h', '4h'], kind: 'reversal',
    bullish: 'Price lower low without an OBV lower low: hidden demand.', bearish: 'Price higher high without an OBV higher high: rally lacks demand (bull trap).',
    evaluate: (s) => (s.divObv.regular ? on(s.divObv.regular, 0.8) : undefined) },
  { id: 'cmf_flow', indicator: 'money_flow', timeframes: ['15m', '1h', '4h'], kind: 'trend',
    bullish: 'Chaikin money flow > 0.1: accumulation.', bearish: 'Chaikin money flow < -0.1: distribution.',
    evaluate: (s) => (f(s.cmf) && Math.abs(s.cmf) > 0.1 ? on(sgn(s.cmf), Math.min(1, Math.abs(s.cmf) / 0.3)) : undefined) },
  { id: 'mfi_extreme', indicator: 'money_flow', timeframes: ['15m', '1h'], kind: 'reversal',
    bullish: 'MFI < 20: volume-weighted oversold.', bearish: 'MFI > 80: volume-weighted overbought.',
    evaluate: (s) => (!f(s.mfi) ? undefined : s.mfi < 20 ? on(1, trending(s) ? 0.3 : 0.7) : s.mfi > 80 ? on(-1, trending(s) ? 0.3 : 0.7) : undefined) },
  { id: 'mfi_divergence', indicator: 'divergence', timeframes: ['1h', '4h'], kind: 'reversal',
    bullish: 'Bullish MFI divergence.', bearish: 'Price rising while MFI falls: volume behind the rally deteriorating.',
    evaluate: (s) => (s.divMfi.regular ? on(s.divMfi.regular, 0.8) : undefined) },
  { id: 'volume_surge', indicator: 'obv', timeframes: ['5m', '15m', '1h'], kind: 'continuation',
    bullish: 'Volume > 2x average on an up bar: conviction buying.', bearish: 'Volume > 2x average on a down bar: conviction selling.',
    evaluate: (s) => (f(s.volRatio) && s.volRatio >= 2 && f(s.chgAtr) && Math.abs(s.chgAtr) > 0.3 ? on(sgn(s.chgAtr), Math.min(1, s.volRatio / 4)) : undefined) },
  { id: 'vwap_side', indicator: 'vwap', timeframes: ['5m', '15m', '1h'], kind: 'trend',
    bullish: 'Above the session VWAP: intraday buyers in control.', bearish: 'Below the session VWAP: sellers in control.',
    evaluate: (s) => (f(s.vwap) && s.atr > 0 ? on(sgn(s.close - s.vwap), Math.min(1, Math.abs(s.close - s.vwap) / (2 * s.atr) + 0.2)) : undefined) },
  { id: 'vp_acceptance', indicator: 'volume_profile', timeframes: ['15m', '1h'], kind: 'continuation',
    bullish: 'Accepted above the value-area high: value migrating up.', bearish: 'Accepted below the value-area low: value migrating down.',
    evaluate: (s) => (s.profile ? (s.profile.loc === 'above' ? on(1, 0.5) : s.profile.loc === 'below' ? on(-1, 0.5) : undefined) : undefined) },
  { id: 'vp_80_rule', indicator: 'volume_profile', timeframes: ['15m', '1h'], kind: 'reversal',
    bullish: '80% rule: back inside value from below; rotation toward the VAH expected.', bearish: '80% rule: back inside value from above; rotation toward the VAL expected.',
    evaluate: (s) => (s.profile?.reentry ? on(s.profile.reentry, 1) : undefined) },
  { id: 'poc_magnet', indicator: 'volume_profile', timeframes: ['15m', '1h'], kind: 'reversal',
    bullish: 'Below the point of control inside value: fair-value magnet pulls up.', bearish: 'Above the point of control inside value: magnet pulls down.',
    evaluate: (s) => {
      if (!s.profile || s.profile.loc !== 'inside' || !(s.atr > 0)) return undefined;
      const d = (s.profile.poc - s.close) / s.atr;
      return Math.abs(d) >= 0.3 && Math.abs(d) <= 2 ? on(sgn(d), 0.4) : undefined;
    } },
  { id: 'lvn_rejection', indicator: 'volume_profile', timeframes: ['15m', '1h'], kind: 'reversal',
    bullish: 'Wick rejected from a low-volume node below value: snap-back into value.', bearish: 'Wick rejected from a low-volume node above value.',
    evaluate: (s) => {
      const p = s.profile;
      if (!p) return undefined;
      const bullWick = (s.sweep > 0 || s.candle.pinBar > 0) && f(p.nodeLow) && p.nodeLow < 0.5;
      const bearWick = (s.sweep < 0 || s.candle.pinBar < 0) && f(p.nodeHigh) && p.nodeHigh < 0.5;
      return bullWick ? on(1, 1) : bearWick ? on(-1, 1) : undefined;
    } },
  // Structure
  { id: 'market_structure', indicator: 'market_structure', timeframes: ['15m', '1h', '4h'], kind: 'trend',
    bullish: 'Higher highs and higher lows.', bearish: 'Lower highs and lower lows.',
    evaluate: (s) => (s.trend === 'up' ? on(1, 0.6) : s.trend === 'down' ? on(-1, 0.6) : undefined) },
  { id: 'bos', indicator: 'market_structure', timeframes: ['15m', '1h', '4h'], kind: 'continuation',
    bullish: 'Break of structure up: uptrend continues.', bearish: 'Break of structure down: downtrend continues.',
    evaluate: (s) => (s.bos ? on(s.bos, 0.8) : undefined) },
  { id: 'choch', indicator: 'market_structure', timeframes: ['5m', '15m', '1h'], kind: 'reversal',
    bullish: 'Change of character: first break above a swing high in a downtrend.', bearish: 'Change of character: first break below a swing low in an uptrend.',
    evaluate: (s) => (s.choch ? on(s.choch, 1) : undefined) },
  { id: 'liquidity_sweep', indicator: 'liquidity', timeframes: ['15m', '1h', '4h'], kind: 'reversal',
    bullish: 'Liquidity sweep of the lows: stops harvested, closed back inside (reversal up).', bearish: 'Liquidity sweep of the highs: closed back inside (reversal down).',
    evaluate: (s) => (s.sweep ? on(s.sweep, 1) : undefined) },
  { id: 'true_breakout', indicator: 'liquidity', timeframes: ['15m', '1h', '4h'], kind: 'continuation',
    bullish: 'True breakout up: solid body on volume.', bearish: 'True breakdown: solid body on volume.',
    evaluate: (s) => (s.breakout ? on(s.breakout, 1) : undefined) },
  { id: 'donchian_breakout', indicator: 'breakout', timeframes: ['15m', '1h', '4h'], kind: 'continuation',
    bullish: 'Close above the 20-bar high.', bearish: 'Close below the 20-bar low.',
    evaluate: (s) => (s.donchianBreak ? on(s.donchianBreak, 0.7) : undefined) },
  { id: 'fvg_retest', indicator: 'liquidity', timeframes: ['15m', '1h'], kind: 'continuation',
    bullish: 'Retesting an unfilled bullish fair value gap (support).', bearish: 'Retesting an unfilled bearish fair value gap (resistance).',
    evaluate: (s) => (s.inFvg ? on(s.inFvg, 0.6) : undefined) },
  { id: 'equal_levels', indicator: 'liquidity', timeframes: ['1h', '4h'], kind: 'regime',
    bullish: '', bearish: '', neutral: 'Equal highs/lows nearby: resting stop liquidity that is likely to be swept.',
    evaluate: (s) => {
      const near = (x?: number) => x !== undefined && s.atr > 0 && Math.abs(x - s.close) <= 2 * s.atr;
      return near(s.equalHighs) || near(s.equalLows) ? on(0, 0.5) : undefined;
    } },
  { id: 'engulfing', indicator: 'candles', timeframes: ['15m', '1h', '4h'], kind: 'reversal',
    bullish: 'Bullish engulfing candle.', bearish: 'Bearish engulfing candle.',
    evaluate: (s) => (s.candle.engulfing ? on(s.candle.engulfing, 0.5) : undefined) },
  { id: 'pin_bar', indicator: 'candles', timeframes: ['15m', '1h', '4h'], kind: 'reversal',
    bullish: 'Hammer / bullish pin bar: lower prices rejected.', bearish: 'Shooting star / bearish pin bar: higher prices rejected.',
    evaluate: (s) => (s.candle.pinBar ? on(s.candle.pinBar, 0.5) : undefined) },
  { id: 'doji', indicator: 'candles', timeframes: ['1h', '4h'], kind: 'volatility',
    bullish: '', bearish: '', neutral: 'Doji: indecision / momentum exhaustion.',
    evaluate: (s) => (s.candle.doji ? on(0, 0.4) : undefined) },
  { id: 'round_number_break', indicator: 'round_numbers', timeframes: ['15m', '1h'], kind: 'continuation',
    bullish: 'Crossed above a round number: stops beyond it fuel the move.', bearish: 'Crossed below a round number: stops beyond it fuel the move.',
    evaluate: (s) => (s.round.crossed ? on(s.round.crossed, 0.6) : undefined) },
  { id: 'round_number_barrier', indicator: 'round_numbers', timeframes: ['15m', '1h'], kind: 'reversal',
    bullish: '', bearish: '',
    neutral: 'Within 0.25 ATR of a round number: take-profit orders cluster there (stall risk).',
    evaluate: (s) => (!s.round.crossed && f(s.round.distAtr) && Math.abs(s.round.distAtr) <= 0.25 ? on(0, 0.5) : undefined) },
  // Macro (PDF section 9.2), carried on the 1h timeframe.
  { id: 'dominance_matrix', indicator: 'dominance_matrix', timeframes: ['1h'], kind: 'regime',
    bullish: 'Dominance matrix bullish for this asset (risk-on / altseason quadrant).', bearish: 'Dominance matrix bearish for this asset (risk-off / distribution quadrant).',
    neutral: 'Dominance matrix: risk-on for Bitcoin only (alts stagnate).',
    evaluate: (_s, _all, m) => {
      if (!m || m.usdtdChg === undefined || m.btcdChg === undefined || !f(m.usdtdChg) || !f(m.btcdChg)) return undefined;
      const th = 0.5;
      const u = m.usdtdChg > th ? 1 : m.usdtdChg < -th ? -1 : 0, b = m.btcdChg > th ? 1 : m.btcdChg < -th ? -1 : 0;
      if (u === 0) return undefined;
      const btc = (m.asset ?? 'BTC') === 'BTC';
      if (u > 0 && b > 0) return on(-1, btc ? 0.6 : 1);           // severe risk-off
      if (u > 0 && b < 0) return on(-1, 0.7);                      // distribution
      if (u < 0 && b > 0) return btc ? on(1, 1) : on(0, 0.4);      // risk-on for BTC
      if (u < 0 && b < 0) return on(1, btc ? 0.4 : 1);             // altseason
      return on(u < 0 ? 1 : -1, 0.5);                              // cash moving, BTC.D flat
    } },
];

// ---- Rule book: rules added for the directional system (research/ruleBook.ts tests every rule and
// rule-book rule walk-forward by market character; bot/strategy/ruleBook.ts combines the ones that pass).
// Kept out of RULES so the inputs the TA network and the models were trained on (rule nets and counts)
// do not shift; the analyzer evaluates them into TaSnapshot.book.
export const BOOK_RULES: RuleDef[] = [
  // Chart patterns, RSI regime rules (bot/ta/structure.ts chartPatterns, rsiRangeShift)
  { id: 'double_top_bottom', indicator: 'chart_patterns', timeframes: ['1h', '4h', '1d'], kind: 'reversal',
    bullish: 'Double bottom completed: the close broke above the peak between the two lows.', bearish: 'Double top completed: the close broke below the trough between the two highs.',
    evaluate: (s) => (s.patterns?.doubleTB ? on(s.patterns.doubleTB, 0.8) : undefined) },
  { id: 'head_shoulders', indicator: 'chart_patterns', timeframes: ['1h', '4h', '1d'], kind: 'reversal',
    bullish: 'Inverse head and shoulders completed: neckline broken upward.', bearish: 'Head and shoulders completed: neckline broken downward.',
    evaluate: (s) => (s.patterns?.headShoulders ? on(s.patterns.headShoulders, 0.9) : undefined) },
  { id: 'flag_pennant', indicator: 'chart_patterns', timeframes: ['15m', '1h', '4h'], kind: 'continuation',
    bullish: 'Bull flag / pennant broke upward: the impulse resumes.', bearish: 'Bear flag / pennant broke downward: the impulse resumes.',
    evaluate: (s) => (s.patterns?.flag ? on(s.patterns.flag, 0.8) : undefined) },
  { id: 'triangle_break', indicator: 'chart_patterns', timeframes: ['1h', '4h', '1d'], kind: 'continuation',
    bullish: 'Triangle broke upward.', bearish: 'Triangle broke downward.',
    evaluate: (s) => (s.patterns?.triangle ? on(s.patterns.triangle, 0.7) : undefined) },
  { id: 'trendline_retest', indicator: 'chart_patterns', timeframes: ['1h', '4h', '1d'], kind: 'reversal',
    bullish: 'Broken down-trendline retested from above and held: old resistance is now support.', bearish: 'Broken up-trendline retested from below and rejected: old support is now resistance.',
    evaluate: (s) => (s.patterns?.trendlineRetest ? on(s.patterns.trendlineRetest, 0.8) : undefined) },
  { id: 'rsi_range_shift', indicator: 'rsi_regime', timeframes: ['1h', '4h', '1d'], kind: 'regime',
    bullish: 'RSI in the bull range (holding ~40-80): uptrend momentum regime.', bearish: 'RSI in the bear range (capped ~60, reaching 20s): downtrend momentum regime.',
    evaluate: (s) => (s.rsiRange ? on(s.rsiRange, 0.7) : undefined) },
  { id: 'rsi2_pullback', indicator: 'rsi_regime', timeframes: ['1h', '4h', '1d'], kind: 'reversal',
    bullish: 'RSI(2) below 10 above the 200-bar average: a dip inside an uptrend.', bearish: 'RSI(2) above 90 below the 200-bar average: a rip inside a downtrend.',
    evaluate: (s) => {
      if (!f(s.rsi2) || !f(s.sma200)) return undefined;
      return s.close > s.sma200 && s.rsi2 < 10 ? on(1, Math.min(1, 0.5 + (10 - s.rsi2) / 20)) : s.close < s.sma200 && s.rsi2 > 90 ? on(-1, Math.min(1, 0.5 + (s.rsi2 - 90) / 20)) : undefined;
    } },
  { id: 'trend_pullback', indicator: 'moving_averages', timeframes: ['1h', '4h'], kind: 'continuation',
    bullish: 'Uptrend pullback to the 21 EMA holding, RSI 40-60 turning up: continuation entry.', bearish: 'Downtrend rally into the 21 EMA failing, RSI 40-60 turning down: continuation entry.',
    evaluate: (s) => {
      if (!f(s.ema50) || !f(s.adx) || !(s.atr > 0) || !f(s.rsi)) return undefined;
      const mid = s.rsi >= 40 && s.rsi <= 60;
      const up = s.close > s.ema21 && s.ema21 > s.ema50 && s.adx > 20 && Math.abs(s.close - s.ema21) <= 0.6 * s.atr && mid && s.rsi > s.rsiPrev;
      const dn = s.close < s.ema21 && s.ema21 < s.ema50 && s.adx > 20 && Math.abs(s.close - s.ema21) <= 0.6 * s.atr && mid && s.rsi < s.rsiPrev;
      return up ? on(1, 0.7) : dn ? on(-1, 0.7) : undefined;
    } },
  // Breadth and traditional risk gauges (daily, from bot/ta/marketContext.ts)
  { id: 'breadth', indicator: 'breadth', timeframes: ['1d'], kind: 'regime',
    bullish: 'Broad participation: most coins above their 20 / 50-day averages, or a new-highs thrust.', bearish: 'Broad weakness: most coins below their 20 / 50-day averages, or new lows dominate.',
    evaluate: (_s, _all, m) => {
      const b = m?.breadth;
      if (!b || !f(b.above50) || !f(b.above20)) return undefined;
      if ((b.above50 >= 0.7 && b.above20 >= 0.6) || b.hiLo >= 0.4) return on(1, Math.min(1, 0.5 + Math.max(b.above50 - 0.5, b.hiLo)));
      if ((b.above50 <= 0.3 && b.above20 <= 0.4) || b.hiLo <= -0.4) return on(-1, Math.min(1, 0.5 + Math.max(0.5 - b.above50, -b.hiLo)));
      return undefined;
    } },
  { id: 'macro_risk', indicator: 'macro_risk', timeframes: ['1d'], kind: 'regime',
    bullish: 'Risk-on: the dollar, VIX and yields falling, high-yield bonds rising.', bearish: 'Risk-off: the dollar, VIX and yields rising, high-yield bonds falling.',
    evaluate: (_s, _all, m) => {
      const r = m?.risk;
      if (!r) return undefined;
      const vote = (x: number | undefined, band: number, sign: 1 | -1) => (x !== undefined && f(x) ? (x > band ? sign : x < -band ? -sign : 0) : 0);
      const n = [r.dxy, r.us10y, r.vix, r.hyg].filter((x) => x !== undefined && f(x)).length;
      if (n < 3) return undefined;
      const score = vote(r.dxy, 0.005, -1) + vote(r.us10y, 0.01, -1) + vote(r.vix, 0.05, -1) + vote(r.hyg, 0.005, 1);
      return score >= 3 ? on(1, 0.8) : score <= -3 ? on(-1, 0.8) : undefined;
    } },
];

// ---- Confluences: combinations the reference (and cross-checks) say mean something together ----

export interface ConfluenceDef {
  id: string;
  name: string;
  source: string;
  members: Array<{ rule: string; tf: Timeframe; dirless?: boolean }>;
  /** Minimum members agreeing (same direction, or present when direction-free). */
  minAgree: number;
  /** Rules that must be among the agreeing members. */
  required: string[];
  bullish: string;
  bearish: string;
}

export const CONFLUENCES: ConfluenceDef[] = [
  { id: 'volatility_reversal_15m', name: 'Volatility Reversal Matrix (15m)', source: 'PDF section 8',
    members: [{ rule: 'liquidity_sweep', tf: '15m' }, { rule: 'lvn_rejection', tf: '15m' }, { rule: 'rsi_divergence', tf: '1h' }, { rule: 'macd_hist_shift', tf: '15m' }, { rule: 'macd_cross', tf: '15m' }],
    minAgree: 3, required: ['liquidity_sweep'],
    bullish: 'Sweep of the lows rejected at a low-volume node, RSI divergence and MACD turning: high-probability reversal up.',
    bearish: 'Sweep of the highs rejected at a low-volume node, RSI divergence and MACD turning: high-probability reversal down.' },
  { id: 'volatility_reversal_1h', name: 'Volatility Reversal Matrix (1h)', source: 'PDF section 8',
    members: [{ rule: 'liquidity_sweep', tf: '1h' }, { rule: 'lvn_rejection', tf: '1h' }, { rule: 'rsi_divergence', tf: '4h' }, { rule: 'macd_hist_shift', tf: '1h' }, { rule: 'macd_cross', tf: '1h' }],
    minAgree: 3, required: ['liquidity_sweep'],
    bullish: 'Hourly sweep-and-reclaim with momentum exhaustion: reversal up.', bearish: 'Hourly sweep-and-reject with momentum exhaustion: reversal down.' },
  { id: 'smc_reversal', name: 'Smart-money reversal (sweep, CHoCH, FVG)', source: 'PDF section 6.1',
    members: [{ rule: 'liquidity_sweep', tf: '1h' }, { rule: 'liquidity_sweep', tf: '15m' }, { rule: 'choch', tf: '15m' }, { rule: 'choch', tf: '5m' }, { rule: 'fvg_retest', tf: '15m' }],
    minAgree: 2, required: ['choch'],
    bullish: 'Lows swept, structure flipped up on the lower timeframe, pullback into the gap: reversal entry.', bearish: 'Highs swept, structure flipped down, pullback into the gap: reversal entry.' },
  { id: 'trend_alignment', name: 'Trend alignment', source: 'PDF sections 1.1-1.3 + 3.2',
    members: [{ rule: 'ema_stack', tf: '1h' }, { rule: 'adx_trend', tf: '1h' }, { rule: 'ichimoku_cloud', tf: '4h' }, { rule: 'market_structure', tf: '1h' }, { rule: 'momentum_state', tf: '1h' }, { rule: 'price_to_ma', tf: '4h' }],
    minAgree: 4, required: [],
    bullish: 'Moving averages, ADX, cloud, structure and momentum all agree: established uptrend.', bearish: 'Every trend tool agrees: established downtrend.' },
  { id: 'squeeze_breakout_1h', name: 'Squeeze breakout (1h)', source: 'PDF 2.1 squeeze + 6.1 true breakout',
    members: [{ rule: 'squeeze_release', tf: '1h' }, { rule: 'true_breakout', tf: '1h' }, { rule: 'donchian_breakout', tf: '1h' }, { rule: 'volume_surge', tf: '1h' }, { rule: 'adx_trend', tf: '1h' }],
    minAgree: 2, required: ['squeeze_release'],
    bullish: 'Volatility compression released upward with a real breakout: expansion up.', bearish: 'Compression released downward with a real breakdown: expansion down.' },
  { id: 'squeeze_breakout_15m', name: 'Squeeze breakout (15m)', source: 'PDF 2.1 + 6.1',
    members: [{ rule: 'squeeze_release', tf: '15m' }, { rule: 'true_breakout', tf: '15m' }, { rule: 'donchian_breakout', tf: '15m' }, { rule: 'volume_surge', tf: '15m' }],
    minAgree: 2, required: ['squeeze_release'],
    bullish: '15-minute squeeze released upward with a breakout.', bearish: '15-minute squeeze released downward with a breakdown.' },
  { id: 'range_reversion', name: 'Range mean reversion', source: 'PDF 1.2 (ADX < 20) + 2.1 + 3.1 + 3.3',
    members: [{ rule: 'adx_range', tf: '1h', dirless: true }, { rule: 'stoch_cross_extreme', tf: '15m' }, { rule: 'bb_reversion', tf: '15m' }, { rule: 'rsi_extreme', tf: '15m' }, { rule: 'williams_extreme', tf: '15m' }, { rule: 'mfi_extreme', tf: '15m' }],
    minAgree: 3, required: ['adx_range'],
    bullish: 'Ranging market at an oversold extreme with oscillators turning: fade down, expect a bounce.', bearish: 'Ranging market at an overbought extreme: fade the rally.' },
  { id: 'volume_confirmation', name: 'Volume confirms the move', source: 'PDF section 4',
    members: [{ rule: 'obv_trend', tf: '1h' }, { rule: 'cmf_flow', tf: '1h' }, { rule: 'vwap_side', tf: '15m' }, { rule: 'market_structure', tf: '1h' }],
    minAgree: 3, required: [],
    bullish: 'Price structure up with OBV, money flow and VWAP behind it: organic demand.', bearish: 'Structure down with volume flowing out: organic supply.' },
  { id: 'exhaustion', name: 'Momentum exhaustion (multi-oscillator divergence)', source: 'PDF 3.1, 3.2, 4.1, 4.2',
    members: [{ rule: 'rsi_divergence', tf: '1h' }, { rule: 'macd_divergence', tf: '1h' }, { rule: 'obv_divergence', tf: '1h' }, { rule: 'mfi_divergence', tf: '1h' }],
    minAgree: 2, required: [],
    bullish: 'Several oscillators diverge from the new low: sellers exhausted.', bearish: 'Several oscillators diverge from the new high: buyers exhausted, bull-trap risk.' },
  { id: 'value_area_rotation', name: 'Value-area rotation (80% rule)', source: 'PDF 5.1-5.2',
    members: [{ rule: 'vp_80_rule', tf: '15m' }, { rule: 'vwap_side', tf: '15m' }, { rule: 'momentum_state', tf: '15m' }, { rule: 'poc_magnet', tf: '15m' }],
    minAgree: 2, required: ['vp_80_rule'],
    bullish: 'Back inside value from below with VWAP/momentum support: rotation toward the VAH.', bearish: 'Back inside value from above: rotation toward the VAL.' },
  { id: 'mtf_momentum', name: 'Multi-timeframe momentum', source: 'cross-reference (time-series momentum)',
    members: [{ rule: 'momentum_state', tf: '15m' }, { rule: 'momentum_state', tf: '1h' }, { rule: 'momentum_state', tf: '4h' }],
    minAgree: 3, required: [],
    bullish: 'RSI and MACD bullish on 15m, 1h and 4h.', bearish: 'RSI and MACD bearish on 15m, 1h and 4h.' },
  { id: 'macro_rotation', name: 'Macro rotation confirmed on the chart', source: 'PDF section 9.2',
    members: [{ rule: 'dominance_matrix', tf: '1h' }, { rule: 'momentum_state', tf: '1h' }, { rule: 'market_structure', tf: '1h' }, { rule: 'vwap_side', tf: '15m' }],
    minAgree: 2, required: ['dominance_matrix'],
    bullish: 'Dominance quadrant favours this asset and the chart agrees.', bearish: 'Dominance quadrant is against this asset and the chart agrees.' },
  { id: 'macro_trend', name: 'Higher-timeframe regime', source: 'PDF 1.1 + 1.3 (daily/4h)',
    members: [{ rule: 'ma_regime', tf: '1d' }, { rule: 'ema_stack', tf: '4h' }, { rule: 'ichimoku_cloud', tf: '1d' }, { rule: 'ma_regime', tf: '4h' }],
    minAgree: 3, required: [],
    bullish: 'Daily and 4-hour regime bullish: trade with it.', bearish: 'Daily and 4-hour regime bearish.' },
];

export const knowledgeById = (id: string) => KNOWLEDGE.find((k) => k.id === id);
