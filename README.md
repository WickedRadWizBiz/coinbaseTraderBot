# Kalshi crypto bot (15-minute and hourly), v3

This is a rebuild that follows *Your Kalshi Bot vs. an Institutional Trading System*. The old bot's problems weren't a lack of sophistication. It had no sound core underneath the "institutional" modules. v2 is small and deliberately plain:

- one pricing model with a theoretical basis
- one validated meta-model, frozen at runtime
- a fail-closed risk gateway
- an order state machine that only moves positions on fills
- reconciliation against the exchange
- fee-correct PnL
- a persistent kill switch
- an audit log

> Nothing here guarantees profit. Good architecture stops you losing money to bugs and bad sizing. Only an edge that has been tested makes money. Follow the go-live gates below.

## Architecture

```
bot/
  config.ts              env -> validated, deep-frozen config (no runtime mutation, no API to change it)
  fees.ts                Kalshi taker/maker fee formula, round-up to the cent
  kalshi/                REST (Create Order V2 only), WebSocket, signing (RSA-PSS / Ed25519), wire parsing, rate limiter
  marketdata/            order books (snapshot+delta, gap -> resnapshot), CF RTI index tracker, recorder
  model/
    fairValue.ts         settlement-exact pricer: 60 s average, martingale drift, Student-t tails, Up/Down, ladders, brackets
    metaModel.ts         frozen, versioned residual model (MLP or gradient-boosted trees, deep ensemble) + go-live gates
    trees.ts             GBDT inference (missing values follow learned default directions)
    featureEngine.ts     one feature engine shared by production and research (~120 candidates, tiered, schema-versioned)
    calibration.ts       Brier, log loss, reliability, Platt, beta calibration, calibration slices
    ladder.ts            strike-ladder monotonicity, isotonic projection, ladder arbitrage scan
    modelHealth.ts       live log-loss advantage vs the calibrated market (Diebold-Mariano), halts when worse
  sizing/kelly.ts        fee-net fractional Kelly; target-EV sizing (shrink to market, $ target, min EV); zero when edge <= 0
  risk/                  RiskGateway (fails closed), worst-case exposure incl. resting orders, persistent KillSwitch, EquityGuard
  oms/                   order state machine, idempotent client_order_id, positions change only on fills
  recon/                 exchange-is-truth reconciliation, fill replay, orphan cancel, break -> halt -> kill
  strategy/              relaxed cadence gate, maker quoting (post_only), selective taking, model exit, Mode B take-profit
  paper/                 paper exchange: same gateway interface, queue-aware fills, no bankroll refills
  tca/                   per-fill edge-at-decision and 5/30/60 s markouts
  api/                   authenticated, read-only operator API; kill switch only
  engine.ts, main.ts
research/                offline only: dataset builder, walk-forward trainer (MLP + GBDT), backtest, DSR/PBO/DM/CPCV stats
tests/                   node:test suite (fees, Kelly, fair value vs Monte Carlo, OMS, risk, recon, paper, strategy, engine)
web/                     read-only dashboard (React), served by the API
deploy/                  systemd unit, activate/rollback scripts
```

Every order goes down one path. Paper, shadow and live all run the same OMS, risk and reconciliation code; only the `ExchangeGateway` changes.

```
market data ─► fair value ─► meta-model ─► strategy plan ─► RiskGateway.check ─► OMS.submit ─► exchange
                                                                 (fail closed)     (id persisted first)
exchange fills/orders ─► OMS (dedupe by trade id) ─► PositionBook ─► PnL / TCA / audit
reconciler (45 s + on reconnect) ─► replay fills, compare orders/positions ─► halt / kill on break
```

## The meta-model, revised

The old `metaLearningEngine.ts` and `plasticityEngine.ts` (tfjs-node) retrained **online** on pre-fee win/loss labels, and Gemini "amendments" rescaled live TP/SL. None of that could be validated. It is replaced by:

1. **A digital-option fair value.** It prices the actual contract, a 60 s average of the CF RTI against a strike that is itself a 60 s average:
   - variance `σ²(τ − 2A/3)` before the final minute
   - an exact partial-fixing treatment inside the final minute
   - tests check it against a Monte Carlo simulation of the settlement
