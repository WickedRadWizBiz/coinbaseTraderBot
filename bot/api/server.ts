// Operator API. Read-only by design:
//  - Bound to loopback by default (reach it through an SSH tunnel/Tailscale).
//  - Every /api route requires the bearer token (constant-time compare), with
//    a lockout after repeated failures.
//  - There is NO route to change settings, switch to live, write credentials,
//    restart, or reset state. The only write actions are engaging the kill
//    switch and resetting it (with an explicit confirmation phrase, and only
//    when reconciliation is clean).

import crypto from 'crypto';
import express, { NextFunction, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import type { AuditKind, AuditLog } from '../audit/auditLog';
import { publicConfig, type Config } from '../config';
import type { Engine } from '../engine';
import type { Oms } from '../oms/oms';
import { PositionBook } from '../oms/positions';
import type { KillSwitch } from '../risk/killSwitch';
import type { Reconciler } from '../recon/reconciler';
import { FEATURES } from '../model/featureEngine';
import type { MetaModel } from '../model/metaModel';
import type { Tca } from '../tca/tca';
import type { MarketData } from '../marketdata/marketData';
import { SpotBookService } from '../marketdata/spotBook';

export interface ApiDeps {
  cfg: Readonly<Config>;
  audit: AuditLog;
  engine: Engine;
  oms: Oms;
  kill: KillSwitch;
  recon: Reconciler;
  model: MetaModel;
  tca: Tca;
  md: MarketData;
  startedAt: number;
  spotBooks?: SpotBookService;
}

export function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(provided).digest();
  return crypto.timingSafeEqual(a, b);
}

export function authMiddleware(token: string, now: () => number = Date.now) {
  const failures = new Map<string, { n: number; since: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip ?? 'unknown';
    const f = failures.get(ip);
    if (f && f.n >= 10 && now() - f.since < 15 * 60_000) {
      res.status(429).json({ error: 'too many failed attempts' });
      return;
    }
    const header = req.get('authorization') ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!tokenMatches(token, provided)) {
      const cur = f && now() - f.since < 15 * 60_000 ? f : { n: 0, since: now() };
      cur.n += 1;
      failures.set(ip, cur);
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    failures.delete(ip);
    next();
  };
}

export function createApi(d: ApiDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    });
    next();
  });
  app.use(express.json({ limit: '4kb' }));

  const api = express.Router();
  api.use(authMiddleware(d.cfg.dashboardToken));

  api.get('/status', (_req, res) => {
    const bankroll = d.engine.bankroll();
    res.json({
      mode: d.cfg.mode,
      kalshiEnv: d.cfg.kalshiEnv,
      uptimeSec: Math.round((Date.now() - d.startedAt) / 1000),
      model: {
        id: d.model.id,
        kind: d.model.params.kind,
        features: d.model.params.features,
        selected: d.model.params.training?.selected ?? null,
        importance: d.model.params.training?.holdoutImportance ?? null,
        liveBlockers: d.model.liveBlockers(),
        validation: d.model.params.validation ?? null,
      },
      kill: d.kill.status(),
      haltReasons: d.engine.haltReasons(),
      recon: d.recon.lastResult ?? null,
      balance: d.engine.balance ?? null,
      bankroll: bankroll ?? null,
      dailyPnl: d.engine.dailyPnl(),
      dailyLossLimit: bankroll !== undefined ? Math.min(bankroll * d.cfg.risk.dailyLossLimitFrac, d.cfg.risk.dailyLossLimitUsd) : d.cfg.risk.dailyLossLimitUsd,
      indexSource: d.md.indexSource,
      wsConnected: d.md.wsConnected,
      consecutiveOrderErrors: d.oms.consecutiveErrors,
    });
  });

  api.get('/markets', (_req, res) => res.json([...d.engine.status.values()].sort((a, b) => a.closeTs - b.closeTs || a.ticker.localeCompare(b.ticker))));

  api.get('/positions', (_req, res) => {
    res.json(d.oms.positions.all().map((m) => ({ ...m, maxLoss: PositionBook.maxLoss(m), scenario: PositionBook.scenario(m) })).sort((a, b) => b.closeTs - a.closeTs));
  });

  api.get('/orders', (req, res) => {
    const live = req.query.live === '1';
    res.json(live ? d.oms.liveOrders() : d.oms.allOrders(Number(req.query.limit) || 200));
  });

  api.get('/tca', (_req, res) => res.json(d.tca.summary()));

  // Candidate feature registry (for the Strategy Brain view).
  api.get('/features', (_req, res) => res.json(Object.entries(FEATURES).map(([name, f]) => ({ name, group: f.group, description: f.description }))));

  // Depth view: the contract's YES book as the bot sees it.
  api.get('/order-book/:ticker', (req, res) => {
    const ticker = req.params.ticker;
    const book = d.md.books.get(ticker);
    const m = d.md.markets.get(ticker);
    if (!book || !m) {
      res.status(404).json({ error: 'unknown market' });
      return;
    }
    const st = d.engine.status.get(ticker);
    res.json({
      asset: m.asset,
      closeTs: m.closeTime,
      usable: book.isUsable(Date.now(), d.cfg.risk.maxBookAgeMs),
      ...book.snapshot(25),
      fairValue: st?.fairValue ?? null,
      pYes: st?.pYes ?? null,
      position: d.oms.positions.position(ticker),
    });
  });

  // Depth view: the matching spot USD pair (display only) plus the settlement index.
  const spotBooks = d.spotBooks ?? new SpotBookService();
  api.get('/spot-book/:ticker', async (req, res) => {
    const m = d.md.markets.get(req.params.ticker);
    if (!m) {
      res.status(404).json({ error: 'unknown market' });
      return;
    }
    const idx = d.md.index.get(m.asset)?.latest();
    try {
      const book = await spotBooks.get(m.asset);
      res.json({ ...book, index: idx?.value ?? null, indexTs: idx?.ts ?? null, indexSource: d.md.indexSource, strike: m.strike ?? null });
    } catch (e) {
      res.status(502).json({ error: (e as Error).message, product: `${m.asset}-USD`, index: idx?.value ?? null, strike: m.strike ?? null });
    }
  });

  api.get('/audit', (req, res) => {
    const limit = Math.min(500, Number(req.query.limit) || 100);
    const kind = typeof req.query.kind === 'string' ? (req.query.kind as AuditKind) : undefined;
    res.json(d.audit.tail(limit, kind));
  });

  api.get('/config', (_req, res) => res.json(publicConfig(d.cfg as Config)));

  api.post('/kill', async (req, res) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 200) : 'manual';
    await d.kill.engage(reason, `api:${req.ip}`);
    res.json(d.kill.status());
  });

  api.post('/kill/reset', (req, res) => {
    if (req.body?.confirm !== 'RESET KILL SWITCH') {
      res.status(400).json({ error: 'body must include {"confirm": "RESET KILL SWITCH"}' });
      return;
    }
    if (d.recon.halted) {
      res.status(409).json({ error: 'reconciliation is not clean; resolve breaks first', recon: d.recon.lastResult });
      return;
    }
    d.kill.reset(`api:${req.ip}`);
    res.json(d.kill.status());
  });

  app.use('/api', api);
  app.get('/healthz', (_req, res) => res.type('text').send('ok'));

  const webDist = path.resolve('web/dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist, { index: 'index.html' }));
  }
  return app;
}
