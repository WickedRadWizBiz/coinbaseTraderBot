# Training on your own computer

The laptop trainer runs the bot's own training pipeline (`research/pipeline.ts`) on your computer. It
has no time cap and uses bigger budgets than the server's background job or the daily remote job. It
then sends the winning models to the bot, which loads them without a restart.

## Windows: download and double-click

1. GitHub → **Releases** → **Laptop trainer (Windows)** → download `KalshiTrainer-windows.zip`. The
   zip is rebuilt on every change to the training code. You can also build it now from Actions →
   *Laptop trainer (Windows package)* → *Run workflow*.
2. Unzip it anywhere with about 40 GB free, then double-click `Train.cmd`. (The replay of all the history
   takes about 10 GB, the 1-minute history it is made from about 3 GB.)
3. Type how many hours to train: 12 for a first run, 48 or more for a long one.
4. **First run only:** it asks for your server, so it can copy the bot's recordings and upload the
   models.
   - Give the Lightsail public IP, user `ubuntu`, and the instance's SSH key file (Lightsail console →
     Account → SSH keys → Download).
   - Leave the address empty to train on downloaded history only.
   - To change these later, run `Train.cmd --setup`.

Nothing to install: the zip carries Node, the bundled trainer, and TA-Lib compiled for Windows.

## Any computer with Node 20+

```bash
npm ci
npm run train:laptop -- --hours 12 --host <server ip> --key ~/lightsail.pem
```

| Option | Meaning |
|---|---|
| `--hours N` | Training budget (default 12) |
| `--data DIR` | Data, history and models, kept between runs (default `./trainer-data`) |
| `--days N` | Recorded days to copy (default 45) |
| `--no-pull` / `--no-push` | Skip copying data down / sending models up |
| `--only a,b` | Run only these pipeline steps |
| `--setup` | Ask for the server details again |

## What a run does

1. **Pull (SSH).** Copies the same files as the remote-training workflow, only new or changed ones:
   - the last N days of recordings;
   - the candle history;
   - the models directory (pipeline state, tournaments in progress);
   - the rest of `~/bot/data`, except audit trails and logs;
   - `bot.env`, without any line holding a key, secret, token or password.
2. **History.** Downloads years of spot candles for every crypto asset Kalshi lists (Binance Vision,
   Coinbase), the replay's 1-minute spot and perpetual bars and funding rates from 2017, and a year of
   Kalshi's settled contracts, tennis matches with every trade. Each later run downloads only what is new.
3. **Rounds.**
   - Round 1 runs every step.
   - Later rounds continue the tournaments (TA network, SNNs, setups, sweeps) and retrain the models
     that read them, until the time is up.
   - Each module is trained and judged on its own. It replaces the model in use only when it beats it
     (`AUTO_TRAIN_CHAMPION`).
   - The sweep then tunes the bot as a whole.
4. **Push (SSH).** Copies the models directory back, newer files only. The running bot hot-swaps every
   model that changed.

The pipeline saves progress after every step. Stopping with Ctrl+C or closing the window loses at most
the step in progress, and the next run picks up the tournaments where they stopped.

## History replay: the bot "trading" years of history

With `HISTORY_REPLAY=true` (on in the laptop profile), the pipeline turns all of the 1-minute history into
recording files (`research/history/historyReplay.ts`, step `history_replay`): from August 2017 for BTC and
ETH, each other coin from its own listing (`HISTORY_REPLAY_YEARS=0`; a number of years limits it). The
replay code reads them exactly as it reads the bot's live recordings:

