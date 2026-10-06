// Entry point. Wires the components; all behaviour lives in the modules.

import { ExchangeStatusMonitor } from './kalshi/exchangeStatus';
import { setBalancePrecision } from './fees';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Alerter, AlertSink, TelegramSink, WebhookSink } from './alerts/alerter';
import { createApi } from './api/server';
import { AuditLog } from './audit/auditLog';
import { ConfigError, loadConfig, publicConfig, type Config } from './config';
import { Engine } from './engine';
import { KalshiSigner } from './kalshi/auth';
import { KalshiRest } from './kalshi/rest';
import type { ExchangeGateway } from './kalshi/types';
import { KalshiWs } from './kalshi/ws';
import { MarketData, Recorder } from './marketdata/marketData';
import { MetaModel } from './model/metaModel';
import { loadVolProfile, type VolProfile } from './model/volSeasonality';
import { loadCalendar } from './model/calendar';
import { ModelHealth } from './model/modelHealth';
import { directionalConviction, type TaNetView } from './strategy/taConviction';
import { setTaNetEnsemble, TaNetEnsemble, taNetView } from './ta/taNetEnsemble';
import { assetFeatureMap } from './model/featureEngine';
import { ClockSkewMonitor } from './risk/clockSkew';
import { BreakEven, EquityGuard } from './risk/equityGuard';
import { PerpHedger } from './perps/hedger';
import { PerpModel } from './perps/perpSignal';
import { PerpTrader } from './perps/perpTrader';
import type { DirectionalTrader } from './perps/hedger';
import { SetupTrader } from './setups/setupTrader';
import { SetupJournal } from './setups/journal';
import { compressOldRecordings, recordingsUsage } from './marketdata/recordingFiles';
import { DEFAULT_LANES } from './setups/lanes';
import { PaperPerpExchange } from './perps/paperPerp';
import { KalshiPerpsRest, type PerpGateway } from './perps/perpRest';
import { BalanceMonitor, type MonitorState } from './vault/balanceMonitor';
import { Vault } from './vault/vault';
import { readJson } from './util/persist';
import { Oms } from './oms/oms';
import { PaperExchange } from './paper/paperExchange';
import { KillSwitch } from './risk/killSwitch';
import { RiskGateway } from './risk/riskGateway';
import { Reconciler } from './recon/reconciler';
import { Tca } from './tca/tca';
import { createSnnFleet } from './snn';
import { VolModel } from './model/volModel';
import { activeTaNet, setTaNet, setTaNetContextSource, TaNet, TaNetRuntime } from './ta/taNet';
import { FillModel } from './tca/fillModel';
import { TennisScoreClient } from './tennis/liveTennisApi';
import { TennisFairModel } from './tennis/tennisFair';
import { AutoTrainer, resolveModelPaths } from './autotrain';
import { logger } from './util/log';
import { RunControl } from './control';
import { TrainingSupervisor } from './training/supervisor';
import { SettlementSweeper } from './paper/settlementSweeper';
import { DEFAULT_STREAK, StreakScaler } from './risk/streakScaler';

const log = logger('main');

