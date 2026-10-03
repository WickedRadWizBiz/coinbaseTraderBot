# Evolutionary initialisation of every network (population-based training)

Every network in the bot starts the same way: as **three identical networks** that differ only slightly in their hyperparameters. They train walk-forward and **fight for fitness**. The surviving elite becomes "the one network" for its job:
- the TA network,
- the crypto SNN,
- the perps SNN,
- the tennis SNN.

This page maps each part of the evolutionary protocol to the code, and says where it had to be adapted.

## Phase 3: the tournament (`research/pbt.ts`)

The tournament follows DeepMind's population-based training, adapted to time series. It is not a classic genetic algorithm.

| Step | What happens |
|---|---|
| Initialise | Three members with the same seed and the same starting weights. Member 0 has the base hyperparameters; members 1 and 2 are within ±10% of them. |
| Exploit | Each member trains on the round's training block (past data only). |
| Evaluate | Each member is scored on the **next** block, which none of them has seen. |
| Explore | **Elite** (best fitness) survives untouched. **Culled** (worst) throws away its weights and becomes an exact copy of the elite. The **middle** member and the new copy get mutated: each knob is multiplied by 0.8 or 1.25, within its limits. |
| Explore (exploration member) | Every N rounds (`TA_NET_RESTART_EVERY` 6, `AUTO_TRAIN_SNN_PBT_RESTART_EVERY` 4) the culled member does **not** copy the elite. It restarts from scratch: new weights, every knob drawn at random (log-uniform) within its limits, its own lineage and an empty record. Only the middle member is mutated that round. Without this, all three members soon descend from one ancestor and the population can get stuck in that ancestor's local optimum. The elite still survives, so a restart costs nothing if the newcomer is worse. To give the newcomer a fair trial: it trains extra epochs on its first block to catch up with members that have trained on every earlier block (TA network: 3), and it cannot be culled for its first 2 rounds (the next-worst member is culled instead, and the newcomer keeps its knobs). Month-to-month fitness noise is larger than the gaps between members; in the first 34 rounds of the first real run, without the grace period, all five newcomers were culled within one or two rounds, one of them right after ranking first. |
| Roll forward | The blocks advance and the round repeats. |

Every member keeps a record of its evaluation windows. A copy inherits the elite's record, so the final elite's record is the out-of-sample history of its whole lineage. Every evaluation of every member counts as a **trial** for the deflated Sharpe ratio (Phase 5).

**Fitness** = Sortino ratio (annualised, after costs) − 5 × maximum drawdown − 5 × costs (`bot/util/fitness.ts`). A network that never trades scores 0, as if it held cash: better than any losing network, worse than any winning one.

### Per network

**TA network** (`research/trainTaNet.ts`), over years of exchange history:
- **Blocks:** a rolling 12-month training block (`TA_NET_TRAIN_MONTHS`, 12–18 recommended), a 1-month evaluation block, rolled forward one month at a time.
- **What it trades in evaluation:** its own position rule. That is quarter-Kelly on its forecasts, with the volatility forecast setting the risk scale, a 5 bp cost on turnover, and equal capital per asset.
- **Optimizer:** AdamW (decoupled weight decay, none on biases), learning rate capped at 0.003. Plain L2 inside Adam decayed schema 4's 15-minute and swing blocks to zero: Adam rescales the penalty into full-size steps for weights with a weak learning signal.
- **Mutated knobs:** learning rate, weight decay, the weight of each branch (15-minute, hourly swing, hourly TA, daily, market context), the weight of the volatility head, and the drop-path probabilities (per join, per branch).

**Crypto and perps SNNs** (`research/snnPbt.ts`), over the recordings. Only days or weeks exist, so the blocks are measured in days:
- **Blocks:** 3 days of initial learning, then 1-day evaluation blocks. The networks learn online, so each evaluation day is also prequential: every output is made before the label that could train on it.
- **Crypto fitness:** one quarter-Kelly bet per contract when the network's probability beats the market mid by 3¢, with a 2¢ fee. Contracts in one settlement window count as one interaction.
- **Perps fitness:** quarter-Kelly even-odds bets on its direction calls, assuming a 1% move and a 5 bp cost.
- **Mutated knobs:** learning rates, gains and time constants. These knobs keep every array's shape, so a culled network can take over the elite's learned state exactly.
- **What the winner sets:** the elite's knobs become that network's hyperparameters for training, backfill and the live bot.

