#!/usr/bin/env bash
# Swap back to the previous release.
set -euo pipefail
[ -L ~/bot/previous ] || { echo "no previous release"; exit 1; }
PREV="$(readlink ~/bot/previous)"
ln -sfn "$(readlink ~/bot/current)" ~/bot/previous
ln -sfn "$PREV" ~/bot/current
sudo systemctl restart kalshi-bot
echo "rolled back to $PREV"
