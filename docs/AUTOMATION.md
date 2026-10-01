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

**The SNN goes first.** The MLP, perps and tennis models use the SNN's outputs as inputs, so they're trained after it. The steps always run in this order:

| Step | What it does | Output (in `data/models/`) |
|---|---|---|
| snn-ablation | Tests SNN stages S0–S6, and the experimental mechanisms against their simpler stand-ins. Runs weekly, or when forced | `work/snn_ablation.json` |
| snn-train | Trains the SNN at the highest stage whose whole chain passed | `snn_model.json` |
| snn-backfill | Fills in SNN outputs for recorded minutes that have no live SNN log, one day at a time, picking up where it left off. Built so that no output ever saw its own result | `work/snnfill/` |
| dataset | Turns the recordings, plus the logged and backfilled SNN outputs, into labelled training rows | `work/dataset.jsonl` |
| mlp | Trains the MLP fair value and its take/skip head (with SNN feature sets), backtests it after fees, records the result in the model file | `model.json` |
| vol | Fits the intraday volatility profile | `vol_profile.json` |
| perps | Trains the perps model (with the SNN's 1h/4h direction), then runs its execution backtest | `perp_model.json` |
| tennis | Trains the tennis MLP (4 signals, score, book, SNN) | `tennis_model.json` |

There's a report for each run in `data/models/reports/` and a log in `data/models/logs/`.

A step with nothing to work on yet is reported as **skipped**, not failed. Examples: no perp quotes recorded, fewer than 8 settlement windows, fewer than 5 settled tennis matches.

### 3. A new SNN retrains the models that read it

- **Inside the pipeline:** the MLP, perps and tennis steps always come after the SNN and use its outputs.
- **If the SNN changes any other way,** for example you drop in a new `snn_model.json`:
  - The bot swaps it in.
  - It sees the MLP was trained on the old SNN's outputs.
  - It reruns `dataset, mlp, perps, tennis` on its own.
  - Turn this off with `AUTO_TRAIN_ON_MODEL_CHANGE=false`.
- **A new MLP doesn't retrain the SNN.** The SNN learns from the market, not from the MLP.

### 4. It hot-swaps new models

About every 30 seconds the bot checks `data/models/` for changed files:

| File changed | What happens |
|---|---|
| `model.json` | The new meta-model trades immediately. The SNN blend history is cleared, because it was recorded against the old model, and α (the SNN's vote) starts again from 0. |
| `snn_model.json` | A fresh SNN starts from the trained weights. The old one is checkpointed and stopped. |
| `perp_model.json` | The perps trader switches to the new model. |
| `tennis_model.json` | The tennis model switches. It only gates entries once validated. |
| `vol_profile.json` | Applied only if its own validation showed an improvement and `VOL_SEASONALITY=true`. |

A file in `data/models/` always wins over the same file in `params/`. To go back to the `params/` version, delete the file from `data/models/`.

### 5. It keeps the SNN blend history across restarts

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
| Run just the SNN steps | same, with `-H 'Content-Type: application/json' -d '{"only":"snn"}'` |
| See status, next run and last swap | `GET /api/autotrain`, or the **Auto-train** row on the Telemetry page |
| Run it from a checkout | `npm run pipeline` (or `npm run pipeline -- --only snn`, or `--force-ablation`) |

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
- Deploy a code change with the "Deploy release" GitHub Action and a version tag, e.g. `v2.1.0`. Steps:
  1. Create the tag.
  2. Go to Actions → Deploy release → Run workflow.
  3. Enter the tag.
  4. Approve it.
- `data/models/` and `data/recordings/` stay where they are across deploys.

**4. Optional extras, any time:**
- `npm run research:ta` refreshes the TA rule hit rates. It needs internet access to Coinbase. They are only shown on the dashboard; nothing trades on them.
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
| `AUTO_TRAIN_ABLATION_DAYS` | `7` | Days of recordings the SNN ablation replays. It's the slow step: roughly 5–40 minutes per recorded day on a small server. |
| `AUTO_TRAIN_ABLATION_EVERY_DAYS` | `7` | Re-run the ablation this often even if the MLP didn't change. |
| `AUTO_TRAIN_SNN_TRAIN_DAYS` | `21` | Days the SNN trains on. The last 20% is held out for an out-of-sample check. |
| `AUTO_TRAIN_ON_MODEL_CHANGE` | `true` | Re-run the SNN steps when the MLP changes outside the pipeline. |
| `AUTO_TRAIN_MIN_DAYS` | `1` | Don't train with fewer days of recordings than this. |
| `AUTO_TRAIN_DIR` | `data/models` | Where promoted models go. |
| `AUTO_TRAIN_RECORDINGS` | `data/recordings` | Where recordings are read from. |
| `AUTO_TRAIN_WATCH_SEC` | `30` | How often to check for changed model files. |

## If something goes wrong

| Problem | Fix |
|---|---|
| A bad model went live | Delete it from `data/models/`. The bot falls back to `params/`, or to pure fair value if there's no file there. Or set `AUTO_TRAIN_PROMOTE=validated`. |
| A run failed | Open the log named in `/api/autotrain` (`data/models/logs/…`). The other steps still ran: each step is independent. |
| The server feels slow during training | Move `AUTO_TRAIN_HOUR_UTC` to a quiet hour, or lower `AUTO_TRAIN_ABLATION_DAYS`. Training runs at the lowest CPU priority, but Lightsail burst credits are shared. |
