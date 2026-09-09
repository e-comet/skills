const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const TRANSIENT_RELEASE_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES']);
export const isTransientReleaseError = error => TRANSIENT_RELEASE_ERRORS.has(error?.code);
// Absorb brief sharing violations without holding the response open indefinitely;
// persistent faults get paced background cleanup rather than a busy loop.
const LOCK_RELEASE_ATTEMPTS = 3;
const LOCK_RELEASE_RETRY_MS = 25;
const LOCK_RELEASE_DEFER_MS = 1000;
// Only completed critical sections enter this registry. PID equality alone never
// authorizes reclaiming a live lock, even one created by this process.
export const createOwnedLockReleaseTracker = () => {
    const pendingLockReleases = new Map();
    const retryOwnedLockRelease = (lockPath, pending) => {
        if (pending.inFlight) return pending.inFlight;
        pending.inFlight = (async () => {
            try {
                for (let attempt = 0; ; attempt += 1) {
                    try { await pending.release(); break; }
                    catch (error) {
                        if (!isTransientReleaseError(error) || attempt + 1 >= LOCK_RELEASE_ATTEMPTS) throw error;
                        await delay(LOCK_RELEASE_RETRY_MS);
                    }
                }
                if (pendingLockReleases.get(lockPath) === pending) pendingLockReleases.delete(lockPath);
                if (pending.timer) clearTimeout(pending.timer);
                pending.timer = undefined;
            } catch (error) {
                // A peer may be the next caller while this owner is idle. Retry only our
                // ended section, with one unrefed timer and a bounded batch per attempt.
                if (isTransientReleaseError(error) && !pending.timer) {
                    pending.timer = setTimeout(() => {
                        pending.timer = undefined;
                        void retryOwnedLockRelease(lockPath, pending).catch(() => undefined);
                    }, LOCK_RELEASE_DEFER_MS);
                    pending.timer.unref();
                }
                throw error;
            } finally { pending.inFlight = undefined; }
        })();
        return pending.inFlight;
    };
    return {
        async retryPending(lockPath) {
            const pending = pendingLockReleases.get(lockPath);
            if (pending) await retryOwnedLockRelease(lockPath, pending);
        },
        async release(lockPath, release) {
            const pending = { release, inFlight: undefined, timer: undefined };
            pendingLockReleases.set(lockPath, pending);
            await retryOwnedLockRelease(lockPath, pending);
        },
    };
};