- **Index and spot prices.** Four a minute from Binance 1-minute bars: the bar's open, then a path toward
  its close drawn at the bars' own volatility. Each one tells the bot no more about the coming close than a
  real price at that moment would. Shifted onto Kalshi's level using each real 15-minute contract's strike.
  - Live, the features read one price a second (returns over 10 s to 5 minutes, RSI, efficiency ratios,
    Kalshi's 60 one-second settlement marks). The replay reader fills the seconds between two prints with
    a random path toward the next print at the market's own volatility, so those features read the same
    kind of path they read live. A second is filled only once its time has passed: nothing is known early.
- **BTC.D and USDT.D.** At every print, rebuilt the way the live bot rebuilds them (see
  [BTC.D and USDT.D](#btcd-and-usdtd) below).
- **Candles.** The live feed's timeframes; every day file is self-contained.
- **Perp quotes.** From Binance USD-M bars, at the spread and contract specs the bot's own perp
  recordings show, with Binance's funding rates.
- **Kalshi's settled contracts.** The real ones where Kalshi's history reaches (about a year): their
  markets, minute quotes, trades and results.
- **Synthetic price-prediction contracts everywhere else.** For each coin, a 15-minute Up/Down every
  quarter hour and an hourly "above" ladder (4 strikes around the price).
  - They settle by Kalshi's rules on the real price: the strike is the 60-second average before the open;
    the result compares the 60-second average before the close to it.
  - Their quotes are a no-skill price (a random walk at the recent volatility) with a 1-2 cent spread.
    A network profits only by calling the direction better than chance.

The models replay it without knowing it isn't live:

- **Perps model:** trains on every day of perpetual history (Binance's perpetuals start in September
  2019), one sample per coin every 15 minutes. Each day's samples are kept, so a run computes only the new
  days; the first run computes all of them on every core at once. Its execution backtest runs on the
  latest year (the market as it trades now).
- **Perps SNN:** its tournament, training and entry / exit learning on direction calls run on the
  replay.
- **Kalshi SNN (price-prediction contracts):** its tournament and training run on the replay's 15-minute
  and hourly contracts.
  - A network takes Up or Down on a contract when its own probability differs from the price by more
    than 3 cents.
  - The history then plays the contract out to its result.
  - The networks whose calls made money on days they had not seen win the round, as in the other
    tournaments.
  - Its gate for live use stays on the bot's recordings, against real Kalshi prices.
- **Whole-bot and Kalshi sweeps:** the replay days that hold Kalshi's real contracts. The strategy never
  trades the synthetic ones, whose price is its own model's. The result is a proposal, never auto-applied.
- **Kalshi decision model:** stays on the bot's own recordings (it learns how real Kalshi prices differ
  from fair value, which synthetic quotes cannot show).
- **SNN tournaments span every era.** A tournament's days are blocks of a week spread from the first year
  of history to the latest days (bull and bear markets, crashes, quiet years), so the winning settings
  have to hold up in every kind of market. The network that goes live then trains on the latest days.

The first run downloads Binance's archives from 2017 (about 1 GB) and builds every replay day (an hour or
two). Later runs add only the new days. A day is rebuilt only when something it read changed: Kalshi's
files for it, the 1-minute history or funding rates reaching further into it (a day first built before
its data was published), or new dominance readings near it.

## BTC.D and USDT.D

Every part of the bot that reads BTC dominance (BTC.D) or USDT dominance (USDT.D) gets them in training
too:

| Part | Live | In training |
|---|---|---|
| Kalshi SNN and perps SNN (USDT.D 15-minute change input) | the live rebuild, every second | the replay's rebuild |
| Perps model (USDT.D change, BTC.D change by coin) | the live rebuild | the replay's rebuild, every perpetual day since 2019 |
| Kalshi decision features, the TA snapshot's dominance quadrant, the alt-coin risk-on rule | the live rebuild | the replay's rebuild in the backtests and sweeps |
| TA network | BTC.D / USDT.D daily charts; hourly, Binance's BTC dominance index and the market basket | the same series: TradingView's daily charts back to 2013 plus the bot's own bars |

How the replay rebuilds them, as the live bot does (live, CoinGecko's market caps anchor Binance's
prices):

- **Anchors.** Real dominance readings from the history store: TradingView's BTC.D and USDT.D plus the
  bot's own hourly bars. Hourly where they reach (the last ~200 days and the bot's own bars), else
  4-hourly (~2 years), else daily (back to 2013). Each reading is used from its time on, never before.
- **Between readings.** BTC's market cap moves with BTC's price, USDT's stays put, and every other coin's
  moves with the replayed alts (ETH, XRP, SOL, DOGE by size). So BTC.D rises when BTC beats the alts, and
  USDT.D falls when crypto rises.
- **Seams.** A new reading rarely lands exactly where the moved value drifted to; the gap is closed over
  an hour, so the features never see a jump that did not happen.
- **No reading.** Before the series start, or after a hole of more than 2.5 days, there is no value, as
  live when the feed is stale.

The rule book is the one exception. Live, its dominance-quadrant rule reads 15-minute dominance changes.
The rule study walks years of hourly candles, and minute-level dominance exists only in the replay, so the
rule cannot be tested at the scale it is used. It is left out of the study rather than tested on a
different signal. The TA network covers dominance at the hourly and daily scale.

