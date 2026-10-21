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

   **Skip data download** (under Start, also used by Start conditioning): the server's recordings are not copied
   and no history is downloaded (the pipeline runs with `--skip history`); training starts at once on the data
   already here. Two things still happen, because training needs them and they are small: the index series saved
   on the server (BTC.D, USDT.D and the rest, a few files) are copied, and a series still missing from disk after
   that is fetched once from TradingView (the `history-index` step; nothing is refreshed, so after the first time
   training never fetches it). The models are still sent back to the server afterwards. It is not remembered
   between sessions.

   **Kalshi sweeps** (under Start, off by default, remembered): runs the sweeps that replay Kalshi's contracts,
   `sweep-kalshi` and `sweep-bot`. Every setting they try is a full Kalshi backtest over the replay days, so they
   take hours. Unticked, they are skipped and the other sweeps (the setup lanes) still run. They only ever write
   proposals, never change the bot. From the console: `--kalshi-sweep` / `--no-kalshi-sweep`.
   - **How hard should it work?** Gentle, Balanced (the default) or Full speed; see *Keeping the computer
     usable* below. The choice is remembered.
   - **Session length**: a slider from 30 to 120 minutes, 60 by default. See [Sessions](#sessions) below.
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

   **Stop** ends the step in progress (finished steps, tournament rounds and the networks that finished a round
   are kept; the next run continues, see "Stopping and starting again" below). Keep the console window open while it trains: closing it stops the trainer.
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

## Keeping the computer usable

Earlier versions could freeze the laptop when it was used for anything else during training. Each process was
allowed 8 GB of memory, and so was every worker thread: a process-wide memory limit overrides a worker's own. One
worker ran per CPU thread but one, at normal priority. The GPU trainer queued a whole epoch of work at once and
could fill the graphics card's memory, which the display shares. Together, they could push Windows into swapping
or into resetting the graphics driver.

The trainer now sizes itself to the computer (`research/trainerResources.ts`):

- **A plan per intensity.** A quarter of the memory (at least 3 GB) is always left for you and Windows. The
  rest is shared between the pipeline and its worker threads, at about 1.5 GB a worker.

  | | CPU threads used | while you use the computer | GPU memory | GPU pauses |
  |---|---|---|---|---|
  | Gentle | a quarter | one | 60% | a sync every 10 steps, 20 ms (40 ms while you use it) |
  | Balanced | half | a quarter of the threads | 75% | every 25 steps, 5 ms (20 ms) |
  | Full speed | all but two | the same | 90% | every 100 steps, none |

  Memory can lower these. A 16-thread laptop with 16 GB runs 5 workers (Gentle: 4); with 32 GB, Balanced
  runs 8. The tournaments field one network per worker, and the evolved formulas 2,000 per worker.
- **The history download.** Years of 1-minute bars are fetched and stored a year at a time, oldest first.
  It used to hold all of a coin's archives in memory before storing them: several GB per coin, six coins at
  once on a first download. Measured on 3 coins × 4 years: a peak of 2.5 GB instead of 5.4 GB, and a little
  faster.
- **Priority.** The trainer, the pipeline, PyTorch and every worker run below normal priority (Gentle: the
  idle class), so whatever you do comes first. The trainer window itself runs at normal priority.
- **Memory caps that hold.**
  - The pipeline's own process keeps up to 8 GB where the computer has it: its history step holds years of
    1-minute bars, about 5.5 GB.
  - Each worker thread has its own, smaller cap. The trainer clears the process-wide limit that used to give
    every worker the pipeline's 8 GB.
  - A job that runs out is run again with twice the room, up to 8 GB, so the cap stops a runaway job without
    failing a step.
  - On a small machine, after a round in which the pipeline ran out of memory, the next rounds give it twice
    as much, up to 8 GB.
- **The governor.** Every 15 s it checks free memory and, on Windows, whether you used the keyboard or mouse
  in the last 90 s.
  - Low on memory: the worker pools start no new work and let idle workers go.
  - You are using the computer: they run fewer jobs at once and the GPU trainer pauses longer.

  It tells the pools and the GPU trainer through `trainer-data\throttle.json`. The window shows what it is
  doing under the progress bars, for example `balanced: 4 of 8 threads · you are using the computer · 9.1 of
  16.0 GB memory free`.
- **The GPU.** The PyTorch trainer:
  - drains the GPU's queue every few steps and pauses after it, so the desktop is never stuck behind a long
    queue (the cause of Windows' "display driver stopped responding");
  - takes at most the plan's share of the GPU's memory. A training pack that does not fit trains on the CPU.
  - uses only the plan's CPU threads (`TA_NET_TORCH_THREADS`; the math libraries under it get the same).
- **A record.** Once a minute, `trainer-data\resources.log` records free memory, the trainer's own memory, the
  threads in use and why. If the computer freezes, crashes or loses power during a run, the next start says
  so in the window, with the last readings before it happened. The run's own log,
  `trainer-data\models\logs\pipeline-laptop-<start>.log`, has every step's output and the trainer's own lines
  (`[trainer ...]`: copies from and to the server, the PyTorch and TradingView setup, round results).

**If it still freezes:** choose Gentle, and look at the last lines of `resources.log` from before the freeze.
- Free memory falling to a few hundred MB: memory is the cause. Close other heavy programs, or lower
  `TRAIN_WORKERS` in `trainer.env`.
- Plenty of memory free: the cause is elsewhere, most likely the graphics driver. Update it from nvidia.com
  or Lenovo Vantage.

The console version takes `--intensity gentle|balanced|full`. Any of the plan's settings can be set in
`trainer.env`: `TRAIN_WORKERS`, `TRAIN_WORKER_HEAP_MB`, `TRAIN_MIN_FREE_MB`, `NODE_OPTIONS`,
`TA_NET_TORCH_THREADS`, `TA_NET_GPU_MEM_FRACTION`, `TA_NET_GPU_SYNC_EVERY`, `TA_NET_GPU_YIELD_MS`.

## Any computer with Node 20+

```bash
npm ci
npm run train:laptop -- --host <server ip> --key ~/lightsail.pem              # a 60-minute session
npm run train:laptop -- --minutes 120 --host <server ip> --key ~/lightsail.pem # a 2-hour session
npm run train:laptop -- --hours 0 --host <server ip> --key ~/lightsail.pem     # no clock: until it stops by itself
```

| Option | Meaning |
|---|---|
| `--minutes N` | The session's length (default 60); see [Sessions](#sessions) |
| `--hours N` | The same in hours; 0: no session clock, rounds until it stops by itself (see [When it stops](#when-it-stops)) |
| `--data DIR` | Data, history and models, kept between runs (default `./trainer-data`) |
| `--days N` | Recorded days to copy (default 45) |
| `--no-pull` / `--no-push` | Skip copying data down / sending models up |
| `--only a,b` | Run only these pipeline steps |
| `--setup` | Ask for the server details again |

## Sessions

A run is a **session** of a set length: 60 minutes by default, 30 to 120 on the window's slider (`--minutes` in the
console). The pipeline keeps to it (`TRAIN_SESSION_MIN`, research/sessionClock.ts):

- **The clock starts with the first training step.** The copy from the server and the data steps (the history
  download, the replay build, the TradingView index fill) come before it and aren't counted.
- **The networks get the first 70%** (the TA network, the walk-forward export, the formulas, the SNN tournaments and
  training). **The models that read them get the rest** (`SESSION_DECISION_SHARE`, 0.3): the vol model, the dataset,
  the Kalshi MLP, the perps, tennis and fill models, sizing, the playbook and the readiness check. Their part starts
  with the first of them, so time the networks didn't use goes to them.
- **No step starts once its part is used up.** The log says `skipped (the networks' part of the 60-minute session is
  used up ...: it runs next session)`.
- **The long steps stop at their next unit.** A tournament (TA network, SNNs) stops before its next round and
  carries on next session; GP stops before its next generation (a coin it didn't reach keeps its formula); the
  sweeps and the walk-forward export get at most what is left of the part. A step that can't stop part-way (an SNN's
  training, a weekly study) finishes once started.
- **Its budgets are sized to it.** An hour gives each SNN tournament generation a week of history (it takes a few
  sessions), an SNN 4 training days, and Kalshi's contract history 6 minutes of downloading (it resumes). Two hours
  give the same; longer sessions grow them (24 hours: 36 tournament days, 24 training days). The sweeps, which only
  write proposals, run weekly.
- **The SNN whose tournament ran longest ago goes first,** so a session that ends inside one network's tournament
  leaves the other one for the next session.
- **Each model goes to your server as soon as its step finishes** (and the bot swaps it in), so a session closed or
  crashed part-way keeps what it finished. What is left (tournament progress) goes at the end.

A run with `--hours 0` has no clock: rounds until it stops by itself, each sized like a day.

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
   - The first round runs every step, unless a run in the last 24 hours already finished the history and the
     replay (`trainer-data\trainer-state.json`): then it goes straight on with the training.
   - Each later round runs one tournament generation per network, on weeks of history that network has
     never trained on (see [History ledger](#history-ledger-which-weeks-each-network-has-trained-on)).
   - Then a contest on held-out weeks against the network in use, a retrain of the models that read the
     networks (and the TA network's tournament where it left off), and the readiness check.
   - Every 24 hours a round runs every step again: new history and new recordings from the server, so
     new weeks to train on.
   - Each module is trained and judged on its own. It replaces the model in use only when it beats it
     (`AUTO_TRAIN_CHAMPION`).
   - The sweep tunes the bot as a whole (a proposal, weekly in a long run).
4. **Push (SSH).** As soon as a step finishes with a new model the bot loads, after every round that made a model
   better, and at the end: the models directory to the server, newer files only (not the caches or the links to
   replay days). The running bot hot-swaps every
   model that changed. A file changed here is never overwritten by an older copy from the server.
   - **As each step finishes:** when a step leaves a new file at the top of the models folder (a model it promoted),
     the trainer sends it while the next step runs. Work in progress never triggers a send (a tournament stopped
     mid-round replaces no live model); its progress files go along with the next send. Only what was written by the
     time the step reported done goes: a file the next step is still writing waits for that step's send.
   - **At the start of each run** too: any model newer than the server's copy goes up first, so models from a run that
     was closed before its last send (or had no server set) still arrive.
   - **Every send is checked:** the server's models are listed again and each file must be there with its size and
     time. Each send is recorded in `trainer-data\pushes.jsonl`, and STATUS.txt's first line says where the models went
     (`Server: ... Last send ...: 7 file(s), 7 confirmed on the server`, or `Server: NOT SET`).
   - **No server set:** the window warns above Start, and the models stay on the laptop. The Server section needs your
     Lightsail address, the user (`ubuntu`) and the path to its SSH key (.pem).

**Stopping and starting again.** Press Stop, Ctrl+C, or close the window, and the next run picks up where this one
stopped:
- **Finished steps are saved** after each one, and aren't run again until they're due.
- **No repeat of the day's history.** A run started within 24 hours of the last full round doesn't download
  the history or rebuild the replay again.
- **Tournaments keep finished members.** A tournament round is every network training and being judged over
  several days. Each network that finished the round before the stop is kept, so the resumed round only runs
  the rest. This applies to the SNN tournaments and the TA network's.
- **Unchanged retrain steps are skipped.** These are the vol model, the dataset, the Kalshi MLP, the vol
  profile, the perps and tennis models, and the playbook. One is skipped when nothing it reads has changed
  since its last run: the same code and settings, no new recordings, replay days or SNN outputs, and no model
  it reads replaced. Readiness reuses its whole-bot replay on the same terms and still refreshes the models'
  status. The log says which steps were skipped and why. `AUTO_TRAIN_SKIP_UNCHANGED=false` turns this off.

What can still be lost: the step in progress when you stop, minus the members a tournament already finished.

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
- **Or** the session is over, or you press Ctrl+C.

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

1. **Train a session a day for the first week or two.** The first session can take longer, since it downloads
   years of history before the clock starts. Each network's tournament runs a few rounds a session and finishes a
   generation every few sessions; then the network is retrained and must beat the one in use. The first sessions
   make the first models, the later ones must beat them; the scores mean something only after that.
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

## Conditioning mode

The trainer window has a second button, **Start conditioning**. It is greyed out until a normal run has finished since the last conditioning run. You can still press it; it asks "are you sure?" first. It runs one pressure-test tournament of the freshly trained bot on unseen history days, with tiers from $1000 down to $100 and a 35% cull, then sends the results to the server like a normal round. An Elite Champion replaces the live bot's trading settings, and the dashboard can roll it back. The rules are in docs/AUTOMATION.md §10.

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

## Are all the setup scorer's inputs there?

Before each setups training, the log gives one line on the scorer's optional inputs. It names each input and what its producer did this round, for example:
`setups: inputs: TA network walk-forward: yes; fractal (BTC.D daily 2016-01-01..2017-12-31): yes; waterfall USDT.D leg (USDT.D daily from 2016-01-01): yes; Librarian walk-forward: MISSING (librarian FAILED this round: ...); cross-graph walk-forward: yes; cross-coin lead-lag (15 / 60 min): yes`

- **TA network walk-forward:** step `ta_net_oos`.
- **Fractal inputs:** BTC.D daily history covering 2016-2017. The history step's TradingView fill fetches it (tvdatafeed, set up once in `trainer-data\tv-env`): 5,000 daily bars of CRYPTOCAP:BTC.D, back to 2013, in one request.
- **Waterfall USDT.D leg:** USDT.D daily history from 2016, fetched the same way. One request returns CRYPTOCAP:USDT.D back to 2015.
- **Librarian:** step `librarian`, weekly. It also runs whenever its forecasts file is missing, for example when its model was copied from the server without them.
- **Cross-asset graph:** step `cross_graph`, weekly, with the same rule.
- **Cross-coin lead-lag:** step `cross_lead`, weekly, on the 1-minute history the history step downloads for the replay. It counts as there only when the study validated a leader / coin pair at 15 or 60 minutes (the horizons the scorer reads). Otherwise the line says what the study found, for example `MISSING (the study (40 pairs tested) found no leader / coin pair predictive at 15 or 60 minutes; cross_lead ran this round)`. That is a finding, not a fault.

When an input that was missing at the last setups training arrives, the scorer is retrained in that round. It doesn't wait for `SETUP_RETRAIN_DAYS`.

## BTC.D and USDT.D

Every part of the bot that reads BTC dominance (BTC.D) or USDT dominance (USDT.D) gets them in training
too:

| Part | Live | In training |
|---|---|---|
| Kalshi SNN and perps SNN (USDT.D 15-minute change input) | the live rebuild, every second | the replay's rebuild |
| Perps model (USDT.D change, BTC.D change by coin) | the live rebuild | the replay's rebuild, every perpetual day since 2019 |
| Kalshi decision features, the TA snapshot's dominance quadrant, the alt-coin risk-on rule | the live rebuild | the replay's rebuild in the backtests and sweeps |
| TA network | BTC.D / USDT.D daily charts; hourly, Binance's BTC dominance index and the market basket | the same series: TradingView's daily charts (BTC.D back to 2013, USDT.D to 2015) plus the bot's own bars |
| Fractal Alignment Engine and waterfall mode (BTC.D's 2016-2017 parent, the 55% gate, the USDT.D breakdown leg), and the setup scorer's fractal inputs | BTC.D / USDT.D daily from the server's history store (TradingView plus the bot's own bars, reloaded hourly) | the same daily series, read point in time for every setup |

**Where the daily history comes from.**
- **Fetching:** the history step's TradingView fill (tvdatafeed) gets 5,000 daily bars per series in one request: BTC.D back to 2013 and USDT.D back to 2015.
- **Coverage rule:** both must reach back to 2016 (the Fractal Alignment Engine's parent window, and the same years for the USDT.D leg). A store that starts later, for example one imported from 2018, gets the full backfill. That backfill is asked at most weekly, in case TradingView itself starts later.
- **Where they're kept:** on the laptop, in `trainer-data\history\tradingview\`. The server's daily training runs the same fill with its own tvdatafeed and keeps its own copy, which the live bot reads. The trainer copies the server's copy down with the rest of its history (also with *Skip data download*: the index series alone), so a laptop connected to the server never has to fetch them; nothing goes from the laptop to the server.

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
- **The tournament:** runs one network per worker thread at the same time. A 16-thread laptop with 32 GB
  on Balanced puts 8 networks through each day in that same time (see *Keeping the computer usable*).

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

Each SNN tournament fields a population of networks: one per worker thread of the resource plan on the laptop
(`AUTO_TRAIN_SNN_PBT_POPULATION`). It replays them in parallel worker threads (`TRAIN_WORKERS`). Every
round:

- the best network survives untouched;
- the worst quarter is replaced by copies of the best ones;
- the rest have their settings mutated;
- each is judged on days it has never seen.

All members of a round replay the same days, so the work that does not depend on the network (reading the
recordings, the order books, the feature maps, pricing every contract) is done once: the first request for a
span records its **input tape** (`work/snn-tape/<domain>`), and every member plays that tape on its own network.
A member's results are bit for bit what its own replay of the recordings gives; it runs about 1.8 times faster,
and the next round's tape is recorded on a free worker while the current round plays. The champion contest
shares each day's tape between the two networks. Tapes are reused while their recordings, the TA network, the
history store and the trainer's code are unchanged; the least recently used are deleted past
`SNN_TAPE_CACHE_GB` (default 10). `SNN_TAPES=false` turns them off.

**GPU groups in the tournaments.** When the trainer's PyTorch sees a CUDA GPU, the crypto and perps tournaments also
play members on it (`research/snnGpuSched.ts`). Each round, a group of the members waiting on the round's tape plays it
together with their columns on the GPU (the tournament engine below), in a worker thread of its own, while the others
play it one per CPU worker as before. The group takes the share that lets both sides finish together: with Q members
waiting, C CPU workers and a GPU member worth r CPU cores, about Q·r/(C+r). r is measured on every round (the log
prints it: `SNN GPU group: 6 member(s) in 41.0 s next to 10 on 7 CPU worker(s); a GPU member ≈ 2.4 CPU core(s)`).
The group's worker thread takes one of the CPU workers' places. Every member's rows and saved network are the same bits
wherever it played, so the GPU changes how long a round takes, never its result. If the GPU fails, the members go back
to the CPU for the rest of the tournament. Members with gap junctions, or a mechanism the GPU kernel lacks, always play
on the CPU. A tournament of fewer than `SNN_GPU_MIN_MEMBERS` members (default 8) plays every member on the CPU: beside
the CPU workers its group would get 1-2 members, worth about the one core its worker thread takes (your laptop's
5-member tournaments). Settings: `SNN_GPU=false` turns it off; `SNN_GPU_GROUP` is the most members in a group (default 16);
`SNN_GPU_GROUPS` is how many groups run at once, each with its own worker thread (default: what `SnnGpuBench.cmd` found
best on this computer, else 1); `SNN_GPU_SPEEDUP` is the guess for r before the first group is measured (default: the
bench's, else 2). The GPU kernels take microseconds and the trainer waits for
each step's results, so they never queue long work in front of the desktop.

**GPU check for the SNN (prototype).** `SnnGpuBench.cmd` (next to `Train.cmd`; close the trainer first) tests whether
the SNN tournaments could run on your GPU without changing a single result. It records a few hours of the crypto
network's column steps from your replay and runs them on the GPU as many tournament members at once, with two kernels:

- **thread** (`python/snn/column.cu`, up to 64 members): one GPU thread per member and column. Each thread runs a whole
  column alone, in 64-bit floating point, which a laptop GPU computes at about 1/64 of its 32-bit speed. The first
  report (RTX 5060 laptop) had it at about 1.4 times one CPU core with 64 members, far behind the CPU's threads.
- **block** (`python/snn/column_par.cuh`, 1 to 256 members): one thread block per member and column. The column's
  neurons, dendritic branches, synapses and predictive-coding rows are spread over the block's 64 threads, and the
  synaptic scatters become gathers in the same order. Sums whose order matters stay on one thread.

Both use the TypeScript's operations in the same order, V8's own exp/log/tanh and no fused multiply-add. Every member
is checked bit for bit against the TypeScript network; the CPU twin of the block kernel (`python/snn/par_cpu.c`, real
threads and barriers) is checked the same way by the tests. The run prints the time per step next to one CPU core and
next to the tournaments' CPU threads. The report is `trainer-data\snn-gpu-bench.json`. It needs only the trainer's
PyTorch (no CUDA toolkit). It changes nothing in training.

It then checks the **tournament engine** (`research/snnGpu.ts`): groups of 8, 16 and 32 crypto members (one unchanged,
the rest with mutated knobs) play two hours of the tape together. Their columns live on the GPU (`python/snn/pool.py`, a
helper process holding every column's state; `python/snn/group.cuh`, the block kernel for one step of every column of
the group). Each member's network-level logic (inputs, cross-column terms, readouts, health, the NaN guard) stays in
TypeScript: per step it sends one small record per column and gets back the column's scalars, mean rates and, when a
readout or score needs them, its rate vectors. Members 0 and 1 are checked bit for bit (rows and the full saved network)
against the same members played on the CPU, and the run prints each group's time next to one CPU core. The results go
under `engine` in the same report. Members with gap junctions, or a mechanism the GPU kernel lacks, stay on the CPU.

One group is held back by its own thread, which runs every member's network logic, not by the GPU. On the RTX 5060
laptop, a group of 16 or 32 members was worth about 3.1 CPU cores, and the GPU was busy only about a quarter of the
time. So the bench then runs 1, 2, 3 and 4 groups of 16 at once, each in its own worker thread with its own device pool,
as the tournaments do, and checks them bit for bit too. The tournaments then run the most groups whose last one still
adds more than a core net of the thread it takes (`engine.recommend` in the report; `SNN_GPU_GROUPS` overrides it).

A 16-thread laptop with 32 GB on Balanced runs 8 candidates at once instead of 3, one after another (Full speed:
up to 14, as memory allows).

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

Everything that trains a neural network in batches runs in PyTorch, on the GPU:

| Step | What trains on the GPU |
|---|---|
| `ta_net`, `ta_net_oos` | The TA network's tournament and its walk-forward export for the setup scorer |
| `cross_graph` | The cross-asset graph network (`XG_ENGINE=auto`) |
| `mlp` | The Kalshi decision model: every fold of every candidate network is sent as one batch, then the final network and its ensemble, then the CPCV splits (`MLP_ENGINE=auto`) |
| `tennis` | The tennis model's network |

The MLPs train with the same algorithm and from the same starting weights as the TypeScript trainer, so they come out the same network (CI checks this). The live bot runs them unchanged.

What stays on the CPU, and why:
- **The SNN tournaments.** A member's time goes into replaying the market event by event, which is branchy work a graphics card can't run. Population "stacking" there happens across CPU threads (above).
- **The gradient-boosted trees.** These are the setup scorer, the perps and vol models, and the GBDT candidates. Trees are built split by split.

**Setup is automatic, on the first run that trains the TA network:**
1. The trainer finds the NVIDIA GPU (`nvidia-smi`).
2. With the bundled `uv\uv.exe`, it creates `trainer-data\python-env` (Python 3.12, downloaded into `trainer-data\python-dist`).
3. It installs the CUDA 12.8 build of PyTorch there. RTX 50xx (Blackwell) cards need CUDA 12.8. This is a one-time download of about 3 GB.
4. It runs a small network through PyTorch and through TypeScript, and checks that they agree.

The window's log shows each step, and then: `TA network trains in PyTorch ... on the GPU (NVIDIA GeForce RTX 5060 Laptop GPU)`. Later runs only check the environment, which takes a few seconds.

- **No NVIDIA GPU:** it installs the CPU build instead (about 300 MB), which is still about 4 times faster than the TypeScript trainer.
- **Anything fails** (no internet, an old driver, a failed check): the TA network trains in TypeScript as before. The log says why, and the next run tries again.
- **Driver:** CUDA 12.8 needs NVIDIA driver 570 or newer. If the log says the GPU does not answer, update the driver from nvidia.com or the Lenovo Vantage app.

**The tournament in progress continues.** Weights move between TypeScript and PyTorch unchanged, so a saved tournament (say, round 70 of 96) carries on from where it stopped. After every tournament round, the log shows the speed: `round N: PyTorch trained ... samples in ... s (.../s, CUDA graph)`.

To check or set up PyTorch without training, run `node\node.exe app\dist\laptopTrain.cjs --torch-check --data trainer-data` from the KalshiTrainer folder. Exit code 0 means it is ready.

To keep the TA network in TypeScript, put `TA_NET_ENGINE=ts` in `trainer-data\trainer.env` (`MLP_ENGINE=ts` for the MLPs, `XG_ENGINE=ts` for the graph network). To use a Python you already have that includes PyTorch, put `TA_NET_PYTHON=C:\path\to\python.exe` there.

To free the disk space PyTorch takes, delete `trainer-data\python-env`, `python-dist` and `uv-cache`. They are set up again on the next run (TypeScript if not).
