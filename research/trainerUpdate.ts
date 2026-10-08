// New versions of the laptop trainer: the Windows package is published as the repository's "trainer-latest"
// release (.github/workflows/trainer-windows.yml), built from one commit. The trainer compares that commit with
// the one it was built from (app/VERSION.txt), and the window asks before anything is downloaded:
//
//   check     GET the release (public, no key) on start and every 6 hours
//   install   only after you say yes: download the zip into <install>/update, then a small script waits for
//             the trainer to exit, unpacks the zip (PowerShell Expand-Archive), copies it over the install
//             folder (robocopy; trainer-data, your models and history, is never touched) and starts the
//             trainer again. Windows only; elsewhere the window links the release page.

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

export const REPO = 'WickedRadWizBiz/coinbaseTraderBot';
export const RELEASE_TAG = 'trainer-latest';
export const RELEASE_PAGE = `https://github.com/${REPO}/releases/tag/${RELEASE_TAG}`;
const ASSET = 'KalshiTrainer-windows.zip';

export interface UpdateInfo {
  current: string | null; latest: string | null; publishedAt: string | null;
  available: boolean; canInstall: boolean; downloadUrl: string | null; checkedAt: string | null; error?: string;
}

/** The commit a package was built from: "built <date> from <sha>" (VERSION.txt) or "Built from <sha>." (release notes). */
export function shaOf(text: string | null | undefined): string | null {
  const m = /from ([0-9a-f]{7,40})/i.exec(text ?? '');
  return m ? m[1].toLowerCase() : null;
}

/** The install folder (KalshiTrainer, holding Train.cmd and app/) when this is the packaged trainer. */
export function installRoot(entry = process.argv[1] ?? ''): string | undefined {
  if (!entry.endsWith('.cjs')) return undefined;
  const root = path.resolve(path.dirname(entry), '..', '..');
  return fs.existsSync(path.join(root, 'Train.cmd')) && fs.existsSync(path.join(root, 'app')) ? root : undefined;
}

export function currentVersion(root = installRoot()): string | null {
  if (!root) return null;
  try { return shaOf(fs.readFileSync(path.join(root, 'app', 'VERSION.txt'), 'utf8')); } catch { return null; }
}

export async function checkForUpdate(o: { fetchImpl?: typeof fetch; current?: string | null; root?: string; platform?: string } = {}): Promise<UpdateInfo> {
  const f = o.fetchImpl ?? fetch;
  const root = o.root ?? installRoot();
  const current = o.current !== undefined ? o.current : currentVersion(root);
  const base: UpdateInfo = { current, latest: null, publishedAt: null, available: false, canInstall: false, downloadUrl: null, checkedAt: new Date().toISOString() };
  try {
    const res = await f(`https://api.github.com/repos/${REPO}/releases/tags/${RELEASE_TAG}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'kalshi-bot-trainer' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { ...base, error: `GitHub answered HTTP ${res.status}` };
    const r = await res.json() as { body?: string; published_at?: string; target_commitish?: string; assets?: Array<{ name: string; browser_download_url: string }> };
    const latest = shaOf(r.body) ?? (/^[0-9a-f]{40}$/i.test(r.target_commitish ?? '') ? r.target_commitish!.toLowerCase() : null);
    const asset = r.assets?.find((a) => a.name === ASSET);
    const differs = !!latest && !!current && !latest.startsWith(current.slice(0, 7)) && !current.startsWith(latest.slice(0, 7));
    return { ...base, latest, publishedAt: r.published_at ?? null, available: differs, canInstall: differs && !!asset && !!root && (o.platform ?? process.platform) === 'win32', downloadUrl: asset?.browser_download_url ?? null };
  } catch (e) { return { ...base, error: (e as Error).message }; }
}

/** The script that swaps the new version in once the trainer has exited, then starts it again. */
export function applyScript(root: string, zip: string, pid: number): string {
  const staging = path.win32.join(root, 'update', 'staging');
  return [
    '@echo off',
    'rem Installs the new trainer once the running one has exited. Your data (trainer-data) is not touched.',
    'echo Updating the Kalshi bot trainer...',
    `:wait`,
    `tasklist /FI "PID eq ${pid}" 2>nul | find "${pid}" >nul && (timeout /t 1 /nobreak >nul & goto wait)`,
    `if exist "${staging}" rmdir /s /q "${staging}"`,
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '${zip}' -DestinationPath '${staging}' -Force"`,
    `if not exist "${path.win32.join(staging, 'KalshiTrainer', 'app', 'dist', 'laptopTrain.cjs')}" (echo The download was incomplete; the old version is kept. & pause & exit /b 1)`,
    `robocopy "${path.win32.join(staging, 'KalshiTrainer')}" "${root}" /E /XD trainer-data update /R:5 /W:2 /NFL /NDL /NJH /NJS >nul`,
    `if errorlevel 8 (echo Copying the new version failed; run Train.cmd to keep using the old one. & pause & exit /b 1)`,
    `rmdir /s /q "${staging}"`,
    `del "${zip}"`,
    `start "" "${path.win32.join(root, 'Train.cmd')}"`,
    '',
  ].join('\r\n');
}

/** Download the new package and hand over to the apply script (which waits for this process to exit). */
export async function downloadAndStage(info: UpdateInfo, o: { root?: string; fetchImpl?: typeof fetch; onProgress?: (done: number, total: number) => void } = {}): Promise<string> {
  const root = o.root ?? installRoot();
  if (!root || !info.downloadUrl) throw new Error('this is not the packaged Windows trainer: download the new version from the release page');
  if (!info.downloadUrl.startsWith(`https://github.com/${REPO}/releases/download/`)) throw new Error('unexpected download address');
  const f = o.fetchImpl ?? fetch;
  const res = await f(info.downloadUrl, { headers: { 'User-Agent': 'kalshi-bot-trainer' }, signal: AbortSignal.timeout(30 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const dir = path.join(root, 'update');
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, ASSET);
  const out = fs.createWriteStream(zip);
  let done = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    done += value.length;
    if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
    o.onProgress?.(done, total);
  }
  await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
  if (total && done !== total) throw new Error('download incomplete');
  const script = path.join(dir, 'apply-update.cmd');
  fs.writeFileSync(script, applyScript(root, zip, process.pid));
  return script;
}

/** Start the apply script in its own window, detached, so it outlives this process. */
export function runApplyScript(script: string): void {
  spawn('cmd.exe', ['/c', 'start', '"Kalshi trainer update"', '/min', 'cmd.exe', '/c', script], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
}