**Tennis SNN** (`bot/snn/population.ts`), **live**, because there is no recorded score feed to replay:
- All three members see every input, and the bot uses the elite's outputs.
- Each member is graded on simulated bets against the market mid when matches settle.
- After every 30 graded matches (`SNN_TENNIS_POPULATION_SETTLES`) the elite survives, the worst restarts from the elite's state, and the middle member restarts from its own state with mutated knobs.
- The population survives restarts (`data/snn/tennis/population/population.json`).

**The tournament is an initialisation followed by continual evolution:**
- The population is saved after every round, and later runs continue it as new months (TA) or new days (SNNs) arrive.
- A long first tournament is spread over several daily pipeline runs (`TA_NET_MAX_ROUNDS_PER_RUN`, `AUTO_TRAIN_SNN_PBT_MAX_ROUNDS`). Nothing is promoted until it reaches the present.

## Phase 2: multi-timeframe network (`bot/ta/branchNet.ts`, TA network)

The granularities feed four separate branches. They are never flattened into one vector.

| Branch | Input | Layer | Purpose |
|---|---|---|---|
| Micro | last 32 fifteen-minute bars (return, range, close position, volume, taker flow) | fractal convolution block (columns see 3 / 7 / 31 bars), mean + last pooling | microstructure, noise filtering |
| Swing | last 48 raw hourly bars (same readings) | fractal convolution block | candle patterns, short structure, swings |
| Context | one vector at the forecast hour: 15m TA library, BTC / market / BTCDOM, the dominance quadrant, TA on the daily BTC.D and USDT.D charts | dense tanh | what the coin's own chart can't show: the market around it |
| Trend | last 12 hourly steps of the TA library (1h + 4h readings, confluences, returns, calendar) | GRU | intraday and multi-day momentum |
| Macro | last 30 daily steps (daily TA readings, daily returns, volatility) | attention, with today as the query | regime, support and resistance |

The fractal blocks, drop-path, the per-pattern report and the market context are described in docs/TA_NETWORK.md. The five outputs are concatenated, each scaled by its branch weight (mutated by the tournament), then go through a dense layer. That layer has three outputs: P(up in 1h), P(up in 4h), and the 4-hour volatility ratio. Backpropagation is hand-written and checked against finite differences for every parameter (`tests/branchNet.test.ts`).

The SNNs keep their spiking architecture; their multi-timeframe inputs come through their columns.

## Phase 4: regimes (`research/fitness.ts`)

The rolling training blocks deliberately cross these crypto cycles:

| Regime | Dates |
|---|---|
| Cycle 1 (retail) | markup Jul 2016–Dec 2017 → markdown 2018 → accumulation Jan 2019–Mar 2020 |
| Cycle 2 (DeFi/macro) | markup Apr 2020–Nov 2021 → markdown Dec 2021–Dec 2022 → accumulation 2023 |
| Cycle 3 (ETF/institutional) | markup Jan 2024–Oct 2025 → distribution/markdown Nov 2025–now |

Each report shows results per regime. History before the Binance data starts (August 2017) comes from imported CSVs such as Bittrex.

## Phase 5: statistical hurdles

- **Independent interactions:** trades that fire together count as **one** interaction. That means the same asset (or settlement window, or column) within an hour, so 15 trades in one volatility spike are one. Each regime the record covers must hold at least `TA_NET_MIN_PER_REGIME` (100) of them.
- **Deflated Sharpe ratio:** computed on the elite lineage's independent interactions, with every member evaluation counted as a trial. The TA network's direction heads need a probability of at least `TA_NET_DSR` (0.95) to speak.
- **Unseen holdout:** the last `TA_NET_HOLDOUT_MONTHS` (3) are never touched by the tournament. Each head is graded there against the naive forecast with a day-block bootstrap. The volatility head speaks if it passes. The direction heads also need the deflated Sharpe and regime hurdles.
- **Live forward test (out-of-sample finality):**
  - The live bot trades the elite's position rule on paper, hour by hour, for `TA_NET_FORWARD_DAYS` (90).
  - It is **confirmed** if the record is positive after costs, with a positive Sortino over at least 30 independent runs.
  - If it **fails**, the direction heads go silent (`TA_NET_MUTE_ON_FORWARD_FAIL`).
  - The record is kept in `data/ta_net_forward.json`.

