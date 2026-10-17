// The hash of the SNN kernel's C sources (python/snn/column.cu + fdlibm.h), recorded in bot/snn/kernelWasm.ts
// when the WebAssembly is built and checked by the tests, so the embedded kernel never lags its sources.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export function kernelSourceHash(root: string): string {
  const h = crypto.createHash('sha256');
  // Line endings normalised (a Windows checkout has the same kernel).
  for (const f of ['python/snn/column.cu', 'python/snn/fdlibm.h']) h.update(fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n'));
  return h.digest('hex').slice(0, 16);
}
