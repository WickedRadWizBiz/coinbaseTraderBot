# Kalshi 15-minute crypto bot, v2

This is a rebuild that follows *Your Kalshi Bot vs. an Institutional Trading System*. The old bot's problems weren't a lack of sophistication. It had no sound core underneath the "institutional" modules. v2 is small and deliberately plain:

- one pricing model with a theoretical basis
- one validated meta-model, frozen at runtime
- a fail-closed risk gateway
- an order state machine that only moves positions on fills
- reconciliation against the exchange
- fee-correct PnL
- a persistent kill switch
- an audit log

> Nothing here guarantees profit. Good architecture stops you losing money to bugs and bad sizing. Only an edge that has been tested makes money. Follow the go-live gates below.

## Architecture

```
bot/
  config.ts              env -> validated, deep-frozen config (no runtime mutation, no API to change it)
  fees.ts                Kalshi taker/maker fee formula, round-up to the cent
  kalshi/                REST (Create Order V2 only), WebSocket, signing (RSA-PSS / Ed25519), wire parsing, rate limiter
  marketdata/            order books (snapshot+delta, gap -> resnapshot), CF RTI index tracker, recorder
  model/
    fairValue.ts         digital option on the 60 s settlement average (tie -> YES, partial fixing in final minute)
    metaModel.ts         frozen, versioned neural network with residual on fair value + go-live gates
    features.ts          one feature builder shared by production and research
    calibration.ts       Brier, reliability, Platt
  sizing/kelly.ts        fee-net fractional Kelly; zero size when edge <= 0 (no fallback)
  risk/                  RiskGateway (fails closed), worst-case exposure incl. resting orders, persistent KillSwitch
  oms/                   order state machine, idempotent client_order_id, positions change only on fills
  recon/                 exchange-is-truth reconciliation, fill replay, orphan cancel, break -> halt -> kill
  strategy/              maker quoting (post_only), selective taking, fair-value exits (no % stops)
  paper/                 paper exchange: same gateway interface, queue-aware fills, no bankroll refills
  tca/                   per-fill edge-at-decision and 5/30/60 s markouts
  api/                   authenticated, read-only operator API; kill switch only
  engine.ts, main.ts
research/                offline only: dataset builder, walk-forward meta-model trainer, backtest, DSR/PBO stats
tests/                   node:test suite (fees, Kelly, fair value vs Monte Carlo, OMS, risk, recon, paper, strategy, engine)
web/                     read-only dashboard (React), served by the API
deploy/                  systemd unit, activate/rollback scripts
```

Every order goes down one path. Paper, shadow and live all run the same OMS, risk and reconciliation code; only the `ExchangeGateway` changes.

```
market data ─► fair value ─► meta-model ─► strategy plan ─► RiskGateway.check ─► OMS.submit ─► exchange
                                                                 (fail closed)     (id persisted first)
exchange fills/orders ─► OMS (dedupe by trade id) ─► PositionBook ─► PnL / TCA / audit
reconciler (45 s + on reconnect) ─► replay fills, compare orders/positions ─► halt / kill on break
```

## The meta-model, revised

The old `metaLearningEngine.ts` and `plasticityEngine.ts` (tfjs-node) retrained **online** on pre-fee win/loss labels, and Gemini "amendments" rescaled live TP/SL. None of that could be validated. It is replaced by:

1. **A digital-option fair value.** It prices the actual contract, a 60 s average of the CF RTI against a strike that is itself a 60 s average:
   - variance `σ²(τ − 2A/3)` before the final minute
   - an exact partial-fixing treatment inside the final minute
   - tests check it against a Monte Carlo simulation of the settlement
2. **A small frozen neural network** (`bot/model/metaModel.ts`) that learns a *residual* on the fair value's log-odds from market context (mid, spread, depth imbalance, time left, volatility regime):
   - with L2 regularization it shrinks back to the fair value when there is no signal
   - it is trained **offline only** with purged walk-forward CV by window, and the untouched holdout is used once
   - Platt scaling is applied only when enough independent windows support it
   - the file's SHA-256 is stamped on every decision and order
   - **Candidate features ported from the old model** (`bot/model/featureEngine.ts`) are available to it in four groups:
     - microstructure: order-flow imbalance, trade-flow imbalance, VPIN-style toxicity, microprice drift, depth imbalance, trade intensity
     - momentum/TA on the settlement index: sigma-scaled returns, RSI, MACD histogram, Bollinger %B, Kaufman efficiency, Ichimoku tenkan/kijun distance, realized-vol ratio
     - Coinbase spot lead-lag: basis and spot-minus-index return
     - time of day (only eligible once there are 14+ days of data)

     The offline trainer searches over feature sets (base, base plus each group, all) along with network size. Every variant counts toward the Deflated Sharpe, and holdout permutation importance shows which features actually help. Production and research compute features through the same `FeatureHub`, and a test checks they are identical. Features the old model had that aren't ported (macro goal, trailing state, latency, funding, confluence labels, USDT dominance) had no testable basis for this contract.