## Phase 1: capital allocation, where it fits the current build

- **Numerical Kelly** (`bot/sizing/portfolioKelly.ts`):
  - **Objective:** maximise E[log(1 + fᵀR)] numerically, by projected gradient ascent on a scenario set. The objective is concave, so this finds the optimum. There is no SLSQP library in TypeScript; this solves the same problem.
  - **Correlated contracts:** contracts settling on the same index at the same time share one scenario factor, so stacking an hourly ladder is penalised.
- **Applied as a cap on new crypto orders:** the per-contract sizing still decides; the portfolio solver can only make an order **smaller**. It works out the best stake for the new contract given the positions already held, then shrinks it by `PORTFOLIO_KELLY_SHRINK` (0.5; the protocol's range is 0.25–0.5). Tennis keeps its own rules-based budget, because it has no model probability to size an edge from. A cap that bites is written to the audit log.
- **Illiquid binaries vs. perps:** capital locked in open binaries can't buffer perp margin. So the perp's assumed volatility is multiplied by (1 + `PERP_LOCKED_VOL_MULT` × locked fraction), which can only reduce perp size.
- **Time-normalised edge:** a binary's expected value per unit staked, E[x] = p·b − q, is divided by its lock-up time to give a daily rate. That puts it on the same scale as perp drift. It is logged with every cap (`timeNormalizedEdge`).

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `TA_NET_TRAIN_MONTHS` / `TA_NET_EVAL_MONTHS` / `TA_NET_STEP_MONTHS` | `12` / `1` / `1` | TA tournament blocks |
| `TA_NET_HOLDOUT_MONTHS` | `3` | never touched by the tournament |
| `TA_NET_STRIDE` | `2` | train on every 2nd hourly sample (adjacent hours are highly correlated) |
| `TA_NET_MIN_PER_REGIME` / `TA_NET_DSR` | `100` / `0.95` | Phase 5 hurdles |
| `TA_NET_FORWARD_DAYS` / `TA_NET_MUTE_ON_FORWARD_FAIL` | `90` / `true` | live forward test |
| `TA_NET_MAX_ROUNDS_PER_RUN` | `36` | spread the first tournament over daily runs (0 = all at once) |
| `AUTO_TRAIN_SNN_PBT_DAYS` / `AUTO_TRAIN_SNN_PBT_INIT_DAYS` | `7` / `3` | SNN tournament span and initial learning block |
| `AUTO_TRAIN_SNN_PBT_EVERY_DAYS` / `AUTO_TRAIN_SNN_PBT_MAX_ROUNDS` | `30` / `0` | re-run the SNN tournaments monthly; rounds per run |
| `TA_NET_RESTART_EVERY` / `AUTO_TRAIN_SNN_PBT_RESTART_EVERY` | `6` / `4` | exploration member: every N rounds the worst network restarts from scratch (0 = never) |
| `SNN_TENNIS_POPULATION` / `SNN_TENNIS_POPULATION_SETTLES` | `true` / `30` | live tennis tournament |
| `PORTFOLIO_KELLY` / `PORTFOLIO_KELLY_SHRINK` | `true` / `0.5` | portfolio cap on crypto orders |
| `PERP_LOCKED_VOL_MULT` | `1` | perp volatility inflation per unit of locked capital |

Commands:
- `npm run pipeline -- --fresh-ta-net`: restart the TA tournament from scratch.
- `npm run pipeline -- --force-snn-pbt`: rerun the SNN tournaments.
- `npm run research:ta-net` / `npm run research:snn-pbt -- --domain crypto`: run a tournament by hand.