## Does it run in real time?

No. The replay runs as fast as the processor allows: its clock is the data's own timestamps, so nothing
waits for the market. The Kalshi network still steps once per market second, as it does live.

- **One network:** a replayed day of all five coins (about 960 contracts) took 4 to 7.5 minutes on one
  core of a 2.8 GHz cloud server, about 190 to 370 times faster than real time. A recent laptop core is
  usually faster.
- **The tournament:** runs one network per thread at the same time, so a 16-thread laptop puts 15
  networks through each day in that same time.

A 12-hour run covers about 30 tournament days (four week-long blocks across the years) and 14 training
days per network. The windows grow with the hours you give it, up to a year of tournament days (52 blocks).

## Tennis on Kalshi's match history

Kalshi keeps every settled tennis market and every trade in it. The trainer downloads them (the match
markets, their minute quotes, and each match's full trade tape) and writes them into the replay:

- **Prices.** The real price path of the match, trade by trade. The book follows each trade: the side the
  taker hit moves to the trade price, the minute quotes' spread sits on the other side.
- **Flow.** Every trade with its size and its taker side (who bought YES, who bought NO).
- **Result.** The settlement after the match.
- **No score.** Kalshi keeps no score history.
  - A score rebuilt from the price path would only restate the price, and would teach the score-reading
    parts that the score never moves before the price. Live, the real score sometimes does.
  - So history trains on the real price swings (favour shifting, positions gaining and losing as the
    match plays out), and the real score effects come from the bot's own recordings, where the live score
    feed is recorded.

What trains on it:

- **Tennis network.** A tournament over the most recent replayed days, members judged on simulated bets
  against the market and settled by the result. The winner's settings then run through the training days
  match by match.
  - Each match has its own column, which used to start from nothing every match. Now a shared tennis
    template carries what each match learned into the next one.
  - Live matches keep adding to the template.
- **Tennis model.** Kalshi's match history plus the bot's recorded matches. Matches are split in time
  order, so the newest ones (the bot's own, with the live score) are the holdout it must beat the market on.

## The TA network already trains this way

- **Live-like replay.** It walks forward through years of history one closed hourly bar at a time, exactly
  as it reads the market live.
- **Graded on entries and exits.** Each call is a trade with a take-profit and a stop one forecast standard
  deviation away and a 4-hour time limit. The first one touched decides it.
- **Fitness.** The return of those trades over months it has never seen, after costs, penalised for
  drawdown. Calls that sit out too often score badly.
- **Holdout.** The last months are never seen by the tournament at all: the network has to beat a naive
  forecast there before it may speak live.
- **Rule book and setup scorer.** The same walk-forward test runs every TA rule by market character, and
  every chart setup with its own stops and targets.

## What each module learns from

| Module | Learns from |
|---|---|
| TA network, rule book, setup scorer | years of candles, walked forward and graded on entries and exits |
| Perps model, perps SNN | the history replay: every day of perpetual history since September 2019 |
| Kalshi SNN | the history replay's 15-minute / hourly contracts (real and synthetic) since 2017; its live gate on the bot's recordings |
| Tennis SNN, tennis model | Kalshi's tennis history (real prices and trades) + the bot's recorded matches |
| Intraday volatility profile | the replay's last 180 days |
| Whole-bot / Kalshi sweeps | the history replay's days with real Kalshi contracts |
| Kalshi decision model, volatility forecast | the bot's recordings: they learn from the full order book and the second-by-second index, which history does not contain |
| Fill model, sizing tuner, setup-SNN gate | the bot's own orders and trades: they measure the bot itself, so only its own record can teach them |

## Many candidates at once

Each SNN tournament fields a population of networks: about one per CPU thread on the laptop
(`AUTO_TRAIN_SNN_PBT_POPULATION`). It replays them in parallel worker threads (`TRAIN_WORKERS`). Every
round:

- the best network survives untouched;
- the worst quarter is replaced by copies of the best ones;
- the rest have their settings mutated;
- each is judged on days it has never seen.

A 16-thread laptop runs 15 candidates at once instead of 3, one after another.

## GPU

Not used. The networks are small spiking and feed-forward models written in TypeScript. A member's time
goes into replaying the market event by event (prices, books, features, decisions), which is branchy CPU
work a graphics card cannot run, rather than into big matrix multiplications. The population "stacking"
therefore happens across CPU threads, as described above.
