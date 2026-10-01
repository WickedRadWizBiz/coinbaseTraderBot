#!/usr/bin/env bash
# Point ~/bot/current at a release and restart the service. The previous
# target is kept in ~/bot/previous; `deploy/rollback.sh` swaps back.
set -euo pipefail
REL="${1:?usage: activate.sh <release-dir>}"
mkdir -p ~/bot
DIR="$(cd "$(dirname "$0")" && pwd)"
bash "$DIR/ensure-env.sh"
# Install / refresh the systemd unit from the release (needs passwordless sudo, as on Lightsail).
if ! cmp -s "$DIR/kalshi-bot.service" /etc/systemd/system/kalshi-bot.service 2>/dev/null; then
  sudo cp "$DIR/kalshi-bot.service" /etc/systemd/system/kalshi-bot.service
  sudo systemctl daemon-reload
  sudo systemctl enable kalshi-bot >/dev/null 2>&1 || true
fi
if [ -L ~/bot/current ]; then ln -sfn "$(readlink ~/bot/current)" ~/bot/previous; fi
ln -sfn "$REL" ~/bot/current
sudo systemctl restart kalshi-bot
sleep 3
systemctl is-active --quiet kalshi-bot || { echo "service failed to start; rolling back"; bash "$(dirname "$0")/rollback.sh"; exit 1; }
# The dashboard must answer (any HTTP status, e.g. 401 without the token, means it is up).
for i in 1 2 3 4 5 6 7 8 9 10; do
  code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/status || true)"
  [ "$code" != "000" ] && break
  sleep 2
done
[ "${code:-000}" != "000" ] || { echo "dashboard not answering on :3000; rolling back"; bash "$DIR/rollback.sh"; exit 1; }
echo "activated $REL (dashboard HTTP $code)"
