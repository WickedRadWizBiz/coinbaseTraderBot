// Worker thread: one random-sweep trial (research/randomSweep.ts evalTrial: the production backtester over every
// recorded day with one set of bot.env lines), so trials run on separate cores.

import { parentPort } from 'worker_threads';
import { evalTrial } from './randomSweep';

parentPort?.on('message', async (j: { dir: string; modelPath: string; env: Record<string, string>; stage: number }) => {
  try {
    parentPort!.postMessage({ ok: true, out: await evalTrial(j.dir, j.modelPath, j.env, j.stage) });
  } catch (e) {
    parentPort!.postMessage({ ok: false, error: (e as Error).stack ?? String(e) });
  }
});
