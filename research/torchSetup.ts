// PyTorch for the TA network's torch engine (research/taNetTorch.ts) on the laptop trainer: a Python environment
// in trainer-data/python-env made with uv (the Windows package ships uv/uv.exe; elsewhere uv on PATH), with the
// CUDA 12.8 build of PyTorch (RTX 50xx / Blackwell need it) when there is an NVIDIA GPU, the CPU build otherwise
// (still several times faster than the TypeScript trainer). Done once (about 3 GB with CUDA, 300 MB without); later
// runs only check it. No uv, or anything failing: the TA network trains in TypeScript.
//
//   TA_NET_ENGINE=ts in trainer.env      never set up or use PyTorch
//   TA_NET_PYTHON=C:\path\python.exe     use this Python (with PyTorch) instead

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface TorchEnv { python: string; torch: string; cuda: boolean; gpu?: string }

/** The PyTorch wheel index: CUDA 12.8 (Blackwell needs it; older NVIDIA GPUs run it too) or CPU-only. */
export const TORCH_INDEX = { cuda: 'https://download.pytorch.org/whl/cu128', cpu: 'https://download.pytorch.org/whl/cpu' } as const;
export const TORCH_SPEC = 'torch>=2.7,<3';
export const PYTHON_VERSION = '3.12';

export const envPython = (envDir: string, win = process.platform === 'win32') => (win ? path.join(envDir, 'Scripts', 'python.exe') : path.join(envDir, 'bin', 'python'));

const PROBE = [
  'import json, torch',
  "d = {'torch': torch.__version__, 'cuda': False}",
  'try:',
  '    if torch.cuda.is_available():',
  "        x = torch.ones(64, device='cuda')",
  "        d['cuda'] = float((x * 2).sum()) == 128.0",
  "        d['gpu'] = torch.cuda.get_device_name(0)",
  'except Exception as e:',
  "    d['cudaError'] = str(e).splitlines()[0][:200]",
  'print(json.dumps(d))',
].join('\n');

/** What a Python's PyTorch can do (undefined: no Python, or no PyTorch in it). */
export function probeTorch(python: string): (TorchEnv & { cudaError?: string }) | undefined {
  if (!python) return undefined;
  const r = spawnSync(python, ['-c', PROBE], { encoding: 'utf8', timeout: 180_000, windowsHide: true });
  if (r.status !== 0) return undefined;
  try {
    const j = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as { torch: string; cuda: boolean; gpu?: string; cudaError?: string };
    return { python, torch: j.torch, cuda: j.cuda, ...(j.gpu ? { gpu: j.gpu } : {}), ...(j.cudaError ? { cudaError: j.cudaError } : {}) };
  } catch { return undefined; }
}

