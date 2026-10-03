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
- **Sizing:** each trade risks a set share of equity between entry and stop (`SETUP_FAST_RISK` 0.4%, `SETUP_SLOW_RISK` 0.6%), scaled 0.5×–1.5× by the score. Caps: per coin (`SETUP_MAX_ASSET_LEVERAGE`) and in total (`SETUP_MAX_LEVERAGE`).

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

## Results

See the latest section below; it's rewritten after every real-data run.

## Settings (`bot.env`)

| Setting | Default | Meaning |
|---|---|---|
| `PERP_STRATEGY` | `setups` | `setups` = this trader; `signal` = the older horizon-return trader |
| `PERPS_TRADING` | `off` | `paper` simulates against live perp quotes; `live` sends real orders (needs `TRADING_MODE=live`) |
| `SETUP_MODEL_PATH` | `params/setup_model.json` | The scorer (the pipeline's promoted copy wins when present) |
| `SETUP_FAST_RISK` / `SETUP_SLOW_RISK` | 0.004 / 0.006 | Equity at risk per trade |
| `SETUP_FAST_MAX_POSITIONS` / `SETUP_SLOW_MAX_POSITIONS` | 3 / 3 | Open trades per lane |
| `SETUP_MAX_LEVERAGE` / `SETUP_MAX_ASSET_LEVERAGE` | 3 / 1.5 | Notional caps as multiples of equity |
| `SETUP_DAILY_GOAL_USD` | 100 | Shown on the dashboard next to today's realized P&L. It does not change how the bot trades: chasing a daily target makes traders overtrade. |
| `SETUP_RETRAIN_DAYS` | 7 | Pipeline retraining interval |
| `PERP_DAILY_LOSS_FRAC` | 0.10 | Perp daily loss stop: flatten and halt for the UTC day |
| `PERP_PILOT_MAX_NOTIONAL_USD` | 25 | Size cap while a lane is unvalidated |

The dashboard's perps panel (`trading`) shows both lanes: open trades with their stops and targets, the queues with scores, recent skips with reasons, recent trades, and today's P&L against the goal.
