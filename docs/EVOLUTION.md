# Evolutionary initialisation of every network (population-based training)

Every network in the bot starts the same way: as **three identical networks** that differ only slightly in their hyperparameters. They train walk-forward and **fight for fitness**. The surviving elite becomes "the one network" for its job:
- the TA network,
- the crypto SNN,
- the perps SNN,
- the tennis SNN.

This page maps each part of the evolutionary protocol to the code, and says where it had to be adapted.

On the laptop trainer the SNN tournaments field about one network per CPU thread (15 on a 16-thread laptop).
On top of the tournament, those populations **breed** every few rounds (see
[Genetic breeding](#genetic-breeding-researchgeneticts) below).

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
- **What it trades in evaluation:** triple-barrier trades on its own forecasts: every hour a 4-hour trade sized by quarter-Kelly on P(up in 4h), take-profit and stop at ±1 forecast 4-hour sigma (the volatility forecast sets the barriers), first touch decides, 5 bp costs on entry and exit, equal capital per asset. A trade is only taken when P(up in 4h) is at least `minEdge` from 50%; `minEdge` is mutated like the other knobs. A member that trades fewer than 5% of the hours in a round scores up to −10 instead of the cash score of 0: in the first schema-5 run, sitting out kept winning until no member traded at all.
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

## Genetic breeding (`research/genetic.ts`)

On top of the tournament's selection, every population of 6 or more networks breeds. The SNN tournaments
on the laptop qualify (about 15 networks); the server's three-network tournaments and the TA network
(3 by default, `TA_NET_POPULATION`) run as before.

| Step | What happens |
|---|---|
| Select parents | Every round the usual selection goes on. Every `TOURNAMENT_BREED_EVERY` rounds (4: for an SNN, the four judged days of one week of history) a generation ends. The `TOURNAMENT_PARENTS` (3) networks with the best **mean fitness over the generation** are the parents. A mean over the generation, not one day's score, so a lucky day does not make a parent. |
| Crossover | Every pair of parents has **one offspring**: 3 parents make 3 offspring. Each knob comes mostly from one parent, the fitter one slightly favoured, blended a little with the other parent's value. |
| Pass down winning traits | **Knobs:** a trait memory follows every evaluation of every network. For each knob it records where the values of the networks that ranked in the top quarter of their round lie, and how strongly the knob relates to rank. Where it is confident, crossover favours the parent whose value sits in that winning region. **Learned strategies (SNNs):** each column is one asset and horizon, a strategy of its own. An offspring takes every column from the parent whose column made more money over the generation; the rest of the network comes from the fitter parent. A tennis network's columns are its matches, so a tennis offspring starts from the fitter parent's network. A TA network offspring starts from the fitter parent's weights. |
| Mutate slightly | Every knob of an offspring is then nudged by about ±3% (`TOURNAMENT_MUTATION`, a log-normal sd), within its limits. |
| Next generation | The offspring take the slots of the networks with the worst mean over the generation; the round's elite is never one of them. The champion parents and the best runners-up carry on, with the offspring, into the next generation. Each offspring is judged on its own knobs the next round, then takes part in the selection like any other network. |
| Iterate | The population and its trait memory are saved after every round and carry on across runs, so the generations keep counting. On the laptop a round of the trainer runs about 5 generations (a 5-week tournament of fresh history), so 4 to 10 trainer rounds make 20 to 50 generations. The trainer stops when progress does: rounds in a row where no challenger beat the network in use (docs/LAPTOP_TRAINING.md). |

Every round's log shows the generation, its parents, each offspring's parents (for example `#7=#3x#11`) and
the knob values the trait memory is confident about. The pipeline report carries the generation count.

### Why one population, three parents, and islands off

The design was measured before it was switched on. The test: a toy landscape with 6 knobs and a hidden
optimum (one peak, or two), 15 networks, 48 or 96 rounds, and every evaluation noisy, with noise
comparable to the gaps between networks, as tournament days are. The score is how far the final elite's
knobs ended from the optimum.

| Variant | Beat the plain tournament | Notes |
|---|---|---|
| Breeding, 3 parents (the default) | 56% of 320 runs | Closer to the optimum in all 4 settings with 96 rounds (for example 1.99 vs 2.22) |
| Breeding, 4 parents (6 offspring per generation) | 41% of 320 runs | Replacing 40% of the population every generation is too much on noisy scores |
| 4 islands of about 4 networks, their winners breeding | 34% of 160 runs | Better only on long runs with low noise (0.41 vs 0.54); with noisy scores each small island picks its winner on noise |

**Islands** (`TOURNAMENT_ISLANDS`, default 1): the population is split into separate tournaments run side
by side; each island's winner is a parent; the next islands are dealt from the champions (one each), the
offspring and the best runners-up. They are available, but off: on noisy scores they converged more slowly
than one population.

## Genetic programming: evolved formulas (`research/gpIndicators.ts`)

The tournaments above evolve the *settings* of networks someone designed. Genetic programming evolves the
*indicator itself*: a mathematical formula, machine-made, that turns the coins' hourly bars into a position.
It follows the video "I let genetic programming design trading indicators" and its code
(ZiadFrancis/Genetics_Trading_Part_1: DEAP plus vectorbt), rebuilt in TypeScript for the bot's coins. The
formula language is shared with the live bot (`bot/gp/expr.ts`).

| Step | The video | The bot |
|---|---|---|
| Inputs | 5-minute OHLC of 4 forex pairs to predict one (cross-market) | Hourly bars of the coin plus BTC and ETH (`GP_CROSS`). Per coin: the bar's log return, open / high / low against the close, and volume against its 24-hour mean. These are scale-free, so a formula means the same at $3,000 and at $100,000 BTC. |
| Building blocks | + - × ÷ (protected), sin, cos, tan, tanh, a > b ? 100 : -100, random constants | The same, plus functions over the last *w* hours: lag, delta, mean, std, max, min, sum, z-score (w = 1..96). Without them a formula only sees the current bar. |
| 1. Population | 15,000 random formulas (the code's default is 1,000) | `GP_POPULATION`: 1,000 on the server; on the laptop 2,000 per worker thread, up to 15,000. Ramped half-and-half trees, depth 1–5, plus the formula in use. |
| 2. Fitness | Backtest; e^(-total return), minimised; under 20 trades or a wiped-out account scores 1e6 | Backtest on the training years. The formula's value is the target exposure, clipped to -100%..+100%. A **10% dead band** (`GP_BAND`) means the position only moves when the formula asks for 10 points more or less. Each unit of exposure traded costs `GP_COST_BPS` (5 bps). Score: annualised **Sharpe** (`GP_FITNESS=sharpe`, the default) or the video's **-e^(-return)** (`GP_FITNESS=return`). A little is taken off per token against bloat. Under 20 trades, a wiped-out account or a broken formula scores worst. |
| 3. Selection | Top 10% kept | The best **10% pass unchanged**. The rest are bred from parents picked by tournament (best of 3). |
| 4. Breeding | Subtree crossover plus mutation | **One-point subtree crossover** (90%): a random branch of one formula swapped with a random branch of the other. **Mutation** (15%): a branch regrown, one node swapped for another of its kind, or a branch hoisted up. A child deeper than 8, longer than 60 tokens or looking back more than 240 hours is replaced by its parent. |
| 5. Generations | 15–20; champion tested on unseen data | `GP_GENERATIONS` (15) with a hall of fame of the 10 best formulas. The **champion** is the hall-of-fame formula that scores best on the **validation** years (the 20% after training). It is then tested **once** on the newest 20%, which neither the evolution nor the choice has seen. |
| Saved champion | `best_individual.dill`, loaded for fast inference | `data/models/gp_indicators.json`: one champion per coin, as tokens plus the readable formula, with its train / validation / test record. The live bot re-reads it when it changes and computes each formula once per new hourly bar. |

**What a champion must show before it speaks live (validated).**
- Test Sharpe above 0.
- A **probabilistic Sharpe** of at least `GP_MIN_PSR` (0.9) on the test's daily returns. This is deflated by every champion ever compared on a test window for that coin, so repeated runs make it harder, not easier.
- At least 20 test trades.
- Test drawdown within 35%.
- Validation Sharpe above 0.

A validated formula joins the TA conviction signals as `evolved formula`, with the exposure it holds now (`bot/strategy/taConviction.ts`). That signal counts towards breadth and boosts for Kalshi entries and perp setups, like the rule book. Unvalidated formulas are shown but never speak, except in paper mode with `GP_REQUIRE_VALIDATED=false`.

**Promotion.** Champions are kept per coin. A new champion replaces the one in use only when it scores higher on the new test years, with both judged on the same years. The formula in use is also seeded into each new population, so evolution carries on from it across runs.

**Measured** (synthetic markets; the real-history run happens in the daily remote training):

| Check | Result |
|---|---|
| BTC repeats a quarter of ETH's last hourly return (a planted cross-market lead) | The champion reads ETH (for example `z48(ETH.c)`). Validated, test Sharpe about 17, in 4 s. |
| Pure noise, 1,000 formulas × 15 generations, 3 seeds | Evolution finds training Sharpes above 1, but none validates. Test Sharpes were -1.4, -1.9 and 0.9. The last one, on 8 trades, missed the probabilistic-Sharpe bar, and 20 test trades are now required too. |
| Live bot vs research | 0 of 2,998 random formulas differ between the live bot's 320 hourly bars and the full history. Every window function looks back a fixed number of bars, and constant or near-constant windows are computed exactly. |
| Cost | About 5 ms per formula on 80,000 hourly bars (BTC since 2017): about a minute per coin at the server's 1,000 formulas × 15 generations. On the laptop, 15,000 formulas are spread over the worker threads. |

The video's own sample result (46% return, Sharpe 1.1, max drawdown -12% on a year of test) would roughly
meet the bar with more than a year of test data. Expect most coins' champions not to validate: hourly crypto
direction is hard, and the gate is there so that only a formula that held up on unseen years gets a say.

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
  - The live bot trades the elite's triple-barrier rule on paper, hour by hour, for `TA_NET_FORWARD_DAYS` (90).
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
| `TOURNAMENT_PARENTS` / `TOURNAMENT_BREED_EVERY` / `TOURNAMENT_MUTATION` | `3` / `4` / `0.03` | genetic breeding in populations of 6+: parents per generation (one offspring per pair; 0 = off), rounds per generation, the offspring's knob mutation (log-normal sd) |
| `TOURNAMENT_ISLANDS` | `1` | split the population into this many island tournaments whose winners breed (each island at least 3 networks) |
| `GP_EVERY_DAYS` / `GP_POPULATION` / `GP_GENERATIONS` | `7` / `1000` / `15` | genetic programming of formulas: how often (0 = every run; the laptop trainer runs it every round with up to 15,000 formulas), formulas per coin, generations |
| `GP_ASSETS` / `GP_CROSS` | all of BTC, ETH, SOL, XRP, DOGE with history / `BTC,ETH` | coins that get a formula; the cross-market coins every formula may read |
| `GP_FITNESS` / `GP_COST_BPS` / `GP_BAND` / `GP_MIN_PSR` | `sharpe` / `5` / `0.1` / `0.9` | score (`return` = the video's e^(-return)); cost per unit of exposure traded; dead band; the test's probabilistic Sharpe a champion needs |
| `GP_SIGNAL` / `GP_REQUIRE_VALIDATED` | `true` / `true` | the evolved formulas join the conviction signals; only validated ones (`false` lets unvalidated ones speak in paper mode) |
| `TA_NET_POPULATION` | `3` | networks in the TA tournament (6+ breed; each round costs one network's training per member) |
| `SNN_TENNIS_POPULATION` / `SNN_TENNIS_POPULATION_SETTLES` | `true` / `30` | live tennis tournament |
| `PORTFOLIO_KELLY` / `PORTFOLIO_KELLY_SHRINK` | `true` / `0.5` | portfolio cap on crypto orders |
| `PERP_LOCKED_VOL_MULT` | `1` | perp volatility inflation per unit of locked capital |

Commands:
- `npm run pipeline -- --fresh-ta-net`: restart the TA tournament from scratch.
- `npm run pipeline -- --force-snn-pbt`: rerun the SNN tournaments.
- `npm run research:ta-net` / `npm run research:snn-pbt -- --domain crypto`: run a tournament by hand.
- `npm run research:gp -- --assets BTC --population 15000 --generations 20`: evolve formulas by hand (`--fitness return` for the video's fitness).
