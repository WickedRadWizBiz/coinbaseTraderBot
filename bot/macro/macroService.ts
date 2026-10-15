// Live side of the Fractal Alignment Engine and waterfall mode (bot/macro/fractalEngine.ts, bot/macro/waterfall.ts):
// keeps the engine's state and the waterfall legs current from the history store's daily BTC.D / USDT.D (spliced
// with the bot's own hourly bars, so they stay current between TradingView refreshes) and SHIB candles, latches
// the first 55% hit, holds the operator's arming switch, and hands the strategies their policy:
//   engine (Kalshi binaries)   kalshiBlocked / kalshiMaxFrac
//   engine (tennis)            tennisBlocked
//   setup trader (perps)       perpMult(asset, side), and the fractal inputs for the setup scorer
// Recomputed at most every refreshMs (the inputs are daily and weekly); a level change and the gate latch are
// written to the audit log.

import type { AuditLog } from '../audit/auditLog';
import type { Candle } from '../ta/indicators';
import { logger } from '../util/log';
import { loadSpotSeries } from '../marketdata/historyStore';
import { DEFAULT_FRACTAL, projectedCross, type FractalConfig } from './fractalEngine';
import { MacroSeries, type MacroInputs } from './macroSeries';
import { DEFAULT_WATERFALL, gateHit, waterfallPolicy, WaterfallSwitch, type WaterfallLevel, type WaterfallParams, type WaterfallPolicy } from './waterfall';

const log = logger('macro');
const HOUR = 3_600_000;

export interface MacroServiceDeps {
  historyDir?: string;
  /** Daily index series (the IndexStore's spliced BTC.D / USDT.D). */
  index: (asset: 'BTC.D' | 'USDT.D') => Candle[] | undefined;
  /** DATA_DIR/waterfall.json: the gate latch and the arming switch. */
  file?: string;
  params?: WaterfallParams;
  fractal?: FractalConfig;
  audit?: AuditLog;
  now?: () => number;
  refreshMs?: number;
}

export class MacroService {
  readonly sw: WaterfallSwitch;
  private readonly params: WaterfallParams;
  private series?: MacroSeries;
  private key = '';
  private shib?: { at: number; c: Candle[] };
  private checked = -Infinity;
  private inputsNow?: MacroInputs;
  private level: WaterfallLevel = 'off';
  private current: WaterfallPolicy = waterfallPolicy('off', DEFAULT_WATERFALL);
  private lastError?: string;

  constructor(private readonly d: MacroServiceDeps) {
    this.params = d.params ?? DEFAULT_WATERFALL;
    this.sw = new WaterfallSwitch(d.file);
  }

  private now(): number { return (this.d.now ?? Date.now)(); }

  /** Recompute when due (or forced). */
  refresh(force = false): void {
    const now = this.now();
    if (!force && now - this.checked < (this.d.refreshMs ?? 60_000)) return;
    this.checked = now;
    try {
      const btcd = this.d.index('BTC.D') ?? [], usdtd = this.d.index('USDT.D') ?? [];
      if (this.d.historyDir && (!this.shib || now - this.shib.at > HOUR)) {
        try { this.shib = { at: now, c: loadSpotSeries(this.d.historyDir, 'SHIB', '1d').candles }; } catch { this.shib = { at: now, c: [] }; }
      }
      // A new series object when an input gained a bar or a closed bar changed (its caches are point in time and
      // nothing reads the forming day, so they stay valid otherwise: about one rebuild a day).
      const closed = (cs: Candle[]) => { const b = cs[cs.length - 2]; return `${cs.length}:${cs[cs.length - 1]?.ts}:${b?.ts}:${b?.c}`; };
      const key = `${closed(btcd)}|${closed(usdtd)}|${this.shib?.c.length ?? 0}`;
      if (!this.series || key !== this.key) { this.series = new MacroSeries({ btcd, usdtd, shib: this.shib?.c }, this.params, this.d.fractal ?? DEFAULT_FRACTAL); this.key = key; }
      this.inputsNow = this.series.at(now);
      const hit = gateHit(btcd, now, this.params.gate);
      if (this.sw.observe(hit)) {
        log.info('BTC.D hit the waterfall gate: the mode can now be armed', { level: hit!.level, peak: hit!.peak });
        this.d.audit?.write('waterfall', { event: 'gate_hit', btcd: hit!.level, peak: hit!.peak, gate: this.params.gate, ts: hit!.ts });
      }
      this.apply();
      this.lastError = undefined;
    } catch (e) {
      this.lastError = String(e);
      log.warn('macro refresh failed', { error: this.lastError });
    }
  }

  private apply(): void {
    const wf = this.inputsNow?.wf;
    const level: WaterfallLevel = !this.sw.armed ? 'off' : wf?.signal ? 'triggered' : 'armed';
    this.current = waterfallPolicy(level, this.params, wf?.btcd, this.inputsNow?.fractal?.low?.btcd);
    if (level !== this.level) {
      this.d.audit?.write('waterfall', { event: 'level', from: this.level, to: level, why: this.current.why, legs: wf?.legs ?? null });
      log.info('waterfall mode', { from: this.level, to: level, why: this.current.why });
      this.level = level;
    }
  }

  /** The policy for new entries now. */
  policy(): WaterfallPolicy { this.refresh(); return this.current; }

  /** The engine's state and the legs now (the setup scorer's fractal inputs). */
  inputs(): MacroInputs | undefined { this.refresh(); return this.inputsNow; }

  setArmed(on: boolean, by = 'dashboard'): { ok: boolean; error?: string } {
    if (on) this.refresh(true); // latch a gate hit that arrived since the last refresh before judging
    const r = this.sw.setArmed(on, by, this.now());
    if (r.ok) { this.d.audit?.write('waterfall', { event: on ? 'armed' : 'disarmed', by }); this.refresh(true); }
    return r;
  }

  status() {
    this.refresh();
    const f = this.inputsNow?.fractal, wf = this.inputsNow?.wf;
    const cross = f ? projectedCross(f, this.params.gate) : undefined;
    return {
      ...this.sw.status(),
      level: this.level, why: this.current.why, gate: this.params.gate, params: this.params,
      legs: wf?.legs ?? null, signal: wf?.signal ?? false, confirmations: wf?.confirmations ?? 0, readings: wf?.why ?? [],
      btcd: wf?.btcd ?? null, usdtd: wf?.usdtd ?? null, shibVelocity: wf?.shibVelocity ?? null,
      parentHistory: this.series?.hasParent() ?? false,
      fractal: f ? {
        asOf: f.asOf, parentDate: new Date(f.parentTs).toISOString().slice(0, 10), progress: f.progress, phase: f.phase, swing: f.swing,
        dilation: f.dilation, localDilation: f.localDilation, map: f.map, fit: f.fit, proj: f.proj, nextWaterfall: f.nextWaterfall ?? null, low: f.low ?? null,
        projectedGateCross: cross ?? null,
        // Weekly chart: the child, the parent mapped onto it, and the projection.
        chart: { child: f.path.map((p) => [p.childTs, +p.btcd.toFixed(2), +p.mapped.toFixed(2)]), projection: f.projection.map((q) => [Math.round(q.ts), +q.btcd.toFixed(2)]) },
      } : null,
      error: this.lastError ?? null,
    };
  }
}

let live: MacroService | undefined;
export function setMacro(m: MacroService | undefined): void { live = m; }
export function macro(): MacroService | undefined { return live; }
