import { randomUUID } from 'node:crypto';

import {
    ALLOWED_EXTENSION_IDS,
    BRIDGE_GENERATION,
    BRIDGE_VERSION,
    CONTROL_PROTOCOL_VERSION,
    EXTENSION_ID_OVERRIDE_ENABLED,
    EXTENSION_PROTOCOL_VERSION,
    HANDOFF_DRAIN_POLL_MS,
    HANDOFF_MAX_DRAIN_MS,
    HANDOFF_RECONNECT_GRACE_MS,
    PEER_HANDSHAKE_TIMEOUT_MS,
    PEER_RECONNECT_BASE_MS,
    PEER_RECONNECT_MAX_MS,
    PEER_WAKE_COOLDOWN_MS,
    SESSION_NONCE,
    WS_HEARTBEAT_INTERVAL_MS,
} from './config.mjs';
import { PEER_REJECTION_CODES } from './connection-state.mjs';
import { localMessage, MESSAGE_TYPES, peerStatusMessage } from './extension-vocabulary.mjs';
import { encodeFrame, parseFrames, sendWs, websocketAccept, WS_CONNECTING, WS_OPEN } from './websocket.mjs';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const isAllowedExtensionOrigin = (origin) => {
    if (!origin.startsWith('chrome-extension://')) return false;
    return ALLOWED_EXTENSION_IDS.has(origin.slice('chrome-extension://'.length));
};

