// Strategy playbook: which of the bot's strategy families carries the risk in which market regime.
//
// The families are the bot's two independent ways of making money from one pot of capital:
//   kalshi   fair-value trading of Kalshi's crypto contracts (bot/strategy/fairValueStrategy.ts)
//   perps    the setup trader's fast and slow lanes on perpetuals (bot/setups)
// For each regime (bot/ta/regime.ts: character x Hilbert trend/cycle mode, per coin: a trade on a coin uses that
// coin's own confirmed regime, since an altcoin can trend on its own while BTC ranges) the
// playbook holds a weight per family, learned by research/playbook.ts from whole-bot replay days and switched on
// only when the switching bot beat the static bot on later days it was not learned on:
//
//   kalshi   0 .. 1     scales the Kalshi order size cap (the sizing tier stays the ceiling); 0 = no new entries
//   perps    0 .. 1.5   scales the setup lanes' risk per trade (the perps daily stop and margin caps still bind)
//
// Lookup: the exact regime ("trending:trend"), else its character ("trending"), else neutral (1, 1). Weights
// change new entries only; open positions keep their exits. <AUTO_TRAIN_DIR>/playbook.json is re-read when it
// changes; PLAYBOOK_APPLY=false ignores it.

import fs from 'fs';
import path from 'path';

export interface PlaybookWeights { kalshi: number; perps: number }
export interface PlaybookEntry extends PlaybookWeights { days: number; why?: string }
export interface PlaybookFile {
  schema: 'playbook1'; version: string; at: string;
  /** Switched on: the switching bot beat the static one on the later days (validation). */
  enabled: boolean;
  entries: Record<string, PlaybookEntry>;
  validation?: { days: number; staticUsd: number; switchedUsd: number; staticMaxDdUsd: number; switchedMaxDdUsd: number; why: string };
}

export const NEUTRAL: PlaybookWeights = { kalshi: 1, perps: 1 };
export const WEIGHT_RANGE = { kalshi: [0, 1], perps: [0, 1.5] } as const;
const clamp = (v: unknown, [lo, hi]: readonly [number, number]) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 1);

export const playbookPath = (dir: string) => path.join(dir, 'playbook.json');

export function readPlaybook(file: string): PlaybookFile | undefined {
  try {
    const f = JSON.parse(fs.readFileSync(file, 'utf8')) as PlaybookFile;
    return f?.schema === 'playbook1' && f.entries && typeof f.entries === 'object' ? f : undefined;
  } catch { return undefined; }
}

/** Weights for a regime: exact key, else its character, else neutral (and neutral when the playbook is off). */
export function weightsFor(pb: PlaybookFile | undefined, key: string | undefined): PlaybookWeights & { source: string } {
  if (!pb?.enabled || !key) return { ...NEUTRAL, source: pb ? (pb.enabled ? 'no regime yet' : 'playbook off (failed validation)') : 'no playbook' };
  for (const k of [key, key.split(':')[0]]) {
    const e = pb.entries[k];
    if (e) return { kalshi: clamp(e.kalshi, WEIGHT_RANGE.kalshi), perps: clamp(e.perps, WEIGHT_RANGE.perps), source: k };
  }
  return { ...NEUTRAL, source: `no entry for ${key}` };
}

/** Live holder: re-reads the file when its time changes (checked at most every 30 s). */
export class Playbook {
  private file?: PlaybookFile;
  private mtime = -1;
  private checked = 0;
  constructor(private readonly dir: string, private readonly apply = true) {}

  current(now = Date.now()): PlaybookFile | undefined {
    if (!this.apply) return undefined;
    if (now - this.checked >= 30_000) {
      this.checked = now;
      let m = -1;
      try { m = fs.statSync(playbookPath(this.dir)).mtimeMs; } catch { /* absent */ }
      if (m !== this.mtime) { this.mtime = m; this.file = m < 0 ? undefined : readPlaybook(playbookPath(this.dir)); }
    }
    return this.file;
  }

  weights(key: string | undefined, now = Date.now()) { return weightsFor(this.current(now), key); }

  status(key: string | undefined, now = Date.now()) {
    const f = this.current(now);
    return { apply: this.apply, version: f?.version ?? null, enabled: f?.enabled ?? false, regime: key ?? null, weights: this.weights(key, now), validation: f?.validation ?? null, entries: f?.entries ?? null };
  }
}

let live: Playbook | undefined;
export function setPlaybook(p: Playbook | undefined): void { live = p; }
export function playbook(): Playbook | undefined { return live; }
