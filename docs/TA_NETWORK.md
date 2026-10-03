# Historical data and the TA network

The TA network is a fourth learned model, trained on years of exchange history instead of the bot's own recordings. It reads its inputs in five separate branches (docs/EVOLUTION.md, Phase 2):

| Branch | Input | Layer |
|---|---|---|
| Micro | last 32 fifteen-minute bars (return, range, close position, volume, taker order flow) | fractal convolution block |
| Swing | last 48 raw hourly bars (same five readings) | fractal convolution block |
| Trend | last 12 hourly steps of the whole TA library (every 1h and 4h indicator and structure reading, every rule signal and confluence score) | GRU |
| Macro | last 30 daily steps (daily TA readings, daily returns, volatility) | attention |
| Context | one vector at the forecast hour: the TA library on 15-minute bars, BTC and the whole market, Binance's BTC dominance index, the BTC.D × USDT.D quadrant, and TA on the BTC.D and USDT.D daily charts | dense layer |

At the close of every hourly bar it forecasts:

| Output | Meaning |
|---|---|
| `up_1h` | Probability the spot price is higher one hour later |
| `up_4h` | Probability it is higher four hours later |
| `vol_4h` | How much the next 4 hours' realised volatility will differ from the last 24 hours' (log ratio) |

**How it's chosen:** a tournament of three identical networks with slightly different settings, walk-forward month by month over the history. The surviving elite is the network the bot uses (docs/EVOLUTION.md).

Its forecasts become features (`tanet_*`) for three decision models:
- the crypto MLP (hourly ladders and 15-minute contracts),
- the perps model (1h and 4h holds),
- the volatility forecast.

Each of those models keeps the features only if its own validation improves with them. The network never trades by itself.

### Market context: BTC, the market, BTC dominance and USDT dominance

Every coin's forecast also sees the market around it. All of it is computed the same way from history in training and from the live feeds, and never from anything after the bar being forecast.

| Input | What it is | History | Live |
|---|---|---|---|
| BTC | BTC's own moves over 1h, 4h, 24h and 7 days, and its position in its 24h range | every coin in the store | the bot's Coinbase candles |
| Strength against BTC | the coin's move minus BTC's (for BTC: BTC minus the alt basket), over the same spans. This is BTC dominance at the level of one coin: "is this alt beating BTC?" | same | same |
| Market momentum and breadth | the average move of every tracked coin, and the share of coins up over 4h and 24h. USDT.D's hour-to-hour moves are mostly the inverse of total crypto market cap (USDT's own cap barely moves within a day), so this stands in for USDT.D at the hourly scale | same | same |
| BTCDOM | Binance's BTC dominance index: BTC priced against a market-cap-weighted basket of the top 20 altcoins, stablecoins excluded. Rising = BTC beating the alts. Its moves and TA readings (trend, RSI, MACD, structure), flipped for alts | Binance index history, hourly since June 2021 (downloaded with `history.sh binance`) | rebuilt every second from Binance spot prices and CoinGecko market caps (Binance's futures API refuses US servers), continuing from the stored level |
| Dominance quadrant | the knowledge base's BTC.D × USDT.D matrix (altseason, risk-on for BTC only, risk-off, distribution) at the 4h and 24h scale, from BTCDOM and market momentum. The 4h reading is also handed to the TA library, so the `dominance_matrix` rule and the `macro_rotation` confluence now fire | same | same |
| Daily BTC.D and USDT.D | the TA library on the real dominance charts as of the last closed day: trend, RSI, MACD, structure, distance to the 50/200-day averages and to round numbers, 1/5/20-day changes (BTC.D flipped for alts) | TradingView's charts, a one-off export (below) | the bot's own dominance feed, recorded as hourly bars and lined up with TradingView's levels |

