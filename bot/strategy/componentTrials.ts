// Component trials (the owner, Oct 24: "Have the rule book, SNN, and TA NET contribute, give each a shot and let's see
// how well they perform. If they perform well in the test allow them to function for paper trading to further test
// them").
//
// Each component's contribution to a crypto contract's price is worked out at every scheduled evaluation inside the
// contract's entry window, traded or not, in paper and in live, and scored when the contract settles: the log loss of
// the price with the contribution against the price without it (the meta-model's price, before any tilt). A contract's
// snapshots are averaged, and so are the contracts of one asset closing together (one outcome, a settlement). Over
// the most recent TRIAL_KEEP settlements a Diebold-Mariano statistic (bot/model/modelHealth.ts) tests the difference:
//   - testing: from the start, until the difference is significant either way;
//   - on: better at one-sided p <= TRIAL_P over at least TRIAL_MIN_WINDOWS settlements. Paper's prices then include the
//     contribution; live never does (live prices as it did before the trials);
//   - off: worse at one-sided p <= TRIAL_P over at least TRIAL_MIN_WINDOWS settlements (paper prices without it).
// The scores keep coming either way: a component that is on goes off once it is significantly worse, and one that is
// off comes back on once it is significantly better.
//
// The contributions (bot/engine.ts):
//   - snn: the crypto network's probability for the contract blended in at the blender's cap, (1 - a) p + a p_snn with
//     a = TRIAL_SNN_ALPHA (0.25) x its confidence c (bot/snn/blender.ts). The blender's own earned alpha stays 0 until
//     its bootstrap test passes on 200 settled events since the last meta-model swap;
//   - ta: the TA network's 1 h / 4 h direction drift with every head counting fully, validated or not (today's tilt
//     counts an unvalidated head by its graded skill, bot/strategy/taConviction.ts);
//   - rules: the rule book's trial rows, the rules that held up on both periods of the walk-forward study without
//     passing its multiple-testing bar (bot/strategy/ruleBook.ts trialRead), as a drift like the TA network's.

import { dmStat, logLoss } from '../model/modelHealth';
import { normCdf } from '../util/num';
import { readJson, writeJsonAtomic } from '../util/persist';

export type TrialName = 'snn' | 'ta' | 'rules';
export const TRIAL_NAMES: TrialName[] = ['snn', 'ta', 'rules'];
export type TrialState = 'testing' | 'on' | 'off';

export interface TrialParams {
  /** Record and score the trials (TRIALS). */
  enabled: boolean;
  /** Settlements needed before a trial may turn on or off. */
  minWindows: number;
  /** One-sided p-value that turns a trial on (better) or off (worse). */
  p: number;
  /** The most recent settlements kept and tested. */
  keep: number;
  /** The SNN's blend weight in its trial (times its confidence). */
  snnAlpha: number;
}

export const DEFAULT_TRIALS: TrialParams = { enabled: true, minWindows: 100, p: 0.05, keep: 500, snnAlpha: 0.25 };

interface Window { key: string; closeTs: number; d: number; n: number }
interface Book { windows: Window[]; state: TrialState; since: number; why?: string }
type State = Record<TrialName, Book>;

export interface TrialStatus {
  state: TrialState; since: number; why: string | null;
  /** Settlements scored, and the log loss the contribution saved a contract on average (+ = better with it). */
  windows: number; advantage: number | null;
  /** One-sided p-values: better with it, worse with it. */
  pBetter: number | null; pWorse: number | null;
  /** Contracts waiting for their result. */
  pending: number;
}

export class ComponentTrials {
  private st: State;
  /** ticker -> trial -> [p with, p without] snapshots, and the settlement they belong to. */
  private readonly snaps = new Map<string, { key: string; closeTs: number; by: Partial<Record<TrialName, Array<[number, number]>>> }>();

  constructor(readonly p: TrialParams = DEFAULT_TRIALS, private readonly file?: string, private readonly onChange?: (name: TrialName, to: TrialState, why: string) => void, now = Date.now()) {
    const saved = file ? readJson<Partial<State>>(file, { quarantine: true }) : undefined;
    this.st = Object.fromEntries(TRIAL_NAMES.map((n) => [n, saved?.[n] ?? { windows: [], state: 'testing', since: now }])) as State;
  }

