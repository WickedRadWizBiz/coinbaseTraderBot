// Worker thread: one Kalshi sweep evaluation (research/sweep.ts kalshiScore: the production backtester over a
// window's days with one set of strategy settings), so the values of a setting are evaluated on separate cores.
// Bundled to dist/sweepWorker.cjs for the bundled pipeline.

import { parentPort } from 'worker_threads';
import { kalshiScore } from './sweep';

parentPort?.on('message', async (j: { dir: string; modelPath: string; strategy: Record<string, unknown> }) => {
  try {
    parentPort!.postMessage({ ok: true, out: await kalshiScore(j.dir, j.modelPath, j.strategy) });
  } catch (e) {
    parentPort!.postMessage({ ok: false, error: (e as Error).stack ?? String(e) });
  }
});
