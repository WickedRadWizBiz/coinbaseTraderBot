// Worker thread: scores a chunk of evolved formulas on a coin's training years (research/gpIndicators.ts with
// TRAIN_WORKERS > 1), so a population of thousands is backtested on every core. Each worker loads the hourly
// history once per coin and keeps it. Bundled to dist/gpWorker.cjs for the bundled pipeline.

import { parentPort } from 'worker_threads';
import { loadGpData, trainScore, withDefaults, type GpData, type GpJob } from './gpIndicators';

const data = new Map<string, GpData>();

parentPort?.on('message', (j: GpJob) => {
  try {
    const key = `${j.dir}|${j.target}|${j.inputs.join(',')}|${j.split.join(',')}`;
    let d = data.get(key);
    if (!d) { d = loadGpData(j.dir, j.target, j.inputs, j.split); data.clear(); data.set(key, d); }
    const o = withDefaults(j.opts);
    parentPort!.postMessage({ ok: true, out: j.formulas.map((f) => trainScore(f, d!, o)) });
  } catch (e) {
    parentPort!.postMessage({ ok: false, error: (e as Error).stack ?? String(e) });
  }
});
