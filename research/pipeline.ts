// Automated training pipeline: every research step in the right order, with the right inputs,
// promoting the results to AUTO_TRAIN_DIR (data/models), where the running bot picks them up
// without a restart (bot/autotrain.ts).
//
//   1. dataset      research:dataset over the recordings
//   2. mlp          research:train (MLP-only) -> backtest --annotate -> promote model.json
//   3. vol          research:sessions volatility profile -> promote vol_profile.json
//   4. perps        research:perp-train -> perp-backtest --annotate -> promote perp_model.json
//   5. snn          ONLY AFTER the MLP: research:snn-ablation against the promoted MLP (when the
//                   MLP changed, or every AUTO_TRAIN_ABLATION_EVERY_DAYS) -> pick the stage ->
//                   research:snn-train against the same MLP -> promote snn_model.json
//
// A new MLP always triggers a fresh SNN ablation + training, because the SNN is judged against
// the specific p_model it will be blended with. The bot also re-runs the snn steps on its own when
// model.json changes outside the pipeline (AUTO_TRAIN_ON_MODEL_CHANGE).
//
//   npm run pipeline                       # everything
//   npm run pipeline -- --only snn         # just the SNN steps (also: dataset,mlp,vol,perps)
//   npm run pipeline -- --force-ablation   # re-run the SNN ablation even if not due

import fs from 'fs';
import path from 'path';
import { MODEL_FILES } from '../bot/autotrain';
import { loadConfig, type Config } from '../bot/config';
import { MetaModel } from '../bot/model/metaModel';
import { PerpModel } from '../bot/perps/perpSignal';
import { STAGES, type Stage } from '../bot/snn/params';
import { backtestMain } from './backtest';
import { buildDatasetMain } from './buildDataset';
import { perpBacktestMain } from './perpBacktest';
import { sessionsMain } from './sessions';
import { snnAblationMain, type Verdict } from './snnAblation';
import { trainMetaModelMain } from './trainMetaModel';
import { trainPerpMain } from './trainPerpModel';
import { trainSnnMain } from './trainSnn';

export const STEPS = ['dataset', 'mlp', 'vol', 'perps', 'snn'] as const;
export type Step = typeof STEPS[number];

export interface PipelineState {
  lastRun?: number;
  lastAblation?: number;
  /** Meta-model id currently promoted, and the one the promoted SNN was ablated/trained against. */
  mlpId?: string;
  snnEvaluatedAgainst?: string;
  snnStage?: Stage;
  snnVersion?: string;
  lastReport?: string;
}

/** Thrown by a step that has nothing to do yet (e.g. no perp quotes recorded): reported as skipped. */
export class SkipStep extends Error {}

export interface StepResult { step: string; ok: boolean; skipped?: string; ms: number; detail?: unknown; error?: string }


export function readState(dir: string): PipelineState {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'pipeline_state.json'), 'utf8')); } catch { return {}; }
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Recording days present (md-YYYY-MM-DD.jsonl), sorted. */
export function recordingDays(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((f) => /^md-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)?.[1]).filter((d): d is string => Boolean(d)).sort();
}

const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const argsOf = (o: Record<string, string | number | undefined>) => (k: string, d: string) => (o[k] === undefined || o[k] === '' ? d : String(o[k]));

/** Highest stage k such that S1..Sk were all accepted; 0 if S1 failed. */
export function acceptedChain(verdicts: Verdict[]): number {
  let k = 0;
  for (let s = 1; s <= 6; s++) {
    const v = verdicts.find((x) => x.mechanism.startsWith(`S${s} `));
    if (!v?.accepted) break;
    k = s;
  }
  return k;
}

export interface PipelineOpts { cfg?: Readonly<Config>; only?: Step[]; forceAblation?: boolean; now?: number; log?: (m: string) => void;
  /** Restrict the SNN ablation to mechanisms whose name starts with this (testing). */
  ablationOnly?: string }

