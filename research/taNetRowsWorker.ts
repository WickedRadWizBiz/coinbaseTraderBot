// Worker thread: computes one asset's TA network rows into its row cache (research/trainTaNet.ts
// computeRowsInWorkers), so a rebuild of years of hourly rows for many coins runs on every core. Each worker loads
// the basket (every coin's hourly bars) and the index series once and keeps them. Bundled to
// dist/taNetRowsWorker.cjs for the bundled pipeline.

import { parentPort } from 'worker_threads';
import { loadTaNetInputs, rowsJob, type TaNetInputs, type TaNetRowsJob } from './trainTaNet';

let held: { key: string; inp: TaNetInputs } | undefined;

parentPort?.on('message', (j: TaNetRowsJob) => {
  try {
    const key = `${j.histDir}|${j.assets.join(',')}`;
    if (held?.key !== key) held = { key, inp: loadTaNetInputs(j.histDir, j.assets, true) };
    parentPort!.postMessage({ ok: true, out: rowsJob(j, held.inp) });
  } catch (e) {
    parentPort!.postMessage({ ok: false, error: (e as Error).stack ?? String(e) });
  }
});
