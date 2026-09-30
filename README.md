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
- **Clock-skew guard (`bot/risk/clockSkew.ts`).** Contracts settle on exact seconds and Kalshi rejects badly timestamped requests. The local clock is compared with the `Date` header of every Kalshi REST response. The header has one-second resolution, but each response bounds the offset to `[Date − recv, Date + 1 s − send]`, and the intersection of recent intervals narrows it to a few hundred ms. New risk halts when the whole interval is beyond `CLOCK_SKEW_MAX_MS` (2 s), so one unlucky sample can't trip it. Exits stay allowed. Beyond `CLOCK_SKEW_WARN_MS` (1 s) the dashboard warns. A stepped clock (NTP correction) is handled by falling back to the newest samples, and no recent sample means no verdict. `/api/status` shows the offset, bounds and sample count under `clock`. `CLOCK_SKEW_MAX_MS=0` disables the halt.
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
  - **The daily stop is in dollars too.** Each tier has a dollar ceiling (`dailyLossUsd`: $4, $5, and `RISK_DAILY_LOSS_USD` at the normal tier), interpolated like the other limits. The stop is the lower of the tier fraction of bankroll and that ceiling. Above $100 the ceiling grows in proportion to the high-water mark instead of staying at one flat number, so a $1,000 account is stopped at 3% ($30), not at $5. The dashboard shows the tier's actual limit.

**Markets (`STRATEGY_SERIES=auto`, the default).** Every hour the bot discovers every crypto series it can price from Kalshi's series listing (`bot/marketdata/seriesDiscovery.ts`). That covers 15-minute Up/Down (`KX<ASSET>15M`), hourly/daily greater-than ladders (`KX<ASSET>D`) and range brackets (`KX<ASSET>`) for every asset with a settlement index in `INDEX_ID_MAP` (BTC, ETH, SOL, XRP, DOGE). Crypto series that don't settle on a 60-second index average, such as yearly highs, are skipped because they would be mispriced. An explicit comma list still works. Market listings are paged, so large hourly ladders are complete.

**Record-only series (`RECORD_SERIES`).** A comma list of Kalshi series that the bot subscribes to and records, but never prices, quotes or trades. Their books, trades, lifecycle events and **official results** (fetched once per market after it closes) go into the same recordings, so a new market type or sport can gather research data before any strategy exists for it. They are flagged `recordOnly` in the recording. Backtests, dataset builds and session stats skip them, hourly ladders never use them as siblings, and `RECORD_MAX_MARKETS` (150) caps how many are tracked at once. A series already being traded is not duplicated. `/api/status` shows `recording`.

**Pricing (`bot/model/fairValue.ts`).**
- Martingale drift (`d2 = (ln S/K − v/2)/√v`).
- **Official 60-second average (`SETTLEMENT_AVG=official`, the default).** Settlement is the simple average of the sixty one-per-second CF RTI values in the last minute. `IndexTracker.settlement` takes the last print at or before each of the 60 second marks (`close − 59 s … close`) and averages them. The mid-window pricer fixes the `n` marks that have passed and prices the other `60 − n`, instead of treating the average as continuous. The same function computes the opening strike of an Up/Down contract when Kalshi hasn't published one, and the computed outcome in research. It is unavailable unless every mark so far is covered by a print no older than 3 s, so a feed hole blocks pricing instead of inventing a value. `SETTLEMENT_AVG=continuous` restores the earlier time-weighted average. The two differ by less than a second of drift. **Which side of the boundary the marks fall on (`close − 59 s … close` vs `close − 60 s … close − 1 s`) comes from Kalshi's rule text, which I could not read from the build host. Check it against a few settled contracts** (`/api/status` strike and the recorded results).
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

