// Worker thread: one SNN replay (research/snnReplay.ts) for a tournament member, so the members of a
// population run on separate cores (research/snnPbt.ts with TRAIN_WORKERS > 1). Bundled to
// dist/snnReplayWorker.cjs for the bundled pipeline.

import path from 'path';
import { parentPort } from 'worker_threads';
import { loadCalendar } from '../bot/model/calendar';
import { MetaModel } from '../bot/model/metaModel';
import type { SnnCheckpoint, SnnModelFile } from '../bot/snn/network';
import type { SnnParams } from '../bot/snn/params';
import type { TennisConfig } from '../bot/config';
import { replaySnn, type SnnRow } from './snnReplay';

export interface SnnReplayJob {
  dir: string; params: SnnParams; domain: 'crypto' | 'perps' | 'tennis'; modelPath?: string; checkpoint?: SnnCheckpoint;
  from: number; to: number; fromDay: string; toDay: string; skipModel?: boolean; tennis?: TennisConfig;
  /** A trained network's model file to start from (a champion contest). */
  snnModel?: SnnModelFile;
}
export interface SnnReplayOut { rows: SnnRow[]; checkpoint: SnnCheckpoint }

const calendar = loadCalendar(path.resolve('params/calendar.json'));
const models = new Map<string, MetaModel>();

parentPort?.on('message', async (j: SnnReplayJob) => {
  try {
    let model: MetaModel | undefined;
    if (j.modelPath) { model = models.get(j.modelPath) ?? MetaModel.load(j.modelPath); models.set(j.modelPath, model); }
    const r = await replaySnn(j.dir, { params: j.params, domain: j.domain, model, calendar, checkpoint: j.checkpoint, snnModel: j.snnModel, allowParamChange: true, from: j.from, to: j.to, fromDay: j.fromDay, toDay: j.toDay, skipModel: j.skipModel, tennis: j.tennis });
    const out: SnnReplayOut = { rows: r.rows, checkpoint: r.net.serialize() };
    parentPort!.postMessage({ ok: true, out });
  } catch (e) {
    parentPort!.postMessage({ ok: false, error: (e as Error).stack ?? String(e) });
  }
});
