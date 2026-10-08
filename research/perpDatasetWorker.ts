// Worker thread: the perps model's dataset rows for one run of recorded days (research/trainPerpModel.ts
// buildPerpDataset with --workers > 1), so years of history replay are computed on every core. Bundled to
// dist/perpDatasetWorker.cjs for the bundled pipeline.

import { parentPort } from 'worker_threads';
import { perpRowsForDays } from './trainPerpModel';

export interface PerpDatasetJob { dir: string; days: string[]; warm?: string; tail?: string; everySec?: number; horizonMin?: number }

parentPort?.on('message', async (j: PerpDatasetJob) => {
  try {
    parentPort!.postMessage({ ok: true, out: await perpRowsForDays(j.dir, j.days, j.warm, j.tail, j) });
  } catch (e) {
    parentPort!.postMessage({ ok: false, error: (e as Error).stack ?? String(e) });
  }
});
