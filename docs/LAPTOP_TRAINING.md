# Training on your own computer

The laptop trainer runs the bot's own training pipeline (`research/pipeline.ts`) on your computer. It
has no time cap and uses bigger budgets than the server's background job or the daily remote job. It
then sends the winning models to the bot, which loads them without a restart.

## Windows: download and double-click

1. GitHub → **Releases** → **Laptop trainer (Windows)** → download `KalshiTrainer-windows.zip`. The
   zip is rebuilt on every change to the training code. You can also build it now from Actions →
   *Laptop trainer (Windows package)* → *Run workflow*.
2. Unzip it anywhere with about 30 GB free, then double-click `Train.cmd`.
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
   Coinbase) and a year of Kalshi's settled contracts. Each later run downloads only what is new.
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

With `HISTORY_REPLAY=true` (on in the laptop profile), the pipeline turns two years of 1-minute history
into recording files (`research/history/historyReplay.ts`, step `history_replay`). The replay code reads
them exactly as it reads the bot's live recordings:

- **Index and spot prints.** Four per minute from Binance 1-minute bars. The index is shifted onto
  Kalshi's own level using each 15-minute contract's strike.
- **Candles.** The live feed's timeframes; every day file is self-contained.
- **Perp quotes.** From Binance USD-M bars, at the spread and contract specs the bot's own perp
  recordings show, with Binance's funding rates.
- **Kalshi's settled contracts.** Their markets, minute books, trades and results.

The models replay it without knowing it isn't live:

- **Perps model:** trains and backtests on the replay (years instead of days).
- **Perps SNN:** its tournament, training and entry / exit learning on direction calls run on the
  replay.
- **Whole-bot and Kalshi sweeps:** the fitness of the entire pipeline together runs over the replay.
  The result is a proposal, never auto-applied.
- **Kalshi SNN and decision model:** stay on the bot's own recordings. A replayed Kalshi book is one
  quote a minute with nominal size, too coarse to learn entry and exit timing honestly.

## What each module learns from

| Module | Learns from |
|---|---|
| TA network, rule book, setup scorer | years of candles |
| Perps model, perps SNN | the history replay (years of perp history) |
| Whole-bot / Kalshi sweeps | the history replay |
| Kalshi decision model, crypto SNN, volatility model | the bot's recordings (copied from the server) |
| Tennis, fill model | live only |

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
