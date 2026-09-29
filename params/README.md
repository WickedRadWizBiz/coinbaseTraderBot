# Model parameters

`model.json` (when present) is the frozen, versioned meta-model loaded at
startup. Without it the bot uses the identity model: the digital-option fair
value, unchanged. That's fine for paper/shadow, and live mode refuses it.

A candidate goes through these steps before it's promoted:

1. `npm run research:dataset`: build labelled rows from `data/recordings`.
2. `npm run research:train`: purged walk-forward training. This writes
   `model.candidate.json` with a holdout validation report.
3. `npm run research:backtest -- --model params/model.candidate.json --annotate`:
   a fee-inclusive backtest that adds `netEdgeCiLow` and `deflatedSharpe`.
4. If `validation.passed` is true, open a PR that copies the candidate to
   `model.json`. Review it, merge it, tag a release and deploy.

The live gates are enforced in code (`bot/model/metaModel.ts`):

- at least 1,000 holdout windows
- Brier score better than the market mid
- calibration within 3 pp
- net-edge 95% CI lower bound above 0
- deflated Sharpe above 0
