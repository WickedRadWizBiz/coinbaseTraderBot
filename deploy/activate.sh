#!/usr/bin/env bash
# Point ~/bot/current at a release and restart the service. The previous
# target is kept in ~/bot/previous; `deploy/rollback.sh` swaps back.
set -euo pipefail
REL="${1:?usage: activate.sh <release-dir>}"
mkdir -p ~/bot
DIR="$(cd "$(dirname "$0")" && pwd)"
bash "$DIR/ensure-env.sh"
# Install / refresh the systemd unit from the release (needs passwordless sudo, as on Lightsail).
# The unit is written for user ubuntu and /usr/bin/node: fill in this server's user, home and the node
# that `npm ci` just built the native modules with (nvm or NodeSource).
NODE_BIN="$(command -v node)"
UNIT="$(mktemp)"
sed -e "s#/usr/bin/node#$NODE_BIN#" -e "s#/home/ubuntu#$HOME#g" -e "s#^User=ubuntu#User=$(id -un)#" "$DIR/kalshi-bot.service" > "$UNIT"
if ! cmp -s "$UNIT" /etc/systemd/system/kalshi-bot.service 2>/dev/null; then
  sudo cp "$UNIT" /etc/systemd/system/kalshi-bot.service
  sudo systemctl daemon-reload
  sudo systemctl enable kalshi-bot >/dev/null 2>&1 || true
fi
rm -f "$UNIT"
if [ -L ~/bot/current ]; then ln -sfn "$(readlink ~/bot/current)" ~/bot/previous; fi
ln -sfn "$REL" ~/bot/current
sudo systemctl restart kalshi-bot
diag() { echo "--- service status ---"; systemctl status kalshi-bot --no-pager -l 2>&1 | head -20 || true; echo "--- last log lines ---"; sudo journalctl -u kalshi-bot -n 80 --no-pager 2>&1 || true; }
fail() { echo "$1; rolling back"; diag; bash "$DIR/rollback.sh" || true; exit 1; }
echo "node $NODE_BIN ($("$NODE_BIN" -v)); unit: $(grep ^ExecStart /etc/systemd/system/kalshi-bot.service)"
sleep 3
# The dashboard must answer (any HTTP status, e.g. 401 without the token, means it is up).
# Up to 3 min (a small instance loading the models can be slow); a crashed service fails at once.
for i in $(seq 1 90); do
  code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/status || true)"
  [ "$code" != "000" ] && break
  systemctl is-active --quiet kalshi-bot || [ "$(systemctl show -p SubState --value kalshi-bot)" = "auto-restart" ] || fail "service is not running"
  sleep 2
done
[ "${code:-000}" != "000" ] || fail "dashboard not answering on :3000"
echo "activated $REL (dashboard HTTP $code)"
# HTTPS in front of the dashboard (never fails the deploy).
bash "$DIR/https.sh" || true
