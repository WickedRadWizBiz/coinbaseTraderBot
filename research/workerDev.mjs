// Development worker bootstrap (tsx): registers the TypeScript loader inside the worker thread, then
// loads the TypeScript entry named in workerData.entry. Bundled pipelines use dist/<name>.cjs instead.
import { workerData } from 'worker_threads';
import { register } from 'tsx/esm/api';

register();
await import(workerData.entry);
