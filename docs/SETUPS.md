# Setup trader: fast and slow lanes

The perps trader works like a chart reader. It waits for a setup, checks the bigger picture and the time of day, and takes the trade only if the odds after costs are good. It then manages the trade: half off at the first target, stop to break-even, and the rest trailed.

- **Fast lane (intraday / micro-swing):** 15-minute and 1-hour setups, held for hours. It catches one leg of a move, then flips, waits, or moves to another coin.
- **Slow lane (days to weeks):** daily trend setups, reviewed at every daily close.

Code: `bot/setups/`. Training and backtest: `research/trainSetupModel.ts`. Live: `bot/setups/setupTrader.ts`, turned on with `PERP_STRATEGY=setups` (the default).

## Why it was rebuilt this way

The TA network had been asked to call up or down every hour. That's not how TA makes money, and the research showed it (`docs/TA_NETWORK.md`, `research/classicTaStudy.ts`, `research/intradaySetupStudy.ts`, `research/setupMetaStudy.ts`):

- The same textbook TA rules lose on hourly bars but beat buy-and-hold on daily bars.
- TA trend trading wins only 25–45% of trades. It makes money because winners are several times larger than losers.
- An intraday setup taken every time is break-even before costs. A model that reads the whole chart and picks which setups to take improved results in every setup type, on years it never saw. This is meta-labeling: the setup picks the side, and the model decides whether the trade is worth taking.

## The setups (`bot/setups/detectors.ts`)

| Lane | Setup | Bars | When | Exits |
|---|---|---|---|---|
| fast | **fade** | 15m, 1h | RSI overbought (≥ 70 in the last 3 bars, now turning down), the upper Bollinger band tagged, MACD histogram falling, a red bar with taker-buy share under 50% and falling → **short**. Mirror image → **long**. | Half off at the middle band (stop to break-even), the rest at the opposite band; 1.5-ATR trail after the first target; 24-bar time stop |
| fast | **pullback** | 15m, 1h | Higher-timeframe trend up (SMA 20 > SMA 50 on 4× bars, close above SMA 50), a dip (RSI < 40 or the lower band tagged), then a green bar with buyers → **long**. Mirror → **short**. | Half off at 1R, the rest at 3R; trail after 1R; 24 bars |
| slow | **breakout** | daily | Close beyond the prior 20-day high (low) with the 50/200-day trend agreeing | 3-ATR chandelier trail from the best close; 60-day time stop |
| slow | **dip** | daily | Pullback in an established trend: above the 200-day SMA, 50 above 200, RSI back above 45 after dipping under it | Same trail; 60 days |

Every stop sits beyond the structure: the extreme of the last 3 bars, plus 0.25 ATR for the fast lane.

## Trade management (`bot/setups/exits.ts`)

Inside each bar the checks run in a fixed order. When the order inside a bar can't be seen, it's resolved against us:

1. **Stop.** A gap through the stop exits at the bar's open.
2. **First target.** Half the position comes off, and the stop moves to break-even.
3. **Final target.** The rest comes off.

At each close of the trade's own timeframe:
- the trailing stop follows the best close (it only ever tightens);
- the time stop exits after a fixed number of bars. It also counts elapsed time, so gaps in the candles cannot keep a trade open.

Costs come from the perps fees:
- market entry: taker fee + 2 bp slippage;
- target exits: maker fee;
- stop and time exits: taker fee + slippage;
- funding: charged both ways (conservative).

The same code runs in the backtest (on 15-minute bars) and live (on the spot price, tick by tick).

### The 4h ATR ratchet (`SETUP_RATCHET`, on for the slow lane)

For the lanes it covers, the ratchet replaces the break-even and trailing rules above:

1. **Initial stop:** 3.5 ATR(4h) from the entry. The 4h bars are built from the closed hourly bars (the last 280 hours, so the research simulation and the live bot compute the same number).
2. **Break-even:** once the trade has gone 2 ATRs in its favour, the stop moves to the entry plus the round-trip fees, so a trade that has run that far can no longer lose money.
3. **Trail:** from 3.5 ATRs in favour, the stop trails the best price by 3 ATRs.

