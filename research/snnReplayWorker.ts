// Worker thread: one SNN replay (research/snnReplay.ts) for a tournament member, so the members of a
// population run on separate cores (research/snnPbt.ts with TRAIN_WORKERS > 1). Bundled to
// dist/snnReplayWorker.cjs for the bundled pipeline.
//
// It also plays a group of members on one tape with their columns on the GPU (research/snnGpu.ts; snnGpuSched.ts
// hands it the groups). The device pool process it starts for that stays up between groups.

import path from 'path';
import { parentPort } from 'worker_threads';
import { loadCalendar } from '../bot/model/calendar';
import { MetaModel } from '../bot/model/metaModel';
import type { SnnCheckpoint, SnnModelFile } from '../bot/snn/network';
import type { SnnParams } from '../bot/snn/params';
import type { TennisConfig } from '../bot/config';
import { replaySnn, type SnnRow } from './snnReplay';
import { GpuPool, playSnnTapeGpu } from './snnGpu';
import { playSnnTape, recordSnnTape } from './snnTape';

export interface SnnReplayJob {
  dir: string; params: SnnParams; domain: 'crypto' | 'perps' | 'tennis'; modelPath?: string; checkpoint?: SnnCheckpoint;
  from: number; to: number; fromDay: string; toDay: string; skipModel?: boolean; tennis?: TennisConfig;
  /** A trained network's model file to start from (a champion contest). */
  snnModel?: SnnModelFile;
  /** Play this span's tape instead of replaying the recordings (research/snnTape.ts). */
  playTape?: string;
  /** Only record the span's tape to this file (rows and checkpoint come back empty). */
  recordTape?: string;
}
/** `ms`: the replay's own time (not the wait for a free worker). */
export interface SnnReplayOut { rows: SnnRow[]; checkpoint?: SnnCheckpoint; ms?: number }

/** The device pool to use: `python` with PyTorch for the GPU; `cpu` for its C build (tests). */
export interface SnnGpuSpec { python: string; cpu?: boolean; threads?: number }
/** A group of members playing one tape on the GPU (each from its own checkpoint and start), or a check that the
 *  device pool starts here (its backend comes back). */
export type SnnGpuJob =
  | { gpuGroup: { spec: SnnGpuSpec; tape: string; domain: 'crypto' | 'perps'; members: { params: SnnParams; checkpoint?: SnnCheckpoint; from: number }[] } }
  | { gpuProbe: SnnGpuSpec };
/** `ms`: the group's time, the pool's start excluded. */
export interface SnnGpuOut { outs: SnnReplayOut[]; ms: number; backend?: string }

const calendar = loadCalendar(path.resolve('params/calendar.json'));
const models = new Map<string, MetaModel>();
let gpu: { key: string; pool: Promise<GpuPool> } | undefined;
const gpuPool = (spec: SnnGpuSpec) => {
  const key = JSON.stringify(spec);
  if (gpu?.key !== key) {
    void gpu?.pool.then((p) => p.close(), () => {});
    gpu = { key, pool: GpuPool.start(spec) };
    gpu.pool.catch(() => { gpu = undefined; });
  }
  return gpu.pool;
};

async function gpuJob(j: SnnGpuJob): Promise<SnnGpuOut> {
  if ('gpuProbe' in j) return { outs: [], ms: 0, backend: (await (await gpuPool(j.gpuProbe)).info()).backend };
  const g = j.gpuGroup;
  const pool = await gpuPool(g.spec);
  const t0 = performance.now();
  const rs = await playSnnTapeGpu(g.tape, g.members.map((m) => ({ params: m.params, domain: g.domain, checkpoint: m.checkpoint, allowParamChange: true, from: m.from })), pool);
  return { outs: rs.map((r) => ({ rows: r.rows, checkpoint: r.net.serialize() })), ms: performance.now() - t0 };
}

parentPort?.on('message', async (j: SnnReplayJob | SnnGpuJob) => {
  try {
    if ('gpuGroup' in j || 'gpuProbe' in j) { parentPort!.postMessage({ ok: true, out: await gpuJob(j) }); return; }
    const t0 = performance.now();
    let model: MetaModel | undefined;
    if (j.modelPath) { model = models.get(j.modelPath) ?? MetaModel.load(j.modelPath); models.set(j.modelPath, model); }
    if (j.recordTape) {
      await recordSnnTape(j.dir, j.recordTape, { params: j.params, domain: j.domain, model, calendar, from: j.from, to: j.to, fromDay: j.fromDay, toDay: j.toDay, skipModel: true });
      parentPort!.postMessage({ ok: true, out: { rows: [] } satisfies SnnReplayOut });
      return;
    }
    const r = j.playTape ? playSnnTape(j.playTape, { params: j.params, domain: j.domain, checkpoint: j.checkpoint, snnModel: j.snnModel, allowParamChange: true, from: j.from }) : await replaySnn(j.dir, { params: j.params, domain: j.domain, model, calendar, checkpoint: j.checkpoint, snnModel: j.snnModel, allowParamChange: true, from: j.from, to: j.to, fromDay: j.fromDay, toDay: j.toDay, skipModel: j.skipModel, tennis: j.tennis });
    const out: SnnReplayOut = { rows: r.rows, checkpoint: r.net.serialize(), ms: performance.now() - t0 };
    parentPort!.postMessage({ ok: true, out });
  } catch (e) {
    parentPort!.postMessage({ ok: false, error: (e as Error).stack ?? String(e) });
  }
});
