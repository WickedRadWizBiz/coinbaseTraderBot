# Training automation: what runs by itself, and what you do by hand

## The short version

Leave the bot running. Every day at 06:00 UTC it:
1. Retrains its models from the market data it has recorded.
2. Tests them.
3. Swaps them into the running bot. No restart and no redeploy are needed.

You only need to do the things in **"What you still do by hand"** below.

## What the bot does automatically

### 1. It records data, all the time

While the bot runs in any mode (paper, shadow or live), it writes every book update, trade, index tick and settlement to `data/recordings/md-YYYY-MM-DD.jsonl`. This is what everything below learns from, and the longer the bot runs, the more of the whole system becomes testable (see 8 below).

- **Compression:** days older than `RECORDINGS_GZIP_AFTER_DAYS` (2) are gzipped to `md-YYYY-MM-DD.jsonl.gz`, about a tenth of the size, so months of recordings fit on the server. Every replay, trainer and sweep reads both forms.
- **Disk floor:** if free space where the recordings live drops below `RECORDINGS_MIN_FREE_GB` (5), the bot deletes the oldest recorded days (never the newest two) until twice that is free, and sends an alert naming the days. A full disk stops the bot from saving its state and from starting at all, which is worse than losing the oldest training days. `RECORDINGS_PRUNE=false` turns the deletion off (alert only). The check runs every 10 minutes.
- **Setup journal:** the perps setup trader also writes `data/setups/journal-YYYY-MM-DD.jsonl`. Every setup it sees and every trade it opens and closes is logged there, together with what the TA network and the perps SNN said at that moment.

### 2. It runs the training pipeline every day

This is `research/pipeline.ts`. By default (`AUTO_TRAIN=remote`) it runs on a GitHub-hosted runner (`.github/workflows/train.yml`): the job copies the server's last 45 days of recordings, the candle history and the models directory off the server, trains on the runner's own CPUs (up to 5 h; it checkpoints after every step and continues on the next run), and copies the models and history back, where the bot hot-swaps them. The server's `bot.env` is read with every credential line removed. Run it from the Actions tab (Remote training) for an extra run or a single step (`only`). With `AUTO_TRAIN=background` it runs on the server instead, as a low-priority background process.

**History and the TA network go first**, then the SNNs. The TA network (docs/TA_NETWORK.md) learns from years of exchange candles, not from recordings, so it doesn't wait for recorded days. There are three isolated SNNs (crypto, perps, tennis; docs/SNN.md). Each decision model reads only its own network, so every network is trained before the model that reads it. The steps always run in this order:

