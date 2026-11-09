import { AsyncLocalStorage } from 'node:async_hooks';
// The meter of the run a call belongs to. The run registry enters it; use cases count progress through it without
// knowing about runs (refactor spec §6.3).
export const currentRun = new AsyncLocalStorage();
// Best-effort progress for the run this call belongs to: counts settled units. The meter is captured here, so a callback
// that a socket event invokes later still counts.
export const countRunProgress = (total, unit) => {
    const meter = currentRun.getStore();
    if (!meter)
        return unit;
    const progress = { completed: 0, total };
    meter.progress = progress;
    return async (...args) => {
        try {
            return await unit(...args);
        }
        finally {
            progress.completed += 1;
        }
    };
};