2. **A small frozen neural network** (`bot/model/metaModel.ts`) that learns a *residual* on the fair value's log-odds from market context (mid, spread, depth imbalance, time left, volatility regime):
   - with L2 regularization it shrinks back to the fair value when there is no signal
   - it is trained **offline only** with purged walk-forward CV by window, and the untouched holdout is used once
   - Platt scaling is applied only when enough independent windows support it
   - the file's SHA-256 is stamped on every decision and order
   - **Candidate features ported from the old model** (`bot/model/featureEngine.ts`) are available to it in four groups:
     - microstructure: order-flow imbalance, trade-flow imbalance, VPIN-style toxicity, microprice drift, depth imbalance, trade intensity
     - momentum/TA on the settlement index: sigma-scaled returns, RSI, MACD histogram, Bollinger %B, Kaufman efficiency, Ichimoku tenkan/kijun distance, realized-vol ratio
     - Coinbase spot lead-lag: basis and spot-minus-index return
     - macro: USDT.D and BTC.D levels and 5/15-minute moves, with BTC.D oriented per asset (rising BTC.D is bullish for BTC, bearish for alts). Binance doesn't publish dominance, so `bot/marketdata/dominance.ts` rebuilds it: live Binance USDT-pair prices × circulating supply, re-anchored to CoinGecko's global total every 5 minutes.
     - confluence: explicit agreement features that are non-zero only when independent factors point the same way, signed by direction. Examples: USDT.D falling AND index rising AND RSI(14, 1m) oversold; risk-on AND Kalshi order flow; plus a confluence count. Their weights are learned and validated, never hand-set. Confluence changes trading only through the model's probability: a stronger agreeing signal means more edge, which means larger Kelly size and permission to take liquidity. The Strategy Brain page shows each market's live factors and which features moved the model off the fair value.
     - time of day (only eligible once there are 14+ days of data)

     The offline trainer searches over feature sets (base, base plus each group, all) along with network size. Every variant counts toward the Deflated Sharpe, and holdout permutation importance shows which features actually help. Production and research compute features through the same `FeatureHub`, and a test checks they are identical. Features the old model had that aren't ported (macro goal, trailing state, latency, funding, confluence labels, USDT dominance) had no testable basis for this contract.
   - **Market sessions** (`bot/model/sessions.ts`) are computed from each venue's local hours through IANA time zones, so US and UK daylight-saving shifts are handled. The sessions are Asia, London, London/NY overlap, New York, twilight (US close to Asia open) and weekend.
     - **In learning:** session indicators, time to and since a session change, the US-open window (09:30–10:00 ET, the documented ETF-era volatility spike), Monday Asia open, a seasonal volatility ratio, and, as weak-evidence candidates only, Asian-range position and breakout. All of these are eligible only with 14+ days of data.
     - **In logic:**
       - an intraday volatility profile scales the EWMA sigma used for fair value, following Andersen & Bollerslev (1997). It is fitted and validated out of sample by `npm run research:sessions` and applied only if it improved accuracy;
       - reduce-only per-session risk multipliers (`SESSION_RISK`), with values recommended from backtest evidence;
       - a session guard that keeps hunt mode's order-book stops out of twilight and weekend liquidity and away from session changes.
     - The dashboard shows the session card with venue clocks and a countdown.
3. **Go-live gates enforced in code.** Live mode refuses to start unless the model's validation report shows:
   - at least 1,000 holdout windows
   - a Brier score better than the market mid
   - calibration within 3 pp
   - a fee-inclusive net-edge 95% CI lower bound above 0
   - a deflated Sharpe above 0

   v3 adds the gates listed above: log loss against the calibrated market with Diebold–Mariano, calibration slices, DSR probability and PBO.

With no model file, the identity model (pure fair value) is used. That's fine for paper and shadow, and live mode rejects it.

## v3: the institutional blueprint and the relaxed-cadence spec

v3 implements *Institutional-Grade ML Trading for Kalshi Crypto Binaries and Perps* and the *Kalshi Relaxed-Cadence Model Spec*. Both documents make the same point: the edge comes from exact settlement math, calibration against the market, maker patience and strict validation. It does not come from a more exotic network.

**Cadence (`bot/strategy/cadence.ts`).** `STRATEGY_CADENCE=relaxed` is the default. Each contract gets a full entry/quote decision at every 1-minute bar close. A decision also runs early when:
- fair value moves by 1.5¢ or more
- the book moves through a resting quote
- a fill changes the position, so a take-profit rests at once
- the entry window opens or closes
- a resting quote is due for its 30-second re-price

Decisions are never closer than 10 seconds apart. Exits are checked every tick. Entry windows:
- 15-minute Up/Down: from 14 down to 2 minutes before close. The final minutes are a latency race.
- Hourly strikes: from 55 down to 5 minutes before close, and only while the mid is between 10¢ and 90¢.

In the final minute, open positions ride to settlement.

**Entries and exits.**
- **Maker entries** bid at `floor(q_adj − e_min − buffer)`, with e_min = 3¢. The adverse-selection buffer is estimated from 60-second maker markouts and clamped to 0.5–1.5¢.
- **Taker entries** need at least 5¢ of net edge after the taker fee.
- **Model exit.** Sell at the bid only when the bid minus the taker fee exceeds q_adj + 1¢.
- **`EXIT_POLICY`:**
  - `hold` (Mode A, the default) has no exit fee.
  - `take_profit` (Mode B) rests a maker take-profit at entry + 8¢. It never offers below what the model thinks the position is worth.
  - `fair_value` and `confluence_ratchet` work as before.

