// Entry point. Wires the components; all behaviour lives in the modules.

import { ExchangeStatusMonitor } from './kalshi/exchangeStatus';
import { MAKER_RATE, setBalancePrecision, TAKER_RATE } from './fees';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Alerter, AlertSink, TelegramSink, WebhookSink } from './alerts/alerter';
import { createApi } from './api/server';
import { KalshiCheck, type CheckSource } from './recon/kalshiCheck';
import type { ExchangeFill } from './kalshi/types';
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
import { loadSessionRiskFile } from './model/sessionRisk';
import { loadCalendar } from './model/calendar';
import { ModelHealth } from './model/modelHealth';
import { AccuracyGate } from './strategy/accuracyGate';
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
import { MarketContext, marketContext, setMarketContext } from './ta/marketContext';
import { activeRuleBook, RuleBook, setRuleBook, STAND_ASIDE } from './strategy/ruleBook';
import { activeGpSignals, GpSignals, setGpSignals } from './gp/gpSignals';
import { SetupJournal } from './setups/journal';
import { capRecordings, compressOldRecordings, freeBytesAt, makeRecordingsRoom, recordingsUsage } from './marketdata/recordingFiles';
import { DEFAULT_LANES } from './setups/lanes';
import { PaperPerpExchange } from './perps/paperPerp';
import { KalshiPerpsRest, type PerpGateway } from './perps/perpRest';
import { BalanceMonitor, type MonitorState } from './vault/balanceMonitor';
import { Vault } from './vault/vault';
import { readJson, setQuarantineAll } from './util/persist';
import { championEnv, championPath, markApplied, readChampion, watchChampion } from './strategy/conditioningOverlay';
import { Playbook, setPlaybook } from './strategy/playbook';
import { Compensator, setCompensator } from './strategy/compensator';
import { MacroService, setMacro } from './macro/macroService';
import { macroSettings } from './macro/macroSeries';
import { Oms } from './oms/oms';
import { PaperExchange } from './paper/paperExchange';
import { KillSwitch } from './risk/killSwitch';
import { RiskGateway } from './risk/riskGateway';
import { Reconciler } from './recon/reconciler';
import { Tca } from './tca/tca';
import { createSnnFleet } from './snn';
import { VolModel } from './model/volModel';
import { activeTaNet, setTaNet, setTaNetContextSource, TaNet, TaNetRuntime } from './ta/taNet';
import { Librarian, setLibrarianPath } from './ta/librarian';
import { CrossGraph, setCrossGraphPath, XgMemo } from './ta/crossGraph';
import { setCrossLeadPath } from './ta/crossLead';
import { FillModel } from './tca/fillModel';
import { TennisScoreClient } from './tennis/liveTennisApi';
import { TennisFairModel } from './tennis/tennisFair';
import { AutoTrainer, resolveModelPaths } from './autotrain';
import { logger } from './util/log';
import { RunControl } from './control';
import { TrainingSupervisor } from './training/supervisor';
import { SettlementSweeper } from './paper/settlementSweeper';
import { gatePasses, Probation, setProbation } from './risk/probation';
import { SinuousEntryGate } from './strategy/sinuousEntry';
import { SinuousExitGate } from './strategy/sinuousExit';
import { TakeProfitBench } from './strategy/takeProfitBench';
import { LiveLines } from './strategy/liveLine';
import { ComponentTrials, TRIAL_LABEL } from './strategy/componentTrials';
import { Scoreboard } from './health/scoreboard';
import { DEFAULT_STREAK, StreakScaler } from './risk/streakScaler';

const log = logger('main');

