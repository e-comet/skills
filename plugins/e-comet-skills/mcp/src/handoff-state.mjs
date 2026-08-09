import { HANDOFF_RECONNECT_GRACE_MAX_MS } from './config.mjs';

export class HandoffState {
    target = null;
    transitioning = false;
    takeoverGranted = false;
    listenerYieldUntil = 0;

    // The ceiling is the shared constant, not a multiple of the default grace: deriving it meant that changing
    // `HANDOFF_RECONNECT_GRACE_MS` would silently move the clamp every caller that omits the parameter — all of
    // the tests — exercises, away from the one production passes.
    constructor({ generation, instanceId, reconnectGraceMs, reconnectGraceMaxMs = HANDOFF_RECONNECT_GRACE_MAX_MS, now = Date.now }) {
        this.generation = generation;
        this.instanceId = instanceId;
        this.reconnectGraceMs = reconnectGraceMs;
        this.reconnectGraceMaxMs = reconnectGraceMaxMs;
        this.now = now;
    }

    begin(target) {
        if (this.target || target.peerGeneration <= this.generation) return false;
        this.target = target;
        this.transitioning = true;
        return true;
    }

    isTarget(target) {
        return this.target === target;
    }

    cancel(target) {
        if (!this.isTarget(target)) return false;
        this.target = null;
        this.transitioning = false;
        return true;
    }

    abandon(target) {
        if (!this.isTarget(target)) return false;
        this.target = null;
        this.transitioning = false;
        return true;
    }

    // `transitioning` describes the bridge topology alone: whether the primary/secondary arrangement is still
    // settling. It deliberately says nothing about extension readiness, which callers report separately as
    // `extensionConnected`. Conflating the two used to leave the flag stuck on whenever a peer reconnected to a
    // primary that had no extension attached.
    markTopologySettled() {
        this.transitioning = false;
    }

    markDisconnected() {
        this.transitioning = true;
    }

    observeHandoff({ targetInstanceId, reconnectGraceMs }) {
        this.transitioning = true;
        if (targetInstanceId !== this.instanceId) {
            // The grace arrives over the socket, so it is clamped: an unbounded value would park this
            // listener (and the tool wake-up guarded by it) arbitrarily far into the future, and an Infinity
            // smuggled through JSON parsing would turn the reconnect delay into a spin loop.
            const grace = Number(reconnectGraceMs);
            this.deferListener(grace > 0 && grace <= this.reconnectGraceMaxMs ? grace : this.reconnectGraceMs);
        }
    }

    observeCancellation() {
        this.transitioning = false;
    }

    observeTakeoverGrant(targetInstanceId) {
        if (targetInstanceId === this.instanceId) {
            this.takeoverGranted = true;
            return true;
        }
        return false;
    }

    consumeTakeoverGrant() {
        const granted = this.takeoverGranted;
        this.takeoverGranted = false;
        return granted;
    }

    deferListener(delayMs = this.reconnectGraceMs) {
        this.listenerYieldUntil = Math.max(this.listenerYieldUntil, this.now() + delayMs);
    }

    retryDelay(minimumMs = 500) {
        return Math.max(minimumMs, this.listenerYieldUntil - this.now());
    }

    resetAfterListen() {
        this.takeoverGranted = false;
        this.listenerYieldUntil = 0;
        this.target = null;
        // Owning the listener is a settled topology, so stop reporting a transition even if no extension ever attaches.
        this.transitioning = false;
    }
}
