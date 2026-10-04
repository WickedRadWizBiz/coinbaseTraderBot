#!/usr/bin/env bash
# First-deploy setup on the server. Idempotent and never overwrites anything that exists:
#  - creates ~/bot/bot.env with paper-trading defaults (dashboard open, no login)
#  - DASHBOARD_PASSWORD in the environment (the deploy passes the GitHub secret of that name, when set)
#    is written into bot.env; the old DASHBOARD_TOKEN line is removed (no longer used)
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
# Optional login for the dashboard: DASHBOARD_PASSWORD=... (empty or missing = no login)
# Open on the static IP for now (no TLS). Set BIND_HOST=127.0.0.1 and remove the next line to lock down.
BIND_HOST=0.0.0.0
ALLOW_NON_LOOPBACK_BIND=true
PORT=3000
ENVEOF
  echo "created $ENV (paper mode, dashboard without login)"
fi
# Keep bot.env's permissions (600) while rewriting lines.
edit_env() { local tmp; tmp="$(mktemp "$ENV.XXXX")"; grep -v -e "$1" "$ENV" > "$tmp" || true; [ -z "${2:-}" ] || printf '%s\n' "$2" >> "$tmp"; chmod 600 "$tmp"; mv "$tmp" "$ENV"; }
grep -q '^DASHBOARD_TOKEN=' "$ENV" && edit_env '^DASHBOARD_TOKEN=' && echo "removed the unused DASHBOARD_TOKEN from $ENV"
if [ -n "${DASHBOARD_PASSWORD:-}" ] && ! grep -qxF "DASHBOARD_PASSWORD=$DASHBOARD_PASSWORD" "$ENV"; then
  edit_env '^DASHBOARD_PASSWORD=' "DASHBOARD_PASSWORD=$DASHBOARD_PASSWORD"
  echo "dashboard password set from the deploy"
fi
true