  /** Paper's prices include this component's contribution. */
  on(name: TrialName): boolean { return this.p.enabled && this.st[name].state === 'on'; }

  /** One snapshot of a contract: its price with the component's contribution and without it. */
  record(name: TrialName, ticker: string, asset: string, closeTs: number, pWith: number, pWithout: number, now = Date.now()): void {
    if (!this.p.enabled || !Number.isFinite(pWith) || !Number.isFinite(pWithout)) return;
    let s = this.snaps.get(ticker);
    if (!s) {
      // Contracts whose result never came (six hours past their close) are dropped.
      if (this.snaps.size >= 500) for (const [t, x] of this.snaps) if (x.closeTs < now - 6 * 3_600_000) this.snaps.delete(t);
      s = { key: `${asset}:${closeTs}`, closeTs, by: {} };
      this.snaps.set(ticker, s);
    }
    (s.by[name] ??= []).push([pWith, pWithout]);
  }

  /** A contract settled: score its snapshots for every trial, then test each trial that took a new score. */
  onResult(ticker: string, result: 'yes' | 'no', now = Date.now()): void {
    const s = this.snaps.get(ticker);
    if (!s) return;
    this.snaps.delete(ticker);
    const y = result === 'yes' ? 1 : 0;
    let changed = false;
    for (const name of TRIAL_NAMES) {
      const list = s.by[name];
      if (!list?.length) continue;
      const d = list.reduce((a, [w, wo]) => a + logLoss(w, y) - logLoss(wo, y), 0) / list.length;
      const b = this.st[name];
      const w = b.windows.find((x) => x.key === s.key);
      if (w) { w.d = (w.d * w.n + d) / (w.n + 1); w.n++; } else b.windows.push({ key: s.key, closeTs: s.closeTs, d, n: 1 });
      b.windows.sort((a, c) => a.closeTs - c.closeTs || (a.key < c.key ? -1 : 1));
      if (b.windows.length > this.p.keep) b.windows = b.windows.slice(-this.p.keep);
      this.decide(name, now);
      changed = true;
    }
    if (changed && this.file) writeJsonAtomic(this.file, this.st);
  }

  private score(name: TrialName): { n: number; advantage: number | null; pBetter: number | null; pWorse: number | null } {
    const d = this.st[name].windows.map((w) => w.d);
    if (d.length < 10) return { n: d.length, advantage: null, pBetter: null, pWorse: null };
    const { mean, stat } = dmStat(d);
    // d = log loss with the contribution minus without it: below 0 is better with it.
    return { n: d.length, advantage: -mean, pBetter: normCdf(stat), pWorse: 1 - normCdf(stat) };
  }

  private decide(name: TrialName, now: number): void {
    const b = this.st[name];
    const s = this.score(name);
    if (s.n < this.p.minWindows || s.advantage === null) return;
    const ll = `${s.advantage >= 0 ? 'saves' : 'costs'} ${Math.abs(s.advantage).toFixed(4)} of log loss a contract`;
    let to: TrialState | undefined, why = '';
    if (b.state !== 'on' && s.pBetter! <= this.p.p) { to = 'on'; why = `better with it over ${s.n} settlements (${ll}, p ${s.pBetter!.toFixed(3)})`; }
    else if (b.state !== 'off' && s.pWorse! <= this.p.p) { to = 'off'; why = `worse with it over ${s.n} settlements (${ll}, p ${s.pWorse!.toFixed(3)})`; }
    if (!to) return;
    b.state = to; b.since = now; b.why = why;
    this.onChange?.(name, to, why);
  }

  status(): Record<TrialName, TrialStatus> {
    const pending = (name: TrialName) => [...this.snaps.values()].filter((s) => s.by[name]?.length).length;
    return Object.fromEntries(TRIAL_NAMES.map((name) => {
      const b = this.st[name], s = this.score(name);
      const r = (x: number | null, d: number) => (x === null ? null : +x.toFixed(d));
      return [name, { state: b.state, since: b.since, why: b.why ?? null, windows: s.n, advantage: r(s.advantage, 5), pBetter: r(s.pBetter, 4), pWorse: r(s.pWorse, 4), pending: pending(name) }];
    })) as Record<TrialName, TrialStatus>;
  }
}
