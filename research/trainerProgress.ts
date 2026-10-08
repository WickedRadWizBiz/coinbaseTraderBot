// What the trainer window shows while a round runs (research/trainerUi.ts): the pipeline's output turned into two
// progress bars (downloads, training) with time estimates, the step in progress with its own bar, and a short
// explanation of what that step is doing.
//
// Estimates: each step is expected to take what it took in the last rounds (median over the pipeline reports in
// models/reports), the steps expected this round being those of the last round of the same kind (a full round
// downloads and runs every step; a continuing round runs the tournaments and the models that read them). When a
// step reports its own progress ([progress] lines: contracts downloaded, tournament rounds, generations), the
// rate so far gives that step's remaining time instead.

import fs from 'fs';
import path from 'path';

export const DOWNLOAD_STEPS = new Set(['history-seed', 'history', 'history_replay']);

/** One line on what each step does (the trainer's own phases too). */
export function explain(step: string): string {
  const domain = /^snn-([a-z]+)/.exec(step)?.[1];
  const net = domain ? `${domain} spiking network` : '';
  if (step === 'pull') return 'Copying your bot\'s newest recordings, history and models from the server, only the files that changed.';
  if (step === 'push') return 'Sending the models that got better to your server; the bot loads them within a minute, no restart.';
  if (step === 'starting') return 'Getting ready: reading your settings and the last rounds\' timings.';
  if (step === 'history-seed') return 'Importing the seed price history that ships with the trainer (only once per version).';
  if (step === 'history') return 'Downloading what is missing: Binance price archives, Coinbase candles, the TradingView index series and Kalshi\'s settled contracts. Data already on disk is never downloaded again.';
  if (step === 'history_replay') return 'Building the history replay: years of 1-minute prices turned into day-by-day market recordings the networks can trade through.';
  if (step === 'ta_net') return 'TA network tournament: several networks learn from years of hourly candles; the best one\'s settings survive and the winners breed.';
  if (step === 'ta_net_oos') return 'Walking the TA network forward month by month, so the setup scorer trains on honest forecasts it never saw the answers to.';
  if (step === 'rule_book') return 'Testing every TA rule on years of history by market character; only rules that held up on later, unseen years are kept.';
  if (step === 'gp') return 'Evolving trading formulas: thousands of random formulas compete, the best breed for generations, and the champion is tested on the newest years it never saw.';
  if (step === 'setups') return 'Retraining the setup scorer that decides which perps setups are worth taking.';
  if (step === 'setup_snn') return 'Checking whether the perps trades the spiking network agreed with did better.';
  if (step.startsWith('sweep')) return 'Replaying recent days with each bot setting nudged one at a time, to propose better settings (nothing changes by itself).';
  if (/-ablation$/.test(step)) return `Testing which stages of the ${net} really help, one stage at a time.`;
  if (/-pbt$/.test(step)) return `The ${net} tournament: several networks trade weeks of history none of them trained on; the best survive and breed.`;
  if (/-train$/.test(step)) return `Training the ${net} with the tournament winner's settings.`;
  if (/-backfill$/.test(step)) return `Filling in the ${net}'s past outputs for the models that read them.`;
  if (step === 'snn-tennis') return 'The tennis network learns live; nothing to replay.';
  if (step === 'vol_model') return 'Training the volatility forecast (how much prices will move over a contract\'s life).';
  if (step === 'dataset') return 'Turning the recordings into training examples for the Kalshi decision model.';
  if (step === 'mlp') return 'Training the Kalshi decision model and backtesting it after fees.';
  if (step === 'vol') return 'Fitting how volatility changes through the day.';
  if (step === 'perps') return 'Training the perps model and running its execution backtest.';
  if (step === 'tennis') return 'Training the tennis model on Kalshi\'s match history.';
  if (step === 'fill') return 'Learning from the bot\'s own orders which quotes get filled.';
  if (step === 'sizing') return 'Tuning bet sizes on settled trades.';
  if (step === 'readiness') return 'Scoring the whole bot on days nothing was trained on, against your target.';
  return 'Working on the next part of the pipeline.';
}

