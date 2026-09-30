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
import { Oms } from './oms/oms';
import { PaperExchange } from './paper/paperExchange';
import { KillSwitch } from './risk/killSwitch';
import { RiskGateway } from './risk/riskGateway';
import { Reconciler } from './recon/reconciler';
import { Tca } from './tca/tca';
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
    if (blockers.length) {
      log.error(`refusing to start live: model ${model.id} is not validated: ${blockers.join('; ')}`);
      process.exit(3);
    }
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
  const rest = new KalshiRest({ baseUrl: cfg.restBaseUrl, signer, subaccount: cfg.kalshiSubaccount });
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
  const engine = new Engine({ cfg, audit, alerter, md, gateway, oms, risk, kill, recon, model, volProfile });
  const tca = new Tca(path.join(cfg.dataDir, 'tca'), (t) => md.books.get(t)?.mid());

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

  const app = createApi({ cfg, audit, engine, oms, kill, recon, model, tca, md, startedAt: Date.now() });
  const server = app.listen(cfg.port, cfg.host, () => log.info(`operator API on http://${cfg.host}:${cfg.port} (token required)`));

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.warn(`received ${sig}; cancelling resting orders and shutting down`);
    engine.stop();
    try { await oms.cancelAll(`shutdown (${sig})`); } catch (e) { log.error('cancel on shutdown failed', { error: String(e) }); }
    paper?.flush();
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
