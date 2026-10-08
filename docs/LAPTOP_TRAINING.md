# Training on your own computer

The laptop trainer runs the bot's own training pipeline (`research/pipeline.ts`) on your computer. By
default it keeps going, round after round, until the bot stops improving or reaches the target. It uses
bigger budgets than the server's background job or the daily remote job. After every round that makes a
model better, it sends the models to the bot, which loads them without a restart.

## Windows: download and double-click

1. GitHub → **Releases** → **Laptop trainer (Windows)** → download `KalshiTrainer-windows.zip`. The
   zip is rebuilt on every change to the training code. You can also build it now from Actions →
   *Laptop trainer (Windows package)* → *Run workflow*.
2. Unzip it anywhere with about 40 GB free, then double-click `Train.cmd`. (The replay of all the history
   takes about 10 GB, the 1-minute history it is made from about 3 GB.)
3. The **trainer window** opens (a Microsoft Edge app window, in the bot dashboard's look). Choose:
   - **Continue where it left off** (the normal choice): only new data is downloaded, the tournaments carry
     on, and what is due is retrained.
   - **Sweep everything again**: the first round runs every step now, even the weekly ones (studies,
     tournaments, ablations, sweeps; the pipeline's `--sweep-all`). Your models, history and tournaments
     in progress are kept. It takes much longer.
   - **Hours**: 0 trains until it stops by itself; a number stops sooner.
   - **Server** (optional): the Lightsail public IP, user `ubuntu`, and the instance's SSH key file
     (Lightsail console → Account → SSH keys → Download). With it the trainer copies the bot's recordings
     and uploads the models; leave it empty to train on downloaded history only.

   Press **Start**. While it runs, the window shows:
   - two progress bars, **Downloads** and **Training**, each with the time left and the clock time it
     should finish (from how long the same steps took in the last rounds, and, for a step that reports
     its progress — contracts downloaded, tournament rounds, formula generations — from how fast it is
     going);
   - a third bar for the step in progress;
   - below them, a short **explanation** of what that step is doing;
   - the pipeline's output (folded away) and, after each round, the scoreboard;
   - a **champions leaderboard**: every tournament (TA network, the spiking networks) as a bracket of its
     last rounds' best (8 → 4 → 2 → the champion), and each coin's evolved formula, with the champion's top
     attributes: fitness, Sortino, drawdown, rounds won, its genetic generation and parents, and the
     settings that most set it apart from the population (▲ above, ▼ below the population's median). Best
     first; the brackets are laid out wide and scaled to fit the window, and the list scrolls.

   **Stop** ends the step in progress (finished steps and tournament rounds are kept; the next run
   continues). Keep the console window open while it trains: closing it stops the trainer.
   `trainer-data\GUIDE.txt` says how long to train before live trading and what good scores look like;
   `trainer-data\STATUS.txt` shows the scores after every round.
4. **New versions.** The window checks the *trainer-latest* release when it starts and every 6 hours. When
   it was built from a newer commit, the window asks whether to install it. Nothing is downloaded until
   you say yes. Then it:
   1. stops training;
   2. downloads the new zip;
   3. waits for the trainer to exit;
   4. unpacks the zip over the install folder (`trainer-data`, your data and models, is never touched);
   5. starts the trainer again.

   *Not now* hides the offer until a newer build appears.
5. `TrainConsole.cmd` is the old console-only way: it asks for the hours in the console (`--setup` asks for
   the server again) and prints everything there.

Nothing to install: the zip carries Node, the bundled trainer, and TA-Lib compiled for Windows.

## Any computer with Node 20+

```bash
npm ci
npm run train:laptop -- --host <server ip> --key ~/lightsail.pem            # until it stops by itself
npm run train:laptop -- --hours 12 --host <server ip> --key ~/lightsail.pem # or at most 12 hours
```

| Option | Meaning |
|---|---|
| `--hours N` | 0 (default): until it stops by itself (see [When it stops](#when-it-stops)); N > 0: also stop after N hours |
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
   Coinbase), the replay's 1-minute spot and perpetual bars, funding rates and open interest (5-minute,
   from September 2020), and a year of Kalshi's settled contracts, tennis matches with every trade. Each
   later run downloads only what is new.
3. **Rounds.**
   - Round 1 runs every step.
   - Each later round runs one tournament generation per network, on weeks of history that network has
     never trained on (see [History ledger](#history-ledger-which-weeks-each-network-has-trained-on)).
   - Then a contest on held-out weeks against the network in use, a retrain of the models that read the
     networks (and the TA network's tournament where it left off), and the readiness check.
   - Every 24 hours a round runs every step again: new history and new recordings from the server, so
     new weeks to train on.
   - Each module is trained and judged on its own. It replaces the model in use only when it beats it
     (`AUTO_TRAIN_CHAMPION`).
   - The sweep tunes the bot as a whole (a proposal, weekly in a long run).
4. **Push (SSH).** After every round that made a model better, and at the end: the models directory to the
   server, newer files only (not the caches or the links to replay days). The running bot hot-swaps every
   model that changed. A file changed here is never overwritten by an older copy from the server.

The pipeline saves progress after every step. Stopping with Ctrl+C or closing the window loses at most
the step in progress, and the next run picks up the tournaments where they stopped.

## When it stops

After every round it reads the readiness check (`models/readiness.json`, below) and stops when:

- **The target is reached.** On days nothing was trained or tuned on, the whole bot earns at least
  `TRAIN_TARGET_DAILY_PCT` of `TRAIN_TARGET_POOL_USD` a day. The defaults are 50% of $200, that is $100
  a day. The lower end of the 95% interval must reach it, so it has to hold consistently, not just on
  average. The drawdown must stay within `TRAIN_TARGET_MAX_DD_PCT` (default 10%), over 30 days or more.
- **It stops making progress.** `TRAIN_PLATEAU_ROUNDS` rounds in a row (default 3) improve nothing: no
  challenger beat the model in use, and no tournament is still running. A promotion that only ties (the
  same score, or as many validated parts, kept for its fresher data) is not progress.
- **No fresh history is left.** Every replayed network has trained on every week, and the round improved
  nothing. New weeks arrive with time, so run it again later.
- **Or** the hours you gave it are up, or you press Ctrl+C.

Set these in `trainer-data/trainer.env` (written on the first run, `KEY=VALUE` lines; credentials and
paths are ignored there). After each round the trainer writes the scoreboard to `trainer-data/STATUS.txt`
and appends a line to `trainer-data/rounds.jsonl`.

### About the default target

$100 a day on $200 is +50% a day. Compounded, that is about 190,000x in 30 days. No trading system keeps
that up: the best funds make 20-40% a *year*, and a genuinely good bot on a small account might make 0.2%
to 1% a day. The trainer is built to aim at the target you set, but expect it to stop on "no progress"
long before it gets there. That stop is still a useful answer: the models are as good as this history can
make them. Set `TRAIN_TARGET_DAILY_PCT=0.5` to stop at a realistic bar instead.

## Getting the bot ready for live trading

`trainer-data/GUIDE.txt` (also printed at the start of every run) says the same as this section:

1. **Let the trainer run until it stops by itself.** Round 1 can take a day or more on a 16-thread laptop,
   since it downloads years of history first. Each later round takes several hours. Give it at least 3 rounds. Round 1 makes the first models;
   round 2 is the first where challengers must beat them; the scores mean something only after that.
2. **Paper-trade on the server for 2 to 4 weeks** with the trained models. The dashboard's paper P&L
   should look like the readiness check: same sign, similar size, drawdown no worse.
3. **Only then consider real money,** and start small. The server's daily training keeps the models
   current. Run the trainer again every week or two: it continues where it stopped, and only weeks no
   network has trained on count as fresh.

What good scores look like (after fees, on held-out days):

| Part | Good |
|---|---|
| Whole bot | mean daily return above 0 with the whole 95% interval above 0. 0.2% to 1% a day is very good (0.5% a day compounds to about 6x in a year). Sharpe 2 or more, max drawdown within 10-15%, 55% or more winning days, over 30+ days. STATUS.txt then shows `solid: YES` |
| Perps model | IC 0.02 to 0.05 or more with its lower bound above 0, net bps per trade above 0 after fees, DSR 0.95 or more, the execution backtest passed |
| TA network | heads validated on the holdout, network DSR 0.95 or more |
| Setup scorer | both lanes validated (holdout and final window) |
| Kalshi decision model | log loss below the calibrated market's, Diebold-Mariano p below 0.05 |
| SNNs | challengers that win their contests on held-out weeks |

Live results are usually worse than any backtest.

## Readiness: the whole bot on days nothing was trained on

The pipeline's last step, `readiness` (`research/readiness.ts`), writes `models/readiness.json`:

- **The whole bot.** Kalshi's contracts through the production backtester and the perps setup lanes, from
  one pot of capital under one daily loss stop (`research/wholeBot.ts`), on a pool of
  `TRAIN_TARGET_POOL_USD`, with the live settings.
- **Its days.** The replay's days with Kalshi's real contracts (else the bot's recordings), with three
  limits:
  - the newest 15%, which is the sweep's final window, so it was never tuned on;
  - minus the days the Kalshi decision model was fitted on (its own holdout stays in);
  - at most the newest 90.
- **Out of sample throughout.** The setup scores on those days come from models that never saw them, and
  the SNN outputs are prequential.
- **Per day, in percent of the pool:** the mean and its 95% bootstrap interval, the median, the share of
  winning days, the worst day, the largest drawdown of the equity curve, the annualised Sharpe. Then
  whether it meets the target and whether it looks solid.
- **Every model's state:** present, validated, and the key numbers.
- **Each network's place in the history ledger:** weeks used, fresh weeks left, contests run.

## History ledger: which weeks each network has trained on

`research/historyLedger.ts` keeps `models/work/history-ledger.json`. The replay's days are cut into ISO
weeks, Monday to Sunday UTC, labelled like `2021-W19`. For every network the ledger records which weeks it
has trained on and been judged on, and each tournament generation and contest with its weeks.

- **Holdout weeks.** Every 8th week older than half a year. No network ever trains on them. They are where
  a challenger must beat the model in use before it may replace it, so a champion is never crowned on data
  it learned from. The set is fixed: weeks are counted from a fixed Monday, so it never shifts as history
  grows.
- **Training weeks.** All the others. Each tournament generation takes weeks the network has never trained
  on, spread over all the years (`AUTO_TRAIN_SNN_PBT_DAYS` / 7 weeks a generation). Tournaments that keep
  running never grind the same weeks again. The population carries on from one generation to the next,
  and a network replaying an earlier week starts that day fresh (its learning kept, the market state
  cleared).
- **No fresh week left.** The tournament is skipped until new weeks complete. A tournament that must run
  anyway (a new stage, no settings yet) takes the weeks used least.
- **Contests** use the holdout weeks the network has been judged on least (`AUTO_TRAIN_CONTEST_WEEKS`,
  default 2), so repeated contests do not keep reusing the same few weeks either.

What uses it:

- **Kalshi SNN and perps SNN.** The tournament runs on the generation's fresh weeks. The network that goes
  live then trains on the latest weeks, since it must know today's market. Those are never holdout weeks.
  Then the contest:
  - the new network and the one in use replay the same held-out weeks from their own model files,
    learning online as they would live;
  - each is scored like a tournament member;
  - the challenger is promoted only if it scores better.
- **Perps model.** It trains without the holdout weeks, and its execution backtest runs on them. Before it
  replaces the model in use, both are scored on the holdout weeks by the live rule's net P&L per trade.
  This happens only when the model in use was also trained without them (marked in its file), with at
  least 20 trades each.
- **Tennis network.** It trains on the newest tennis days once, then learns live. The ledger records the
  weeks it used.

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
  recordings show, with Binance's funding rates and open interest. Open interest is Binance's 5-minute
  reading, carried for at most 10 minutes. Where Binance has none (before September 2020, or a gap), the
  quote has none, as live when the feed is down. The perps model's open-interest features read it.
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
  2019) except the ledger's holdout weeks, one sample per coin every 15 minutes. Each day's samples are
  kept, so a run computes only the new days; the first run computes all of them on every core at once. Its
  execution backtest and its contest run on the holdout weeks.
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
- **SNN tournaments span every era.** Each generation's weeks are fresh weeks spread from the first year
  of history to the latest days (bull and bear markets, crashes, quiet years), so the winning settings
  have to hold up in every kind of market. The network that goes live then trains on the latest days, and
  must beat the one in use on held-out weeks.

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

A run that goes until it stops gives each tournament generation about 5 weeks and trains each network on
its latest 24 days. A run with a budget sizes them by the hours: 12 hours covers about 30 tournament days
(four weeks across the years) and 14 training days per network, up to a year of tournament days
(52 weeks).

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
| Evolved formulas (genetic programming) | years of hourly candles of the coin plus BTC and ETH: trained on the oldest 60%, chosen on the next 20%, tested on the newest 20% |
| Perps model, perps SNN | the history replay: every day of perpetual history since September 2019 (open interest from September 2020), except the holdout weeks |
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

**Breeding.** Every week of history (4 judged days) is a generation. The 3 networks with the best mean over
it breed: every pair has one offspring.
- **Knobs:** mixed from both parents, leaning towards the values that have kept winning (a trait memory of
  every evaluation), then nudged by about ±3%.
- **Columns:** taken from whichever parent's column made more. Each column is one asset and horizon.
- **Who makes room:** the offspring replace the worst networks; the parents and the best runners-up carry
  on.

A round of the trainer runs about 5 generations, so a run that goes until it stops covers 20 to 50 of
them. docs/EVOLUTION.md has the details and the measurements behind the settings.

**Evolved formulas.** Every round also runs the genetic programming of trading formulas (`gp`). Per coin,
it evolves 2,000 random formulas per worker thread (up to 15,000, the video's population) for 15
generations, scored in parallel on every thread. A coin's formula is replaced when a new champion beats it
on the newest years. On an 8-thread laptop a round's `gp` step takes about 10 minutes for the five coins.

## GPU

Not used. The networks are small spiking and feed-forward models written in TypeScript. A member's time
goes into replaying the market event by event (prices, books, features, decisions), which is branchy CPU
work a graphics card cannot run, rather than into big matrix multiplications. The population "stacking"
therefore happens across CPU threads, as described above.
