# Cortex-like SNN (bot/snn)

This implements *From Flat SNN to Cortex-Like Predictor: Verified PDF Review and a Multi-Level SNN Design
for the Kalshi Bot*, extended so that **the SNN informs and the MLP decides**. The SNN never touches the
hard limits: whitelist, position caps, daily loss stop and kill switch all sit outside it.

## Roles

| | SNN (multilayered spiking network, `bot/snn`) | MLP (original network, `bot/model`) |
|---|---|---|
| Job | Direction and fair-value bias | Fair value, and **whether to take each trade** |
| Inputs | TA library on the Coinbase spot USD pair (indicators and rule/confluence scores), perp premium/funding, Kalshi books; for tennis, the 4 confluence signals (momentum, flow, depth, cross-market) plus the live score | The same feature catalog **plus the SNN's outputs** (`snn_up_15m/1h/4h`, `snn_up_h`, `snn_move_h_z`, `snn_bias`, `snn_dir_agree`) |
| Learns | Continuously, 24/7, traded or not: direction heads from realised moves, readouts from settlements | Daily, offline, on the recordings plus the logged SNN outputs |
| Output | P(up) over 15m / 1h / 4h per asset, P(up) over 5 min per tennis match, expected move, and p_snn per contract | p_model, plus a take/skip probability for each would-be trade |

## Three isolated networks

There are three separate SNNs, one per contract type. Each has its own worker thread, parameters (time
constants matched to its horizons), health monitor, governor, lateral inhibition, checkpoint directory
(`data/snn/<domain>/`) and model file (`snn_<domain>.json`). **They never read each other's data**, and
inhibition / salience only compete inside one network.

| Network | Columns | Inputs | Graded on | Read by |
|---|---|---|---|---|
| crypto | asset × {15m, 1h} | TA on the spot USD pair, perp premium/funding, the Kalshi contract book | settled Kalshi contracts (snapshot + settlement) and its direction calls | the MLP + take/skip head |
| perps | asset × {1h, 4h} | the same asset-level data, no contract channels | its direction calls (perps never settle) | the perps model |
| tennis | one per live match | the 4 signals (momentum, flow, depth, cross-market), live score, book | settled match contracts and its 5-minute direction calls | the tennis model |

Each decision model reads **only its own network** (`SNN_CROSS_FEED=false`, the default). With
`SNN_CROSS_FEED=true` a model may also read the other crypto-side network, and only for horizons its own
network lacks (MLP ← perps 4h, perps ← crypto 15m). Contract scores always come from the network that
owns the contract.

**Confidence.** The networks still do the same snapshot-and-settlement analysis as the MLP. Each call
carries its network's own graded record, logged with it and fed to its decision model:

| Field | Meaning | Feature |
|---|---|---|
| skill | 1 − Brier/0.25 of the last ≤ 500 graded direction calls (0 = coin flip; NaN below 50) | `snn_skill_h`, `snn_skill_1h`, `snn_skill_4h`, tennis `snn_skill` |
| calConf | calibration confidence of the contract readout on settled snapshots (1 = slope 1) | `snn_cal_h`, tennis `snn_cal` |
| contractSkill | 1 − Brier/0.25 of the contract readout on settled snapshots | `snn_contract_skill_h` |
| surpriseRatio | prediction error now vs its normal level (> 1 = confused right now) | `snn_surprise_h` |
| G | governor level (0 calm … 1 over-active) | `snn_gov_h` |

The perps network has no settlements, so its confidence is its direction skill alone. The tennis network
cannot be replayed (there is no recorded score feed to replay), so it learns live only and its
checkpoints persist across restarts.

**Crypto.** The fair-value MLP and its take/skip head (`bot/model/takeModel.ts`) read the crypto network's calls.
- **Take/skip head:** for every entry the edge would place, it estimates P(trade wins). The trade is taken only if that clears the side's break-even (price + fee).
- **Validation gate:** the gate switches on only after its out-of-fold held-out check beats the fair value alone.

**Perps** read the perps network's `snn_up_1h`, `snn_up_4h`, `snn_skill_1h` and `snn_skill_4h`.

