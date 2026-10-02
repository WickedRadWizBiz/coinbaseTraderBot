# Training automation: what runs by itself, and what you do by hand

## The short version

Leave the bot running. Every day at 06:00 UTC it:
1. Retrains its models from the market data it has recorded.
2. Tests them.
3. Swaps them into the running bot. No restart and no redeploy are needed.

You only need to do the things in **"What you still do by hand"** below.

## What the bot does automatically

### 1. It records data, all the time

While the bot runs in any mode (paper, shadow or live), it writes every book update, trade, index tick and settlement to `data/recordings/md-YYYY-MM-DD.jsonl`. This is what everything below learns from.

### 2. It runs the training pipeline every day

This is `research/pipeline.ts`, run as a low-priority background process so trading isn't slowed down.

**History and the TA network go first**, then the SNNs. The TA network (docs/TA_NETWORK.md) learns from years of exchange candles, not from recordings, so it doesn't wait for recorded days. There are three isolated SNNs (crypto, perps, tennis; docs/SNN.md). Each decision model reads only its own network, so every network is trained before the model that reads it. The steps always run in this order:

| Step | What it does | Output (in `data/models/`) |
|---|---|---|
| history | Downloads new Binance Vision archives and Coinbase candles for every crypto asset Kalshi lists. Skipped if the server can't reach them, or with `HISTORY_AUTO_UPDATE=false` | `data/history/` |
| ta_net | Runs the TA network's tournament of three over the hourly history. The first one is spread over daily runs; afterwards it continues month by month every `TA_NET_RETRAIN_DAYS` (7). Promoted only once it reaches the present; only heads that pass the holdout and hurdles speak live (docs/EVOLUTION.md) | `ta_net.json` |
| snn-crypto-ablation | Tests the crypto network's stages S0–S6 on settled contracts. Runs weekly, or when forced | `work/snn_crypto_ablation.json` |
| snn-crypto-pbt | Tournament of three identical crypto networks over the last 7 recorded days. The elite's knobs are used from then on. Runs at the start, when the stage changes, and every 30 days | `work/snnpbt/crypto/` |
| snn-crypto-train | Trains the crypto network (15m/1h) at the highest stage whose whole chain passed, with the tournament's knobs | `snn_crypto.json` |
| snn-crypto-backfill | Fills in the crypto network's outputs for recorded minutes with no live log, one day at a time, resuming where it left off. No output ever saw its own result | `work/snnfill/crypto/` |
| snn-perps-ablation / -pbt / -train / -backfill | The same for the perps network (1h/4h), judged on its own direction calls because perps never settle | `snn_perps.json`, `work/snnfill/perps/` |
| snn-tennis | Always skipped: the tennis network can't be replayed (no recorded score feed), so it learns live and keeps its checkpoints in `data/snn/tennis/` | — |
| vol_model | Trains the tree volatility forecast (how far realised vol over a contract's life will differ from the EWMA) and checks it on held-out days | `vol_model.json` |
| dataset | Turns the recordings, plus the crypto network's logged and backfilled outputs, into labelled training rows. Priced with the vol forecast when it is validated | `work/dataset.jsonl` |
| mlp | Trains the MLP fair value and its take/skip head (MLP vs trees, the better one kept), backtests it after fees, records the result in the model file | `model.json` |
| vol | Fits the intraday volatility profile | `vol_profile.json` |
| perps | Trains the perps model (ridge vs trees, on the perps network's 1h/4h calls and skill), then runs its execution backtest | `perp_model.json` |
| tennis | Trains the tennis model (MLP vs trees; 4 signals, score, book, tennis network) | `tennis_model.json` |
| fill | Trains the fill / adverse-selection model from the bot's own maker quotes. Skipped ("collecting") until 500 quotes and 100 fills exist; promoted only once it beats the base rate on held-out days | `fill_model.json` |

There's a report for each run in `data/models/reports/` and a log in `data/models/logs/`.

A step with nothing to work on yet is reported as **skipped**, not failed. Examples: no perp quotes recorded, fewer than 8 settlement windows, fewer than 5 settled tennis matches, fewer than 3 days of index data for the vol forecast, not enough maker quotes for the fill model.

### 3. A new network retrains only the model that reads it

- **Inside the pipeline:** the MLP, perps and tennis steps always come after the networks and use their outputs.
- **If a network changes any other way,** for example you drop in a new `snn_perps.json`:
  - The bot swaps in that network alone; the other two keep running untouched.
  - It sees its consumer was trained on the old network's outputs.
  - It reruns that consumer on its own: `snn_crypto.json` → `dataset, mlp`; `snn_perps.json` → `perps`; `snn_tennis.json` → `tennis`.
  - Turn this off with `AUTO_TRAIN_ON_MODEL_CHANGE=false`.
- **A new MLP doesn't retrain any network.** The networks learn from the market, not from the models.

### 4. It hot-swaps new models

About every 30 seconds the bot checks `data/models/` for changed files:

| File changed | What happens |
|---|---|
| `model.json` | The new meta-model trades immediately. The SNN blend history is cleared, because it was recorded against the old model, and α (the SNN's vote) starts again from 0. |
| `ta_net.json` | The new TA network's forecasts are used at once. The models that read them (vol forecast, MLP, perps) are retrained on their own if they were trained on an older network. |
| `snn_crypto.json` / `snn_perps.json` / `snn_tennis.json` | A fresh network of that kind starts from the trained weights. The old one is checkpointed and stopped. The other networks are not touched. |
| `vol_model.json` | Fair value's sigma is multiplied by the forecast, only if its validation passed and `VOL_MODEL=true`. |
| `fill_model.json` | The fill model switches on at once if validated (see "The fill model brings itself online" below). |
| `perp_model.json` | The perps trader switches to the new model. |
| `tennis_model.json` | The tennis model switches. It only gates entries once validated. |
| `vol_profile.json` | Applied only if its own validation showed an improvement and `VOL_SEASONALITY=true`. |

A file in `data/models/` always wins over the same file in `params/`. To go back to the `params/` version, delete the file from `data/models/`.

### 5. The fill model brings itself online

Nothing to do by hand:
1. From the first day, every maker entry quote the bot sends is logged to `data/fills/` with its placement (distance to the touch, queue ahead, book imbalance, spread, order flow, time to close, volatility, edge), whether it filled within 60 s, and the 60 s markout of the fill.
2. Each daily run, the **fill** step checks whether there is enough: 500 quotes and 100 fills. Until then it is reported as skipped ("collecting maker quotes").
3. Once there is enough, it trains two tree models: P(fill within 60 s) and the expected markout given a fill. It promotes the file only when the P(fill) model beats the plain fill rate on held-out days and the markout model is no worse than the average markout.
4. The bot hot-swaps it in and starts using it immediately. For every maker entry it compares the expected value of quoting (P(fill) × (edge + expected markout)) with crossing the spread now (edge at the touch, after the taker fee). It quotes, crosses or skips, whichever is better. It skips when neither clears `FILL_MIN_EV`. A cross must also clear the strategy's own taker threshold, and the risk gateway still checks every order.

The Telemetry page's **Fill model** row shows "collecting quotes" until then, and "active" after.

### 6. It keeps the SNN blend history across restarts

The history is saved in `data/snn/blender.json`. It is thrown away automatically if the meta-model has changed since it was recorded.

## Promotion policy

`AUTO_TRAIN_PROMOTE=always` is the default, and it is hot-swap mode: every freshly trained model goes live in the bot straight away.

The built-in gates still apply even in this mode:
- In `TRADING_MODE=live`, the risk gateway rejects every binary crypto order while the meta-model's validation hasn't passed.
- An unvalidated perps model trades at pilot size only.
- The SNN never gets a vote (α = 0) until it earns one from real settled results.

Set `AUTO_TRAIN_PROMOTE=validated` once you want only models that passed their checks to be promoted.

## Running it yourself

| What you want | How |
|---|---|
| Run everything now (on the server) | `curl -X POST -H "Authorization: Bearer $DASHBOARD_TOKEN" http://127.0.0.1:3000/api/autotrain/run` |
| Run just the SNN steps | same, with `-H 'Content-Type: application/json' -d '{"only":"snn"}'` (crypto and perps networks) |
| See status, next run and last swap | `GET /api/autotrain`, or the **Auto-train** row on the Telemetry page |
| Run it from a checkout | `npm run pipeline` (or `npm run pipeline -- --only snn,vol_model,fill`, or `--force-ablation`) |
| Retrain the TA network now (server) | `bash ~/bot/current/deploy/history.sh train` |
| Import your own CSVs / download history (server) | `bash ~/bot/current/deploy/history.sh import ~/incoming`, `... binance`, `... coinbase`, `... status` (docs/TA_NETWORK.md) |

Running from a checkout: `npm run pipeline` reads recordings from `data/recordings` and writes to `data/models`. Point it elsewhere with `AUTO_TRAIN_RECORDINGS=... AUTO_TRAIN_DIR=...`.

## What you still do by hand

These can't be automated, or deliberately aren't.

**1. Keep the bot running so it records data.**
- Training needs recordings. Expect at least a few days before the MLP trains: it needs 8 or more settlement windows just to try, and about 1,000 before its validation can pass.
- Perps training needs `PERPS_FEED=true` so perp quotes get recorded.
- Tennis scores need a Live Tennis API key in `LIVE_TENNIS_API_KEY`. That switches `TENNIS_SCORE_FEED` to `livetennis` automatically. The tennis model needs at least 100 settled matches before it can pass validation.

**2. Flip the "real money" switches yourself, on the server, in `bot.env`. Then restart the bot.**
- `TRADING_MODE=live`, and its acknowledgement line, for live binaries.
- `PERP_TRADING=live` / `PERP_HEDGE=live` for live perps.
- `SNN_MODE=blend` to let the SNN vote. Until then it only watches. Turn this on once the Telemetry row shows α above 0, or the ablation report accepts a stage.

**3. Deploy code changes.**
- Models are retrained automatically. Code is not.
- Code deploys itself: merging to `main` runs the Deploy workflow, which tests, builds, uploads and restarts the bot on Lightsail (docs/DEPLOY.md). To redeploy or deploy a tag by hand, use Actions → Deploy → Run workflow.
- `data/models/` and `data/recordings/` stay where they are across deploys.

**4. Optional extras, any time:**
- `npm run research:ta` refreshes the TA rule hit rates. It needs internet access to Coinbase. They are only shown on the dashboard; nothing trades on them. `npm run research:ta -- --history data/history` runs it on the long hourly history instead.
- Import extra history (your Bittrex/Yahoo/CryptoDataDownload CSVs) whenever you get it: `bash ~/bot/current/deploy/history.sh import <folder>`. The next `ta_net` run uses it.
- Edit `params/calendar.json` (macro release dates) when the calendar changes.
- If you want a trained model saved in git, copy it from `data/models/` into `params/` and commit it.

**5. Check on it now and then.**
- On the Telemetry page, a red **Auto-train** row means the last run failed. Its log path is in `/api/autotrain`.
- An alert is also sent when a run fails, if Telegram or a webhook is configured.

## Settings (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `AUTO_TRAIN` | `daily` | `off` disables the schedule. Hot-swapping still works. |
| `AUTO_TRAIN_HOUR_UTC` | `6` | Hour of the daily run. |
| `AUTO_TRAIN_PROMOTE` | `always` | `always` = hot-swap every new model; `validated` = only models that passed. |
| `AUTO_TRAIN_SNN_STAGE` | `auto` | `auto` = the highest stage whose whole chain passed the ablation (otherwise `SNN_STAGE`); or force `S0`–`S6`. |
| `AUTO_TRAIN_ABLATION_DAYS` | `7` | Days of recordings each network's ablation replays (crypto and perps, so twice). It's the slow step: roughly 5–40 minutes per recorded day per network on a small server. |
| `AUTO_TRAIN_ABLATION_EVERY_DAYS` | `7` | Re-run the ablation this often even if the MLP didn't change. |
| `AUTO_TRAIN_SNN_TRAIN_DAYS` | `21` | Days the SNN trains on. The last 20% is held out for an out-of-sample check. |
| `AUTO_TRAIN_ON_MODEL_CHANGE` | `true` | Retrain a network's consumer when that network's file changes outside the pipeline. |
| `SNN_CROSS_FEED` | `false` | Let each decision model also read the other crypto-side network (only for horizons its own lacks). |
| `VOL_MODEL` | `true` | Apply the tree volatility forecast to fair value (only if validated). |
| `FILL_MIN_EV` | `0` | Minimum expected value per contract ($) for a maker quote or a cross once the fill model is active. |
| `AUTO_TRAIN_MIN_DAYS` | `1` | Don't train with fewer days of recordings than this. |
| `AUTO_TRAIN_DIR` | `data/models` | Where promoted models go. |
| `AUTO_TRAIN_RECORDINGS` | `data/recordings` | Where recordings are read from. |
| `AUTO_TRAIN_WATCH_SEC` | `30` | How often to check for changed model files. |
| `HISTORY_AUTO_UPDATE` | `true` | Refresh Binance/Coinbase history in the daily run (the other history and TA network settings are in docs/TA_NETWORK.md). |
| `TA_NET_RETRAIN_DAYS` | `7` | Continue the TA network's tournament at most this often. |
| `AUTO_TRAIN_SNN_PBT_DAYS` / `AUTO_TRAIN_SNN_PBT_EVERY_DAYS` | `7` / `30` | SNN tournaments: days replayed, how often they rerun (docs/EVOLUTION.md has every tournament setting). |

## If something goes wrong

| Problem | Fix |
|---|---|
| A bad model went live | Delete it from `data/models/`. The bot falls back to `params/`, or to pure fair value if there's no file there. Or set `AUTO_TRAIN_PROMOTE=validated`. |
| A run failed | Open the log named in `/api/autotrain` (`data/models/logs/…`). The other steps still ran: each step is independent. |
| The server feels slow during training | Move `AUTO_TRAIN_HOUR_UTC` to a quiet hour, or lower `AUTO_TRAIN_ABLATION_DAYS`. Training runs at the lowest CPU priority, but Lightsail burst credits are shared. |
