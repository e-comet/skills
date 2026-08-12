// Peer failures are reported to the agent, so the vocabulary is a closed set owned by this process. A reason
// string received from the other side of the socket is never surfaced: anything listening on loopback could
// otherwise write arbitrary text into a tool result and from there into the model's context.
/**
 * The whole vocabulary, so a caller cannot be narrowed to whichever code happens to be a default.
 * @typedef {'authentication_failed' | 'protocol_mismatch' | 'handshake_required' | 'connection_failed' | 'listen_failed' | 'token_permission_denied' | 'token_unavailable'} PeerRejectionCode
 */
export const PEER_REJECTION_CODES = Object.freeze({
    authenticationFailed: 'authentication_failed',
    protocolMismatch: 'protocol_mismatch',
    handshakeRequired: 'handshake_required',
    connectionFailed: 'connection_failed',
    // This process could not bind the listener at all — no peer was ever contacted. Reporting it through
    // `connection_failed` would send the reader to investigate a primary that was never reached.
    listenFailed: 'listen_failed',
    tokenPermissionDenied: 'token_permission_denied',
    tokenUnavailable: 'token_unavailable',
});

export class ConnectionState {
    #extensionReadyWaiters = new Set();
    #closed = false;
    #now;

    extensionSocket = null;
    extensionReady = false;
    extensionBrowserJobReady = false;
    peerSocket = null;
    peerReady = false;
    peerExtensionReady = false;
    peerExtensionBrowserJobReady = false;
    peerBrowserContext = { state: 'unknown' };
    peerExtensionLastConnectedAtMs = null;
    peerExtensionLastDisconnectedAtMs = null;
    peerExtensionVersion = undefined;
    authenticatedPrimaryMetadata = undefined;
    peerReconnectTimer = null;
    peerReconnectBackoffStep = 0;
    // Classification of the attempt currently in flight. Cleared when an attempt ends, so a socket that closes
    // after a protocol-level rejection cannot overwrite the more specific code with a generic one.
    peerAttemptRejectionCode = null;
    // Last classified failure of the current uninterrupted streak, and when that streak began.
    peerRejectionCode = null;
    peerFailureSinceMs = null;
    peerNextRetryAtMs = null;
    extensionLastConnectedAtMs = null;
    extensionLastDisconnectedAtMs = null;
    extensionVersion = undefined;
    browserContext = { state: 'unknown' };

    constructor({ now = Date.now } = {}) {
        this.#now = now;
    }

    // The one clock for everything that ends up compared or reported together. The bridge runtime reads it
    // through here rather than taking its own injection, so `since` and `retryAt` cannot come from two epochs.
    now() {
        return this.#now();
    }

    get effectiveExtensionReady() {
        return this.extensionReady || (this.peerReady && this.peerExtensionReady);
    }

    get effectiveBrowserJobReady() {
        return this.extensionBrowserJobReady || (this.peerReady && this.peerExtensionBrowserJobReady);
    }

    get effectiveBrowserContext() {
        return this.extensionReady ? this.browserContext : this.peerReady ? this.peerBrowserContext : { state: 'unknown' };
    }

    get effectiveExtensionLastConnectedAtMs() {
        return this.extensionReady ? this.extensionLastConnectedAtMs : this.peerReady ? this.peerExtensionLastConnectedAtMs : this.extensionLastConnectedAtMs;
    }

    get effectiveExtensionLastDisconnectedAtMs() {
        return this.extensionReady ? this.extensionLastDisconnectedAtMs : this.peerReady ? this.peerExtensionLastDisconnectedAtMs : this.extensionLastDisconnectedAtMs;
    }

    get effectiveExtensionVersion() {
        return this.extensionReady ? this.extensionVersion : this.peerReady ? this.peerExtensionVersion : this.extensionVersion;
    }

    connectExtension(socket, options) {
        const browserJobSupported = typeof options === 'boolean' ? options : options.browserJobSupported;
        const previousSocket = this.extensionSocket;
        if (previousSocket !== socket) this.browserContext = { state: 'unknown' };
        this.extensionSocket = socket;
        this.extensionReady = true;
        this.extensionBrowserJobReady = browserJobSupported;
        this.extensionVersion = typeof options === 'object' ? options.version : undefined;
        this.extensionLastConnectedAtMs = this.#now();
        this.#resolveExtensionReadyWaiters();
        return previousSocket && previousSocket !== socket ? previousSocket : null;
    }

    disconnectExtension(socket) {
        if (this.extensionSocket !== socket) return false;
        this.extensionSocket = null;
        this.extensionReady = false;
        this.extensionBrowserJobReady = false;
        this.extensionLastDisconnectedAtMs = this.#now();
        this.browserContext = { state: 'unknown' };
        return true;
    }