**TA knowledge library (`bot/ta/`, readable version in [`docs/TA_LIBRARY.md`](docs/TA_LIBRARY.md)).** The bot has direct access to technical analysis of the Coinbase spot USD pair behind each contract (BTC-USD, ETH-USD, ...). The library is built from the operator's reference PDF *Quantitative Technical Analysis in Cryptocurrency Markets* and cross-checked against the original authors and the empirical literature.
- **Data.** `SpotCandleFeed` polls Coinbase candles on 1m, 5m, 15m, 1h and 1d; 4h is built from complete 1h groups. Only closed candles count, so there is no look-ahead. New candles are recorded as `candles` events, so research replays exactly what live saw. `TA_CANDLES=false` turns it off.
- **Indicators (`indicators.ts`).**
  - Trend: SMA/EMA, ADX with ±DI, Ichimoku.
  - Volatility: Bollinger Bands with %B, bandwidth and the Keltner squeeze; ATR.
  - Momentum: RSI, MACD, Stochastic, Williams %R.
  - Volume: OBV, CMF, MFI, session VWAP, volume profile (POC, value area, high/low-volume nodes); Donchian channels.
  - All are standard author definitions with Wilder smoothing where the original uses it.
- **Structure (`structure.ts`).** Confirmed fractal swings, HH/HL/LH/LL structure, break of structure and change of character, liquidity sweeps vs true breakouts (wick-and-reclaim vs solid body on volume), equal highs/lows, unfilled fair value gaps, regular and hidden divergences (RSI, MACD histogram, OBV, MFI), engulfing/doji/pin-bar candles, and round-number levels (Osler's stop and take-profit clustering).
- **Knowledge (`knowledge.ts`).** Every indicator has an entry covering its formula, parameters, the timeframes the reference recommends vs the ones the bot uses, what each state means for price action, caveats, and an **evidence rating with sources**.
  - Moderate: MA and breakout rules (Hudson & Urquhart 2021, Detzel et al. 2021, Gerritsen et al. 2020) and round numbers (Osler 2003).
  - Weak: oscillators and candlesticks (Park & Irwin 2007, Marshall et al. 2006).
  - Practitioner only: SMC liquidity concepts, volume profile, the "80% rule".
  - On-chain MVRV and NVT are documented but not computed: they are cycle-scale metrics with no information at a 15-minute horizon.
- **Rules and confluences.** 47 live rules (122 rule × timeframe checks, e.g. `rsi_divergence`, `liquidity_sweep`, `squeeze_release`, `vp_80_rule`, `dominance_matrix`) are evaluated per timeframe. 13 confluences encode the reference's combinations:
  - the Volatility Reversal Matrix (sweep + LVN rejection + RSI divergence + MACD shift) on 15m and 1h;
  - the SMC sweep → CHoCH → FVG reversal;
  - trend alignment;
  - squeeze breakouts;
  - range mean reversion (only with ADX < 20);
  - volume confirmation;
  - multi-oscillator exhaustion;
  - value-area rotation;
  - multi-timeframe momentum;
  - the BTC.D × USDT.D rotation matrix (asset-aware: altseason is bullish for alts, risk-on-for-BTC is not);
  - the higher-timeframe regime.
- **How the bot learns from it.**
  1. **Features.** 68 new features: `ta` (51) holds indicator readings per timeframe, normalised by ATR; `taconf` (17) holds confluence scores and nets per rule kind. Stale charts read NaN. The trainer tries `…+ta` and `…+ta+taconf` sets, and walk-forward validation (counted in the Deflated Sharpe) decides whether TA earns a place in the model. Nothing is hand-weighted.
  2. **Rule study.** `npm run research:ta` walks forward over Coinbase history (`--assets BTC,ETH,SOL --days 120`) or recorded candles (`--recordings`). For each rule × timeframe and each confluence it measures the hit rate and drift-removed forward return at 15 and 60 minutes, with a moving-block bootstrap. A Benjamini-Hochberg false-discovery-rate cut runs across every hypothesis. The result is written to `params/ta_study.json`.
- **API.**
  - `GET /api/ta` shows each asset's live reading: indicators per timeframe, active signals with their textbook meaning **and their measured study stats**, and firing confluences.
  - `GET /api/ta/library` returns the full knowledge base.
  - `npm run ta:docs` regenerates `docs/TA_LIBRARY.md`.

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

**Kalshi perpetuals (`bot/perps/`).** Perps run on a separate exchange: REST at `external-api[.demo].kalshi.com/trade-api/v2` under `/margin/...`, with their own API keys. Endpoint and field names follow Kalshi's perps overview page and the perps OpenAPI spec (`specs/perps_openapi.yaml` in the public kalshi-python-sdk): orders, positions, balance (`/margin/balance?compute_available_balance=true`), risk (`/margin/risk`), `/margin/enabled` and exit triggers. **Verify on Kalshi demo before relying on them.** All wire parsing lives in `perpData.ts` and `perpRest.ts`. Rules from the spec that the code enforces:
- Perp prices are **per contract**. The exchange computes notional as `|qty| × mark`, so a contract's exposure to the underlying is measured as perp price ÷ index price, not from `contract_size`.
- `reduce_only` is accepted **only on immediate-or-cancel / fill-or-kill orders**. Resting reductions are plain post-only orders sized to the position; urgent reductions are reduce-only IOC.
- Counts and prices are fixed-point strings (prices in dollars, 4 decimals).
- **Stage 1, perps as features (on by default, no key needed).** Every 2 seconds the bot polls the public perp market list (one call covers all markets) and each market's funding estimate. It records them for research and feeds a new `perp` feature group, which the trainer adds one group at a time like the others:
  - the perp premium to the settlement index, and its 5-minute change (perps tend to lead spot)
  - perp-minus-index return over 1 and 5 minutes
  - the funding rate and minutes to the next funding time (00:00, 08:00 and 16:00 New York)
  - the 1-hour change in open interest
- **Stage 2, delta-hedging the binary book (`PERP_HEDGE`, `paper` by default).**
  - Each binary's sensitivity to the underlying (dP/dS) comes from re-pricing at S ± 0.05%. Positions net per asset, and the hedge target is `−Σ position × dP/dS ÷ (underlying units per contract)`.
  - It hedges only when the book's dollar delta is at least `PERP_HEDGE_MIN_DOLLAR_DELTA` (default $2,000, which is $20 per 1% move) and a whole step is needed. A 25% hysteresis band stops churn.
  - Contracts within 2 minutes of close are excluded because their delta is unstable.
  - Each asset is capped at `PERP_HEDGE_MAX_NOTIONAL_USD`, and the hedge never exceeds the exposure it offsets.
  - At small bankrolls the $2,000 threshold means the hedge rarely fires, which is intended: hedging a $20 book would cost more in fees and margin than the risk it removes.
- **Stage 3, LIVE directional perp trading (`PERP_TRADING`, `paper` by default, `live` for real orders).** `bot/perps/perpTrader.ts` decides a target position per perp market. One executor (`hedger.ts`) drives each position to hedge + directional target.
  - **Signal.** The expected return over `PERP_HORIZON_MIN` (240 min) comes from a frozen ridge model (`params/perp_model.json`) on ~30 features: returns and volatility, perp premium, funding, open interest, USDT.D/BTC.D, and the TA library readings and confluences. The features come from the same registry the binary model uses.
    - Without a model, a time-series-momentum prior (IC `PERP_PRIOR_IC` = 0.05 × σ_H × clipped 4-hour momentum z) lets the bot trade live at **pilot size**. With realistic costs it trades rarely, which is the honest outcome.
  - **Entry and exit.** `net = dir × μ − 2 × maker fee − funding over the horizon in the position's direction` (positive funding: longs pay). It enters when net ≥ `PERP_ENTRY_EDGE_BPS` (5) and holds while `dir × μ − exit fee − funding ≥ PERP_EXIT_EDGE_BPS` (0), a hysteresis band. It reverses on a strong opposite signal, and exits after `PERP_MAX_HOLD_MIN` (480) without a fresh entry-strength signal.
  - **Size.** Fractional Kelly for a continuous bet: `leverage = PERP_KELLY_FRACTION × net ÷ σ_H²`, capped by:
    - `PERP_MAX_LEVERAGE` (3) and half the exchange's leverage estimate;
    - `0.5 ÷ stop distance`, so the stop always sits well inside the liquidation distance;
    - `PERP_MAX_NOTIONAL_USD` per market and `PERP_MAX_TOTAL_NOTIONAL_USD` overall.
  - **Stops on the exchange.** Each directional position gets a Kalshi exit trigger (`PUT /margin/cross/positions/{ticker}/exit_trigger`, stop-loss on the liquidation mark) at `max(PERP_STOP_ATR_MULT × 1h ATR, PERP_MIN_STOP_BPS)` from the entry. It protects the position even while the bot is down. The bot also flattens itself if the touch crosses the stop, then cools down for `PERP_COOLDOWN_MIN`.
  - **Account guards.**
    - A perp daily loss stop on margin-account equity (`PERP_DAILY_LOSS_FRAC`, 10%) flattens and halts for the rest of the UTC day.
    - The kill switch flattens every directional position with reduce-only IOC orders.
    - The clock-skew guard and a failed perps feed block new entries.
    - There is a minimum equity for new entries (`PERP_MIN_EQUITY_USD`).
    - Every order passes quote freshness (20 s), a price collar (`PERP_COLLAR_BPS`) and a per-order notional cap (`PERP_MAX_ORDER_NOTIONAL_USD`).
  - **Pilot vs full size.** Until a model passes both gates below, directional trading is capped at `PERP_PILOT_MAX_NOTIONAL_USD` ($25) and `PERP_PILOT_MAX_LEVERAGE` (1×). `PERP_REQUIRE_VALIDATION=true` blocks unvalidated entries entirely.
  - **Validation (research).**
    1. `npm run research:perp-train` builds the dataset from recordings (perp quotes, index, candles, dominance), then runs a walk-forward ridge fit with an H embargo. It checks the out-of-sample IC CI lower bound > 0 (block bootstrap), the per-trade P&L CI lower bound > 0 for the live trading rule net of fees and funding, a deflated Sharpe probability > 0.95, and an effective sample ≥ 200.
    2. `npm run research:perp-backtest -- --model … --annotate` replays the recordings through the same trader and executor against the paper perps exchange: maker fills on trade-through, fees, funding and exchange stops. It needs a positive per-day P&L CI lower bound and a DSR probability > 0.95 over at least 30 days.
    - A test checks the pipeline on synthetic data: a random walk never validates, and a planted momentum signal is found and trades profitably.
- **Execution (hedge and directional).**
  - Entries and ordinary reductions are post-only maker orders at the touch, re-priced every 30 seconds.
  - A reduction left unfilled for 5 minutes, or an urgent one (stop, kill switch, daily loss), crosses the spread reduce-only.
  - A flip closes first; the new side opens on the next tick. An open position nobody wants any more is unwound.
- **Venue and modes.** Hedging and trading share one perps account, so `PERP_HEDGE` and `PERP_TRADING` must both be `live` or both `paper`.
  - `live` needs `TRADING_MODE=live`, `KALSHI_PERPS_KEY_ID` / `KALSHI_PERPS_PRIVATE_KEY_PATH` and a funded margin account. At startup the bot checks `/margin/enabled` (perps are rolling out member by member). Transfers from the event-contract balance to margin are not available yet, so fund the margin account directly.
  - In live mode an unvalidated binary model no longer stops the process when perps or tennis trade live. The risk gateway still rejects every binary crypto order until that model validates.
  - `paper` simulates against live perp quotes with a `PERP_PAPER_BALANCE_USD` ($20) margin account.
  - `/api/status` → `perps` shows the feed, premium, funding, hedge and combined targets, resting orders, exchange stops, and the trader's equity, signal source, model gates and last decision per market. The telemetry page has a Perps row.

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
- **Graduation ramp (`VAULT_RAMP_START_USD`=20, `VAULT_RAMP_FULL_USD`=100).** A $20 account has to compound to reach the larger sizing tiers, and skimming half of every $2 win would keep it there. The vault and pocket shares are therefore scaled by a factor that is 0 at a $20 tradable high-water mark and 1 at $100, interpolated in log(bankroll) like the tiers (about 57% at $50). The factor reads the high-water mark, so an account that has graduated stays at the full rate. Skipped wins are logged as `skip` events. `VAULT_RAMP_FULL_USD=0` restores the full rules at any size.
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
npm run research:ta -- --assets BTC,ETH,SOL,XRP,DOGE --days 120                        # TA rule study -> params/ta_study.json
npm run research:perp-train -- --recordings data/recordings --every 300                 # -> params/perp_model.candidate.json
npm run research:perp-backtest -- --model params/perp_model.candidate.json --annotate   # execution gate for full-size perps
```

`npm run research:sessions` reports volatility, Kalshi spreads and depth, and trade activity for each session. It fits and validates the intraday volatility profile (`params/vol_profile.json`), backtests P&L by session, and prints a recommended `SESSION_RISK` along with the evidence behind it.

**Latency injection.** `--latency-ms 250 [--cancel-latency-ms 150] [--latency-jitter-ms 100]` makes every order and cancel reach the simulated exchange late, against whatever the book and the tape look like by then (seeded jitter, so runs repeat). A taker order fills at the later price, a maker quote joins the queue late, and a cancel can lose the race to a trade (`cancelRaceFills` counts those fills). While a market has anything in flight the strategy plans nothing new for it, like the engine's per-market busy flag. The default is no latency, which is optimistic: on the synthetic data 500 ms of latency cuts P&L by about 40% and 3 s by about 80%, so run the real recordings at your actual round-trip time (`--latency-ms`, typically 100–400 from a US cloud host) before trusting a profit number. The tennis backtest does not inject latency yet.

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
| Perps / margin | Rebuilt on the new core: features (stage 1), a delta hedge (stage 2) and live directional trading (stage 3) with exchange-side stops, liquidation-aware leverage, a perp daily loss stop, pilot size until a model validates, and research gates. |
| Online NN, meta-learning, plasticity, hand-set win probability, confluence | Replaced by the fair value plus the frozen, offline-validated meta-model. |
| % TP/SL and trailing stops on binaries | Fixed-% stops removed. Exits are fair-value or model-based. The order-book ratchet / hunt mode runs live only after the backtest shows it beating the fair-value exit. |
| USDT-dominance, Ichimoku, VPIN gates; trade-ID-tuned gates | Removed as gates. USDT.D/BTC.D, Ichimoku and VPIN return only as learned model features, weighted by walk-forward validation. |
| Paper "blowout reset" | Removed. The paper exchange never refills. |
| Cosmetic modules (Avellaneda-Stoikov, jump-diffusion, Kalman, Bayesian Kelly, HRP, Almgren-Chriss, "SR 11-7"), the Python bot, patch scripts, committed state, second lockfile | Deleted. |
| Legacy `/portfolio/orders` | Orders go to `POST /portfolio/events/orders` (V2) with `post_only`, `self_trade_prevention_type`, `expiration_time` and `cancel_order_on_pause`. |
| Risk gateway (fail closed) | `bot/risk/riskGateway.ts`. It checks: per-order, per-window (correlated, no netting), total and daily-loss limits; price collar vs fair value and vs the touch; longshot guard; stale book and index; throttles; time to close. |
| OMS state machine and idempotency | `bot/oms/`. The id is persisted before send. Acceptance is not a fill. Fills are de-duplicated. Exits stay tracked until confirmed. |
| Reconciliation | `bot/recon/reconciler.ts`. Runs every 45 s and on reconnect. Missed fills are repaired, orphans cancelled, and a break halts new risk (and trips the kill switch if it persists). |
| Kill switch | Persists on disk, survives restart, auto-trips on loss limit, repeated order errors, persistent break or a stalled heartbeat. Resting orders also carry an exchange-side `expiration_time` as a dead-man switch. |
| Fee-correct PnL | Exact fee formula with round-up. Uses exchange-reported fees when present. Wins and losses are labelled after fees at settlement. |
| Data recorder, fill simulator, TCA, alerts, audit log | Recorder: `marketdata/`. Fill simulator: `paper/` (queue position, trade-through fills). TCA: `tca/` (markouts). Alerts: Telegram or webhook. Audit log: hash-chained JSONL, checked with `npm run audit:verify`. |
| Tests / CI | 232 tests, including an engine integration test and end-to-end research pipeline tests (binary MLP/GBDT, tennis, TA study, perps) on synthetic data. |

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
