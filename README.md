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
  fees.ts                Kalshi taker/maker fee formula and its rounding
  kalshi/feeSchedule.ts  Kalshi's fee schedule, exactly: the published PDF, each series' fee type, event overrides, a check of every live fill
  kalshi/                REST (Create Order V2 only), WebSocket, signing (RSA-PSS / Ed25519), wire parsing, rate limiter
  marketdata/            order books (snapshot+delta, gap -> resnapshot), CF RTI index tracker, recorder
  model/
    fairValue.ts         settlement-exact pricer: 60 s average, martingale drift, Student-t tails, Up/Down, ladders, brackets
    metaModel.ts         frozen, versioned residual model (MLP or gradient-boosted trees, deep ensemble) + go-live gates
    trees.ts             GBDT inference (missing values follow learned default directions)
    gatedExperts.ts      trend vs microstructure experts mixed by a gate on volatility change (take head, perps candidate)
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
deploy/                  systemd unit, activate/rollback/first-deploy scripts (docs/DEPLOY.md)
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
- a resting quote is due for its 10-second re-price (`STRATEGY_REPRICE_SEC`), or the quote the last decision saw has gone since (expired, filled or pulled), so a quote still wanted comes back without waiting for the next bar

Decisions are never closer than 10 seconds apart. Exits are checked every tick. Entry windows:
- 15-minute Up/Down: from 14 down to 5 minutes before close (`ENTRY_WINDOW_15M=840,300`).
- Hourly strikes: from 55 down to 10 minutes before close (`ENTRY_WINDOW_HOURLY=3300,600`), and only while the mid is between 10¢ and 90¢.

Entries stop well before the close so a position has time to reach its take-profit floor and run: in the final minute, open positions ride to settlement.

**Fresh quotes.** A stale resting bid is the one that gets picked off, so quotes are kept close to the current price:
- re-priced every 10 seconds (`STRATEGY_REPRICE_SEC`), moved when the price they should sit at changes by 1¢;
- pulled when the index moves more than 2 sigmas in 5 seconds (`STRATEGY_FAST_MOVE_SIGMAS=2`);
- gone from the exchange 20 seconds after they were placed (`STRATEGY_ORDER_TTL_SEC`, the dead-man switch if the bot stops). A quote still wanted is placed again when it expires.

Every placement and re-price is an order. The risk gateway allows `RISK_MAX_ORDERS_PER_MIN` (120) a minute, and new risk stops at 80% of that (96) so the rest is always there for exits. Server diagnostics with the P&L report show orders per minute by purpose and how often the limit refused one.
- **Why 120:** at the old 30 the limit was reached in busy minutes on Oct 20–22, refusing about 23,000 quote re-prices and some entries. Quotes then had to live 60 seconds, because re-placing unchanged ones would have spent the minute's budget.
- **Kalshi's limit:** 120 is a fifth of Kalshi's Basic-tier write budget. That budget is 100 tokens a second, and a create, amend or cancel costs 10, so 600 writes a minute (docs.kalshi.com, Rate Limits and Tiers). Creates plus their cancels stay well inside it.
- **The REST client's limiter** (`bot/kalshi/rateLimiter.ts`) holds every write to that budget anyway, so the bot waits for a token rather than meeting a 429.

