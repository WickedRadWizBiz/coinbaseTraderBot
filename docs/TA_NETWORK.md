# Historical data and the TA network

The TA network is a fourth learned model, trained on years of exchange history instead of the bot's own recordings. It reads its inputs in four separate branches (docs/EVOLUTION.md, Phase 2):

| Branch | Input | Layer |
|---|---|---|
| Micro | last 32 fifteen-minute bars (return, range, close position, volume, taker order flow) | fractal convolution block |
| Swing | last 48 raw hourly bars (same five readings) | fractal convolution block |
| Trend | last 12 hourly steps of the whole TA library (every 1h and 4h indicator and structure reading, every rule signal and confluence score) | GRU |
| Macro | last 30 daily steps (daily TA readings, daily returns, volatility) | attention |

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

It does not read dominance charts (USDT.D, BTC.D) because there is no history for them. The rules that need them stay silent, both in training and live.

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

To run it now:

```bash
bash ~/bot/current/deploy/history.sh train          # through the pipeline: validated, promoted, hot-swapped
npm run research:ta-net                         # from a checkout, writes params/ta_net.json
npm run pipeline -- --fresh-ta-net              # restart the tournament from scratch
```

What it does:
1. **Inputs.** For every closed hourly bar it builds the four branch inputs, using the same windows the live bot has: 280 hourly bars (the last 48 also raw, for the swing branch), 4h built from them, 250 daily bars, and 32 fifteen-minute bars. All assets are pooled, because every input is scale-free. Hourly rows are cached, so re-runs only compute new bars.
2. **Tournament.** Three identical networks with slightly different settings train on a rolling 12-month block and are scored on the next month. Each one trades its own position rule (quarter-Kelly on its forecasts, 5 bp costs). Fitness = Sortino − 5 × max drawdown − 5 × costs. Each month the elite survives, the worst copies it, and the middle one and the copy get mutated (learning rate, L2, the weight of each branch, the vol head's weight, the drop-path probabilities). Every 6th round the worst network instead restarts from scratch with random settings (the exploration member). Then everything rolls forward one month.
3. **Hurdles.** The elite's out-of-sample record is clustered so that one continuous position counts as one interaction. It must pass the deflated Sharpe ratio, with every member evaluation counted as a trial, and hold at least 100 independent interactions in every regime it covers.
4. **Unseen holdout.** The last 3 months are never touched. Each head is graded there against the naive forecast. The volatility head speaks live if it beats it. The direction heads also need step 3's hurdles.
5. **Live forward test.** The bot trades the elite's position rule on paper for 90 days. If that fails, the direction heads go silent.

6. **Pattern report.** The elite is run on the holdout with one fractal column at a time (see above).

Live, every forecast is also graded against the candles that follow. `tanet_skill_1h` and `tanet_skill_4h` are the network's rolling skill over its last 168 graded calls.

## 3. Real results of the first tournament (schema 2, before the fractal blocks and order flow; Binance spot, BTC/ETH/SOL/XRP/DOGE, Aug 2017 – Oct 2026)

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
