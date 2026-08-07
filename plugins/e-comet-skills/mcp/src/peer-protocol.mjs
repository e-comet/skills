import {
    BRIDGE_VERSION,
    CONTROL_PROTOCOL_VERSION,
    EXTENSION_PROTOCOL_VERSION,
    MAX_BROWSER_JOB_TOKEN_BYTES,
    PEER_RECONNECT_BASE_MS,
    PEER_RECONNECT_MAX_ATTEMPTS,
    PEER_RECONNECT_MAX_MS,
} from './config.mjs';
import { createPeerAuthNonce, createPeerAuthProof, isValidPeerAuthNonce, peerTokensEqual } from './peer-auth.mjs';
import { peerStatusMessage } from './extension-vocabulary.mjs';
import { safeExternalToolError, ToolExecutionError, toolFailure } from './tool-errors.mjs';
import { encodeFrame } from './websocket.mjs';
import { validTimeout } from './wb-domain.mjs';

const isValidPeerIdentity = (message) =>
    message?.controlProtocolVersion === CONTROL_PROTOCOL_VERSION &&
    Number.isInteger(message.bridgeGeneration) &&
    message.bridgeGeneration >= 1 &&
    typeof message.bridgeVersion === 'string' &&
    message.bridgeVersion.length > 0 &&
    typeof message.instanceId === 'string' &&
    message.instanceId.length > 0;

const peerAuthTranscript = (client, primary) =>
    JSON.stringify([
        CONTROL_PROTOCOL_VERSION,
        client.clientNonce,
        primary.serverNonce,
        client.bridgeGeneration,
        client.bridgeVersion,
        client.instanceId,
        primary.bridgeGeneration,
        primary.bridgeVersion,
        primary.instanceId,
    ]);

