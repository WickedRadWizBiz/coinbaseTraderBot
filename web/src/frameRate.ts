const steppers = new Set<(now: number) => void>();

/** Run fn on every step of the page's animation clock (see capAnimationFrameRate), so what it draws reaches the screen
 *  in the same frame as the stepped CSS animations. Returns the unsubscribe function. */
export function onAnimationStep(fn: (now: number) => void): () => void {
  steppers.add(fn);
  return () => { steppers.delete(fn); };
}

/** Endless CSS animations (the screens' flicker and scan bar, the LEDs, the pulsing indicators) advance `fps` times a
 *  second instead of at the display's refresh rate (60-120 Hz on a phone). Each one is paused and moved to the current
 *  time on a shared clock, so it keeps its keyframes, duration, easing and phase: it looks the same, with a fraction
 *  of the redraws. Transitions and one-shot animations (key presses, the trade shake) run untouched. */
export function capAnimationFrameRate(fps = 20): () => void {
  const canStep = typeof document.getAnimations === 'function' && typeof CSSAnimation !== 'undefined';
  // For each animation taken over: the document time at which its own time was zero.
  const origin = new WeakMap<Animation, number>();
  const ignored = new WeakSet<Animation>();
  const stepAnimations = (now: number) => {
    // All reads before any write: reading an animation's state brings styles up to date, so interleaving reads with
    // the writes below would recalculate styles once per animation instead of once per step.
    const fresh: Animation[] = [];
    const step: Array<[Animation, number]> = [];
    for (const a of document.getAnimations()) {
      let t0 = origin.get(a);
      if (t0 === undefined) {
        if (ignored.has(a)) continue;
        if (!(a instanceof CSSAnimation) || a.effect?.getTiming().iterations !== Infinity) { ignored.add(a); continue; }
        // A newly started animation: take it over where it is.
        if (a.playState !== 'running' || typeof a.currentTime !== 'number') continue;
        t0 = now - a.currentTime;
        origin.set(a, t0);
        fresh.push(a);
      }
      step.push([a, t0]);
    }
    for (const a of fresh) a.pause();
    for (const [a, t0] of step) a.currentTime = now - t0;
  };
  const tick = () => {
    if (document.hidden) return;
    const t = document.timeline.currentTime;
    const now = typeof t === 'number' ? t : performance.now();
    if (canStep && typeof t === 'number') stepAnimations(now);
    for (const fn of steppers) fn(now);
  };
  tick();
  const id = setInterval(tick, 1000 / fps);
  return () => clearInterval(id);
}