**Sizing (`STRATEGY_SIZING=target_ev`).**
- The decision probability is `q_adj = p_mkt_cal + κ(p_model − p_mkt_cal)`, with κ = 0.5. It shrinks the model toward the market after the market's own favourite-longshot bias has been removed.
- Size is `N = min(ceil($target / e), ⌊λ f* B / c⌋, caps)`, with a $10 target and λ = 0.25.
- A trade with expected profit under $1 is skipped.
- Kelly is scaled by `max(0, 1 − drawdown/15%)`. New risk pauses for 24 hours after a 7-day loss above 8%. The daily loss stop is 3%.
- The $100/day vault goal is a **monthly average**. Expect about 35–40% losing days even when the edge is real.
- **Bankroll-scaled risk tiers** (`bot/risk/sizingTiers.ts`, `SIZING_TIERS`). A small account is treated as expendable and sized aggressively; sizing tapers as it grows. Between the points below every limit is interpolated in log(bankroll), so there are no jumps. Across the whole ladder the dollar risk per order stays around $2.

  | High-water mark | Tier | Per order | Daily stop | Kelly | Drawdown brake reaches 0 at |
  |---|---|---|---|---|---|
  | $20 | aggressive | 10% ($2) | 20% ($4) | 3/4 | 60% |
  | $50 | moderate | 5% ($2.50) | 10% ($5) | 1/2 | 35% |
  | $100+ | normal | 2% | 3% | 1/4 | 15% |

  - The tier comes from the **high-water mark** of tradable bankroll, not the current balance. Once the account has grown into a tier it stays there, and losses never re-escalate risk. Withdrawals from trading cash lower the mark.
  - The **hard floor is $10** (`MIN_TRADABLE_BANKROLL_USD`): a $20 account keeps trading after a $2 loss and stops only below $10. `PAPER_BANKROLL_USD` defaults to $20.
  - The EV target is a share (25%) of the per-order risk budget, capped at $10, so it never limits size below the tier. At $20 a typical trade (about 3.5 contracts at 56¢ with a 6.5¢ edge) expects about $0.23, winning about $1.50 or losing $2. Five losses in a row, a normal streak, takes $20 to about $12 (each loss is 10% of what is left, and the drawdown brake shrinks size further).
  - The normal tier is the configured `RISK_*` and `STRATEGY_KELLY_FRACTION` values, and `SIZING_TIERS=off` applies it at every size.

**Markets (`STRATEGY_SERIES=auto`, the default).** Every hour the bot discovers every crypto series it can price from Kalshi's series listing (`bot/marketdata/seriesDiscovery.ts`). That covers 15-minute Up/Down (`KX<ASSET>15M`), hourly/daily greater-than ladders (`KX<ASSET>D`) and range brackets (`KX<ASSET>`) for every asset with a settlement index in `INDEX_ID_MAP` (BTC, ETH, SOL, XRP, DOGE). Crypto series that don't settle on a 60-second index average, such as yearly highs, are skipped because they would be mispriced. An explicit comma list still works. Market listings are paged, so large hourly ladders are complete.

**Pricing (`bot/model/fairValue.ts`).**
- Martingale drift (`d2 = (ln S/K − v/2)/√v`).
- Optional Student-t tails, with ν chosen offline. The trainer keeps Gaussian tails unless a fat-tailed ν beats them by more than one standard error.
- Hourly `greater` ladders (KXBTCD), `between` brackets (KXBTC) and `less` markets, as well as the 15-minute Up/Down.
- `/api/ladder` checks monotonicity and projects the ladder onto a consistent CDF (isotonic). It also flags executable ladder arbitrage (YES(≥K1) + NO(≥K2) < $1 after fees) and bracket-versus-ladder deviations. It is report-only.

**Features (`bot/model/featureEngine.ts`, schema v3, tiered T1/T2).** New minute-scale groups:

| Group | Features |
|---|---|
| geometry | τ, d2, φ(d2), strike distance, Student-t price, contract kind |
| vol | realized variance over 15 min, 1 h and 4 h; EWMA fast/slow ratio; bipower jump ratio; Garman–Klass |
| kalshi | `logit_gap` (market vs pricer), `sigma_gap` (market-implied vs our variance), 1/5-minute flow, mid changes, 1/5/15-minute OFI |
| returns | σ-normalized 5 min/15 min/1 h/4 h returns, return since open, efficiency ratio, range position, variance ratio |
| clock | minute of hour, seconds since the quarter hour, NYSE open/close distance, Kalshi maintenance |
| calendar | minutes to/since CPI, FOMC, NFP and PCE from `params/calendar.json` |
| ladder | violation, neighbour gap, bracket sum |
| interaction | a few interaction terms |

The trainer's ablation decides which groups are kept.