**Tennis.**
- The tennis model (`bot/tennis/tennisFair.ts`, an MLP or boosted trees, whichever validates better) learns fair P(A wins) from the 4 signals, the score, the book and the tennis network (its P(A), direction call and confidence).
- Once validated (100+ matches, held-out Brier better than the market's), an entry needs fair − price ≥ `TENNIS_FAIR_MIN_EDGE`.
- Live scores come from the Live Tennis API (`TENNIS_SCORE_FEED=livetennis`, key in `LIVE_TENNIS_API_KEY`). The free tier allows 100 calls a day: one slate call covers every match, and it is only refreshed on a price move, an exit, or after `TENNIS_SCORE_IDLE_MIN`.

**Logging and the legacy blend.**
- Each network's calls are written to the recordings every minute as `snn` events tagged with the network (`d: crypto | perps | tennis`), each call as `[key, pUp, expSignedMove, labelled, skill, calConf, contractSkill, surpriseRatio, G]`. That is what the decision models train on. Events logged before the split (no `d`) are read as: 15m → crypto, 4h → perps, 1h → both.
- The old end-of-pipeline blend (`SNN_MODE=blend`, α ≤ 0.25) is still available but no longer needed. In the default `shadow` mode the SNN runs, logs and feeds the MLP without blending.

## Starting each network: a tournament of three (docs/EVOLUTION.md)

Each network starts as three identical networks (same seed and weights) whose shape-preserving knobs (learning rates, gains, time constants) differ by up to ±10%. They fight for fitness on simulated trades, and the elite becomes the network:
- **Crypto and perps:** step `snn-<domain>-pbt` replays the recordings (`research/snnPbt.ts`). There are 3 days of initial learning, then a tournament after every day. The elite's knobs are used for training, backfill and live. It reruns every 30 days.
- **Tennis:** the tournament runs **live** (`bot/snn/population.ts`), because there is no recorded score feed. All three see every input, and the bot reads the elite. After every 30 graded matches the worst restarts from the elite's state with mutated knobs.

## Every formula, where it lives, and how it is checked

All equations are in `bot/snn/formulas.ts` in their **corrected** form. Each one is asserted in
`tests/snnFormulas.test.ts` against hand-computed values and against an independent stdlib-only
Python reference (`research/snn_reference.py` → `tests/fixtures/snn_golden.json`, tolerance 1e-5;
regenerate with `npm run research:snn-golden`).

| # | Formula (corrected) | Code | Status |
|---|---|---|---|
| LIF | V_{t+1} = V∞ + (V_t − V∞)e^{−Δt/τ_m}, V∞ = E_L + R·I | `lifStep` | adopt |
| ALIF | θ = θ0 + β_a·a; a_{t+1} = a_t·e^{−Δt/τ_a} + s_t; spike if V ≥ θ, reset V_r | `alifThreshold`, `alifAdapt`, `alifStep` | adopt |
| Izhikevich | v' = 0.04v² + 5v + 140 − u + I, u' = a(bv − u); two 0.5 ms v half-steps; RS (0.02, 0.2, −65, 8), FS (0.1, 0.2, −65, 2), CH (c = −50, d = 2) | `izhikevichStep`, `IZH` | defer |
| HH (fixed) | β_n = 0.125·e^{−(V+65)/80}; α_n = 0.01(V+55)/(1 − e^{−(V+55)/10}) | `hhBetaN`, `hhAlphaN` | reject (reference) |
| Nernst–Planck (fixed) | J = −D(∂C/∂x + zF/(RT)·C·∂V/∂x); Einstein D = μk_BT/\|q\| | `nernstPlanckFlux`, `einsteinD` | reject (reference) |
| Cable | λ²∂²V/∂x² = τ_m∂V/∂t + V, λ = √((d/4)R_m/R_i) | `cableLambda`, `cableResidual` | reject (reference) |
| Poirazi (fixed) | y = g(Σ_j α_j·s(Σ_{i∈D_j} w_i x_i − ϑ_j)) | `poirazi`; live in `Column.step` | adopt |
| dCaAP | s(x) = exp(−(x − θ)²/2w²) | `dcaap` | defer (`SNN_DCAAP`) |
| Double exponential | t_pk = τ_dτ_r/(τ_d − τ_r)·ln(τ_d/τ_r); K = 1/(e^{−t_pk/τ_d} − e^{−t_pk/τ_r}); g = ḡK(e^{−t/τ_d} − e^{−t/τ_r}) | `dexpPeakTime`, `dexpNorm`, `dexpKernel`, `dexpTraceStep` | adopt (AMPA 5 s, NMDA 90 s, GABA 10 s) |
| NMDA Mg block | G(V) = 1/(1 + ([Mg]/3.57)·e^{−0.062V}) | `nmdaGate`, `toMvEquivalent` | adopt (learning gate + NMDA class) |
| Gap junction | I = g_j(V1 − V2); CC = R2/(R2 + Rj) = g_j/(g_j + g2) | `gapCurrent`, `couplingCoefficientR/G` | defer (`SNN_GAP_JUNCTIONS`) |
| Postnov | I_syn = (k_s − δG_m)(z − z0), I_ast = γG_m (γ term excluded in the governor) | `postnovISyn`, `postnovIAst` | reference |
| Governor | τ_G·Ġ = −G + sat(k1ρ̂ + k2z_e + k3f_sat + k4ΔB); η_eff = η(1 − δG); gain × (1 − δ′G) | `governorStep`, `etaEff`, `columnGain` | adopt |
| BCM | θ_M = ⟨y²⟩/ρ0 or (ȳ/y0)^p·ȳ; ẇ = ηxy(y − θ_M) | `bcmThetaIC`, `bcmTheta1982`, `bcmDw` | adopt (health metric) |
| Minimal triplet STDP | r1, o1, o2 traces; post: Δw⁺ = A3⁺r1·o2(t−ε); pre: Δw⁻ = −A2⁻(ρ̄)o1, A2⁻(ρ̄) = A2⁻(ρ̄/ρ0)^p; Δw = η_eff·G(V_post)·(Δw⁺ + Δw⁻), \|Δw\| ≤ κ, w ∈ [w_min, w_max] | `tripletTraces`, `tripletDw`, `a2MinusSlide`, `gatedUpdate` | adopt at S6 |
| Two-speed weights | ẇ_f = plasticity − (w_f − w_s)/τ_c; ẇ_s = ε(w_f − w_s) (exact solution) | `twoSpeedStep`, `twoSpeedHalfLife` | adopt |
| Readout delta rule | Δw = η(y_k − p_k)φ_k, capped (per-contract tag) | `readoutDelta`, `Readout.settle` | adopt (S1) |
| Rao–Ballard (fixed precision) | r ← r + (k1/σ²)Uᵀf′ᵀe + (k1/σ_td²)(r_td − r) − (k1/2)g′(r); U ← U + (k2/σ²)f′ᵀe·rᵀ − k2λU; \|e\| ≤ e_max | `pcPredict`, `pcUpdate`, `pcStep`, `clipNorm`, `pcLambdaMax` | adopt (S4) |
| Wilson–Cowan | τ_EĖ = −E + (k_E − r_EE)S_E(c1E − c2I + P); τ_Iİ = −I + (k_I − r_II)S_I(c3E − c4I + Q); S(x) = 1/(1 + e^{−a(x−θ)}); c1 = 12, c2 = 4, c3 = 13, c4 = 11, a_e = 1.2, θ_e = 2.8, a_i = 1, θ_i = 4, r = 1, k_E = 0.97, k_I = 0.98; RK2 with Δt ≤ τ/10 | `wcDeriv`, `wcStepRk2`, `WC_PARAMS` | defer (`SNN_WILSON_COWAN`) |
| Fast-sigmoid surrogate | ∂S/∂U = 1/(1 + k\|U\|)², k = 25 | `fastSigmoidSurrogate` | offline training |
| Salience | r_iⁿ/(σⁿ + Σ_j r_jⁿ) | `divisiveNormalization` | adopt (S5, shadow ranking) |
| Strike monotonicity | isotonic (PAV) projection of P(index > K) across strikes | `isotonic` | adopt (S1) |
| Blend and confidence | p_final = (1 − αc)p_model + αc·p_snn; c = c_cal·min(1, S0/S_t)·(1 − δ′G) | `blend`, `surpriseConfidence`, `SnnBlender` | adopt |
| Scores | Brier; multi-strike ranked probability score; calibration slope | `brier`, `rankedProbabilityScore`, `calibrationSlope` | adopt |

## Architecture (per column = one whitelisted market, e.g. BTC-15m)

| Level | Model | Size | Learning |
|---|---|---|---|
| L0 encoding | crypto: send-on-delta on the index (3/6/12 bp) and the Kalshi mid (±1¢), plus 8-band population codes of 24 inputs (TA library ×2 timeframes, rule/confluence scores, perp, returns, USDT.D, ATM Kalshi book). Tennis: deltas on P(A) plus 15 inputs (4 signals, score, breaks, progress, score model, book). Both feed LIF τ 2 s | 200 crypto / 128 tennis (widened from the PDF's 64 to carry these inputs) | none |
| L1 dendritic | Poirazi: 6 branches × 16 synapses, sigmoid branches low-passed at τ ∈ {5, 30, 120} s, LIF soma; AMPA-like + NMDA-like (gated) classes | 48 | offline e-prop surrogate; S6 triplet × NMDA gate × governor |
| L2/3 | ALIF E (τ_m 10 s, τ_a 300 s) + LIF I (τ_m 3 s), 10% recurrent, CSR, event-driven; cross-column lateral inhibition; 64 error units | 128 E + 32 I | S6 triplet (E→E) with NMDA gate; inhibitory plasticity off |
| PC pathway | U1: L2/3 → L1 (48 × 128), U0: L1 → L0 (64 × 48), tanh predictors | — | offline pretraining; S6 online with precision 1/σ² |
| L5 readout | logistic on EWMA L2/3 rates + L1 rates + pooled d×rate (~200 features) | 1 per column | per-contract tags + delta rule (η ≈ 1e-4, capped), two-speed weights |
| Governor | first-order low-pass G ∈ [0, 1] | 1 per column | rule-based |
| Direction head | logistic on the column state; label = price higher after the column's horizon (15m / 60m / 240m; 5 min for tennis) | 1 per column | delta rule on every minute's tag once its horizon passes, 24/7 (η 2e-3, capped), two-speed weights |

**Columns.**
- Crypto network: one per asset × {15m, 60m} (`BTC-15m`, `BTC-60m`, …). Up to `SNN_MAX_COLUMNS`, default 18.
- Perps network: one per asset × {60m, 240m}, in its own network (so `BTC-60m` exists in both, independently).
- Tennis network: one per live match (`TEN:<event>`), created and removed with the match. Up to 8.
- Crypto and perps columns are fed every second from asset-level data, whether or not anything trades. So the direction heads keep learning around the clock.
- 15-minute contracts are scored on the crypto 15m column, hourly ladders on the crypto 60m column.
- Time constants per network (`domainParams`): crypto keeps the PDF's values; perps run 3–5× slower (τ_A 30 min, branch τ up to 10 min, a call every 5 min); tennis faster (τ_A 2 min, a call every 30 s).

The clock is Δt = 1 s of market time, run in a `worker_threads` worker (`bot/snn/worker.ts`, bundled to
`dist/snnWorker.cjs`). Readouts have a 200 ms deadline: on a timeout, α = 0 for that tick. A latency p99 above
150 ms skips the vote. On the default sizes the measured cost is about 0.3 ms per column per market-second.
Within a step the order is: inputs → synaptic currents → dendrites → soma → spikes → traces → plasticity →
governor → PC → readout features. State is struct-of-arrays typed arrays. Exact exponential decays are
precomputed, and slow accumulators use Float64. The seeded xoshiro128** PRNG state is checkpointed.

**Determinism.** Each column's connectivity is seeded from `seed ^ hash(key)`, and iteration order is fixed.
The same tick log gives bit-identical outputs, and a checkpoint → restore → continue run equals an
uninterrupted one. The worker and the in-process runtime agree exactly. All of this is tested in
`tests/snn.test.ts`.

**Checkpoints.** `data/snn/<domain>/snn-<version>-<ts>.json` is written every `SNN_CHECKPOINT_EVERY_MIN` and at
shutdown, and the newest 5 are kept. A corrupt newest file rolls back to the previous one, and a version
mismatch is refused. A checkpoint holds weights (fast and slow), thresholds, θ_M, traces, the tags awaiting
settlement, G, PC precisions, the PRNG state and the version hash. After a gap longer than 120 s, transient
state (voltages, traces) is reset while weights are kept. Replay of missed ticks is not implemented: the
network warms up again from live data.

## Staging and ablations

`SNN_STAGE` S0…S6 sets which mechanisms run. Each stage adds one mechanism to the one before.
Deferred mechanisms are separate flags.

| Stage | Adds | Compared against |
|---|---|---|
| S0 | frozen LIF reservoir + online logistic readout (decaying trace) | plain online logistic regression on raw features |
| S1 | per-contract tags + proper-scoring readout + strike monotonicity | S0 |
| S2 | Poirazi dendritic L1 | point-LIF L1 with the same synapses (equal parameter count) |
| S3 | AMPA/NMDA/GABA classes + ALIF | single τ, plain LIF |
| S4 | predictive coding + surprise → c | S3, and realized-vol → c |
| S5 | lateral inhibition → salience (shadow ranking) | ranking by readout edge \|p_snn − mid\| |
| S6 | online triplet/BCM × NMDA gate × governor, online PC | frozen S5 |
| deferred | Wilson–Cowan, gap junctions, Izhikevich CH, dCaAP | EWMA-vol regime, BTC–ETH correlation, burst counter, 2-branch Poirazi XOR |

`npm run research:snn-ablation` runs this protocol:
- prequential walk-forward replay with strict timestamps;
- the settlement event as the unit of evidence;
- a paired per-event Brier Δ with a day-block bootstrap 95% CI;
- a pre-registered grid of at most 20 configs per mechanism, with every config reported.

A mechanism is accepted only if all of these hold:
- **(a)** CI(Δ) < 0;
- **(b)** calibration slope within 0.9–1.1;
- **(c)** correlation with p_model below 0.7;
- **(d)** blended Brier better than p_model;
- **(e)** latency and health within band;
- **(f)** fee-aware paper P&L not worse.

The design expects most mechanisms to fail, and that is the system working.

`npm run research:snn-train` runs three steps:
1. PC pretraining.
2. Truncated surrogate-gradient (e-prop) training of the L1 branches.
3. An L2 logistic readout fit on a training window, then out-of-sample evaluation on the next window.

Both scripts take `--domain crypto|perps`. The crypto network is judged on settled contracts as above. The
perps network is judged on its own graded direction calls: the baseline is the column's prequential
up-rate (a no-skill forecaster), and calls are clustered per column-hour so overlapping horizons are not
counted as independent events. The automated pipeline runs both and promotes `snn_crypto.json` and
`snn_perps.json` (docs/AUTOMATION.md).

## Health (freeze learning and drop to shadow on breach)

The thresholds below are implemented in `bot/snn/health.ts`. The reference is taken after 3 h of running,
unless the model file ships one.

| Metric | Threshold | What happens |
|---|---|---|
| Firing rate per level | outside [0.2×, 5×] of reference for more than 5 min | freeze |
| E/I input ratio | outside x/÷2 of a 2 h-adapting reference | freeze |
| BCM θ_M | outside [0.5×, 2×] of initial, or drifting faster than 0.5 of reference per hour | freeze |
| Saturated weights | 5% or more | freeze |
| ‖w_f − w_s‖/‖w_s‖ | 0.1 or more | freeze |
| G ≥ 0.9 | 10% or more of the day | freeze |
| G stuck at a bound | more than 1 h | alert |
| Prediction-error z | above 6 | clip |
| Prediction-error z | above 10 for 3 steps | freeze PC updates |
| Same top salience column | more than 90% of 6 h | alert |
| Readout reliability slope | outside 0.8–1.2 | shadow only, so the readout can still recalibrate |
| NaN | any | restore last good state |
| Latency p99 | above 150 ms | skip vote |

Learning resumes after 30 min back within band.

## Configuration

`SNN_MODE` (off | **shadow** | blend), `SNN_STAGE` (default S5), `SNN_CRYPTO` / `SNN_PERPS` / `SNN_TENNIS`
(each network on/off), `SNN_<CRYPTO|PERPS|TENNIS>_STAGE` (default `SNN_STAGE`; tennis S3),
`SNN_<CRYPTO|PERPS|TENNIS>_MODEL_PATH` (default `params/snn_<domain>.json`), `SNN_CROSS_FEED` (default false),
`SNN_COLUMNS` (whitelist), `SNN_MAX_COLUMNS`, `SNN_CHECKPOINT_DIR`, `SNN_CHECKPOINT_EVERY_MIN`, `SNN_WORKER`,
`SNN_TIMEOUT_MS` (≤ 200), `SNN_LATENCY_SKIP_P99_MS`, `SNN_ALPHA_MAX` (≤ 0.25), `SNN_MIN_EVENTS`,
`SNN_READOUT_ETA`, `SNN_SEED`, `SNN_TARGET_SCALING`, and the deferred flags `SNN_WILSON_COWAN`,
`SNN_GAP_JUNCTIONS`, `SNN_IZHIKEVICH_CH`, `SNN_DCAAP`.

The legacy blend uses the crypto network only. **α is earned.** It is the grid α* ∈ [0, 0.25] that minimises blended Brier over the last ≤ 2000 settled
scanned contracts, with at least 200 events. It is adopted only when the event-clustered day-block CI of
Brier(blend) − Brier(model) is entirely below 0.

**Dynamic target scaling.** This is conservative only. The hunt take-profit distance is scaled into
[0.85, 1] from surprise and G, at most one step per 15 min, and only in blend mode.

**Asset choice.** The salience vector is logged as a shadow ranking (`/api/snn`). It never adds assets.

## Honest limits

These are the PDF's own limits:
- There is no published evidence that biological fidelity beats simple baselines on financial prediction
  net of fees.
- Surprise is largely a volatility proxy.
- Settlement events, not strikes, bound statistical power.
- Frozen weights decay under non-stationarity, while online plasticity trades stability for adaptivity.

Expect S1–S3 to hold most of whatever value exists. If the "cortex" ends up as a well-regularised nonlinear
feature extractor with a biologically inspired stability toolkit, that still counts as success.


## Health fixes (October 2026)

- **E/I balance no longer freezes the crypto network all night.** The reference was a single 3-hour snapshot taken at startup (a US afternoon). As activity fell overnight the excitatory/inhibitory input ratio drifted to 0.32x of it, outside the +/-30% band, and all learning froze from 03:26 UTC on; the frozen readout could not fix its calibration (slope 2.0), so the network stayed in shadow. The reference now follows a 2-hour geometric average of the measured ratio (it tracks the session) and the band is x/÷2, so a sudden imbalance within minutes still freezes learning; runaway or dead layers are still caught by the firing-rate bands.
- **The perps network was silent.** Its slow 1h/4h inputs drive layer 1 about 6x less than crypto's, and at the shared layer-2 threshold the excitatory and inhibitory rates were exactly 0 from the start, so its readouts never updated. Perps columns now have threshold homeostasis (`ipLow` / `ipHigh` / `ipStep` / `ipMin` in `domainParams('perps')`): every minute a column whose layer-2 rate stays below 1e-4 lowers its E thresholds by 2%, down to 0.15x, and raises them back above 5e-3. The thresholds are saved in checkpoints. The crypto parameters are unchanged (the new keys are absent there), so its version hash and checkpoint are kept; the perps network restarts fresh (it had learned nothing).
- **Timeouts.** Both networks missed the 150 ms readout deadline (p99 155-163 ms) on the CPU-throttled server; each unit now reports `workerBusy` and the bot exposes a CPU profile (`/api/debug/profile`) to find the load. Measured on the server (October 6): each worker was only 3-4 % busy (about 40 ms of compute per step); the round trip was lost to the main thread (event-loop p99 80 ms, behind one fsync'd rewrite of the whole order state per quote change and serialized WebSocket inflate) and to the JIT warm-up after every restart (the first steps took over 200 ms and held p99 at the 200 ms deadline for the next 10 minutes). Fixed at those causes: order state writes are coalesced, the Kalshi socket no longer uses permessage-deflate, the first 30 steps after a start are not counted toward the band, and each unit reports `computeP99Ms` (worker compute) next to `p99Ms` (round trip): the difference is queueing.