export const createBridgeRuntime = ({
    host,
    port,
    extensionPath,
    peerPath,
    createHttpServer,
    createWebSocket,
    extensionProtocol,
    peerProtocol,
    handoff,
    connections,
    peerTokenSource,
    log,
    // Only a test seam: a suite cannot wait out the production deadline to prove a silent peer is abandoned.
    peerHandshakeTimeoutMs = PEER_HANDSHAKE_TIMEOUT_MS,
    inboundPeerResolutionTimeoutMs = 1000,
    inboundPeerHandshakeTimeoutMs = 5000,
}) => {
    const acceptedPeerStates = new Set();
    const connectionStates = new Set();
    // Every socket that ever completed the HTTP upgrade, tracked at the raw-socket level. Protocol state is
    // not enough for teardown: a half-open upgrade that never finished its handshake, or a socket whose close
    // frame was echoed (`destroySocket: false`) but whose remote never sends its FIN, has already left
    // connectionStates yet still blocks server.close() — and closeIdleConnections()/closeAllConnections() do
    // not touch upgraded sockets, which the HTTP server no longer tracks.
    const upgradedSockets = new Set();
    const inboundPeerAdmissions = new Map();
    let closed = false;
    // Guards a listener attempt between `listen()` and its callback or 'error' event, where `server.listening`
    // is still false. Without it two nearly simultaneous wake-ups both reach `listen()`.
    let bridgeStartPending = false;
    let peerConnectPending = false;
    let listenerState = 'pending';
    let lastBridgeStartAttemptAtMs = null;
    // Which classifications the current degraded episode has already announced. A retry is never logged on its
    // own — a process that lives for days would write a line every 30 seconds — and a code that alternates
    // between attempts cannot re-announce either, because each one is only ever recorded once. The set is
    // bounded by the closed rejection vocabulary and is emptied when the episode ends.
    const announcedDegradedCodes = new Set();

    const server = createHttpServer((request, response) => {
        if (request.url === '/health' && request.headers?.host === `${host}:${port}`) {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ ok: true, extensionConnected: connections.extensionReady }));
            return;
        }
        response.writeHead(404);
        response.end();
    });

    const currentPeerStatus = () =>
        peerStatusMessage({
            connections,
            handoff,
            bridgeGeneration: BRIDGE_GENERATION,
            bridgeVersion: BRIDGE_VERSION,
            controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
            extensionProtocolVersion: EXTENSION_PROTOCOL_VERSION,
        });

    const broadcastPeerStatus = () => {
        const message = currentPeerStatus();
        for (const state of acceptedPeerStates) {
            if (!state.peerHandshakeComplete) continue;
            try {
                sendWs(state.socket, message);
            } catch {
                acceptedPeerStates.delete(state);
            }
        }
    };

    const sendPeerControl = (state, message) => {
        try {
            sendWs(state.socket, message);
            return true;
        } catch {
            return false;
        }
    };

    let connectToPrimaryBridge;
    const relinquishBridge = (effect) => {
        handoff.deferListener();
        // Close the narrow post-drain window before clearing the socket: new work must fail retryably, not wait for its timeout.
        effect.invalidateAuthorizationWork();
        const currentExtensionSocket = connections.extensionSocket;
        connections.disconnectExtension(currentExtensionSocket);

        server.close(() => {
            // Deliberately reconnects as a peer rather than going through start(): the port was just handed to
            // the promoted instance, and re-entering the listen path would race it for the port we gave away.
            scheduleBridgeStart(250, connectToPrimaryBridge);
        });
        currentExtensionSocket?.end(encodeFrame('', 0x8));
        for (const state of [...acceptedPeerStates]) {
            state.socket.end(encodeFrame('', 0x8));
        }
        const destroyTimer = setTimeout(() => {
            // Destroy every socket that ever upgraded, not only the ones still tracked by protocol state:
            // anything less leaves server.close()'s callback waiting forever and the scheduled peer reconnect
            // below never armed — no listener, no peer, no retry.
            for (const socket of [...upgradedSockets]) {
                socket.destroy();
            }
            // close() already reaps idle keep-alive connections itself, but a socket that connected without
            // completing a request is reaped by neither it nor closeIdleConnections() — and close() also stops
            // the interval that would otherwise time its headers out. Only this ends such a socket, and until
            // it does the callback above never runs: no listener, no peer, no armed retry.
            server.closeAllConnections?.();
        }, 100);
        destroyTimer.unref?.();
    };

    const beginHandoff = async (effect) => {
        const targetState = effect.state;
        if (!handoff.begin(targetState)) return;
        const notice = {
            type: 'peer_handoff',
            controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
            targetInstanceId: targetState.peerInstanceId,
            targetGeneration: targetState.peerGeneration,
            reconnectGraceMs: HANDOFF_RECONNECT_GRACE_MS,
        };
        for (const state of acceptedPeerStates) {
            if (!state.peerHandshakeComplete) continue;
            sendPeerControl(state, notice);
        }
        log(
            `handoff requested by generation ${targetState.peerGeneration} instance ${targetState.peerInstanceId}; ` +
                `draining ${effect.activeRequestCount()} active request(s)`
        );

        const drainDeadline = connections.now() + HANDOFF_MAX_DRAIN_MS;
        while (effect.activeRequestCount() > 0 && handoff.isTarget(targetState) && !targetState.socket.destroyed) {
            if (connections.now() >= drainDeadline) {
                log(`handoff drain exceeded ${HANDOFF_MAX_DRAIN_MS} ms; invalidating active browser-job authorization work`);
                effect.invalidateAuthorizationWork();
                break;
            }
            await delay(HANDOFF_DRAIN_POLL_MS);
        }
        if (!handoff.isTarget(targetState) || targetState.socket.destroyed) {
            handoff.cancel(targetState);
            for (const state of acceptedPeerStates) {
                if (!state.peerHandshakeComplete) continue;
                sendPeerControl(state, {
                    type: 'peer_handoff_cancelled',
                    controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
                });
            }
            return;
        }

        const granted = sendPeerControl(targetState, {
            type: 'peer_takeover_granted',
            controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
            targetInstanceId: targetState.peerInstanceId,
            targetGeneration: targetState.peerGeneration,
        });
        if (!granted) {
            handoff.abandon(targetState);
            return;
        }
        log(`handoff granted to generation ${targetState.peerGeneration} instance ${targetState.peerInstanceId}`);
        await delay(HANDOFF_DRAIN_POLL_MS);
        relinquishBridge(effect);
    };

    const closeConnectionState = (state, { destroySocket = true } = {}) => {
        if (state.closed) return;
        state.closed = true;
        clearInterval(state.heartbeatTimer);
        acceptedPeerStates.delete(state);
        connectionStates.delete(state);
        if (state.path === peerPath) peerProtocol.onDisconnect(state);
        else extensionProtocol.onDisconnect(state);
        if (destroySocket) state.socket.destroy();
    };

    const releaseInboundPeerAdmission = (socket) => {
        const admission = inboundPeerAdmissions.get(socket);
        if (!admission || admission.released) return false;
        admission.released = true;
        clearTimeout(admission.resolutionTimer);
        clearTimeout(admission.handshakeTimer);
        inboundPeerAdmissions.delete(socket);
        return true;
    };

    const acquireInboundPeerAdmission = (socket) => {
        if (inboundPeerAdmissions.size >= 16) return null;
        const admission = { released: false, resolutionTimer: null, handshakeTimer: null };
        inboundPeerAdmissions.set(socket, admission);
        const cleanup = () => releaseInboundPeerAdmission(socket);
        socket.once('close', cleanup);
        socket.once('error', cleanup);
        return admission;
    };

    server.on('upgrade', async (request, socket) => {
        if (
            (request.url !== extensionPath && request.url !== peerPath) ||
            request.headers.upgrade?.toLowerCase() !== 'websocket' ||
            !request.headers['sec-websocket-key']
        ) {
            socket.destroy();
            return;
        }

        const inboundAdmission = request.url === peerPath ? acquireInboundPeerAdmission(socket) : null;
        if (request.url === peerPath && !inboundAdmission) {
            socket.destroy();
            return;
        }

        let resolvedPeerToken;
        if (request.url === peerPath && peerTokenSource) {
            inboundAdmission.resolutionTimer = setTimeout(() => {
                socket.destroy();
                releaseInboundPeerAdmission(socket);
            }, inboundPeerResolutionTimeoutMs);
            inboundAdmission.resolutionTimer.unref?.();
            const tokenResult = await peerTokenSource.resolve({ allowCreate: false });
            clearTimeout(inboundAdmission.resolutionTimer);
            inboundAdmission.resolutionTimer = null;
            if (closed || socket.destroyed || inboundAdmission.released || !tokenResult.ok) {
                socket.destroy();
                releaseInboundPeerAdmission(socket);
                return;
            }
            resolvedPeerToken = tokenResult.token;
        }

        if (closed || socket.destroyed || (inboundAdmission && inboundAdmission.released)) {
            socket.destroy();
            releaseInboundPeerAdmission(socket);
            return;
        }

        const origin =
            request.headers.origin || (EXTENSION_ID_OVERRIDE_ENABLED ? process.env.ECOMET_LOCAL_BRIDGE_TEST_ORIGIN || '' : '');
        if (
            (request.url === extensionPath && !isAllowedExtensionOrigin(origin)) ||
            (origin && !origin.startsWith('chrome-extension://'))
        ) {
            log('rejected WebSocket origin');
            socket.destroy();
            releaseInboundPeerAdmission(socket);
            return;
        }

        const accept = websocketAccept(request.headers['sec-websocket-key']);
        socket.write(
            [
                'HTTP/1.1 101 Switching Protocols',
                'Upgrade: websocket',
                'Connection: Upgrade',
                `Sec-WebSocket-Accept: ${accept}`,
                '',
                '',
            ].join('\r\n')
        );

        const protocolState =
            request.url === peerPath
                ? peerProtocol.createState(socket, { peerToken: resolvedPeerToken })
                : {
                      socket,
                      extensionHandshakeComplete: false,
                  };
        const state = Object.assign(protocolState, {
            buffer: Buffer.alloc(0),
            socket,
            path: request.url,
            origin,
            fragmentOpcode: null,
            fragments: [],
            fragmentBytes: 0,
            awaitingPong: false,
            awaitingPongResumeGraceGranted: false,
            heartbeatResumeGraceUntil: 0,
            grantHeartbeatResumeGrace: false,
            processingApplicationMessage: false,
            heartbeatTimer: null,
            closed: false,
        });
        upgradedSockets.add(socket);
        socket.on('close', () => upgradedSockets.delete(socket));
        connectionStates.add(state);
        if (request.url === peerPath) acceptedPeerStates.add(state);
        if (inboundAdmission) {
            inboundAdmission.handshakeTimer = setTimeout(() => {
                if (state.peerHandshakeComplete) return;
                closeConnectionState(state);
                releaseInboundPeerAdmission(socket);
            }, inboundPeerHandshakeTimeoutMs);
            inboundAdmission.handshakeTimer.unref?.();
        }

        if (request.url === extensionPath) {
            state.helloId = randomUUID();
            sendWs(
                socket,
                localMessage(state.helloId, MESSAGE_TYPES.hello, {
                    clientName: 'e-comet-local-bridge',
                    clientVersion: BRIDGE_VERSION,
                    protocolVersion: EXTENSION_PROTOCOL_VERSION,
                    bridgeGeneration: BRIDGE_GENERATION,
                    sessionNonce: SESSION_NONCE,
                })
            );
        }

        state.heartbeatTimer = setInterval(() => {
            if (socket.destroyed || !socket.writable) {
                closeConnectionState(state);
                return;
            }
            if (state.processingApplicationMessage || Date.now() < state.heartbeatResumeGraceUntil) return;
            if (state.awaitingPong) {
                log(`closing unresponsive WebSocket client on ${state.path}`);
                closeConnectionState(state);
                return;
            }
            state.awaitingPong = true;
            state.awaitingPongResumeGraceGranted = false;
            socket.write(encodeFrame('', 0x9));
        }, WS_HEARTBEAT_INTERVAL_MS);
        state.heartbeatTimer.unref();

        socket.on('data', (chunk) => {
            if (state.path === peerPath) {
                try {
                    parseFrames(
                        state,
                        chunk,
                        (message) => {
                            void Promise.resolve(peerProtocol.handleMessage(state, message))
                                .then((effect) => {
                                    if (state.peerHandshakeComplete) releaseInboundPeerAdmission(socket);
                                    if (effect?.type === 'handoff_requested') return beginHandoff(effect);
                                })
                                .catch((error) => log('WebSocket message handling failed:', error.message));
                        },
                        (closeFrameSent) => closeConnectionState(state, { destroySocket: !closeFrameSent })
                    );
                } catch (error) {
                    log('WebSocket protocol error:', error.message);
                    closeConnectionState(state);
                }
                return;
            }
            state.processingApplicationMessage = true;
            state.grantHeartbeatResumeGrace = state.awaitingPong && !state.awaitingPongResumeGraceGranted;
            if (state.grantHeartbeatResumeGrace) state.awaitingPongResumeGraceGranted = true;
            socket.pause?.();
            void (async () => {
                let nextChunk = chunk;
                while (!state.closed) {
                    let message;
                    try {
                        const handled = parseFrames(
                            state,
                            nextChunk,
                            (nextMessage) => {
                                message = nextMessage;
                            },
                            (closeFrameSent) => closeConnectionState(state, { destroySocket: !closeFrameSent }),
                            { maxApplicationMessages: 1 }
                        );
                        nextChunk = Buffer.alloc(0);
                        if (!handled || !message || state.closed) break;
                        const effect = await extensionProtocol.handleMessage(state, message);
                        if (effect?.type === 'handoff_requested') await beginHandoff(effect);
                    } catch (error) {
                        log('WebSocket protocol error:', error.message);
                        closeConnectionState(state);
                        break;
                    }
                }
            })().finally(() => {
                state.processingApplicationMessage = false;
                if (state.grantHeartbeatResumeGrace) {
                    state.heartbeatResumeGraceUntil = Date.now() + WS_HEARTBEAT_INTERVAL_MS;
                    state.grantHeartbeatResumeGrace = false;
                }
                if (!state.closed && !socket.destroyed) socket.resume?.();
            });
        });
        socket.on('close', () => closeConnectionState(state));
        socket.on('error', () => closeConnectionState(state));
    });

    // One spelling of "this peer socket is worth waiting on", so a change to what counts as live cannot apply to
    // some callers and not others. CONNECTING is included deliberately: an attempt already in flight must not be
    // duplicated. Compared against the transport's own constants, never the platform `WebSocket` global: the
    // socket here is a `connectWebSocket` transport, and the global only exists unflagged from Node 22.4.
    const peerSocketLive = () =>
        Boolean(connections.peerSocket) && [WS_CONNECTING, WS_OPEN].includes(connections.peerSocket.readyState);

    // Both ways out of a degraded episode end here, so the transition is announced exactly once whichever role
    // the process recovers into.
    const noteDegradedEpisodeEnded = (recovery) => {
        if (announcedDegradedCodes.size === 0) return;
        if (recovery !== 'primary' && !connections.peerReady) return;
        announcedDegradedCodes.clear();
        log(
            recovery === 'primary'
                ? 'recovered from the degraded peer state by taking over the local bridge listener'
                : 'recovered from the degraded peer state by reconnecting to the primary local bridge'
        );
    };

    // An earlier listen failure marked the process as failed. Reaching any healthy role — owning the listener
    // or completing a peer handshake — makes that verdict stale, and leaving it would make a healthy agent
    // exit non-zero on shutdown.
    const clearStaleExitVerdict = () => {
        if (process.exitCode === 1) process.exitCode = 0;
    };

    // Every way a listen attempt can fail short of EADDRINUSE ends here: the loopback port sits in an excluded
    // range (EACCES), the address is unavailable, or listen() threw synchronously on a stale handle. The retry
    // is re-armed unconditionally — without it the process would sit with no listener, no peer and no scheduled
    // retry, contradicting the invariant that reconnection never gives up — while the log line and the status
    // code follow the degraded-episode rules: announced once per episode, never once per retry.
    const onListenFailure = (error) => {
        listenerState = 'failed';
        process.exitCode = 1;
        connections.recordPeerRejection(PEER_REJECTION_CODES.listenFailed);
        if (!announcedDegradedCodes.has(PEER_REJECTION_CODES.listenFailed)) {
            announcedDegradedCodes.add(PEER_REJECTION_CODES.listenFailed);
            log(
                `degraded: cannot bind the local bridge listener on ${host}:${port} (${error.message}); ` +
                    `retrying every ${Math.round(PEER_RECONNECT_MAX_MS / 1000)}s until it can be bound`
            );
        }
        scheduleBridgeStart(PEER_RECONNECT_MAX_MS);
    };

    // Registered once rather than passed to listen(): Node registers a listen callback via once('listening'),
    // and a failed bind never removes it, so re-passing it on every retry of a now-endless schedule would
    // accumulate one callback per attempt and fire them all together when the port finally frees.
    server.on('listening', () => {
        listenerState = 'listening';
        bridgeStartPending = false;
        clearStaleExitVerdict();
        noteDegradedEpisodeEnded('primary');
        connections.resetPeerAfterListen();
        handoff.resetAfterListen();
        log(`listening on ws://${host}:${port}${extensionPath} as generation ${BRIDGE_GENERATION} version ${BRIDGE_VERSION}`);
    });

    const start = () => {
        if (closed || server.listening || bridgeStartPending) return;
        // Only an attempt that actually reaches `listen()` moves the cooldown. Stamping before the guards would
        // let no-op wake-ups push the next real attempt further away.
        lastBridgeStartAttemptAtMs = connections.now();
        bridgeStartPending = true;
        try {
            // Operational listen failures arrive through 'error'; keep this guard for synchronous argument/state errors.
            server.listen(port, host);
        } catch (error) {
            // A synchronous throw runs neither the 'listening' nor the 'error' event, so the flag has to be
            // released here too, and the retry re-armed: the timer that ran this attempt already cleared its
            // own schedule before invoking start().
            bridgeStartPending = false;
            onListenFailure(error);
        }
    };

    // The single owner of the reconnect timer: it cancels whatever was pending, publishes the retry time that
    // `local_bridge_status` reports, and clears both before handing control to the attempt.
    const scheduleBridgeStart = (delayMs, run = start) => {
        if (closed) return;
        connections.clearPeerRetrySchedule();
        // The runtime stamps the absolute time itself: `ensureBridgeConnected` compares this against its own
        // clock, and letting the two sides read different injected clocks would make the comparison meaningless.
        connections.notePeerRetryScheduled(connections.now() + delayMs);
        connections.peerReconnectTimer = setTimeout(() => {
            connections.clearPeerRetrySchedule();
            run();
        }, delayMs);
    };

    // Lets a tool call pull the next attempt forward instead of waiting out the degraded interval. Every guard
    // below exists to keep that shortcut from doing damage: it never runs beside an attempt already in flight,
    // never more often than the cooldown, never during a handoff, and never in place of a schedule that is
    // about to fire on its own.
    const ensureBridgeConnected = () => {
        if (closed || server.listening || bridgeStartPending) return;
        if (peerSocketLive()) return;
        if (lastBridgeStartAttemptAtMs !== null && connections.now() - lastBridgeStartAttemptAtMs < PEER_WAKE_COOLDOWN_MS) return;
        // A deferred listener means the port belongs to an instance being promoted. Between server.close() and
        // its callback nothing is published yet, so without this a wake-up in that window would arm a start()
        // that re-binds the port mid-handoff. The relinquish path owns the next attempt; stand down entirely.
        if (handoff.retryDelay(0) > 0) return;
        // Pull an attempt forward, never push one back, and never replace a schedule that is about to fire
        // anyway. The post-handoff peer reconnect and the takeover poll are both scheduled tighter than the
        // wake-up cooldown; taking them over would delay recovery and, worse, swap a deliberate peer reconnect
        // for a listen attempt that races the instance the port was just handed to.
        const scheduledSoonEnough =
            connections.peerNextRetryAtMs !== null && connections.peerNextRetryAtMs <= connections.now() + PEER_WAKE_COOLDOWN_MS;
        if (scheduledSoonEnough) return;
        scheduleBridgeStart(0);
    };

    connectToPrimaryBridge = async () => {
        if (closed) return;
        if (peerSocketLive()) return;
        if (peerConnectPending) return;
        peerConnectPending = true;
        let resolvedPeerToken;
        if (peerTokenSource) {
            const tokenResult = await peerTokenSource.resolve({ allowCreate: true });
            if (closed) {
                peerConnectPending = false;
                return;
            }
            if (!tokenResult.ok) {
                peerConnectPending = false;
                const rejectionCode =
                    ['permission_denied', 'insecure_permissions'].includes(tokenResult.reason)
                        ? PEER_REJECTION_CODES.tokenPermissionDenied
                        : PEER_REJECTION_CODES.tokenUnavailable;
                connections.recordPeerRejection(rejectionCode);
                const retry = connections.nextPeerReconnectDelay({ baseMs: PEER_RECONNECT_BASE_MS, maxMs: PEER_RECONNECT_MAX_MS });
                scheduleBridgeStart(retry.delayMs, connectToPrimaryBridge);
                return;
            }
            resolvedPeerToken = tokenResult.token;
        }

        const socket = createWebSocket(`ws://${host}:${port}${peerPath}`);
        const state = peerProtocol.createState(socket, { role: 'client', peerToken: resolvedPeerToken });
        peerConnectPending = false;
        connections.clearPeerAttemptVerdict();
        connections.peerSocket = socket;
        // A peer that never answers leaves this socket silent forever: no 'close' fires, so nothing schedules the
        // next attempt, and `ensureBridgeConnected` keeps seeing a live socket and stands down. That silence can
        // fall either side of the upgrade — a connect stuck in SYN_SENT, or a process that accepts the socket
        // and then stalls — so the deadline covers the whole handshake, not just the connect, and is only
        // cleared once the peer has actually completed one. Forcing the socket closed restores the normal path.
        let forcedAbandonTimer = null;
        const handshakeDeadline = setTimeout(() => {
            if (state.peerHandshakeComplete) return;
            log('peer did not complete a handshake in time; abandoning the attempt');
            socket.close();
            // The owned client transport destroys its socket after WS_CLIENT_CLOSE_GRACE_MS when the peer
            // never answers the Close frame, so the real 'close' event normally reaches disconnected() on its
            // own. This timer stays as the written-off fallback for a transport that still fails to emit one
            // (an injected test double, a future regression); a second run is already harmless because the
            // disconnect path ignores sockets that are no longer current.
            forcedAbandonTimer = setTimeout(() => disconnected(), 1000);
            forcedAbandonTimer.unref?.();
        }, peerHandshakeTimeoutMs);
        handshakeDeadline.unref?.();
        socket.addEventListener('open', () => {
            socket.send(JSON.stringify(state.outboundHello));
        });
        socket.addEventListener('message', (event) => {
            void Promise.resolve(peerProtocol.handleMessage(state, event.data))
                .then(() => {
                    if (state.peerHandshakeComplete) {
                        clearTimeout(handshakeDeadline);
                        clearStaleExitVerdict();
                    }
                    // Readiness is only ever reached by handling a peer_welcome or peer_status frame, so this is
                    // the moment a degraded episode ends by reconnecting rather than by taking over the listener.
                    // Closing it here, not lazily at the next disconnect, keeps one source of truth for it.
                    noteDegradedEpisodeEnded('peer');
                })
                .catch((error) => log('peer protocol handling failed:', error.message));
        });
        const disconnected = () => {
            clearTimeout(handshakeDeadline);
            clearTimeout(forcedAbandonTimer);
            const result = peerProtocol.onDisconnect(state);
            if (!result.disconnected || closed) return;
            const reconnectDelay = result.shouldTakeover
                ? HANDOFF_DRAIN_POLL_MS
                : Math.max(result.reconnectDelay, handoff.retryDelay());
            // `rejectionCode` is the verdict this close reached, not the current value of a field that
            // outlives the attempt: a saturated backoff reached through closes the disconnect path declined
            // to classify carries no code, and announcing one would name a failure that did not happen.
            if (
                !result.shouldTakeover &&
                result.saturated &&
                result.rejectionCode !== null &&
                !announcedDegradedCodes.has(result.rejectionCode)
            ) {
                announcedDegradedCodes.add(result.rejectionCode);
                log(
                    `degraded: no usable primary local bridge (${result.rejectionCode}); ` +
                        `retrying every ${Math.round(reconnectDelay / 1000)}s until it returns`
                );
            }
            scheduleBridgeStart(reconnectDelay);
        };
        socket.addEventListener('close', disconnected, { once: true });
        socket.addEventListener('error', () => socket.close(), { once: true });
    };

    server.on('error', (error) => {
        // 'error' also fires for handle-level failures after the port is bound. Those are not listen attempts:
        // treating one as such would cancel the single-flight guard for a listen genuinely in flight and pin a
        // permanent rejection on a primary that is serving traffic, since nothing a still-listening process does
        // will clear it.
        if (server.listening) {
            log(`local bridge listener error while serving ${host}:${port}:`, error.message);
            return;
        }
        // Released before the EADDRINUSE branch returns: that is the common path here, and a flag left set there
        // would make every later ensureBridgeConnected() a silent no-op.
        bridgeStartPending = false;
        if (error.code === 'EADDRINUSE') {
            listenerState = 'address_in_use';
            if (connections.peerReconnectBackoffStep === 0) {
                log(`local bridge already exists at ${host}:${port}; using it as the primary instance`);
            }
            connectToPrimaryBridge();
            return;
        }
        // Not a contended port but a refused one — an excluded loopback range, for instance.
        onListenFailure(error);
    });

    const close = () => {
        if (closed) return;
        closed = true;
        bridgeStartPending = false;
        connections.clearPeerRetrySchedule();
        connections.clearPeerAttemptVerdict();
        connections.close?.();
        connections.peerSocket?.close();
        for (const state of [...connectionStates]) {
            closeConnectionState(state);
        }
        for (const [socket] of [...inboundPeerAdmissions]) {
            socket.destroy();
            releaseInboundPeerAdmission(socket);
        }
        // Sockets that already left connectionStates without being destroyed (the echoed-close-frame path)
        // would otherwise keep the process alive after shutdown.
        for (const socket of [...upgradedSockets]) {
            socket.destroy();
        }
        if (server.listening) server.close();
        // The half-open case the loop above cannot see: a socket that connected and never completed a request
        // is tracked by neither connectionStates nor upgradedSockets, and close() does not reap it (nor does
        // closeIdleConnections, which only covers finished keep-alive connections). Left alive it holds the
        // event loop open and pushes a clean shutdown onto server.mjs's hard-exit backstop, which abandons
        // whatever is still buffered — including a result file mid-write. Called unconditionally: connections
        // outlive the listener, so a process that already relinquished the port can still be holding one.
        server.closeAllConnections?.();
    };

    const status = () => {
        const peerRejection = connections.peerRejectionStatus();
        return {
            extensionConnected: connections.effectiveExtensionReady,
            browserJobSupported: connections.effectiveBrowserJobReady,
            bridgeRole: server.listening ? 'primary' : connections.peerReady ? 'secondary' : 'disconnected',
            bridgeTransitioning: handoff.transitioning,
            listenerState,
            browserContext: connections.effectiveBrowserContext,
            extensionLastConnectedAtMs: connections.effectiveExtensionLastConnectedAtMs,
            extensionLastDisconnectedAtMs: connections.effectiveExtensionLastDisconnectedAtMs,
            extensionVersion: connections.effectiveExtensionVersion,
            ...(connections.peerReady && connections.authenticatedPrimaryMetadata
                ? { peer: connections.authenticatedPrimaryMetadata }
                : {}),
            ...(peerRejection === undefined ? {} : { peerRejection }),
        };
    };
    status.broadcast = broadcastPeerStatus;

    return { start, close, status, ensureBridgeConnected };
};
