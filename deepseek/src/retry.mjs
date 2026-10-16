// Backoff protects the e-Comet services and the local machine from a reconnect storm while a
// connection stays down; the cap keeps recovery within minutes once the cause clears.
export const RECONNECT_DELAYS_MS = Object.freeze([5_000, 15_000, 60_000, 300_000]);

/**
 * One pending retry at a time. `attempt` resolves true when nothing is left to do and false to try
 * again after the next delay; a thrown error counts as false. Timers never keep the Host alive.
 */
export function createRetry(attempt, { delays = RECONNECT_DELAYS_MS } = {}) {
  let timer;
  let failures = 0;
  let stopped = false;
  function schedule() {
    if (stopped || timer) return;
    timer = setTimeout(async () => {
      let done;
      try { done = await attempt(); } catch { done = false; }
      timer = undefined;
      if (stopped) return;
      if (done) failures = 0;
      else { failures++; schedule(); }
    }, delays[Math.min(failures, delays.length - 1)]);
    timer.unref?.();
  }
  return {
    schedule,
    reset() { clearTimeout(timer); timer = undefined; failures = 0; },
    stop() { stopped = true; clearTimeout(timer); timer = undefined; },
  };
}