**Model (`research/trainMetaModel.ts`).**
- Rows are weighted 1 / snapshots per contract, and additionally divided by the number of strikes per hourly event.
- Walk-forward folds are purged, with a 1-hour embargo.
- Two model families are compared: a residual MLP, and residual gradient-boosted trees whose init score is the fair-value log-odds. The trees are written in TypeScript (`research/gbdt.ts` and `bot/model/trees.ts`), so there is no ONNX export step and no parity gap.
- The **one-standard-error rule** picks the simplest configuration within 1 SE of the best.
- A beta-calibrated market benchmark (`marketCalibration`) is fitted, and the output is calibrated with Platt or beta scaling, whichever wins out of fold.
- A 5-member bootstrap **deep ensemble** supplies the ensemble spread. Entries are vetoed when |p − p_mkt| < 2σ_ens.
- An optional **CPCV** report (10 groups, 2 held out, 45 splits) gives a distribution of the advantage.
- Holdout predictions go through the production `MetaModel` class, so train/serve parity holds by construction.

**Go-live gates (all enforced by `MetaModel.liveBlockers`).**
- The earlier gates: at least 1,000 windows, Brier better than the market, calibration within 3pp, net-edge CI > 0, DSR > 0.
- **Log loss better than the calibrated market, with Diebold–Mariano p < 0.05.**
- **No calibration slice (price or time to close) off by more than 1.5¢ beyond sampling noise.**
- **Deflated Sharpe probability > 0.95**, counting every configuration tried.
- **PBO < 0.2.**

In live trading, `ModelHealth` stops new risk if the rolling log-loss advantage over the calibrated market turns significantly negative across at least 200 windows. The Telemetry page shows cadence, sizing, drawdown, model health and the entry guards. Operationally, the gate still requires 2 weeks live at 10–20% size, with realized edge at least 50% of the backtest edge.

**Kalshi perpetuals (`bot/perps/`).** Perps run on a separate exchange: REST at `external-api[.demo].kalshi.com/trade-api/v2` under `/margin/...`, with their own API keys. Endpoint and field names follow the perps OpenAPI as mirrored by the public kalshi-python-sdk, because docs.kalshi.com is blocked from the build host. **Verify on Kalshi demo before relying on them.** All wire parsing lives in `perpData.ts` and `perpRest.ts`.
- **Stage 1, perps as features (on by default, no key needed).** Every 2 seconds the bot polls the public perp market list (one call covers all markets) and each market's funding estimate. It records them for research and feeds a new `perp` feature group, which the trainer adds one group at a time like the others:
  - the perp premium to the settlement index, and its 5-minute change (perps tend to lead spot)
  - perp-minus-index return over 1 and 5 minutes
  - the funding rate and minutes to the next funding time (00:00, 08:00 and 16:00 New York)
  - the 1-hour change in open interest
- **Stage 2, delta-hedging the binary book (`PERP_HEDGE`, `paper` by default).**
  - Each binary's sensitivity to the underlying (dP/dS) comes from re-pricing at S ± 0.05%. Positions net per asset, and the hedge target is `−Σ position × dP/dS ÷ contract size`.
  - It hedges only when the book's dollar delta is at least `PERP_HEDGE_MIN_DOLLAR_DELTA` (default $2,000, which is $20 per 1% move) and a whole step is needed. A 25% hysteresis band stops churn.
  - Contracts within 2 minutes of close are excluded because their delta is unstable.
  - Each asset is capped at `PERP_HEDGE_MAX_NOTIONAL_USD`, and the hedge never exceeds the exposure it offsets.
  - Entries are post-only maker orders at the touch, re-priced every 30 seconds.
  - A reduction left unfilled for 5 minutes crosses the spread reduce-only, for example when the binaries have settled and the hedge would otherwise be naked.
  - While new risk is halted or the kill switch is on, the hedger only reduces. The kill switch also cancels perp orders.
  - `paper` simulates hedges against live perp quotes: fills on trade-through only, maker/taker fees in bps, and funding accrued at each funding time. `live` sends real orders and needs `TRADING_MODE=live`, the perps keys, and a funded margin account.
  - At small bankrolls the $2,000 threshold means the hedge rarely fires, which is intended: hedging a $20 book would cost more in fees and margin than the risk it removes.
  - `/api/status` shows the perp feed, premium, funding, the hedge targets and resting orders.
- **Stage 3, directional perp trading, is not built.** Taker round trips (24 bps) are about the size of a 15-minute BTC move. It would need its own model, liquidation-aware limits, funding in P&L and a backtest that passes the same gates.