export interface StepTiming { step: string; ms: number; skipped?: boolean }

/** Past rounds from the pipeline reports (oldest first): each a list of steps with their durations. */
export function readRounds(models: string, max = 12): StepTiming[][] {
  try {
    const dir = path.join(models, 'reports');
    return fs.readdirSync(dir).filter((f) => /^pipeline-.*\.json$/.test(f)).sort().slice(-max).map((f) => {
      try { return ((JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).steps ?? []) as Array<{ step: string; ms?: number; skipped?: string }>).map((s) => ({ step: s.step, ms: s.ms ?? 0, skipped: !!s.skipped })); } catch { return []; }
    }).filter((r) => r.length);
  } catch { return []; }
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/** Expected milliseconds per step (median of the runs that did work) and the step list of the last round of
 *  the same kind (full: it downloaded; continuing: it did not). */
export function planFrom(rounds: StepTiming[][], full: boolean): { plan: string[]; expect: Map<string, number> } {
  const by = new Map<string, number[]>();
  for (const r of rounds) for (const s of r) if (!s.skipped && s.ms > 0) { const l = by.get(s.step); if (l) l.push(s.ms); else by.set(s.step, [s.ms]); }
  const expect = new Map([...by].map(([k, v]) => [k, median(v)]));
  const same = [...rounds].reverse().find((r) => r.some((s) => s.step === 'history') === full);
  const plan = same ? same.filter((s) => !s.skipped).map((s) => s.step) : full ? ['history', 'history_replay', 'ta_net', 'ta_net_oos', 'rule_book', 'gp', 'setups', 'snn-crypto-pbt', 'snn-crypto-train', 'snn-perps-pbt', 'snn-perps-train', 'vol_model', 'dataset', 'mlp', 'perps', 'readiness']
    : ['ta_net', 'rule_book', 'gp', 'snn-crypto-pbt', 'snn-perps-pbt', 'mlp', 'perps', 'readiness'];
  return { plan, expect };
}

/** Rough first-time guesses (minutes) for steps with no past round. */
const GUESS_MIN: Record<string, number> = { history: 60, history_replay: 20, ta_net: 45, gp: 12, ta_net_oos: 20 };

export interface Bar { pct: number; etaSec: number | null; label: string }
export interface ProgressView {
  phase: string; step: string | null; explanation: string;
  downloads: Bar; training: Bar; current: Bar & { task: string | null };
  done: string[]; log: string[];
}

export class RoundProgress {
  private readonly plan: string[];
  private readonly expect: Map<string, number>;
  private readonly finished = new Map<string, number>();
  private current: { step: string; start: number } | null = null;
  private task: { name: string; done: number; total: number; start: number; startDone: number } | null = null;
  private readonly log: string[] = [];
  phase = 'starting';

  constructor(rounds: StepTiming[][], readonly full: boolean, private readonly now: () => number = Date.now) {
    const p = planFrom(rounds, full);
    this.plan = p.plan; this.expect = p.expect;
  }

  private est(step: string): number { return this.expect.get(step) ?? (GUESS_MIN[step] ?? (step.startsWith('snn') ? 15 : 3)) * 60_000; }

