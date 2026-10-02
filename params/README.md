# Model parameters

`model.json` (when present) is the frozen, versioned meta-model loaded at
startup. Without it the bot uses the identity model: the digital-option fair
value, unchanged. That's fine for paper/shadow, and live mode refuses it.

A candidate goes through these steps before it's promoted:

1. `npm run research:dataset`: build labelled rows from `data/recordings`.
2. `npm run research:train`: purged walk-forward training. This writes
   `model.candidate.json` with a holdout validation report.
3. `npm run research:backtest -- --model params/model.candidate.json --annotate`:
   a fee-inclusive backtest that adds `netEdgeCiLow`, `deflatedSharpe`,
   `dsrProbability` and `pbo`.
4. If `validation.passed` is true, open a PR that copies the candidate to
   `model.json`. Review it, merge it, tag a release and deploy.

The live gates are enforced in code (`bot/model/metaModel.ts`):

- at least 1,000 holdout windows
- Brier score better than the market mid
- calibration within 3 pp
- net-edge 95% CI lower bound above 0
- deflated Sharpe above 0
- log loss better than the beta-calibrated market mid, Diebold–Mariano p < 0.05
- no price or time-to-close calibration slice off by more than 1.5¢ beyond sampling noise
- deflated Sharpe probability above 0.95 (every configuration tried counts)
- PBO below 0.2 when several variants were compared

## Macro calendar

`calendar.json` (optional) lists scheduled CPI, FOMC, NFP and PCE releases for
the calendar features: `[{ "ts": "<ISO time>", "kind": "CPI" }, ...]`.
`calendar.example.json` shows the format; its dates are placeholders, so copy
the official BLS, Federal Reserve and BEA schedules. Without the file, the
calendar features read as unavailable.

## TA network

`ta_net.json` is the TA network (`bot/ta/taNet.ts`, docs/TA_NETWORK.md), trained with
`npm run research:ta-net` on Binance spot history for BTC, ETH, SOL, XRP and DOGE
(Aug 2017 – Oct 2026). Only heads that passed the blind walk-forward test speak live
(`up_1h` and `vol_4h` in this file). The server's pipeline retrains it on every crypto
asset Kalshi lists and promotes the result to `data/models/ta_net.json`, which is preferred
over this file.
