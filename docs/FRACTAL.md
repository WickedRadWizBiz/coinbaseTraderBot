# Fractal Alignment Engine and waterfall mode

**The thesis:** since 2018, BTC dominance (BTC.D) has been replaying the shape of its 2016–2017 cycle, slowed down several times and on a compressed scale. The 2016–2017 parent had four stages:

1. a long BTC-dominant stretch;
2. a first waterfall;
3. a relief rally;
4. a final waterfall into the alt season.

The engine measures where the 2018-to-now cycle (the child) stands on that parent. It works point in time, so training and the live bot see the same numbers. Waterfall mode is the bot's stance for the parent's final waterfall. The operator can arm it only after BTC.D first hits 55%.

Code: `bot/macro/fractalEngine.ts` (the engine), `bot/macro/waterfall.ts` (trigger, gate, switch, policy), `bot/macro/macroSeries.ts` (point-in-time inputs), `bot/macro/macroService.ts` (live).

## The engine

**Data.** BTC.D daily closes from the history store. These are TradingView's `CRYPTOCAP:BTC.D` (5,000 daily bars back, fetched by the pipeline), spliced with the bot's own hourly bars so the series stays current. They are compared on weekly closes.

**Alignment.** Dynamic time warping of the child's weekly closes onto the parent's:

- Each child week advances the parent by 0, 1 or 2 weeks. That allows local time dilation from 0.5× up to 16×, with at most 16 child weeks on one parent week.
- The child's first week may sit anywhere in the first 15% of the parent.
- The end is open: the latest child week lands on whichever parent week it matches best.
- Levels are compared after a map, `child = a + b × parent`. The child moves on a compressed scale, so the map is refitted on the aligned pairs, with `b` kept in [0.35, 2.5].
- From the second pass on, shape counts as well as level: each series' trend over the same span of parent time. A flat stretch of the child cannot then sit on a steep stretch of the parent.

**State.** At any time the engine reports:

- **Parent week matched to now:** its date, and progress through the parent (0–1).
- **Phase:** the parent's swings come from a zigzag (6-point reversals); falls of 15 points or more are waterfalls. Each swing has a base (drift under 15% of the swing) and a steep part. The phase counts as inside the steep part only when the parent is there AND the child has itself moved 15% of the swing on its own scale. On a flat base, the exact position cannot be identified, and the engine says "base", not "waterfall".
- **Time dilation:** child time per parent time, since 2018 and over the last 26 weeks.
- **Fit:** correlation and mean error after the map, over the whole path and the last year. Fit is the engine's own reliability signal: low on flat stretches, high once the cycle has shown its structure.

**Projection.** The parent's remaining path, mapped onto the child's scale and anchored at today's level. Time is stretched by the geometric mean of the overall and recent dilation. From it the engine reports:

- BTC.D in 30, 90 and 180 days;
- the next waterfall's projected start, end and depth;
- the lowest projected level ahead and when;
- when the projection crosses the 55% gate.

**Before 2019, nothing.** The child needs a year of weeks before any state is given. Without BTC.D history for 2016–2017 the engine does not run, and the dashboard says so.

**What it is not.** The engine is a map of the cycle, not a forecaster with a track record. `npm run research:fractal` reports how far the projection can be trusted:

- today's alignment;
- the alignment week by week since 2019;
- the projection's walk-forward error and directional hit rate against "no change", overall and when the fit is high.

## Where the model sees it

The setup scorer has a new optional input group, `fractal`:

- **Engine:** progress, phase flags (base, fall, waterfall), share of the swing done, overall and recent dilation (log), fit (whole and last year), recent error, projected BTC.D change over 30 and 90 days, weeks to the next waterfall.
- **Orientation:** an altcoin flag, plus a copy of the 90-day projection oriented by side and asset. For an altcoin a falling BTC.D is the tailwind; for BTC it is the reverse.
- **Waterfall legs:** BTC.D against the gate, USDT.D breakdown, SHIB volume velocity.