**ATP tennis (`bot/tennis/`, series `KXATPMATCH`).** Tennis runs as a rules-based strategy driven by the order book, with its own hard budget:
- **Budget.** All tennis positions plus resting orders are capped at 25% of the working cash pool (the tradable bankroll after vault/pocket). The cap can't be configured above 25%. Each match is capped at 10% and each order at 5%. Sizing includes tennis maker fees (multiplier 1). Tennis is budgeted separately from the crypto book, so neither eats the other's limits.
- **Underdog bounce.** From at most 30 minutes before the start (`TENNIS_PRE_START_MIN`, capped at 30) until 20 minutes after it, if the match is heavily skewed (underdog priced 8–25¢), the bot bids for the underdog as a maker, one tick inside the spread when there's room. After a fill it rests a take-profit at `max(entry + 6¢, entry × 1.4)`. If the price jumps past that target, it sells at the bid immediately. This is a volatility trade. Tennis and Kalshi studies find longshots win *less* often than their price implies (Lahvička 2014; Bürgi, Deng & Whelan), so holding underdogs to settlement is expected to lose, and the take-profit is the whole point. An optional stop is off by default, so the maximum loss is the entry price.
  - **Early is what matters.** Underdogs tend to go "in the money" early, when they win a few points or games against the favorite, and then usually lose. So entries get full size before the start and for the first `TENNIS_EARLY_FULL_SIZE_MIN` (10) minutes, then taper linearly to half size at the end of the entry window.
  - **Entries need tennis confluence** (the four signals below): at least `TENNIS_ENTRY_MIN_SIGNALS_PRE` (1) before the start, and `TENNIS_ENTRY_MIN_SIGNALS_LIVE` (2) once in play. Pre-match the book is quiet, so depth or flow alone is enough.
  - **Late-match exits.** Once the match is `TENNIS_UNDERDOG_LATE_PROGRESS` (35%) done, the hunt stops and any profit the bids can fill (at least entry + 1 tick) is taken at once. Past `TENNIS_UNDERDOG_CUT_PROGRESS` (60%) the position is sold at the bid even at a loss, salvaging what it is still worth before the likely loss at settlement (0 turns the cut off).
- **Favorite re-entry.** Once the match is at least half done, and the leader is priced 75–92¢ and hasn't slipped more than 4¢ in 5 minutes, and at least `TENNIS_FAV_ENTRY_MIN_SIGNALS` (2) tennis-confluence signals agree, the bot bids for the leader and holds to settlement. The hit rate is high, but the payoff is asymmetric: at 85¢ a win pays 15¢ and a loss costs 85¢. An optional stop is off by default.
- **Conservative price hunt, then the next exit in profit (`TENNIS_TRAIL=true`, the default, on both legs).** Tennis has no macro confluence, so it uses a **tennis confluence** built from the two player markets' books and tapes. It counts four independent confirmations over the last `TENNIS_CONF_WINDOW_SEC` (60 s); every threshold is configurable (`TENNIS_CONF_MOMENTUM_CENTS`, `TENNIS_CONF_FLOW`, `TENNIS_CONF_DEPTH`, `TENNIS_CONF_OPPONENT_CENTS`). The same signals gate entries and exits:
  - momentum: our player's mid is up at least 1¢
  - trade flow: aggressive buying favours our player (signed flow at least 0.2)
  - depth: bids are heavier in the top three levels (imbalance at least 0.2)
  - cross-market: the opponent's market fell at least 1¢

  How the exit works:
  - Below the target there is no exit order and the position rides. The target is `max(entry + 6¢, entry × 1.4)` for the underdog and `min(97¢, entry + 6¢)` for the favorite.
  - At the target the bot hunts only if at least `TENNIS_HUNT_MIN_SIGNALS` (2) signals agree. Otherwise it takes the profit at once.
  - While hunting, the stop is the highest of the target lock, the order-book wall ratchet (levels that can fill the whole position, as in crypto) and 2 ticks under the peak bid (`TENNIS_HUNT_TRAIL_TICKS`). The hunt lasts at most `TENNIS_HUNT_MAX_SEC` (180 s).
  - When the bid breaks the stop, the signals fade, or time runs out, the bot takes the **next available exit in profit**: a reduce-only sell at the price where visible bid depth can absorb the whole position, never below entry + 1 tick. Below that it holds (the optional hard stop is separate).
  - Exits are taker orders, about 1.2¢ at 20¢ with the tennis fee multiplier of 1.
  - `TENNIS_TRAIL=false` restores the fixed maker take-profit. The dashboard shows each position's stop and confluence reading.
- **Match state and progress.** "Started" means the published start time has passed, or, when none is published, the first 3¢ move of the mid within 3 minutes (in-play prices move on every point). Progress (0–1, used by the favorite re-entry and the underdog late/cut exits) is measured in **points, not minutes**, by a tennis scoring model in `bot/tennis/tennisModel.ts`:
  - **Rules.** Games go to 4 points with deuce and advantage. Sets go to 6 games, win by 2, with a 7-point tiebreak at 6-6 (serve alternating every 2 points). Since 2022 all four Slams play a 10-point tiebreak at 6-6 in the final set. Matches are best of 5 in Slam main draws and best of 3 elsewhere, including Slam qualifying (read from the market title).
  - **Calibration.** Each player's serve-point win rate is solved from the pre-match price around the tour average (`TENNIS_SERVE_BASE`, 64%). The model then gives the mean and spread of the match length: an even best-of-3 is about 164 points (about 110 minutes at `TENNIS_SEC_PER_POINT`=40 s, which includes changeovers), a 92/8 match about 20 points fewer, and an even best-of-5 about 270.
  - **Point clock.** Minutes since the start are converted to points and compared with that length distribution. A match running long is assumed to have more to go (a tight three-setter with tiebreaks), so time alone never reaches 100%.
  - **Information clock.** The win probability is a martingale that ends at 0 or 1, so the price variance still to resolve is p(1−p) on average. Progress is `resolved / (resolved + p(1−p))`, where resolved is the price variation already seen (or at least the drop in p(1−p) since the start). A blowout reads as nearly finished, while a see-saw match at 50/50 reads as early whatever the clock says. The two clocks are blended at `TENNIS_PROGRESS_INFO_WEIGHT` (0.5).
  - **Live score (optional, `TENNIS_SCORE_FEED=kalshi`).** Kalshi links matches to milestones with live data (`/milestones`, `/live_data/{type}/milestone/{id}`, taken from the official SDK). With a score, progress comes from the exact sets, games and points: points played against the model's expected remaining points from that score, which understands a set in hand, a 5-5 final-set tiebreak and so on. The tennis payload isn't documented, so the parser accepts common shapes and the raw payload is shown as `scoreRaw` in `/api/status`. Check a few matches before relying on it. It's off by default, and the model estimate is the fallback.
  - `/api/status` shows each match's progress breakdown (point clock, information clock, score, expected minutes, best-of).