export async function runPipeline(o: PipelineOpts = {}): Promise<{ steps: StepResult[]; state: PipelineState; report: string }> {
  const cfg = o.cfg ?? loadConfig({ ...process.env, DASHBOARD_TOKEN: process.env.DASHBOARD_TOKEN ?? 'x'.repeat(32), TRADING_MODE: 'paper' });
  const A = cfg.autoTrain;
  const log = o.log ?? ((m: string) => console.log(`[pipeline] ${m}`));
  const now = o.now ?? Date.now();
  const work = path.join(A.dir, 'work');
  fs.mkdirSync(work, { recursive: true });
  const state = readState(A.dir);
  const steps: StepResult[] = [];
  const want = (s: Step) => !o.only?.length || o.only.includes(s);
  const rec = A.recordingsDir;
  const days = recordingDays(rec);
  const promoted = (name: keyof typeof MODEL_FILES) => path.join(A.dir, MODEL_FILES[name]);
  const run = async (step: string, fn: () => Promise<unknown>, skip?: string) => {
    const t0 = Date.now();
    if (skip) { steps.push({ step, ok: true, skipped: skip, ms: 0 }); log(`${step}: skipped (${skip})`); return undefined; }
    log(`${step}: running...`);
    try {
      const detail = await fn();
      steps.push({ step, ok: true, ms: Date.now() - t0, detail });
      log(`${step}: done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      return detail;
    } catch (e) {
      if (e instanceof SkipStep) { steps.push({ step, ok: true, skipped: e.message, ms: Date.now() - t0 }); log(`${step}: skipped (${e.message})`); return undefined; }
      steps.push({ step, ok: false, ms: Date.now() - t0, error: (e as Error).stack ?? String(e) });
      log(`${step}: FAILED: ${(e as Error).message}`);
      return undefined;
    }
  };
  const tooFew = days.length < A.minDays ? `only ${days.length} day(s) of recordings in ${rec} (< AUTO_TRAIN_MIN_DAYS=${A.minDays})` : undefined;
  const dataset = path.join(work, 'dataset.jsonl');

  // 1. dataset
  if (want('dataset') || want('mlp')) await run('dataset', () => buildDatasetMain(argsOf({ recordings: rec, out: dataset, every: 60 })), tooFew);

  // 2. MLP: train -> backtest annotate -> promote
  let mlpChanged = false;
  if (want('mlp')) {
    const cand = path.join(work, 'model.candidate.json');
    await run('mlp', async () => {
      if (!fs.existsSync(dataset) || fs.statSync(dataset).size === 0) throw new SkipStep('empty dataset: no priced contracts with outcomes in the recordings yet');
      try { await trainMetaModelMain(argsOf({ data: dataset, out: cand })); } catch (e) {
        if (/need at least \d+ windows/.test((e as Error).message)) throw new SkipStep(`not enough settlement windows yet: ${(e as Error).message}`);
        throw e;
      }
      const prod = cfg.strategy.exitPolicy;
      await backtestMain(argsOf({ recordings: rec, model: cand, exits: prod }), true);
      const m = MetaModel.load(cand);
      const passed = Boolean(m.params.validation?.passed);
      if (A.promote === 'validated' && !passed) return { promoted: false, id: m.id, reason: `validation not passed (${m.liveBlockers().join('; ')})` };
      fs.copyFileSync(cand, promoted('mlp'));
      mlpChanged = state.mlpId !== m.id;
      state.mlpId = m.id;
      return { promoted: true, id: m.id, kind: m.params.kind, validationPassed: passed, liveBlockers: m.liveBlockers() };
    }, tooFew);
  }

  // 3. intraday volatility profile (applied by the bot only when its own validation improved)
  if (want('vol')) {
    await run('vol', async () => {
      const out = path.join(work, 'vol_profile.json');
      await sessionsMain(argsOf({ recordings: rec, out, 'no-backtest': 1 }));
      fs.copyFileSync(out, promoted('vol'));
      return { promoted: true, improved: JSON.parse(fs.readFileSync(out, 'utf8')).validation?.improved ?? false };
    }, tooFew);
  }

  // 4. perps: train -> execution backtest annotate -> promote
  if (want('perps')) {
    await run('perps', async () => {
      const cand = path.join(work, 'perp_model.candidate.json');
      try { await trainPerpMain(argsOf({ recordings: rec, out: cand })); } catch (e) {
        if (/record more perp data|no perp/i.test((e as Error).message)) throw new SkipStep('no perp quotes recorded yet (PERPS_FEED=true records them)');
        throw e;
      }
      if (!fs.existsSync(cand)) throw new Error('perp trainer wrote no model (no perp quotes in the recordings?)');
      await perpBacktestMain(argsOf({ recordings: rec, model: cand }), true);
      const m = PerpModel.load(cand);
      const ok = Boolean(m?.validated());
      if (A.promote === 'validated' && !ok) return { promoted: false, reason: m?.blockers().join('; ') };
      fs.copyFileSync(cand, promoted('perp'));
      return { promoted: true, validated: ok, blockers: m?.blockers() ?? [] };
    }, tooFew);
  }

  // 5. SNN: always after (and against) the promoted MLP
  if (want('snn')) {
    const mlpPath = fs.existsSync(promoted('mlp')) ? promoted('mlp') : cfg.paramsPath;
    const mlpId = fs.existsSync(mlpPath) ? MetaModel.load(mlpPath).id : MetaModel.identity().id;
    const against = state.snnEvaluatedAgainst !== mlpId;
    const due = o.forceAblation || against || mlpChanged || !state.lastAblation || (A.ablationEveryDays > 0 && now - state.lastAblation >= A.ablationEveryDays * 86_400_000);
    const lastDays = (n: number) => (days.length ? days.slice(-n) : []);
    const abDays = lastDays(A.ablationDays);
    let stage: Stage = A.snnStage === 'auto' ? (state.snnStage ?? cfg.snn.stage) : A.snnStage;
    let stageAccepted = false;
    const verdicts = await run('snn-ablation', async () => {
      const v = await snnAblationMain(argsOf({ recordings: rec, model: fs.existsSync(mlpPath) ? mlpPath : undefined, from: abDays[0], out: path.join(work, 'snn_ablation.json'), only: o.ablationOnly }));
      state.lastAblation = now;
      return v;
    }, tooFew ?? (due ? undefined : 'not due (same MLP, ablated recently)')) as Verdict[] | undefined;
    if (verdicts) {
      const k = acceptedChain(verdicts);
      if (A.snnStage === 'auto') stage = k > 0 ? STAGES[k] : cfg.snn.stage;
      stageAccepted = k > 0 && STAGES.indexOf(stage) <= k;
    } else stageAccepted = state.snnEvaluatedAgainst === mlpId;
    const trainNeeded = due || !fs.existsSync(promoted('snn'));
    await run('snn-train', async () => {
      const span = lastDays(A.snnTrainDays);
      const nEval = span.length >= 2 ? Math.max(1, Math.round(span.length * 0.2)) : 0;
      const trainSpan = span.slice(0, span.length - nEval), evalSpan = span.slice(span.length - nEval);
      const cand = path.join(work, 'snn_model.candidate.json');
      const r = await trainSnnMain(argsOf({
        recordings: rec, stage, out: cand, model: fs.existsSync(mlpPath) ? mlpPath : undefined,
        from: trainSpan[0], to: evalSpan[0] ?? undefined,
        'eval-from': evalSpan[0], 'eval-to': evalSpan.length ? new Date(dayMs(evalSpan[evalSpan.length - 1]) + 86_400_000).toISOString().slice(0, 10) : undefined,
      }));
      if (A.promote === 'validated' && !stageAccepted) return { promoted: false, stage, reason: 'stage not accepted by the ablation', result: r };
      fs.copyFileSync(cand, promoted('snn'));
      state.snnEvaluatedAgainst = mlpId;
      state.snnStage = stage;
      state.snnVersion = r?.version;
      return { promoted: true, stage, stageAccepted, against: mlpId, result: r };
    }, tooFew ?? (trainNeeded ? undefined : 'up to date with the promoted MLP'));
  }

  state.lastRun = now;
  const report = path.join(A.dir, 'reports', `pipeline-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`);
  writeAtomic(report, JSON.stringify({ at: new Date(now).toISOString(), recordings: rec, days: days.length, promote: A.promote, steps }, null, 1));
  state.lastReport = report;
  writeAtomic(path.join(A.dir, 'pipeline_state.json'), JSON.stringify(state, null, 1));
  log(`report: ${report}`);
  return { steps, state, report };
}

async function main() {
  const i = process.argv.indexOf('--only');
  const only = i >= 0 ? (process.argv[i + 1] ?? '').split(',').filter(Boolean) as Step[] : undefined;
  for (const s of only ?? []) if (!STEPS.includes(s)) throw new Error(`unknown step ${s} (steps: ${STEPS.join(', ')})`);
  const r = await runPipeline({ only, forceAblation: process.argv.includes('--force-ablation') });
  const failed = r.steps.filter((s) => !s.ok);
  console.log(`[pipeline] ${r.steps.length - failed.length}/${r.steps.length} steps ok${failed.length ? `; failed: ${failed.map((f) => f.step).join(', ')}` : ''}`);
  process.exitCode = failed.length ? 1 : 0;
}

if (process.argv[1] && /pipeline\.(ts|cjs|js)$/.test(process.argv[1])) void main();
