// Worker-thread entry: owns all SNN state; the main thread talks to it with postMessage.
// Bundled to dist/snnWorker.cjs (npm run build:bot); in development it runs through tsx.
import { parentPort } from 'worker_threads';
import { SnnRuntime, type SnnRequest } from './runtime';

const rt = new SnnRuntime();
parentPort?.on('message', (m: SnnRequest) => parentPort!.postMessage(rt.handle(m)));