- **Rollout.** Tennis trades in paper and shadow modes. In live mode it only tracks matches until you set `TENNIS_LIVE=true`. `npm run research:tennis` replays recorded tennis books through the same decision code and reports P&L per leg with a per-match bootstrap CI. Enable real money only once that CI's lower bound is above 0 over about 200 matches.
- `/api/status` and the Telemetry panel show each match's phase, the budget in use, and why the bot is or isn't acting.

**Researched and deliberately not adopted (yet):**
- **LightGBM in Python plus ONNX.** Replaced by the in-repo TypeScript GBDT, which gives the same model class with nothing to keep in parity.
- **GRU/TCN encoder, gated regime stacker, HMM/BOCPD regimes.** Both documents rank these last. They need 3 months or more of logs, and must beat the GBDT in CPCV to be kept.
- **Scenario/copula Kelly.** Correlated same-close BTC/ETH/SOL exposure is instead capped as one position by `RISK_MAX_WINDOW_FRAC`.
- **Funding, OI and liquidations; DVOL; NQ/DXY; Coinbase multi-level OFI.** These need feeds the bot does not have (or that are US-blocked), and they are T2/T3 anyway.
- **Full Avellaneda–Stoikov quoting and RL quote offsets.** They need fill-intensity estimates from our own fills first. Inventory skew stays in place.

## Profit vault and pocket

These are rules for how much of the Kalshi cash the bot treats as its own to trade (`bot/vault/`). Nothing moves on the exchange; reserved money is simply left out of the tradable bankroll, which drives sizing and risk limits.