    updateBrowserContext(socket, context) {
        if (socket !== this.extensionSocket) return false;
        const previous = this.browserContext;
        if (previous.state === 'known' && previous.wbTabConnected === context.wbTabConnected && previous.sellerTabConnected === context.sellerTabConnected) return false;
        this.browserContext = { state: 'known', ...context, changedAt: new Date(this.#now()).toISOString() };
        return true;
    }

    // Returns null for a frame from a socket that is no longer the peer socket. The old client socket's
    // message listener is never detached, so frames queued before its close completes still arrive; without
    // the identity check (which `disconnectPeer` already has) a late frame would republish readiness for a
    // socket that no longer exists and silently cancel a retry that was just armed.
    updatePeerStatus(message, socket, authenticatedPrimary = {}) {
        if (socket !== undefined && socket !== this.peerSocket) return null;
        const { extensionConnected, browserJobSupported } = message;
        const wasReady = this.peerReady;
        this.resetPeerReconnect();
        this.peerReady = true;
        this.peerExtensionReady = extensionConnected === true;
        this.peerExtensionBrowserJobReady = browserJobSupported === true;
        this.peerBrowserContext = message.browserContext?.state === 'known' ? { ...message.browserContext } : { state: 'unknown' };
        this.peerExtensionLastConnectedAtMs = Number.isFinite(message.extensionLastConnectedAtMs) ? message.extensionLastConnectedAtMs : null;
        this.peerExtensionLastDisconnectedAtMs = Number.isFinite(message.extensionLastDisconnectedAtMs) ? message.extensionLastDisconnectedAtMs : null;
        this.peerExtensionVersion = typeof message.extensionVersion === 'string' ? message.extensionVersion : undefined;
        this.authenticatedPrimaryMetadata = {
            ...(typeof authenticatedPrimary.authenticatedPrimaryBridgeVersion === 'string'
                ? { bridgeVersion: authenticatedPrimary.authenticatedPrimaryBridgeVersion }
                : {}),
            browserContextPropagationSupported: authenticatedPrimary.browserContextPropagationSupported === true,
        };
        this.#resolveExtensionReadyWaiters();
        return wasReady;
    }

    waitForExtensionReady(timeoutMs) {
        if (this.#closed) return Promise.resolve(false);
        if (this.effectiveExtensionReady) return Promise.resolve(true);
        return new Promise((resolve) => {
            const waiter = (ready) => {
                clearTimeout(waiter.timer);
                this.#extensionReadyWaiters.delete(waiter);
                resolve(ready);
            };
            waiter.timer = setTimeout(() => waiter(false), timeoutMs);
            this.#extensionReadyWaiters.add(waiter);
            if (this.effectiveExtensionReady) waiter(true);
        });
    }

    close() {
        if (this.#closed) return;
        this.#closed = true;
        for (const waiter of [...this.#extensionReadyWaiters]) waiter(false);
    }

    #resolveExtensionReadyWaiters() {
        if (!this.effectiveExtensionReady) return;
        for (const waiter of [...this.#extensionReadyWaiters]) waiter(true);
    }

    disconnectPeer(socket) {
        if (this.peerSocket !== socket) return false;
        this.peerSocket = null;
        this.peerReady = false;
        this.peerExtensionReady = false;
        this.peerExtensionBrowserJobReady = false;
        this.peerBrowserContext = { state: 'unknown' };
        this.authenticatedPrimaryMetadata = undefined;
        return true;
    }

    resetPeerAfterListen() {
        this.peerSocket?.close();
        this.peerSocket = null;
        this.peerReady = false;
        this.peerExtensionReady = false;
        this.peerExtensionBrowserJobReady = false;
        this.peerBrowserContext = { state: 'unknown' };
        this.authenticatedPrimaryMetadata = undefined;
        this.resetPeerReconnect();
    }

    clearPeerAttemptVerdict() {
        this.peerAttemptRejectionCode = null;
    }

    // A protocol-level verdict: always authoritative for the attempt in flight.
    recordPeerRejection(code) {
        const rejectionCode = Object.values(PEER_REJECTION_CODES).includes(code) ? code : PEER_REJECTION_CODES.connectionFailed;
        this.peerAttemptRejectionCode = rejectionCode;
        this.peerRejectionCode = rejectionCode;
        this.peerFailureSinceMs ??= this.#now();
    }

    // A socket that closed without telling us why. Never downgrades a verdict already reached for this attempt.
    classifyPeerCloseFailure() {
        if (this.peerAttemptRejectionCode !== null) return;
        this.recordPeerRejection(PEER_REJECTION_CODES.connectionFailed);
    }

    // Saturation is a property of the delay, not of an attempt count: once the curve reaches its ceiling the
    // secondary is degraded and stays there, retrying at that cadence until it reconnects or becomes primary.
    nextPeerReconnectDelay({ baseMs, maxMs }) {
        const delayMs = Math.min(maxMs, baseMs * 2 ** this.peerReconnectBackoffStep);
        const saturated = delayMs >= maxMs;
        if (!saturated) this.peerReconnectBackoffStep += 1;
        return { delayMs, saturated };
    }

    // Takes an absolute time rather than a delay: the runtime that schedules the timer owns the clock this is
    // later compared against, so the value must not be stamped from a second, independently injectable one.
    notePeerRetryScheduled(retryAtMs) {
        this.peerNextRetryAtMs = retryAtMs;
    }

    clearPeerRetrySchedule() {
        clearTimeout(this.peerReconnectTimer);
        this.peerReconnectTimer = null;
        this.peerNextRetryAtMs = null;
    }

    // Absent while the bridge is healthy: a null-filled object in every status would be noise in the agent's context.
    peerRejectionStatus() {
        if (this.peerRejectionCode === null || this.peerFailureSinceMs === null) return undefined;
        // This feeds the one tool an operator uses to diagnose a wedged bridge, so it must report the failure
        // rather than become one: a millisecond value outside the Date range would make toISOString() throw
        // on every status call. Such a timestamp is omitted, never thrown on.
        const isoTime = (ms) => (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : undefined);
        const since = isoTime(this.peerFailureSinceMs);
        const retryAt = this.peerNextRetryAtMs === null ? undefined : isoTime(this.peerNextRetryAtMs);
        return {
            code: this.peerRejectionCode,
            ...(since === undefined ? {} : { since }),
            ...(retryAt === undefined ? {} : { retryAt }),
        };
    }

    resetPeerReconnect() {
        this.clearPeerRetrySchedule();
        this.peerReconnectBackoffStep = 0;
        this.peerAttemptRejectionCode = null;
        this.peerRejectionCode = null;
        this.peerFailureSinceMs = null;
    }
}
