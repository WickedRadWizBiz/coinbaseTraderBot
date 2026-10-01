// Entry point. Wires the components; all behaviour lives in the modules.

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
import { ClockSkewMonitor } from './risk/clockSkew';
import { EquityGuard } from './risk/equityGuard';
import { PerpHedger } from './perps/hedger';
import { PerpModel } from './perps/perpSignal';
import { PerpTrader } from './perps/perpTrader';
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
import { createSnn } from './snn';
import { logger } from './util/log';

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
  fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
  const audit = new AuditLog(path.join(cfg.dataDir, 'audit'));
  audit.write('startup', { pid: process.pid, node: process.version, config: publicConfig(cfg as Config) });

  const sinks: AlertSink[] = [];
  if (cfg.alertTelegramToken && cfg.alertTelegramChatId) sinks.push(new TelegramSink(cfg.alertTelegramToken, cfg.alertTelegramChatId));
  if (cfg.alertWebhookUrl) sinks.push(new WebhookSink(cfg.alertWebhookUrl));
  const alerter = new Alerter(sinks, audit);

  // Model: frozen, versioned, validated offline. Identity (pure fair value) if no file.
  let model: MetaModel;
  if (fs.existsSync(cfg.paramsPath)) {
    model = MetaModel.load(cfg.paramsPath);
  } else {
    log.warn(`no model params at ${cfg.paramsPath}; using identity model (pure fair value)`);
    model = MetaModel.identity();
  }
  if (cfg.mode === 'live') {
    const blockers = model.liveBlockers();
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
  const vp = loadVolProfile(cfg.strategy.volProfilePath);
  if (vp && cfg.strategy.volSeasonality) {
    if (vp.validation?.improved) {
      volProfile = vp;
      log.info(`applying intraday volatility profile ${vp.version}`);
    } else {
      log.warn(`vol profile ${vp.version} not applied: validation did not show improvement`);
    }
  }

  const signer = cfg.kalshiKeyId && cfg.kalshiPrivateKeyPath ? KalshiSigner.fromFile(cfg.kalshiKeyId, cfg.kalshiPrivateKeyPath) : undefined;
  const clock = new ClockSkewMonitor(cfg.clockSkewMaxMs || 2000, cfg.clockSkewWarnMs);
  const rest = new KalshiRest({ baseUrl: cfg.restBaseUrl, signer, subaccount: cfg.kalshiSubaccount, onServerDate: (d, s, r) => clock.observe(d, s, r) });
  const indexIds = Object.keys(cfg.indexIdMap);
  const ws = signer ? new KalshiWs(cfg.wsUrl, signer, indexIds) : undefined;
  const md = new MarketData(cfg, rest, ws, new Recorder(path.join(cfg.dataDir, 'recordings')));

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
  const equityGuard = new EquityGuard({ ddScaleAt: cfg.strategy.ddScaleAt, weeklyLossPause: cfg.strategy.weeklyLossPause }, path.join(cfg.dataDir, 'equity_guard.json'));
  const modelHealth = new ModelHealth({ minWindows: cfg.strategy.modelHealthMinWindows }, path.join(cfg.dataDir, 'model_health.json'));
  const calendar = loadCalendar(path.resolve(process.env.MACRO_CALENDAR_PATH ?? './params/calendar.json'));
  if (!calendar) log.info('no macro calendar (params/calendar.json): calendar features unavailable');
  // Perps: one executor per perps account drives each position to hedge (stage 2) + directional
  // (stage 3) targets, simulated against live perp quotes (paper) or with real orders (live).
  let hedger: PerpHedger | undefined;
  let perpTrader: PerpTrader | undefined;
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
    if (P.trading !== 'off') {
      const perpModel = PerpModel.load(P.modelPath);
      if (!perpModel) log.warn(`no perp model at ${P.modelPath}: trading the momentum prior at pilot size ($${P.pilotMaxNotionalUsd}, ${P.pilotMaxLeverage}x)`);
      else if (!perpModel.validated()) log.warn(`perp model ${perpModel.params.version} not validated (${perpModel.blockers().join('; ')}): pilot size only`);
      perpTrader = new PerpTrader({
        params: {
          horizonMin: P.horizonMin, entryEdgeBps: P.entryEdgeBps, exitEdgeBps: P.exitEdgeBps, kellyFraction: P.kellyFraction, maxLeverage: P.maxLeverage,
          maxNotionalUsd: P.maxTradeNotionalUsd, maxTotalNotionalUsd: P.maxTotalNotionalUsd, stopAtrMult: P.stopAtrMult, minStopBps: P.minStopBps, maxHoldMin: P.maxHoldMin,
          dailyLossFrac: P.dailyLossFrac, cooldownMin: P.cooldownMin, pilotMaxNotionalUsd: P.pilotMaxNotionalUsd, pilotMaxLeverage: P.pilotMaxLeverage, priorIc: P.priorIc,
          makerBps: P.makerFeeBps, requireValidation: P.requireValidation, minEquityUsd: P.minEquityUsd,
        },
        hub, gateway: perpGateway, model: perpModel, audit,
        sources: (asset) => ({ index: md.index.get(asset), spot: md.spot.get(asset), bars: md.features.bars.get(asset), candles: md.features.candles.get(asset), usdtd: md.usdtd, btcd: md.btcd, perp: hub.get(asset) }),
      });
    }
    kill.bindCancelAll(async (reason) => { await oms.cancelAll(reason); await hedger!.cancelAll(reason); });
    log.info('perps enabled', { hedge: P.hedge, trading: P.trading, gateway: perpGateway.name });
  }
  // Cortex-like SNN: shadow by default; in blend mode alpha is earned (<= 0.25) by out-of-sample Brier.
  const snn = createSnn(cfg.snn);
  if (snn) {
    try {
      await snn.host.start();
      log.info('SNN started', { mode: cfg.snn.mode, stage: cfg.snn.stage, host: snn.host.mode, version: snn.host.version, restored: snn.host.restoredFrom });
    } catch (e) {
      log.error('SNN failed to start; continuing without it', { error: String(e) });
    }
  }
  const engine = new Engine({ cfg, audit, alerter, md, gateway, oms, risk, kill, recon, model, volProfile, vault, balanceMonitor, balanceMonitorPath, tca, equityGuard, modelHealth, calendar, hedger, perpTrader, clock, snn });

  // Execution events -> OMS (same path for paper and live).
  if (paper) {
    paper.on('fill', (f) => oms.onFill(f));
    paper.on('order', (o) => oms.onExchangeOrder(o));
    md.on('trade', (t: { ticker: string; price: number; count: number; takerSide: 'yes' | 'no' | undefined }) => paper.onTrade(t.ticker, t.price, t.count, t.takerSide));
    md.on('lifecycle', (e: { ticker: string; event: string; result?: string }) => {
      if ((e.result === 'yes' || e.result === 'no') && /settle|determin/i.test(e.event)) paper.settle(e.ticker, e.result);
    });
    // Settle the paper account from the exchange's official results.
    setInterval(async () => {
      for (const p of await paper.getPositions()) {
        const closeTs = md.markets.get(p.ticker)?.closeTime ?? oms.positions.get(p.ticker)?.closeTs ?? 0;
        if (!closeTs || Date.now() < closeTs) continue;
        try {
          const info = await rest.getMarket(p.ticker);
          if (info?.result === 'yes' || info?.result === 'no') {
            paper.settle(p.ticker, info.result);
            md.recordResult(p.ticker, info.result);
          }
        } catch { /* retry next interval */ }
      }
    }, 30_000).unref();
  } else if (ws) {
    ws.on('fill', (f) => oms.onFill(f));
    ws.on('user_order', (o) => oms.onExchangeOrder(o));
  }
  oms.on('fill', (f, rec, fee) => tca.onFill(f, rec, fee));

  if (kill.engaged) {
    log.warn('kill switch is ENGAGED from a previous run; no orders will be sent until it is reset', kill.status());
    await oms.cancelAll('startup with kill switch engaged');
  }

  md.start();
  await engine.start();

  const app = createApi({ cfg, audit, engine, oms, kill, recon, model, tca, md, vault, startedAt: Date.now() });
  const server = app.listen(cfg.port, cfg.host, () => log.info(`operator API on http://${cfg.host}:${cfg.port} (token required)`));

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.warn(`received ${sig}; cancelling resting orders and shutting down`);
    engine.stop();
    try { await oms.cancelAll(`shutdown (${sig})`); } catch (e) { log.error('cancel on shutdown failed', { error: String(e) }); }
    paper?.flush();
    try { await snn?.host.stop(); } catch (e) { log.error('SNN checkpoint on shutdown failed', { error: String(e) }); }
    audit.write('shutdown', { sig });
    md.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
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