export const createPeerProtocol = ({
    connections,
    requestBroker,
    handoff,
    peerToken,
    send,
    log,
    broadcastStatus,
}) => {
    const currentPeerStatus = () =>
        peerStatusMessage({
            connections,
            handoff,
            bridgeGeneration: handoff.generation,
            bridgeVersion: BRIDGE_VERSION,
            controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
            extensionProtocolVersion: EXTENSION_PROTOCOL_VERSION,
        });

    const closeState = (state) => {
        if (state.role === 'client') {
            state.socket.close();
        } else {
            state.socket.end(encodeFrame('', 0x8));
        }
    };

    const createState = (socket, { role = 'server' } = {}) => ({
        socket,
        role,
        peerHandshakeComplete: false,
        primaryProofVerified: false,
        authenticatedPrimary: null,
        pendingPeerAuth: null,
        peerGeneration: null,
        peerInstanceId: null,
        // The secondary reuses its authorize requestId as authorizationScopeId on every scoped fetch.
        authorizationLeases: new Map(),
        outboundHello:
            role === 'client'
                ? {
                      type: 'peer_auth_init',
                      controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
                      bridgeGeneration: handoff.generation,
                      bridgeVersion: BRIDGE_VERSION,
                      instanceId: handoff.instanceId,
                      clientNonce: createPeerAuthNonce(),
                  }
                : undefined,
    });

    const rejectUnauthenticated = (state, reason) => {
        send(state.socket, {
            type: 'peer_rejected',
            reason,
            controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
        });
        closeState(state);
    };

    const rejectUntrustedPrimary = (state, reason = 'Primary peer authentication failed') => {
        connections.recordPeerRejection(reason);
        closeState(state);
    };

    const completeServerHandshake = (state, peerIdentity) => {
        state.peerGeneration = peerIdentity.bridgeGeneration;
        state.peerInstanceId = peerIdentity.instanceId;
        state.peerHandshakeComplete = true;
        state.pendingPeerAuth = null;
        send(state.socket, {
            type: 'peer_welcome',
            extensionConnected: connections.extensionReady,
            browserJobSupported: connections.extensionBrowserJobReady,
            controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
            extensionProtocolVersion: EXTENSION_PROTOCOL_VERSION,
            bridgeGeneration: handoff.generation,
            bridgeVersion: BRIDGE_VERSION,
            instanceId: handoff.instanceId,
            handoffSupported: true,
        });
        return state.peerGeneration > handoff.generation
            ? {
                  type: 'handoff_requested',
                  state,
                  activeRequestCount: () => requestBroker.activeRequestCount,
                  invalidateAuthorizationWork: () => requestBroker.invalidateAuthorizationWork(),
              }
            : undefined;
    };

    const handlePeerClientMessage = async (state, message) => {
        if (message?.type === 'peer_rejected') {
            connections.recordPeerRejection(message.reason);
            closeState(state);
            return;
        }
        if (message?.type === 'peer_auth_challenge') {
            const client = state.outboundHello;
            const validChallenge =
                !state.peerHandshakeComplete &&
                !state.primaryProofVerified &&
                isValidPeerIdentity(message) &&
                isValidPeerAuthNonce(client?.clientNonce) &&
                message.clientNonce === client.clientNonce &&
                isValidPeerAuthNonce(message.serverNonce) &&
                typeof message.serverProof === 'string';
            if (!validChallenge) {
                rejectUntrustedPrimary(state);
                return;
            }
            const primary = {
                bridgeGeneration: message.bridgeGeneration,
                bridgeVersion: message.bridgeVersion,
                instanceId: message.instanceId,
                serverNonce: message.serverNonce,
            };
            const transcript = peerAuthTranscript(client, primary);
            const expectedProof = createPeerAuthProof(peerToken, 'primary', transcript);
            if (!peerTokensEqual(message.serverProof, expectedProof)) {
                rejectUntrustedPrimary(state);
                return;
            }
            state.primaryProofVerified = true;
            state.authenticatedPrimary = primary;
            state.socket.send(
                JSON.stringify({
                    type: 'peer_auth_response',
                    controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
                    clientProof: createPeerAuthProof(peerToken, 'client', transcript),
                })
            );
            return;
        }
        if (message?.type === 'peer_welcome') {
            const authenticatedPrimary = state.authenticatedPrimary;
            if (
                state.peerHandshakeComplete ||
                !state.primaryProofVerified ||
                message.controlProtocolVersion !== CONTROL_PROTOCOL_VERSION ||
                message.bridgeGeneration !== authenticatedPrimary?.bridgeGeneration ||
                message.bridgeVersion !== authenticatedPrimary.bridgeVersion ||
                message.instanceId !== authenticatedPrimary.instanceId
            ) {
                rejectUntrustedPrimary(state);
                return;
            }
            state.peerHandshakeComplete = true;
            const wasReady = connections.updatePeerStatus(message);
            handoff.markRoutable(connections.effectiveExtensionReady);
            if (!wasReady) {
                log(
                    `connected to primary local bridge generation ${message.bridgeGeneration} version ${
                        message.bridgeVersion || 'unknown'
                    }`
                );
            }
            return;
        }
        if (!state.peerHandshakeComplete) {
            connections.recordPeerRejection('Peer handshake is required');
            closeState(state);
            return;
        }
        if (message?.type === 'peer_handoff') {
            handoff.observeHandoff(message);
            return;
        }
        if (message?.type === 'peer_handoff_cancelled') {
            handoff.observeCancellation();
            return;
        }
        if (message?.type === 'peer_takeover_granted') {
            handoff.observeTakeoverGrant(message.targetInstanceId);
            return;
        }
        if (message?.type === 'peer_status') {
            const wasReady = connections.updatePeerStatus(message);
            handoff.markRoutable(connections.effectiveExtensionReady);
            if (!wasReady) {
                const versionLabel = message.controlProtocolVersion ? `generation ${message.bridgeGeneration}` : 'legacy generation';
                log(`connected to primary local bridge ${versionLabel}`);
            }
            return;
        }
        if (message?.type === 'peer_browser_job_authorize_result' && typeof message.requestId === 'string') {
            if (message.error) requestBroker.rejectAuthorization(message.requestId, safeExternalToolError(message.error));
            else if (!requestBroker.resolveAuthorization(message.requestId, message.authorization)) {
                try {
                    state.socket.send(
                        JSON.stringify({
                            type: 'peer_browser_job_authorization_release',
                            authorizationScopeId: message.requestId,
                        })
                    );
                } catch (error) {
                    log('failed to release late peer browser-job authorization:', error.message);
                }
            }
            return;
        }
        if (message?.type !== 'peer_wb_fetch_result' || typeof message.requestId !== 'string') return;
        if (message.error) {
            // Голая строка без toolError нормализовалась в stage 'authorization' и через
            // rethrowAuthorizationError обрывала всё задание, требуя нового JWT. Отказ
            // обслуживающего процесса — это провал одной единицы исполнения.
            const peerError =
                message.toolError ??
                { code: 'PEER_REQUEST_REJECTED', message: String(message.error), stage: 'execution', retryable: false };
            requestBroker.rejectFetch(message.requestId, safeExternalToolError(peerError, 'Wildberries request failed.'));
        } else {
            requestBroker.resolveFetch(message.requestId, message.response);
        }
    };

    const handlePeerServerMessage = async (state, message) => {
        if (message?.type === 'peer_auth_init') {
            if (
                state.peerHandshakeComplete ||
                state.pendingPeerAuth ||
                !isValidPeerIdentity(message) ||
                !isValidPeerAuthNonce(message.clientNonce)
            ) {
                rejectUnauthenticated(state, 'Peer authentication failed');
                return;
            }
            const client = {
                bridgeGeneration: message.bridgeGeneration,
                bridgeVersion: message.bridgeVersion,
                instanceId: message.instanceId,
                clientNonce: message.clientNonce,
            };
            const primary = {
                bridgeGeneration: handoff.generation,
                bridgeVersion: BRIDGE_VERSION,
                instanceId: handoff.instanceId,
                serverNonce: createPeerAuthNonce(),
            };
            const transcript = peerAuthTranscript(client, primary);
            state.pendingPeerAuth = { client, transcript };
            send(state.socket, {
                type: 'peer_auth_challenge',
                controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
                bridgeGeneration: primary.bridgeGeneration,
                bridgeVersion: primary.bridgeVersion,
                instanceId: primary.instanceId,
                clientNonce: client.clientNonce,
                serverNonce: primary.serverNonce,
                serverProof: createPeerAuthProof(peerToken, 'primary', transcript),
            });
            return;
        }
        if (message?.type === 'peer_auth_response') {
            const pending = state.pendingPeerAuth;
            if (
                state.peerHandshakeComplete ||
                !pending ||
                message.controlProtocolVersion !== CONTROL_PROTOCOL_VERSION ||
                typeof message.clientProof !== 'string' ||
                !peerTokensEqual(message.clientProof, createPeerAuthProof(peerToken, 'client', pending.transcript))
            ) {
                rejectUnauthenticated(state, 'Peer authentication failed');
                return;
            }
            return completeServerHandshake(state, pending.client);
        }
        if (!state.peerHandshakeComplete) {
            rejectUnauthenticated(state, 'Peer handshake is required');
            return;
        }
        if (message?.type === 'peer_status_request') {
            send(state.socket, currentPeerStatus());
            return;
        }
        if (
            message?.type === 'peer_browser_job_authorization_release' &&
            typeof message.authorizationScopeId === 'string'
        ) {
            const authorizationLease = state.authorizationLeases.get(message.authorizationScopeId);
            if (authorizationLease) {
                state.authorizationLeases.delete(message.authorizationScopeId);
                authorizationLease.release();
            }
            return;
        }
        if (
            message?.type === 'peer_browser_job_authorize' &&
            typeof message.requestId === 'string' &&
            typeof message.token === 'string' &&
            message.token.length > 0 &&
            Buffer.byteLength(message.token, 'utf8') <= MAX_BROWSER_JOB_TOKEN_BYTES
        ) {
            try {
                for (const [authorizationScopeId, authorizationLease] of state.authorizationLeases) {
                    if (authorizationLease.isActive()) continue;
                    state.authorizationLeases.delete(authorizationScopeId);
                }
                if (state.authorizationLeases.has(message.requestId)) {
                    throw new Error('Duplicate peer browser-job authorization request');
                }
                const authorizationLease = await requestBroker.requestAuthorization(message.token);
                state.authorizationLeases.set(message.requestId, authorizationLease);
                try {
                    send(state.socket, {
                        type: 'peer_browser_job_authorize_result',
                        requestId: message.requestId,
                        authorization: authorizationLease.authorization,
                    });
                } catch (error) {
                    state.authorizationLeases.delete(message.requestId);
                    authorizationLease.release();
                    throw error;
                }
            } catch (error) {
                send(state.socket, {
                    type: 'peer_browser_job_authorize_result',
                    requestId: message.requestId,
                    error: toolFailure(error, {
                        code: 'BROWSER_JOB_AUTHORIZATION_FAILED',
                        message: 'Browser job authorization failed.',
                        stage: 'authorization',
                        retryable: false,
                    }),
                });
            }
            return;
        }
        if (
            message?.type !== 'peer_wb_fetch' ||
            typeof message.requestId !== 'string' ||
            typeof message.authorizationScopeId !== 'string' ||
            typeof message.url !== 'string' ||
            typeof message.authorizationId !== 'string' ||
            message.authorizationId.length === 0 ||
            !validTimeout(message.timeout)
        ) {
            send(state.socket, {
                type: 'peer_wb_fetch_result',
                requestId: message?.requestId,
                error: 'Invalid peer request',
            });
            return;
        }

        try {
            const authorizationLease = state.authorizationLeases.get(message.authorizationScopeId);
            if (!authorizationLease || authorizationLease.authorization?.authorizationId !== message.authorizationId) {
                throw new ToolExecutionError(
                    'BROWSER_JOB_REAUTHORIZATION_REQUIRED',
                    'Browser job authorization must be acquired again after the bridge connection changed.',
                    'authorization',
                    true
                );
            }
            const response = await authorizationLease.requestWbFetch(message.url, message.timeout);
            send(state.socket, {
                type: 'peer_wb_fetch_result',
                requestId: message.requestId,
                response,
            });
        } catch (error) {
            send(state.socket, {
                type: 'peer_wb_fetch_result',
                requestId: message.requestId,
                error: error.message,
                toolError: toolFailure(error, {
                    code: 'WB_FETCH_FAILED',
                    message: 'Wildberries request failed.',
                    stage: 'execution',
                    retryable: false,
                }),
            });
        }
    };

    const handleMessage = async (state, rawMessage) => {
        let message;
        try {
            message = JSON.parse(rawMessage);
        } catch {
            return;
        }
        return state.role === 'client'
            ? handlePeerClientMessage(state, message)
            : handlePeerServerMessage(state, message);
    };

    const onDisconnect = (state) => {
        if (state.role !== 'client') {
            handoff.abandon(state);
            for (const authorizationLease of state.authorizationLeases.values()) {
                authorizationLease.release();
            }
            state.authorizationLeases.clear();
            return { disconnected: false, shouldTakeover: false, reconnectDelay: null };
        }
        if (!connections.disconnectPeer(state.socket)) {
            return { disconnected: false, shouldTakeover: false, reconnectDelay: null };
        }

        const shouldTakeover = handoff.consumeTakeoverGrant();
        handoff.markDisconnected();
        requestBroker.rejectPendingRequests(
            new ToolExecutionError(
                    'EXTENSION_DISCONNECTED',
                    'The primary local bridge disconnected before returning the WB response. Retry once it is back.',
                    'extension',
                    true
                )
        );
        requestBroker.rejectPendingAuthorizations(
            new ToolExecutionError(
                    'EXTENSION_DISCONNECTED',
                    'The primary local bridge disconnected before authorizing the browser job. Retry once it is back.',
                    'extension',
                    true
                )
        );
        clearTimeout(connections.peerReconnectTimer);
        const reconnectDelay = connections.nextPeerReconnectDelay({
            baseMs: PEER_RECONNECT_BASE_MS,
            maxMs: PEER_RECONNECT_MAX_MS,
            maxAttempts: PEER_RECONNECT_MAX_ATTEMPTS,
        });
        if (!shouldTakeover && reconnectDelay === null) {
            handoff.observeCancellation();
        }
        broadcastStatus();
        return { disconnected: true, shouldTakeover, reconnectDelay };
    };

    return { createState, handleMessage, onDisconnect };
};