**Continuous OBV divergence.** Besides the on/off divergence flags, every timeframe has a divergence *strength* between the last two confirmed swings (a swing counts only once 3 bars after it exist): tanh(0.25 × price move in ATRs + OBV move ÷ volume traded between the swings), fading with the swing's age. `obv_div` is regular divergence (price lower low + OBV higher low = bullish, mirror bearish), `obv_hdiv` hidden (price higher low + OBV lower low = bullish continuation). The pattern report showed the fractal blocks never rebuild divergences from raw bars, so the library is their only source.

**The 15-minute TA library.** Every indicator and structure reading is also computed on the last 256 fifteen-minute bars, so the six confluences built on 15-minute members (squeeze breakout, value-area rotation, volatility reversal, range reversion, SMC reversal, multi-timeframe momentum) now fire in training. With the dominance quadrant, all 13 confluences are live in the network.

**Why a separate context branch.** Feeding these ~120 extra readings into every one of the GRU's 12 hourly steps slowed learning: on a planted-signal test the hit rate fell from 57% to 52% even with the new inputs empty. Read once, through a small dense layer with its own weight and dropout, they cost far fewer weights, and the planted-signal result is back to 57%.

**TradingView history (tvdatafeed).** `deploy/tv_history.py` uses tvdatafeed (an unofficial TradingView client, no login) for two jobs, and the daily pipeline runs both in its history step (`TV_FILL=true`, the default):
- **Index series, 5,000 bars each** (tvdatafeed's maximum) at 1d, 4h and 1h. The symbols are BTC.D, USDT.D, TOTAL3 (crypto market cap without BTC and ETH) and OTHERS.D (the share outside the top 10), all from CRYPTOCAP, and RTY, the US Russell 2000 (the first of TVC:RUT, RUSSELL:RUT, CME_MINI:RTY1! and AMEX:IWM that answers). A series with fewer than 3,000 daily bars gets the full backfill. TOTAL3, OTHERS.D and RTY have no live feed in the bot, so their last 40 daily bars are refreshed whenever the newest is more than 2 days old (4 for RTY, which skips weekends). BTC.D and USDT.D stay current from the bot's own dominance feed.
- **Gap filling for every coin.** Each run checks every timeframe (15m, 1h, 4h, 1d) of every coin for missing bars within tvdatafeed's 5,000-bar reach, leaving out the last 3 days, which the exchange archives haven't published yet. The worst 20 get that window from the first venue that has the pair (Coinbase, Binance, Bitstamp, Kraken). The bars are stored as source `tvspot`, which fills the missing bars only, including inside the exchanges' own spans, and never replaces an exchange's bar. A hole TradingView can't fill either (an outage on every venue) is retried weekly instead of daily.

```bash
bash ~/bot/current/deploy/history.sh tradingview   # on the server, now: index backfill (installs tvdatafeed in a venv), then import
bash ~/bot/current/deploy/history.sh tvfetch --out ~/incoming/tv --spot BTC:1h,SOL:15m   # spot bars for named holes
```

The importer files `CRYPTOCAP_*` and `TVINDEX_*` exports (also TradingView's own "Export chart data" CSVs) as index series, never as coins. The deploy installs python3-venv and git on the server. Downloading through an unofficial client is against TradingView's terms, so the pipeline only asks for what is missing or stale. If TradingView blocks the server's address, the step reports it and the bot carries on with what it has.

**TA-Lib inputs.** The core indicators come from TA-Lib (docs/TA_LIBRARY.md, "Engine"). Of its extra readings, the network takes a compact set per timeframe through the context branch: the candlestick net score (last bar and last 3 bars), CCI, the Aroon oscillator, the Ultimate Oscillator, distance to the Parabolic SAR, the Hilbert trend mode, and distance to KAMA. With all ~170 TA-Lib extras, the tournament test's planted signal was no longer learned (holdout hit rate 50%, against 52%+ with the compact set), the same overfitting the market context caused before it got its own branch. The setup scorer, a tree model, gets every TA-Lib reading.

**Slow context: TOTAL3, OTHERS.D, RTY.** The same daily readings as BTC.D and USDT.D (1/5/20-day changes plus trend, momentum, structure and moving-average distances) are added to the context branch for these three series. They're there for the network to find patterns and extra confluence, not as rules. They lag one extra day (the bar that closed a day before the dominance bars), so live always has the bar training had, even before the daily refresh. RTY's last bar carries for up to 4 days, covering weekends and holidays. Signs: TOTAL3 and RTY up = risk-on for every coin; OTHERS.D up = small alts outperforming (bullish alts, bearish BTC relative).

When new context history arrives (BTCDOM for the first time, or the TradingView export), every past row changes, so the next pipeline run starts the tournament afresh to learn from it.

### Fractal blocks: one block, three pattern scales

The micro and swing branches each use a **fractal convolution block** (FractalNet, the "fractal" half of the fractal SNN paper). It is built by one rule: a block of depth C+1 is the average of a single convolution and two depth-C blocks in series. At depth 3 that gives three parallel columns of causal convolutions, joined where they meet:

| Column | Convolutions | Sees the last | Pattern scale it can learn |
|---|---|---|---|
| 1 | 1 | 3 bars | single candles and pairs: engulfing, pin bars, dojis, volume spikes |
| 2 | 2 | 7 bars | short structure: breakouts, sweeps, break of structure, momentum bursts |
| 3 | 4 | 31 bars | swing and chart-pattern scale: divergences, squeezes, ranges, trend legs |

On the hourly swing branch 31 bars is about 1.3 days; on the 15-minute branch about 8 hours.

**Drop-path** (training only): at every join each input is dropped at random (at least one stays), and half the samples keep just one random column through the whole block. So no column can lean on another; each depth has to work on its own. Whole branches are also dropped now and then (`pBranch`). The tournament mutates both probabilities.

**Which depth carries which pattern (the pattern report).** Because each column works alone, the trainer can switch the others off and measure each depth on the holdout. For each block and column it records:
- the holdout loss with only that column active (`ablation`), and
- the strongest correlation between that column's outputs and each family of TA library readings: candlesticks (engulf, pin, doji), structure (trend, BOS, CHoCH, sweep, breakout, equal highs/lows, Donchian), momentum (RSI, MACD, stochastic, Williams %R), divergences, volatility (squeeze, Bollinger width, ATR rank), volume and flow (volume ratio, OBV, CMF, MFI, taker flow), levels (round numbers, volume profile, FVGs), and 4h structure.

The report is saved in the model file (`patterns`) and printed in the training log, for example `swing momentum: best tracked by column 1 (3 bars), |corr| 0.80`. How to read it:
- High correlation with a family means that depth has learned to see what the TA library already computes. That is consistent, but the network gets no new information from it.
- A column that **lowers the holdout loss on its own but correlates weakly** with every family has found something the library does not encode. That is the interesting case, and the place to look for a new hand-written pattern.
- A column that does neither is dead weight at that scale.

It is a diagnostic, not a trading gate: the heads still speak only after the holdout and hurdles.

### Order flow (taker buy vs sell)

Every candle can carry `tb`, the volume bought by aggressive (taker) buyers. Order-flow imbalance = 2 × tb / volume − 1, from −1 (all selling) to +1 (all buying).
- **History:** Binance klines include taker-buy volume (column 10). Bars from sources without it (Coinbase, Bittrex) borrow Binance's taker-buy share for the same hour when it exists.
- **Live:** Coinbase REST candles have no split, so the bot listens to Coinbase's public trade feed (`matches`) and counts buyer-initiated volume per 15 minutes. A bar is only reported if the feed was connected for the whole of it. After a restart, 15-minute flow appears after the first full bar, hourly flow after an hour, and the 24-hour reading after a day; until then those inputs count as missing.
- **Where it's used:** the network's micro and swing bars (fifth reading), its hourly features `flow_1h/4h/24h/flow_chg`, and the decision-model features `ta_taker_imb_15m/1h/4h/24h` (the perps model uses the 1h and 4h ones).

Re-run `history.sh binance` once after this update so the stored Binance files gain the `tb` column.

## 1. Getting the data

Everything goes into one store: `data/history/<source>/<ASSET>/<tf>.csv` (on the server, `~/bot/data/history`). Every row is one bar stamped with its **open** time in UTC.

### a. Binance Vision (free, automatic)

Downloads Binance's public kline archives for **every crypto asset Kalshi lists**, in both its binary price series (15-minute, hourly, daily) and its perpetuals. Each archive is checked against Binance's published SHA-256 checksum. Re-running only fetches what's new.

```bash
# on the server
bash ~/bot/current/deploy/history.sh binance                         # Kalshi assets, 1h + 15m + 1d
bash ~/bot/current/deploy/history.sh binance --assets BTC,ETH,SOL --intervals 1h,15m
bash ~/bot/current/deploy/history.sh binance --dry-run              # just list what it would fetch
# from a checkout
npm run history:binance
```

`--markets um` also downloads USD-M perpetual futures. They are stored separately (`binance-um`) and never mixed into the spot series.

### b. Coinbase backfill (free, automatic)

Coinbase is the exchange closest to the CF Benchmarks indices Kalshi settles on. The bot already polls it live.

```bash
bash ~/bot/current/deploy/history.sh coinbase --tfs 15m,1h,1d
npm run history:coinbase -- --assets BTC,ETH --tfs 15m,1h
```

### c. Your own CSV files (Bittrex, Yahoo, CryptoDataDownload, anything with OHLC columns)

Copy them to the server, then import:

```bash
ssh ubuntu@54.145.7.203 mkdir -p ~/incoming
scp *.csv ubuntu@54.145.7.203:~/incoming/
ssh ubuntu@54.145.7.203 'bash ~/bot/current/deploy/history.sh import ~/incoming'
# from a checkout
npm run history:import -- path/to/folder
```

The importer recognises these formats from the file contents:
- **Binance** archives: zipped or plain CSV, millisecond or microsecond timestamps.
- **CryptoDataDownload**, including their Bittrex, Bitstamp, Gemini and Coinbase files.
- **Yahoo Finance**: daily, intraday, and the multi-row header yfinance writes.
- **Bittrex API** exports.
- **Coinbase API** rows.
- **Any other CSV** with a time column and open/high/low/close columns.

It reads the asset and timeframe from the file name or the symbol column. If it can't tell, pass `--asset BTC --tf 1h`. Only USD-quoted pairs are accepted (USD, USDT, USDC and similar).

For every file it:
1. Drops impossible bars (high below low, zero prices) and duplicates.
2. Reports gaps, suspicious jumps and bars not on the hour.
3. **Checks the clock against what's already stored from other sources.** If a file is stamped with bar close times instead of open times, it lines up one bar off. The import is then refused, because training on it would leak the future into the past. The error message tells you the fix, e.g. `--shift-bars -1`.

### d. What's stored

```bash
bash ~/bot/current/deploy/history.sh status
```

This lists every series and shows how the network will see each asset. When several sources cover the same asset, the best one keeps its whole time span. The order is Coinbase, then Binance, then the others, then Bittrex, then Yahoo. A lower-ranked source only fills time **before or after** that span, never bars inside it. Mixing exchanges bar by bar would create fake price jumps. So your Bittrex 2018 files extend the history back before the Binance or Coinbase data starts. Hourly files are also combined into 4h and daily bars where no daily file exists.

## 2. Training: the tournament

The pipeline does it automatically:
- Step `history` refreshes Binance and Coinbase data every day (if the server has internet access).
- Step `ta_net` runs the tournament. The first time, it covers years of history, spread over several daily runs (36 rounds per run by default). Afterwards it continues month by month every 7 days.
- Nothing is promoted until the tournament has reached the present.
- After an update that changes the network's inputs (like this one: schema 3), the old promoted model can't be loaded. The bot uses the shipped `params/ta_net.json` instead, and the pipeline starts a new tournament on the server's own history. The bot switches to the server's model once that tournament reaches the present and passes.

To run it now:

```bash
bash ~/bot/current/deploy/history.sh train          # through the pipeline: validated, promoted, hot-swapped
npm run research:ta-net                         # from a checkout, writes params/ta_net.json
npm run pipeline -- --fresh-ta-net              # restart the tournament from scratch
```

What it does:
1. **Inputs.** For every closed hourly bar it builds the five branch inputs, using the same windows the live bot has: 280 hourly bars (the last 48 also raw, for the swing branch), 4h built from them, 250 daily bars, 256 fifteen-minute bars (the last 32 also raw), every coin's hourly bars for the market context, BTCDOM and the daily dominance charts. All assets are pooled, because every input is scale-free. Hourly rows are cached, so re-runs only compute new bars.
2. **Tournament.** Three identical networks with slightly different settings train on a rolling 12-month block and are scored on the next month. Each one trades its own forecasts as triple-barrier trades (López de Prado): every hour a 4-hour trade sized by quarter-Kelly on P(up in 4h), with take-profit and stop at ±1 forecast 4-hour standard deviation and a 4-hour time limit. The first barrier touched decides (a bar touching both counts as the stop; a gap through a barrier exits at the open), with 5 bp costs on entry and exit. This scores the path of a trade, not one hourly close. A trade is only taken when |P(up in 4h) − 0.5| ≥ `minEdge`, a confidence threshold the tournament tunes (0.002–0.15): fewer, surer trades instead of every hour. Results report the win rate on trades taken, with a 95% interval, and the share of hours traded. Fitness = Sortino − 5 × max drawdown − 5 × costs. Each month the elite survives, the worst copies it, and the middle one and the copy get mutated (learning rate, weight decay, the weight of each branch, the vol head's weight, the drop-path probabilities). Every 6th round the worst network instead restarts from scratch with random settings (the exploration member). Then everything rolls forward one month.
3. **Hurdles.** The elite's out-of-sample record is clustered so that one continuous position counts as one interaction. It must pass the deflated Sharpe ratio, with every member evaluation counted as a trial, and hold at least 100 independent interactions in every regime it covers.
4. **Unseen holdout.** The last 3 months are never touched. Each head is graded there against the naive forecast. The volatility head speaks live if it beats it. The direction heads also need step 3's hurdles.
5. **Frozen final window.** The most recent `TA_NET_FINAL_MONTHS` (2) are carved out after the holdout and never used for training or selection. Every head must also hold up there (mean improvement over the naive forecast above zero). A ledger counts how often each final window has been evaluated; the log says when a window has been seen before and is no longer an unseen test.
6. **Live forward test.** The bot trades the elite's triple-barrier rule on paper for 90 days. If that fails, the direction heads go silent.

6. **Pattern report.** The elite is run on the holdout with one fractal column at a time (see above).

Live, every forecast is also graded against the candles that follow. `tanet_skill_1h` and `tanet_skill_4h` are the network's rolling skill over its last 168 graded calls.

## 3. Real results: AdamW, OBV divergence, triple-barrier fitness, confidence threshold (schema 5; Binance spot + BTCDOM, BTC/ETH/SOL/XRP/DOGE, Aug 2017 – Oct 2026)

**Setup:** 83 monthly rounds (249 member evaluations), AdamW, continuous OBV divergence, triple-barrier trades as the fitness, the confidence threshold `minEdge` evolved by the tournament. Untouched holdout 2026-05-02 to 2026-08-02; frozen final window 2026-08-02 to 2026-10-02, evaluated once.

| Check | Result | Passes |
|---|---|---|
| Holdout, `vol_4h` | MSE 0.330 vs 0.413 (20% lower), CI +0.060 to +0.109; holds on the final window | **yes: speaks live** |
| Holdout, `up_1h` | log loss 0.69261 vs 0.69316, CI −0.0012 to +0.0021, hit rate 50.9% | no |
| Holdout, `up_4h` | log loss 0.69276 vs 0.69296, CI −0.0039 to +0.0039, hit rate 52.0% | no |
| Barrier trades taken (holdout and final window) | 0 of 11,040 and 0 of 7,300 hours | no (see below) |
| Deflated Sharpe | no out-of-sample trades to test | no |

**The tournament learned to sit out.** A month with no trades scored 0, which beat every member that traded and lost, so `minEdge` climbed from 0.02 to 0.14 (trade only when P(up in 4h) is below 36% or above 64%). The network's largest holdout edge was 0.116, so the elite never traded. From round 79 on, members that took no trades won every round. Fixed: a member that trades fewer than 5% of the hours now scores up to −10 (`coverageFloor` in `research/trainTaNet.ts`), so sitting out ranks below trading and losing.

**Selective trading would not have helped either.** The elite's holdout win rate by confidence (diagnostic on the holdout only; the final window stays unseen):

| Hours traded (most confident) | Trades | Win rate (95% CI) | Net |
|---|---|---|---|
| top 50% | 5,521 | 50.6% (49.3–52.0) | −29.9% |
| top 20% | 2,209 | 51.2% (49.1–53.2) | −10.5% |
| top 10% | 1,105 | 49.4% (46.5–52.4) | −7.4% |
| top 5% | 553 | 51.2% (47.0–55.3) | −2.9% |
| top 1% | 112 | 57.1% (47.9–65.9) | −0.3% |

Every interval includes 50%. Higher confidence does not mean more wins, so the direction heads are not calibrated: the network is not more often right when it is surer. Costs make every slice lose.

AdamW did its job on the weights: the elite's branch gates stayed balanced (micro 0.94, swing 1.05, trend 0.85, daily 1.82, context 0.31), and the volatility forecast is the best so far (0.330, against 0.376 in schema 4 and 0.361 in schema 3). But the pattern report's direction log loss is 0.69315 with every column, which is exactly a coin flip, so no single pattern scale carries direction either.

## 3a. Real results: market context and BTC dominance (schema 4; Binance spot + Binance's BTCDOM index, BTC/ETH/SOL/XRP/DOGE, Aug 2017 – Oct 2026)

**Setup:** 85 monthly rounds (255 member evaluations), exploration restarts with the grace period and catch-up epochs, untouched holdout 2026-07-02 to 2026-10-02. Context: the 5-coin basket and BTCDOM from June 2021. No TradingView BTC.D / USDT.D history was available for this run, so the daily dominance inputs were empty; the server's tournament adds them once `history.sh tradingview` has run.

| Check | Result | Passes |
|---|---|---|
| Holdout, `vol_4h` | MSE 0.376 vs 0.434 (13% lower), CI +0.035 to +0.084 | **yes: speaks live** |
| Holdout, `up_1h` | log loss 0.6963 vs 0.6932, hit rate 50.0% | no |
| Holdout, `up_4h` | log loss 0.7098 vs 0.6936, hit rate 49.4% | no |
| Elite lineage's out-of-sample record | Sharpe −0.42 vs 0.18 expected from luck with 255 trials; DSR probability 0.00 | no |
| Holdout, position rule | net −10.0%, max drawdown 20.3% | no |

The elite's branch weights: daily 2.0 (the maximum), hourly swing 1.67, hourly TA 1.36, 15-minute 0.83, market context 0.39 (turned down). Its learning rate hit the maximum (0.01), and the 15-minute and swing blocks' input weights decayed to almost zero, so this model's pattern report is close to empty (schema 3's report below is the informative one). The cause is L2 regularisation applied inside Adam: for weights with a weak learning signal, Adam rescales the shrinkage into full-size steps toward zero. Decoupled weight decay (AdamW) is the standard fix.

The context did not add a measurable edge on this holdout: the volatility forecast is within noise of schema 3's (0.376 vs 0.361, overlapping intervals), and direction is still a coin flip.

## 3b. Real results: fractal network with order flow (schema 3; Binance spot with taker volume, BTC/ETH/SOL/XRP/DOGE, Aug 2017 – Oct 2026)

**Setup:** 85 monthly rounds (255 member evaluations), exploration restarts every 6 rounds, untouched holdout 2026-07-02 to 2026-10-02. The last 10 rounds already ran with the newcomer grace period and catch-up epochs: the round-77 newcomer won round 78 outright.

| Check | Result | Passes |
|---|---|---|
| Holdout, `vol_4h` | MSE 0.361 vs 0.434 (17% lower), CI +0.046 to +0.105 | **yes: speaks live** |
| Holdout, `up_1h` | log loss 0.6946 vs 0.6932, hit rate 51.7% | no |
| Holdout, `up_4h` | log loss 0.7151 vs 0.6936, hit rate 51.4% | no |
| Elite lineage's out-of-sample record | Sharpe −0.55 vs 0.26 expected from luck with 255 trials; DSR probability 0.00 | no |
| Holdout, position rule | net −11.7% (schema 2: −26%), max drawdown 20.3% | no |

The elite's branch weights: 15-minute 0.30 (turned down again), hourly swing 1.03, hourly TA 0.68, daily 1.60.

**Pattern report** (holdout, 5,520 rows): the strongest correlation between any one fractal column's output and each TA pattern family.

| Pattern family | 15-minute block: best column | Hourly swing block: best column |
|---|---|---|
| Candlesticks | 3 bars (0.30) | 3 bars (0.33) |
| Structure (BOS, CHoCH, sweeps) | 3 bars (0.29) | 3 bars (0.27) |
| Momentum (RSI, MACD, stochastic) | 3 bars (0.54) | 3 bars (0.37) |
| Divergences | 7 bars (0.11) | 3 bars (0.16) |
| Volatility (squeeze, band width, ATR rank) | 7 bars (0.21) | **31 bars (0.62)** |
| Volume and order flow | 3 bars (0.65) | 3 bars (0.71) |
| Levels (round numbers, volume profile, FVGs) | 3 bars (0.34) | 31 bars (0.34) |
| 4h structure | 3 bars (0.16) | 31 bars (0.27) |

With one column at a time, holdout `up_1h` log loss is 0.6947–0.6952 for every column (all columns: 0.6948; coin flip: 0.6932), and `vol_4h` MSE is 0.3601 for the 3-bar 15-minute column alone (all columns: 0.3601) up to 0.3616 for the 31-bar hourly column.

What it means:
- **Depth specialises.** The 3-bar columns carry candle patterns, momentum and order flow; the 31-bar hourly column carries the volatility regime, levels and 4h structure.
- **Divergences are not rebuilt** by any column (0.16 at most): they need an indicator compared across two swings, which small convolutions over raw bars don't reconstruct. The library's divergence readings are the only source of that information.
- **No column has a direction edge**, alone or together. The volatility forecast comes from the short columns; the deep ones add nothing to it.

## 3c. Real results of the first tournament (schema 2, before the fractal blocks and order flow; Binance spot, BTC/ETH/SOL/XRP/DOGE, Aug 2017 – Oct 2026)

**Setup:** 85 monthly rounds from mid-2019 to June 2026, 255 member evaluations (trials), and an untouched holdout from 2026-07-02 to 2026-10-02.

The elite's settings after evolution:

| Knob | Value |
|---|---|
| learning rate | 0.00062 |
| L2 | 0.00051 |
| 15m branch weight | 0.25 (the minimum: the tournament mostly switched the 15-minute branch off) |
| hourly branch weight | 0.66 |
| daily branch weight | 0.82 |

| Check | Result | Passes |
|---|---|---|
| Elite lineage's out-of-sample record | 544 independent interactions over 6 regimes, Sharpe −0.14 vs 0.12 expected from luck with 255 trials; deflated Sharpe probability 0.00 | no |
| Holdout, position rule | Sortino −4.0, max drawdown 29.6%, net −26% | no |
| Holdout, `up_1h` | log loss 0.6994 vs 0.6932 (coin flip), hit rate 51.6% | no: silent live |
| Holdout, `up_4h` | log loss 0.7289 vs 0.6936, hit rate 51.4% | no: silent live |
| Holdout, `vol_4h` | mean squared error 0.349 vs 0.434 (20% lower), CI +0.054 to +0.118 | **yes: speaks live** |

**What this means:**
- **The volatility forecast is real.** It held up through a tournament it wasn't selected on, and on three months nobody touched. It feeds the vol model and the perps model as a feature.
- **No direction edge after costs, so direction is switched off.** Trading the network's 1h/4h direction calls lost money once costs and selection bias were counted. The earlier single-model test showed a 52% hit rate on 1-hour direction. Under this protocol that did not survive: it loses after a 5 bp cost, and with 255 trials counted the deflated Sharpe rejects it outright. This is the protocol doing its job.
- **Selection was on the trading strategy.** Fitness was the direction strategy, so the vol head rode along rather than being selected on. A future change could add a volatility-scored fitness.

This model ships as `params/ta_net.json`. The server's pipeline continues the tournament on every Kalshi crypto asset (with your Bittrex CSVs adding 2016–2018) and re-runs these checks. The pipeline report (`data/models/reports/`) and `GET /api/status` → `treeModels.taNet` show the numbers for the model actually running.

## Settings (`bot.env`)

| Variable | Default | Meaning |
|---|---|---|
| `TA_NET` | `true` | Compute the network's forecasts as features. |
| `TA_NET_PATH` | `params/ta_net.json` | Fallback model file (the pipeline's `data/models/ta_net.json` is preferred). |
| `TA_NET_REQUIRE_VALIDATED` | `true` | Only heads that passed the blind test speak. |
| `TA_NET_RETRAIN_DAYS` | `7` | Continue the tournament at most this often (daily while the first one is still running). |
| `TA_NET_TRAIN_MONTHS` / `TA_NET_EVAL_MONTHS` / `TA_NET_STEP_MONTHS` | `12` / `1` / `1` | Tournament blocks. |
| `TA_NET_HOLDOUT_MONTHS` | `3` | Never touched by the tournament. |
| `TA_NET_FINAL_MONTHS` | `2` | Frozen final window after the holdout; every head must also hold up there (0 = off). |
| `TA_NET_STRIDE` | `2` | Train on every 2nd hourly sample. |
| `TA_NET_MIN_PER_REGIME` / `TA_NET_DSR` | `100` / `0.95` | Statistical hurdles for the direction heads. |
| `TA_NET_FORWARD_DAYS` / `TA_NET_MUTE_ON_FORWARD_FAIL` | `90` / `true` | Live forward test. |
| `TA_NET_MAX_ROUNDS_PER_RUN` | `36` | Rounds per pipeline run while the first tournament runs (0 = all at once). |
| `TA_NET_RESTART_EVERY` | `6` | Every N rounds the worst network restarts from scratch with random settings (0 = never). |
| `TAKER_FLOW` | `true` | Listen to the Coinbase trade feed for live taker order flow. |
| `COINBASE_WS_URL` | `wss://ws-feed.exchange.coinbase.com` | Coinbase Exchange public WebSocket. |
| `HISTORY_DIR` | `data/history` | The candle store. |
| `HISTORY_AUTO_UPDATE` | `true` | Refresh Binance and Coinbase data in the daily pipeline. |
| `HISTORY_ASSETS` | `auto` | `auto` = every crypto asset Kalshi lists; or a list like `BTC,ETH,SOL`. |
| `HISTORY_BINANCE_INTERVALS` | `1h,15m,1d` | Binance intervals to keep up to date. |
| `HISTORY_COINBASE_TFS` | `1h,1d` | Coinbase timeframes to backfill (add `15m` if you want it; about 1,000 requests per asset the first time). |

## The TA rule study on long history

The rule-by-rule study (hit rate and false-discovery-rate cut for every rule and confluence) can now run on the hourly history too:

```bash
npm run research:ta -- --history data/history
```

That gives the 1h, 4h and 1d rules years of evidence instead of a few weeks.