3. **Go-live gates enforced in code.** Live mode refuses to start unless the model's validation report shows:
   - at least 1,000 holdout windows
   - a Brier score better than the market mid
   - calibration within 3 pp
   - a fee-inclusive net-edge 95% CI lower bound above 0
   - a deflated Sharpe above 0

With no model file, the identity model (pure fair value) is used. That's fine for paper and shadow, and live mode rejects it.

## Running

```bash
npm ci
npm run check            # typecheck + tests
cp .env.example .env     # set DASHBOARD_TOKEN=$(openssl rand -hex 32)
npm run dev              # paper mode by default
# dashboard: ssh -L 3000:127.0.0.1:3000 <host>, then http://localhost:3000
```

### Modes

- **Paper without Kalshi keys** uses public REST books and trades. Set `ALLOW_PROXY_INDEX=true` to price off Coinbase spot. That has basis risk against the RTI, so it is plumbing only.
- **Shadow** uses `TRADING_MODE=shadow` with a Kalshi key. It gets the authenticated WebSocket (books, trades, lifecycle, CF RTI) and the simulated exchange. This is the "shadow paper" phase.
- **Live** needs all of the following, and all of them are set at deploy time, never via the API:
  - `TRADING_MODE=live`
  - `KALSHI_ENV=prod`
  - `LIVE_TRADING_ACKNOWLEDGED=I_ACCEPT_REAL_MONEY_RISK`
  - a validated `params/model.json`

### Research loop

```bash
npm run research:dataset -- --recordings data/recordings
npm run research:train                                   # -> params/model.candidate.json
npm run research:backtest -- --model params/model.candidate.json --grid 0.01,0.02,0.03 --annotate
```

The backtest reports per-window results. Correlated BTC, ETH and SOL markets that close together count as one observation. It also reports a bootstrap CI of net edge per contract, the Deflated Sharpe for every variant tried, and PBO (CSCV) across the grid. Promoting a candidate is a reviewed PR; see `params/README.md`.

## Guide checklist: what changed

