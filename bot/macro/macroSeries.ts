// The macro series behind the Fractal Alignment Engine and waterfall mode, read point in time: BTC.D and USDT.D
// daily (the history store's spliced index series: TradingView, then the bot's own hourly bars aggregated) and
// SHIB daily spot candles. The same object serves the setup trainer (a state for every setup, computed once per
// week / day and cached) and the live bot (bot/macro/macroService.ts).

import type { MacroConfig } from '../config';
import type { Candle } from '../ta/indicators';
import { loadIndexSeries, loadSpotSeries } from '../marketdata/historyStore';
import { DEFAULT_FRACTAL, FractalCache, type FractalConfig, type FractalState } from './fractalEngine';
import { DEFAULT_WATERFALL, waterfallReading, type WaterfallParams, type WaterfallReading } from './waterfall';

const DAY = 86_400_000;

export interface MacroDaily { btcd: Candle[]; usdtd?: Candle[]; shib?: Candle[] }

/** What the setup scorer and the waterfall switch read at one time. */
export interface MacroInputs { fractal?: FractalState; wf?: WaterfallReading; gate: number }

/** Engine and waterfall settings from the config (bot/config.ts macroConfig). */
export function macroSettings(m: MacroConfig): { fractal: FractalConfig; params: WaterfallParams } {
  return { fractal: { ...DEFAULT_FRACTAL, parentFrom: m.parentFrom, parentTo: m.parentTo, childFrom: m.childFrom }, params: { ...m.waterfall } };
}

export function loadMacroDaily(historyDir: string): MacroDaily {
  const safe = (f: () => Candle[]) => { try { return f(); } catch { return []; } };
  return {
    btcd: safe(() => loadIndexSeries(historyDir, 'BTC.D', '1d').candles),
    usdtd: safe(() => loadIndexSeries(historyDir, 'USDT.D', '1d').candles),
    shib: safe(() => loadSpotSeries(historyDir, 'SHIB', '1d').candles),
  };
}

export class MacroSeries {
  readonly fractal: FractalCache;
  private readonly readings = new Map<number, WaterfallReading>();
  constructor(readonly daily: MacroDaily, readonly params: WaterfallParams = DEFAULT_WATERFALL, cfg: FractalConfig = DEFAULT_FRACTAL) {
    this.fractal = new FractalCache(daily.btcd, cfg);
  }

  /** The engine's state (as of the last complete week) and the waterfall legs (as of the day's start). */
  at(t: number): MacroInputs {
    const fractal = this.fractal.at(t);
    const day = Math.floor(t / DAY) * DAY;
    let wf = this.readings.get(day);
    if (!wf) {
      wf = waterfallReading({ ...this.daily, fractal: this.fractal.at(day), at: day }, this.params);
      this.readings.set(day, wf);
    }
    return { fractal, wf, gate: this.params.gate };
  }

  /** Whether the parent window has BTC.D history (the engine can run at all). */
  hasParent(): boolean {
    const c = this.fractal.cfg;
    return this.daily.btcd.filter((x) => x.ts >= c.parentFrom && x.ts < c.parentTo).length > 0.9 * ((c.parentTo - c.parentFrom) / DAY);
  }
}
