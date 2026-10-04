# TA knowledge library

Generated from `bot/ta/knowledge.ts` by `npm run ta:docs`. Do not edit by hand.

Every indicator is computed on closed Coinbase spot USD candles (1m, 5m, 15m, 1h, 4h, 1d) for the asset behind each contract. Rules and confluences are candidates: the meta-model learns their weight walk-forward (feature groups `ta` and `taconf`), and `npm run research:ta` measures each one's forward-return edge with a false-discovery-rate cut.

## Engine: TA-Lib first, this library for the rest

The core indicators come from **TA-Lib** (https://ta-lib.org, the C library behind ta-lib-python), through the native Node binding in `vendor/talib`. It is compiled from TA-Lib's C sources on `npm ci`; the published package shipped macOS object files, so it is vendored with those removed. TA-Lib provides:
- ATR, EMA 12/21/26/50, SMA 50/200
- ADX with +DI/-DI
- Bollinger Bands (20, 2)
- RSI (14), MACD (12/26/9)
- Stochastic (14, 3, 3 slow)
- Williams %R, OBV, MFI

Every rule, confluence and model input that reads those reads TA-Lib's values.

**TA-Lib adds** inputs this library didn't have, at every timeframe, for the TA network and the setup scorer (`bot/ta/talib.ts`):
- CCI, momentum, the Aroon oscillator, the Ultimate Oscillator, NATR, TRIX, PPO, CMO
- balance of power, distance to the Parabolic SAR, the Hilbert trend-vs-cycle mode
- linear-regression slope, standard deviation, distance to KAMA, the A/D oscillator, Stochastic RSI
- **all 61 candlestick patterns**: summed into bullish / bearish / net scores for the last bar and the last 3 bars, plus 22 well-known patterns as their own inputs (engulfing, hammer, inverted hammer, shooting star, hanging man, the dojis, morning and evening star, three white soldiers, three black crows, harami, piercing, dark cloud cover, marubozu, three inside and outside, belt hold, kicking, abandoned baby, spinning top)

**This library keeps** what TA-Lib doesn't do, as extra nuance:
- market structure (swings, BOS, CHoCH), liquidity sweeps, true breakouts, equal highs and lows, fair-value gaps
- regular and hidden divergences, the continuous OBV divergence
- volume profile with the 80% rule, VWAP, Ichimoku, the Keltner squeeze, Donchian breakouts, Chaikin Money Flow, round numbers
- its own engulfing, pin bar and doji reads
- the knowledge base's rules and confluences

If the native module can't load, everything falls back to this library's own implementations of the core indicators, and the TA-Lib-only inputs read as missing. The TA network and setup model files record the engine they were trained with, and the bot logs a warning on a mismatch. `TA_ENGINE=builtin` forces the fallback.

## Indicators

### Simple & exponential moving averages

- **Category:** trend · **Author:** classical
- **Formula:** `SMA_n = (1/n) sum P_i;  EMA_t = (P_t - EMA_{t-1}) x a + EMA_{t-1},  a = 2/(n+1)`
- **Parameters:** EMA 12/21/26/50; SMA 50/200
- **Best timeframes (reference):** SMA 50/100/200 on 1D/1W; EMA 12/21/26 on 1H/4H · **Bot computes on:** 15m, 1h, 4h, 1d
- **Evidence:** moderate (MA rules are the best-supported TA family in crypto.)

| When | Meaning | Bias |
|---|---|---|
| price > EMA21 > EMA50 (> SMA200) | Stacked uptrend: dips toward the fast EMA are bought. | bullish |
| price < EMA21 < EMA50 (< SMA200) | Stacked downtrend: rallies into the fast EMA are sold. | bearish |
| SMA50 crosses above SMA200 (golden cross) | Macro regime shift to bullish. | bullish |
| SMA50 crosses below SMA200 (death cross) | Macro regime shift to bearish. | bearish |
| price far above/below its MA (price-to-MA ratio) | Trend strength; extreme ratios also mean stretched. | context |

**Caveats:** Lagging by construction; whipsaws in ranges (check ADX). Golden/death crosses are rare on the timeframes that matter for 15-minute contracts: context, not a trigger.

**Sources:**
- Hudson & Urquhart (2021), Technical trading and cryptocurrencies, Annals of Operations Research: ~15,000 rules, significant predictability with multiple-testing controls
- Detzel, Liu, Strauss, Zhou & Zhu (2021), Learning and predictability via technical analysis: evidence from bitcoin and stocks with hard-to-value fundamentals, Financial Management: price-to-MA ratios predict BTC returns out of sample
- Corbet, Eraslan, Lucey & Sensoy (2019), The effectiveness of technical trading rules in cryptocurrency markets, Finance Research Letters
- Brock, Lakonishok & LeBaron (1992), Simple technical trading rules and the stochastic properties of stock returns, Journal of Finance
- Operator reference: Quantitative Technical Analysis in Cryptocurrency Markets (PDF)

### Average Directional Index (+DI / -DI)

- **Category:** trend · **Author:** J. Welles Wilder
- **Formula:** `+DM = H - H_prev, -DM = L_prev - L (the larger, if > 0); +DI = 100 RMA14(+DM)/RMA14(TR); DX = 100 |+DI - -DI| / (+DI + -DI); ADX = RMA14(DX)`
- **Parameters:** 14
- **Best timeframes (reference):** 4h, 1d · **Bot computes on:** 15m, 1h, 4h
- **Evidence:** practitioner (Used here as a regime filter (trend vs range) rather than a signal.)

| When | Meaning | Bias |
|---|---|---|
| ADX > 25 and rising, +DI > -DI | Strong, accelerating uptrend: counter-trend traders get trapped. | bullish |
| ADX > 25 and rising, -DI > +DI | Strong, accelerating downtrend. | bearish |
| ADX < 20 | No trend: breakouts fail often, oscillator mean-reversion works better. | context |

**Caveats:** Non-directional: direction comes from the DIs. Noisy below 1H.

**Sources:**
- Wilder (1978), New Concepts in Technical Trading Systems
- Operator reference: Quantitative Technical Analysis in Cryptocurrency Markets (PDF)

### Ichimoku Kinko Hyo

- **Category:** trend · **Author:** Goichi Hosoda
- **Formula:** `Tenkan = (HH9+LL9)/2; Kijun = (HH26+LL26)/2; Span A = (Tenkan+Kijun)/2 shifted +26; Span B = (HH52+LL52)/2 shifted +26; Chikou = close shifted -26`
- **Parameters:** 9 / 26 / 52, shift 26
- **Best timeframes (reference):** 1d, 4h · **Bot computes on:** 1h, 4h, 1d
- **Evidence:** practitioner (Limited peer-reviewed testing.)

| When | Meaning | Bias |
|---|---|---|
| price above the cloud, Tenkan > Kijun, future cloud green | Bullish equilibrium: the cloud is a thick support floor. | bullish |
| price below the cloud, Tenkan < Kijun, future cloud red | Bearish equilibrium: the cloud is resistance. | bearish |
| Tenkan crosses Kijun on the cloud side of price | Momentum turning with the trend. | context |
| thin cloud | Weak support/resistance: prone to rapid breaks. | volatility |

**Caveats:** The reference warns intraday (15m) Ichimoku gives excessive false signals: the bot only uses 1H and slower.

**Sources:**
- Operator reference: Quantitative Technical Analysis in Cryptocurrency Markets (PDF)

### Bollinger Bands, %B, bandwidth and the squeeze

- **Category:** volatility · **Author:** John Bollinger
- **Formula:** `MB = SMA20; UB/LB = MB +/- 2 sigma20; %B = (P - LB)/(UB - LB); bandwidth = (UB - LB)/MB; squeeze = BB inside Keltner (EMA20 +/- 1.5 ATR10)`
- **Parameters:** 20, 2; Keltner 20, 1.5 x ATR10
- **Best timeframes (reference):** 4h, 1d · **Bot computes on:** 5m, 15m, 1h, 4h
- **Evidence:** weak (Volatility clustering (the squeeze logic) is well established; band-touch reversion is mixed.)

| When | Meaning | Bias |
|---|---|---|
| %B > 1 in a range (ADX < 20) | Statistically stretched above the mean: reversion likely. | bearish |
| %B < 0 in a range | Stretched below the mean: bounce likely. | bullish |
| %B > 1 with ADX > 25 (band walk) | In a strong trend price rides the band: not a sell signal. | bullish |
| squeeze (bands inside Keltner / bandwidth at a low percentile) | Volatility compression: a violent expansion usually follows. | volatility |
| squeeze releases | Expansion has begun in the direction of the break. | context |

**Caveats:** Micro timeframes give meaningless band breaches. Squeezes predict volatility, not direction.

**Sources:**
- Operator reference: Quantitative Technical Analysis in Cryptocurrency Markets (PDF)
- Park & Irwin (2007), What do we know about the profitability of technical analysis?, Journal of Economic Surveys: profits in older data, fading in recent decades; data snooping a major concern

### Average True Range

- **Category:** volatility · **Author:** J. Welles Wilder
- **Formula:** `TR = max(H - L, |H - C_prev|, |L - C_prev|); ATR = RMA14(TR)`
- **Parameters:** 14
- **Best timeframes (reference):** 1h, 4h, 1d · **Bot computes on:** 1m, 5m, 15m, 1h, 4h, 1d
- **Evidence:** moderate (Volatility persistence is one of the most robust facts in finance.)

| When | Meaning | Bias |
|---|---|---|
| ATR at a high percentile | Large swings: smaller size, wider stops (entry +/- 2 ATR). | volatility |
| ATR at a low percentile | Compression: often precedes an explosive move. | volatility |

**Caveats:** No direction. The bot uses ATR to normalise every distance (FVGs, round numbers, VWAP).

**Sources:**
- Wilder (1978), New Concepts in Technical Trading Systems
- Operator reference: Quantitative Technical Analysis in Cryptocurrency Markets (PDF)

### Relative Strength Index

- **Category:** momentum · **Author:** J. Welles Wilder
- **Formula:** `RSI = 100 - 100/(1 + RS), RS = RMA14(gains)/RMA14(losses)`
- **Parameters:** 14; levels 30/50/70
- **Best timeframes (reference):** 15m day trading, 4H swing, 1D macro · **Bot computes on:** 5m, 15m, 1h, 4h
- **Evidence:** weak (Oscillator rules have mixed evidence; divergence is practitioner lore.)

| When | Meaning | Bias |
|---|---|---|
| RSI > 70 | Overbought: reversal or consolidation risk (can stay embedded in FOMO trends). | bearish |
| RSI < 30 | Oversold: bounce potential. | bullish |
| price higher high, RSI lower high (bearish divergence) | Buyers exhausted: reversal highly probable per the reference. | bearish |
| price lower low, RSI higher low (bullish divergence) | Selling velocity exhausted. | bullish |
| hidden divergence (price HL, RSI LL) | Trend continuation after a pullback. | context |
| RSI crosses 50 | Momentum regime flips. | context |

**Caveats:** Overbought/oversold fades lose in trends: the bot damps them when ADX > 25.

**Sources:**
- Wilder (1978), New Concepts in Technical Trading Systems
- Park & Irwin (2007), What do we know about the profitability of technical analysis?, Journal of Economic Surveys: profits in older data, fading in recent decades; data snooping a major concern
- Operator reference: Quantitative Technical Analysis in Cryptocurrency Markets (PDF)

### MACD

- **Category:** momentum · **Author:** Gerald Appel
- **Formula:** `MACD = EMA12 - EMA26; signal = EMA9(MACD); histogram = MACD - signal`
- **Parameters:** 12 / 26 / 9
- **Best timeframes (reference):** 4h, 1d · **Bot computes on:** 15m, 1h, 4h
- **Evidence:** weak (MACD is an EMA-difference rule; the MA-rule evidence partly carries over.)

| When | Meaning | Bias |
|---|---|---|
| MACD crosses above signal (stronger below zero) | Bullish momentum shift. | bullish |
| MACD crosses below signal (stronger above zero) | Bearish momentum shift. | bearish |
| negative histogram shrinking | Bearish momentum decelerating: often precedes a bullish cross. | bullish |
| positive histogram shrinking | Bullish momentum decelerating. | bearish |
| histogram divergence vs price | Momentum fading against the price extreme. | context |

**Caveats:** Whipsaws below 1H per the reference; 15m is included only as a confluence member.

**Sources:**
- Operator reference: Quantitative Technical Analysis in Cryptocurrency Markets (PDF)
- Hudson & Urquhart (2021), Technical trading and cryptocurrencies, Annals of Operations Research: ~15,000 rules, significant predictability with multiple-testing controls

### Stochastic oscillator & Williams %R

- **Category:** momentum · **Author:** George Lane; Larry Williams
- **Formula:** `%K = 100 (C - LL14)/(HH14 - LL14); %D = SMA3(%K); %R = -100 (HH14 - C)/(HH14 - LL14)`
- **Parameters:** 14, 3; levels 20/80 and -80/-20
- **Best timeframes (reference):** 15m, 1h · **Bot computes on:** 5m, 15m, 1h
- **Evidence:** weak

| When | Meaning | Bias |
|---|---|---|
| %K crosses above %D below 20 | Buy signal in a range. | bullish |
| %K crosses below %D above 80 | Sell signal in a range. | bearish |
| %R < -80 / > -20 | Oversold / overbought. | context |

**Caveats:** Precise in ranges, pinned at extremes in trends: used only with ADX < 20.

**Sources:**
- Operator reference: Quantitative Technical Analysis in Cryptocurrency Markets (PDF)
- Park & Irwin (2007), What do we know about the profitability of technical analysis?, Journal of Economic Surveys: profits in older data, fading in recent decades; data snooping a major concern

### On-Balance Volume

- **Category:** volume · **Author:** Joe Granville
- **Formula:** `OBV += V if close up, -= V if close down`
- **Parameters:** slope over 20 bars / (20 x avg volume)
- **Best timeframes (reference):** 1d, 1h · **Bot computes on:** 1h, 4h
- **Evidence:** practitioner (Volume does carry information about price moves.)

| When | Meaning | Bias |
|---|---|---|
| OBV rising while price is flat | Quiet accumulation: upside resolution probable. | bullish |
| new price high without a new OBV high | Rally lacks demand: bull-trap warning. | bearish |

**Caveats:** The reference notes intraday OBV is distorted by market-maker volume; single-venue (Coinbase) volume is a sample of the market.

**Sources:**
- Blume, Easley & O'Hara (1994), Market statistics and technical analysis: the role of volume, Journal of Finance
- Operator reference: Quantitative Technical Analysis in Cryptocurrency Markets (PDF)

### Chaikin Money Flow & Money Flow Index

- **Category:** volume · **Author:** Marc Chaikin; Gene Quong & Avrum Soudack
- **Formula:** `CMF = sum20(((C-L)-(H-C))/(H-L) x V) / sum20(V);  MFI = 100 - 100/(1 + pos14(TP x V)/neg14(TP x V))`
- **Parameters:** CMF 20, MFI 14
- **Best timeframes (reference):** 4h, 1d · **Bot computes on:** 15m, 1h, 4h
- **Evidence:** practitioner

| When | Meaning | Bias |
|---|---|---|
| CMF > 0 sustained | Closing in the upper half of ranges on volume: accumulation. | bullish |
| CMF < 0 sustained | Distribution. | bearish |
| MFI > 80 / < 20 | Volume-weighted overbought / oversold. | context |
| price rising while MFI falls | Volume behind the rally deteriorating: top risk. | bearish |

**Sources:**
- Blume, Easley & O'Hara (1994), Market statistics and technical analysis: the role of volume, Journal of Finance
- Operator reference: Quantitative Technical Analysis in Cryptocurrency Markets (PDF)

### Volume profile (POC, value area, HVN/LVN, 80% rule)

- **Category:** microstructure · **Author:** Market Profile (Steidlmayer)
- **Formula:** `Volume per price bin; POC = max bin; value area = bins grown from the POC to 70% of volume (VAL..VAH); node = bin volume / mean bin`
- **Parameters:** 96 bars, 40 bins, 70%
- **Best timeframes (reference):** FRVP intraday (15m, 1H), VPVR daily · **Bot computes on:** 15m, 1h
- **Evidence:** practitioner

| When | Meaning | Bias |
|---|---|---|
| price near a high-volume node / the POC | Fair-value magnet: price gravitates to it. | context |
| price inside a low-volume node | Liquidity vacuum: price slices through fast. | volatility |
| opened outside the value area, two closes back inside | 80% rule: rotation to the opposite edge of value is likely. | context |
| accepted above VAH / below VAL | Value migrating: breakout acceptance. | context |

**Caveats:** The "80%" is practitioner folklore: the bot measures its actual hit rate. Built from one venue's candles, spreading each candle's volume over its range (an approximation of tick-level profiles).

**Sources:**
- Operator reference: Quantitative Technical Analysis in Cryptocurrency Markets (PDF)

### VWAP (session / anchored)

- **Category:** microstructure
- **Formula:** `VWAP = sum(TP x V)/sum(V), TP = (H+L+C)/3, reset at 00:00 UTC`
- **Parameters:** session = UTC day
- **Best timeframes (reference):** intraday session VWAP; anchored on 1D · **Bot computes on:** 5m, 15m, 1h
- **Evidence:** practitioner (The institutional execution benchmark; its S/R role is practitioner knowledge.)

| When | Meaning | Bias |
|---|---|---|
| price above VWAP | Intraday buyers in control; VWAP is support. | bullish |
| price below VWAP | Sellers in control; VWAP is resistance. | bearish |

**Caveats:** Crypto trades 24/7: the "session" is a convention (UTC day).

**Sources:**
- Operator reference: Quantitative Technical Analysis in Cryptocurrency Markets (PDF)

### Market structure: swings, BOS, CHoCH

- **Category:** structure · **Author:** Dow theory / SMC
- **Formula:** `Fractal swings (3 bars each side, confirmed); HH+HL = up, LH+LL = down; BOS = close through the last swing with the trend; CHoCH = against it`
- **Parameters:** fractal 3/3
- **Best timeframes (reference):** Daily levels, 15m confirmation · **Bot computes on:** 5m, 15m, 1h, 4h
- **Evidence:** practitioner (Chart patterns do carry some information.)

| When | Meaning | Bias |
|---|---|---|
| higher highs and higher lows | Uptrend structure. | bullish |
| break of structure with the trend | Continuation. | context |
| change of character (first break against the trend) | Reversal confirmation after a sweep. | context |

**Caveats:** Swings are confirmed 3 bars late by design (no look-ahead).

**Sources:**
- Lo, Mamaysky & Wang (2000), Foundations of technical analysis, Journal of Finance: chart patterns carry incremental information
- Operator reference: Quantitative Technical Analysis in Cryptocurrency Markets (PDF)

### Liquidity sweeps, true breakouts, equal highs/lows, fair value gaps

- **Category:** structure · **Author:** SMC / ICT
- **Formula:** `Sweep: wick through the prior swing, close back inside, wick >= 50% of range. True breakout: body >= 60% of range closing beyond the swing on >= 1.5x average volume. FVG: bar(i-2).high < bar(i).low (bullish), unfilled.`
- **Parameters:** last 3 bars; volume x1.5; equal levels within 0.15 ATR
- **Best timeframes (reference):** Daily levels, 15m execution · **Bot computes on:** 15m, 1h, 4h
- **Evidence:** practitioner (Mechanism supported by stop-loss clustering research.)

| When | Meaning | Bias |
|---|---|---|
| sweep of lows then close back above | Stops harvested; institutions filled: violent reversal up. | bullish |
| sweep of highs then close back below | Bull stops/breakout buyers trapped: reversal down. | bearish |
| true breakout (solid body, volume) | Genuine range expansion: continuation. | context |
| equal highs/lows | Resting stop liquidity: a sweep target. | context |
| price retesting an unfilled FVG | Imbalance zone: entry on the pullback. | context |

**Caveats:** The sweep mechanism (stop clusters beyond obvious levels cascade) is documented in FX order books; the full SMC playbook is not peer-reviewed.

**Sources:**
- Osler (2003), Currency orders and exchange rate dynamics: an explanation for the predictive success of technical analysis, Journal of Finance: take-profits cluster at round numbers, stop-losses just beyond them
- Osler (2005), Stop-loss orders and price cascades in currency markets, Journal of International Money and Finance
- Operator reference: Quantitative Technical Analysis in Cryptocurrency Markets (PDF)

### Trading-range (Donchian) breakout

- **Category:** structure · **Author:** Donchian / Brock et al.
- **Formula:** `close > highest high (or < lowest low) of the prior 20 bars`
- **Parameters:** 20
- **Best timeframes (reference):** 1h, 4h, 1d · **Bot computes on:** 15m, 1h, 4h
- **Evidence:** moderate (TRB rules are among the few with crypto support.)

| When | Meaning | Bias |
|---|---|---|
| close beyond the 20-bar range | Breakout: trend continuation in that direction. | context |

**Caveats:** Many breakouts fail (see sweeps): confirm with volume / true-breakout body.

**Sources:**
- Gerritsen, Bouri, Ramezanifar & Roubaud (2020), The profitability of technical trading rules in the Bitcoin market, Finance Research Letters: trading-range breakout rules profitable
- Brock, Lakonishok & LeBaron (1992), Simple technical trading rules and the stochastic properties of stock returns, Journal of Finance
- Hudson & Urquhart (2021), Technical trading and cryptocurrencies, Annals of Operations Research: ~15,000 rules, significant predictability with multiple-testing controls

### Divergences (RSI, MACD histogram, OBV, MFI)

- **Category:** momentum
- **Formula:** `Last two confirmed swing lows (highs): price LL (HH) while the oscillator makes HL (LH) = regular; price HL (LH) while the oscillator makes LL (HH) = hidden`
- **Parameters:** swings within 10 bars
- **Best timeframes (reference):** 1h, 4h · **Bot computes on:** 15m, 1h, 4h
- **Evidence:** practitioner

| When | Meaning | Bias |
|---|---|---|
| regular bullish divergence | Downside momentum exhausted. | bullish |
| regular bearish divergence | Upside momentum exhausted. | bearish |
| hidden divergence | Pullback within a trend likely to resume. | context |

**Caveats:** Divergences can persist; the reference uses them as one leg of a confluence, never alone.

**Sources:**
- Operator reference: Quantitative Technical Analysis in Cryptocurrency Markets (PDF)

### Candlestick patterns (engulfing, doji, pin bar)

- **Category:** structure
- **Formula:** `Engulfing: body engulfs the prior opposite body; doji: body <= 10% of range; pin bar: wick >= 2x body and >= 60% of range`
- **Parameters:** —
- **Best timeframes (reference):** at key levels · **Bot computes on:** 15m, 1h, 4h
- **Evidence:** weak

| When | Meaning | Bias |
|---|---|---|
| bullish engulfing / hammer at support | Buyers reclaimed control. | bullish |
| bearish engulfing / shooting star at resistance | Sellers reclaimed control. | bearish |
| doji | Indecision / momentum exhaustion. | context |

**Caveats:** Stand-alone candlestick rules have tested poorly: kept only as confluence context.

**Sources:**
- Marshall, Young & Rose (2006), Candlestick technical trading strategies: can they create value for investors?, Journal of Banking & Finance: no value in US equities
- Operator reference: Quantitative Technical Analysis in Cryptocurrency Markets (PDF)

### Round-number levels

- **Category:** microstructure · **Author:** Osler
- **Formula:** `Nearest multiple of 10^(floor(log10 P) - 1): $1,000 for BTC, $100 for ETH, $10 for SOL`
- **Parameters:** —
- **Best timeframes (reference):** all · **Bot computes on:** 15m, 1h
- **Evidence:** moderate (Documented in FX dealer order books.)

| When | Meaning | Bias |
|---|---|---|
| price just crossed a round number | Stops clustered just beyond it trigger: the move accelerates. | context |
| price approaching a round number | Take-profit orders cluster at it: stall/reversal risk. | context |

**Sources:**
- Osler (2003), Currency orders and exchange rate dynamics: an explanation for the predictive success of technical analysis, Journal of Finance: take-profits cluster at round numbers, stop-losses just beyond them
- Osler (2005), Stop-loss orders and price cascades in currency markets, Journal of International Money and Finance

### Intraday time-series momentum

- **Category:** momentum
- **Formula:** `Sign of the early-session return predicts the late-session return`
- **Parameters:** —
- **Best timeframes (reference):** intraday · **Bot computes on:** 15m, 1h
- **Evidence:** moderate

| When | Meaning | Bias |
|---|---|---|
| strong early-session move | Tends to continue into the session close. | context |

**Caveats:** Captured by the existing ret_* features and the momentum_state rule.

**Sources:**
- Shen, Urquhart & Wang (2022), Bitcoin intraday time series momentum, Financial Review

### MVRV Z-score (documented, not computed)

- **Category:** onchain
- **Formula:** `Z = (market value - realized value) / sigma(market value)`
- **Parameters:** thresholds +7 (tops), < 0.1 (bottoms)
- **Best timeframes (reference):** weekly / monthly · **Bot computes on:** —
- **Evidence:** practitioner (Few cycles of history.)

| When | Meaning | Bias |
|---|---|---|
| Z > 7 | Euphoric cycle top. | bearish |
| Z < 0.1 | Capitulation bottom. | bullish |

**Caveats:** Cycle-scale (months): no information at a 15-minute or 1-hour horizon; needs an on-chain data provider.

**Sources:**
- Operator reference: Quantitative Technical Analysis in Cryptocurrency Markets (PDF)

### NVT ratio / signal (documented, not computed)

- **Category:** onchain
- **Formula:** `NVT = market cap / daily on-chain USD volume; signal uses a 90-day MA of volume`
- **Parameters:** > 150 = overvalued
- **Best timeframes (reference):** 1d · **Bot computes on:** —
- **Evidence:** practitioner

| When | Meaning | Bias |
|---|---|---|
| NVT high | Price outpacing on-chain utility. | bearish |
| NVT low | Undervalued vs usage. | bullish |

**Caveats:** Daily/weekly valuation metric; not used for intraday contracts.

**Sources:**
- Operator reference: Quantitative Technical Analysis in Cryptocurrency Markets (PDF)

### BTC.D x USDT.D liquidity rotation matrix

- **Category:** macro
- **Formula:** `BTC.D = BTC mcap / total; USDT.D = USDT mcap / total (the bot tracks both live)`
- **Parameters:** recent change, sigma-scaled; |z| > 0.5 counts as rising/falling
- **Best timeframes (reference):** 1h, 4h, 1d · **Bot computes on:** 1h
- **Evidence:** practitioner

| When | Meaning | Bias |
|---|---|---|
| USDT.D up + BTC.D up | Severe risk-off: everything sold, alts worst. | bearish |
| USDT.D down + BTC.D up | Risk-on for Bitcoin; alts stagnate. | context |
| USDT.D down + BTC.D down | Altseason: capital cascades into alts. | bullish |
| USDT.D up + BTC.D down | Macro distribution out of BTC into cash. | bearish |

**Caveats:** Spot-ETF flows now move BTC.D independently of alt rotation. The bot's dominance series is a live proxy (Binance prices anchored to CoinGecko caps).

**Sources:**
- Operator reference: Quantitative Technical Analysis in Cryptocurrency Markets (PDF)

### Validation discipline (why nothing here is trusted untested)

- **Category:** macro
- **Formula:** `Every rule x timeframe x horizon is a hypothesis; forward-return hit rates are tested with a bootstrap and a Benjamini-Hochberg false-discovery-rate cut`
- **Parameters:** FDR 10%
- **Best timeframes (reference):** n/a · **Bot computes on:** —
- **Evidence:** strong (Searching many rules without correction manufactures false edges.)

| When | Meaning | Bias |
|---|---|---|
| a rule survives the FDR cut out of sample | Its measured edge is shown next to the live signal and the model may weight it. | context |

**Caveats:** Transaction costs and the contract payoff, not raw hit rate, decide tradability: the meta-model makes that call.

**Sources:**
- Sullivan, Timmermann & White (1999), Data-snooping, technical trading rule performance, and the bootstrap, Journal of Finance
- Bajgrowicz & Scaillet (2012), Technical trading revisited: false discoveries, persistence tests, and transaction costs, Journal of Financial Economics
- Park & Irwin (2007), What do we know about the profitability of technical analysis?, Journal of Economic Surveys: profits in older data, fading in recent decades; data snooping a major concern

## Rules (live signals)

| Rule | Indicator | Kind | Timeframes | Bullish | Bearish / neutral |
|---|---|---|---|---|---|
| `ema_stack` | moving_averages | trend | 15m, 1h, 4h | Price > EMA21 > EMA50: stacked uptrend. | Price < EMA21 < EMA50: stacked downtrend. |
| `ma_regime` | moving_averages | regime | 4h, 1d | Price above the 200-period SMA: long-term uptrend regime. | Price below the 200-period SMA: long-term downtrend regime. |
| `golden_death_cross` | moving_averages | trend | 1h, 4h, 1d | Golden cross: SMA50 crossed above SMA200. | Death cross: SMA50 crossed below SMA200. |
| `price_to_ma` | moving_averages | trend | 1h, 4h, 1d | Price above its 50-period MA (price-to-MA ratio > 1): trend support (Detzel et al.). | Price below its 50-period MA. |
| `adx_trend` | adx | trend | 15m, 1h, 4h | ADX > 25 and rising with +DI > -DI: strong uptrend. | ADX > 25 and rising with -DI > +DI: strong downtrend. |
| `adx_range` | adx | regime | 15m, 1h, 4h | — | ADX < 20: no trend; favour mean reversion, distrust breakouts. |
| `ichimoku_cloud` | ichimoku | trend | 1h, 4h, 1d | Above the Ichimoku cloud with Tenkan > Kijun: bullish equilibrium. | Below the cloud with Tenkan < Kijun: bearish equilibrium. |
| `ichimoku_tk_cross` | ichimoku | continuation | 1h, 4h | Tenkan crossed above Kijun above the cloud. | Tenkan crossed below Kijun below the cloud. |
| `bb_reversion` | bollinger | reversal | 5m, 15m, 1h | Below the lower Bollinger band in a range: stretched, bounce likely. | Above the upper band in a range: stretched, reversion likely. |
| `bb_band_walk` | bollinger | continuation | 15m, 1h, 4h | Walking the upper band in a strong trend: momentum, not a sell. | Walking the lower band in a strong downtrend. |
| `squeeze` | bollinger | volatility | 15m, 1h, 4h | — | Bollinger squeeze: volatility compressed, an expansion is due (direction unknown). |
| `squeeze_release` | bollinger | continuation | 15m, 1h, 4h | Squeeze released upward: expansion has begun to the upside. | Squeeze released downward. |
| `atr_regime` | atr | volatility | 15m, 1h | — | ATR at an extreme percentile: volatility regime change (size and stops adapt). |
| `rsi_extreme` | rsi | reversal | 5m, 15m, 1h, 4h | RSI < 30: oversold. | RSI > 70: overbought. |
| `rsi_divergence` | divergence | reversal | 15m, 1h, 4h | Bullish RSI divergence: price lower low, RSI higher low (selling exhausted). | Bearish RSI divergence: price higher high, RSI lower high (buying exhausted). |
| `rsi_hidden_divergence` | divergence | continuation | 1h, 4h | Hidden bullish RSI divergence: uptrend pullback likely to resume. | Hidden bearish RSI divergence: downtrend likely to resume. |
| `momentum_state` | rsi | trend | 15m, 1h, 4h | RSI > 50 and MACD histogram > 0: bullish momentum regime. | RSI < 50 and MACD histogram < 0: bearish momentum regime. |
| `macd_cross` | macd | reversal | 15m, 1h, 4h | MACD crossed above its signal line (strongest below zero). | MACD crossed below its signal line (strongest above zero). |
| `macd_hist_shift` | macd | reversal | 15m, 1h, 4h | Negative MACD histogram shrinking: bearish momentum decelerating. | Positive MACD histogram shrinking: bullish momentum decelerating. |
| `macd_divergence` | divergence | reversal | 1h, 4h | Bullish MACD-histogram divergence. | Bearish MACD-histogram divergence. |
| `stoch_cross_extreme` | stochastic | reversal | 5m, 15m, 1h | Stochastic %K crossed above %D below 20. | Stochastic %K crossed below %D above 80. |
| `williams_extreme` | stochastic | reversal | 5m, 15m, 1h | Williams %R below -80: oversold. | Williams %R above -20: overbought. |
| `obv_trend` | obv | trend | 1h, 4h | OBV rising: volume flowing in (accumulation if price is flat). | OBV falling: distribution. |
| `obv_divergence` | divergence | reversal | 1h, 4h | Price lower low without an OBV lower low: hidden demand. | Price higher high without an OBV higher high: rally lacks demand (bull trap). |
| `cmf_flow` | money_flow | trend | 15m, 1h, 4h | Chaikin money flow > 0.1: accumulation. | Chaikin money flow < -0.1: distribution. |
| `mfi_extreme` | money_flow | reversal | 15m, 1h | MFI < 20: volume-weighted oversold. | MFI > 80: volume-weighted overbought. |
| `mfi_divergence` | divergence | reversal | 1h, 4h | Bullish MFI divergence. | Price rising while MFI falls: volume behind the rally deteriorating. |
| `volume_surge` | obv | continuation | 5m, 15m, 1h | Volume > 2x average on an up bar: conviction buying. | Volume > 2x average on a down bar: conviction selling. |
| `vwap_side` | vwap | trend | 5m, 15m, 1h | Above the session VWAP: intraday buyers in control. | Below the session VWAP: sellers in control. |
| `vp_acceptance` | volume_profile | continuation | 15m, 1h | Accepted above the value-area high: value migrating up. | Accepted below the value-area low: value migrating down. |
| `vp_80_rule` | volume_profile | reversal | 15m, 1h | 80% rule: back inside value from below; rotation toward the VAH expected. | 80% rule: back inside value from above; rotation toward the VAL expected. |
| `poc_magnet` | volume_profile | reversal | 15m, 1h | Below the point of control inside value: fair-value magnet pulls up. | Above the point of control inside value: magnet pulls down. |
| `lvn_rejection` | volume_profile | reversal | 15m, 1h | Wick rejected from a low-volume node below value: snap-back into value. | Wick rejected from a low-volume node above value. |
| `market_structure` | market_structure | trend | 15m, 1h, 4h | Higher highs and higher lows. | Lower highs and lower lows. |
| `bos` | market_structure | continuation | 15m, 1h, 4h | Break of structure up: uptrend continues. | Break of structure down: downtrend continues. |
| `choch` | market_structure | reversal | 5m, 15m, 1h | Change of character: first break above a swing high in a downtrend. | Change of character: first break below a swing low in an uptrend. |
| `liquidity_sweep` | liquidity | reversal | 15m, 1h, 4h | Liquidity sweep of the lows: stops harvested, closed back inside (reversal up). | Liquidity sweep of the highs: closed back inside (reversal down). |
| `true_breakout` | liquidity | continuation | 15m, 1h, 4h | True breakout up: solid body on volume. | True breakdown: solid body on volume. |
| `donchian_breakout` | breakout | continuation | 15m, 1h, 4h | Close above the 20-bar high. | Close below the 20-bar low. |
| `fvg_retest` | liquidity | continuation | 15m, 1h | Retesting an unfilled bullish fair value gap (support). | Retesting an unfilled bearish fair value gap (resistance). |
| `equal_levels` | liquidity | regime | 1h, 4h | — | Equal highs/lows nearby: resting stop liquidity that is likely to be swept. |
| `engulfing` | candles | reversal | 15m, 1h, 4h | Bullish engulfing candle. | Bearish engulfing candle. |
| `pin_bar` | candles | reversal | 15m, 1h, 4h | Hammer / bullish pin bar: lower prices rejected. | Shooting star / bearish pin bar: higher prices rejected. |
| `doji` | candles | volatility | 1h, 4h | — | Doji: indecision / momentum exhaustion. |
| `round_number_break` | round_numbers | continuation | 15m, 1h | Crossed above a round number: stops beyond it fuel the move. | Crossed below a round number: stops beyond it fuel the move. |
| `round_number_barrier` | round_numbers | reversal | 15m, 1h | — | Within 0.25 ATR of a round number: take-profit orders cluster there (stall risk). |
| `dominance_matrix` | dominance_matrix | regime | 1h | Dominance matrix bullish for this asset (risk-on / altseason quadrant). | Dominance matrix bearish for this asset (risk-off / distribution quadrant). |

## Confluences

### Volatility Reversal Matrix (15m) (`volatility_reversal_15m`)

Source: PDF section 8. Needs 3 of 5 members agreeing, including `liquidity_sweep`.

Members: `liquidity_sweep@15m`, `lvn_rejection@15m`, `rsi_divergence@1h`, `macd_hist_shift@15m`, `macd_cross@15m`

- Bullish: Sweep of the lows rejected at a low-volume node, RSI divergence and MACD turning: high-probability reversal up.
- Bearish: Sweep of the highs rejected at a low-volume node, RSI divergence and MACD turning: high-probability reversal down.

### Volatility Reversal Matrix (1h) (`volatility_reversal_1h`)

Source: PDF section 8. Needs 3 of 5 members agreeing, including `liquidity_sweep`.

Members: `liquidity_sweep@1h`, `lvn_rejection@1h`, `rsi_divergence@4h`, `macd_hist_shift@1h`, `macd_cross@1h`

- Bullish: Hourly sweep-and-reclaim with momentum exhaustion: reversal up.
- Bearish: Hourly sweep-and-reject with momentum exhaustion: reversal down.

### Smart-money reversal (sweep, CHoCH, FVG) (`smc_reversal`)

Source: PDF section 6.1. Needs 2 of 5 members agreeing, including `choch`.

Members: `liquidity_sweep@1h`, `liquidity_sweep@15m`, `choch@15m`, `choch@5m`, `fvg_retest@15m`

- Bullish: Lows swept, structure flipped up on the lower timeframe, pullback into the gap: reversal entry.
- Bearish: Highs swept, structure flipped down, pullback into the gap: reversal entry.

### Trend alignment (`trend_alignment`)

Source: PDF sections 1.1-1.3 + 3.2. Needs 4 of 6 members agreeing.

Members: `ema_stack@1h`, `adx_trend@1h`, `ichimoku_cloud@4h`, `market_structure@1h`, `momentum_state@1h`, `price_to_ma@4h`

- Bullish: Moving averages, ADX, cloud, structure and momentum all agree: established uptrend.
- Bearish: Every trend tool agrees: established downtrend.

### Squeeze breakout (1h) (`squeeze_breakout_1h`)

Source: PDF 2.1 squeeze + 6.1 true breakout. Needs 2 of 5 members agreeing, including `squeeze_release`.

Members: `squeeze_release@1h`, `true_breakout@1h`, `donchian_breakout@1h`, `volume_surge@1h`, `adx_trend@1h`

- Bullish: Volatility compression released upward with a real breakout: expansion up.
- Bearish: Compression released downward with a real breakdown: expansion down.

### Squeeze breakout (15m) (`squeeze_breakout_15m`)

Source: PDF 2.1 + 6.1. Needs 2 of 4 members agreeing, including `squeeze_release`.

Members: `squeeze_release@15m`, `true_breakout@15m`, `donchian_breakout@15m`, `volume_surge@15m`

- Bullish: 15-minute squeeze released upward with a breakout.
- Bearish: 15-minute squeeze released downward with a breakdown.

### Range mean reversion (`range_reversion`)

Source: PDF 1.2 (ADX < 20) + 2.1 + 3.1 + 3.3. Needs 3 of 6 members agreeing, including `adx_range`.

Members: `adx_range@1h`, `stoch_cross_extreme@15m`, `bb_reversion@15m`, `rsi_extreme@15m`, `williams_extreme@15m`, `mfi_extreme@15m`

- Bullish: Ranging market at an oversold extreme with oscillators turning: fade down, expect a bounce.
- Bearish: Ranging market at an overbought extreme: fade the rally.

### Volume confirms the move (`volume_confirmation`)

Source: PDF section 4. Needs 3 of 4 members agreeing.

Members: `obv_trend@1h`, `cmf_flow@1h`, `vwap_side@15m`, `market_structure@1h`

- Bullish: Price structure up with OBV, money flow and VWAP behind it: organic demand.
- Bearish: Structure down with volume flowing out: organic supply.

### Momentum exhaustion (multi-oscillator divergence) (`exhaustion`)

Source: PDF 3.1, 3.2, 4.1, 4.2. Needs 2 of 4 members agreeing.

Members: `rsi_divergence@1h`, `macd_divergence@1h`, `obv_divergence@1h`, `mfi_divergence@1h`

- Bullish: Several oscillators diverge from the new low: sellers exhausted.
- Bearish: Several oscillators diverge from the new high: buyers exhausted, bull-trap risk.

### Value-area rotation (80% rule) (`value_area_rotation`)

Source: PDF 5.1-5.2. Needs 2 of 4 members agreeing, including `vp_80_rule`.

Members: `vp_80_rule@15m`, `vwap_side@15m`, `momentum_state@15m`, `poc_magnet@15m`

- Bullish: Back inside value from below with VWAP/momentum support: rotation toward the VAH.
- Bearish: Back inside value from above: rotation toward the VAL.

### Multi-timeframe momentum (`mtf_momentum`)

Source: cross-reference (time-series momentum). Needs 3 of 3 members agreeing.

Members: `momentum_state@15m`, `momentum_state@1h`, `momentum_state@4h`

- Bullish: RSI and MACD bullish on 15m, 1h and 4h.
- Bearish: RSI and MACD bearish on 15m, 1h and 4h.

### Macro rotation confirmed on the chart (`macro_rotation`)

Source: PDF section 9.2. Needs 2 of 4 members agreeing, including `dominance_matrix`.

Members: `dominance_matrix@1h`, `momentum_state@1h`, `market_structure@1h`, `vwap_side@15m`

- Bullish: Dominance quadrant favours this asset and the chart agrees.
- Bearish: Dominance quadrant is against this asset and the chart agrees.

### Higher-timeframe regime (`macro_trend`)

Source: PDF 1.1 + 1.3 (daily/4h). Needs 3 of 4 members agreeing.

Members: `ma_regime@1d`, `ema_stack@4h`, `ichimoku_cloud@1d`, `ma_regime@4h`

- Bullish: Daily and 4-hour regime bullish: trade with it.
- Bearish: Daily and 4-hour regime bearish.