- **Vault.** 50% of every win (fee-inclusive, at settlement) is vaulted until $100 has been vaulted. Vaulting then pauses until the next market session opens, when the quota resets. `VAULT_QUOTA_RESET=us_open` resets it once per US-open day instead. The headline goal is **$100 per trading day** (US open to US open, `VAULT_DAILY_GOAL_USD`). Because the quota refills each session, a day can go over the goal, which is fine.
- **Pocket.** Only while the quota is met, 10% of each win is pocketed. Pocketed money is released back to trading at the next US market open (09:30 ET, so Friday's pocket releases on Monday).
- **Withdrawals.** They are detected by reconciling Kalshi's balance against the cash movements the bot's own trading explains. A discrepancy is booked only if it is stable across two checks with no settlement in flight. Withdrawals come out of the vault first, then the pocket, then trading cash. The dashboard's **Record Withdrawal** button books one manually, and the detector will not count it a second time.

## Running

```bash
npm ci
npm run check            # typecheck + tests
cp .env.example .env     # set DASHBOARD_TOKEN=$(openssl rand -hex 32)
npm run dev              # paper mode by default
# dashboard: ssh -L 3000:127.0.0.1:3000 <host>, then http://localhost:3000
```

### Modes

- **Paper without Kalshi keys** uses public REST books and trades. Set `ALLOW_PROXY_INDEX=true` to price off Coinbase spot. That has basis risk against the RTI, so it is plumbing only.
- **Shadow** uses `TRADING_MODE=shadow` with a Kalshi key. It gets the authenticated WebSocket (books, trades, lifecycle, CF RTI) and the simulated exchange. This is the "shadow paper" phase.
- **Live** needs all of the following, and all of them are set at deploy time, never via the API:
  - `TRADING_MODE=live`
  - `KALSHI_ENV=prod`
  - `LIVE_TRADING_ACKNOWLEDGED=I_ACCEPT_REAL_MONEY_RISK`
  - a validated `params/model.json`

### Research loop

```bash
npm run research:dataset -- --recordings data/recordings --every 60 --entry-window-only   # relaxed-spec sampling
npm run research:train -- --families mlp,gbdt --ensemble 5 --cpcv 10                      # -> params/model.candidate.json
npm run research:backtest -- --model params/model.candidate.json --grid 0.02,0.03,0.04 --exits hold,take_profit,fair_value --annotate
```

`npm run research:sessions` reports volatility, Kalshi spreads and depth, and trade activity for each session. It fits and validates the intraday volatility profile (`params/vol_profile.json`), backtests P&L by session, and prints a recommended `SESSION_RISK` along with the evidence behind it.

The backtest mirrors the engine: cadence-gated entries, entry windows, target-EV sizing and exit modes. It reports profit per trade (with CI), trades and P&L per day, and take-profit fills alongside the per-window statistics. `--annotate` writes `netEdgeCiLow`, `deflatedSharpe`, `dsrProbability` and `pbo` into the model file.

`--exits hold,fair_value,take_profit,liquidity_ratchet,hybrid` compares exit policies on identical data (`bot/strategy/exitPolicies.ts`):
- **Liquidity ratchet.** Stops sit at exit-side book levels big enough to absorb the whole position (`--ratchet-fill`) that have persisted for `--ratchet-age` seconds. The stop ratchets up as price moves past higher walls. If price comes back down to the stop, the bot exits with an immediate-or-cancel order limited to the stop minus `--ratchet-slip` ticks. A gap through the stop falls back to the next wall down.
- **Hybrid.** The same ratchet, but a triggered stop only exits if the model agrees the position is worth less than the stop.

- **Confluence ratchet ("let the winner run").** Normally the fair-value exit applies. The bot switches to hunt mode only when a position has beaten its entry fair value by `--hunt-margin` AND the confluence score oriented to the position is at least `--hunt-confluence`. In hunt mode an **order-book ratcheting trailing stop** manages the exit, and nothing else may reduce the position: no fair-value exit, no opposite quote, no opposite takes.
  - The stop starts **at the target** as soon as hunting begins, which locks that profit.
  - As the surge continues, the stop ratchets up to each exit-side level the price moves past that could actually fill the whole position: size at least `--ratchet-fill` × position, persisting for `--ratchet-age` seconds.
  - When the surge reverses below the stop, the bot exits reduce-only at the stop minus `--ratchet-slip` ticks.
  - It takes the profit early at the bid, never below the lock, if confluence flips against the position or the session turns unsafe for book-anchored stops.
  - A gap through the stop sells at the bid while that is still above the entry fair value. Below it, hunt mode ends and the fair-value exit takes over.
  - **Evaluated in research.** `research:backtest` runs hunt mode over a grid of target margins (`--hunt-grid`, default 1/2/4¢) and wall fill ratios (`--ratchet-fill-grid`, default 1×/2×). Every variant counts toward the Deflated Sharpe. The best variant is compared with the fair-value exit window by window, and `--annotate` writes the result into the model file as `validation.exitEvaluation`. `huntOk` requires at least 300 windows, a paired bootstrap CI lower bound above 0, and a deflated probability above 0.95.
  - With a passing evaluation the engine uses the winning parameters. In live mode an unevaluated or losing hunt mode falls back to the fair-value exit, and the dashboard says so.
  - It is available as the opt-in `EXIT_POLICY=confluence_ratchet`, and the dashboard shows HUNTING with the target and stop.

Every exit executes one tick after it triggers. The exit policy governs all active reductions, so taker entries against a position are blocked under hold and ratchet. The diagnostics report:
- exit regret: settlement value of the exited contracts minus exit proceeds
- stopped-out winners
- slippage versus the stop
- gap-throughs

Production keeps the fair-value exit unless a policy wins on real recordings after fees and the overfitting correction.

The backtest reports per-window results. Correlated BTC, ETH and SOL markets that close together count as one observation. It also reports a bootstrap CI of net edge per contract, the Deflated Sharpe for every variant tried, and PBO (CSCV) across the grid. Promoting a candidate is a reviewed PR; see `params/README.md`.

## Guide checklist: what changed

| Guide item | Status |
|---|---|
| Public `0.0.0.0` binding, 75 open routes | Binds `127.0.0.1` by default; a non-loopback bind needs an explicit flag. Every `/api` route needs a bearer token (constant-time compare, lockout). |
| Live toggle via API, raw settings merge, credential-writing endpoints | Removed. There is no settings, credential, restart or reset-state route. Live mode is env-only, checked at startup. |
| Open cancel-all, panic, restart and download routes | Replaced by one authenticated kill switch and a reset that needs a typed phrase and clean reconciliation. |
| Auto-deploy on push to `main` with `npm install` | Replaced. CI runs typecheck, tests and build. Deploy is manual, tag-only, uses `npm ci`, sits behind a GitHub `production` environment, and supports rollback. |
| Gemini writing live parameters | Removed from the runtime. LLMs may help offline (reviews, reports) and must never change a running parameter. |
| `ALWAYS_ON_15M`, profit-target sizing, Kelly fail-open, EV-gate override, $0.50 default price | Removed. Kelly returns zero when edge ≤ 0. The gateway has no override. Missing data blocks trading and pulls quotes. |
| FIX path, and FIX→REST fallback with a new id | Removed. There is one REST order path. Retries reuse the same `client_order_id`, and a timeout queries by id before any resend. |
| Perps / margin | Removed until the core is proven. |
| Online NN, meta-learning, plasticity, hand-set win probability, confluence | Replaced by the fair value plus the frozen, offline-validated meta-model. |
| % TP/SL and trailing stops on binaries | Removed. The bot holds to settlement and exits only when the bid beats fair value by the fee plus a buffer. |
| USDT-dominance, Ichimoku, VPIN gates; trade-ID-tuned gates | Removed. |
| Paper "blowout reset" | Removed. The paper exchange never refills. |
| Cosmetic modules (Avellaneda-Stoikov, jump-diffusion, Kalman, Bayesian Kelly, HRP, Almgren-Chriss, "SR 11-7"), the Python bot, patch scripts, committed state, second lockfile | Deleted. |
| Legacy `/portfolio/orders` | Orders go to `POST /portfolio/events/orders` (V2) with `post_only`, `self_trade_prevention_type`, `expiration_time` and `cancel_order_on_pause`. |
| Risk gateway (fail closed) | `bot/risk/riskGateway.ts`. It checks: per-order, per-window (correlated, no netting), total and daily-loss limits; price collar vs fair value and vs the touch; longshot guard; stale book and index; throttles; time to close. |
| OMS state machine and idempotency | `bot/oms/`. The id is persisted before send. Acceptance is not a fill. Fills are de-duplicated. Exits stay tracked until confirmed. |
| Reconciliation | `bot/recon/reconciler.ts`. Runs every 45 s and on reconnect. Missed fills are repaired, orphans cancelled, and a break halts new risk (and trips the kill switch if it persists). |
| Kill switch | Persists on disk, survives restart, auto-trips on loss limit, repeated order errors, persistent break or a stalled heartbeat. Resting orders also carry an exchange-side `expiration_time` as a dead-man switch. |
| Fee-correct PnL | Exact fee formula with round-up. Uses exchange-reported fees when present. Wins and losses are labelled after fees at settlement. |
| Data recorder, fill simulator, TCA, alerts, audit log | Recorder: `marketdata/`. Fill simulator: `paper/` (queue position, trade-through fills). TCA: `tca/` (markouts). Alerts: Telegram or webhook. Audit log: hash-chained JSONL, checked with `npm run audit:verify`. |
| Tests / CI | 196 tests, including an engine integration test and end-to-end research pipeline tests (MLP and GBDT) on synthetic data. |

## Things you must do yourself

1. **Rotate the Kalshi API key now.** Assume the old one is compromised, because it could be overwritten over HTTP. Create a subaccount-restricted key, store it outside the repo, and `chmod 600` it.
2. **Close the firewall.** In Lightsail, leave only SSH open. Reach the dashboard via SSH tunnel or Tailscale.
3. **Protect the `production` environment.** In GitHub settings, require a reviewer on it. The server keeps its own `bot.env`.
4. **Verify wire formats on Kalshi's demo environment before any live dollar.** The docs site was not reachable while this was built, so these follow the guide and the previous adapter:
   - the V2 order payload
   - WebSocket message shapes, especially `cfbenchmarks_value` and its index ids (`INDEX_ID_MAP`)
   - the fills and positions fields
   - series fee fields

   All parsing lives in `bot/kalshi/wire.ts` and `bot/kalshi/ws.ts`.
5. **Confirm the fee multipliers per series.** Read them from the series API; live mode refuses a series whose fees were not fetched.

## Go-live roadmap (from the guide)

| Phase | Gate to exit |
|---|---|
| 0 Lockdown | Port scan shows only SSH. Live flag only at deploy. Old key revoked. |
| 1–2 Core | Tests pass. On Kalshi **demo**, 500+ orders with zero reconciliation breaks, orphans or duplicates. A kill-switch drill cancels everything within 5 s and survives restart. |
| 3 Data & model | At least 1,000 windows recorded. Out-of-sample, fee-inclusive net edge 95% CI lower bound above 0. Log loss beats the calibrated market (DM p < 0.05). DSR probability above 0.95, PBO below 0.2. Calibration within 1.5¢ in every price and time-to-close slice. Backtest shows $1–$10 average profit per trade at the chosen bankroll. |
| 4 Shadow | The same gates on new data. Max drawdown under 15%. Maker markouts no worse than half the quoted edge. |
| 5 Pilot | 2 weeks at 10–20% size (`RISK_MAX_CONTRACTS_PER_ORDER`, `STRATEGY_TARGET_EV_USD`), 2% window cap, 3% daily loss stop. At least 200 fills, realized edge per contract at least 50% of backtest edge, zero breaks. |
| 6 Ramp | Double capital at most once per clean month. |

## Legacy code

The previous implementation was removed in v2. That covers `server_app.ts`, the `*Engine.ts` modules, `kalshiFixEngine.ts`, the Python bot, the `fix_*`/`patch*`/`check_*` scripts, the old `src/` frontend, `bun.lock`, and committed state such as `audit_memory.json`. Git history still has it.
