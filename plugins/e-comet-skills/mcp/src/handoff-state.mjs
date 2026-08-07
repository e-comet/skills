export class HandoffState {
    target = null;
    transitioning = false;
    takeoverGranted = false;
    listenerYieldUntil = 0;

    constructor({ generation, instanceId, reconnectGraceMs, now = Date.now }) {
        this.generation = generation;
        this.instanceId = instanceId;
        this.reconnectGraceMs = reconnectGraceMs;
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

    markRoutable(routable) {
        if (routable) this.transitioning = false;
    }

    markDisconnected() {
        this.transitioning = true;
    }

    observeHandoff({ targetInstanceId, reconnectGraceMs }) {
        this.transitioning = true;
        if (targetInstanceId !== this.instanceId) {
            this.deferListener(Number(reconnectGraceMs) || this.reconnectGraceMs);
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
    }
}
