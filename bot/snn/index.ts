// Wiring for the SNN: params from config (stage flags, deferred flags), the optional offline model
// file, the worker host, the blender and the conservative target scaler.

import fs from 'fs';
import path from 'path';
import type { SnnConfig } from '../config';
import { logger } from '../util/log';
import { DEFAULT_BLENDER, SnnBlender, TargetScaler } from './blender';
import { SnnHost } from './host';
import type { SnnModelFile } from './network';
import { DEFAULT_SNN, stageFlags, versionHash, type SnnParams } from './params';

export { SnnBlender, TargetScaler } from './blender';
export { SnnHost } from './host';

const log = logger('snn');

export function snnParams(c: SnnConfig): SnnParams {
  return {
    ...DEFAULT_SNN,
    seed: c.seed, maxColumns: c.maxColumns, readoutEta: c.readoutEta,
    flags: { ...stageFlags(c.stage), ...c.deferred },
  };
}

export function loadSnnModel(file: string): SnnModelFile | undefined {
  if (!fs.existsSync(file)) return undefined;
  const m = JSON.parse(fs.readFileSync(file, 'utf8')) as SnnModelFile;
  if (m.version !== versionHash(m.params)) throw new Error(`SNN model ${file}: version hash does not match its params`);
  return m;
}

/** Worker script next to the bundle in production (dist/snnWorker.cjs), the TS source under tsx. */
export function workerScript(entry = process.argv[1] ?? ''): { path: string; execArgv?: string[] } {
  if (entry.endsWith('.cjs')) return { path: path.join(path.dirname(entry), 'snnWorker.cjs') };
  return { path: path.resolve('bot/snn/worker.dev.mjs') };
}

export function createSnn(c: SnnConfig, opts: { worker?: boolean } = {}): { host: SnnHost; blender: SnnBlender; scaler: TargetScaler; params: SnnParams; model?: SnnModelFile } | undefined {
  if (c.mode === 'off') return undefined;
  let model: SnnModelFile | undefined;
  try { model = loadSnnModel(c.modelPath); } catch (e) { log.warn(String(e)); }
  // A trained model file defines the network it was trained as; otherwise build from config.
  const params = model?.params ?? snnParams(c);
  if (model) log.info(`SNN model ${model.version} (${model.trainedAt ?? 'untrained'})`);
  const useWorker = (opts.worker ?? c.worker) && fs.existsSync(workerScript().path);
  const host = new SnnHost({
    params, whitelist: c.columns, model, worker: useWorker ? workerScript() : undefined,
    timeoutMs: c.timeoutMs, latencySkipP99Ms: c.latencySkipP99Ms, checkpointDir: c.checkpointDir, checkpointEveryMin: c.checkpointEveryMin, keepCheckpoints: 5,
  });
  const blender = new SnnBlender({ ...DEFAULT_BLENDER, alphaMax: c.alphaMax, minEvents: c.minEvents, govDeltaP: params.govDeltaP, surpriseToC: params.flags.surpriseToC });
  return { host, blender, scaler: new TargetScaler(), params, model };
}
