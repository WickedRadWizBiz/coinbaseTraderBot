// tvdatafeed (TradingView history, no login) for the laptop trainer: a small Python environment in trainer-data/tv-env
// made with uv (the Windows package ships uv/uv.exe; elsewhere uv on PATH), so the pipeline's history step can run
// deploy/tv_history.py there (research/history/tradingview.ts, TV_PYTHON) the way the server runs it in its venv.
// What it fetches first: the full 5,000-bar daily history of CRYPTOCAP:BTC.D (back to 2013), which the Fractal
// Alignment Engine's 2016-2017 parent window needs, and the other index series.
//
// tvdatafeed is not on PyPI; it is installed from its GitHub archive (no git needed), the same source the server
// installs. Done once; later runs only check it. No uv, or anything failing: TV_FILL stays off and the log says why.
//
//   TV_FILL=false in trainer.env           never set up or use it
//   TV_PYTHON=C:\path\python.exe           use this Python (with tvdatafeed) instead
//   TV_DATAFEED_SPEC=<pip requirement>     install this instead of the default archive

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { envPython, findUv, PYTHON_VERSION, runLogged } from './torchSetup';

export const TV_DATAFEED_SPEC = 'tvdatafeed @ https://github.com/rongardF/tvdatafeed/archive/refs/heads/main.zip';

/** Whether a Python imports tvdatafeed (its module is tvDatafeed). */
export function probeTv(python: string): boolean {
  if (!python) return false;
  return spawnSync(python, ['-c', 'import tvDatafeed'], { encoding: 'utf8', timeout: 120_000, windowsHide: true }).status === 0;
}

/** A Python with tvdatafeed: TV_PYTHON, the trainer's own (set up on first use), or undefined (the reason logged). */
export async function ensureTvDatafeed(dataDir: string, log: (m: string) => void, o: { python?: string; uv?: string; spec?: string; timeoutMs?: number } = {}): Promise<string | undefined> {
  const own = o.python ?? process.env.TV_PYTHON;
  if (own) {
    if (probeTv(own)) { log(`tvdatafeed from TV_PYTHON (${own})`); return own; }
    log(`TV_PYTHON=${own} has no tvdatafeed; setting up the trainer's own`);
  }
  const envDir = path.join(dataDir, 'tv-env');
  const python = envPython(envDir);
  if (fs.existsSync(python) && probeTv(python)) return python;
  const uv = o.uv ?? findUv();
  if (!uv) { log('uv not found (the Windows package ships it): no TradingView history (BTC.D before the bot\'s own bars stays missing)'); return undefined; }
  log('setting up tvdatafeed for the TradingView history (BTC.D and the other index series): a one-time download of about 60 MB...');
  const env = { ...process.env, UV_PYTHON_INSTALL_DIR: path.join(dataDir, 'python-dist'), UV_CACHE_DIR: path.join(dataDir, 'uv-cache'), UV_NO_PROGRESS: '1', UV_LINK_MODE: 'copy' };
  const t0 = Date.now(), limit = o.timeoutMs ?? 20 * 60_000;
  if (!fs.existsSync(python)) {
    fs.rmSync(envDir, { recursive: true, force: true });
    if (await runLogged(uv, ['venv', envDir, '--python', PYTHON_VERSION], env, log, limit) !== 0) { log('creating the Python environment for tvdatafeed failed (tried again next run): no TradingView history this run'); return undefined; }
  }
  if (await runLogged(uv, ['pip', 'install', '--python', python, o.spec ?? process.env.TV_DATAFEED_SPEC ?? TV_DATAFEED_SPEC], env, log, Math.max(60_000, limit - (Date.now() - t0))) !== 0) {
    log('installing tvdatafeed failed (tried again next run): no TradingView history this run');
    return undefined;
  }
  if (!probeTv(python)) { log('tvdatafeed installed but does not import: no TradingView history this run'); return undefined; }
  log(`tvdatafeed ready in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return python;
}