/** An NVIDIA GPU with a driver (nvidia-smi lists it). */
export function nvidiaGpu(): string | undefined {
  const r = spawnSync('nvidia-smi', ['-L'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  const l = r.status === 0 ? r.stdout.split('\n').find((x) => /^GPU \d+:/.test(x.trim())) : undefined;
  return l?.trim().replace(/^GPU \d+:\s*/, '').replace(/\s*\(UUID.*$/, '');
}

/** uv: next to the bundled app (KalshiTrainer/uv/uv.exe), else on PATH. */
export function findUv(entry = process.argv[1] ?? ''): string | undefined {
  const exe = process.platform === 'win32' ? 'uv.exe' : 'uv';
  const near = [path.resolve(path.dirname(entry), '..', '..', 'uv', exe), path.resolve(path.dirname(entry), '..', 'uv', exe)].find((p) => fs.existsSync(p));
  if (near) return near;
  return spawnSync('uv', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0 ? 'uv' : undefined;
}

/** A command with its output relayed to `log` (uv's per-package lines at most every few seconds); its exit code. */
export function runLogged(cmd: string, args: string[], env: NodeJS.ProcessEnv, log: (m: string) => void, timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let last = 0;
    const out = (d: Buffer) => {
      for (const l of d.toString('utf8').split(/\r?\n/)) {
        const t = l.trim();
        // uv's per-package lines; at most one every few seconds (the big wheel is the wait).
        if (t && (Date.now() - last > 3000 || /^(Installed|Prepared|Resolved|Using|Creating|error|warning)/i.test(t))) { last = Date.now(); log(`  ${t.slice(0, 200)}`); }
      }
    };
    c.stdout!.on('data', out);
    c.stderr!.on('data', out);
    const timer = setTimeout(() => c.kill(), timeoutMs);
    c.on('close', (code) => { clearTimeout(timer); resolve(code ?? 1); });
    c.on('error', (e) => { clearTimeout(timer); log(`  ${e.message}`); resolve(1); });
  });
}

/** A Python with PyTorch for the torch engine, setting it up when needed (undefined: train in TypeScript). */
export async function ensureTorch(dataDir: string, log: (m: string) => void, o: { python?: string; uv?: string; gpu?: string | null; timeoutMs?: number } = {}): Promise<TorchEnv | undefined> {
  const own = o.python ?? process.env.TA_NET_PYTHON;
  if (own) {
    const p = probeTorch(own);
    if (p) { log(`PyTorch ${p.torch} from TA_NET_PYTHON (${p.cuda ? `GPU: ${p.gpu}` : 'CPU'})`); return p; }
    log(`TA_NET_PYTHON=${own} has no working PyTorch; setting up the trainer's own`);
  }
  const gpu = o.gpu === null ? undefined : o.gpu ?? nvidiaGpu();
  const envDir = path.join(dataDir, 'python-env');
  const python = envPython(envDir);
  const have = fs.existsSync(python) ? probeTorch(python) : undefined;
  if (have && (have.cuda || !gpu)) { log(`PyTorch ${have.torch} ready (${have.cuda ? `GPU: ${have.gpu}` : 'CPU'})`); return have; }
  if (have) log(`PyTorch ${have.torch} does not run on the GPU${have.cudaError ? ` (${have.cudaError})` : ''}; installing the CUDA 12.8 build`);
  const uv = o.uv ?? findUv();
  if (!uv) { log('uv not found (the Windows package ships it): the TA network trains in TypeScript'); return undefined; }
  log(gpu
    ? `setting up PyTorch for the GPU (${gpu}): Python ${PYTHON_VERSION} and the CUDA 12.8 build of PyTorch, a one-time download of about 3 GB...`
    : `no NVIDIA GPU found: setting up PyTorch for the CPU (still several times faster than TypeScript), a one-time download of about 300 MB...`);
  const env = { ...process.env, UV_PYTHON_INSTALL_DIR: path.join(dataDir, 'python-dist'), UV_CACHE_DIR: path.join(dataDir, 'uv-cache'), UV_NO_PROGRESS: '1', UV_LINK_MODE: 'copy' };
  const t0 = Date.now(), limit = o.timeoutMs ?? 90 * 60_000;
  if (!have) {
    fs.rmSync(envDir, { recursive: true, force: true });
    if (await runLogged(uv, ['venv', envDir, '--python', PYTHON_VERSION], env, log, limit) !== 0) { log('creating the Python environment failed: the TA network trains in TypeScript'); return undefined; }
  }
  if (await runLogged(uv, ['pip', 'install', '--python', python, 'numpy'], env, log, limit) !== 0
    || await runLogged(uv, ['pip', 'install', '--python', python, '--reinstall-package', 'torch', TORCH_SPEC, '--index-url', gpu ? TORCH_INDEX.cuda : TORCH_INDEX.cpu], env, log, Math.max(60_000, limit - (Date.now() - t0))) !== 0) {
    log('installing PyTorch failed (it is tried again on the next run): the TA network trains in TypeScript');
    return undefined;
  }
  const p = probeTorch(python);
  if (!p) { log('PyTorch installed but does not start: the TA network trains in TypeScript'); return undefined; }
  log(`PyTorch ${p.torch} installed in ${((Date.now() - t0) / 60_000).toFixed(0)} min (${p.cuda ? `GPU: ${p.gpu}` : gpu ? `the GPU does not answer${p.cudaError ? ` (${p.cudaError})` : ''}: an NVIDIA driver from 570 on is needed for CUDA 12.8; training on the CPU meanwhile` : 'CPU'})`);
  return p;
}
