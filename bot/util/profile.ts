// On-demand CPU profile of the bot's main thread (node:inspector), summarised for diagnostics: which
// functions and files the CPU time goes to. Read-only, at most 15 s, one at a time, and at most once a
// minute (the dashboard has no login).

import fs from 'fs';
import inspector from 'inspector';
import { fileURLToPath } from 'url';

interface Node { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number; children?: number[] }
interface Profile { nodes: Node[]; startTime: number; endTime: number; samples?: number[]; timeDeltas?: number[] }

let busy = false, lastAt = 0;

export interface ProfileSummary { seconds: number; sampledMs: number; idleShare: number; topFunctions: Array<{ fn: string; where: string; ms: number; share: number }>; topFiles: Array<{ file: string; ms: number; share: number }> }

export async function cpuProfile(seconds: number, now = Date.now()): Promise<ProfileSummary | { error: string }> {
  if (busy) return { error: 'a profile is already running' };
  if (now - lastAt < 60_000) return { error: `try again in ${Math.ceil((60_000 - (now - lastAt)) / 1000)} s` };
  busy = true; lastAt = now;
  const sec = Math.max(1, Math.min(15, seconds));
  const session = new inspector.Session();
  session.connect();
  const post = <T>(method: string, params?: object) => new Promise<T>((res, rej) => session.post(method, params ?? {}, (err, r) => (err ? rej(err) : res(r as T))));
  try {
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: 1000 });
    await post('Profiler.start');
    await new Promise((r) => setTimeout(r, sec * 1000));
    const { profile } = await post<{ profile: Profile }>('Profiler.stop');
    return summarise(profile, sec);
  } finally {
    session.disconnect();
    busy = false;
  }
}

/** esbuild bundles mark each module with a "// path/to/file.ts" line: map bundle lines back to sources. */
const markers = new Map<string, Array<[number, string]>>();
function sourceOf(url: string, line: number): string {
  if (!url) return '';
  let m = markers.get(url);
  if (!m) {
    m = [];
    try {
      const file = url.startsWith('file:') ? fileURLToPath(url) : url;
      if (/\.cjs$/.test(file)) fs.readFileSync(file, 'utf8').split('\n').forEach((l, i) => { const r = /^\/\/ ((?:bot|research|web|node_modules)\/[^\s]+\.(?:ts|js|mjs|cjs))$/.exec(l); if (r) m!.push([i, r[1]]); });
    } catch { /* not readable: file names only */ }
    markers.set(url, m);
  }
  if (!m.length) return url.replace(/^.*\//, '');
  let lo = 0, hi = m.length - 1, best = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (m[mid][0] <= line) { best = mid; lo = mid + 1; } else hi = mid - 1; }
  return best >= 0 ? m[best][1] : url.replace(/^.*\//, '');
}

export function summarise(p: Profile, seconds: number): ProfileSummary {
  // Self time per node from the sample stream (time delta attributed to the sampled node).
  const self = new Map<number, number>();
  const samples = p.samples ?? [], deltas = p.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) self.set(samples[i], (self.get(samples[i]) ?? 0) + (deltas[i] ?? 0) / 1000);
  const byFn = new Map<string, { fn: string; where: string; ms: number }>(), byFile = new Map<string, number>();
  let total = 0, idle = 0;
  for (const n of p.nodes) {
    const ms = self.get(n.id) ?? 0;
    if (!ms) continue;
    total += ms;
    const f = n.callFrame.functionName || '(anonymous)';
    if (f === '(idle)' || f === '(program)' && !n.callFrame.url) { if (f === '(idle)') idle += ms; }
    const file = n.callFrame.url ? sourceOf(n.callFrame.url, n.callFrame.lineNumber).slice(-80) : f;
    const key = `${f}@${file}:${n.callFrame.lineNumber + 1}`;
    const e = byFn.get(key) ?? { fn: f, where: `${file}:${n.callFrame.lineNumber + 1}`, ms: 0 };
    e.ms += ms; byFn.set(key, e);
    byFile.set(file, (byFile.get(file) ?? 0) + ms);
  }
  const share = (ms: number) => +(ms / Math.max(1, total)).toFixed(3);
  return {
    seconds, sampledMs: Math.round(total), idleShare: share(idle),
    topFunctions: [...byFn.values()].sort((a, b) => b.ms - a.ms).slice(0, 30).map((e) => ({ ...e, ms: Math.round(e.ms), share: share(e.ms) })),
    topFiles: [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([file, ms]) => ({ file, ms: Math.round(ms), share: share(ms) })),
  };
}
