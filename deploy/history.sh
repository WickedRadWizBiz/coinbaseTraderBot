#!/usr/bin/env bash
# Historical candle tools on the server (research/history/cli.ts, bundled to dist/history.cjs):
#   ~/bot/current/deploy/history.sh import ~/incoming        # your CSVs (Bittrex, Binance, Yahoo, ...)
#   ~/bot/current/deploy/history.sh binance                  # Binance Vision, every Kalshi crypto asset
#   ~/bot/current/deploy/history.sh coinbase --tfs 15m,1h,1d # Coinbase backfill
#   ~/bot/current/deploy/history.sh tradingview              # one-off: BTC.D / USDT.D / TOTAL history (deploy/tv_dominance.py)
#   ~/bot/current/deploy/history.sh status                   # what is stored
#   ~/bot/current/deploy/history.sh train                    # run / continue the TA network tournament now (hot-swapped)
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f ~/bot/bot.env ] && . ~/bot/bot.env; set +a
export DATA_DIR="${DATA_DIR:-$HOME/bot/data}"
if [ "${1:-}" = "train" ]; then
  shift
  # Through the pipeline, so the result is validated, promoted to data/models and picked up live.
  # A manual run finishes the whole tournament (the daily pipeline spreads it over runs).
  export TA_NET_MAX_ROUNDS_PER_RUN="${TA_NET_MAX_ROUNDS_PER_RUN:-0}"
  exec nice -n 19 node dist/pipeline.cjs --only ta_net --force-ta-net "$@"
fi
if [ "${1:-}" = "tradingview" ]; then
  shift
  # One-off backfill of TradingView's dominance / total-market-cap charts (unofficial client, no
  # login), then imported as index series. Needs python3 with venv (sudo apt install python3-venv git).
  OUT="${DATA_DIR}/incoming/tradingview"
  VENV="$HOME/bot/.venv-tradingview"
  [ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet --upgrade --no-cache-dir git+https://github.com/rongardF/tvdatafeed.git
  "$VENV/bin/python" deploy/tv_dominance.py --out "$OUT" "$@"
  exec node dist/history.cjs import "$OUT"
fi
exec node dist/history.cjs "$@"
