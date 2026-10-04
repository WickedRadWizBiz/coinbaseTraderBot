#!/usr/bin/env bash
# First-deploy setup on the server. Idempotent and never overwrites anything that exists:
#  - creates ~/bot/bot.env with paper-trading defaults and a fresh random dashboard token
#  - creates ~/bot/data
# The dashboard listens on all interfaces (http://<static-ip>:3000) for now. To lock it down
# later see docs/DEPLOY.md ("Making it more secure").
set -euo pipefail
mkdir -p ~/bot/data
ENV=~/bot/bot.env
if [ ! -f "$ENV" ]; then
  umask 077
  cat > "$ENV" <<ENVEOF
# Created by deploy/ensure-env.sh on first deploy. Edit freely, then: sudo systemctl restart kalshi-bot
TRADING_MODE=paper
DASHBOARD_TOKEN=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
# Open on the static IP for now (no TLS). Set BIND_HOST=127.0.0.1 and remove the next line to lock down.
BIND_HOST=0.0.0.0
ALLOW_NON_LOOPBACK_BIND=true
PORT=3000
ENVEOF
  echo "created $ENV (paper mode). Read the dashboard token with: grep DASHBOARD_TOKEN $ENV"
fi
