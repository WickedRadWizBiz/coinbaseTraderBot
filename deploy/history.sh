#!/usr/bin/env bash
# Historical candle tools on the server (research/history/cli.ts, bundled to dist/history.cjs):
#   ~/bot/current/deploy/history.sh import ~/incoming        # your CSVs (Bittrex, Binance, Yahoo, ...)
#   ~/bot/current/deploy/history.sh binance                  # Binance Vision, every Kalshi crypto asset
#   ~/bot/current/deploy/history.sh coinbase --tfs 15m,1h,1d # Coinbase backfill
#   ~/bot/current/deploy/history.sh status                   # what is stored
#   ~/bot/current/deploy/history.sh train                    # retrain the TA network now (hot-swapped)
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f ~/bot/bot.env ] && . ~/bot/bot.env; set +a
export DATA_DIR="${DATA_DIR:-$HOME/bot/data}"
if [ "${1:-}" = "train" ]; then
  shift
  # Through the pipeline, so the result is validated, promoted to data/models and picked up live.
  exec nice -n 19 node dist/pipeline.cjs --only ta_net --force-ta-net "$@"
fi
exec node dist/history.cjs "$@"
