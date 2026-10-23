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
- **Index series, 5,000 bars each** (tvdatafeed's maximum) at 1d, 4h and 1h. The symbols are BTC.D, USDT.D, TOTAL3 (crypto market cap without BTC and ETH) and OTHERS.D (the share outside the top 10), all from CRYPTOCAP, and RTY, the US Russell 2000 (the first of TVC:RUT, RUSSELL:RUT, CME_MINI:RTY1! and AMEX:IWM that answers). A series gets the full backfill when it has fewer than 3,000 daily bars, or when it does not reach back to a date the bot needs: BTC.D and USDT.D must cover the Fractal Alignment Engine's 2016-2017 parent window (USDT.D for the waterfall's USDT.D leg over the same years). 5,000 daily bars go back to 2013 for BTC.D, and TradingView's USDT.D starts in 2015, so one request covers each. That second kind of backfill is asked at most weekly, in case TradingView itself starts later. A series whose newest daily bar is more than 2 days old (4 for the traditional-market series, which skip weekends) has its last 40 daily bars refreshed. That is always the case for TOTAL3, OTHERS.D and RTY, which have no live feed in the bot. It applies to BTC.D and USDT.D only where the bot's own dominance bars are missing, as on the laptop trainer.
- **Gap filling for every coin.** Each run checks every timeframe (15m, 1h, 4h, 1d) of every coin for missing bars within tvdatafeed's 5,000-bar reach, leaving out the last 3 days, which the exchange archives haven't published yet. The worst 20 get that window from the first venue that has the pair (Coinbase, Binance, Bitstamp, Kraken). The bars are stored as source `tvspot`, which fills the missing bars only, including inside the exchanges' own spans, and never replaces an exchange's bar. A hole TradingView can't fill either (an outage on every venue) is retried weekly instead of daily.

```bash
bash ~/bot/current/deploy/history.sh tradingview   # on the server, now: index backfill (installs tvdatafeed in a venv), then import
bash ~/bot/current/deploy/history.sh tvfetch --out ~/incoming/tv --spot BTC:1h,SOL:15m   # spot bars for named holes
```

**On the laptop trainer** (no bash, no server venv), the trainer sets up tvdatafeed itself, once, in `trainer-data\tv-env`, with the uv the Windows package ships (`research/tvSetup.ts`). tvdatafeed is not on PyPI, so it is installed from the same GitHub archive the server uses, and no git is needed. The history step then runs `deploy/tv_history.py` with that Python (`TV_PYTHON`). If uv or the install fails, the step runs without TradingView, and the log says why. Turn it off with `TV_FILL=false` in `trainer.env`.

The importer files `CRYPTOCAP_*` and `TVINDEX_*` exports (also TradingView's own "Export chart data" CSVs) as index series, never as coins. The deploy installs python3-venv and git on the server. Downloading through an unofficial client is against TradingView's terms, so the pipeline only asks for what is missing or stale. If TradingView blocks the server's address, the step reports it and the bot carries on with what it has.

**TA-Lib inputs.** The core indicators come from TA-Lib (docs/TA_LIBRARY.md, "Engine"). Of its extra readings, the network takes a compact set per timeframe through the context branch: the candlestick net score (last bar and last 3 bars), CCI, the Aroon oscillator, the Ultimate Oscillator, distance to the Parabolic SAR, the Hilbert trend mode, and distance to KAMA. With all ~170 TA-Lib extras, the tournament test's planted signal was no longer learned (holdout hit rate 50%, against 52%+ with the compact set), the same overfitting the market context caused before it got its own branch. The setup scorer, a tree model, gets every TA-Lib reading.

**Slow context: TOTAL3, OTHERS.D, RTY.** The same daily readings as BTC.D and USDT.D (1/5/20-day changes plus trend, momentum, structure and moving-average distances) are added to the context branch for these three series. They're there for the network to find patterns and extra confluence, not as rules. They lag one extra day (the bar that closed a day before the dominance bars), so live always has the bar training had, even before the daily refresh. RTY's last bar carries for up to 4 days, covering weekends and holidays. Signs: TOTAL3 and RTY up = risk-on for every coin; OTHERS.D up = small alts outperforming (bullish alts, bearish BTC relative).

When new context history arrives (BTCDOM for the first time, or the TradingView export), every past row changes, so the next pipeline run starts the tournament afresh to learn from it.

### Grouped variant: indicator families (challenger)

`TA_NET_ARCH=grouped` (or `--arch grouped`) builds the network around indicator families instead of feeding it the raw readings. Indicators that measure the same thing are stacked: RSI, MACD, Stochastic, CCI and the other oscillators on 1h and 4h all go into the momentum family, and so on.

| Family | Members (any timeframe) |
|---|---|
| trend | moving averages and their stack, ADX / DI, Ichimoku, golden cross, market-structure trend, KAMA, Parabolic SAR, Aroon, linear-regression slope, Hilbert trend mode |
| momentum | RSI, MACD, Stochastic, Williams %R, price change in ATRs, CCI, momentum, Ultimate Oscillator, CMO, PPO, TRIX, Stochastic RSI, z-scored returns |
| volume | OBV slope, CMF, MFI, volume ratio, VWAP, volume profile, taker flow, A/D oscillator, balance of power |
| volatility | Bollinger %B and bandwidth, squeeze, ATR level and rank, NATR, standard deviation, realised-volatility ratios |
| structure | BOS, CHoCH, sweeps, true breakouts, equal highs and lows, Donchian, fair-value gaps, round numbers, divergences |
| candles | engulfing, pin bar, doji, TA-Lib's candlestick scores |
| confluence | the knowledge base's confluences and rule tallies |
| timing | hour, weekday, weekend, missing bars |
| market, dominance, slow (context only) | BTC and the basket; BTCDOM, BTC.D, USDT.D and the quadrant; TOTAL3, OTHERS.D, RTY |

- **Level 1:** each family has its own small encoder (4 units) that reads only its members.
- **Level 2 (deep path):** the GRU reads the 12 hourly steps of family summaries, and the context layer the context families, instead of 150–250 raw readings. That is far fewer weights.
- **Level 3 (shallow path, the fractal join):** an attention over all families at the forecast hour. Each family scores its own salience; a softmax turns the scores into weights that blend the family summaries into one vector, which goes straight to the merge layer next to the deep path. The network can follow a single family directly or the deep confluence, and the live output (`families` in the TA network's status) says how much each family counted in each call.

The backward pass is hand-written and checked against finite differences (tests/branchNet.test.ts). On the tournament test's synthetic data the grouped network learns the planted signal with every input group present. It replaces the flat network only if it does better on the same tournament, holdout and final-window tests.

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
1. **Inputs.** For every closed hourly bar it builds the five branch inputs, using the same windows the live bot has: 280 hourly bars (the last 48 also raw, for the swing branch), 4h built from them, 250 daily bars, 256 fifteen-minute bars (the last 32 also raw), every coin's hourly bars for the market context, BTCDOM and the daily dominance charts. All assets are pooled, because every input is scale-free. Hourly rows are cached (`work/tanet-cache`), so re-runs only compute new bars. The cache keeps a signature per calendar month of everything the rows read: the coin's own bars, its 15-minute bars, every basket coin's hourly bars, BTCDOM and the daily index charts. A revised bar or a coin added to the basket recomputes rows from that month on, not the coin's whole history. With `TRAIN_WORKERS` > 1 (the laptop trainer: one per core but one), or `TA_ROW_WORKERS` (for this rebuild only; the remote runner sets it to its core count), coins with many rows to compute are spread over worker threads, as many as free memory allows. The laptop trainer never copies this cache from the server, since the server's is built from other history. Once the laptop has its own tournament (`work/tanet-population.json`), the server's copy never replaces it.
2. **Tournament.** Three identical networks with slightly different settings train on a rolling 12-month block and are scored on the next month. Each one trades its own forecasts as triple-barrier trades (López de Prado): every hour a 4-hour trade sized by quarter-Kelly on P(up in 4h), with take-profit and stop at ±1 forecast 4-hour standard deviation and a 4-hour time limit. The first barrier touched decides (a bar touching both counts as the stop; a gap through a barrier exits at the open), with 5 bp costs on entry and exit. This scores the path of a trade, not one hourly close. A trade is only taken when |P(up in 4h) − 0.5| ≥ `minEdge`, a confidence threshold the tournament tunes (0.002–0.15): fewer, surer trades instead of every hour. Results report the win rate on trades taken, with a 95% interval, and the share of hours traded. Fitness = Sortino − 5 × max drawdown − 5 × costs. Each month the elite survives, the worst copies it, and the middle one and the copy get mutated (learning rate, weight decay, the weight of each branch, the vol head's weight, the drop-path probabilities). Every 6th round the worst network instead restarts from scratch with random settings (the exploration member). Then everything rolls forward one month.
3. **Hurdles.** The elite's out-of-sample record is clustered so that one continuous position counts as one interaction. It must pass the deflated Sharpe ratio, with every member evaluation counted as a trial, and hold at least 100 independent interactions in every regime it covers.
4. **Unseen holdout.** The last 3 months are never touched. Each head is graded there against the naive forecast. The volatility head speaks live if it beats it. The direction heads also need step 3's hurdles.
5. **Frozen final window.** The most recent `TA_NET_FINAL_MONTHS` (2) are carved out after the holdout and never used for training or selection. Every head must also hold up there (mean improvement over the naive forecast above zero). A ledger counts how often each final window has been evaluated; the log says when a window has been seen before and is no longer an unseen test.
6. **Live forward test.** The bot trades the elite's triple-barrier rule on paper for 90 days. If that fails, the direction heads go silent.

6. **Pattern report.** The elite is run on the holdout with one fractal column at a time (see above).

Live, every forecast is also graded against the candles that follow. `tanet_skill_1h` and `tanet_skill_4h` are the network's rolling skill over its last 168 graded calls.

### Training engine: TypeScript or PyTorch (October 2026)

The tournament's training epochs and forecasts can run in PyTorch (`python/tanet`), on an NVIDIA GPU when there is one. Everything else stays in TypeScript: the tournament (`research/pbt.ts`), fitness, hurdles, the holdout and the pattern report. So does the live bot, which keeps running the network in `bot/ta/branchNet.ts`.

- **Same network, same weights.** PyTorch holds the weights as one flat tensor with the TypeScript layout. The layout and the fractal trees are sent from TypeScript and never re-derived in Python. A member's weights and AdamW moments move between the two engines unchanged, so a saved tournament continues in either one (round 70 of 96 continues where it stopped). `tests/taNetTorch.test.ts` checks, in float64:
  - outputs and gradients equal `branchForward` / `branchBackward`, with the same drop-path masks and branch scales;
  - the training pack rebuilds exactly what `rawInputs` builds;
  - forecasts through the pack equal the TypeScript forecast.
- **The training pack.** Once per step, the dataset is written to `work/tanet-cache/torch-pack`:
  - the hourly trend and context rows, and the daily rows, once per asset;
  - per sample, its row and day index plus the raw 15-minute and hourly windows.

  Python gathers each batch's windows itself. On the GPU, the tables sit in device memory, normalised once. On the CPU, they stay memory-mapped. The pack is reused while the data is unchanged, and it is never copied to the server.
- **Speed.** On a 4-core cloud CPU, TypeScript trains at 1.7 ms per sample; PyTorch on the same CPU takes 0.39 ms. On a GPU, each training step (gather, forward, backward, AdamW) is recorded once as a CUDA graph and replayed per batch, which is checked against the plain step first. The batch stays 64, as in TypeScript, so the tuned learning rates still apply. The log reports the speed after every round: `round N: PyTorch trained ... samples in ... s (.../s, CUDA graph)`.
- **Fallback.** With `auto`, any problem means the run continues in TypeScript, and the log says why. Problems include no Python, no PyTorch, a failed install, a crash mid-run, or non-finite weights. Only the flat network trains in PyTorch; the grouped challenger stays in TypeScript.

The walk-forward export for the setup scorer (`ta_net_oos`, `research/taNetOos.ts`) uses the same engine and the same training pack.

Where it is on:
- **The laptop trainer** sets PyTorch up by itself (see docs/LAPTOP_TRAINING.md, "GPU").
- **The remote training job** installs the CPU build.
- **The server** keeps `ts`.

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
| `LIBRARIAN_PATH` | `params/librarian.json` | Fallback Librarian file (the pipeline's `data/models/librarian.json` is preferred). |
| `CROSS_GRAPH_PATH` | `params/cross_graph.json` | Fallback cross-asset graph network file (the pipeline's `data/models/cross_graph.json` is preferred). |
| `CROSS_LEAD_PATH` | `params/cross_lead.json` | Fallback cross-coin lead-lag study (the pipeline's `data/models/cross_lead.json` is preferred). |
| `XG_ENGINE` | `auto` | The cross-asset graph network's training engine: `ts`, `torch` or `auto` (PyTorch when a Python with it and numpy is found). |
| `TA_NET_REQUIRE_VALIDATED` | `true` | Only heads that passed the blind test speak. |
| `TA_NET_RETRAIN_DAYS` | `7` | Continue the tournament at most this often (daily while the first one is still running). |
| `TA_NET_TRAIN_MONTHS` / `TA_NET_EVAL_MONTHS` / `TA_NET_STEP_MONTHS` | `12` / `1` / `1` | Tournament blocks. |
| `TA_NET_HOLDOUT_MONTHS` | `3` | Never touched by the tournament. |
| `TA_NET_FINAL_MONTHS` | `2` | Frozen final window after the holdout; every head must also hold up there (0 = off). |
| `TA_NET_STRIDE` | `2` | Train on every 2nd hourly sample. |
| `TA_NET_ENGINE` | `ts` | Training engine: `ts`, `torch` (PyTorch; fails if it cannot start), or `auto` (PyTorch when it starts, else TypeScript). The laptop trainer and the remote job use `auto`. |
| `TA_NET_PYTHON` | `python3` / `python` | The Python with PyTorch for the torch engine. The laptop trainer sets its own. |
| `TA_NET_CUDA_GRAPHS` | `true` | Record the GPU training step as a CUDA graph (`false`: plain PyTorch). |
| `TA_NET_MIN_PER_REGIME` / `TA_NET_DSR` | `100` / `0.95` | Statistical hurdles for the direction heads. |
| `TA_NET_FORWARD_DAYS` / `TA_NET_MUTE_ON_FORWARD_FAIL` | `90` / `true` | Live forward test. |
| `TA_NET_MAX_ROUNDS_PER_RUN` | `36` | Rounds per pipeline run while the first tournament runs (0 = all at once). |
| `TA_NET_RESTART_EVERY` | `6` | Every N rounds the worst network restarts from scratch with random settings (0 = never). |
| `TAKER_FLOW` | `true` | Listen to the Coinbase trade feed for live taker order flow. |
| `COINBASE_WS_URL` | `wss://ws-feed.exchange.coinbase.com` | Coinbase Exchange public WebSocket. |
| `HISTORY_DIR` | `data/history` | The candle store. |
| `HISTORY_AUTO_UPDATE` | `true` | Refresh Binance and Coinbase data in the daily pipeline. |
| `HISTORY_RECHECK_HOURS` | `24` | Sources checked completely within this many hours are skipped (0 = always check). |
| `HISTORY_ASSETS` | `auto` | `auto` = every crypto asset Kalshi lists; or a list like `BTC,ETH,SOL`. |
| `HISTORY_BINANCE_INTERVALS` | `1h,15m,1d` | Binance intervals to keep up to date. |
| `HISTORY_COINBASE_TFS` | `1h,1d` | Coinbase timeframes to backfill (add `15m` if you want it; about 1,000 requests per asset the first time). |

## The TA rule study on long history

The rule-by-rule study (hit rate and false-discovery-rate cut for every rule and confluence) can now run on the hourly history too:

```bash
npm run research:ta -- --history data/history
```

That gives the 1h, 4h and 1d rules years of evidence instead of a few weeks.


## The Librarian: oracle strategy and regime-transition heads (October 2026)

The Librarian (the 4th-generation spec's 3.1; the name for the adversary with full access to the TA library, trained on the oracle) reads the same row the TA network reads at each closed hourly bar: every TA library reading on 15m / 1h / 4h / 1d, the rules, the confluences and the market context (`TANET_FEATURES`). It answers two questions the direction heads do not (`bot/ta/librarian.ts`, trained by `research/librarian.ts`).

- **Strategy head.** Which of the bot's strategy families would have paid over the next 24 hours:
  - trend: rides the 4h EMA stack, the trend-pullback setups' side;
  - revert: fades the 1h Bollinger extremes or RSI beyond 70 / 30, the fade and dip setups' side;
  - breakout: follows a 20-bar Donchian break or a squeeze releasing, the burst and breakout setups;
  - flat.

  The oracle label is a softmax of what each family's position earned over the day, net of a 10 bps round trip, in units of the coin's volatility. It is soft: families that earned about the same share it. The model is multinomial logistic on the z-scored readings.
- **Transition head.** P(the coin's confirmed daily regime, `bot/ta/regime.ts` with the playbook's two-day confirmation, changes within 72 hours).
- **Outputs.** The weights, a continuous playbook position (weights × each family's position, −1..1), its disagreement with the knowledge base's rule tally (`net_all`), and the transition probability.

**Training and grading.**
- Rows are every third hour of every coin with a TA row, from the TA network's row cache.
- The first fit uses two years. Then every quarter it refits (warm start) on every row whose labels had closed, and forecasts every hour of the next quarter unseen.
- The strategy head is graded on those forecasts at one decision a day per coin, with a turnover cost. It competes at equal risk (Sharpe ratio) against two persistence playbooks:
  - the mean oracle weights of the coin's current regime in the rows the fit saw (the regime persists);
  - the family that paid over the last day (the winner persists).
- The strategy head validates when it beats both, and its vol-matched edge over the regime playbook has a daily bootstrap 95% lower bound above 0 on 60+ days.
- The transition head validates when its log loss beats the hazard by days since the last change, with a 95% lower bound above 0 on 500+ rows.

**Where it is used.**
- **Decision models.** The features `lib_trend`, `lib_revert`, `lib_breakout`, `lib_flat`, `lib_net`, `lib_vs_book` and `lib_trans` are offered to the decision models trained on the recordings. Each is NaN unless its head validated. A model keeps them only if its own validation improves.
- **Setup scorer.** It reads both heads, ungated, as its `librarian` input group, from the walk's forecasts in research and from the same model on the walking TA network's row live. The group is kept only if it raises the development years.

**Running it.**
- The pipeline runs it weekly (step `librarian`, `data/models/librarian.json`); the bot reloads the file when it changes.
- By hand: `npm run research:librarian -- --history data/history`.
- `LIBRARIAN_PATH` is the fallback model file.

## The Oracle cull: every TA reading against hindsight (October 2026)

The Librarian learns from the oracle; the Oracle cull uses the same oracle to judge the inputs. Every reading the TA network and the Librarian read is tested: each indicator on 15m / 1h / 4h / 1d, the rule tallies, the confluences, the candle patterns, and the cross-asset and order-flow readings (`TANET_FEATURES`, 468 of them). The test asks whether the reading tells anything about the hindsight-best strategy (`research/oracleCull.ts`).

**The test.**
- The oracle is the Librarian's soft label: which family (trend, mean-revert, breakout, flat) earned most over the next day after a round trip, every third hour of every coin.
- Each reading's values are cut into quantile bins on the first two years.
- Walking forward through time, each later row is forecast by the average oracle label of the rows in its bin whose outcome was already known, against the overall average alone.
- The gain is how much better that forecast was against what actually paid, out of sample.

**The verdict** (from daily gains, weekly-block bootstrap):
- **proven:** the gain passes Benjamini-Hochberg at q = 0.1 over all 468 readings, so a reading does not pass on luck;
- **kept:** the gain is positive but not proven;
- **culled:** the reading forecast the oracle worse than not reading it.

`ORACLE_CULL_LEVEL=unproven` culls everything that is not proven.

**The effect.**
- **TA network.** It reads a culled input as absent. The input's normalisation scale is set to 1e300, which makes it 0 in the TypeScript trainer, the PyTorch trainer (where float32 turns it to infinity) and the live bot. The saved population keeps the raw statistics, so a reading a later cull keeps comes back. The network file lists the culled readings (`cull`).
- **Librarian.** It fits and forecasts without the culled inputs (their spread is zero).
- **Gates.** Both keep their own gates: the TA network's champion contest and the Librarian's grading decide whether the culled model is used. The cull never ships a worse model by itself.

**Running it.**
- The pipeline runs it weekly before the TA network (step `oracle_cull`, `data/models/oracle_cull.json`, with every reading's gain, interval, p-value, its correlation with the oracle's position, and a per-indicator summary).
- By hand: `npm run research:oracle-cull -- --history data/history`.
- `ORACLE_CULL=false` turns it off.

## The cross-asset graph network (October 2026)

The 4th-generation spec's item 2, as reviewed: a graph network over the coins, learning from **relative** returns. Each coin is measured against the basket, so it forecasts which coins will outrun the others. Where the market as a whole goes is the TA network's job. The model is in `bot/ta/crossGraph.ts`; training is in `research/trainCrossGraph.ts` and `python/xgraph/train.py`.

**Inputs (nodes).** Every coin with hourly bars, at the close of each hour, all in units of the coin's own hourly volatility, so BTC and DOGE are comparable:
- its return relative to the basket over 1, 4, 24 and 168 hours;
- its volatility regime (24 h vs 168 h);
- its taker-buy share and its volume against their norms;
- the basket's own 24 h move, the same for every node: the tide the relative moves happen in.

**Edges.** The correlation of each pair's hourly returns over the last 168 hours.

**Network.**
- **Encoder:** `h = tanh(W1 x + b1)`.
- **Message:** a weighted mean of the other coins' encodings. The weights are a softmax of β × correlation; β is learned, and sets how much the closest-moving coins speak compared with all coins alike.
- **Update:** `z = tanh(W2 h + U2 m + b2)`.
- **Two heads:** the coin's relative return over the next 4 and 24 hours, in volatility units. The rank across coins is also exported.

**Training and grading.**
- **Walk-forward:** samples every 4th hour. The first fit uses two years; then a warm-started refit every quarter on every sample whose 24 h label had closed, each fit forecasting every hour of the next quarter unseen.
- **Grading:** one decision a day, on those forecasts only.
  - The cross-sectional correlation (IC) of the 24 h forecast with what happened, against the better of momentum and reversal of the 24 h relative return. Its sign is chosen on the rows each fit saw.
  - A long-short book: the top quarter of coins long, the bottom quarter short, 10 bps per name changed.
- **Validation:** it validates when the IC edge has a daily bootstrap 95% lower bound above 0 on 120+ days, and the book made money after costs.

**Engines.** Training runs on PyTorch when `XG_ENGINE` is `torch`, or `auto` (the default) and a Python with PyTorch and numpy is found. Otherwise it runs in TypeScript. Either way it is the same network with the same flat weights, and the live bot runs the TypeScript forward pass. CI checks the two engines agree on identical weights.

**Where it is used.**
- **Decision models:** `xg_rel4`, `xg_rel24` and `xg_rank` are offered as features, NaN unless the model validated.
- **Setup scorer:** it reads the forecasts as its `xgraph` input group (with copies oriented to the trade's side), kept only if they raise the development years.

**Running it.** The pipeline runs it weekly (step `cross_graph`, `data/models/cross_graph.json`; forecasts in `data/history/.xgraph/`). By hand: `npm run research:xgraph -- --history data/history`.

## Cross-coin lead-lag (October 2026)

Does the bot look for one coin following another? This study asks it directly: when a leader (BTC, ETH) moves, does a follower make up the part of that move it has not made yet over the next 1, 5, 15 or 60 minutes? The study is `research/crossLead.ts`; the reading the bot uses is `bot/ta/crossLead.ts`.

**What it measures.** The data is four years of 1-minute spot history (the history replay's `binance-1m` store), sampled every h minutes without overlap.
- **The gap:** beta × the leader's return over the last h minutes − the follower's return over the same minutes.
- **beta:** how much the follower moves with the leader in full, fitted on 60-minute returns (240 for the hourly horizon). A beta from the same short span would absorb the lag it is meant to measure.
- **The catch-up slope a:** the follower's next-h-minute return regressed on the gap. The expected move is a × gap.

**Walk-forward.** Each quarter is fitted on the two years before it and tested on the quarter itself. Every graded number is out of sample, and the folds are stored (`walk`) so training reads, at each time, the fit made before it.

**Verdicts.**
- **Validated (predictive):** the pooled out-of-sample information coefficient of a × gap with the next move has a day-block bootstrap lower bound above 0. That bound is one-sided, with Bonferroni over every pair and horizon tested. The IC must also be positive in at least 60% of the quarters, on 120+ days.
- **Tradable:** the largest 10% of gaps also paid for a perp round trip (28 bps) on their own. This is reported only; nothing trades the gap by itself. A gap of a few basis points is expected to be predictive but not tradable.

**Where it is used.** A pair is used only once validated, and each use must pay on its own terms:
- **Decision models (Kalshi):** `cl_exp1`, `cl_exp5`, `cl_exp15` and `cl_exp60` are the coin's expected move from its validated leaders' 1-minute index bars over the same minutes, in units of its per-minute volatility × √h. They are NaN otherwise, and feature selection decides whether they stay. Exits follow the model's fair value, so they move with it.
- **Setup scorer:** the `crosslead` input group (15 and 60 minutes, from 15-minute candles) is kept only if it raises the development years.
- **Setup exit:** the lead-lag exit is switched on only if it raises the setups' net R out of sample (docs/SETUPS.md, "The cross-coin lead-lag exit").

**Running it.** The pipeline runs it weekly (step `cross_lead`, `data/models/cross_lead.json`, after `cross_graph`). It is skipped without the 1-minute store (`HISTORY_REPLAY=true` downloads it). By hand: `npm run research:cross-lead -- --history data/history [--years 4]`. Each pair's verdict and reason are in the log and the file (`why`).

## Calibration, champion / challenger, ensemble (October 2026)

- **Calibration.** On the October holdout the direction heads called the right side 51.2% of the time but scored worse than a coin flip on log loss (1h: 0.6938 vs 0.6932; 4h: 0.6999 vs 0.6930): the probabilities were too extreme. The final training pass now stops one evaluation period (`--calib-months`, default `--eval-months`, 1) before the holdout; Platt parameters (P = sigmoid(a x logit + b), a in [0, 1] so it only shrinks, |b| <= 0.2) are fitted on that untouched month and stored in `params.calib`. The holdout and final window are graded on calibrated probabilities, and the live network outputs them.
- **Champion / challenger.** `--incumbent <file>` grades the live network on the same holdout rows (mean over the heads of model loss / naive loss). The pipeline promotes the candidate only if it scores at least as well; otherwise the live network stays. The incumbent is only compared when its inputs match and its own holdout began no later than the candidate's (it never trained on those hours). Replaced networks are archived in `data/models/archive/ta_net/`.
- **Ensemble.** The bot runs the live network plus up to two archived versions and blends them by prior x exp(40 x rolling skill) (`bot/ta/taNetEnsemble.ts`). A head counts as validated when versions holding at least half the weight validated it.
