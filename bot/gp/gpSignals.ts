// Live evolved formulas: the champion formula per coin found by genetic programming (research/gpIndicators.ts,
// <AUTO_TRAIN_DIR>/gp_indicators.json), run on the coins' latest closed hourly bars. Its exposure (-1 = fully
// short .. +1 = fully long, after the 10 % dead band) joins the TA conviction signals (bot/strategy/
// taConviction.ts) as one more reading of the coin's direction. Only a formula that passed its test on the
// most recent, never-seen years speaks (GP_REQUIRE_VALIDATED=false lets the others speak in paper mode).
//
// The file is re-read when it changes (checked at most every 30 s; the pipeline promotes a new champion without a
// restart); a reading is computed once per new hourly bar.

import fs from 'fs';
import { buildInputs, desiredExposure, evaluate, heldExposure, isValid, type Bar, type Token } from './expr';

/** What the live bot needs of research/gpIndicators.ts's file. */
export interface GpLiveChampion {
  tokens: Token[]; formula: string; inputs: string[]; lookback: number; validated: boolean; why?: string;
  test?: { from: string; to: string; totalReturn: number; sharpe: number; maxDd: number; trades: number };
}
export interface GpLiveFile { schema: string; version?: string; band: number; champions: Record<string, GpLiveChampion> }

export interface GpReading {
  asset: string;
  /** Exposure the formula holds now (dead band applied), and what it asks for at this bar. */
  exposure: number; desired: number;
  validated: boolean;
  /** Whether it counts among the conviction signals (validated, or allowed unvalidated). */
  speaks: boolean;
  formula: string; barTs: number;
}

export class GpSignals {
  private file?: { mtime: number; f?: GpLiveFile };
  private checkedAt = -Infinity;
  private readonly cache = new Map<string, { key: string; r: GpReading | undefined }>();

  constructor(private readonly path: () => string, private readonly allowUnvalidated: () => boolean = () => false, private readonly recheckMs = 30_000) {}

  private load(): GpLiveFile | undefined {
    const now = Date.now();
    if (this.file && now - this.checkedAt < this.recheckMs && now >= this.checkedAt) return this.file.f;
    this.checkedAt = now;
    let p: string;
    try { p = this.path(); } catch { return undefined; }
    let mtime = 0;
    try { mtime = fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0; } catch { mtime = 0; }
    if (!mtime) { this.file = undefined; return undefined; }
    if (this.file?.mtime !== mtime) {
      try {
        const f = JSON.parse(fs.readFileSync(p, 'utf8')) as GpLiveFile;
        this.file = { mtime, f: f?.champions ? f : undefined };
      } catch { this.file = { mtime }; }
      this.cache.clear();
    }
    return this.file.f;
  }

  /** The champions (for status). */
  champions(): Record<string, GpLiveChampion> { return this.load()?.champions ?? {}; }
  version(): string | undefined { return this.load()?.version; }

  /** The coin's formula on the latest closed hourly bars (`bars(asset)`); undefined without a champion or bars. */
  read(asset: string, bars: (asset: string) => Bar[] | undefined): GpReading | undefined {
    const f = this.load();
    const c = f?.champions[asset];
    if (!f || !c || !isValid(c.tokens)) return undefined;
    const series: Record<string, Bar[]> = {};
    for (const a of new Set([asset, ...c.inputs])) {
      const b = bars(a);
      if (!b || b.length < c.lookback + 2) return undefined;
      series[a] = b;
    }
    const last = series[asset][series[asset].length - 1].ts;
    const key = `${last}|${c.inputs.map((a) => series[a][series[a].length - 1].ts).join(',')}|${c.tokens.join(' ')}`;
    const hit = this.cache.get(asset);
    if (hit?.key === key) return hit.r;
    let r: GpReading | undefined;
    try {
      const desired = desiredExposure(evaluate(c.tokens, buildInputs(asset, series)));
      const held = heldExposure(desired, f.band ?? 0.1);
      const n = desired.length;
      r = { asset, exposure: held[n - 1], desired: desired[n - 1], validated: c.validated, speaks: c.validated || this.allowUnvalidated(), formula: c.formula, barTs: last };
    } catch { r = undefined; }
    this.cache.set(asset, { key, r });
    return r;
  }
}

let active: GpSignals | undefined;
export function setGpSignals(g: GpSignals | undefined): void { active = g; }
export function activeGpSignals(): GpSignals | undefined { return active; }
