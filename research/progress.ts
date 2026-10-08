// Progress lines for the laptop trainer's window (research/trainerUi.ts): long loops in the pipeline (downloads,
// tournaments, the formula evolution) report how far they are as `[progress] {"task","done","total"}` on stdout,
// which the trainer reads from the pipeline's output to draw its progress bars and time estimates.
//
// Only when the trainer asks for them (TRAINER_PROGRESS=1), so the server's and the remote job's logs stay as
// they were; at most one line a second per task, and always the last one.

const last = new Map<string, number>();

export function progress(task: string, done: number, total: number, now = Date.now()): void {
  if (process.env.TRAINER_PROGRESS !== '1' || !(total > 0)) return;
  const t = last.get(task) ?? 0;
  if (done < total && now - t < 1000) return;
  last.set(task, now);
  process.stdout.write(`[progress] ${JSON.stringify({ task, done: Math.min(done, total), total })}\n`);
}
