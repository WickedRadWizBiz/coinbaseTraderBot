# Historical data and the TA network

The TA network is a fourth learned model, trained on years of exchange history instead of the bot's own recordings. It reads three timeframes in three separate branches (docs/EVOLUTION.md, Phase 2):

| Branch | Input | Layer |
|---|---|---|
| Micro | last 32 fifteen-minute bars | 1-D convolution |
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
1. **Inputs.** For every closed hourly bar it builds the three branch inputs, using the same windows the live bot has: 280 hourly bars, 4h built from them, 250 daily bars, and 32 fifteen-minute bars. All assets are pooled, because every input is scale-free. Hourly rows are cached, so re-runs only compute new bars.
2. **Tournament.** Three identical networks with slightly different settings train on a rolling 12-month block and are scored on the next month. Each one trades its own position rule (quarter-Kelly on its forecasts, 5 bp costs). Fitness = Sortino − 5 × max drawdown − 5 × costs. Each month the elite survives, the worst copies it, and the middle one and the copy get mutated (learning rate, L2, the weight of each branch, the vol head's weight). Then everything rolls forward one month.
3. **Hurdles.** The elite's out-of-sample record is clustered so that one continuous position counts as one interaction. It must pass the deflated Sharpe ratio, with every member evaluation counted as a trial, and hold at least 100 independent interactions in every regime it covers.
4. **Unseen holdout.** The last 3 months are never touched. Each head is graded there against the naive forecast. The volatility head speaks live if it beats it. The direction heads also need step 3's hurdles.
5. **Live forward test.** The bot trades the elite's position rule on paper for 90 days. If that fails, the direction heads go silent.

Live, every forecast is also graded against the candles that follow. `tanet_skill_1h` and `tanet_skill_4h` are the network's rolling skill over its last 168 graded calls.

## 3. First real results (Binance spot, BTC/ETH/SOL/XRP/DOGE, Aug 2017 – Oct 2026, ~348,000 hourly rows)

The split was: train before 2023-07-27, validation until 2024-12-06, then a blind walk-forward test to 2026-10-01 (about 80,000 forecasts, refitted every 6 months). Boosted trees won the validation comparison for all three heads.

| Head | Blind test vs the naive forecast | 95% CI of the improvement | Validated |
|---|---|---|---|
| `up_1h` | log loss 0.69193 vs 0.69316; hit rate 52.3%; skill 0.24% | +0.00025 to +0.0021 | **yes** |
| `up_4h` | log loss 0.69303 vs 0.69322; hit rate 51.7% | −0.0011 to +0.0014 | no: stays silent live |
| `vol_4h` | mean squared error 0.305 vs 0.403 (24% lower) | +0.088 to +0.108 | **yes** |

This model ships as `params/ta_net.json`. The server's pipeline retrains it on every Kalshi crypto asset. The pipeline report (`data/models/reports/`) and `GET /api/status` → `treeModels.taNet` show the numbers for the model actually running.

**Read these honestly:**
- **The volatility forecast is the strong result.** It knows when the next few hours will be calmer or wilder than the last day. That helps the vol model price contracts and size risk.
- **1-hour direction is real but small.** A 52% hit rate is statistically significant. Some of it is probably short-term mean reversion in exchange closing prices, which Kalshi's averaged settlement prices partly remove.
- **4-hour direction showed no reliable edge, so it's switched off.**

That's why the outputs go to the decision models as features instead of trading directly. Each model keeps them only if they improve its own after-fee validation.

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
