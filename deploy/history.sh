#!/usr/bin/env bash
# Historical candle tools on the server (research/history/cli.ts, bundled to dist/history.cjs):
#   ~/bot/current/deploy/history.sh import ~/incoming        # your CSVs (Bittrex, Binance, Yahoo, ...)
#   ~/bot/current/deploy/history.sh binance                  # Binance Vision, every Kalshi crypto asset
#   ~/bot/current/deploy/history.sh coinbase --tfs 15m,1h,1d # Coinbase backfill
#   ~/bot/current/deploy/history.sh tradingview              # TradingView index history now: BTC.D, USDT.D, TOTAL3, OTHERS.D, RTY (5,000 bars)
#   ~/bot/current/deploy/history.sh tvfetch --out DIR ...    # deploy/tv_history.py in its venv (the daily pipeline calls this)
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
# TradingView through tvdatafeed (unofficial client, no login) in its own venv. Needs python3 with
# venv and git (the deploy installs them: python3-venv git).
tv_venv() {
  VENV="$HOME/bot/.venv-tradingview"
  [ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
  if ! "$VENV/bin/python" -c 'import tvDatafeed' 2>/dev/null; then
    "$VENV/bin/pip" install --quiet --upgrade pip setuptools wheel
    "$VENV/bin/pip" install --quiet --upgrade --no-cache-dir git+https://github.com/rongardF/tvdatafeed.git
  fi
}
if [ "${1:-}" = "tvfetch" ]; then
  shift
  tv_venv
  exec "$VENV/bin/python" deploy/tv_history.py "$@"
fi
if [ "${1:-}" = "tradingview" ]; then
  shift
  # Index history now (5,000 bars of 1d / 4h / 1h), imported as index series. The daily pipeline also
  # does this when a series is missing or short, and keeps the daily bars current.
  OUT="${DATA_DIR}/incoming/tradingview"
  tv_venv
  "$VENV/bin/python" deploy/tv_history.py --out "$OUT" --indexes default "$@"
  exec node dist/history.cjs import "$OUT"
fi
exec node dist/history.cjs "$@"
