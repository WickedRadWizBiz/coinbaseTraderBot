#!/usr/bin/env bash
# Point ~/bot/current at a release and restart the service. The previous
# target is kept in ~/bot/previous; `deploy/rollback.sh` swaps back.
set -euo pipefail
REL="${1:?usage: activate.sh <release-dir>}"
mkdir -p ~/bot
if [ -L ~/bot/current ]; then ln -sfn "$(readlink ~/bot/current)" ~/bot/previous; fi
ln -sfn "$REL" ~/bot/current
sudo systemctl restart kalshi-bot
sleep 3
systemctl is-active --quiet kalshi-bot || { echo "service failed to start; rolling back"; bash "$(dirname "$0")/rollback.sh"; exit 1; }
echo "activated $REL"