| Step | What it does | Output (in `data/models/`) |
|---|---|---|
| history | Downloads new Binance Vision archives (spot, plus Binance's BTCDOM index) and Coinbase candles for every crypto asset Kalshi lists, the TradingView index series (`TV_FILL`), then Kalshi's settled contracts with their last 48 hours of 1-minute candles. The Kalshi part is time-boxed to `KALSHI_HISTORY_BUDGET_MIN` (20) per run and resumes where it stopped; markets that never traded are stored without a request and markets the API rejects are not asked again (the ladders list ~100,000 settled markets in 60 days, which once filled whole 5-hour runs). Requests share one pace of 10 a second (half of Kalshi's read limit); a "too many requests" answer pauses every download worker together (1 s, doubling to 30 s, or Kalshi's Retry-After) and the market is retried, not dropped. Assets Kalshi lists that Coinbase does not sell (tokenised stocks, indices) are asked for once per run, not once per timeframe. Skipped if the server can't reach the exchanges, or with `HISTORY_AUTO_UPDATE=false`. The live bot also appends its own hourly USDT.D / BTC.D / BTCDOM bars here | `data/history/` |
| ta_net | Runs the TA network's tournament of three over the hourly history. The first one is spread over daily runs; afterwards it continues month by month every `TA_NET_RETRAIN_DAYS` (7). Promoted only once it reaches the present; only heads that pass the holdout and hurdles speak live (docs/EVOLUTION.md) | `ta_net.json` |
| ta_net_oos | Walk-forward forecasts of the TA network over all history (`research/taNetOos.ts`): one network with the tournament winner's settings trains on the trailing 12 months and forecasts the next month, month by month. Later runs only add new months; it starts over when a new TA network is promoted. These forecasts are the setup scorer's TA network inputs, and the walking network is what the live setup trader reads | `ta_net_wf.json`; forecasts in `data/history/.tanet-oos/` |
| rule_book | Weekly walk-forward study of every TA rule by market character (`research/ruleBook.ts`), and the confluence logbook: every pair of signals seen active together and what followed, kept when the pair beat both of its parts on the discovery and the later years (`research/confluenceBook.ts`, with a small take-profit / stop-loss grid for the perps side), and what makes or breaks each rule: the context of every signal (RSI, ADX, volatility, volume, higher-timeframe trend, hour, weekend) split into ranges, kept when a range helps or hurts the rule on both periods (`research/conditionBook.ts`), and what invalidates each call: another signal, or several pointing against it, present at the same time when the call lost money on both periods (`research/invalidationBook.ts`). Passing rules, pairs and conditions join the conviction signals (a breaking condition or a present invalidator silences its rule) | `rule_book.json` |
| gp | Genetic programming of trading formulas every `GP_EVERY_DAYS` (7): per coin, `GP_POPULATION` (1,000) random formulas over its own and BTC / ETH hourly bars evolve for `GP_GENERATIONS` (15) generations (best 10% kept, subtree crossover and mutation). The champion is chosen on the validation years and tested once on the newest years. A coin's formula is replaced only when the new champion beats it on those years; only validated formulas speak live (docs/EVOLUTION.md) | `gp_indicators.json` |
| setups | Retrains the setup scorer for the perps fast and slow lanes every `SETUP_RETRAIN_DAYS` (7). The TA network inputs are kept only if they beat the candle-only model on the development years. Also exports its recent out-of-sample setups for the whole-bot replay | `setup_model.json`, `setup_oos.json` |
| setup_snn | Checks the setup journal: do trades the perps SNN agreed with do better? It stays off ("collecting") until 150 closed trades with SNN readings exist, and switches on only once proven (see 8 below) | `setup_snn_gate.json` |
| sweep-&lt;target&gt; | The sweep optimizer, weekly (see 7 below). Proposals only | `sweeps/<target>.json` |
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
| `rule_book.json` / `gp_indicators.json` | Re-read on the next decision: the passing rules and the validated evolved formulas join the conviction signals. |

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

### 7. It sweeps the bot's settings, one at a time (proposals only)

Once a week (`SWEEP_EVERY_DAYS`), the pipeline runs the sweep optimizer (`research/sweep.ts`) on each target in `SWEEP_TARGETS`. Each target gets up to `SWEEP_HOURS` (2) hours, unattended.

- **Targets:**
  - `setups-long` and `setups-short`: the momentum-burst entry thresholds and exits for each side, scored on years of candle history.
  - `setups-vol`: how strongly the TA network's 4-hour volatility forecast widens or tightens fast-lane trails (`VOL_ADAPT.trailK`; 0 = off). It needs the walk-forward forecasts from `ta_net_oos`.
  - `kalshi`: the contract strategy's edge thresholds, buffers, exit margin, Kelly fraction and per-trade EV target, scored in the production backtester over the bot's own recordings. It needs at least 20 recorded days.
  - `bot`: the **whole bot** over the recordings (`research/wholeBot.ts`). Kalshi contracts go through the production backtester and the perps setup lanes run on their walk-forward scores, trading from one pot of capital under one combined daily loss stop. It tunes the shared settings: the capital split between Kalshi and perps, risk per fast and slow lane trade, lane sizes, the minimum target, the daily stop, and Kalshi's minimum edge and Kelly fraction. It scores them by the t-statistic of the combined profit per day, and needs at least 20 recorded days. To see the whole bot's day-by-day result with the current settings, run `npm run research:whole-bot`.
- **How it searches:** it tries every value of one setting while the others stay fixed, keeps the best, then moves to the next setting, and repeats until a full pass changes nothing.
- **What counts as an improvement:** a change is kept only if it raises the tuning-window score by at least 0.05 and doesn't lower the check-window score by more than 0.1. A final window is scored only once, at the end.
- **What it produces:** a proposal in `AUTO_TRAIN_DIR/sweeps/<target>.json` (start and end settings, every step, all three window scores). It never changes the live configuration. Apply a proposal by setting its values, after reading the final-window result.

The search runs as a background process, so a long sweep (`npm run research:sweep -- --target setups-long --hours 24`) costs nothing while it grinds. If a sweep stops partway, it resumes from its ledger.

### 8. It scores the whole bot against a target (readiness)

The last step, `readiness`, replays the whole bot (Kalshi contracts and perps setup lanes, one pot of capital) on days nothing was fitted or tuned on. It reports the daily return in % of `TRAIN_TARGET_POOL_USD` with its 95% interval, the drawdown, the Sharpe and the share of winning days. It says whether that meets the target and whether it looks solid, and writes every model's state and each network's history-ledger position to `AUTO_TRAIN_DIR/readiness.json`. The continuous laptop trainer stops when the target is met (docs/LAPTOP_TRAINING.md).

### 9. It reports what the recordings make testable, and switches on what they prove

Some parts of the bot can be tested on years of exchange history. Others exist only in the bot's own recordings: the SNNs' live states, Kalshi order books, perps funding, and the SNN's calls on setup trades. Each daily report (and `pipeline_state.json`) has a **readiness** block. It shows how many recorded days there are, how much disk they use and how much is free, and for each step that needs recordings, how much it has against how much it needs. For example: `sweep bot (whole-bot replay) 12/20`, `setup_snn gate 37/150`.

The SNN gate for the setup trader brings itself online like the fill model:
1. Every setup trade is journaled with the perps SNN's 1h and 4h calls at entry.
2. The **setup_snn** step reports "collecting" until there are 150 closed trades with SNN readings.
3. It then picks an agreement level on the earlier 70% of trades. Agreement is the trade's side × (P(up) − 0.5), at 1h for the fast lane and 4h for the slow lane. On the later 30%, the trades that level would have blocked must have lost money, with the bootstrap 90% upper bound of their mean below zero.
4. If so, `setup_snn_gate.json` turns on and the setup trader picks it up immediately: an entry is skipped when the SNN's call disagrees by more than that level. If not, the gate stays off and the file says why. It is re-tested every run, so it can also switch off again.

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
| Run everything now (on the server) | `curl -X POST http://127.0.0.1:3000/api/autotrain/run` (add `-H "Authorization: Bearer $DASHBOARD_PASSWORD"` when a password is set) |
| Run just the SNN steps | same, with `-H 'Content-Type: application/json' -d '{"only":"snn"}'` (crypto and perps networks) |
| See status, next run and last swap | `GET /api/autotrain`, or the **Auto-train** row on the Telemetry page |
| Run it from a checkout | `npm run pipeline` (or `npm run pipeline -- --only snn,vol_model,fill`, or `--force-ablation`) |
| Retrain the TA network now (server) | `bash ~/bot/current/deploy/history.sh train` |
| Import your own CSVs / download history (server) | `bash ~/bot/current/deploy/history.sh import ~/incoming`, `... binance` (spot plus Binance's BTCDOM index), `... coinbase`, `... tradingview` (one-off BTC.D / USDT.D history), `... status` (docs/TA_NETWORK.md) |

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
| `AUTO_TRAIN` | `remote` | `remote` = trained on GitHub Actions (`.github/workflows/train.yml`, daily at 07:17 UTC and on demand), models copied back and hot-swapped, never trained on this server; `background` trains beside trading (lowest CPU priority, frozen only when the machine is busy); `windows` = session-edge windows only; `daily` = once at `AUTO_TRAIN_HOUR_UTC`; `off` disables the schedule. Hot-swapping still works. |
| `AUTO_TRAIN_EVERY_HOURS` | `6` | Background: a new run this many hours after the last completed one. |
| `AUTO_TRAIN_START_DELAY_MIN` | `10` | Background: wait this long after the bot starts before training. |
| `AUTO_TRAIN_MAX_LAG_MS` / `AUTO_TRAIN_MIN_FREE_MB` / `AUTO_TRAIN_MAX_STEAL` | `500` / `300` / `0.15` | Background: training is frozen while the trading loop lags more than this (p99), less memory than this is available, or the host steals more CPU than this (burstable CPU out of credits). |
| `AUTO_TRAIN_HOUR_UTC` | `6` | Hour of the daily run (`AUTO_TRAIN=daily`). |
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
| `TA_NET_OOS_HOURS` | `3` | Time budget per run for the TA network's walk-forward export (it resumes on the next run). |
| `SETUP_TA_NET_PATH` | `params/ta_net_wf.json` | The walking TA network the setup trader reads when `data/models/ta_net_wf.json` doesn't exist yet. |
| `SWEEP_TARGETS` | `setups-long,setups-short,setups-vol,kalshi,bot` | Sweep targets run weekly. |
| `RECORDINGS_GZIP_AFTER_DAYS` | `2` | Gzip recorded days older than this (0 = never). |
| `RECORDINGS_MIN_FREE_GB` | `5` | Below this much free space: alert, and delete the oldest recorded days until twice this is free. |
| `RECORDINGS_PRUNE` | `true` | `false` = alert only, never delete recordings. |
| `AUTO_TRAIN_SNN_PBT_DAYS` / `AUTO_TRAIN_SNN_PBT_EVERY_DAYS` | `7` / `30` | SNN tournaments: days replayed, how often they rerun (docs/EVOLUTION.md has every tournament setting). On the history replay, a generation is that many days of weeks the network has never trained on (docs/LAPTOP_TRAINING.md, history ledger). |
| `TOURNAMENT_PARENTS` / `TOURNAMENT_BREED_EVERY` / `TOURNAMENT_MUTATION` / `TOURNAMENT_ISLANDS` | `3` / `4` / `0.03` / `1` | Genetic breeding in tournaments of 6+ networks (the laptop's): parents per generation (0 = off), rounds per generation, offspring mutation, islands (docs/EVOLUTION.md). |
| `GP_EVERY_DAYS` / `GP_POPULATION` / `GP_GENERATIONS` / `GP_ASSETS` / `GP_CROSS` | `7` / `1000` / `15` / five coins / `BTC,ETH` | Genetic programming of formulas (docs/EVOLUTION.md has the fitness, dead band and gate settings). |
| `AUTO_TRAIN_CONTEST_WEEKS` | `2` | History replay: held-out weeks a new SNN replays against the network in use. It replaces that network only if it scores better there. |
| `TRAIN_TARGET_POOL_USD` / `TRAIN_TARGET_DAILY_PCT` / `TRAIN_TARGET_MAX_DD_PCT` | `200` / `50` / `10` | The readiness step's target: the whole bot on held-out days earning this % of the pool a day (the lower end of the 95% interval) with at most this drawdown. The continuous laptop trainer stops when it is met. 50% a day is far beyond any real system; see docs/LAPTOP_TRAINING.md. |
| `TRAIN_PLATEAU_ROUNDS` | `3` | Continuous laptop trainer: stop after this many rounds in a row that improve no model. |

## If something goes wrong

| Problem | Fix |
|---|---|
| A bad model went live | Delete it from `data/models/`. The bot falls back to `params/`, or to pure fair value if there's no file there. Or set `AUTO_TRAIN_PROMOTE=validated`. |
| A run failed | Open the log named in `/api/autotrain` (`data/models/logs/…`). The other steps still ran: each step is independent. |
| The server feels slow during training | Move `AUTO_TRAIN_HOUR_UTC` to a quiet hour, or lower `AUTO_TRAIN_ABLATION_DAYS`. Training runs at the lowest CPU priority, but Lightsail burst credits are shared. |

## Training windows (AUTO_TRAIN=windows, the default)

The pipeline runs only at the session edges: the first and last 40 minutes (`SESSION_EDGE_MIN`) of the Asian
(Tokyo open to Hong Kong close), London and New York sessions, on local exchange hours (DST-correct),
Monday to Friday. That is six windows a day, four hours in all. The bot opens no new positions in them
(`SESSION_EDGE_NO_ENTRY=true`; open positions are still managed and exited), and the pipeline gets the machine:

- once a day is due (20 hours after the last run), it starts at the next window;
- when a window ends it is frozen in place (SIGSTOP to its whole process group) and resumed (SIGCONT) at the
  next window, so it never uses CPU while the bot trades. A frozen pipeline keeps its memory;
- steps with their own time budgets (the TA network tournament, the walk-forward export) count paused time as
  elapsed, stop early and resume on a later run, since they save their progress.

On weekends (no sessions) a due run starts at midnight New York time on Saturday or Sunday and runs
unpaused until it finishes or the weekend ends (Tokyo opens Monday, Sunday 20:00 New York), after which the
session-edge windows pace it again. Weekend trading is unaffected.

The dashboard's auto-train status shows `paused` and the current or next window. `AUTO_TRAIN=daily` restores the
old schedule (AUTO_TRAIN_HOUR_UTC, no pausing).

