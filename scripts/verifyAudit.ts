// Verify the hash chain of every audit log file.
//   npm run audit:verify -- [data/audit]
import fs from 'fs';
import path from 'path';
import { AuditLog } from '../bot/audit/auditLog';

const dir = process.argv[2] ?? path.resolve(process.env.DATA_DIR ?? 'data', 'audit');
let bad = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort()) {
  const seq = AuditLog.verifyFile(path.join(dir, f));
  if (seq === null) console.log(`ok       ${f}`);
  else { console.log(`TAMPERED ${f} at seq ${seq}`); bad++; }
}
process.exit(bad ? 1 : 0);
