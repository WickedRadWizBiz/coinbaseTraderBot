// Development worker bootstrap (tsx): registers the TypeScript loader inside the worker thread,
// then loads the real entry. Production uses the bundled dist/snnWorker.cjs instead.
import { register } from 'tsx/esm/api';

register();
await import('./worker.ts');
