// Operator run control from the dashboard: STOP pauses new entries (open positions are still managed and
// exited), PLAY resumes. Persisted in DATA_DIR/control.json, so a restart keeps the operator's choice.

import fs from 'fs';
import path from 'path';

export class RunControl {
  private state: { active: boolean; ts: number; by?: string };

  constructor(private readonly file: string) {
    try { this.state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.state = { active: true, ts: 0 }; }
  }

  get active(): boolean { return this.state.active !== false; }

  set(active: boolean, by = 'dashboard'): void {
    this.state = { active, ts: Date.now(), by };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }

  status(): { active: boolean; since: number | null } { return { active: this.active, since: this.state.ts || null }; }
}
