// Operator API. Read-only by design:
//  - Bound to loopback by default (reach it through an SSH tunnel/Tailscale).
//  - With DASHBOARD_PASSWORD set, every /api route requires it as the bearer (constant-time compare),
//    with a lockout after repeated failures. Without one the dashboard is open (no login).
//  - Write actions: the kill switch (engage / reset with a confirmation phrase), PLAY / STOP (pause new
//    entries), and the PAPER / LIVE switch, which rewrites TRADING_MODE (and the perps / tennis modes) in
//    the server's bot.env and restarts the bot; a switch whose settings would not start (e.g. live without
//    Kalshi keys) is refused before anything is written. No route writes credentials.

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
import type { KalshiCheck } from '../recon/kalshiCheck';
import { FEATURES } from '../model/featureEngine';
import { ladderQuotes, scanLadder } from '../model/ladder';
import type { MetaModel } from '../model/metaModel';
import type { AutoTrainer } from '../autotrain';
import type { Tca } from '../tca/tca';
import type { MarketData } from '../marketdata/marketData';
import { SpotBookService } from '../marketdata/spotBook';
import type { Vault } from '../vault/vault';

import { BOOK_RULES, CONFLUENCES, KNOWLEDGE, RULES } from '../ta/knowledge';
import { marketContext } from '../ta/marketContext';
import { activeRuleBook } from '../strategy/ruleBook';
import { conditioningStatus, rollbackChampion } from '../strategy/conditioningOverlay';
import { activeGpSignals } from '../gp/gpSignals';
import { buildNeuralMap } from './neuralMap';
import type { TrainingSupervisor } from '../training/supervisor';
import type { SettlementSweeper } from '../paper/settlementSweeper';
import type { RunControl } from '../control';
import { ConfigError, loadConfig } from '../config';
import { latencySnapshot } from '../util/latency';
import { cpuProfile } from '../util/profile';
import { updateEnvFile } from '../util/envFile';
import { studyFor, studyMeta } from '../ta/study';