**Entries and exits.**
- **Maker entries** bid at `floor(q_adj − e_min − buffer)`, with e_min = 3¢. The adverse-selection buffer is the measured move against the bot a minute after its maker fills (60-second markouts), clamped to 1.5–3¢ (`STRATEGY_MAKER_BUFFER_RANGE`; 2¢ until 30 maker fills exist). Fewer fills, but they start closer to break-even. The markouts it learns from (the last 2,000 fills of the last 7 days, of the same trading mode) are reloaded from `data/tca/tca.jsonl` at start, so a restart or a deploy does not send the buffer back to its default.
- **Minimum quote size (`STRATEGY_MIN_QUOTE_CONTRACTS`, default 3).** A maker quote that sizing wants is at least 3 contracts, as far as the per-order cap and the risk left under the window and total caps and in free cash allow (never smaller than sizing asked for, and never a quote sizing didn't want). Kalshi rounds each order's fee up to the cent, so selling a 0.4-contract position costs about 2.5¢ a contract against 2¢ for 3 contracts.
- **Taker entries** need at least 5¢ of net edge after the taker fee.
- **Take-profit: winners run, with 10% locked in (`PROFIT_TARGET_PCT` 0.10, `PROFIT_TARGET_CENTS` 2, `PROFIT_GIVE_BACK` 0.33).** The floor is 10% of what a contract cost (its price plus the entry fee) and at least 2¢ a contract, counted net of every fee: those paid on the entry, plus the exit's taker fee. Once selling at the touch would bank the floor, the position is armed and keeps running while the price rises. The bot remembers the best price the held side could have been sold at since the position was opened or added to. It sells at the touch when the gain falls back by a third of its best, or into the last tick above the floor, whatever the model thinks the contract is worth, and never below the floor, so a profit sale is never a loss.
  - Example: bought at 40¢ (floor +4¢). It rises to a 60¢ bid (+18.3¢ after the 1.7¢ exit fee) and is sold at 53¢ (+11.2¢) on the way back down. A run that only reaches +5¢ is sold at about +4¢ when it turns.
  - A price that jumps straight through the floor between two one-second checks is not sold below it. The model exit has the position from there, and if the price climbs back above the floor it is sold at once.
  - With the exit-in-profit curve's default cross mode (`SINUOUS_EXIT=cross`, paper and live) nothing waits: the curve can sell earlier, at the bid, on a confirmed roll-over. In gate mode (`SINUOUS_EXIT=gate`) gains between the last tick above the floor and two-thirds of the best wait for the curve, which picks the moment (a spike or a roll-over); the last tick above the floor never waits.
  - `PROFIT_GIVE_BACK=0` sells as soon as the floor is reached, the Oct 22 afternoon behaviour, which banked gains too small. Both floor settings at 0 turn the take-profit off: before Oct 22 a winner was only sold when the market paid more than the model's own value, so a contract the model still liked rode to settlement however far it was in profit.
  - In the final minute, and while a hunt's trailing stop runs a winner, the take-profit does not apply. Stop-loss exits (the model exit cutting a loser, the hunt's trailing stop, tennis stops) are unchanged and can still sell at a loss.
  - **Benched when it costs money against holding (`TAKE_PROFIT_BENCH`, on; the owner's choice on Oct 24; `bot/strategy/takeProfitBench.ts`).** The take-profit is on the same scoreboard and bench as the exit curve's cross. On Oct 23-24 it sold about 4,700 contracts at +5¢ to +8¢ each that settlement paid more for: $230 less than holding them, $205 of it on Oct 24. Each crypto take-profit sale that fills is remembered with its net price (the side's price less the sale's fee). When the market settles, its sales are scored together as one result: what they got minus what holding to settlement paid (1 if the side held won, else 0), times the contracts. It is benched at a net cost of `PROBATION_MAX_LOSS_USD` ($25), or once it is losing beyond luck (t ≤ −`SINUOUS_BENCH_T`, 2) after `SINUOUS_BENCH_MIN_EXITS` (30) scored markets. Benched, it sells nothing: winners ride to the model exit, the ratchet stop or settlement, until the dashboard's Reset (`POST /api/take-profit/reset`). Paper and live alike; each book keeps its own scoreboard (`take-profit-bench.json` in `DATA_DIR` and `DATA_DIR/live`), starting empty. `TAKE_PROFIT_BENCH=false` keeps the scoreboard but never benches (the status shows the bench it would have called). The dashboard's Take-profit bench row and `takeProfitBench` in `/api/status` show it.
- **Fees.** Kalshi's quoted prices exclude fees. The taker fee is 0.07 × C × P × (1 − P), the maker fee 0.0175 × C × P × (1 − P) on series that charge one, and each order's fee is rounded up so the balance lands on the account's grid (a hundredth of a cent for direct members, a cent through an FCM). The bot prices every entry and exit net of them (`bot/fees.ts`); Kalshi's own `fee_cost` on each fill is booked when it is reported.
- **Kalshi's fee schedule, checked instead of guessed (the owner's request on Oct 23; `bot/kalshi/feeSchedule.ts`).** The bot knows each series' fees from three sources, checked against each other:
  - **The published schedule** (`KALSHI_FEE_SCHEDULE_URL`, kalshi.com/docs/kalshi-fee-schedule.pdf), read 30 s after start and every `KALSHI_FEE_SCHEDULE_HOURS` (6). The bot reads the PDF itself: the taker and maker formulas (their rates are what the bot computes with), the rounding rule, the effective date, the General Trading Fees Table (the bot's formula must reproduce every row, or it alerts), and the Non-Standard Fees table (each listed series' maker and taker multipliers; ATP and WTA matches pay a maker fee, unlisted series such as the crypto ones pay the general taker fee and no maker fee). A failed read keeps the last good one (kept in `data/fee_schedule.json`). kalshi.com answers the server's own download with its bot check (HTTP 429, `x-vercel-mitigated: challenge`), so until a read of its own succeeds the bot uses the copy built into the release (`bot/kalshi/feeScheduleSnapshot.json`: the schedule effective July 7, 2026, read from the PDF; whichever was read later wins). When Kalshi publishes a new schedule, save the PDF from a browser and run `npx tsx scripts/feeScheduleSnapshot.ts <pdf>` (it refuses a PDF whose formulas and fee table it cannot read).
  - **The API**, per series (`fee_type`, `fee_multiplier`, hourly), with scheduled series changes and per-event overrides (`GET /events/fee_changes`), each applied at its time. The fee types are the schedule's tables: `quadratic` (no maker fee), `quadratic_with_maker_fees` (maker multiplier M), `quadratic_with_combo_maker_fees` (twice that). A series whose type is not one of those (`flat` names a table the current schedule no longer has) is unverified: no new entries there, while exits still go out, priced as if a maker fee applied. Where the API and the published table disagree, the higher fee is used and an alert says so.
  - **Every live fill**: the fee Kalshi charged against the fee the schedule predicts (exact, lower by whole grid steps when Kalshi's fee accumulator refunds earlier rounding, or a mismatch, which is alerted and written to the audit log as `fee_check`). The same check learns the account's rounding grid from the fees Kalshi charges ($0.0001 or $0.01) after three fills that tell them apart, and prices with it from then on; `KALSHI_BALANCE_PRECISION` is only the starting point.
  - The dashboard's Kalshi fees row, `/api/status` → `feeSchedule`, and the learning report show the schedule read, the verified series, the grid and the fill check.
- **Exits never meet the bot's own quotes.** An immediate exit that would trade against one of the bot's own resting orders pulls that order first. Otherwise Kalshi's self-trade prevention cancels the exit instead, every tick.
- **Model exit.** Sell at the bid only when the bid minus the taker fee exceeds q_adj + 1¢.
- **`EXIT_POLICY`:**
  - `confluence_ratchet` (the default) sells for profit with the model exit, and lets a winner run on the order-book ratchet (below) while confluence agrees.
  - `fair_value` is the model exit alone.
  - `take_profit` (Mode B) rests a maker take-profit at entry + 8¢. It never offers below what the model thinks the position is worth.
  - `hold` (Mode A) rides every contract to settlement: no exit fee, and no selling for profit.

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
  - The **hard floor is $10** (`MIN_TRADABLE_BANKROLL_USD`): a $20 account keeps trading after a $2 loss and stops only below $10. `PAPER_BANKROLL_USD` defaults to $100 (raising it later tops up the existing paper account by the difference).
  - The paper pool exists only in paper mode. In live mode the bot shows and trades only the Kalshi cash pool:
    - its orders, positions, vault, break-even, balance history, perps trades and Kalshi check live in `DATA_DIR/live`, apart from the paper books;
    - a perps setting of `paper` is off in live.
    - Switching back to paper finds the paper books as they were.
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
- The default model is a residual **MLP with a hidden layer** (8 or 16 units, chosen by the 1-SE rule). `--families mlp,gbdt` also compares residual gradient-boosted trees whose init score is the fair-value log-odds, and `--hidden 0` adds the no-hidden-layer (logistic) variant. The trees are written in TypeScript (`research/gbdt.ts` and `bot/model/trees.ts`), so there is no ONNX export step and no parity gap.
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
  - the 4-hour change in the funding estimate (leverage demand building or unwinding)
  - the 1-hour change in open interest, and its acceleration (last hour vs the hour before)
  - taker order-flow imbalance over 1 and 4 hours, from the Coinbase trade feed (docs/TA_NETWORK.md)
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
    - the liquidation cap (`bot/risk/liquidation.ts`): `(1 − PERP_LIQ_BUFFER) ÷ (stop distance + maintenance rate)`, reduced by what the other open positions tie up, so the liquidation sits at least 25% beyond the stop (the setup trader uses the same cap and also cuts open trades when the exchange's liquidation estimate drifts inside it; docs/SETUPS.md);
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
  - `paper` simulates against live perp quotes with a `PERP_PAPER_BALANCE_USD` ($100) margin account.
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

## Automated training and hot-swapping

The bot retrains itself. By default (`AUTO_TRAIN=remote`) training runs on GitHub Actions (`.github/workflows/train.yml`, daily at 07:17 UTC and on demand from the Actions tab): the job copies the last 45 days of recordings, the history and the models directory off the server, trains on the runner's own CPUs, and copies the models back, where the bot hot-swaps them (the Lightsail CPU cannot sustain trading plus training). With `AUTO_TRAIN=background` it runs `research/pipeline.ts` beside trading as a lowest-priority child process: a new run starts whenever one is due (`AUTO_TRAIN_EVERY_HOURS`, 6, after the last completed run; at once after a restart cut one short, resuming from the per-step checkpoints), `AUTO_TRAIN_START_DELAY_MIN` (10) after the bot starts. It is frozen while the machine is under pressure and resumed after a calm minute: the trading loop lagging (p99 over `AUTO_TRAIN_MAX_LAG_MS`, 500), available memory under `AUTO_TRAIN_MIN_FREE_MB` (300), or the host throttling the burstable CPU (steal over `AUTO_TRAIN_MAX_STEAL`, 15%). The Friday-midnight (New York) weekend run still holds new entries until it finishes; a run still going at midnight is followed by it. `AUTO_TRAIN=windows` keeps the old schedule (session-edge windows only), `daily` runs once at `AUTO_TRAIN_HOUR_UTC`. The pipeline runs in this order:
1. Tests and trains the crypto and perps SNNs (the tennis SNN learns live).
2. Backfills each network's outputs without leakage.
3. Trains the tree volatility forecast.
4. Builds the dataset.
5. Trains the MLP on the crypto network's outputs (MLP vs trees for the take/skip head), then backtests it.
6. Fits the volatility profile.
7. Trains the perps model and the tennis model (each: its own network's outputs; MLP/ridge vs trees).
8. Trains the fill / adverse-selection model once enough maker quotes are logged.

Promoted models land in `data/models/`, and the running bot hot-swaps them without a restart.

A new network retrains only the model that reads it, including when you swap one in by hand. The blend history is saved across restarts and cleared when the MLP changes.

**Tree models.** Gradient-boosted trees (`research/gbdt.ts`, logistic or squared loss, missing values routed natively) fill three gaps:
- **Vol forecast** (`bot/model/volModel.ts`): predicts how far realised volatility over a contract's remaining life will differ from the backward-looking EWMA, and multiplies fair value's sigma by it (clamped to 0.5–2×). Applied only after its held-out QLIKE check passes (`VOL_MODEL`). Until then fair value's sigma is multiplied by `VOL_FALLBACK_MULT` (1.15; 1 = off): the 5-minute EWMA lags, and on the live Oct 20–22 log loss 1.15 scored best overall (1.3 helped on Oct 21–22 but hurt Oct 20). The backtester does the same. `guards.volFallbackMult` in `/api/status` shows it while it applies.
- **Fill / adverse-selection model** (`bot/tca/fillModel.ts`): from the bot's own logged maker quotes, P(fill within 60 s) and the expected markout given a fill. Per maker entry the bot then quotes, crosses or skips by expected value. It brings itself online: it collects quotes from day one, trains once 500 quotes / 100 fills exist, and is promoted and used only after it beats the base rate on held-out days.
- **Candidates** for the take/skip head, the perps model and the tennis model, compared with the existing MLP / ridge on the same validation data; the better one is kept.

**Gated experts** (`bot/model/gatedExperts.ts`, the 4th-generation spec's 6.3): one more candidate for the take/skip head and the perps model. A trend expert (momentum, the TA library, the TA network) and a microstructure expert (order-flow imbalance, microprice drift, book depth, VPIN, trade bursts; for perps the premium, funding and open-interest changes and taker imbalance) are mixed by a smooth weight

    gamma(t) = sigmoid(g0 + g . drivers)      output = base + (1 - gamma) x trend + gamma x micro

whose drivers are how fast volatility is changing (`vol_ratio_15m_4h`, `ewma_vol_ratio`) and, for the take head, the SNN governor level. When volatility turns abruptly the weight moves from the lagging trend readings to the real-time order flow. Both experts and the gate are fitted jointly (full-batch Adam, L2, early stopping). It lives here, in the recordings-trained decision layer, and not in the 9-year TA network, because the microstructure inputs exist only in the recordings. It is compared with the others on the same validation data and is used only when it wins there and then passes the held-out check (take head: log loss below the fair value alone; perps: the walk-forward IC, P&L and deflated-Sharpe gates, with each candidate counted as a trial).

`docs/AUTOMATION.md` is the plain-language guide. It covers what runs by itself, what you still do by hand, every setting, and how to roll back.

**Training on your own computer** (`research/laptopTrain.ts`, [docs/LAPTOP_TRAINING.md](docs/LAPTOP_TRAINING.md)): the same pipeline with bigger budgets, in rounds until the bot stops improving or reaches the target (or for as many hours as you give it). Windows: download `KalshiTrainer-windows.zip` from the *Laptop trainer (Windows)* release and double-click `Train.cmd`; elsewhere `npm run train:laptop -- --host <ip> --key <pem>`. It copies the bot's data over SSH (credentials never leave the server) and downloads years of history and a year of Kalshi's settled contracts. Then it trains in rounds:

- each network's tournaments run on weeks of history it has never trained on (the history ledger, `research/historyLedger.ts`);
- a challenger must beat the model in use on held-out weeks before it replaces it;
- the whole bot is scored on days nothing was trained or tuned on, in % of a $200 pool (`research/readiness.ts`).

After every round that improves a model, it sends the models back for the bot to hot-swap. `trainer-data/GUIDE.txt` says how long to train before live trading and what good scores look like.

It keeps the computer usable while it trains (`research/trainerResources.ts`):
- it sizes its threads and memory to the machine and an intensity (Gentle, Balanced or Full speed), always leaving a quarter of the memory free;
- it runs below normal priority;
- it backs off while you use the computer or memory runs short;
- it paces the GPU so the display never waits behind it;
- it logs what it used, so a freeze can be traced.

**Conditioning mode** (the trainer's second button, greyed out until a fresh normal run; pressing it anyway asks "are you sure?"): instances of the whole bot with different trading settings play days no network trained on. The tiers are $1000, $500 and $200, then $100 on calm, trending and two kinds of volatile days, with 3-, 2- and 1-day windows each. A window passes only if at least $100 of profit is held at its end and P&L never falls 35% below the starting cash. An instance that passes all 21 windows and beats the live settings becomes the Elite Champion. The bot then restarts on its settings, and the dashboard can roll it back (`research/conditioning.ts`, docs/AUTOMATION.md §10).

**Strategy playbook** (`bot/strategy/playbook.ts`, `research/playbook.ts`): each coin's regime is its character crossed with the Hilbert trend/cycle mode, confirmed over 2 hours. Per regime, the bot weights its two strategy families, Kalshi contracts and perps setups, by what each earned there on replay days. The weights are switched on only after beating the static bot on later days (docs/AUTOMATION.md §11).

## Historical data and the TA network (bot/ta/taNet.ts)

- **History store** (`research/history`, `data/history`):
  - Binance Vision bulk download (checksummed) for every crypto asset Kalshi lists, in its binary series and its perps.
  - Coinbase backfill.
  - An importer for your own CSVs (Bittrex, CryptoDataDownload, Yahoo, anything with OHLC columns) that converts every timestamp to bar-open UTC and refuses files whose clock is a bar off.
  - Sources are spliced by priority, never mixed bar by bar.
- **TA network:** a five-branch neural network (fractal blocks over 15m and hourly bars, hourly GRU over the TA library, daily attention, and a market-context branch: BTC, market breadth, Binance's BTC dominance index, the BTC.D × USDT.D quadrant, TA on the daily dominance charts). It forecasts P(up) over 1h and 4h, plus the next 4 hours' volatility.
- **Training and validation:** chosen by a tournament of three over years of pooled hourly history. It must pass an untouched holdout, a deflated-Sharpe and per-regime hurdle, and a live forward test. Every live call is graded (`tanet_skill_*`).
- **Who uses it:** its forecasts are features for the MLP, the perps model and the vol forecast, each of which keeps them only if its own validation improves.
- **The Librarian** (`bot/ta/librarian.ts`, `research/librarian.ts`): oracle-trained heads on the same TA row.
  - A strategy head gives soft weights on which strategy family (trend, mean-revert, breakout, flat) would have paid over the next day after fees.
  - A transition head gives P(the coin's regime changes within 72 hours).
  - Both are trained walk-forward and graded against persistence (the current regime's playbook, the last winner, the days-since hazard). Each speaks to the decision models only if it beat persistence out of sample.
  - The setup scorer reads both as an optional input group.
- **The cross-asset graph network** (`bot/ta/crossGraph.ts`, `research/trainCrossGraph.ts`, `python/xgraph`): the coins as a graph whose edges are their return correlations.
  - It learns from each coin's return relative to the basket, and forecasts which coins outrun the others over the next 4 and 24 hours.
  - It trains walk-forward on PyTorch, with a TypeScript mirror for live use.
  - It is graded against momentum / reversal and a long-short book after costs.
- **Cross-coin lead-lag** (`bot/ta/crossLead.ts`, `research/crossLead.ts`): when BTC or ETH moves, does another coin make up the part of the move it has not made yet over the next 1–60 minutes?
  - It is measured walk-forward on the 1-minute history, and a pair is used only if it was predictive out of sample.
  - The Kalshi models get it as features. The setup scorer gets it as an optional input group, and as an exit that is switched on only if it raises the trades' net R out of sample.

`docs/TA_NETWORK.md` covers the commands, the training, and the first real results.

## Fractal Alignment Engine and waterfall mode (bot/macro)

The engine places the 2018-to-now BTC dominance cycle on its 2016–2017 parent with time-warped alignment, point in time. It reports the parent date matched to now, the phase, time dilation, fit, and the projected BTC.D path and next waterfall. Its readings are setup-model inputs, kept only if they help.

Waterfall mode can be armed on the dashboard only after BTC.D first closes at or below 55%:
- **Armed:** tennis pauses and Kalshi binaries are held to 12.5% of the bank.
- **Triggered** (gate + fractal + a USDT.D breakdown or SHIB volume velocity): Kalshi binaries pause too, and the perps lanes lean into alt longs.

`npm run research:fractal` prints the alignment and scores the projection walk-forward. The full guide is [`docs/FRACTAL.md`](docs/FRACTAL.md).

## Setup trader: fast and slow lanes (bot/setups)

The perps trader trades chart setups the way a discretionary trader does. The full guide is [`docs/SETUPS.md`](docs/SETUPS.md).

- **Fast lane:** 15m and 1h setups held for hours. Fade: RSI overbought, the band tagged, momentum fading, sellers stepping in. Pullback: a dip in a higher-timeframe trend.
- **Slow lane:** daily trend setups held for days to weeks.
- **Scoring:** a walk-forward model over the whole TA library on 4 timeframes, BTC, and a DST-correct market clock (NYSE open and close, holidays, the 11:00 ET hour, the last 30 minutes, the London and Tokyo opens, the CME break) decides which setups to take and how big.
- **Queues:** candidates wait in their lane's queue and are re-checked on fresh data right before entry.
- **Trade management:** half off at the first target, stop to break-even, the rest trailed.
- **Proposals, off until proven by their sweeps:**
  - Scale-out exits: partial take-profits at R multiples, the rest trailed (`SETUP_SCALE_OUT`, sweep `setups-scale`).
  - The spot pullback: an RSI dip into a fair value gap, then the 21 EMA reclaimed (`SETUP_SPOT_PB`, sweep `setups-spotpb`). It runs only for coins where the weekly `lead_lag` study (`research/leadLag.ts`) finds that Coinbase spot leads the Kalshi perp by more than the perp feed's polling, by enough to pay for a trade.
- **Commands:** `npm run research:setups` trains and backtests. `PERP_STRATEGY=setups` (the default) runs it live, on paper by default (`PERP_TRADING=paper`).

## Evolutionary initialisation and portfolio Kelly

- **Every network starts as three:** the TA network and the crypto, perps and tennis SNNs each begin as three identical networks with slightly different knobs. They fight for fitness walk-forward (Sortino − drawdown − costs). The elite survives, the worst copies it, and the middle and the copy mutate. The elite becomes the network.
- **Hurdles:** independent-interaction counts per regime, the deflated Sharpe ratio counting every mutation as a trial, an untouched holdout, and a live forward test.
- **Portfolio Kelly:** a numerical Kelly solver caps new crypto orders, treating contracts on the same index and close as one bet. It can only shrink an order, never enlarge it. Perp size shrinks when capital is locked in binaries.
- `docs/EVOLUTION.md` maps every part of the protocol to the code.

## Cortex-like SNN (bot/snn)

This is a multi-level spiking network built from *From Flat SNN to Cortex-Like Predictor*. Every equation from that document is implemented in its corrected form in `bot/snn/formulas.ts`. Each one is checked at 1e-5 against an independent Python reference. `docs/SNN.md` maps each formula to its code and test.

The network has these levels:
- L0 encoders;
- L1 Poirazi dendritic neurons with AMPA/NMDA synapse classes and an NMDA learning gate;
- L2/3 ALIF/LIF populations with lateral inhibition and error units;
- a Rao–Ballard predictive-coding pathway;
- an astrocyte-like governor;
- an L5 readout trained only by settlement labels through per-contract tags.

It runs on a 1 s market clock in a worker thread. Readouts have a 200 ms deadline.

**Three isolated networks.** One per contract type: crypto (15m/1h, scored on settled contracts), perps (1h/4h, graded on its direction calls) and tennis (per live match). Each has its own worker, parameters, health, checkpoints and model file. They never read each other, and each decision model reads only its own network (`SNN_CROSS_FEED=false`). Every call carries its network's confidence from the same snapshot-and-settlement grading the MLP gets: direction skill, contract calibration, surprise and governor level.

**Division of labour: the SNN informs, the MLP decides.**
- **What the SNN reads:** the TA library on the Coinbase spot USD pairs, the perps, the Kalshi books, and for tennis the four confluence signals plus Live Tennis API scores.
- **What it does with them:**
  - Learns the direction of each market around the clock (15m / 1h / 4h; 5 minutes for tennis) from realised moves, whether or not anything trades.
  - Logs its calls with the data stream.
- **What the models do with those calls:**
  - The MLP uses them as inputs for its fair value and for its take/skip head, which decides whether each trade is worth taking.
  - The perps model uses the perps network's 1h/4h calls and skill.
  - The tennis model uses the tennis network's calls for match fair values.

`SNN_MODE=shadow` is the default: the network scores and labels every scanned contract but never changes what is traded. In `SNN_MODE=blend`, p_final = (1 − α·c)·p_model + α·c·p_snn. α starts at 0, is capped at 0.25, and is earned only when the out-of-sample Brier improvement is significant.

The network is staged S0–S6 (`SNN_STAGE`). Each stage must pass `research:snn-ablation`, which requires all of the following:
- an event-clustered paired Brier CI below 0;
- a calibration slope of 0.9–1.1;
- correlation with p_model below 0.7;
- a blended Brier gain;
- latency and health within band;
- fee-aware paper P&L not worse.

A health monitor freezes learning and drops to shadow on any breach. Checkpoints are versioned with rollback.

## Profit vault and pocket

These are rules for how much of the Kalshi cash the bot treats as its own to trade (`bot/vault/`). Nothing moves on the exchange; reserved money is simply left out of the tradable bankroll, which drives sizing and risk limits.

**Paper trades its whole balance** (`VAULT_IN_PAPER=false`, the default). Before the realized-profit rule (below) the vault kept half of every win and none of the losses, so a paper book with many small wins and a net loss ended up with almost everything vaulted: on Oct 23 it held $343 of the $360 paper pool, the bot sized as if it had $17, and orders were a fifth of a contract. The vault still keeps its books in paper; `VAULT_IN_PAPER=true` keeps the reserve out of the paper bankroll as in live. Live always does.

**Paper order size (`PAPER_ORDER_FRAC`, 10% of the bankroll).** In paper, each crypto entry and maker quote that sizing wants to take buys about 10% of the bankroll (cash plus what open positions cost): $12 on a $120 account, $20 on $200. It replaces the tier fraction, the break-even scale, the session size factor, optimal f, the portfolio Kelly cap and conviction boosts in paper. The risk caps widen to fit it: one order, three in markets closing together, ten in all (30% of the account in markets closing together and all of it in total at 10%, or the tier's own caps where those are larger). From Oct 23 paper bought a flat $10 an order (`PAPER_ORDER_USD`) whatever the account held. On a $120 account a single losing 15-minute position cost $10-$21 at settlement, and the pool ran dry more than once. Since Oct 24 orders are a share of the account, a minimum of 10% (the owner's choice): they shrink as the account does and grow as it does. Nothing sizes a paper order above it (conviction boosts stay off in paper). `PAPER_ORDER_FRAC=0` goes back to the fixed `PAPER_ORDER_USD` ($10); both at 0 size paper exactly as live. Paper training trades (1 contract) and exploration entries keep their own size. Live never uses either.

**Accuracy gate (`ACCURACY_GATE`, paper).** The bot keeps a scorecard of who called recent results better: its own probability or the market's mid. For every crypto market it keeps one reading per time-to-close bucket (15-minute markets: 840-600, 600-450, 450-300 and 300-90 s before the close; hourly: 3300-2400, 2400-1500, 1500-600 and 600-90 s), scored when the market settles. In a bucket where, over the last `ACCURACY_GATE_WINDOW` (150) settled markets, the mid scored a lower log loss than the bot's probability (re-scored with a temperature fitted on the same markets, since the bot's odds have run too extreme), paper opens no new entries; exits are unaffected, and a bucket with fewer than `ACCURACY_GATE_MIN_MARKETS` (40) settled markets stays open. On the record of Oct 21-23 (deploy/decision_study.py section 8, walk-forward) the entry fills it would have left open lost $53 to settlement against $193 for all of them. Live keeps the scorecard (`accuracyGate` in `/api/status`) but never blocks on it.

**Paper fills.** A resting paper order fills only on trades Kalshi printed after it was placed: a trade at its price first eats the queue that was ahead of it, and a trade through its price fills it up to that trade's size (a 1-contract print cannot fill a 20-contract order).

**Live-equivalent P&L (paper; the owner's choice on Oct 23).** Paper keeps trading where live would not, so its models keep getting data, and reports what live would have made. Each paper order live would not have sent under its own rules is tagged at its first fill (`paper_live_block` in the audit log): a paper training or exploration trade, and, only with `LIVE_ALLOW_UNVALIDATED_MODEL=false`, an entry while the model has not passed validation and the Kalshi probation is benched (live's risk gateway then rejects it) or a ratchet stop live would not run (hunt mode not validated, probation benched). The P&L report's live-equivalent P&L counts a settled market's realized P&L in proportion to the entry contracts live would also have bought; ratchet stops are counted but cannot be replayed the way live would have exited. Paper also matches live where it was looser: live's stale-data limits, no trading a series before its fee schedule is verified, and the simulator rejects reduce-only on a resting order like Kalshi.

- **Realized profit only (the owner's rule, Oct 23).** "I don't want any vaulting from a negative account, vaulting profits only happens if those are realized gains. A negative total doesn't count." The vault keeps a running total of every settled market's realized P&L, wins and losses, after fees, and that total's high-water mark. Only the part of a win that lifts the total to a new high is new profit, and only new profit is vaulted or pocketed. While the total is below its high, a negative total included, wins go to winning back the losses and nothing is vaulted (each such win is logged as a `skip` event). So nothing is vaulted from an account that is down, nor on a day or session that is down. The total starts at the account's net P&L against break-even when that is negative (the loss has to be won back first), else at 0, and starts over at 0 when an exhausted paper pool is refilled. What the vault already held stays (vaulted money is permanent until withdrawn). The dashboard's vault card shows the total, its high and how much is left to win back.
- **Vault.** 50% of new profit (fee-inclusive, at settlement) is vaulted until $100 has been vaulted. Vaulting then pauses until the next market session opens, when the quota resets. `VAULT_QUOTA_RESET=us_open` resets it once per US-open day instead. The headline goal is **$100 per trading day** (US open to US open, `VAULT_DAILY_GOAL_USD`). Because the quota refills each session, a day can go over the goal, which is fine.
- **Pocket.** Only while the quota is met, 10% of new profit is pocketed. Pocketed money is released back to trading at the next US market open (09:30 ET, so Friday's pocket releases on Monday).
- **Graduation ramp (`VAULT_RAMP_START_USD`=20, `VAULT_RAMP_FULL_USD`=100).** A $20 account has to compound to reach the larger sizing tiers, and skimming half of every $2 win would keep it there. The vault and pocket shares are therefore scaled by a factor that is 0 at a $20 tradable high-water mark and 1 at $100, interpolated in log(bankroll) like the tiers (about 57% at $50). The factor reads the high-water mark, so an account that has graduated stays at the full rate. Skipped wins are logged as `skip` events. `VAULT_RAMP_FULL_USD=0` restores the full rules at any size.
- **Withdrawals.** They are detected by reconciling Kalshi's balance against the cash movements the bot's own trading explains. A discrepancy is booked only if it is stable across two checks with no settlement in flight. Withdrawals come out of the vault first, then the pocket, then trading cash. The dashboard's **Record Withdrawal** button books one manually, and the detector will not count it a second time.
- **Kalshi check** (`bot/recon/kalshiCheck.ts`, dashboard card, `/api/kalshi-check`). The bot's books against Kalshi's own records: every fill (side, count, price, fee), every settlement record (`GET /portfolio/settlements`: contracts held, payout, fees, and the market's net P&L when the position was never partly closed), and the cash balance. In live, a balance move is booked as a deposit / withdrawal only if Kalshi's transfer history (`/portfolio/deposits`, `/portfolio/withdrawals`) shows one; otherwise it is reported as an accounting mismatch. A UTC-day table puts the bot's fills, contracts, fees, settlements, payouts and cash change next to Kalshi's. In paper the exchange is the simulator, so the check only proves the plumbing.

## Running

```bash
npm ci
npm run check            # typecheck + tests
cp .env.example .env     # optional: DASHBOARD_PASSWORD=... for a login
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
  - nothing about the model: by default (`LIVE_ALLOW_UNVALIDATED_MODEL=true`, the owner's choice on Oct 23) the model's validation never blocks a live binary crypto order. Entries, exits and ratchet stops go out whether or not the model passed validation or its probation is benched; every other limit still applies. With `LIVE_ALLOW_UNVALIDATED_MODEL=false`, live entries wait for a validated `params/model.json` or an open probation (`VALIDATION_GATES=monitor`, below), and an exit always goes out
  - step by step, for both APIs: docs/DEPLOY.md, "Connecting the prediction and perps APIs"
  - **cash on the right exchange shard.** Kalshi runs each category on its own matching engine (shard 2: crypto and commodities; shard 3: tennis, baseball, basketball; shard 0: everything else) and checks an order's collateral on its market's shard only. Orders in the Kalshi app move cash between shards on their own; API orders do not. Move cash to the crypto shard (and the tennis shard, for tennis) at kalshi.com/account/exchange-indexes. The bot reads the cash per shard, refuses an order its shard cannot fund (saying where the cash is), warns when a shard it trades on is empty, and shows the split on the dashboard (Kalshi cash by shard).
  - **for tennis: the location attestation.** Kalshi refuses API orders on Sports, Elections and Entertainment markets while the account's location attestation is missing or expired (`api_key_region_expiration_ts` on GET /api_keys; it belongs to the account, not to an API key). The bot checks it every 30 minutes and pauses tennis while it is missing; a refusal pauses tennis only. Crypto contracts do not need it.

### Probation: unvalidated models trade, and their results decide (`VALIDATION_GATES`)

With `VALIDATION_GATES=monitor` (the default) every model that has not passed its validation trades as soon as it exists, on probation (`bot/risk/probation.ts`):
- **What opens:** the Kalshi MLP's go-live gates, the take/skip head, the fill model, hunt mode in live, the perps model's full size, the setup types the setup model has not proven (traded at the lane's own minimum score), the setup lanes' full size, the tennis model, and the evolved GP formulas in live.
- **What stays gated:** inputs to other models (the TA network's heads, the Librarian, the cross-asset graph and leads, the vol forecast's sigma multiplier). The models that read them were trained with those gates, so opening them only in live would feed those models numbers they never saw.
- **How it is judged:** each book (`kalshi`, `perps`, `setups`, `tennis`) counts its realized results: every settled Kalshi market, closed setup trade, closed perps position and settled tennis market. The book is benched, with an alert, when its net loss reaches its loss limit: `PROBATION_MAX_LOSS_USD` ($25), or `PROBATION_MAX_LOSS_PCT` (15%) of its account's break-even when that is smaller (the Kalshi pool for `kalshi` and `tennis`, the perps margin for `perps` and `setups`; 15% of a $41 account is $6.18, a $400 account keeps $25). The limits are applied again at every start, so a book already past them is benched then. It is also benched when after `PROBATION_MIN_TRADES` (20) results it is losing with t ≤ −`PROBATION_T` (−1), more than luck explains. Only the last `PROBATION_WINDOW` (200) results count.
- **Benched:** the book's unvalidated parts go back behind their gates; validated parts keep trading. A new model for the book (the trainer's next promotion) or `POST /api/probation/reset {book}` starts a fresh probation. A benched `kalshi` book does not stop live binary crypto orders while `LIVE_ALLOW_UNVALIDATED_MODEL=true` (the default): it turns off the unvalidated helpers (the take/skip head, the fill model, the GP formulas in live).
- **The dashboard** shows each book's results, net, t and state on the Probation row. Every other limit (daily loss stop, drawdown scaling, kill switch, exposure caps, the losing-streak scaler) applies as before.
- `VALIDATION_GATES=enforce` restores every gate.

### Component trials: the trained model, the rule book, the SNN and the TA network get a shot (`TRIALS`)

The owner, Oct 24: "Have the rule book, SNN, and TA NET contribute, give each a shot and let's see how well they perform. If they perform well in the test allow them to function for paper trading to further test them", then "The trained model as well" and "If the rule book has been trained via the windows trainer then let it trade in paper mode so we can test it that way". Before this, only the trained model (the meta-model) moved prices. The rule book had no rule that passed its walk-forward study. The SNN sat in shadow: its blend weight is earned on 200 settled events since the last meta-model swap, and the meta-model is retrained about daily. The TA network's unproven direction heads tilted prices at their graded weight (`bot/strategy/componentTrials.ts`):
- **The contributions.**
  - *Trained model:* the meta-model's price against the math fair value it refines.
  - *SNN:* the crypto network's probability for the contract blended into the meta-model's price at `TRIAL_SNN_ALPHA` (0.25, the blender's cap), without the blender's confidence factor. On the Oct 21-24 decisions the confidence factor cut the blend's gain: 0.25 x c saved 0.0014 of log loss a contract (p 0.09), 0.25 flat saved 0.0041 (p 0.02).
  - *TA network:* its 1 h / 4 h direction drift with every head counting fully, validated or not.
  - *Rule book:* its trial rows. These are the rules that held up on both periods of the walk-forward study without passing its multiple-testing bar: expectancy positive on discovery and confirmation, a confirmation hit rate of at least half, at least 20 confirmation trades. The Oct 23 study had 47 such rows, mostly 24-hour ones, out of 1,437. Each signal present counts at every horizon it has a row for, its confirmation hit rate read like a TA head (z = Phi^-1(hit rate), an expected move of z sqrt(tau / H) sigma sqrt(tau)), weighted by confirmation trades, as a tilt of the price.
- **The test.** At every scheduled evaluation inside a contract's entry window, traded or not, paper and live, the bot records the price with each contribution and without it. When the contract settles, each trial scores the log loss difference, averaged over the contract's snapshots and over one asset's contracts closing together (one settlement). A Diebold-Mariano test runs over the most recent `TRIAL_KEEP` (500) settlements in time order (Newey-West variance, as the model-health check uses).
- **The verdict.** After at least `TRIAL_MIN_WINDOWS` (100) settlements, a component whose prices are better at one-sided p <= `TRIAL_P` (0.05) goes **into paper's price** (on), and one that is worse at the same p comes **out** (off). The scores keep coming either way: a component can go off, then on again, with an alert and an audit record (`trial`) at every change.
- **While testing.** Paper prices as before: the trained model stays in until it tests significantly worse than the math alone, and the SNN and TA network wait for their verdict. The trials named in `TRIAL_PAPER_START` (default `rules`) trade in paper while they are tested. The rule book was trained by the training pipeline (the copy on the server was made on Oct 23 by the remote-training runner, which runs the same pipeline as the Windows trainer), so per the owner it trades in paper from the start; an 'off' verdict still takes it out.
- **Live never follows a trial**: live prices as it did before the trials (the trained model and today's TA tilt) until the owner decides otherwise.
- **Offline, at once.** `deploy/component_study.py` (run by Server diagnostics with `pnl=true`) does the same scoring for the trained model, the SNN and the TA tilt on the last 3 days of decision records. The meta-model's price comes from each record's `modelShift`, the SNN's probability from its `snn_bias`, and the TA tilt from the record's price minus the meta-model's. It scores against every scanned market's official result and also lists the rule book's trial rows. Oct 21-24 (740 settlements): Kalshi's own price beat every price the bot makes (the fair value by 0.037 of log loss a contract, the meta-model by 0.027, the bot's price by 0.024, all p < 0.01). The TA tilt saved 0.0054 against the meta-model alone (p 0.02; doubled, 0.0070 at p 0.04). The SNN at 0.25 flat saved 0.0041 (p 0.02).
- **Where to look.** The dashboard's Component trials row shows each trial's state, whether paper uses it, settlements, log loss saved and p. Each market's status carries `trials` (each contribution in probability points and the ones paper applies). `/api/status` → `guards.trials`.

### Exit-in-profit curve (`SINUOUS_EXIT`)

**One mode for paper and live (`SINUOUS_EXIT`, `cross` by default; the owner on Oct 23: "It can't just be paper mode. When I take it out of paper mode into live it needs to behave identical").** Before Oct 24 paper ran `SINUOUS_EXIT_PAPER` (cross) while live ran `SINUOUS_EXIT` (gate) with the probation's bench rule; now both run `SINUOUS_EXIT` with the same bench rule (`SINUOUS_BENCH_T`, `SINUOUS_BENCH_MIN_EXITS`), each book keeping its own scoreboard. `SINUOUS_EXIT_PAPER` is no longer read, and the deploy removes it from `bot.env` (a pinned `SINUOUS_EXIT=gate` or `rest`, the old defaults, becomes `cross`).

Every binary contract the bot holds (15-minute and hourly crypto, tennis) has its order book followed as a smooth curve from the moment the position opens (`bot/strategy/sinuousExit.ts`). In gate mode, when the bot's own exit logic wants to take a profit, the exit goes out only when the curve agrees too:
- **DEVIATION_SPIKE:** the live micro-price jumped well above the curve (a buying sweep in our favour to sell into), or
- **SINUOUS_CROSS:** the curve rolled over: it is below where its projection a few seconds ago said it would be, and still falling or flat.

Otherwise the profit exit waits for a later tick. How the curve is built, all in the price of the side held:
1. **Micro-price:** the top of the book, weighted by size: (bid size × ask + ask size × bid) / (bid size + ask size). A YES ask is 1 − the best NO bid.
2. **Logit:** ln(p / (1 − p)), so the 0–1 price range becomes unbounded and symmetric.
3. **Kalman filter:** tracks the curve's level and velocity without moving-average lag. Momentum decays like an Ornstein-Uhlenbeck process.
4. **Projection:** each tick projects a few seconds ahead with that decaying momentum.

The knobs are set by market and adjusted every tick:

| Market | R (book noise) | κ (momentum decay) | z (spike threshold) | Look-ahead |
|---|---|---|---|---|
| Crypto 15m | 0.015 | 0.35 | 1.65 | 3 s |
| Crypto hourly | 0.030 | 0.15 | 2.10 | 6 s |
| Tennis | 0.065 | 0.08 | 1.80 | 2 s |

- **Spread:** a wide spread raises R (×5 at 6¢), so book flicker does not read as momentum.
- **Crypto near the close:**
  - 60–180 s left: z × 0.75 near 50¢; κ × 0.2 above 85¢;
  - last minute: z falls toward 1.1 and κ doubles.
- **Tennis with a live score:**
  - break point or tiebreak: R halves and z is 1.6;
  - routine games: κ 0.35, z 1.4.

**What it gates:** take-profits sent to cross the book. That covers:
- the fair-value exit when it would sell at a profit;
- the hunt's early profit takes (confluence flipped, unsafe session);
- the tennis take-profit at the target;
- the late-match profit;
- the hunt's confluence-fade and time-limit exits.

**What never waits:**
- stops;
- the hunt's trailing stop and a gap through it;
- the tennis trailing stop once broken;
- cutting a loser, and the late-match salvage;
- any exit worth less than `SINUOUS_MIN_PROFIT_CENTS` (1.5¢) a contract after fees;
- resting take-profit quotes;
- the final minute's ride to settlement.

Nothing in the existing strategies changed: the engine filters their exit orders.

**The scoreboard (gate mode)** scores each held profit exit when the position finally exits: (exit price then − exit price when first held) × contracts, net of the exit fee; a settlement counts at $1 or $0. The gate is benched, with an alert, under the probation rules: a net cost of `PROBATION_MAX_LOSS_USD`, or after `PROBATION_MIN_TRADES` held exits a negative net with t ≤ −`PROBATION_T`. Benched, profit exits go out without waiting until a reset (the Reset button on the Telemetry tab's Exit curve row, or `POST /api/curve-exit/reset`).

**Cross mode (the default, paper and live; paper's since the evening of Oct 23, live's since Oct 24).** The owner: "The resting at peak should go." The curve watches every held position and sells it at the bid on a confirmed cross (below); nothing rests at the swing top and nothing is held, so the ratchet stop, the take-profit and the model exit run exactly as they do without the curve. On Oct 23 the resting sells made +5.2¢ a contract but −$113 against holding to settlement: the swing-top estimate sat a few cents above the market and filled on ordinary upticks, selling winners.

**Rest mode (`SINUOUS_EXIT=rest`; paper's default on Oct 23 until the evening).** The owner wanted the curve to give a place to exit rather than hold exits. In rest mode nothing is held: while a position is open, its sell rests at the curve's estimate of where the current swing tops out — the level the curve's momentum carries it to before it decays (x + max(0, v)/κ in logit), plus `SINUOUS_REST_BAND_SIGMAS` (0.5) of the book's noise — never below the take-profit floor and always a tick above the bid. It replaces the opposite-side maker quote, is sized to the position exactly, and is re-priced with the quotes (at each scheduled evaluation, about every 10 seconds while orders rest) when the target moves a cent. It is an exit order (post-only, good till canceled; Kalshi accepts reduce-only on immediate-or-cancel orders only), so the risk gateway checks it as an exit as long as it sells no more than is held. Stops, the take-profit give-back and the model exit still cross the book at once, and pull the resting sell first. No resting sell while a hunt runs a winner. A resting sell pays no fee on these markets. The P&L report lists the resting sells' fills (`exit curve (resting sell)`).

**The cross's sell signal is off by default (`SINUOUS_CROSS=false`, paper and live alike) until a version beats the bot's other exits on the exit study's replays.** On Oct 23 (16:15-00:15 UTC, 250 positions) every turn-based rule lost against them: the trailing take-profit (+$24.44 against holding), the model exit (+$65.13) and the ratchet stop (+$17.54) sold well, while the book cross lost $28.61 against holding on its 15 fills (benched by its own rule at 21:15) and, replayed against what those contracts actually got, the book cross lost $5.32, the projected-peak watch $5.63-$8.63 and the live line $3.31-$4.25 at every look-ahead and x tried (it fired on only 2-9 positions). After most of those sales the price rose again (negative markouts): a short-term turn in these contracts did not pay for the spread and the taker fee. The Oct 24 wiggle band (below) did not change that over 16 hours (10:00 Oct 23 to 02:00 Oct 24, 564 positions): its 2 sd rule broke 14 times an hour while a position was held, but the profit floor and the close held most of those, it sold on only 8 positions and lost $3.51 against what they actually got (-$0.10 a contract; 50% of them better). Its neighbours lost too (k 1.5 -$43.32 on 15, a 10 s look-ahead -$33.93 on 12, no profit floor -$66.00 on 100, or -$30.01 on the 78 closed by today's exits); only k 3 (+$0.31 on 1 position) and a 30 s look-ahead (+$0.18 on 5) came out ahead, on too few positions to count. The curves, the live line, its band and its heads-up run either way; `SINUOUS_CROSS=true` turns the sell signal on, and the depth monitor's notes say when the live line broke while it was off.

**The live-line cross (`SINUOUS_CROSS_SOURCE=line`, the default; the owner's description on Oct 23: "the curve we're generating is meant to attempt to predict the live window of 15 minute and 1 hour crypto price prediction contracts ... give a heads up on a peak or a bottom. And then if the actual line from Kalshi crosses it by more than x amount then that would trigger a sell signal").** The live line is the coin's settlement index on Kalshi's feed, the line the Kalshi app draws against the contract's target, one point a second (`bot/strategy/liveLine.ts`). A contract's price is that line's distance to the target over the volatility left, plus order-book noise (1-cent ticks, the spread, quotes coming and going), so this cross follows the line itself:
- **The curve.** One per coin, shared by its contracts: the same filter as the book curve (level and decaying momentum, κ 0.05 a second for 15-minute contracts, 0.02 for hourly) on the log of the index, its noise scaled to the coin's per-second volatility so one setting fits every coin and every hour. It projects `LIVE_LINE_AHEAD_SEC` (15) seconds ahead for 15-minute contracts and three times that for hourly ones.
- **The wiggle band (the owner, Oct 24: "look back from the moment of the contract start to gain the range of volatile wiggles with which it will use for its x for 2 seconds amount over its normal wiggles ... almost like bollinger bands for the highs and lows of the wiggles").** A wiggle is the line minus the projection made look-ahead seconds ago for that second. The band is the wiggles' mean ± `LIVE_LINE_BAND_K` (2) standard deviations over every second since the contract's window opened (at most its 15 or 60 minutes before the close), the second being tested left out, once the window has `LIVE_LINE_BAND_MIN_SEC` (60) seconds of them; its sd never drops below a tenth of the line's noise over the look-ahead (a frozen feed would make it zero). Like Bollinger bands, a 2 sd band is touched by ordinary wiggles: a random walk is outside it for two seconds or more about 17 times an hour (`tests/liveLine.test.ts`).
- **The sell signal.** For the side held (up = the side gains: YES on an up or above contract, NO on it the other way), the line is outside the band against the side (under it for an up side, over it for a down side) for `LIVE_LINE_CONFIRM_SEC` (2) seconds in a row, and the sale clears the take-profit floor net of every fee. Sold at the bid. Not while a hunt runs a winner, not when another exit already crosses the book, and not in the last `SINUOUS_REST_STAND_DOWN_SEC` (120) seconds. Until Oct 24, x was the line's noise model instead (`LIVE_LINE_X_SIGMAS` 2 of sigma x sqrt(look-ahead); no longer read).
- **The heads-up.** While the line still moves the side's way but its momentum is down to half its best since the move began, the depth monitor's LINE badge shows FADING and where the momentum tops out (its tooltip shows the band). Nothing is sold on it: a predicted top is touched by ordinary noise (the resting sell at the predicted peak lost $113 against holding on Oct 23); the break is the signal.
- 15-minute and hourly crypto only: tennis has no live line.
- **Checked on the record.** The exit study (`deploy/cross_study.py`, run by Server diagnostics with `pnl=true`) replays the live-line band rule (k 1.5-3, look-aheads 10-30 s, with and without the profit floor), the Oct 23 noise-model rule, the book cross and the projected-peak watch a second at a time on every position of the last 8 hours, against what those contracts actually got from the bot's other exits and against holding to settlement, with markouts after each sale and how often each live-line rule broke while a position was held. Its curve, band and fee are the bot's own, kept identical by `tests/crossStudy.test.ts`.

**The book cross (`SINUOUS_CROSS_SOURCE=book`; the owner's option #1 after the Oct 23 exit research, the cross until Oct 24).** Once the curve has rolled over, the position is sold at the bid at once when (1) the curve is below the projection it made look-ahead seconds ago by at least `SINUOUS_CROSS_FEE_MARGIN` (0.5) of the taker fee a contract, with its velocity at or below zero (a wiggle smaller than the fee does not count); (2) the coin's price has turned against the side held over the fast-move window, by at least a quarter of that window's standard deviation (the contract follows spot: a book that dips while spot does not is not a reversal); and (3) the sale clears the take-profit floor net of every fee. Not while a hunt runs a winner, and not when another exit already crosses the book. No resting sell and no cross in the last `SINUOUS_REST_STAND_DOWN_SEC` (120) seconds: a binary's swings grow as the close nears (12-16c for a 1-sigma 10-second move at the money in the last two minutes) and the curve cannot keep up; the take-profit and the model exit carry on. The resting sell is also pulled during a fast index move: a resting sell is lifted exactly when the contract is suddenly worth more. Each cross exit's fills are scored against holding to settlement ((net exit price - payout) x contracts) when its market settles: a cross whose order did not fill sold nothing and is not scored (before Oct 24 the cross was scored when it was called, so an unfilled one counted as a sale; both books' scoreboards started over once when that was fixed). The cross is benched when those scores lose beyond luck at t ≤ −`SINUOUS_BENCH_T` (2) after `SINUOUS_BENCH_MIN_EXITS` (30) scored exits, or cost `PROBATION_MAX_LOSS_USD` (benched, the cross stops until a reset; in rest mode the resting sells go on). `SINUOUS_CROSS=false` turns the cross off. The P&L report lists cross fills (`exit curve (cross)`) and, for every exit kind, what it made against holding those contracts to settlement after its fee. Research behind it: the exit research doc (selling audit, paper vs live, crossing exits on binary contracts).

In gate mode the same bench rule applies to held exits (`SINUOUS_BENCH_T`, `SINUOUS_BENCH_MIN_EXITS`; the paper-only names `SINUOUS_PAPER_BENCH_*` from before Oct 24 are still read). The paper gate scoreboard was benched at −$0.57 over 80 held exits on the morning of Oct 23.

**On the dashboard:**
- the depth monitor shows a CURVE badge for each held contract (its state, the curve, the projection and z) and a LINE badge (the live line: with or against the side, FADING with its projected top, or BREAK, and how far under or over its projection it is);
- the Telemetry tab's Exit curve row shows the scoreboard;
- every hold, release, score and bench is in the audit log (`curve_exit`).

**Modes (`SINUOUS_EXIT`, paper and live):** `cross` (default) sells on a confirmed cross and holds nothing (above). `gate` holds profit exits for the curve's signal. `monitor` shows the curve and notes what it would hold, without holding anything. `rest` also rests the exit at the curve's swing-top estimate. `off` removes it.

### Entry curve (`SINUOUS_ENTRY`)

A resting maker bid fills when the price moves through it, so the fills that come fastest are the ones the market is moving against. On Oct 20–22, a minute after a maker fill the market sat about 1.5¢ below the price paid. The entry curve (`bot/strategy/sinuousEntry.ts`) follows every crypto market's book with the same filter as the exit curve and reads its slope:
- a bid for YES is **against the curve** when the curve falls faster than `SINUOUS_ENTRY_SLOPE_CENTS` (0.5¢) every 10 seconds;
- a bid for NO (a YES ask) is against it when the curve rises faster than that;
- slower, or while the curve warms up, nothing is against it.

The filter damps its slope against book noise: a steady slide of 1¢ every 10 seconds reads about 0.4¢ on a 15-minute contract and 0.6¢ on an hourly one.

**Monitor first (`SINUOUS_ENTRY=monitor`, the default).** Nothing is blocked. Every maker fill that adds to a position is tagged with the curve's slope when it filled, and scored by its 60-second markout: the mid a minute later, in the terms of the side bought, minus the price paid. The Telemetry tab's Entry curve row compares the fills the gate would have blocked with the ones it would have kept, at the configured slope and at 0.25, 0.5, 1 and 2¢. The scoreboard is kept in `curve-entry.json` and survives restarts.

**Turning it on.** Set `SINUOUS_ENTRY=gate` once the blocked fills' markout is clearly worse than the kept ones'. Then a quote that adds to a position is not placed while the curve runs against its side, and a resting one is pulled. A quote that reduces a position, such as a take-profit, is never held. `off` removes the curve.

### Trading by hand on Kalshi alongside the bot

The reconciler (`bot/recon/reconciler.ts`, every 45 s) treats Kalshi as the truth and expects you to trade on the same account:

- **Your fills** (bought or sold in the Kalshi app or website) are booked like the bot's own. Kalshi keeps one net position per market, and so do the bot's books, so a contract you sell by hand simply leaves the bot's position. The bot keeps managing whatever is left with its normal exits. A `manual-trade` alert says what was booked.
- **Your resting orders** are left alone in live mode and listed on the dashboard's Reconciliation row. The OMS writes every order it sends to disk first, so an order it does not know is yours. That holds for the reconciler, and also for a restart or deploy, the dashboard's STOP and the kill switch: all of these cancel only the bot's own orders. (Paper still cancels unknown orders: nobody else trades the paper exchange.)
- **Markets you trade that the bot does not** have their close time looked up, and they are settled from Kalshi's result like the rest.
- **Results before payouts.** Kalshi publishes a market's result some time before it pays the market out (minutes for 15-minute contracts, longer for some daily ones), and lists the position until then. A market the bot has settled is not a mismatch while Kalshi reports the same result for it.
- **Mismatches nothing explains.** First the market's own fill history is searched, as far back as the bot remembers trade ids, so nothing is booked twice. If the same mismatch is still there on the next run, Kalshi's position is adopted: the difference is priced at Kalshi's mid, audit kind `recon_adopt`, `recon-adopt` alert. At most 3 positions are adopted automatically per hour. Past that the mismatch stays a break, because something keeps disagreeing.
- **Resolve.** The Reconciliation row's **Resolve** button, or `POST /api/recon/resolve` with `{"confirm": "ADOPT KALSHI POSITIONS"}`, re-checks now, adopts every remaining mismatch and lifts the reconciliation halt at once. Resetting the kill switch while reconciliation is not clean offers the same step first.

### Research loop

```bash
npm run research:dataset -- --recordings data/recordings --every 60 --entry-window-only   # relaxed-spec sampling
npm run research:train -- --ensemble 5 --cpcv 10                                         # MLP (hidden 8/16) -> params/model.candidate.json
npm run research:backtest -- --model params/model.candidate.json --grid 0.02,0.03,0.04 --exits hold,take_profit,fair_value --annotate
npm run research:ta -- --assets BTC,ETH,SOL,XRP,DOGE --days 120                        # TA rule study -> params/ta_study.json
npm run research:perp-train -- --recordings data/recordings --every 300                 # -> params/perp_model.candidate.json
npm run research:perp-backtest -- --model params/perp_model.candidate.json --annotate   # execution gate for full-size perps
npm run research:snn-train -- --domain crypto --from 2026-06-01 --to 2026-06-22 --eval-from 2026-06-22 --eval-to 2026-06-29   # or --domain perps
npm run research:snn-ablation -- --recordings data/recordings --domain crypto [--grid grid.json]   # S0..S6 + deferred vs proxies, criteria (a)-(f)
npm run research:vol-model -- --recordings data/recordings                               # tree vol forecast -> params/vol_model.json
npm run research:fill-train -- --fills data/fills                                        # fill model (needs 500 quotes / 100 fills)
npm run research:snn-golden                                                              # regenerate the Python golden vectors
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
  - It is the default (`EXIT_POLICY=confluence_ratchet`), and the dashboard shows HUNTING with the target and stop.

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
| Auto-deploy on push to `main` with `npm install` | Replaced. Pushes to `main` still auto-deploy to the Lightsail static IP, but only after typecheck, tests and build pass, from the lockfile (`npm ci`), with a health check and automatic rollback. Tag-only, approval-gated deploys are one setting away (`AUTO_DEPLOY=false`, required reviewers). See `docs/DEPLOY.md`. |
| Gemini writing live parameters | Removed from the runtime. LLMs may help offline (reviews, reports) and must never change a running parameter. |
| `ALWAYS_ON_15M`, profit-target sizing, Kelly fail-open, EV-gate override, $0.50 default price | Removed. Kelly returns zero when edge ≤ 0. The gateway has no override. Missing data blocks trading and pulls quotes. |
| FIX path, and FIX→REST fallback with a new id | Removed. There is one REST order path. Retries reuse the same `client_order_id`, and a timeout queries by id before any resend. |
| Perps / margin | Rebuilt on the new core: features (stage 1), a delta hedge (stage 2) and live directional trading (stage 3) with exchange-side stops, liquidation-aware leverage, a perp daily loss stop, pilot size until a model validates, and research gates. |
| Online NN, meta-learning, plasticity, hand-set win probability, confluence | Replaced by the fair value plus the frozen, offline-validated meta-model. |
| % TP/SL and trailing stops on binaries | Fixed-% stops removed. Exits are fair-value or model-based. The order-book ratchet / hunt mode runs live only after the backtest shows it beating the fair-value exit. |
| USDT-dominance, Ichimoku, VPIN gates; trade-ID-tuned gates | Removed as gates. USDT.D/BTC.D, Ichimoku and VPIN return only as learned model features, weighted by walk-forward validation. |
| Paper "blowout reset" | Removed. The paper exchange never refills. |
| Paper fills from late market data | A resting paper order is filled only by trades Kalshi printed after it was placed (by the trade's own time stamp, 1 s slack for whole-second stamps). On Oct 5-6 the Kalshi socket delivered trades and book updates minutes late (compressed frames queued on a busy box); quotes priced on live Coinbase prices were filled by those old trades, and paper booked that hindsight as profit. Separately, `RISK_MAX_FEED_LAG_MS` (default 3000, 0 = off) stops all orders and pulls resting quotes, paper and live, while Kalshi data reaches the bot later than that (measured from Kalshi's send stamp on index frames, else trade times). |
| Cosmetic modules (Avellaneda-Stoikov, jump-diffusion, Kalman, Bayesian Kelly, HRP, Almgren-Chriss, "SR 11-7"), the Python bot, patch scripts, committed state, second lockfile | Deleted. |
| Legacy `/portfolio/orders` | Orders go to `POST /portfolio/events/orders` (V2) with `post_only`, `self_trade_prevention_type`, `expiration_time` and `cancel_order_on_pause`. |
| Risk gateway (fail closed) | `bot/risk/riskGateway.ts`. It checks: per-order, per-window (correlated, no netting), total and daily-loss limits; price collar vs fair value and vs the touch; longshot guard; stale book and index; throttles; time to close. |
| OMS state machine and idempotency | `bot/oms/`. The id is persisted before send. Acceptance is not a fill. Fills are de-duplicated. Exits stay tracked until confirmed. |
| Reconciliation | `bot/recon/reconciler.ts`. Runs every 45 s and on reconnect. Missed fills are repaired. Trades and orders made by hand on Kalshi are booked or left alone, not treated as faults (see "Trading by hand on Kalshi alongside the bot"). A position nothing explains is adopted from Kalshi after two runs. A remaining break halts new risk, and trips the kill switch if it persists. |
| Kill switch | Persists on disk, survives restart, auto-trips on loss limit, repeated order errors, persistent break or a stalled heartbeat. Resting orders also carry an exchange-side `expiration_time` as a dead-man switch. |
| Sizing vs break-even | One rule in every mode, override on or off (`EquityGuard.sizeScale`; perps: `BreakEven`): full size at or above break-even (the starting cash, moved only by deposits, withdrawals and training refills); as net losses grow the size shrinks linearly, to a quarter (`SIZE_FLOOR`) at a net loss of `RISK_DD_SCALE_AT` (15% on the normal tier); as wins win the losses back it grows again, and once wins equal losses it is back to full size. Never zero. Break-even moves UP with the pool (never down by P&L) when the day's profit (UTC) reaches `VAULT_DAILY_GOAL_USD` (perps: `SETUP_DAILY_GOAL_USD`), or after two losing trades in a row that still leave the pool above break-even (audit `break_even_raised`). |
| Paper exploration | Paper mode only (`PAPER_EXPLORE`, default on): when no entry qualifies, the best borderline one (fee-net positive, within `PAPER_EXPLORE_BAND` = 2c of the edge threshold) is entered at one contract with probability `PAPER_EXPLORE_RATE` (10%), at most `PAPER_EXPLORE_MAX_PER_HOUR` (6) an hour, tagged `explore (p=…)` in the decision log, so the fill model and the edge threshold get data near the boundary. |
| Paper training trades | Paper mode only (`PAPER_TRAINING_TRADES_PER_HOUR`, default 12, 0 = off): when nothing is entered on edge, the bot still buys 1 contract on the side the model favours (taker, at the touch), spread evenly over the hour, one per contract, only with the side priced 10–90c and the spread at most 8c. Tagged `train (paper)` in the decision log so results can be separated from edge-qualified entries. Since Oct 23 paper uses live's data limits (book 5 s, index 3 s; until then it accepted 30 s / 15 s so a busy server did not block training). With `PAPER_OUTSIDE_PRICE_FALLBACK=true` (off by default) Coinbase spot stands in when Kalshi's index print is late. |
| Adversarial evaluator | Every entry is attacked before it is placed (`bot/strategy/adversary.ts`): TA / confluence / macro inputs jittered (seeded Monte Carlo, broken if >20% of draws lose the edge), each input removed in turn (broken if one indicator carries the whole edge), confluence direction vs the side, fair value re-priced at volatility x1.3 / x0.75 and the price moved 0.5–1 sigma against the side, edge vs the model's own std, and the tape (fast move, hostile book). An entry nothing breaks, with TA or confluence evidence that held, gets a conviction multiplier 1 + (max - 1) x worst surviving edge / edge, and is re-sized by Kelly at that multiplier (Kelly fraction and per-order caps scaled together), capped at `ADVERSARIAL_MAX_BOOST` (default 2, max 2) x the original size; window and total risk caps are unchanged. A broken entry keeps its normal size (never smaller). Paper and live; `ADVERSARIAL_BOOST=false` turns it off. The verdict is in each market's status (`adversary`) and the decision notes. |
| Kalshi data only for contracts | Contracts are priced on Kalshi's own CF Benchmarks index (`cfbenchmarks_value_5hz` for BRTI, ETHUSD_RTI, SOLUSD_RTI, XRPUSD_RTI, DOGEUSD_RTI; `cfbenchmarks_value` for the rest; both private channels on the signed WebSocket; each print is `{index_id, value_usd, source_ts_ms, received_at}` plus Kalshi's `sending_ts_ms`). Coinbase and Binance feed TA and features only; `PAPER_OUTSIDE_PRICE_FALLBACK=true` (paper) lets them stand in when the index is stale. Tracked strikes are picked by Kalshi's own prices (YES nearest 50c on a ladder, the richest buckets on a range); range bounds missing from the listing are read from the ticker. `/api/status` `kalshiIndexFeed` counts what the index channels delivered (received / parsed / dropped, ids seen, Kalshi's index list, raw samples, subscription acks). `latency.kalshiTransit` (the dashboard's WS figure) is the one-way delay from Kalshi's send stamp to the bot handling the message, `latency.kalshiIndex` the index print's age, `kalshiIndexFeed.vendorMs` the CF Benchmarks -> Kalshi part; the ping round trip (`kalshiWs`) also waits behind every frame queued ahead of the pong. `latency.loopP99` is the main-thread event-loop delay. The Kalshi socket runs without permessage-deflate (the ws library inflates frames one at a time, so a burst delayed everything behind it) and order state writes are coalesced (submissions are still written before they are sent). `GET /api/debug/profile?sec=10` returns a main-thread CPU profile (once a minute); each SNN unit reports `workerBusy`. |
| CPU budget | Markets the bot holds nothing in (no position, no resting order) are fully re-evaluated every `EVAL_IDLE_SEC` (5 s) instead of every second; any market it is in stays at 1 s. Hourly ladders track the `CATALOG_STRIKES_PER_EVENT` (4) strikes nearest the index. `/api/status` `guards.cpu` shows the process's CPU use (cores) and the wall time per loop section (evaluate, snn, perps) over the last minute. |
| Champion / challenger | A retrained model replaces the live one only when it is at least as good (`research/champion.ts`): the TA network is graded against the live network on the same untouched holdout hours (mean model / naive loss over its heads); the other models (setup scorer, main pricing model, perps, vol, tennis) must validate at least as many parts (heads, lanes, passed validation). Every replaced model is archived in `data/models/archive/<kind>/` (newest 8 kept). `AUTO_TRAIN_CHAMPION=false` turns it off. |
| TA network calibration and ensemble | The direction heads' raw probabilities were overconfident (51% hit rate, yet worse log loss than a coin flip). The final training pass now leaves out the evaluation period (a month) before the holdout and fits Platt calibration there (`fitPlatt`), so the holdout is graded on calibrated probabilities and the live network outputs them. Live, the network is a performance-weighted ensemble (`bot/ta/taNetEnsemble.ts`, `TA_NET_ENSEMBLE`, 3): the champion plus the latest archived versions, each weighted prior x exp(40 x its rolling skill on graded live calls), so versions that keep performing gain weight and none is thrown away. Weights: `/api/status` `guards.taEnsemble`. |
| TA volatility in pricing | The TA network's validated volatility forecast (next 4 h vs the last 24 h) scales the pricing sigma: m = exp(forecast) x 24h realised / EWMA, within [0.5, 2], applied as m^`TA_VOL_WEIGHT` (0.5); skipped while the tree vol model is validated. Each market's status shows `taVolMult`. |
| TA conviction overlay | The TA network (trained on years of hourly history) and the TA / confluence readings steer crypto trading on top of the mathematical fair value (`bot/strategy/taConviction.ts`). **Pricing:** each direction forecast P(up over H) becomes a drift (z = Phi^-1(P), i.e. z sigma over H, z·sqrt(tau/H) sigma over a contract's remaining life); the contract is re-priced with the index moved by `TA_PRICING_WEIGHT` x reliability x that drift, so the side the network favours is worth more than the math alone (shift capped at `TA_PRICING_MAX_SHIFT`, default 6c). A head counts fully once it passed the blind walk-forward test; otherwise by its own rolling skill on the last 168 graded hourly calls (no better than a coin flip -> no influence; ungraded -> half, in live too while `LIVE_ALLOW_UNVALIDATED_MODEL` is on, the default, so the same market prices the same in both modes; with it off, nothing in live). Skipped when the live model already reads the network's forecasts. **Sizing:** the adversary's boost is scaled by breadth, the net share of TA / confluence signals agreeing with the trade (TA network 1h / 4h, confluence count, MTF trend / alignment / momentum, RSI 1h, EMA stack), and the TA network calling the underlying against the trade breaks the entry. Perp setups get 1 + (max - 1) x breadth. **Altcoin risk-on rule:** an altcoin (every asset except `NON_ALTCOINS`, default BTC) long the underlying (YES on up / above, perp long) while USDT.D falls over 15 min (`ALT_USDTD_MAX_Z`, default 0 sigma) and RSI(14) is above `ALT_RSI_MIN` (50; 15m RSI for 15-minute contracts, 1h for hourly and perps) gets `ALT_RISKON_BOOST` (2.5) x its Kelly size and is selected first. The adversary can veto it: a Kalshi entry the adversarial evaluator breaks keeps its normal size, and a perp long gets no altcoin boost (or priority) when the TA network calls the underlying against it or more TA / confluence signals oppose it than agree. All multipliers combined are capped at `CONVICTION_MAX_TOTAL` (2.5) x the normal size, with per-order caps widened to match (window / total caps and the portfolio Kelly cap unchanged). **Selection:** markets are evaluated, and setups entered, in priority order (altcoin risk-on, then TA conviction), so they get the shared risk budget first. **Is it helping?** `guards.taHealth` scores the probability with the TA drift against the same probability without it on every settled window (advantage > 0 = the TA network improves the prices). |
| Tournament fitness | `bot/util/fitness.ts`: annualised log growth of daily net returns (oversizing is punished by the log; no trading scores 0 and the coverage floor stops abstaining from winning). The old Sortino - 5 x drawdown - 5 x costs remains as objective `sortino`. |
| Directional system: character + rule book | **Character** (`bot/ta/character.ts`): each coin is classed hourly as calm, trending, volatile coin-specific or volatile market-wide, from 24 h realised volatility as a percentile of its last 180 daily ranges (nudged by the TA network's validated volatility forecast), the average correlation of its hourly returns with the other coins over 72 h, a variance-ratio Hurst exponent, the efficiency ratio and ADX (Bollinger bandwidth rank is reported). Direction is hard to call; character is not, and it decides which direction rules deserve trust. The study scores the class against the character the next 24 hours actually had. **Rule book** (`bot/ta/knowledge.ts` `BOOK_RULES`, evaluated into `TaSnapshot.book` apart from the rules the trained models read): double top / bottom, head and shoulders (and inverse), flags / pennants, triangle breaks, trendline break + retest, the Cardwell RSI range shift, Connors RSI(2) pullbacks, trend pullbacks to the 21 EMA, market breadth across the coins (share above their 20 / 50-day averages, new 20-day highs vs lows) and traditional risk gauges (DXY, US10Y, VIX, HYG 5-day changes, TradingView daily bars fetched by the pipeline). **Walk-forward study** (`research/ruleBook.ts`, weekly pipeline step `rule_book`): every rule, rule-book rule and confluence on 2017-2026 hourly history of the five coins, every 6 hours, as a trade in its direction held 1 h (for the 15-minute and hourly contracts), 4 h and 24 h after a 10 bps round trip, by character: trades, hit rate, payoff, expectancy, block-bootstrap p-value; a row passes only with a Benjamini-Hochberg pass across every test on the first 70 % of the years AND positive expectancy with a 50 %+ hit rate on the later 30 % it never saw; its weight grows with its t-statistic on both. **Confluence logbook** (`research/confluenceBook.ts`, same walk): at every step the set of signals active together is recorded, and every pair actually seen together pointing the same way (two rules, or one rule on two timeframes) is logged with what followed: count, hit rate, expectancy, its lift over the better of its two parts, and the same on the later years. A pair passes only with a Benjamini-Hochberg pass across every pair tested, positive lift and expectancy on both periods; a passing pair also gets a small take-profit / stop-loss bracket (1-4 % / 0.5-2 % on hourly highs and lows, for the perps side) with its own later-years check. The logbook (`combos` in `rule_book.json`, the 1,500 most notable pairs) shows what tends to happen together; passing pairs join the live reading. **What makes or breaks a rule** (`research/conditionBook.ts`, same walk): each step also notes its context (`bot/strategy/ruleContext.ts`, from the same TA-Lib snapshot the live bot reads): 1h RSI, ADX, ATR and Bollinger-width percentiles, volume vs average, the last 20 hours' move, money flow, the 4h and daily trend, price vs the 200-day average, 4h RSI, the UTC hour and the weekend, with directional ones read relative to the signal. Every rule's occurrences are split into thirds of each parameter, and each range is tested against the rule's other occurrences (Welch, overlap-adjusted, Benjamini-Hochberg across every rule x horizon x parameter x range). A range **makes** the rule when it is positive and better than the rule's own average on both the discovery and the later years; it **breaks** it when it is negative and worse on both. Live, a passing breaker that holds now silences the signal, and a passing maker lets a rule that did not pass on its own count while it holds. The 2,000 most notable ranges are logged as `conditions` in `rule_book.json`; `/api/status` `ruleBook` shows the counts and the strongest. **What invalidates a call** (`research/invalidationBook.ts`, same walk): for every signal, its trades when another signal was active at the same time (pointing the same way or against it) are compared with its trades when that signal was not, and likewise with 1, 2 or 3+ other signals pointing against it (or with it). An addition **invalidates** the call when, with it, the signal lost money and did worse than without it on both the discovery and the later years (Welch, overlap-adjusted, Benjamini-Hochberg across every test). Live, a signal whose passing invalidator is present now is silenced and reported as `invalidated` ("ema_stack@1h by book|double_top|1h"). The log is `invalidations` in `rule_book.json`. **Live** (`bot/strategy/ruleBook.ts`): the passing rules present now, weighted by their row for the coin's character, combine into one reading in [-1, 1] that joins the conviction signals (breadth and boosts for Kalshi entries and perp setups); with no `rule_book.json` it is neutral. In a volatile market-wide character the conviction boosts stand aside (Kelly fair value only; the math still prices everything). The setup take/skip model gets the character as an optional input group, kept only if it raises the development years' t-statistic. Status: `/api/status` `market` (breadth, risk, characters) and `ruleBook` (passed rows, character accuracy). `RULE_BOOK=false` / `CHARACTER_STAND_ASIDE=false` turn the parts off. |
| Evolved formulas (genetic programming) | `research/gpIndicators.ts` (pipeline step `gp`, weekly; every round on the laptop; `npm run research:gp`), after the video "I let genetic programming design trading indicators" and ZiadFrancis/Genetics_Trading_Part_1. Per coin, 1,000 random formulas (up to 15,000 on the laptop) are built from the coin's and BTC / ETH hourly bars (scale-free OHLCV) with arithmetic, trigonometry, comparisons and rolling-window functions. Each formula's value is a target exposure (-100%..+100%) with a 10% dead band and costs; the score is Sharpe, or the video's e^(-return). The best 10% survive, the rest are bred by tournament selection, subtree crossover and mutation, for 15 generations. The champion is chosen on the validation years, tested once on the newest years, and validated only with a probabilistic Sharpe of 0.9+ (deflated by every earlier contest), 20+ trades and a drawdown within 35%. Saved as JSON (`data/models/gp_indicators.json`, one champion per coin, replaced only by a formula that beats it on the same test years). Live (`bot/gp/gpSignals.ts`), a validated formula's current exposure joins the conviction signals as `evolved formula`. docs/EVOLUTION.md has the details and measurements. |
| Optimal f cap | Kelly sizes are capped by Vince's optimal f measured on the trades each book actually produced (`bot/strategy/optimalF.ts`): the growth-optimal risk per trade g* = argmax sum w log(1 + g R) (R = net result per amount risked), its distribution from a moving-block bootstrap of the trade history (blocks of ~sqrt(n) trades keep streaks together), and the cap is its 25th percentile (`OPTIMAL_F_QUANTILE`): what the edge supports even in a weaker resampling of the same trades. The cap is a min with the Kelly-style size (lane risk x score x conviction for perp setups; the per-order stake for Kalshi, conviction boosts included), never a raise. **History + now:** perp setup lanes use the setup model's out-of-sample lane trades (walk-forward scores; the years the book thresholds were chosen on count half), stored in `setup_model.json` `sizing`, plus the trader's own closed trades at `OPTIMAL_F_LIVE_MULT` (2) each, all decaying with a `OPTIMAL_F_HALF_LIFE_DAYS` (365) half-life, recomputed hourly and after every close; Kalshi uses every settled entry in `DATA_DIR/trades.jsonl` (one trade per market, stake loaded with the taker fee) once there are `OPTIMAL_F_MIN_TRADES_KALSHI` (100). **Drawdown guard:** the same bootstrap gives the 95th percentile of the worst drawdown over 100 trades (in R); a lane whose live drawdown goes beyond it trades at half size until it is back under half of it. Paper floors each cap at `OPTIMAL_F_PAPER_FLOOR` (0.25) x the configured risk so evidence keeps coming; live a history with no edge (cap 0) stops entries. Status: `directional.optimalF` (lanes) and `guards.optimalF` (Kalshi pools); `OPTIMAL_F=false` turns it off. |
| Sizing tuner | `research/tuneSizing.ts` (pipeline step `sizing`, `npm run research:tune-sizing`): replays every settled entry (`DATA_DIR/trades.jsonl`: probability, price, outcome) under a grid of Kelly fractions x break-even thresholds, with exhaustions and refills as in paper epochs, and writes the best long-run growth to `data/models/sizing_proposal.json` once 200 trades exist. A proposal: never auto-applied. |
| Kill-switch override | Chassis switch beside the kill key, ON unless switched off, remembered (`DATA_DIR/control.json`). It decides only whether losses can stop trading: the daily loss limit no longer trips the kill switch (logged as `kill_suppressed`), and the weekly loss pause, model-health halt and perp daily halt are skipped. Paper: every automatic trip is covered, and when a pool can no longer trade (Kalshi tradable bankroll below `MIN_TRADABLE_BANKROLL_USD`, perps margin below `PERP_MIN_EQUITY_USD`) the epoch ends: logged as a capital-exhaustion failure in `DATA_DIR/epochs.jsonl`, resting orders cancelled, the pool refilled to its starting amount and break-even reset (`bot/training/supervisor.ts`). Live: only the loss-limit trip is covered (reconciliation breaks and order-error storms still engage), no refill, and an exhausted pool stops at the minimum. Epochs tune sizing; they never penalise individual trades. |
| Results vs expectation | `bot/risk/streakScaler.ts` (diagnostic, shown in status): each settled entry compares the outcome with the probability the order was placed on, z = (outcome - q) / sqrt(q(1 - q)); its exponentially weighted mean in standard errors says whether a losing run is bad luck or the model overstating its edge. |
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