The trainer computes these point in time for every historical setup (2018 on) and keeps the group only if it raises the development years' score. That is the same rule as the TA network and character groups. The result is in the setup model's `groupChoice.fractal`.

The Librarian (oracle-trained strategy head) and the TA network's daily context are the next consumers.

## Waterfall mode

**The gate.** BTC.D closing at or below `WATERFALL_GATE` (55%), on the way down from a peak at least 5 points higher within two years, is "the first 55% hit". It is latched and persisted (`DATA_DIR/waterfall.json`), and only then can the mode be armed: the ARM button on the dashboard's Capital & Risk panel. The server refuses to arm before the gate. Disarming always works.

**The trigger**, triangulated from four legs:

| Leg | When it is on |
|---|---|
| gate | BTC.D's last daily close is below the gate |
| fractal | the fit is at least `WATERFALL_MIN_FIT` (0.8) over the whole path and the last year, and now is inside a parent waterfall or one is projected within `WATERFALL_LEAD_WEEKS` (8) |
| usdt | USDT.D breakdown: the lowest close of the last 7 days is under the lowest of the 30 days before, and the last close is under its 30-day average (stablecoin share falling: money going to risk) |
| shib | SHIB volume velocity: the last 7 days' average daily quote volume is at least `WATERFALL_SHIB_VELOCITY` (2) × the median day of the 90 days before (retail speculation arriving) |

It fires on gate + fractal + (usdt or shib).

**What changes.** The mode affects new entries only. Open positions keep their exits.

| Level | Tennis | Kalshi binaries | Perps setup lanes |
|---|---|---|---|
| off | — | — | — |
| armed (trigger off) | no new entries | total risk cap lowered to `WATERFALL_KALSHI_MAX_FRAC` (12.5%) of the bank | — |
| triggered | no new entries | no new entries | alt longs at `WATERFALL_ALT_LONG_MULT` (1.5×) risk, alt shorts not opened, BTC at `WATERFALL_BTC_MULT` (0.5×) |

In the triggered level:

- The perps weights multiply the playbook's, capped at 2× in total. The lanes' notional caps, the optimal f cap and the liquidation cap (docs/SETUPS.md) still bind.
- The alt-long boost tapers to 1× as BTC.D falls from the gate toward the engine's projected low.
- Alt longs stop opening within `WATERFALL_LOW_BUFFER_PTS` (3) of the projected low, which is where the parent's waterfall ended.

Level changes, the gate latch, arming and disarming are written to the audit log (`waterfall`).

**Phase 2** is the core / stack position with an exit schedule by BTC.D zone. It belongs to the 5.1 work, which stays backtest / shadow-only until it beats the baseline.

## Settings (`bot.env`)

| Setting | Default | Meaning |
|---|---|---|
| `FAE_PARENT_FROM` / `FAE_PARENT_TO` | 2016-01-01 / 2018-01-01 | The parent window |
| `FAE_CHILD_FROM` | 2018-01-01 | The child's start |
| `WATERFALL_GATE` | 55 | BTC.D gate (%) |
| `WATERFALL_MIN_FIT` | 0.8 | Fit the fractal leg needs |
| `WATERFALL_LEAD_WEEKS` | 8 | Fractal leg: a parent waterfall projected within this many weeks |
| `WATERFALL_SHIB_VELOCITY` | 2 | SHIB leg threshold |
| `WATERFALL_KALSHI_MAX_FRAC` | 0.125 | Kalshi total risk cap while armed |
| `WATERFALL_ALT_LONG_MULT` / `WATERFALL_BTC_MULT` | 1.5 / 0.5 | Perps risk multipliers when triggered |
| `WATERFALL_LOW_BUFFER_PTS` | 3 | Alt longs stop opening this close to the projected low |

The setup trainer reads the same `FAE_*` / `WATERFALL_*` settings, so training and the live bot agree.
