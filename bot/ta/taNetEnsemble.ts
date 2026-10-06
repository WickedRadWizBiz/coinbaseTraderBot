// Performance-weighted ensemble of TA network versions: the live (champion) network plus the most recent
// archived ones (research/champion.ts archives every network a retrain replaced). Each version keeps its
// own rolling skill on its graded live calls (TaNetRuntime), and its weight follows that record:
//
//   weight = prior x exp(kappa x skill)      prior 1 for the champion, 0.5 for an archived version;
//                                            skill = mean rolling skill of its direction heads
//                                            (1 - Brier / 0.25; 0 until 24 calls are graded)
//
// so a version that keeps performing gains weight and one that stops loses it (a skill of +0.02 is
// worth 2.2x a coin flip's weight at kappa 40), without anything being thrown away. The blended
// direction probability and skill feed the conviction overlay (bot/strategy/taConviction.ts); the
// volatility forecast blends the versions whose vol head is validated.

import fs from 'fs';
import path from 'path';
import type { CandleSet } from './candleStore';
import { TaNet, TaNetRuntime, TANET_SCHEMA, activeTaNet, type TaNetOutput } from './taNet';
import { viewOf, type TaNetView } from '../strategy/taConviction';

const KAPPA = 40;

interface Member { file: string; version: string; rt: TaNetRuntime; prior: number }

export interface EnsembleWeights { version: string; weight: number; skill: number | null; champion: boolean }

export interface VersionReading { version: string; prior: number; champion: boolean; v: TaNetView | undefined; vol4h?: number }

/** Mean rolling skill of a version's graded direction heads (0 until 24 calls are graded). */
const skillOf = (v: TaNetView) => {
  const s = [[v.skill1, v.graded1], [v.skill4, v.graded4]].filter(([x, g]) => x !== undefined && Number.isFinite(x) && (g ?? 0) >= 24).map(([x]) => x as number);
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
};

/** Blend versions by prior x exp(kappa x skill) (see header). */
export function blendVersions(list: VersionReading[]): { view: TaNetView; weights: EnsembleWeights[] } | undefined {
  const views = list.filter((a) => a.v);
  if (!views.length) return undefined;
  const ws = views.map((a) => a.prior * Math.exp(KAPPA * Math.max(-0.05, Math.min(0.05, skillOf(a.v!)))));
  const W = ws.reduce((a, b) => a + b, 0);
  const weights = views.map((a, i) => ({ version: a.version, weight: +(ws[i] / W).toFixed(3), skill: +skillOf(a.v!).toFixed(4), champion: a.champion }));
  const blend = (pick: (a: VersionReading) => number | undefined) => {
    let n = 0, d = 0;
    views.forEach((a, i) => { const x = pick(a); if (x !== undefined && Number.isFinite(x)) { n += ws[i] * x; d += ws[i]; } });
    return d > 0 ? n / d : undefined;
  };
  const share = (pred: (v: TaNetView) => boolean | undefined) => views.reduce((a, x, i) => a + (pred(x.v!) ? ws[i] : 0), 0) / W;
  return {
    weights,
    view: {
      up1: blend((a) => a.v!.up1), up4: blend((a) => a.v!.up4),
      skill1: blend((a) => ((a.v!.graded1 ?? 0) >= 24 ? a.v!.skill1 : undefined)), skill4: blend((a) => ((a.v!.graded4 ?? 0) >= 24 ? a.v!.skill4 : undefined)),
      graded1: Math.max(...views.map((a) => a.v!.graded1 ?? 0)), graded4: Math.max(...views.map((a) => a.v!.graded4 ?? 0)),
      // A head counts as validated when versions holding at least half the weight validated it.
      validated1: share((v) => v.validated1) >= 0.5, validated4: share((v) => v.validated4) >= 0.5,
      vol4h: blend((a) => a.vol4h),
    },
  };
}

export class TaNetEnsemble {
  private members: Member[] = [];
  private scannedAt = 0;
  private lastWeights: EnsembleWeights[] = [];

  constructor(private readonly archiveDir: string, private readonly size = 3, private readonly champion: () => TaNetRuntime | undefined = activeTaNet) {}

  /** Archived versions (newest first, current schema, not the champion), reloaded every 10 minutes. */
  private archived(now: number): Member[] {
    if (this.size <= 1) return [];
    if (now - this.scannedAt < 600_000 && now >= this.scannedAt) return this.members;
    this.scannedAt = now;
    const champ = this.champion()?.net.version;
    let files: string[] = [];
    try { files = fs.readdirSync(this.archiveDir).filter((f) => f.endsWith('.json')).sort().reverse(); } catch { files = []; }
    const keep: Member[] = [];
    for (const f of files) {
      if (keep.length >= this.size - 1) break;
      const file = path.join(this.archiveDir, f);
      const have = this.members.find((m) => m.file === file);
      if (have) { if (have.version !== champ) keep.push(have); continue; }
      try {
        const p = JSON.parse(fs.readFileSync(file, 'utf8')) as { schema?: string; version?: string };
        if (p.schema !== TANET_SCHEMA || !p.version || p.version === champ || keep.some((m) => m.version === p.version)) continue;
        const net = TaNet.load(file);
        if (net) keep.push({ file, version: net.version, rt: new TaNetRuntime(net, true), prior: 0.5 });
      } catch { /* unreadable: skipped */ }
    }
    this.members = keep;
    return keep;
  }

  /** Blended direction readings (and the validated vol forecast) for an asset. */
  view(asset: string, set: CandleSet | undefined, now: number): TaNetView | undefined {
    const champ = this.champion();
    const all: Array<{ version: string; prior: number; champion: boolean; out?: TaNetOutput }> = [];
    const at = (rt: TaNetRuntime) => { try { return rt.outputFor(asset, set, now); } catch { return undefined; } };
    if (champ) all.push({ version: champ.net.version, prior: 1, champion: true, out: at(champ) });
    for (const m of this.archived(now)) all.push({ version: m.version, prior: m.prior, champion: false, out: at(m.rt) });
    const r = blendVersions(all.map((a) => ({ version: a.version, prior: a.prior, champion: a.champion, v: viewOf(a.out), vol4h: a.out?.vol4h })));
    if (r) this.lastWeights = r.weights;
    return r?.view;
  }

  status(): { size: number; members: EnsembleWeights[] } { return { size: this.size, members: this.lastWeights }; }
}

let ensemble: TaNetEnsemble | undefined;
export function setTaNetEnsemble(e: TaNetEnsemble | undefined): void { ensemble = e; }
export function activeTaNetEnsemble(): TaNetEnsemble | undefined { return ensemble; }

/** The TA network's readings for an asset: the ensemble when one is installed, else the live network. */
export function taNetView(asset: string, set: CandleSet | undefined, now: number): TaNetView | undefined {
  if (ensemble) return ensemble.view(asset, set, now);
  let o: TaNetOutput | undefined;
  try { o = activeTaNet()?.outputFor(asset, set, now); } catch { return undefined; }
  const v = viewOf(o);
  return v ? { ...v, vol4h: o?.vol4h } : undefined;
}
