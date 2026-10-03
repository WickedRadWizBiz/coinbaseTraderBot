# Deploying to Lightsail

## How it works now (open on the static IP, auto-deploy)

- **Every push to `main` deploys.** Opening a PR only runs CI (typecheck, tests, build). When the PR is merged, the **Deploy** workflow tests and builds again, uploads the release to the server and restarts the bot. No manual step.
- The dashboard is at **http://54.145.7.203:3000/** (the Lightsail static IP). It asks for the dashboard token.
- A bad release rolls itself back: if the service doesn't start, or the dashboard doesn't answer on port 3000 after the restart, the previous release is put back.
- Each release lives in `~/releases/<name>` on the server (the 5 newest are kept). `~/bot/current` points at the live one.
- Models, recordings and state are in `~/bot/data` and survive every deploy.

### One-time setup (only if the old bot's repo secrets are not already in this repo)

1. **GitHub secrets** (repo Settings → Secrets and variables → Actions): `LIGHTSAIL_HOST` (`54.145.7.203`), `LIGHTSAIL_USERNAME` (`ubuntu`), `LIGHTSAIL_SSH_KEY` (the private key), and optionally `LIGHTSAIL_PORT`.
2. **Lightsail firewall:** in the instance's Networking tab, add a TCP rule for port 3000 (the previous bot already had it).
3. **Server needs** Node 22, and `ubuntu` must have passwordless `sudo` (the Lightsail default).
4. Merge the PR. The first deploy creates `~/bot/bot.env` for you, in **paper** mode, with a fresh random dashboard token. Read it with:
   `ssh ubuntu@54.145.7.203 grep DASHBOARD_TOKEN ~/bot/bot.env`

If the old bot is running under the same `kalshi-bot` service name, the first deploy replaces it. Its `~/bot/bot.env` and `~/bot/data` are kept, and the new bot starts with them. If `~/bot/current` is a real directory instead of a link, move it aside once (`mv ~/bot/current ~/bot/old-current`) before the first deploy.

### Everyday commands (on the server)

| What | Command |
|---|---|
| Logs | `journalctl -u kalshi-bot -f` |
| Status | `systemctl status kalshi-bot` |
| Roll back to the previous release | `bash ~/bot/current/deploy/rollback.sh` |
| Change settings | edit `~/bot/bot.env`, then `sudo systemctl restart kalshi-bot` |
| Redeploy without a code change | Actions tab → Deploy → Run workflow |
| Deploy a tagged release | same, entering the tag (e.g. `v2.1.0`) |
| Import history CSVs | `ssh ubuntu@54.145.7.203 mkdir -p ~/incoming`, `scp *.csv ubuntu@54.145.7.203:~/incoming/`, then `bash ~/bot/current/deploy/history.sh import ~/incoming` |
| Download / refresh history now | `bash ~/bot/current/deploy/history.sh binance` and `... coinbase` (the daily pipeline does this too) |
| One-off BTC.D / USDT.D history from TradingView | `bash ~/bot/current/deploy/history.sh tradingview` (needs `sudo apt install python3-venv git` once; docs/TA_NETWORK.md) |
| See stored history | `bash ~/bot/current/deploy/history.sh status` |
| Seed history shipped with the code | `deploy/seed/history/` (Yahoo daily BTC, ETH, SOL, XRP, DOGE back to 2016–2020); the daily pipeline imports it once. It only fills days Binance and Coinbase don't cover |
| Retrain the TA network now | `bash ~/bot/current/deploy/history.sh train` |

### Live trading is a separate switch

The deploy never changes `TRADING_MODE`. A new server starts in `paper`. Going live is done by hand in `~/bot/bot.env`.

### Connecting the prediction and perps APIs (live)

1. **Key:** in Kalshi's account settings, create an API key and download its private key. Copy the private key to the server (`scp key.pem ubuntu@54.145.7.203:~/.kalshi/private_key.pem`), then `chmod 600 ~/.kalshi/private_key.pem`. One key works for both the prediction API and the perps REST API (a separate perps key is optional).
2. **Edit `~/bot/bot.env`:**
   ```
   TRADING_MODE=live
   KALSHI_ENV=prod
   LIVE_TRADING_ACKNOWLEDGED=I_ACCEPT_REAL_MONEY_RISK
   KALSHI_KEY_ID=<your key id>
   KALSHI_PRIVATE_KEY_PATH=/home/ubuntu/.kalshi/private_key.pem
   PERP_TRADING=live
   PERP_HEDGE=live
   # Optional: trade binary contracts even though the model hasn't passed validation (your risk).
   LIVE_ALLOW_UNVALIDATED_MODEL=true
   # Optional: a separate perps key instead of the one above.
   # KALSHI_PERPS_KEY_ID=...
   # KALSHI_PERPS_PRIVATE_KEY_PATH=...
   ```
3. **Restart and check:** `sudo systemctl restart kalshi-bot`, then `journalctl -u kalshi-bot -f`.
   - `GET /margin/enabled says margin trading is not enabled` means Kalshi hasn't switched perps on for the account yet (it is rolling out member by member). Perp orders are rejected until it is. The prediction side still trades.
   - Perps trade from the margin balance. Moving money from the event-contract balance to margin needs Kalshi's transfer, which isn't available through the API yet, so do it on the website.

**What stays on while live, whatever the settings:**
- the risk limits, the daily loss stops and the kill switch
- the exchange's own status and maintenance schedule: no new entries while trading is paused, during maintenance, or in the 10 minutes before a scheduled window
- price-grid snapping (orders always land on the market's valid prices)
- reconciliation against the exchange
- for perps, the setup lanes size by risk per trade, at pilot size (`PERP_PILOT_MAX_NOTIONAL_USD`) while a lane isn't validated

## Making it more secure (later)

Each step is independent. Do as many as you like.

1. **Hide the dashboard from the internet.** In `~/bot/bot.env` set `BIND_HOST=127.0.0.1` and delete `ALLOW_NON_LOOPBACK_BIND=true`, restart. Reach it with `ssh -L 3000:127.0.0.1:3000 ubuntu@54.145.7.203`, then open http://127.0.0.1:3000/. Close port 3000 in the Lightsail firewall.
   - Alternative: keep it reachable but behind HTTPS, with a reverse proxy (e.g. Caddy) in front of the loopback port, or put the box on Tailscale.
2. **Restrict SSH** to your own IP in the Lightsail firewall.
3. **Stop deploying on every push.** Set the repository **variable** `AUTO_DEPLOY` to `false`. Pushes then only run CI; deploys happen from Actions → Deploy → Run workflow with a release tag.
4. **Require approval for deploys.** Settings → Environments → `production` → Required reviewers. Every deploy (automatic or manual) then waits for a reviewer.
5. **Rotate the dashboard token** by editing `DASHBOARD_TOKEN` in `~/bot/bot.env` (at least 32 random characters, `openssl rand -hex 32`) and restarting.
6. **Use a dedicated deploy key.** Create a separate SSH key just for deploys, and replace `LIGHTSAIL_SSH_KEY`.

None of these needs a code change.
