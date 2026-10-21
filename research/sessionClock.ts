// The training session's clock: the laptop trainer's session length (TRAIN_SESSION_MIN, minutes; 60 by default in its
// window). The pipeline starts it with the first training step: the data steps before it (the history download, the
// replay build) are outside it. The networks get the first part of it; the rest (SESSION_DECISION_SHARE, 30%) is kept
// for the decision models that read them (vol_model, dataset, mlp, perps, ...), whose phase begins with the first of
// them. No step starts once its part is used up, and the long steps stop at their next unit boundary (a tournament
// round, a GP generation, a sweep's or the walk-forward export's own time budget); tournaments and sweeps carry on from
// there in the next session. Unset or 0: no clock (the server's own runs).

let end = Infinity;
let phaseEnd = Infinity;
let minutes = 0;

/** Starts the clock (once per pipeline run; a later call is ignored). The networks' part ends `share` of the session
 *  before its end. */
export function startSession(min: number, share = Number(process.env.SESSION_DECISION_SHARE ?? 0.3), now = Date.now()): void {
  if (!(min > 0) || end !== Infinity) return;
  const s = Math.min(0.9, Math.max(0, Number.isFinite(share) ? share : 0.3));
  minutes = min;
  end = now + min * 60_000;
  phaseEnd = end - s * min * 60_000;
}

/** The decision models' phase: the rest of the session, whatever the networks left. */
export function enterDecisionPhase(): void { phaseEnd = end; }

/** The current part of the session is used up (always false with no clock). */
export const sessionTimeUp = (now = Date.now()): boolean => now >= phaseEnd;

/** Milliseconds left in the current part (Infinity with no clock). */
export const sessionLeftMs = (now = Date.now()): number => phaseEnd - now;

/** A step's own hours budget, capped at what is left of the current part (at least a minute). */
export const capHours = (hours: number, now = Date.now()): number => (phaseEnd === Infinity ? hours : Math.max(1 / 60, Math.min(hours, sessionLeftMs(now) / 3_600_000)));

export const sessionActive = (): boolean => end !== Infinity;
export const sessionMinutes = (): number => minutes;

/** Back to no clock (tests; a new pipeline run in the same process). */
export function resetSession(): void { end = Infinity; phaseEnd = Infinity; minutes = 0; }
