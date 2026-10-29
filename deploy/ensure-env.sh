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
# Training now runs on GitHub Actions (AUTO_TRAIN=remote, the default: .github/workflows/train.yml) and this
# server only loads the models. A bot.env that pins an old default (windows, background) is moved over; any
# other choice (daily, off) is left alone. The old default of 8 strikes per hourly event becomes 4 (CPU).
for old in windows background; do
  if grep -qx "AUTO_TRAIN=$old" "$ENV"; then edit_env "^AUTO_TRAIN=$old\$" 'AUTO_TRAIN=remote'; echo "AUTO_TRAIN: $old -> remote in $ENV"; fi
done
# The old default exit (hold: every contract rode to settlement, never sold for profit) becomes the ratchet exit.
if grep -qx 'EXIT_POLICY=hold' "$ENV"; then edit_env '^EXIT_POLICY=hold$' 'EXIT_POLICY=confluence_ratchet'; echo "EXIT_POLICY: hold -> confluence_ratchet in $ENV"; fi
if grep -qx 'CATALOG_STRIKES_PER_EVENT=8' "$ENV"; then edit_env '^CATALOG_STRIKES_PER_EVENT=8$' 'CATALOG_STRIKES_PER_EVENT=4'; echo "CATALOG_STRIKES_PER_EVENT: 8 -> 4 in $ENV"; fi
# Entries tuned for quick exits (fresher quotes, a bigger maker discount, time to sell before the close): a bot.env
# that pins the old default of one of these gets the new one; any other value is left alone.
for pair in 'STRATEGY_REPRICE_SEC=30>10' 'STRATEGY_FAST_MOVE_SIGMAS=3>2' \
  'STRATEGY_MAKER_BUFFER=0.01>0.02' 'STRATEGY_MAKER_BUFFER_RANGE=0.005,0.015>0.015,0.03' \
  'ENTRY_WINDOW_15M=840,120>840,300' 'ENTRY_WINDOW_HOURLY=3300,300>3300,600'; do
  old=${pair%%>*}; key=${old%%=*}; new="$key=${pair#*>}"
  if grep -qxF "$old" "$ENV"; then edit_env "^${old//./\\.}\$" "$new"; echo "$key: ${old#*=} -> ${new#*=} in $ENV"; fi
done
# Order budget (owner-approved Oct 22, a fifth of Kalshi's Basic-tier write budget) and the 20 s quote life it makes room
# for: a bot.env pinned to the old values gets the new ones; any other value is left alone.
for pair in 'RISK_MAX_ORDERS_PER_MIN=30>120' 'STRATEGY_ORDER_TTL_SEC=60>20'; do
  old=${pair%%>*}; key=${old%%=*}; new="$key=${pair#*>}"
  if grep -qxF "$old" "$ENV"; then edit_env "^${old//./\\.}\$" "$new"; echo "$key: ${old#*=} -> ${new#*=} in $ENV"; fi
done
# One exit-curve mode for paper and live (the owner, Oct 23: live has to behave identically to paper): SINUOUS_EXIT_PAPER
# is no longer read and is removed; a SINUOUS_EXIT pinned to an old default (gate, rest) becomes cross; any other
# choice (monitor, off) is left alone.
if grep -q '^SINUOUS_EXIT_PAPER=' "$ENV"; then edit_env '^SINUOUS_EXIT_PAPER='; echo "SINUOUS_EXIT_PAPER removed from $ENV (SINUOUS_EXIT sets paper and live)"; fi
for old in gate rest; do
  if grep -qx "SINUOUS_EXIT=$old" "$ENV"; then edit_env "^SINUOUS_EXIT=$old\$" 'SINUOUS_EXIT=cross'; echo "SINUOUS_EXIT: $old -> cross in $ENV"; fi
done
# Paper behaves exactly like live (the owner, Oct 28): a bot.env pinned to the old paper-only defaults (order sizes
# PAPER_ORDER_FRAC 0.1 / 0.10 and PAPER_ORDER_USD 10, exploration entries, 12 training trades an hour, the vault left
# out of paper's bankroll) drops them, so the new defaults (off) apply; any other value is left alone.
for old in 'PAPER_ORDER_FRAC=0.1' 'PAPER_ORDER_FRAC=0.10' 'PAPER_ORDER_USD=10' 'PAPER_EXPLORE=true' 'PAPER_TRAINING_TRADES_PER_HOUR=12' 'VAULT_IN_PAPER=false'; do
  if grep -qxF "$old" "$ENV"; then edit_env "^${old//./\\.}\$"; echo "${old%%=*}=${old#*=} removed from $ENV (paper behaves like live)"; fi
done
if [ -n "${DASHBOARD_PASSWORD:-}" ] && ! grep -qxF "DASHBOARD_PASSWORD=$DASHBOARD_PASSWORD" "$ENV"; then
  edit_env '^DASHBOARD_PASSWORD=' "DASHBOARD_PASSWORD=$DASHBOARD_PASSWORD"
  echo "dashboard password set from the deploy"
fi
true