export interface ApiDeps {
  kalshiCheck?: KalshiCheck;
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
  vault?: Vault;
  autoTrain?: AutoTrainer;
  control?: RunControl;
  /** Paper training override and capital-exhaustion epochs (bot/training/supervisor.ts). */
  training?: TrainingSupervisor;
  /** Paper settlement sweeper (held contracts awaiting Kalshi's result). */
  settlement?: SettlementSweeper;
  /** Restart the bot (systemd starts it again). */
  restart?: () => void;
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
    // No password sent at all (the login screen's own polls before anything is typed): refuse, but it is
    // not a guess, so it does not count toward the lockout.
    if (!provided) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
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

function dominanceStatus(md: MarketData) {
  const now = Date.now();
  const pctChange = (tr: MarketData['usdtd'], sec: number) => {
    const ser = tr.series(now, sec, 10_000);
    return ser ? (ser[ser.length - 1] / ser[0] - 1) * 100 : null;
  };
  const u = md.usdtd.fresh(now, 10_000);
  const b = md.btcd.fresh(now, 10_000);
  return {
    enabled: Boolean(md.dominance),
    usdtd: u?.value ?? null,
    btcd: b?.value ?? null,
    usdtdChange5mPct: pctChange(md.usdtd, 300),
    usdtdChange15mPct: pctChange(md.usdtd, 900),
    btcdChange5mPct: pctChange(md.btcd, 300),
    btcdChange15mPct: pctChange(md.btcd, 900),
    coveredShare: md.dominance?.latest?.coveredShare ?? null,
    anchoredAt: md.dominance?.calc.anchoredAt || null,
    error: md.dominance?.lastError ?? null,
  };
}

export function createApi(d: ApiDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // Behind Caddy on this machine the socket peer is always 127.0.0.1: trust its X-Forwarded-For so each
  // visitor has their own address (the login lockout is per address, not one shared by everyone).
  app.set('trust proxy', 'loopback');
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
  // Browser hardening (also set by Caddy over HTTPS): no framing of the controls (clickjacking), no MIME
  // sniffing, no referrer leaking the address, no fingerprinting header.
  app.disable('x-powered-by');
  app.use((_req, res, next) => { res.set({ 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); next(); });
  app.use(express.json({ limit: '4kb' }));

  const api = express.Router();
  // Unauthenticated: tells the web app whether to show the login screen.
  api.get('/auth', (_req, res) => { res.json({ required: !!d.cfg.dashboardPassword }); });
  if (d.cfg.dashboardPassword) api.use(authMiddleware(d.cfg.dashboardPassword));
  // /status is built at most once a second (every open dashboard tab polls it); any write action
  // (kill switch, PLAY/STOP, mode, vault) drops the cached copy so the next poll shows its effect.
  let statusCache: { at: number; body: unknown } | undefined;
  api.use((req, _res, next) => { if (req.method !== 'GET') statusCache = undefined; next(); });

  api.get('/status', (_req, res) => {
    if (statusCache && Date.now() - statusCache.at < 1000) return res.json(statusCache.body);
    const bankroll = d.engine.bankroll();
    const body = ({
      mode: d.cfg.mode,
      kalshiEnv: d.cfg.kalshiEnv,
      uptimeSec: Math.round((Date.now() - d.startedAt) / 1000),
      model: {
        id: d.engine.model.id,
        kind: d.engine.model.params.kind,
        features: d.engine.model.params.features,
        selected: d.engine.model.params.training?.selected ?? null,
        importance: d.engine.model.params.training?.holdoutImportance ?? null,
        liveBlockers: d.engine.model.liveBlockers(),
        validation: d.engine.model.params.validation ?? null,
      },
      kill: d.kill.status(),
      haltReasons: d.engine.haltReasons(),
      recon: d.recon.lastResult ?? null,
      balance: d.engine.balance ?? null,
      bankroll: bankroll ?? null,
      recording: { series: d.cfg.strategy.recordSeries, markets: d.md.recordedMarkets().filter((m) => m.recordOnly).length },
      dailyPnl: d.engine.dailyPnl(),
      dailyLossLimit: d.engine.dailyLossLimit(),
      indexSource: d.md.indexSource,
      exitPolicy: d.cfg.strategy.exitPolicy,
      session: d.engine.sessionStatus(),
      guards: d.engine.guardStatus(),
      perps: d.engine.perpStatus(),
      snn: d.engine.snnBrief(),
      treeModels: d.engine.treeModelStatus(),
      autoTrain: d.autoTrain ? (() => { const a = d.autoTrain!.status(); return { mode: a.mode, running: a.running, paused: a.paused, window: a.window, nextRun: a.nextRun, lastExit: a.lastExit, lastSwap: a.swaps[0] ?? null }; })() : null,
      tennis: {
        enabled: d.cfg.tennis.enabled,
        trading: d.cfg.tennis.enabled && (d.cfg.mode !== 'live' || d.cfg.tennis.live),
        budget: d.engine.tennisBudget(),
        matches: [...d.engine.tennisStatus.values()],
      },
      vault: d.vault?.status() ?? null,
      dominance: dominanceStatus(d.md),
      wsConnected: d.md.wsConnected,
      catalog: d.md.catalogHealth,
      training: d.training?.status() ?? null,
      entryDiagnosis: d.engine.entryDiagnosis(),
      feeds: d.engine.feedHealth(),
      // Kalshi's own index channel: what arrived, what parsed, ids seen, raw samples, subscription acks.
      kalshiIndexFeed: d.md.indexFeedStats(),
      // Directional system context: breadth, risk gauges, each coin's character (bot/ta/marketContext.ts).
      market: marketContext()?.status() ?? null,
      // Evolved formulas (research/gpIndicators.ts): each coin's champion, whether it is validated, its test record.
      gp: (() => { const g = activeGpSignals(); const cs = g?.champions(); if (!g || !cs || !Object.keys(cs).length) return null; return { version: g.version() ?? null, champions: Object.fromEntries(Object.entries(cs).map(([a, c]) => [a, { formula: c.formula, validated: c.validated, why: c.why ?? null, test: c.test ?? null }])) }; })(),
      conditioning: conditioningStatus(d.cfg.autoTrain.dir),
      ruleBook: (() => { const rb = activeRuleBook(); const m = rb?.meta(); if (!rb || !m) return null; const p = rb.passed(); const pc = rb.passedCombos(), cd = rb.passedConditions(), iv = rb.passedInvalidations(); return { ...m, invalidations: iv.length, topInvalidations: iv.slice(0, 12).map((v) => `${v.key} ${v.h}h invalidated by ${v.by}${/>=/.test(v.by) ? '' : ` (${v.rel})`}`), conditions: { makes: cd.filter((c) => c.effect === 'makes').length, breaks: cd.filter((c) => c.effect === 'breaks').length }, topConditions: cd.slice(0, 12).map((c) => `${c.key} ${c.effect} ${c.h}h when ${c.param} in [${c.lo ?? '-inf'}, ${c.hi ?? 'inf'})`), passed: p.length, top: p.sort((a, b) => b.weight - a.weight).slice(0, 12).map((r) => `${r.id}@${r.tf} ${r.h}h [${r.cls}] w${r.weight}`), pairs: pc.length, topPairs: [...pc].sort((a, b) => b.weight - a.weight).slice(0, 12).map((c) => `${c.parts[0]} + ${c.parts[1]} ${c.h}h w${c.weight}${c.bracket?.ok ? ` (TP ${100 * c.bracket.tp}% / SL ${100 * c.bracket.sl}%)` : ''}`) }; })(),
      settlement: d.settlement?.status() ?? null,
      kalshiCheck: d.kalshiCheck?.status() ?? null,
      latency: latencySnapshot(),
      run: d.control?.status() ?? { active: true, since: null },
      perpsMode: d.cfg.perps.trading,
      consecutiveOrderErrors: d.oms.consecutiveErrors,
    });
    statusCache = { at: Date.now(), body };
    res.json(body);
  });

  api.get('/autotrain', (_req, res) => res.json(d.autoTrain?.status() ?? { mode: 'off' }));
  // Run the training pipeline now (body: { only?: "snn" | "mlp,snn" | ... }).
  api.post('/autotrain/run', (req, res) => {
    if (!d.autoTrain) return res.status(400).json({ error: 'auto-train not available' });
    const only = typeof req.body?.only === 'string' && req.body.only ? ['--only', req.body.only] : [];
    const started = d.autoTrain.run(only);
    d.audit.write('config', { event: 'pipeline_requested', only: req.body?.only ?? null, started });
    res.json({ started, queued: !started });
  });

  api.get('/snn', async (_req, res) => res.json(await d.engine.snnStatus()));
  // The neural map page: every network as a block of pixels, in the order information flows.
  api.get('/neural-map', async (_req, res) => res.json(await buildNeuralMap(d)));

  // Kalshi check: bot vs Kalshi fills, settlements and cash; mismatches and the day-by-day comparison.
  api.get('/kalshi-check', (_req, res) => res.json(d.kalshiCheck?.report() ?? null));
  // CPU, disk writes and memory: the last minute, and 10-minute buckets over 24 h (bot/engine.ts CpuMeter).
  api.get('/cpu', (_req, res) => res.json({ now: d.engine.cpu.status(), history: d.engine.cpu.history() }));
  // On-demand main-thread CPU profile for diagnostics (?sec=1..15; once a minute; read-only).
  api.get('/debug/profile', async (req, res) => { res.json(await cpuProfile(Number(req.query.sec ?? 10))); });
  api.get('/markets', (_req, res) => res.json([...d.engine.status.values()].sort((a, b) => a.closeTs - b.closeTs || a.ticker.localeCompare(b.ticker))));

  // Open positions and those settled in the last 24 h (?all=1: the three days kept). The dashboard polls
  // this every few seconds; the full list is hundreds of settled markets.
  api.get('/positions', (req, res) => {
    const cut = req.query.all === '1' ? -Infinity : Date.now() - 86_400_000;
    res.json(d.oms.positions.all().filter((m) => !m.settled || (m.settledTs ?? Infinity) >= cut)
      .map((m) => ({ ...m, maxLoss: PositionBook.maxLoss(m), scenario: PositionBook.scenario(m) })).sort((a, b) => b.closeTs - a.closeTs));
  });

  api.get('/orders', (req, res) => {
    const live = req.query.live === '1';
    res.json(live ? d.oms.liveOrders() : d.oms.allOrders(Number(req.query.limit) || 200));
  });

  api.get('/tca', (_req, res) => res.json(d.tca.summary()));

  // Candidate feature registry (for the Strategy Brain view).
  api.get('/features', (_req, res) => res.json(Object.entries(FEATURES).map(([name, f]) => ({ name, group: f.group, tier: f.tier ?? 'T1', description: f.description }))));

  // Depth view: the contract's YES book as the bot sees it.
  api.get('/order-book/:ticker', (req, res) => {
    const ticker = req.params.ticker;
    const book = d.md.books.get(ticker);
    const m = d.md.markets.get(ticker);
    if (!book || !m) {
      // A contract the bot still holds after its market closed: no book any more, awaiting Kalshi's result.
      const pos = d.oms.positions.get(ticker);
      if (pos && !pos.settled) {
        res.json({ ticker, closed: true, usable: false, bids: [], asks: [], closeTs: pos.closeTs || null, position: pos.yes, reason: pos.closeTs && pos.closeTs < Date.now() ? 'market closed: awaiting settlement' : 'market not tracked' });
        return;
      }
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

  // Hourly strike-ladder consistency and arbitrage scan (report only).
  api.get('/ladder', (_req, res) => {
    const groups = new Map<string, { asset: string; closeTime: number }>();
    for (const m of d.md.markets.values()) if (m.kind !== 'updown' && !m.recordOnly) groups.set(`${m.asset}:${m.closeTime}`, { asset: m.asset, closeTime: m.closeTime });
    res.json([...groups.values()].sort((a, b) => a.closeTime - b.closeTime).map((g) => {
      const quotes = ladderQuotes(d.md.markets.values(), (t) => d.md.books.get(t), g.asset, g.closeTime);
      const first = quotes[0];
      return { ...g, ...scanLadder(quotes, first ? d.md.feesFor(first.ticker) : undefined) };
    }));
  });

  // TA library: the knowledge base, and each asset's live reading of the spot chart.
  api.get('/ta/library', (_req, res) => {
    res.json({
      knowledge: KNOWLEDGE,
      rules: RULES.map(({ evaluate: _e, ...r }) => r),
      bookRules: BOOK_RULES.map(({ evaluate: _e, ...r }) => r),
      confluences: CONFLUENCES,
      study: studyMeta(d.cfg.taStudyPath) ?? null,
    });
  });
  api.get('/ta', (_req, res) => {
    const now = Date.now();
    const out = [...d.md.features.candles.values()].map((set) => {
      const snap = set.snapshot(now, { usdtdChg: undefined, btcdChg: undefined });
      const tf = Object.fromEntries(Object.entries(snap.tf).map(([k, s]) => [k, s && {
        lastClosed: set.lastTs(k as never) ?? null, close: s.close, rsi: s.rsi, macdHist: s.macdHist, adx: s.adx, plusDI: s.plusDI, minusDI: s.minusDI,
        bbPctB: s.bbPctB, squeeze: s.squeeze, atrPct: s.atrPct, ema21: s.ema21, ema50: s.ema50, sma200: s.sma200, cloud: s.cloud, stochK: s.stochK,
        cmf: s.cmf, mfi: s.mfi, obvSlope: s.obvSlope, vwap: s.vwap, profile: s.profile, trend: s.trend, sweep: s.sweep, bos: s.bos, choch: s.choch, round: s.round,
      }]));
      return {
        asset: set.asset, net: snap.net, tf,
        signals: snap.signals.map((x) => ({ ...x, study: studyFor(d.cfg.taStudyPath, 'rule', x.id, x.tf) ?? null })),
        confluences: snap.confluences.filter((c) => c.score !== 0).map((c) => ({ ...c, study: studyFor(d.cfg.taStudyPath, 'confluence', c.id, 'multi') ?? null })),
      };
    });
    res.json({ study: studyMeta(d.cfg.taStudyPath) ?? null, assets: out });
  });

  api.get('/audit', (req, res) => {
    const limit = Math.min(500, Number(req.query.limit) || 100);
    const kind = typeof req.query.kind === 'string' ? (req.query.kind as AuditKind) : undefined;
    res.json(d.audit.tail(limit, kind));
  });

  api.get('/config', (_req, res) => res.json(publicConfig(d.cfg as Config)));

  // Record a withdrawal the detector missed (or before the next reconciliation).
  // Bookkeeping only: nothing is sent to Kalshi. Comes out of the vault first.
  api.post('/vault/withdrawal', (req, res) => {
    const amount = Number(req.body?.amount);
    if (!d.vault || !(amount > 0) || amount > 1e7) {
      res.status(400).json({ error: 'body must include a positive "amount" in dollars' });
      return;
    }
    const split = d.engine.recordWithdrawal(amount, `api:${req.ip}`);
    res.json({ ...split, status: d.vault.status() });
  });

  // PLAY / STOP: stopping pauses new entries and cancels resting orders (exits are re-placed by the engine).
  api.post('/run', async (req, res) => {
    if (!d.control) return res.status(400).json({ error: 'run control not available' });
    const active = req.body?.active === true;
    d.control.set(active);
    d.audit.write('config', { event: active ? 'bot_play' : 'bot_stop', by: 'dashboard' });
    if (!active) { try { await d.oms.cancelAll('stopped from the dashboard'); } catch { /* reported by the OMS */ } }
    res.json({ ok: true, run: d.control.status() });
  });

  // Kill-switch override (paper training): ON = automatic brakes de-risk instead of halting and exhausted
  // paper pools are refilled; OFF = the kill switch behaves as in live. Persisted; no effect in live mode.
  api.post('/override', async (req, res) => {
    if (!d.control) return res.status(400).json({ error: 'run control not available' });
    const on = req.body?.on === true;
    d.control.setOverride(on);
    d.audit.write('config', { event: on ? 'kill_override_on' : 'kill_override_off', by: 'dashboard' });
    await d.training?.tick();
    res.json({ ok: true, run: d.control.status(), training: d.training?.status() ?? null });
  });

  // PAPER / LIVE: rewrite the modes in bot.env and restart. Live needs { confirm: 'LIVE' } (the dashboard's
  // double-tap + double-tap dialog) and settings that pass the same checks as a start would.
  api.post('/mode', (req, res) => {
    const mode = req.body?.mode;
    if (mode !== 'paper' && mode !== 'live') return res.status(400).json({ error: 'mode must be paper or live' });
    if (mode === 'live' && req.body?.confirm !== 'LIVE') return res.status(400).json({ error: 'live mode needs the double-tap confirmation' });
    if (mode === d.cfg.mode) return res.json({ ok: true, mode, restarting: false });
    const perps = (v: string) => (v === 'off' ? 'off' : mode);
    const changes: Record<string, string> = {
      TRADING_MODE: mode,
      PERP_TRADING: perps(d.cfg.perps.trading),
      PERP_HEDGE: perps(d.cfg.perps.hedge),
      TENNIS_LIVE: mode === 'live' && d.cfg.tennis.enabled ? 'true' : 'false',
      ...(mode === 'live' ? { KALSHI_ENV: 'prod', LIVE_TRADING_ACKNOWLEDGED: 'I_ACCEPT_REAL_MONEY_RISK' } : {}),
    };
    try { loadConfig({ ...process.env, ...changes }); } catch (e) {
      return res.status(400).json({ error: e instanceof ConfigError ? e.message : String(e) });
    }
    if (!fs.existsSync(d.cfg.botEnvFile)) return res.status(400).json({ error: `bot.env not found at ${d.cfg.botEnvFile}` });
    try { updateEnvFile(d.cfg.botEnvFile, changes); } catch (e) { return res.status(500).json({ error: `could not write bot.env: ${String(e)}` }); }
    d.audit.write('config', { event: 'mode_switch', from: d.cfg.mode, to: mode, changes: Object.keys(changes) });
    res.json({ ok: true, mode, restarting: Boolean(d.restart) });
    if (d.restart) setTimeout(d.restart, 500);
  });

  // Conditioning champion rollback: the previous champion back (or the configured settings), then restart.
  api.post('/conditioning/rollback', (req, res) => {
    let r: { to: string | null };
    try { r = rollbackChampion(d.cfg.autoTrain.dir); } catch (e) { return res.status(500).json({ error: String(e) }); }
    d.audit.write('config', { event: 'conditioning_rollback', to: r.to, by: 'dashboard' });
    res.json({ ok: true, to: r.to, restarting: Boolean(d.restart) });
    if (d.restart) setTimeout(d.restart, 500);
  });

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