The stop only ever tightens, and the stop on the exchange moves with it (it only ever tightens too). The lanes size by stop distance, so a wider stop means a smaller position, with the same dollars at risk. That makes the sizing volatility-scaled: when 4h volatility doubles, the position halves.

**The volatility unit.** By default the unit is ATR(4h). With `SETUP_RATCHET_VOL_K` = k, it becomes ATR(4h) × exp(k × the TA network's validated 4h volatility forecast), clamped to 0.67–1.5×. A positive k widens the stops before an expected volatility expansion and tightens them before a quiet spell. The `setups-ratchet` sweep tests k against plain ATR (k = 0) on the TA network's walk-forward forecasts, and it stays 0 unless the sweep shows the forecast is the better unit.

The settings the model was trained with are recorded in the setup model (`ratchet`), and the live trader manages trades with exactly those, so a change to `SETUP_RATCHET` takes effect at the next retraining. The `setups-ratchet` sweep tunes it.

### Spot-led setups: the lead-lag study and the spot pullback (`SETUP_SPOT_PB`, off until proven)

The setups are drawn on Coinbase spot candles and traded on the Kalshi perp. The 4th-generation spec's 5.2 asks whether spot *leads* the perp. If it does, spot-chart pullback rules would be worth adding. That is measured before anything is built on it:

- **The study** (`research/leadLag.ts`, the weekly `lead_lag` pipeline step, `npm run research:lead-lag`): from the recordings' real prints, each coin's spot price and perp mid on a one-second grid.
  - It measures the cross-correlation of their returns at -60..60 s.
  - It computes a lead score over lags beyond two of the perp feed's poll intervals, against the reverse score. The perp is polled every `PERPS_POLL_MS` (2 s), and anything shorter is the polling.
  - **The tradeable test:** at fresh perp quotes only, how far the perp moves in the direction of the largest 10% of spot-perp gaps over the next 5–60 s, against the cost of trading it (10 bps). Polling and API latency leave gaps too small to pay for themselves.
  - A coin's verdict is "spot leads" only when the lead score's 95% lower bound is above 0 and above the reverse, and a big-gap move's lower bound clears the cost. The verdicts go to `data/models/lead_lag.json`.
- **The spot pullback** (`spotpb`, fast lane, `bot/setups/detectors.ts`):
  - **Long:** in an uptrend (higher timeframe), RSI dipped under 40 in the last 5 bars, price came back into a recent bullish fair value gap (a 3-bar gap) without closing through it, and the bar reclaims the 21 EMA in green. The short is the mirror image.
  - The stop goes under the gap and the last 3 bars, with targets at 1R (half off) then 3R and an ATR trail.
  - It runs only for coins whose verdict is "spot leads", and ahead of the plain pullback there.
- **How it is proven:** the `setups-spotpb` sweep compares those coins' fast lanes with and without it, by the t-statistic of net R per trade on the tuning, check and final years. It stays a proposal until you set `SETUP_SPOT_PB=on`.
- **Recorded in the model:** the coins it ran for are recorded in the setup model (`spotPullback`), so the live trader detects exactly the setups the model was trained with. The model sees them through a `kind_spotpb` flag.

### Scale-out exits (`SETUP_SCALE_OUT`, off until proven)

A generic scale-out policy (the 4th-generation spec's 5.1): partial take-profits at R multiples, with the remainder trailed. For the lanes it covers, it replaces the two targets:
- **First step:** once price has gone `SETUP_SCALE_R1` R in the trade's favour, `SETUP_SCALE_F1` of the original position comes off at that level (a resting maker exit). A bar that opens beyond the level fills at the open. The stop then moves to break-even, unless the ratchet manages the stop.
- **Second step:** the same at `SETUP_SCALE_R2` R for `SETUP_SCALE_F2` of the position. Set `SETUP_SCALE_F2` to 0 for a single step.
- **The remainder:** at least 5% of the position always stays on. It trails the best close by `SETUP_SCALE_TRAIL_ATR` ATRs of the setup's timeframe, and it only ever tightens.
- **Before the first step:** the lane manages the trade as it normally would.
- **Conservative fills:** a bar that touches both the stop and a step is resolved against the trade (the stop first).

**How it is proven.**
- The `setups-scale` sweep backtests it on every coin's history across both lanes against each lane's own exits (`scale.on` = 0 is the baseline). It tunes the steps and the trail on the tuning years, and accepts a change only if it holds on the check and final windows (t-statistic of net R per trade, real fees).
- It stays a proposal: `SETUP_SCALE_OUT` is `off` until you adopt it.
- Once on, the settings are recorded in the setup model (`scaleOut`), and the live trader takes the same partial exits through the same reconciliation it uses for the half-off at the first target.

### The cross-coin lead-lag exit (on only when it pays)

When BTC or ETH moves and a coin has not followed yet, does the coin make up the gap over the next 15 to 60 minutes? The weekly `cross_lead` study measures it (docs/TA_NETWORK.md, "Cross-coin lead-lag"). If a coin has a predictive leader, the exit works like this:
- **The reading:** at each 15-minute close, the coin's expected move over the next 15 and 60 minutes from the part of the leaders' move it has not made yet, in units of its own volatility over that span (both horizons summed).
- **The rule:** a trade is closed at that close (taker exit) when the reading points against it by more than k.
- **How it is chosen:** the trainer replays every setup with a lead-lag reading at its entry, with the same plans the lanes trade, with and without the exit at k = 0.5, 1, 1.5 and 2. Training reads the study's walk-forward fits, each made before the time it is used. The exit is switched on, at the k with the best gain, only if both hold:
  - its net R gain per trade on the development years has a month-block bootstrap lower bound above 0 (Bonferroni over the four ks);
  - it gains on the holdout too.
  The final window is not looked at. Otherwise it stays off, and the log says why (`lead-lag exit ...`).
- **Recorded in the model:** when on, the k and the gains are recorded in the setup model (`crossLeadExit`). The scorer and the lane validation are then trained on trades with that exit, and the live trader makes the same exit from the study's final fit, from the close of the 15-minute bar the trade entered in.

### Liquidation beyond the stop (`bot/risk/liquidation.ts`)

Under cross margin, a position is liquidated when the account's equity, after the move, falls to its maintenance margin. If the liquidation price sat inside the stop, the exchange would close the trade at a worse price before the stop could fire. So:

- **At entry**, the notional is capped at `(1 − PERP_LIQ_BUFFER) × (equity − reserved) / (stop distance + maintenance rate)`. Reserved is what the open trades tie up: their loss if they ran to their stops (zero once a stop locks a profit), plus their maintenance margin. With the default buffer of 0.2, the liquidation sits at least 25% farther away than the stop. A trade with nothing left to size is skipped (`setup_skip` in the audit log).
- **While a trade is open**, the bot reads the exchange's liquidation estimate once a minute. If it has drifted inside the required distance (other positions moved, funding, a thin account), the trade is cut until it is not: an urgent reduction, logged as `liquidation_guard`. Nothing more is cut until the exchange shows the reduction.
- The maintenance rate is `PERP_MAINT_MARGIN`, or, when that is 0, half the initial margin implied by the exchange's leverage estimate (5% without one). The paper exchange estimates liquidation the same way.

The perps signal trader (`PERP_STRATEGY=signal`) uses the same cap, with its other open positions reserved at its stop distance.

## What the model sees (`bot/setups/features.ts`, 785 inputs)

- **The full TA library on 15m, 1h, 4h and daily:** RSI, MACD, ADX, Bollinger, Keltner squeeze, EMAs and SMAs, Ichimoku, Stochastic, Williams %R, OBV, CMF, MFI, volume profile, market structure, sweeps, breakouts, divergences, candle patterns, fair-value gaps, round numbers. It also sees the knowledge base's confluences and rule tallies.
- **BTC's readings** on 15m and 1h.
- **The market clock** (`bot/model/sessions.ts`):
  - session: Asia, London, the London/New York overlap, New York, the after-hours gap, weekend;
  - hours since the NYSE open, and the first 30 and 60 minutes;
  - the 11:00 ET hour and the distance from 11:00;
  - the last 30 minutes, and the hour after the close;
  - pre-market and the 08:30 ET data releases;
  - NYSE holidays and early closes;
  - the London and Tokyo opens and the London close;
  - the CME daily break and its weekend closure;
  - the New York hour and weekday.

  All of it is daylight-saving correct.
- **The setup itself:** lane, type, timeframe, side, stop distance in ATRs, targets in R, and its trigger readings.
- **Every directional reading again, multiplied by the trade's side.** "RSI high against my short" is therefore a separate signal from "RSI high".

These are inputs, not rules. The model learns which times and conditions help or hurt each setup.

### What the clock study found (`research/sessionStudy.ts`, 15m bars, 5 coins)

Since the spot ETFs started (Jan 2024):

- **US open, 09:30–10:30 ET:** volatility 1.9× the coin's normal level, the highest of the day.
- **11:00–12:00 ET:** the next hour tends to **continue** the prior two hours (the most positive correlation of the day, +0.09). Fade setups lose there: −0.25% per trade before costs at 11:00, −0.17% at 11:30. So 11:00 matters, but as a bad time to fade, not as a reversal.
- **15:30–16:00 ET (last 30 minutes):** only about 1.1× normal volatility in crypto, unlike stocks.
- **17:30 ET:** the strongest reversal of the day (−0.25 correlation).
- **Weekends:** about 0.8× normal volatility.

## The lanes and the queue (`bot/setups/lanes.ts`)

- **Queueing:** each detected setup the model rates at or above the lane's minimum score joins that lane's queue. A newer setup for the same coin replaces the older one. Candidates expire after 2 bars in the fast lane and 1 day in the slow lane.
- **Re-check before entry:** when a lane has room, the queue is worked best-first, and every candidate is checked again right before entry:
  - re-scored on fresh data;
  - still at or above the minimum score;
  - price not beyond the stop or the first target;
  - not chased: no more than 0.3R (fast) or 0.5R (slow) toward the target since the signal.
- **One position per coin.** The slow lane is served first; a fast candidate on a coin the slow lane holds waits in the queue.
- **Sizing:** each trade risks a set share of equity between entry and stop (`SETUP_FAST_RISK` 0.4%, `SETUP_SLOW_RISK` 0.6%), or a fixed dollar amount (`SETUP_FAST_RISK_USD`, `SETUP_SLOW_RISK_USD`), scaled 0.5×–1.5× by the score. Caps: per coin (`SETUP_MAX_ASSET_LEVERAGE`), in total (`SETUP_MAX_LEVERAGE`), half the exchange's leverage for the market, and the liquidation cap (the liquidation sits beyond the stop with a buffer, after the other open trades; see Trade management).
- **Worth taking:** with `SETUP_MIN_TARGET_USD`, a trade whose first target would pay less than that after the round-trip fee is skipped.

## Training and validation (`npm run research:setups`)

1. **History:** every setup in years of history for every coin, traded on its own with the real exits and costs. This gives about 100,000 fast-lane trades and 2,400 slow-lane trades.
2. **Walk-forward scores:** half-year folds from 2020. Each fold's model learns only from trades that had closed before the fold started, then scores the fold.
3. **Lane backtest** on those out-of-sample scores, with the real lane book: queues, re-checks, one position per coin, caps. Each lane's minimum score is picked from a 6-value grid on the development years only.
4. **Validation:**
   - The **holdout** (the 9 months before the last 3, never used for any choice) needs at least 30 trades and a mean net R above zero, with its bootstrap 5% bound also above zero.
   - The **final window** (the last 3 months) must be net positive.
   - The deployed model is refit on everything.

A lane that fails trades at pilot size (`PERP_PILOT_MAX_NOTIONAL_USD`), or not at all with `PERP_REQUIRE_VALIDATION=true`.

The automated pipeline retrains every `SETUP_RETRAIN_DAYS` (7). The live trader reloads the model when its file changes.

## Results (first real-data run: Binance spot BTC/ETH/SOL/XRP/DOGE, 2017 – Oct 2026)

**Costs assumed:** perps defaults, so market entry 14 bp (12 bp taker + 2 bp slippage), target exit 5 bp, stop exit 14 bp, and 1 bp funding per 8 hours. Dollar figures assume $10,000 of equity.

**Setups taken every time** (no model):

| Setup | Trades | Win rate | Net R per trade | Before costs | Costs in R | Median stop |
|---|---|---|---|---|---|---|
| 15m fade | 24,023 | 41.6% | −0.32 | −0.02 | 0.31 | 1.05% |
| 15m pullback | 57,235 | 40.5% | −0.48 | +0.01 | 0.49 | 0.67% |
| 1h fade | 6,494 | 43.7% | −0.23 | −0.06 | 0.17 | 1.94% |
| 1h pullback | 15,117 | 48.1% | −0.21 | +0.02 | 0.23 | 1.40% |
| 1d breakout | 1,453 | 39.0% | **+0.36** | +0.41 | 0.06 | 17% |
| 1d dip | 910 | 30.2% | **+0.23** | +0.32 | 0.09 | 11% |

The intraday setups are break-even before costs. With stops under 2% wide, a 0.28% round trip costs 0.2–0.5R per trade.

**Lanes with the model** (walk-forward scores, the real lane book; fast threshold = the model's top 5%, slow = top 30%, both picked on 2020 – Sep 2025):

| Lane | Period | Trades | Win rate | Net R per trade (90% interval) | Net $ | Sharpe |
|---|---|---|---|---|---|---|
| fast | 2020 – Sep 2025 | 1,995 | 53.3% | −0.05 (−0.09 to −0.02) | −$4,024 | −0.87 |
| fast | holdout Oct 2025 – Jun 2026 | 219 | 47.5% | −0.08 (−0.17 to +0.02) | −$682 | −1.22 |
| fast | final Jul – Sep 2026 | 100 | 46.0% | −0.19 (−0.34 to −0.05) | −$775 | −3.74 |
| slow | 2020 – Sep 2025 | 165 | 35.8% | **+0.45 (+0.08 to +0.88)** | +$4,715 | 0.69 |
| slow | holdout | 5 | 60% | +1.19 | +$393 | – |
| slow | final | 4 | 0% | −0.72 | −$168 | – |

- **Fast lane: not validated.** The model raises the win rate (42% → 53%) and cuts the loss per trade from −0.39R to −0.05R. That's real ranking skill, but not enough to cover costs. Limit-order entries (maker fee) didn't change the verdict (−0.07R on the holdout and final window).
- **Slow lane: positive over 2020–2025** (daily breakouts +0.91R per trade on 64 trades). But 9 trades in a year can't pass a 30-trade holdout. It needs more coins or a longer holdout before it can validate.

Both lanes therefore trade at pilot size on paper (`PERP_PILOT_MAX_NOTIONAL_USD`), which builds a live record without risking real size.


### Update: momentum bursts and per-type selection

Two changes. The fast lane gained the **momentum burst**: join a volatile move as it happens (a wide-range bar, a volume spike, one-sided taker flow, a breakout of the 20-bar range, the higher timeframe agreeing), trailed by 2.5 ATR from entry. And each setup type now gets its own on/off and score threshold, chosen on 2020 – Sep 2025 only (`research/momentumStudy.ts` has the burst study).

**Chosen on the development years:**
- Traded: **1h burst** (every one: 376 development trades, +$2,748 on $10k), **1d breakout** and **1d dip** (the model's top half).
- Off, because even their best threshold lost in development: 15m burst, 15m fade, 15m pullback, 1h fade, 1h pullback.

| Lane | Period | Trades | Win rate | Net R per trade (90% interval) | Net $ on $10k |
|---|---|---|---|---|---|
| fast (1h bursts) | 2020 – Sep 2025 | 228 | 41.7% | +0.11 (−0.04 to +0.29) | +$1,705 |
| fast | holdout Oct 2025 – Jun 2026 | 53 | 39.6% | **+0.25** (−0.17 to +0.71) | +$277 |
| fast | final Jul – Sep 2026 | 15 | 60.0% | **+0.15** (−0.25 to +0.56) | +$141 |
| slow | 2020 – Sep 2025 | 200 | 36.5% | +0.48 (+0.09 to +0.97) | +$6,723 |
| slow | holdout | 25 | 32.0% | +0.02 | +$167 |
| slow | final | 5 | 0% | −0.70 | −$218 |

- **Fast lane:** positive in every period, including the 12 months it never saw. With limit-order entries it's +0.28R. It isn't validated yet only because 68 trades are too few for the 5% lower bound to clear zero.
- **Slow lane:** positive over 2020–25 but flat-to-negative over the last 12 months, on only 30 trades.
- **At $5 risk per trade:** the fast lane's per-trade average is about +$0.55 to +$1.25. Bursts are rare, though: about one every 5–6 days across 5 coins.

## Settings (`bot.env`)

| Setting | Default | Meaning |
|---|---|---|
| `PERP_STRATEGY` | `setups` | `setups` = this trader; `signal` = the older horizon-return trader |
| `PERP_TRADING` | `paper` | `paper` simulates against live perp quotes; `live` sends real orders (needs `TRADING_MODE=live`); `off` disables directional trading |
| `SETUP_MODEL_PATH` | `params/setup_model.json` | The scorer (the pipeline's promoted copy wins when present) |
| `SETUP_FAST_RISK` / `SETUP_SLOW_RISK` | 0.004 / 0.006 | Equity at risk per trade |
| `SETUP_FAST_MAX_POSITIONS` / `SETUP_SLOW_MAX_POSITIONS` | 3 / 3 | Open trades per lane |
| `SETUP_MAX_LEVERAGE` / `SETUP_MAX_ASSET_LEVERAGE` | 3 / 1.5 | Notional caps as multiples of equity |
| `SETUP_DAILY_GOAL_USD` | 100 | Shown on the dashboard next to today's realized P&L. It does not change how the bot trades: chasing a daily target makes traders overtrade. |
| `SETUP_RETRAIN_DAYS` | 7 | Pipeline retraining interval |
| `SETUP_FAST_RISK_USD` / `SETUP_SLOW_RISK_USD` | 0 | Fixed dollars at risk per trade (entry to stop) instead of a share of equity; 0 = use `SETUP_*_RISK` |
| `SETUP_MIN_TARGET_USD` | 0 | Skip trades whose first target pays less than this after the round-trip fee (e.g. 2) |
| `PERP_DAILY_LOSS_FRAC` | 0.10 | Perp daily loss stop: flatten and halt for the UTC day |
| `PERP_PILOT_MAX_NOTIONAL_USD` | 25 | Size cap while a lane is unvalidated |
| `SETUP_RATCHET` | `slow` | The 4h ATR ratchet exit: `off`, `slow`, `fast` or `both` (takes effect at the next retraining) |
| `SETUP_RATCHET_STOP_ATR` / `_BE_ATR` / `_TRAIL_START_ATR` / `_TRAIL_ATR` | 3.5 / 2 / 3.5 / 3 | Initial stop, break-even plus fees, trail start and trail distance, all in 4h ATRs |
| `SETUP_RATCHET_VOL_K` | 0 | Scale the unit by exp(k × the TA network's 4h volatility forecast), clamped 0.67–1.5× (0 = ATR(4h) alone) |
| `SETUP_SPOT_PB` | `off` | The spot pullback setups for the coins where spot leads the perp (`lead_lag.json`); adopt from the `setups-spotpb` sweep (takes effect at the next retraining) |
| `SETUP_SCALE_OUT` | `off` | Scale-out exits: `off`, `slow`, `fast` or `both` (adopt from the `setups-scale` sweep; takes effect at the next retraining) |
| `SETUP_SCALE_R1` / `_F1` / `_R2` / `_F2` / `_TRAIL_ATR` | 1 / 0.33 / 2 / 0.33 / 2.5 | The two steps (R multiple, share of the original position; F2 = 0: one step) and the remainder's trail in ATRs |
| `PERP_LIQ_BUFFER` | 0.2 | The stop may use at most 1 − buffer of the room to liquidation |
| `PERP_MAINT_MARGIN` | 0 | Maintenance margin rate; 0 = half the initial margin implied by the exchange's leverage estimate (else 5%) |

The dashboard's perps panel (`trading`) shows both lanes: open trades with their stops and targets, the queues with scores, recent skips with reasons, recent trades, and today's P&L against the goal.


### Update: per-side burst search

`research/burstParamSearch.ts` searched every burst threshold and exit for longs and shorts separately: bar range, volume spike, taker flow, breakout lookback, the daily-trend rule, the ATR trail and the time stop. Each setting was ranked on 2020 – Jun 2025 and checked on Jul 2025 – Oct 2026.

- **Longs:** all ten best tuning settings were also profitable on the test window (median +0.35R per trade). The bot now uses the top tuning setting: range ≥ 1.5 ATR, volume ≥ 1.5×, at least 55% of volume on the buy side, a 10-bar breakout, a 3.5-ATR trail and a 32-bar time stop. That gives 811 tuning trades at +0.23R and 221 test trades at +0.32R, against +0.13R in both windows for the old settings.
- **Shorts:** the best tuning settings all lost on the test window (median −0.10R), so shorts keep their original thresholds plus the daily-trend rule (`BURST` in `bot/setups/detectors.ts`).
- **Selection:** a setup type is now traded only with real evidence, meaning a development t-statistic of at least 1. With the looser long settings the 15m bursts scraped above zero (t 0.37), lost afterwards, and took position slots from the 1h bursts.

| Fast lane (1h bursts) | Trades | Net R per trade (90% interval) | Net $ on $10k |
|---|---|---|---|
| 2020 – Sep 2025 | 560 | +0.23 (+0.07 to +0.40) | +$6,651 |
| holdout Oct 2025 – Jun 2026 | 92 | +0.06 (−0.27 to +0.43) | +$42 |
| final Jul – Sep 2026 | 39 | +0.90 (−0.24 to +2.35) | +$1,738 |

That's about 0.3–0.4 trades a day. Across the last 12 months combined: 131 trades at about +0.31R, or +0.37R with limit-order entries. The lane is still not validated, because the holdout's 5% bound is below zero, so it trades at pilot size on paper.

### Update: first sweep runs (`research/sweep.ts`)

The coordinate-descent sweep tuned each burst setting in turn on 2020 – Jun 2024, checked it on Jul 2024 – Jun 2025, and kept the final window (Jul 2025 on) unseen until the end.

- **Longs:** no single-setting change beat the current settings, so the sweep stopped after one pass. Final window: 221 trades at +0.32R.
- **Shorts:** the sweep accepted a 10-bar breakout lookback instead of 20. The tuning window went from +0.27R to +0.32R and the check window from +0.13R to +0.15R. On the unseen final window, though, the result went from +0.10R (53 trades) to −0.01R (65 trades). **The change was not applied**, and shorts keep the 20-bar lookback. Tuning and check gains this small fall within the noise for about 60–80 trades.

## Connected to the rest of the bot

The setup trader used to stand alone. It now reads the TA network and the perps SNN, and its results feed the whole-bot replay.

**TA network (history available, tested now)**
- **Walk-forward forecasts:** the TA network's forecasts over the whole history come from a network that walks forward month by month. It trains on the trailing 12 months and forecasts the next month (`npm run research:ta-net-oos`, pipeline step `ta_net_oos`), so a setup's TA network inputs never saw the future.
- **The same network live:** the live setup trader reads that walking network (`ta_net_wf.json`), so live inputs come from the same network the model was trained on. All three heads are passed through ungated; the setup model decides whether they count.
- **Model inputs, only if they help:** P(up 1h), P(up 4h) and the 4h volatility forecast are setup-model inputs, plus copies oriented to the trade's side. The trainer runs the walk-forward twice, with and without them, and keeps them only if they improve the development years (t-statistic of net R per trade across both lanes). Otherwise they are blanked. The model file records the comparison (`groupChoice`), and the status page shows it under `inputs`.
- **Volatility-scaled trail:** fast-lane trails can be multiplied by exp(k × the 4h volatility forecast), clamped to 0.67–1.5× (`VOL_ADAPT` in `bot/setups/detectors.ts`). The trail widens before an expected volatility expansion and tightens before a quiet spell. k is tuned by the `setups-vol` sweep and is off (0) unless the sweep proves it.

**The Librarian (docs/TA_NETWORK.md, "The Librarian")**
- **Model inputs, only if they help:** at the last closed hour, each strategy family's weight (trend, mean-revert, breakout, flat), the continuous playbook position and its disagreement with the knowledge base's rule tally (with copies oriented to the trade's side), and P(regime change within 72 h). In research they come from the Librarian's walk-forward forecasts, live from the same model on the walking TA network's TA row. The `librarian` group is kept on the same terms as the TA network inputs (`groupChoice.librarian`).

**The cross-asset graph network (docs/TA_NETWORK.md, "The cross-asset graph network")**
- **Model inputs, only if they help:** the coin's forecast return relative to the basket over the next 4 and 24 hours and its rank among the coins at the last closed hour (with copies oriented to the trade's side). In research they come from the network's walk-forward forecasts, and live from the same model on every coin's candles. The `xgraph` group is kept on the same terms as the TA network inputs (`groupChoice.xgraph`).

**Cross-coin lead-lag (docs/TA_NETWORK.md, "Cross-coin lead-lag")**
- **Model inputs, only if they help:** the coin's expected move over the next 15 and 60 minutes from the part of BTC's and ETH's recent move it has not made yet, in its own volatility units, for the leader / horizon pairs the study validated (with copies oriented to the trade's side). In research they come from the study's walk-forward fits, and live from its final fit on every coin's 15-minute candles. The `crosslead` group is kept on the same terms as the TA network inputs (`groupChoice.crosslead`). Only coins with a validated leader have a reading, so instead of 80% coverage it needs 300 development setups with one.
- **Exit, only if it pays:** see "The cross-coin lead-lag exit" above.

**Fractal Alignment Engine and waterfall mode (docs/FRACTAL.md)**
- **Model inputs, only if they help:** where the 2018-to-now BTC.D cycle stands on its 2016–2017 parent (progress, phase, time dilation, fit, the projected BTC.D change, weeks to the next parent waterfall) and the waterfall legs (BTC.D against the 55% gate, a USDT.D breakdown, SHIB volume velocity). They are computed point in time for every setup, as the `fractal` group, kept on the same terms as the TA network inputs (`groupChoice.fractal`).
- **Waterfall mode:** once armed and triggered, the lanes take alt longs at 1.5× risk, skip alt shorts and take BTC at 0.5×. These weights multiply the playbook's, capped at 2× in total, inside the lanes' own caps and the liquidation cap.

**Perps SNN (no history, so it is measured as the recordings grow)**
- **Journal:** every setup and trade is written to `data/setups/journal-YYYY-MM-DD.jsonl` with the SNN's 1h and 4h calls, their skill, and the TA network's forecast at that moment.
- **Gate:** the pipeline's `setup_snn` step tests whether trades the SNN agreed with did better. Once at least 150 closed trades show that the trades it disagreed with lose money out of sample, it switches on an agreement gate, which the trader applies at entry. Until then it reports "collecting" (docs/AUTOMATION.md, section 8).

**Whole-bot replay**
- The trainer exports the last 24 months of traded setups with their walk-forward scores (`setup_oos.json`).
- The whole-bot replay (`npm run research:whole-bot`) runs them through the lane book alongside the Kalshi backtester over the recorded days, from one pot of capital with one daily stop.
- The `bot` sweep target tunes the shared settings on the combined daily P&L.

### Update: first run with the TA network connected

The walk-forward export covered May 2019 – Oct 2026: 88 months and 296,635 hourly forecasts.

- **TA network inputs: kept, narrowly.** On the development years across both lanes, the model with them scored a t-statistic of 2.96 (792 trades, +0.24R) against 2.41 without (751 trades, +0.23R).
- **Volatility trail: stays off.** The `setups-vol` sweep found no setting better than 0. With it off, tuning was +0.26R (702 trades), check +0.13R (242) and final +0.28R (274).
- **Fast lane (1h bursts):**

| Fast lane | Trades | Net R per trade (90% interval) | Net $ on $10k |
|---|---|---|---|
| 2020 – Sep 2025 | 671 | +0.19 (+0.06 to +0.32) | +$6,554 |
| holdout Oct 2025 – Jun 2026 | 110 | +0.04 (−0.19 to +0.30) | +$422 |
| final Jul – Sep 2026 | 38 | +1.06 (−0.12 to +2.58) | +$2,328 |

- **What this means:** about the same as before the TA network was connected (holdout +0.06R on 92 trades, final +0.90R on 39). It is still not validated, because the holdout's lower bound is below zero, so the lane still trades at pilot size on paper. With limit-order entries, the last 12 months come to 148 trades at +0.37R (+0.02 to +0.80).
- **Slow lane:** now trades only daily breakouts, at score ≥ 0.7. Development: 123 trades at +0.58R. Holdout and final: 13 trades, too few to judge.
