// Wiring for the SNN: params from config (stage flags, deferred flags), the optional offline model
// file, the worker host, the blender and the conservative target scaler.

import fs from 'fs';
import path from 'path';
import type { SnnConfig } from '../config';
import { logger } from '../util/log';
import { DEFAULT_BLENDER, SnnBlender, TargetScaler } from './blender';
import { SnnHost, type SnnHostLike } from './host';
import type { SnnCheckpoint, SnnModelFile } from './network';
import { SnnPopulationHost } from './population';
import { DEFAULT_SNN, domainParams, SNN_DOMAINS, stageFlags, versionHash, type SnnDomain, type SnnParams } from './params';

export { SnnBlender, TargetScaler } from './blender';
export { SnnHost } from './host';

const log = logger('snn');

export function snnParams(c: SnnConfig, domain?: SnnDomain): SnnParams {
  const stage = domain ? c.domains[domain].stage : c.stage;
  const base = { ...DEFAULT_SNN, seed: c.seed, maxColumns: c.maxColumns, readoutEta: c.readoutEta, flags: { ...stageFlags(stage), ...c.deferred } };
  return domain ? domainParams(domain, base) : base;
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

/** One isolated SNN: its own worker, params, model file and checkpoint directory. */
export interface SnnUnit { domain: SnnDomain; host: SnnHostLike; params: SnnParams; model?: SnnModelFile }

/** The three isolated SNNs (crypto contracts, perps, tennis), plus the legacy blender (crypto only)
 *  and the conservative target scaler. */
export interface SnnFleet { units: Partial<Record<SnnDomain, SnnUnit>>; blender: SnnBlender; scaler: TargetScaler }

export function createSnnUnit(c: SnnConfig, domain: SnnDomain, modelPath: string, opts: { worker?: boolean } = {}): SnnUnit {
  let model: SnnModelFile | undefined;
  try { model = loadSnnModel(modelPath); } catch (e) { log.warn(String(e)); }
  const params = model?.params ?? snnParams(c, domain);
  if (model) log.info(`SNN ${domain} model ${model.version} (${model.trainedAt ?? 'untrained'})`);
  const useWorker = (opts.worker ?? c.worker) && fs.existsSync(workerScript().path);
  const hostFor = (p: SnnParams, dir: string, seed?: SnnCheckpoint) => new SnnHost({
    params: p, whitelist: domain === 'tennis' ? undefined : c.columns, model: p === params ? model : model ? { ...model, params: p, version: versionHash(p) } : undefined,
    worker: useWorker ? workerScript() : undefined, timeoutMs: c.timeoutMs, latencySkipP99Ms: c.latencySkipP99Ms, checkpointDir: dir, checkpointEveryMin: c.checkpointEveryMin, keepCheckpoints: 5, seedCheckpoint: seed,
  });
  // The tennis network learns live only, so its population tournament runs live (population.ts).
  if (domain === 'tennis' && c.tennisPopulation) {
    const dir = path.join(c.checkpointDir, domain, 'population');
    const host = new SnnPopulationHost({ base: params, dir, roundSettles: c.tennisPopulationSettles, seed: c.seed, makeHost: (p, member, seed) => hostFor(p, path.join(dir, `m${member}`), seed) });
    return { domain, host, params, model };
  }
  return { domain, host: hostFor(params, path.join(c.checkpointDir, domain)), params, model };
}

/** Build the fleet; `paths` overrides each domain's model file (the auto-trainer's promoted copies). */
export function createSnnFleet(c: SnnConfig, paths: Partial<Record<SnnDomain, string>> = {}, opts: { worker?: boolean } = {}): SnnFleet | undefined {
  if (c.mode === 'off') return undefined;
  const units: SnnFleet['units'] = {};
  for (const d of SNN_DOMAINS) if (c.domains[d].enabled) units[d] = createSnnUnit(c, d, paths[d] ?? c.domains[d].modelPath, opts);
  if (!Object.keys(units).length) return undefined;
  const cp = units.crypto?.params ?? snnParams(c, 'crypto');
  const blender = new SnnBlender({ ...DEFAULT_BLENDER, alphaMax: c.alphaMax, minEvents: c.minEvents, govDeltaP: cp.govDeltaP, surpriseToC: cp.flags.surpriseToC });
  return { units, blender, scaler: new TargetScaler() };
}
