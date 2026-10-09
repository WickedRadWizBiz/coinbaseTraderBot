// Worker thread: plays one conditioning instance over one window (research/conditioningRun.ts with
// TRAIN_WORKERS > 1), so the instances of a window replay on every core at once. Each worker loads the
// whole-bot data once and keeps each window's linked days. Bundled to dist/conditioningWorker.cjs.

import { parentPort } from 'worker_threads';
import { evaluateTask, type CondTask } from './conditioningRun';

parentPort?.on('message', (t: CondTask) => {
  evaluateTask(t)
    .then((out) => parentPort!.postMessage({ ok: true, out }))
    .catch((e) => parentPort!.postMessage({ ok: false, error: (e as Error).stack ?? String(e) }));
});