| Guide item | Status |
|---|---|
| Public `0.0.0.0` binding, 75 open routes | Binds `127.0.0.1` by default; a non-loopback bind needs an explicit flag. Every `/api` route needs a bearer token (constant-time compare, lockout). |
| Live toggle via API, raw settings merge, credential-writing endpoints | Removed. There is no settings, credential, restart or reset-state route. Live mode is env-only, checked at startup. |
| Open cancel-all, panic, restart and download routes | Replaced by one authenticated kill switch and a reset that needs a typed phrase and clean reconciliation. |
| Auto-deploy on push to `main` with `npm install` | Replaced. CI runs typecheck, tests and build. Deploy is manual, tag-only, uses `npm ci`, sits behind a GitHub `production` environment, and supports rollback. |
| Gemini writing live parameters | Removed from the runtime. LLMs may help offline (reviews, reports) and must never change a running parameter. |
| `ALWAYS_ON_15M`, profit-target sizing, Kelly fail-open, EV-gate override, $0.50 default price | Removed. Kelly returns zero when edge ≤ 0. The gateway has no override. Missing data blocks trading and pulls quotes. |
| FIX path, and FIX→REST fallback with a new id | Removed. There is one REST order path. Retries reuse the same `client_order_id`, and a timeout queries by id before any resend. |
| Perps / margin | Removed until the core is proven. |
| Online NN, meta-learning, plasticity, hand-set win probability, confluence | Replaced by the fair value plus the frozen, offline-validated meta-model. |
| % TP/SL and trailing stops on binaries | Removed. The bot holds to settlement and exits only when the bid beats fair value by the fee plus a buffer. |
| USDT-dominance, Ichimoku, VPIN gates; trade-ID-tuned gates | Removed. |
| Paper "blowout reset" | Removed. The paper exchange never refills. |
| Cosmetic modules (Avellaneda-Stoikov, jump-diffusion, Kalman, Bayesian Kelly, HRP, Almgren-Chriss, "SR 11-7"), the Python bot, patch scripts, committed state, second lockfile | Deleted. |
| Legacy `/portfolio/orders` | Orders go to `POST /portfolio/events/orders` (V2) with `post_only`, `self_trade_prevention_type`, `expiration_time` and `cancel_order_on_pause`. |
| Risk gateway (fail closed) | `bot/risk/riskGateway.ts`. It checks: per-order, per-window (correlated, no netting), total and daily-loss limits; price collar vs fair value and vs the touch; longshot guard; stale book and index; throttles; time to close. |
| OMS state machine and idempotency | `bot/oms/`. The id is persisted before send. Acceptance is not a fill. Fills are de-duplicated. Exits stay tracked until confirmed. |
| Reconciliation | `bot/recon/reconciler.ts`. Runs every 45 s and on reconnect. Missed fills are repaired, orphans cancelled, and a break halts new risk (and trips the kill switch if it persists). |
| Kill switch | Persists on disk, survives restart, auto-trips on loss limit, repeated order errors, persistent break or a stalled heartbeat. Resting orders also carry an exchange-side `expiration_time` as a dead-man switch. |
| Fee-correct PnL | Exact fee formula with round-up. Uses exchange-reported fees when present. Wins and losses are labelled after fees at settlement. |
| Data recorder, fill simulator, TCA, alerts, audit log | Recorder: `marketdata/`. Fill simulator: `paper/` (queue position, trade-through fills). TCA: `tca/` (markouts). Alerts: Telegram or webhook. Audit log: hash-chained JSONL, checked with `npm run audit:verify`. |
| Tests / CI | 87 tests, including an engine integration test and an end-to-end research pipeline test on synthetic data. |

## Things you must do yourself

1. **Rotate the Kalshi API key now.** Assume the old one is compromised, because it could be overwritten over HTTP. Create a subaccount-restricted key, store it outside the repo, and `chmod 600` it.
2. **Close the firewall.** In Lightsail, leave only SSH open. Reach the dashboard via SSH tunnel or Tailscale.
3. **Protect the `production` environment.** In GitHub settings, require a reviewer on it. The server keeps its own `bot.env`.
4. **Verify wire formats on Kalshi's demo environment before any live dollar.** The docs site was not reachable while this was built, so these follow the guide and the previous adapter:
   - the V2 order payload
   - WebSocket message shapes, especially `cfbenchmarks_value` and its index ids (`INDEX_ID_MAP`)
   - the fills and positions fields
   - series fee fields

   All parsing lives in `bot/kalshi/wire.ts` and `bot/kalshi/ws.ts`.
5. **Confirm the fee multipliers per series.** Read them from the series API; live mode refuses a series whose fees were not fetched.

## Go-live roadmap (from the guide)

| Phase | Gate to exit |
|---|---|
| 0 Lockdown | Port scan shows only SSH. Live flag only at deploy. Old key revoked. |
| 1–2 Core | Tests pass. On Kalshi **demo**, 500+ orders with zero reconciliation breaks, orphans or duplicates. A kill-switch drill cancels everything within 5 s and survives restart. |
| 3 Data & model | At least 1,000 windows recorded. Out-of-sample, fee-inclusive net edge 95% CI lower bound above 0. Deflated Sharpe above 0. Brier better than market. Calibration within ±3 pp. |
| 4 Shadow | The same gates on new data. Max drawdown under 15%. Maker markouts no worse than half the quoted edge. |
| 5 Pilot | $50–$100, 1–2 contracts per order, 2% window cap, $5 daily loss limit. At least 200 fills, live edge at least 50% of paper edge, zero breaks. |
| 6 Ramp | Double capital at most once per clean month. |

## Legacy code

The previous implementation was removed in v2. That covers `server_app.ts`, the `*Engine.ts` modules, `kalshiFixEngine.ts`, the Python bot, the `fix_*`/`patch*`/`check_*` scripts, the old `src/` frontend, `bun.lock`, and committed state such as `audit_memory.json`. Git history still has it.
