import { createHash, randomUUID } from 'node:crypto';

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
    PEER_RECONNECT_MAX_ATTEMPTS,
    SESSION_NONCE,
    WS_HEARTBEAT_INTERVAL_MS,
} from './config.mjs';
import { localMessage, MESSAGE_TYPES, peerStatusMessage } from './extension-vocabulary.mjs';
import { encodeFrame, parseFrames, sendWs } from './websocket.mjs';

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
    log,
}) => {
    const acceptedPeerStates = new Set();
    const connectionStates = new Set();
    let closed = false;

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
            if (closed) return;
            clearTimeout(connections.peerReconnectTimer);
            connections.peerReconnectTimer = setTimeout(connectToPrimaryBridge, 250);
        });

        currentExtensionSocket?.end(encodeFrame('', 0x8));
        for (const state of [...acceptedPeerStates]) {
            state.socket.end(encodeFrame('', 0x8));
        }
        const destroyTimer = setTimeout(() => {
            currentExtensionSocket?.destroy();
            for (const state of [...acceptedPeerStates]) {
                state.socket.destroy();
            }
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

        const drainDeadline = Date.now() + HANDOFF_MAX_DRAIN_MS;
        while (effect.activeRequestCount() > 0 && handoff.isTarget(targetState) && !targetState.socket.destroyed) {
            if (Date.now() >= drainDeadline) {
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

    server.on('upgrade', (request, socket) => {
        if (
            (request.url !== extensionPath && request.url !== peerPath) ||
            request.headers.upgrade?.toLowerCase() !== 'websocket' ||
            !request.headers['sec-websocket-key']
        ) {
            socket.destroy();
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
            return;
        }

        const accept = createHash('sha1')
            .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest('base64');
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
                ? peerProtocol.createState(socket)
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
            heartbeatTimer: null,
            closed: false,
        });
        connectionStates.add(state);
        if (request.url === peerPath) acceptedPeerStates.add(state);

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
            if (state.awaitingPong) {
                log(`closing unresponsive WebSocket client on ${state.path}`);
                closeConnectionState(state);
                return;
            }
            state.awaitingPong = true;
            socket.write(encodeFrame('', 0x9));
        }, WS_HEARTBEAT_INTERVAL_MS);
        state.heartbeatTimer.unref();

        socket.on('data', (chunk) => {
            try {
                parseFrames(
                    state,
                    chunk,
                    (message) => {
                        const operation =
                            state.path === peerPath
                                ? peerProtocol.handleMessage(state, message)
                                : extensionProtocol.handleMessage(state, message);
                        void Promise.resolve(operation)
                            .then((effect) => {
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
        });
        socket.on('close', () => closeConnectionState(state));
        socket.on('error', () => closeConnectionState(state));
    });

    const start = () => {
        if (closed || server.listening) return;
        try {
            // Operational listen failures arrive through 'error'; keep this guard for synchronous argument/state errors.
            server.listen(port, host, () => {
                connections.resetPeerAfterListen();
                handoff.resetAfterListen();
                log(`listening on ws://${host}:${port}${extensionPath} as generation ${BRIDGE_GENERATION} version ${BRIDGE_VERSION}`);
            });
        } catch (error) {
            log('failed to start local bridge listener:', error.message);
        }
    };

    connectToPrimaryBridge = () => {
        if (closed) return;
        if (connections.peerSocket && [0, 1].includes(connections.peerSocket.readyState)) return;

        const socket = createWebSocket(`ws://${host}:${port}${peerPath}`);
        const state = peerProtocol.createState(socket, { role: 'client' });
        connections.peerSocket = socket;
        socket.addEventListener('open', () => {
            socket.send(JSON.stringify(state.outboundHello));
        });
        socket.addEventListener('message', (event) => {
            void Promise.resolve(peerProtocol.handleMessage(state, event.data)).catch((error) =>
                log('peer protocol handling failed:', error.message)
            );
        });
        const disconnected = () => {
            const result = peerProtocol.onDisconnect(state);
            if (!result.disconnected || closed) return;
            if (!result.shouldTakeover && result.reconnectDelay === null) {
                log(
                    `stopped reconnecting to the primary local bridge after ${PEER_RECONNECT_MAX_ATTEMPTS} attempts: ${
                        connections.peerRejectionReason || 'connection failed'
                    }`
                );
                return;
            }
            const reconnectDelay = result.shouldTakeover
                ? HANDOFF_DRAIN_POLL_MS
                : Math.max(result.reconnectDelay, handoff.retryDelay());
            connections.peerReconnectTimer = setTimeout(start, reconnectDelay);
        };
        socket.addEventListener('close', disconnected, { once: true });
        socket.addEventListener('error', () => socket.close(), { once: true });
    };

    server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
            if (connections.peerReconnectAttempts === 0) {
                log(`local bridge already exists at ${host}:${port}; using it as the primary instance`);
            }
            connectToPrimaryBridge();
            return;
        }
        log(`failed to listen on ${host}:${port}:`, error.message);
        process.exitCode = 1;
    });

    const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(connections.peerReconnectTimer);
        connections.close?.();
        connections.peerSocket?.close();
        for (const state of [...connectionStates]) {
            closeConnectionState(state);
        }
        if (server.listening) server.close();
    };

    const status = () => ({
        extensionConnected: connections.effectiveExtensionReady,
        browserJobSupported: connections.effectiveBrowserJobReady,
        bridgeRole: server.listening ? 'primary' : connections.peerReady ? 'secondary' : 'disconnected',
        bridgeTransitioning: handoff.transitioning,
    });
    status.broadcast = broadcastPeerStatus;

    return { start, close, status };
};