async function main(): Promise<void> {
  let cfg: Readonly<Config>;
  try {
    cfg = loadConfig();
    // Paper mode: a damaged state file is moved aside and rebuilt instead of stopping the bot.
    setQuarantineAll(cfg.mode !== 'live');
    // The conditioning champion's settings, before anything reads the configuration.
    const champ = cfg.conditioningApply ? readChampion(championPath(cfg.autoTrain.dir)) : undefined;
    if (champ) {
      const c = championEnv(champ, cfg);
      try {
        cfg = loadConfig({ ...process.env, ...c.env });
        markApplied(champ, c.params, c.skipped);
        log.info('conditioning champion applied', { version: champ.version, params: c.params, skipped: c.skipped });
      } catch (e) { log.error('conditioning champion not applied: its settings do not pass the configuration checks; the configured settings stay', { version: champ.version, error: String(e) }); }
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      log.error(`configuration invalid: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
  setBalancePrecision(cfg.kalshiBalancePrecision);
  fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cfg.bookDir, { recursive: true, mode: 0o700 });
  // A full disk stops the bot at its first write: make room before anything is written (the regular check runs later).
  const startupPruned = cfg.autoTrain.recordingsPrune ? makeRecordingsRoom(path.join(cfg.dataDir, 'recordings'), cfg.autoTrain.recordingsMinFreeGb * 1e9) : [];
  if (startupPruned.length) log.warn('disk full at startup: deleted recorded days', { days: startupPruned });
  const audit = new AuditLog(path.join(cfg.dataDir, 'audit'), 500, Date.now, { maxFileBytes: cfg.auditMaxFileMb * 1024 * 1024, retentionDays: cfg.auditRetentionDays });
  audit.write('startup', { pid: process.pid, node: process.version, config: publicConfig(cfg as Config) });

  const sinks: AlertSink[] = [];
  if (cfg.alertTelegramToken && cfg.alertTelegramChatId) sinks.push(new TelegramSink(cfg.alertTelegramToken, cfg.alertTelegramChatId));
  if (cfg.alertWebhookUrl) sinks.push(new WebhookSink(cfg.alertWebhookUrl));
  const alerter = new Alerter(sinks, audit);
  // Probation (VALIDATION_GATES=monitor): unvalidated models trade, and a book whose results are unacceptable is benched.
  const probationBooks = new Probation(cfg.probation, path.join(cfg.bookDir, 'probation.json'), (book, reason) => {
    audit.write('probation', { event: 'benched', book, reason });
    alerter.notify('warn', `probation-${book}`, `Probation: ${book} benched (its unvalidated models stop trading until the next model or a reset): ${reason}`);
  });
  setProbation(probationBooks);
  if (cfg.probation.mode === 'monitor') log.info('validation gates: monitor (unvalidated models trade on probation)', { ...cfg.probation });
  // Exit-in-profit curve (SINUOUS_EXIT, bot/strategy/sinuousExit.ts), the same in paper and live (the owner, Oct 23: "It
  // can't just be paper mode. When I take it out of paper mode into live it needs to behave identical"): cross by
  // default, the curve sells a held position at the bid on a confirmed roll-over and holds nothing. Its scoreboard (each
  // filled cross against holding to settlement) benches the cross when it loses beyond luck at t <= -SINUOUS_BENCH_T
  // after SINUOUS_BENCH_MIN_EXITS scored exits, or costs PROBATION_MAX_LOSS_USD. Each book keeps its own scoreboard
  // (DATA_DIR and DATA_DIR/live); both started over once on Oct 24, when crosses began to be scored on their fills.
  const curveParams = cfg.sinuousExit;
  const curveBench = { ...cfg.probation, t: cfg.sinuousExit.benchT ?? cfg.probation.t, minTrades: cfg.sinuousExit.benchMinExits ?? cfg.probation.minTrades };
  const curveExit = curveParams.mode === 'off' ? undefined : new SinuousExitGate(curveParams, curveBench, path.join(cfg.bookDir, 'curve-exit.json'), (e) => {
    audit.write('curve_exit', e);
    if (e.event === 'benched') alerter.notify('warn', 'curve-exit', curveParams.mode === 'rest' || curveParams.mode === 'cross'
      ? `Exit curve's cross benched (it stops selling on the cross until a reset${curveParams.mode === 'rest' ? '; the resting sells go on' : ''}): ${String(e.reason)}`
      : `Exit curve benched (profit exits go out without waiting for it until a reset): ${String(e.reason)}`);
  }, Date.now(), 'cross-fills-2026-10-24');
  // Take-profit bench (bot/strategy/takeProfitBench.ts; the owner, Oct 24: the take-profit goes on the exit curve's
  // scoreboard and bench): each crypto take-profit sale against holding to settlement, benched on the curve's rule
  // (TAKE_PROFIT_BENCH=false: scored only). Each book keeps its own scoreboard (DATA_DIR and DATA_DIR/live).
  const takeProfitBench = new TakeProfitBench(cfg.strategy.takeProfitBench, curveBench, path.join(cfg.bookDir, 'take-profit-bench.json'), (e) => {
    audit.write('take_profit_bench', e);
    if (e.event === 'benched') alerter.notify('warn', 'take-profit-bench', `Take-profit benched (winners ride to the model exit, the ratchet stop or settlement until a reset): ${String(e.reason)}`);
  });
  // The live line (bot/strategy/liveLine.ts): each coin's settlement index as a curve, shared by its contracts; the cross
  // watches it (SINUOUS_CROSS_SOURCE=line) and the depth monitor shows each held position's reading.
  const liveLines = curveExit ? new LiveLines(cfg.sinuousExit.line) : undefined;
  // The rule book, SNN and TA network trials (the owner, Oct 24: "give each a shot and let's see how well they perform. If
  // they perform well in the test allow them to function for paper trading"): each scored against the price without it
  // on every settled crypto contract; one that tests significantly better goes into paper's prices, never live's
  // (bot/strategy/componentTrials.ts). Each book keeps its own scorecards (DATA_DIR and DATA_DIR/live).
  const trials = cfg.trials.enabled ? new ComponentTrials(cfg.trials, path.join(cfg.bookDir, 'component_trials.json'), (name, to, why) => {
    audit.write('trial', { event: to, trial: name, why, appliesIn: 'paper' });
    alerter.notify('info', `trial-${name}`, `Trial: the ${TRIAL_LABEL[name]} is ${to === 'on' ? 'now ON in paper' : to === 'off' ? 'OFF in paper' : 'testing'}: ${why}`);
  }) : undefined;
  // The scoreboard: every price against the Kalshi market on every settled crypto contract, paper and live alike
  // (bot/health/scoreboard.ts). Each book keeps its own.
  const scoreboard = cfg.scoreboard.enabled ? new Scoreboard(cfg.scoreboard, path.join(cfg.bookDir, 'scoreboard.json')) : undefined;
  // Entry curve (SINUOUS_ENTRY, bot/strategy/sinuousEntry.ts): monitor scores maker entries by the book's curve at the
  // fill; gate also holds back quotes the curve is running against.
  const curveEntry = cfg.sinuousEntry.mode === 'off' ? undefined : new SinuousEntryGate(cfg.sinuousEntry, path.join(cfg.bookDir, 'curve-entry.json'));

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
    const blockers = cfg.liveAllowUnvalidated || gatePasses('kalshi', false) ? [] : model.liveBlockers();
    if (!cfg.liveAllowUnvalidated && gatePasses('kalshi', false) && model.liveBlockers().length) log.warn(`VALIDATION_GATES=monitor: trading binary contracts live with model ${model.id} on probation although it is not validated (${model.liveBlockers().join('; ')})`);
    if (cfg.liveAllowUnvalidated && model.liveBlockers().length) log.warn(`LIVE_ALLOW_UNVALIDATED_MODEL=true: trading binary contracts live with model ${model.id} although it is not validated (${model.liveBlockers().join('; ')})`);
    // Other live books (perps, tennis) run on their own gates; with LIVE_ALLOW_UNVALIDATED_MODEL=false the risk gateway
    // keeps rejecting every new binary crypto order while the model is unvalidated (exits still go out), so the
    // process only refuses to start when there is nothing else to trade live.
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
  const md = new MarketData(cfg, rest, ws, new Recorder(path.join(cfg.dataDir, 'recordings'), { gzip: cfg.autoTrain.recordingsGzipLive }));
  // The rounding grid an earlier run learned from Kalshi's charged fees wins over KALSHI_BALANCE_PRECISION.
  setBalancePrecision(md.feeBook.precision());
  // Recordings grow by a day file per day, gzipped as they are written (or, a day begun plain, after midnight: about
  // 10x smaller), RECORDINGS_KEEP_DAYS of them kept, and a low-disk alert fires before writes would fail.
  const recDir = path.join(cfg.dataDir, 'recordings');
  const maintainRecordings = async () => {
    try {
      const old = capRecordings(recDir, cfg.autoTrain.recordingsKeepDays);
      if (old.length) log.info('recorded days past RECORDINGS_KEEP_DAYS deleted', { days: old, keep: cfg.autoTrain.recordingsKeepDays });
      // Below the floor, the oldest days go first (the gzip below also needs room to write).
      const floor = cfg.autoTrain.recordingsMinFreeGb * 1e9;
      const prune = () => {
        if (!cfg.autoTrain.recordingsPrune) return;
        const gone = makeRecordingsRoom(recDir, floor);
        if (gone.length) alerter.notify('warn', 'recordings-pruned', `Disk below ${cfg.autoTrain.recordingsMinFreeGb} GB free: deleted the oldest recorded days ${gone[0]}..${gone[gone.length - 1]} (${gone.length})`);
      };
      if ((freeBytesAt(recDir) ?? Infinity) < floor) prune();
      if (cfg.autoTrain.recordingsGzipAfterDays > 0) {
        const done = await compressOldRecordings(recDir, cfg.autoTrain.recordingsGzipAfterDays);
        if (done.length) log.info('recordings compressed', { days: done });
      }
      if ((freeBytesAt(recDir) ?? Infinity) < floor) prune();
      const u = recordingsUsage(recDir);
      if (u.freeBytes !== undefined && u.freeBytes < cfg.autoTrain.recordingsMinFreeGb * 1e9) {
        alerter.notify('warn', 'recordings-disk', `Low disk: ${(u.freeBytes / 1e9).toFixed(1)} GB free; recordings use ${(u.bytes / 1e9).toFixed(1)} GB over ${u.days} days (RECORDINGS_MIN_FREE_GB=${cfg.autoTrain.recordingsMinFreeGb})`);
      }
    } catch (e) { log.warn('recordings maintenance failed', { error: String(e) }); }
  };
  void maintainRecordings();
  // Every 10 minutes: a busy day writes several GB, an hour is too long to wait near a full disk.
  setInterval(() => void maintainRecordings(), 600_000).unref();

  const paper = cfg.mode === 'live'
    ? undefined
    : new PaperExchange(path.join(cfg.dataDir, 'paper_exchange.json'), cfg.paperBankrollUsd, (t) => md.books.get(t), (t) => md.feesFor(t));
  const gateway: ExchangeGateway = paper ?? rest;

  const kill = new KillSwitch(path.join(cfg.dataDir, 'kill_switch.json'), audit, alerter);
  const oms = new Oms({ gateway, audit, statePath: path.join(cfg.bookDir, 'oms_state.json'), feesFor: (t) => md.feesFor(t), subaccount: cfg.kalshiSubaccount, durableWriteAhead: cfg.mode === 'live', leaveExternalOrders: cfg.mode === 'live' });
  kill.bindCancelAll((reason) => oms.cancelAll(reason));

  // Kalshi check: the bot's fills, settlements and cash against Kalshi's own records (bot/recon/kalshiCheck.ts).
  // Listeners go on before the startup reconciliation replays fills.
  const kalshiCheck = new KalshiCheck({
    file: path.join(cfg.bookDir, 'kalshi_check.json'), source: gateway as CheckSource, audit, alerter,
    seenTrade: (id) => oms.hasSeenTrade(id), position: (t) => oms.positions.get(t),
  });
  oms.on('fill', (f: ExchangeFill, _rec: unknown, fee: number, positionAfter: number) => kalshiCheck.onBotFill(f, fee, positionAfter));
  oms.on('settled', (e: { ticker: string; result: 'yes' | 'no'; realized: number; positionBefore: number }) => kalshiCheck.onBotSettle(e, oms.positions.get(e.ticker)));
  kalshiCheck.start();

  // Fee check (bot/kalshi/feeSchedule.ts): every live fill's charged fee against the schedule; the same check learns
  // the account's rounding grid from the fees Kalshi charges.
  if (cfg.mode === 'live') {
    oms.on('fill', (f: ExchangeFill) => {
      if (f.fee === undefined) return;
      const m = md.markets.get(f.ticker);
      const series = m?.seriesTicker ?? f.ticker.split('-')[0];
      const c = md.feeBook.checkFill({ ticker: f.ticker, series, event: m?.eventTicker, count: f.count, sidePrice: f.side === 'bid' ? f.price : 1 - f.price, isTaker: f.isTaker, charged: f.fee, ts: f.ts });
      if (c.learned !== undefined) {
        setBalancePrecision(c.learned);
        alerter.notify('info', 'fee-precision', `Fee check: Kalshi charges this account's fees on a $${c.learned} grid (${c.learned === 0.0001 ? 'a direct member' : 'through an FCM'}); the bot now prices with it (KALSHI_BALANCE_PRECISION=${cfg.kalshiBalancePrecision})`);
      }
      if (c.result === 'mismatch') {
        audit.write('fee_check', { ticker: f.ticker, tradeId: f.tradeId, result: c.result, predicted: c.predicted, charged: c.charged, note: c.note });
        alerter.notify('warn', `fee-mismatch-${series}-${new Date(f.ts).toISOString().slice(0, 10)}`, `Fee check: ${c.note}`);
      }
    });
  }
  // Kalshi's published fee schedule: read 30 s after start, then every KALSHI_FEE_SCHEDULE_HOURS.
  if (cfg.feeSchedule.check) {
    md.on('fee_schedule', (e: { changed: boolean; error?: string }) => {
      const fs0 = md.feeStatus();
      const st = fs0.published;
      // A refused read keeps the schedule in use (the last good read, or the copy built into the release); the checks
      // below run against it either way.
      if (e.error) log.warn('fee schedule check failed (the schedule in use stays)', { error: e.error, url: cfg.feeSchedule.url, inUse: `${st.source} of ${st.effective}` });
      else audit.write('fee_schedule', st);
      const day = new Date().toISOString().slice(0, 10);
      if (e.changed) alerter.notify('info', 'fee-schedule', `Kalshi fee schedule read: effective ${st.effective ?? '?'}, taker ${st.takerRate} / maker ${st.makerRate}, ${st.nonStandardListed} series with their own multipliers; the bot's formula reproduces ${st.tableCheck?.matched ?? 0}/${st.tableCheck?.rows ?? 0} rows of the published fee table`);
      if (st.takerRate !== null && (st.takerRate !== TAKER_RATE || st.makerRate !== MAKER_RATE)) alerter.notify('warn', `fee-schedule-rates-${day}`, `Kalshi's published fee rates are taker ${st.takerRate}, maker ${st.makerRate} (built in: ${TAKER_RATE}, ${MAKER_RATE}); the bot prices with the published ones`);
      if (st.tableCheck && st.tableCheck.matched < st.tableCheck.rows) alerter.notify('warn', `fee-schedule-table-${day}`, `Fee check: the bot's formula does not reproduce Kalshi's published fee table (${st.tableCheck.firstMiss})`);
      for (const s of fs0.series) if (s.source.startsWith('api and published')) alerter.notify('warn', `fee-disagree-${s.series}-${day}`, `Fee check: ${s.series}: the API says ${s.feeType} x${s.multiplier}, the published schedule lists maker ${s.published?.maker} / taker ${s.published?.taker}; pricing with the higher (taker x${s.taker}, maker x${s.maker})`);
    });
    const checkSchedule = () => void md.checkPublishedSchedule();
    setTimeout(checkSchedule, 30_000).unref();
    setInterval(checkSchedule, cfg.feeSchedule.hours * 3_600_000).unref();
  }
  const recon = new Reconciler({
    gateway, oms, audit, alerter,
    getMarket: (t) => rest.getMarket(t),
    onSettled: (t, r) => md.recordResult(t, r),
    onPersistentBreak: (reason) => void kill.engage(reason, 'recon'),
    onFills: (fills) => kalshiCheck.onExchangeFills(fills),
    closeUnknownOrders: cfg.mode !== 'live',
    // Live: an order the bot did not send is the operator's own (placed on Kalshi by hand), not an orphan to cancel.
    leaveExternalOrders: cfg.mode === 'live',
  });
  const risk = new RiskGateway(cfg.risk);
  const vault = new Vault(cfg.vault, path.join(cfg.bookDir, 'vault.json'));
  const balanceMonitorPath = path.join(cfg.bookDir, 'balance_monitor.json');
  const balanceMonitor = new BalanceMonitor(readJson<MonitorState>(balanceMonitorPath, { quarantine: true }) ?? {});
  const tca = new Tca(path.join(cfg.dataDir, 'tca'), (t) => md.books.get(t)?.mid(), cfg.mode);
  const equityGuard = new EquityGuard({ ddScaleAt: cfg.strategy.ddScaleAt, weeklyLossPause: cfg.strategy.weeklyLossPause, dailyGoalUsd: cfg.vault.dailyGoalUsd }, path.join(cfg.bookDir, 'equity_guard.json'));
  // Dashboard PLAY / STOP and the paper training override (persisted).
  const control = new RunControl(path.join(cfg.dataDir, 'control.json'));
  // Kill-switch override (paper and live): loss brakes de-risk instead of halting.
  const trainingOverride = () => control.killOverride;
  const perpsStreak = new StreakScaler(DEFAULT_STREAK, path.join(cfg.bookDir, 'streak_perps.json'));
  const perpsBreakEven = new BreakEven(path.join(cfg.bookDir, 'perps_break_even.json'));
  // Probation's loss limit follows each account's size (PROBATION_MAX_LOSS_PCT of its break-even, at most
  // PROBATION_MAX_LOSS_USD); a book already past it is benched now rather than at its next result.
  probationBooks.setBreakEven((book) => (book === 'perps' || book === 'setups' ? perpsBreakEven.reference : equityGuard.reference));
  probationBooks.review();
  let perpsPaper: PaperPerpExchange | undefined;
  const modelHealth = new ModelHealth({ minWindows: cfg.strategy.modelHealthMinWindows }, path.join(cfg.dataDir, 'model_health.json'));
  const taHealth = new ModelHealth({ minWindows: 1e9 }, path.join(cfg.dataDir, 'ta_health.json'));
  // Bot vs market per time-to-close bucket (each book its own scorecard); only paper blocks entries on it.
  const accuracyGate = new AccuracyGate(cfg.strategy.accuracyGate, path.join(cfg.bookDir, 'accuracy_gate.json'));
  // TA conviction for the perps (setup trader): features + the TA network's raw view, cached per asset per minute.
  const convCache = new Map<string, { ts: number; f: Record<string, number>; v: TaNetView | undefined; rb?: { score: number; n: number }; gp?: { exposure: number } }>();
  const conviction = (asset: string, dir: number, now: number) => {
    let c = convCache.get(asset);
    if (!c || now - c.ts > 60_000 || now < c.ts) {
      const candles = md.features.candles.get(asset);
      const f = assetFeatureMap(asset, now, { index: md.index.get(asset), spot: md.spot.get(asset), bars: md.features.bars.get(asset), candles, usdtd: md.usdtd, btcd: md.btcd, perp: md.features.perps.get(asset) });
      let v: TaNetView | undefined;
      v = taNetView(asset, candles, now);
      // The rule book at the setups' holding horizon (a day), for the coin's character.
      const rb = cfg.strategy.ruleBook ? activeRuleBook()?.read(candles?.snapshot(now, marketContext()?.macro()), 24, marketContext()?.character(asset)?.cls) : undefined;
      // The coin's evolved formula: validated, or on probation (the same rule in paper and live).
      const g = cfg.strategy.gp ? activeGpSignals()?.read(asset, (a) => md.features.candles.get(a)?.bars['1h']) : undefined;
      const gp = g && (g.validated || gatePasses('setups', false)) ? g : undefined;
      c = { ts: now, f, v, rb, gp };
      convCache.set(asset, c);
    }
    const S = cfg.strategy;
    const ch = marketContext()?.character(asset);
    return directionalConviction(asset, dir, c.f, c.v, { weight: S.taPricingWeight, maxShift: S.taPricingMaxShift, maxZ: S.taPricingMaxZ, live: cfg.mode === 'live', altBoost: S.altBoost, altUsdtdMaxZ: S.altUsdtdMaxZ, altRsiMin: S.altRsiMin, nonAlts: S.nonAlts, maxBoost: S.adversarialMaxBoost, maxTotal: S.convictionMaxTotal,
      ruleBook: c.rb, gp: c.gp, standAside: S.characterStandAside && ch && STAND_ASIDE.includes(ch.cls) ? ch.why : undefined });
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
      // The walking TA network (the one whose forecasts trained the setup model), all heads ungated: the setup model
      // itself decides whether they count. Reloaded when the pipeline promotes a newer one.
      const wfTaNet = (() => {
        let rt: TaNetRuntime | undefined, mt = -1;
        return () => {
          const file = resolveModelPaths(cfg).ta_net_wf;
          const m = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
          if (m !== mt) { mt = m; try { const n = m ? TaNet.load(file) : undefined; rt = n ? new TaNetRuntime(n, false) : undefined; } catch (e) { rt = undefined; log.warn(`setup trader: TA network ${file} not loaded: ${(e as Error).message}`); } }
          return rt;
        };
      })();
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
          liqBuffer: P.liqBuffer, maintMargin: P.maintMargin,
        },
        hub, gateway: perpGateway, audit, modelPath: () => resolveModelPaths(cfg).setups, statePath: path.join(cfg.bookDir, 'setups_state.json'),
        candles: (asset) => md.features.candles.get(asset),
        spot: (asset, now) => md.spot.get(asset)?.fresh(now, 15_000)?.value ?? md.index.get(asset)?.fresh(now, 15_000)?.value,
        taNet: (asset: string, now: number) => {
          const o = wfTaNet()?.outputFor(asset, md.features.candles.get(asset), now);
          return o ? { up1: o.up[60] ?? NaN, up4: o.up[240] ?? NaN, vol: o.vol4h ?? NaN } : undefined;
        },
        // The Librarian on the same TA row (ungated: the setup model's "librarian" group decides).
        librarian: (() => {
          let lib: Librarian | undefined, mt = -1, at = '';
          return (asset: string, now: number) => {
            const file = resolveModelPaths(cfg).librarian;
            const m = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
            if (m !== mt || file !== at) { mt = m; at = file; try { lib = m ? Librarian.load(file) : undefined; } catch (e) { lib = undefined; log.warn(`setup trader: Librarian ${file} not loaded: ${(e as Error).message}`); } }
            const rt = lib ? wfTaNet() : undefined;
            const o = rt?.outputFor(asset, md.features.candles.get(asset), now);
            const row = o ? rt!.row(asset, o.barTs) : undefined;
            return lib && row ? lib.predict(row) : undefined;
          };
        })(),
        // The cross-asset graph network on every coin's hourly candles (ungated: the setup model's "xgraph" group decides).
        crossGraph: (() => {
          let g: CrossGraph | undefined, mt = -1, at = '';
          const memo = new XgMemo();
          return (asset: string, now: number) => {
            const file = resolveModelPaths(cfg).cross_graph;
            const m = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
            if (m !== mt || file !== at) { mt = m; at = file; try { g = m ? CrossGraph.load(file) : undefined; } catch (e) { g = undefined; log.warn(`setup trader: cross graph ${file} not loaded: ${(e as Error).message}`); } }
            return g ? memo.get(g, [...md.features.candles.entries()].map(([a, s]) => [a, s.bars['1h']]), now, asset) : undefined;
          };
        })(),
        snn: (asset) => engineRef?.snnContext(asset, undefined, 'perps'),
        journal: new SetupJournal(path.join(cfg.dataDir, 'setups'), (e) => log.warn(`setup journal: ${String(e)}`)),
        snnGatePath: () => path.join(cfg.autoTrain.dir, 'setup_snn_gate.json'),
        trainingOverride, streak: perpsStreak, breakEven: perpsBreakEven, lossAt: cfg.strategy.ddScaleAt,
        conviction, optimalF: { ...cfg.optimalF, paper: P.trading !== 'live' },
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
          makerBps: P.makerFeeBps, requireValidation: P.requireValidation, minEquityUsd: P.minEquityUsd, liqBuffer: P.liqBuffer, maintMargin: P.maintMargin,
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
  // The Librarian the general features read (validated heads only; reloaded when the pipeline promotes a new one).
  setLibrarianPath(cfg.taNet.enabled ? () => resolveModelPaths(cfg).librarian : undefined);
  setCrossGraphPath(cfg.taNet.enabled ? () => resolveModelPaths(cfg).cross_graph : undefined);
  // Cross-coin lead-lag (validated pairs only): the Kalshi features, the setup scorer's inputs and its exit read it.
  setCrossLeadPath(() => resolveModelPaths(cfg).cross_lead);
  // Performance-weighted ensemble: the live network plus the latest archived versions (research/champion.ts).
  setTaNetEnsemble(cfg.taNet.enabled && cfg.taNet.ensemble > 1 ? new TaNetEnsemble(path.join(cfg.autoTrain.dir, 'archive', 'ta_net'), cfg.taNet.ensemble) : undefined);
  // Market context for the directional system: breadth, risk gauges, each coin's character
  // (bot/ta/marketContext.ts), refreshed as hourly candles close.
  const marketCtx = new MarketContext(cfg.taNet.historyDir);
  setMarketContext(marketCtx);
  // Strategy playbook: per coin regime, the weight of the Kalshi and perps families (re-read when the trainer sends a new one).
  setPlaybook(new Playbook(cfg.autoTrain.dir, cfg.playbookApply));
  // The Compensator: per strategy, a learned ramp on each coin's Librarian reading; replaces the playbook's weight when on.
  setCompensator(new Compensator(cfg.autoTrain.dir, cfg.compensatorApply));
  // Fractal Alignment Engine and waterfall mode (bot/macro): the 2018-to-now BTC.D cycle on its 2016-2017 parent, the
  // gate latch and the operator's arming switch (DATA_DIR/waterfall.json), and the policy the strategies read.
  const ms = macroSettings(cfg.macro);
  setMacro(new MacroService({ historyDir: cfg.taNet.historyDir, index: (a) => md.indexStore.get(a, '1d'), file: path.join(cfg.dataDir, 'waterfall.json'), params: ms.params, fractal: ms.fractal, audit }));
  setRuleBook(new RuleBook(() => path.join(cfg.autoTrain.dir, 'rule_book.json')));
  // Evolved formulas (research/gpIndicators.ts): re-read when the pipeline promotes a new champion. An unproven one speaks
  // with GP_REQUIRE_VALIDATED=false, in live too while unvalidated models may trade live (the same as paper).
  setGpSignals(new GpSignals(() => path.join(cfg.autoTrain.dir, 'gp_indicators.json'), () => !cfg.strategy.gpRequireValidated && (cfg.mode !== 'live' || cfg.liveAllowUnvalidated)));
  const refreshMarketCtx = () => { try { const now = Date.now(); marketCtx.update(md.features.candles.values(), now, (a) => taNetView(a, md.features.candles.get(a), now)?.vol4h); } catch (e) { log.warn(`market context: ${String(e)}`); } };
  setInterval(refreshMarketCtx, 60_000).unref();
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
  const engine: Engine = new Engine({ kalshiCheck, control, exchangeStatus, cfg, audit, alerter, md, gateway, oms, risk, kill, recon, model, volProfile, vault, balanceMonitor, balanceMonitorPath, tca, equityGuard, modelHealth, taHealth, accuracyGate, calendar, hedger, perpTrader: directionalTrader, clock, tennisScores, tennisFair, volModel, fillModel, fillLogDir: path.join(cfg.dataDir, 'fills'), snn, snnBlenderPath: path.join(cfg.snn.checkpointDir, 'blender.json'), curveExit, takeProfitBench, curveEntry, liveLines, trials, scoreboard });
  // The pipeline's session risk profile (session_risk.json), under SESSION_RISK; autotrain hot-swaps new ones.
  const sr = loadSessionRiskFile(modelPaths.session_risk);
  if (sr) { engine.setSessionRiskAuto(sr.profile); log.info(`session risk ${sr.version}${cfg.strategy.sessionRiskAuto ? '' : ' loaded, not applied (SESSION_RISK_AUTO off)'}`, { sessions: Object.keys(sr.profile) }); }
  engineRef = engine;
  // Module ledger once an hour (and 5 minutes after start) in the audit log, for the daily module report
  // (deploy/module_report.py): which parts were on, shadow, off or benched, and what flagged them.
  const writeLedger = () => { try { audit.write('modules', { rows: engine.moduleLedger() }); } catch (e) { log.warn('module ledger failed', { error: String(e) }); } };
  setTimeout(writeLedger, 300_000).unref();
  setInterval(writeLedger, 3_600_000).unref();
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
    md.on('trade', (t: { ticker: string; price: number; count: number; takerSide: 'yes' | 'no' | undefined; ts?: number }) => paper.onTrade(t.ticker, t.price, t.count, t.takerSide, t.ts));
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
  const app = createApi({ kalshiCheck, cfg, audit, engine, oms, kill, recon, model, tca, md, vault, autoTrain, control, training, settlement, restart: () => void shutdown('restart (dashboard)', 75), startedAt: Date.now() });
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
    oms.flush();
    kalshiCheck.flush();
    paper?.flush();
    accuracyGate.flush();
    autoTrain.stop();
    try { engine.saveSnnBlender(); await Promise.all(Object.values(engine.snn?.units ?? {}).map((u) => u!.host.stop())); } catch (e) { log.error('SNN checkpoint on shutdown failed', { error: String(e) }); }
    audit.write('shutdown', { sig });
    md.stop();
    server.close(() => process.exit(code));
    setTimeout(() => process.exit(code), 5000).unref();
  };
  // A new (or rolled back) conditioning champion: restart once to apply it everywhere.
  if (cfg.conditioningApply) watchChampion(cfg.autoTrain.dir, (v) => { audit.write('config', { event: 'conditioning_champion', version: v }); log.warn('conditioning champion changed: restarting to apply it', { version: v }); void shutdown(`conditioning champion ${v ?? 'removed'}`, 75); });
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
