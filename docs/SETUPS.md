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
- **Sizing:** each trade risks a set share of equity between entry and stop (`SETUP_FAST_RISK` 0.4%, `SETUP_SLOW_RISK` 0.6%), or a fixed dollar amount (`SETUP_FAST_RISK_USD`, `SETUP_SLOW_RISK_USD`), scaled 0.5×–1.5× by the score. Caps: per coin (`SETUP_MAX_ASSET_LEVERAGE`), in total (`SETUP_MAX_LEVERAGE`), and half the exchange's leverage for the market (liquidation stays well beyond the stop).
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

The dashboard's perps panel (`trading`) shows both lanes: open trades with their stops and targets, the queues with scores, recent skips with reasons, recent trades, and today's P&L against the goal.
