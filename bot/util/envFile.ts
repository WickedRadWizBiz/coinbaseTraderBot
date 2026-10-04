// Edit the server's env file (~/bot/bot.env) in place: changed keys are rewritten on their own lines, new
// keys appended, comments and order kept, permissions kept (600), written atomically.

import fs from 'fs';

export function updateEnvFile(file: string, changes: Record<string, string>): void {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const left = new Map(Object.entries(changes));
  const out = lines.map((l) => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(l);
    if (m && left.has(m[1])) { const v = left.get(m[1])!; left.delete(m[1]); return `${m[1]}=${v}`; }
    return l;
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [k, v] of left) out.push(`${k}=${v}`);
  const mode = fs.statSync(file).mode & 0o777;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, out.join('\n') + '\n', { mode });
  fs.renameSync(tmp, file);
}
