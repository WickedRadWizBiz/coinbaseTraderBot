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

## What each module learns from

| Module | Learns from | Available from day one? |
|---|---|---|
| TA network (direction, volatility) | years of hourly / 15-minute spot candles | yes |
| Rule book, market character | years of candles | yes |
| Setup scorer (perps fast / slow lanes) | years of candles | yes |
| Volatility model, intraday profile | Kalshi's index in the bot's recordings | grows with recordings |
| SNNs (crypto, perps) | the bot's recordings, replayed | grows with recordings |
| Kalshi decision model (MLP + take/skip) | priced Kalshi contracts with outcomes in the recordings | grows with recordings |
| Perps model | Kalshi perp quotes in the recordings | grows with recordings |
| Tennis, fill model | live matches / the bot's own quotes | live only |

The candle-history modules are fully pre-trained by one long run. The Kalshi contract models still learn
from the bot's own recordings, because their inputs (order books, Kalshi's index, contract prices) are not
in candle history. Binance's perpetual-futures candles (`history:binance -- --markets um`) can be
downloaded, but no model reads them yet. Years of Kalshi's settled contracts are downloaded too, as
research material: turning them into training data for the Kalshi decision model is the next step toward
"good from day one".

## GPU

Not used. Every network is a small model written in TypeScript and trained on the CPU, one pipeline step
at a time. A graphics card would only help after rewriting them for a GPU framework. At their size, the
data loading and walk-forward evaluation dominate the run time anyway.