async function main(): Promise<void> {
  let cfg: Readonly<Config>;
  try {
    cfg = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      log.error(`configuration invalid: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
  setBalancePrecision(cfg.kalshiBalancePrecision);
  fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
  const audit = new AuditLog(path.join(cfg.dataDir, 'audit'));
  audit.write('startup', { pid: process.pid, node: process.version, config: publicConfig(cfg as Config) });

  const sinks: AlertSink[] = [];
  if (cfg.alertTelegramToken && cfg.alertTelegramChatId) sinks.push(new TelegramSink(cfg.alertTelegramToken, cfg.alertTelegramChatId));
  if (cfg.alertWebhookUrl) sinks.push(new WebhookSink(cfg.alertWebhookUrl));
  const alerter = new Alerter(sinks, audit);

  // Model: frozen, versioned, validated offline. Identity (pure fair value) if no file. The
  // automated pipeline's promoted copies (AUTO_TRAIN_DIR) win over params/ and are hot-swapped.
  const modelPaths = resolveModelPaths(cfg);
  let model: MetaModel;
  if (fs.existsSync(modelPaths.mlp)) {
    model = MetaModel.load(modelPaths.mlp);
    log.info(`meta-model ${model.id} from ${modelPaths.mlp}`);
  } else {
    log.warn(`no model params at ${modelPaths.mlp}; using identity model (pure fair value)`);
    model = MetaModel.identity();
  }
  if (cfg.mode === 'live') {
    const blockers = cfg.liveAllowUnvalidated ? [] : model.liveBlockers();
    if (cfg.liveAllowUnvalidated && model.liveBlockers().length) log.warn(`LIVE_ALLOW_UNVALIDATED_MODEL=true: trading binary contracts live with model ${model.id} although it is not validated (${model.liveBlockers().join('; ')})`);
    // Other live books (perps, tennis) run on their own gates; the risk gateway keeps rejecting every
    // binary crypto order while the model is unvalidated, so the process only refuses to start when
    // there is nothing else to trade live.
    const otherLive = cfg.perps.trading === 'live' || cfg.perps.hedge === 'live' || (cfg.tennis.enabled && cfg.tennis.live);
    if (blockers.length && !otherLive) {
      log.error(`refusing to start live: model ${model.id} is not validated: ${blockers.join('; ')}`);
      process.exit(3);
    }
    if (blockers.length) log.warn(`binary crypto trading blocked (model ${model.id} not validated: ${blockers.join('; ')}); perps/tennis trade live on their own gates`);
  }

  // Intraday volatility profile: applied to fair value only if enabled AND its own
  // out-of-sample validation showed fair-value accuracy improved.
  let volProfile: VolProfile | undefined;
  const vp = loadVolProfile(modelPaths.vol);
  if (vp && cfg.strategy.volSeasonality) {
    if (vp.validation?.improved) {
      volProfile = vp;
      log.info(`applying intraday volatility profile ${vp.version}`);
    } else {
      log.warn(`vol profile ${vp.version} not applied: validation did not show improvement`);
    }
  }

  let signer: KalshiSigner | undefined;
  if (cfg.kalshiKeyId && cfg.kalshiPrivateKeyPath) {
    try {
      signer = KalshiSigner.fromFile(cfg.kalshiKeyId, cfg.kalshiPrivateKeyPath);
    } catch (e) {
      // Paper trading does not need the key: keep running on public data rather than crash-looping.
      if (cfg.mode === 'live') throw e;
      log.error(`${(e as Error).message}; file ${cfg.kalshiPrivateKeyPath}. Paper trading continues without the key (anonymous REST polling, rate limited). Re-save the key file and restart the bot.`);
      alerter.notify('warn', 'kalshi-key', `Kalshi private key at ${cfg.kalshiPrivateKeyPath} could not be read; running unsigned in paper mode`);
    }
  }
  const clock = new ClockSkewMonitor(cfg.clockSkewMaxMs || 2000, cfg.clockSkewWarnMs);
  const rest = new KalshiRest({ baseUrl: cfg.restBaseUrl, signer, subaccount: cfg.kalshiSubaccount, onServerDate: (d, s, r) => clock.observe(d, s, r) });
  const indexIds = Object.keys(cfg.indexIdMap);
  const ws = signer ? new KalshiWs(cfg.wsUrl, signer, indexIds) : undefined;
  if (!signer) log.warn('no Kalshi API key (KALSHI_KEY_ID + KALSHI_PRIVATE_KEY_PATH): order books are polled over anonymous REST, which Kalshi rate limits hard; add the key even for paper trading');
  const md = new MarketData(cfg, rest, ws, new Recorder(path.join(cfg.dataDir, 'recordings')));
  // Recordings grow by a day file per day: older days are gzipped (about 10x smaller) so months of them
  // fit on disk, and a low-disk alert fires before writes would fail.
  const recDir = path.join(cfg.dataDir, 'recordings');
  const maintainRecordings = async () => {
    try {
      if (cfg.autoTrain.recordingsGzipAfterDays > 0) {
        const done = await compressOldRecordings(recDir, cfg.autoTrain.recordingsGzipAfterDays);
        if (done.length) log.info('recordings compressed', { days: done });
      }
      const u = recordingsUsage(recDir);
      if (u.freeBytes !== undefined && u.freeBytes < cfg.autoTrain.recordingsMinFreeGb * 1e9) {
        alerter.notify('warn', 'recordings-disk', `Low disk: ${(u.freeBytes / 1e9).toFixed(1)} GB free; recordings use ${(u.bytes / 1e9).toFixed(1)} GB over ${u.days} days (RECORDINGS_MIN_FREE_GB=${cfg.autoTrain.recordingsMinFreeGb})`);
      }
    } catch (e) { log.warn('recordings maintenance failed', { error: String(e) }); }
  };
  void maintainRecordings();
  setInterval(() => void maintainRecordings(), 3_600_000).unref();

  const paper = cfg.mode === 'live'
    ? undefined
    : new PaperExchange(path.join(cfg.dataDir, 'paper_exchange.json'), cfg.paperBankrollUsd, (t) => md.books.get(t), (t) => md.feesFor(t));
  const gateway: ExchangeGateway = paper ?? rest;

  const kill = new KillSwitch(path.join(cfg.dataDir, 'kill_switch.json'), audit, alerter);
  const oms = new Oms({ gateway, audit, statePath: path.join(cfg.dataDir, 'oms_state.json'), feesFor: (t) => md.feesFor(t), subaccount: cfg.kalshiSubaccount });
  kill.bindCancelAll((reason) => oms.cancelAll(reason));

  const recon = new Reconciler({
    gateway, oms, audit, alerter,
    getMarket: (t) => rest.getMarket(t),
    onSettled: (t, r) => md.recordResult(t, r),
    onPersistentBreak: (reason) => void kill.engage(reason, 'recon'),
  });
  const risk = new RiskGateway(cfg.risk);
  const vault = new Vault(cfg.vault, path.join(cfg.dataDir, 'vault.json'));
  const balanceMonitorPath = path.join(cfg.dataDir, 'balance_monitor.json');
  const balanceMonitor = new BalanceMonitor(readJson<MonitorState>(balanceMonitorPath) ?? {});
  const tca = new Tca(path.join(cfg.dataDir, 'tca'), (t) => md.books.get(t)?.mid());
  const equityGuard = new EquityGuard({ ddScaleAt: cfg.strategy.ddScaleAt, weeklyLossPause: cfg.strategy.weeklyLossPause, dailyGoalUsd: cfg.vault.dailyGoalUsd }, path.join(cfg.dataDir, 'equity_guard.json'));
  // Dashboard PLAY / STOP and the paper training override (persisted).
  const control = new RunControl(path.join(cfg.dataDir, 'control.json'));
  // Kill-switch override (paper and live): loss brakes de-risk instead of halting.
  const trainingOverride = () => control.killOverride;
  const perpsStreak = new StreakScaler(DEFAULT_STREAK, path.join(cfg.dataDir, 'streak_perps.json'));
  const perpsBreakEven = new BreakEven(path.join(cfg.dataDir, 'perps_break_even.json'));
  let perpsPaper: PaperPerpExchange | undefined;
  const modelHealth = new ModelHealth({ minWindows: cfg.strategy.modelHealthMinWindows }, path.join(cfg.dataDir, 'model_health.json'));
  const taHealth = new ModelHealth({ minWindows: 1e9 }, path.join(cfg.dataDir, 'ta_health.json'));
  // TA conviction for the perps (setup trader): features + the TA network's raw view, cached per asset per minute.
  const convCache = new Map<string, { ts: number; f: Record<string, number>; v: TaNetView | undefined }>();
  const conviction = (asset: string, dir: number, now: number) => {
    let c = convCache.get(asset);
    if (!c || now - c.ts > 60_000 || now < c.ts) {
      const candles = md.features.candles.get(asset);
      const f = assetFeatureMap(asset, now, { index: md.index.get(asset), spot: md.spot.get(asset), bars: md.features.bars.get(asset), candles, usdtd: md.usdtd, btcd: md.btcd, perp: md.features.perps.get(asset) });
      let v: TaNetView | undefined;
      v = taNetView(asset, candles, now);
      c = { ts: now, f, v };
      convCache.set(asset, c);
    }
    const S = cfg.strategy;
    return directionalConviction(asset, dir, c.f, c.v, { weight: S.taPricingWeight, maxShift: S.taPricingMaxShift, maxZ: S.taPricingMaxZ, live: cfg.mode === 'live', altBoost: S.altBoost, altUsdtdMaxZ: S.altUsdtdMaxZ, altRsiMin: S.altRsiMin, nonAlts: S.nonAlts, maxBoost: S.adversarialMaxBoost, maxTotal: S.convictionMaxTotal });
  };
  const calendar = loadCalendar(path.resolve(process.env.MACRO_CALENDAR_PATH ?? './params/calendar.json'));
  if (!calendar) log.info('no macro calendar (params/calendar.json): calendar features unavailable');
  // Perps: one executor per perps account drives each position to hedge (stage 2) + directional
  // (stage 3) targets, simulated against live perp quotes (paper) or with real orders (live).
  // The perps trader reads the SNN's direction calls from the engine (set once it exists).
  let engineRef: Engine | undefined;
  let hedger: PerpHedger | undefined;
  let perpTrader: PerpTrader | undefined;
  let directionalTrader: DirectionalTrader | undefined;
  const P = cfg.perps;
  const perpsWanted = P.hedge !== 'off' || P.trading !== 'off';
  if (perpsWanted && !P.feed) log.warn('perp hedging/trading needs PERPS_FEED=true; perps disabled');
  else if (perpsWanted) {
    const hub = md.features.perps;
    const tickerAsset = (t: string) => [...hub.byAsset.entries()].find(([, s]) => s.latest?.ticker === t)?.[0];
    let perpGateway: PerpGateway;
    if (P.hedge === 'live' || P.trading === 'live') {
      const live = new KalshiPerpsRest(P.restUrl, KalshiSigner.fromFile(P.keyId!, P.privateKeyPath!), fetch, P.subaccount);
      if (!(await live.enabled().catch(() => false))) log.warn('GET /margin/enabled says margin trading is not enabled for this account yet (rolling out member by member); perp orders will be rejected');
      perpGateway = live;
    } else {
      const sim = new PaperPerpExchange(hub, tickerAsset, { makerBps: P.makerFeeBps, takerBps: P.takerFeeBps }, path.join(cfg.dataDir, 'paper_perps.json'), Date.now, P.paperBalanceUsd);
      md.on('perp', () => sim.step());
      perpGateway = sim;
      perpsPaper = sim;
    }
    // Underlying units per contract, from the market itself (perp prices are per contract).
    const units = (asset: string) => {
      const px = hub.get(asset)?.price(Date.now(), 60_000), ix = md.index.get(asset)?.fresh(Date.now(), 15_000)?.value;
      return px && ix ? px / ix : undefined;
    };
    hedger = new PerpHedger({
      gateway: perpGateway, hub, audit, units,
      params: { minDollarDelta: P.minDollarDelta, maxNotionalUsd: P.maxNotionalUsd, excludeTauSec: P.excludeTauSec, repriceSec: P.repriceSec, takerAfterSec: P.takerAfterSec },
      risk: { maxOrderNotionalUsd: P.maxOrderNotionalUsd, collarBps: P.collarBps },
    });
    if (P.trading !== 'off' && P.strategy === 'setups') {
      // Fast / slow lane setup trader (bot/setups): levels from spot candles, orders on the perps.
      directionalTrader = new SetupTrader({
        params: {
          book: {
            fast: { ...DEFAULT_LANES.fast, maxPositions: P.setupFastMax, riskFrac: P.setupFastRisk, riskUsd: P.setupFastRiskUsd },
            slow: { ...DEFAULT_LANES.slow, maxPositions: P.setupSlowMax, riskFrac: P.setupSlowRisk, riskUsd: P.setupSlowRiskUsd },
            maxLeverage: P.setupMaxLeverage, maxAssetLeverage: P.setupMaxAssetLeverage,
            minTargetUsd: P.setupMinTargetUsd, roundTripFee: (2 * P.takerFeeBps + 2) / 1e4,
          },
          costs: { entry: (P.takerFeeBps + 2) / 1e4, makerExit: P.makerFeeBps / 1e4, takerExit: (P.takerFeeBps + 2) / 1e4, fundingPer8h: 0.0001 },
          dailyLossFrac: P.dailyLossFrac, minEquityUsd: P.minEquityUsd, pilotMaxNotionalUsd: P.pilotMaxNotionalUsd, requireValidation: P.requireValidation, dailyGoalUsd: P.setupDailyGoalUsd,
        },
        hub, gateway: perpGateway, audit, modelPath: () => resolveModelPaths(cfg).setups, statePath: path.join(cfg.dataDir, 'setups_state.json'),
        candles: (asset) => md.features.candles.get(asset),
        spot: (asset, now) => md.spot.get(asset)?.fresh(now, 15_000)?.value ?? md.index.get(asset)?.fresh(now, 15_000)?.value,
        // The walking TA network (the one whose forecasts trained the setup model), all heads ungated:
        // the setup model itself decides whether they count. Reloaded when the pipeline promotes a newer one.
        taNet: (() => {
          let rt: TaNetRuntime | undefined, mt = -1;
          return (asset: string, now: number) => {
            const file = resolveModelPaths(cfg).ta_net_wf;
            const m = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
            if (m !== mt) { mt = m; try { const n = m ? TaNet.load(file) : undefined; rt = n ? new TaNetRuntime(n, false) : undefined; } catch (e) { rt = undefined; log.warn(`setup trader: TA network ${file} not loaded: ${(e as Error).message}`); } }
            const o = rt?.outputFor(asset, md.features.candles.get(asset), now);
            return o ? { up1: o.up[60] ?? NaN, up4: o.up[240] ?? NaN, vol: o.vol4h ?? NaN } : undefined;
          };
        })(),
        snn: (asset) => engineRef?.snnContext(asset, undefined, 'perps'),
        journal: new SetupJournal(path.join(cfg.dataDir, 'setups'), (e) => log.warn(`setup journal: ${String(e)}`)),
        snnGatePath: () => path.join(cfg.autoTrain.dir, 'setup_snn_gate.json'),
        trainingOverride, streak: perpsStreak, breakEven: perpsBreakEven, lossAt: cfg.strategy.ddScaleAt,
        conviction,
      });
      const st = (directionalTrader as SetupTrader).status();
      if (st.modelError) log.warn(`setup trader: ${st.modelError}; it records setups but opens no trades until a model exists`);
      else log.info('setup trader', { model: st.model?.version, fast: st.model?.fast.validated, slow: st.model?.slow.validated });
    } else if (P.trading !== 'off') {
      const perpModel = PerpModel.load(modelPaths.perp);
      if (!perpModel) log.warn(`no perp model at ${P.modelPath}: trading the momentum prior at pilot size ($${P.pilotMaxNotionalUsd}, ${P.pilotMaxLeverage}x)`);
      else if (!perpModel.validated()) log.warn(`perp model ${perpModel.params.version} not validated (${perpModel.blockers().join('; ')}): pilot size only`);
      perpTrader = new PerpTrader({
        params: {
          horizonMin: P.horizonMin, entryEdgeBps: P.entryEdgeBps, exitEdgeBps: P.exitEdgeBps, kellyFraction: P.kellyFraction, maxLeverage: P.maxLeverage,
          maxNotionalUsd: P.maxTradeNotionalUsd, maxTotalNotionalUsd: P.maxTotalNotionalUsd, stopAtrMult: P.stopAtrMult, minStopBps: P.minStopBps, maxHoldMin: P.maxHoldMin,
          dailyLossFrac: P.dailyLossFrac, cooldownMin: P.cooldownMin, pilotMaxNotionalUsd: P.pilotMaxNotionalUsd, pilotMaxLeverage: P.pilotMaxLeverage, priorIc: P.priorIc,
          makerBps: P.makerFeeBps, requireValidation: P.requireValidation, minEquityUsd: P.minEquityUsd,
        },
        hub, gateway: perpGateway, model: perpModel, audit, trainingOverride,
        sources: (asset) => ({ index: md.index.get(asset), spot: md.spot.get(asset), bars: md.features.bars.get(asset), candles: md.features.candles.get(asset), usdtd: md.usdtd, btcd: md.btcd, perp: hub.get(asset), snn: engineRef?.snnContext(asset, undefined, 'perps') }),
      });
      directionalTrader = perpTrader;
    }
    kill.bindCancelAll(async (reason) => { await oms.cancelAll(reason); await hedger!.cancelAll(reason); });
    log.info('perps enabled', { hedge: P.hedge, trading: P.trading, gateway: perpGateway.name });
  }
  // Cortex-like SNN: shadow by default; in blend mode alpha is earned (<= 0.25) by out-of-sample Brier.
  // Three isolated SNNs (crypto contracts, perps, tennis): each its own worker, model and checkpoints.
  const snn = createSnnFleet(cfg.snn, { crypto: modelPaths.snn_crypto, perps: modelPaths.snn_perps, tennis: modelPaths.snn_tennis });
  if (snn) {
    for (const [d, u] of Object.entries(snn.units)) {
      try {
        await u!.host.start();
        log.info(`SNN ${d} started`, { mode: cfg.snn.mode, stage: cfg.snn.domains[d as 'crypto'].stage, host: u!.host.mode, version: u!.host.version, restored: u!.host.restoredFrom });
      } catch (e) {
        log.error(`SNN ${d} failed to start; continuing without it`, { error: String(e) });
        delete snn.units[d as 'crypto'];
      }
    }
  }
  let tennisFair: TennisFairModel | undefined;
  try { tennisFair = TennisFairModel.load(modelPaths.tennis); if (tennisFair) log.info(`tennis model ${tennisFair.params.version} (validated=${tennisFair.validated})`); }
  catch (e) { log.warn(`tennis model not loaded: ${(e as Error).message}`); }
  let tennisScores: TennisScoreClient | undefined;
  if (cfg.tennis.enabled && cfg.tennis.scoreFeed === 'livetennis') {
    try { tennisScores = new TennisScoreClient({ stateFile: path.join(cfg.dataDir, 'tennis_api_budget.json') }); }
    catch (e) { log.warn(`live tennis scores disabled: ${(e as Error).message}`); }
  }
  // Tree-based volatility forecast and fill model: used only once their own validation passed.
  let volModel: VolModel | undefined;
  try { volModel = cfg.strategy.volModel ? VolModel.load(modelPaths.vol_model) : undefined; } catch (e) { log.warn(`vol model not loaded: ${(e as Error).message}`); }
  let fillModel: FillModel | undefined;
  try { fillModel = FillModel.load(modelPaths.fill); } catch (e) { log.warn(`fill model not loaded: ${(e as Error).message}`); }
  // TA network (years of hourly history): its forecasts become features for the models that validated them.
  let taNet: TaNet | undefined;
  try { taNet = cfg.taNet.enabled ? TaNet.load(modelPaths.ta_net) : undefined; } catch (e) { log.warn(`TA network not loaded: ${(e as Error).message}`); }
  setTaNet(taNet, cfg.taNet.requireValidated);
  // Performance-weighted ensemble: the live network plus the latest archived versions (research/champion.ts).
  setTaNetEnsemble(cfg.taNet.enabled && cfg.taNet.ensemble > 1 ? new TaNetEnsemble(path.join(cfg.autoTrain.dir, 'archive', 'ta_net'), cfg.taNet.ensemble) : undefined);
  // Market-wide context for the TA network: every tracked coin's candles and the index series.
  setTaNetContextSource({ sets: () => md.features.candles, index: (asset, tf) => md.indexStore.get(asset, tf) });
  if (taNet) {
    // Out-of-sample finality: the live bot forward-tests the elite's position rule.
    activeTaNet()?.enableForwardTest(path.join(cfg.dataDir, 'ta_net_forward.json'), Date.now(), { days: cfg.taNet.forwardDays, muteOnFail: cfg.taNet.muteOnForwardFail });
    log.info('TA network loaded', { version: taNet.version, validatedHeads: taNet.active(true) });
  }
  // The exchange's own status and maintenance schedule gate new entries (exits stay allowed).
  const exchangeStatus = new ExchangeStatusMonitor(rest);
  exchangeStatus.start();
  const engine: Engine = new Engine({ control, exchangeStatus, cfg, audit, alerter, md, gateway, oms, risk, kill, recon, model, volProfile, vault, balanceMonitor, balanceMonitorPath, tca, equityGuard, modelHealth, taHealth, calendar, hedger, perpTrader: directionalTrader, clock, tennisScores, tennisFair, volModel, fillModel, fillLogDir: path.join(cfg.dataDir, 'fills'), snn, snnBlenderPath: path.join(cfg.snn.checkpointDir, 'blender.json') });
  engineRef = engine;
  const autoTrain = new AutoTrainer({ cfg, engine, audit, alerter, perpTrader });
  autoTrain.start();
  // Paper training override: automatic kill trips de-risk instead of halting; exhausted pools are refilled.
  const training = new TrainingSupervisor({
    cfg, control, kill, engine, oms, audit, alerter, equityGuard, kalshiPaper: paper, perpsPaper, perpsStreak, perpsBreakEven,
    cancelPerps: hedger ? (reason) => hedger!.cancelAll(reason) : undefined, perpsMinEquity: cfg.perps.minEquityUsd, perpsStart: cfg.perps.paperBalanceUsd,
    noteCash: (amount) => engine.noteCashFlow(amount),
  });

  // Execution events -> OMS (same path for paper and live).
  let settlement: SettlementSweeper | undefined;
  if (paper) {
    paper.on('fill', (f) => oms.onFill(f));
    paper.on('order', (o) => oms.onExchangeOrder(o));
    md.on('trade', (t: { ticker: string; price: number; count: number; takerSide: 'yes' | 'no' | undefined }) => paper.onTrade(t.ticker, t.price, t.count, t.takerSide));
    md.on('lifecycle', (e: { ticker: string; event: string; result?: string }) => {
      if ((e.result === 'yes' || e.result === 'no') && /settle|determin/i.test(e.event)) paper.settle(e.ticker, e.result);
    });
    // Settle the paper account and the bot's own records from Kalshi's official results, for every
    // contract either side still holds (bot/paper/settlementSweeper.ts).
    settlement = new SettlementSweeper({
      paperPositions: () => paper.getPositions(),
      omsUnsettled: () => oms.positions.unsettled().filter((m) => Math.abs(m.yes) > 1e-9).map((m) => ({ ticker: m.ticker, closeTs: m.closeTs })),
      getMarket: (t) => rest.getMarket(t),
      settlePaper: (t, r) => paper.settle(t, r),
      settleOms: (t, r) => { const m = oms.positions.get(t); if (m && !m.settled) oms.settle(t, r); },
      recordResult: (t, r) => md.recordResult(t, r),
      closeTsOf: (t) => md.markets.get(t)?.closeTime,
      correctCloseTime: (t, closeTime) => { const m = md.markets.get(t); if (m && closeTime < m.closeTime) { log.warn('market close time corrected from Kalshi', { ticker: t, cached: new Date(m.closeTime).toISOString(), kalshi: new Date(closeTime).toISOString() }); m.closeTime = closeTime; } },
      warn: (msg, meta) => log.warn(msg, meta),
      info: (msg, meta) => log.info(msg, meta),
    });
    const sweeper = settlement;
    setInterval(() => void sweeper.sweep().catch((e) => log.warn('settlement sweep failed', { error: String(e) })), 30_000).unref();
    void sweeper.sweep().catch(() => undefined);
  } else if (ws) {
    ws.on('fill', (f) => oms.onFill(f));
    ws.on('user_order', (o) => oms.onExchangeOrder(o));
  }
  oms.on('fill', (f, rec, fee) => tca.onFill(f, rec, fee));

  if (kill.engaged) {
    log.warn('kill switch is ENGAGED from a previous run; no orders will be sent until it is reset', kill.status());
    await oms.cancelAll('startup with kill switch engaged');
  }

  // The dashboard comes up first (it shows the engine warming up); loading every market takes a minute or
  // more on a small server.
  training.start();
  const app = createApi({ cfg, audit, engine, oms, kill, recon, model, tca, md, vault, autoTrain, control, training, settlement, restart: () => void shutdown('restart (dashboard)', 75), startedAt: Date.now() });
  const server = app.listen(cfg.port, cfg.host, () => log.info(`operator API on http://${cfg.host}:${cfg.port} (${cfg.dashboardPassword ? 'password required' : 'no login'})`));

  md.start();
  await engine.start();

  let stopping = false;
  // Exit code 75 asks systemd to start the bot again (Restart=on-failure): used by the PAPER / LIVE switch.
  const shutdown = async (sig: string, code = 0) => {
    if (stopping) return;
    stopping = true;
    log.warn(`received ${sig}; cancelling resting orders and shutting down`);
    engine.stop();
    try { await oms.cancelAll(`shutdown (${sig})`); } catch (e) { log.error('cancel on shutdown failed', { error: String(e) }); }
    paper?.flush();
    autoTrain.stop();
    try { engine.saveSnnBlender(); await Promise.all(Object.values(engine.snn?.units ?? {}).map((u) => u!.host.stop())); } catch (e) { log.error('SNN checkpoint on shutdown failed', { error: String(e) }); }
    audit.write('shutdown', { sig });
    md.stop();
    server.close(() => process.exit(code));
    setTimeout(() => process.exit(code), 5000).unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => {
    log.error('unhandled rejection', { error: String(e) });
    audit.write('error', { where: 'unhandledRejection', error: String(e) });
  });
}

main().catch((e) => {
  log.error('fatal', { error: String(e), stack: (e as Error).stack });
  process.exit(1);
});