  /** One line of the pipeline's output. */
  line(raw: string): void {
    const l = raw.replace(/\r/g, '').trimEnd();
    if (!l) return;
    const pg = /^\[progress\] (\{.*\})$/.exec(l);
    if (pg) {
      try {
        const j = JSON.parse(pg[1]) as { task: string; done: number; total: number };
        const t = this.now();
        if (!this.task || this.task.name !== j.task || j.done < this.task.done) this.task = { name: j.task, done: j.done, total: j.total, start: t, startDone: j.done };
        else { this.task.done = j.done; this.task.total = j.total; }
      } catch { /* not ours */ }
      return;
    }
    this.log.push(l.length > 220 ? `${l.slice(0, 217)}...` : l);
    if (this.log.length > 14) this.log.shift();
    const m = /^\[pipeline\] ([a-z0-9_\-]+): (running\.\.\.|done in|skipped|FAILED)/.exec(l);
    if (!m) return;
    if (m[2] === 'running...') { this.current = { step: m[1], start: this.now() }; this.task = null; this.phase = 'pipeline'; if (!this.plan.includes(m[1])) this.plan.push(m[1]); return; }
    this.finished.set(m[1], this.current?.step === m[1] ? this.now() - this.current.start : 0);
    if (this.current?.step === m[1]) { this.current = null; this.task = null; }
  }

  /** A phase of the trainer itself (pull, push, starting, waiting). */
  setPhase(phase: string): void { this.phase = phase; if (phase !== 'pipeline') { this.current = null; this.task = null; } }

  private remainingOf(step: string): number {
    if (this.finished.has(step)) return 0;
    if (this.current?.step !== step) return this.est(step);
    const elapsed = this.now() - this.current.start;
    const t = this.task;
    if (t && t.done > t.startDone && t.total > 0) {
      const rate = (t.done - t.startDone) / Math.max(1, this.now() - t.start);
      return (t.total - t.done) / rate;
    }
    const e = this.est(step);
    return elapsed < e ? e - elapsed : 0.1 * elapsed;
  }

  /** How far a step is (0..1): finished 1; in progress by its own progress lines, else by time against its
   *  usual duration (never past 95 % until it finishes); planned 0. */
  private fraction(step: string): number {
    if (this.finished.has(step)) return 1;
    if (this.current?.step !== step) return 0;
    const t = this.task;
    if (t && t.total > 0) return Math.min(0.99, t.done / t.total);
    return Math.min(0.95, (this.now() - this.current.start) / this.est(step));
  }

  /** A bar over these steps: each counts by its usual duration; the time left adds up what each still needs. */
  private bar(steps: string[], label: string): Bar {
    if (!steps.length) return { pct: 100, etaSec: 0, label: `${label}: nothing to do this round` };
    let w = 0, got = 0, leftMs = 0;
    for (const s of steps) {
      const e = this.finished.has(s) ? Math.max(this.finished.get(s)!, 1) : this.est(s);
      w += e; got += e * this.fraction(s);
      if (!this.finished.has(s)) leftMs += this.remainingOf(s);
    }
    const allDone = steps.every((s) => this.finished.has(s));
    return { pct: allDone ? 100 : Math.min(99, (100 * got) / w), etaSec: allDone ? 0 : Math.round(leftMs / 1000), label };
  }

  view(): ProgressView {
    const dl = this.plan.filter((s) => DOWNLOAD_STEPS.has(s)), tr = this.plan.filter((s) => !DOWNLOAD_STEPS.has(s));
    const step = this.current?.step ?? null;
    const t = this.task;
    const cur: Bar & { task: string | null } = step
      ? { task: t ? `${t.name}: ${t.done.toLocaleString('en-US')} of ${t.total.toLocaleString('en-US')}` : null, label: step, pct: 100 * this.fraction(step), etaSec: Math.round(this.remainingOf(step) / 1000) }
      : { task: null, label: this.phase, pct: 0, etaSec: null };
    return {
      phase: this.phase, step, explanation: explain(step ?? this.phase),
      downloads: this.bar(dl, 'Downloads'), training: this.bar(tr, 'Training'), current: cur,
      done: [...this.finished.keys()], log: [...this.log],
    };
  }
}

/** "1 h 20 min", "45 min", "under a minute". */
export function formatEta(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return 'estimating...';
  if (sec <= 0) return 'done';
  if (sec < 60) return 'under a minute';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
}
