#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { createBridgeRuntime } from './bridge-runtime.mjs';
import {
    BRIDGE_GENERATION,
    BRIDGE_VERSION,
    CONTROL_PROTOCOL_VERSION,
    EXTENSION_PATH,
    EXTENSION_PROTOCOL_VERSION,
    EXTENSION_READINESS_WAIT_MS,
    HANDOFF_RECONNECT_GRACE_MS,
    HOST,
    PEER_PATH,
    PEER_TOKEN_CREATE_TIMEOUT_MS,
    PEER_TOKEN_DIR,
    PEER_TOKEN_READ_TIMEOUT_MS,
    PORT,
    RESULT_DIR,
    SESSION_NONCE,
} from './config.mjs';
import { ConnectionState } from './connection-state.mjs';
import { deriveBridgeDiagnostics } from './bridge-diagnostics.mjs';
import { createExtensionProtocol } from './extension-protocol.mjs';
import { localMessage, MESSAGE_TYPES } from './extension-vocabulary.mjs';
import { HandoffState } from './handoff-state.mjs';
import { createMcpMessageHandler } from './mcp-dispatcher.mjs';
import { mcpError } from './mcp-protocol.mjs';
import { loadOrCreatePeerToken, loadPeerToken } from './peer-auth.mjs';
import { createPeerTokenSource } from './peer-token-source.mjs';
import { createPeerProtocol } from './peer-protocol.mjs';
import { RequestBroker } from './request-broker.mjs';
import { attachStdioTransport } from './stdio-transport.mjs';
import { ToolExecutionError } from './tool-errors.mjs';
import { connectWebSocket } from './websocket-client.mjs';
import { sendWs, WS_OPEN } from './websocket.mjs';

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
    console.error(`[e-comet-local-bridge] Node.js 22 or newer is required; found ${process.versions.node}`);
    process.exit(1);
}
if (!Number.isInteger(BRIDGE_GENERATION) || BRIDGE_GENERATION < 1) {
    console.error(`[e-comet-local-bridge] bridge generation must be a positive integer; found ${BRIDGE_GENERATION}`);
    process.exit(1);
}

const log = (...args) => console.error('[e-comet-local-bridge]', ...args);
const instanceId = randomUUID();
const injectedPeerTokenFailure =
    process.env.NODE_ENV === 'test' ? process.env.ECOMET_LOCAL_TEST_PEER_TOKEN_FAILURE : undefined;
const peerTokenSource = createPeerTokenSource({
    load: () =>
        injectedPeerTokenFailure
            ? Promise.resolve({ ok: false, reason: injectedPeerTokenFailure })
            : loadPeerToken({ directory: PEER_TOKEN_DIR }),
    loadOrCreate: () => {
        if (injectedPeerTokenFailure) {
            return Promise.reject(Object.assign(new Error('Injected peer-token failure'), { code: 'EACCES' }));
        }
        return loadOrCreatePeerToken({ directory: PEER_TOKEN_DIR });
    },
    readDeadlineMs: PEER_TOKEN_READ_TIMEOUT_MS,
    createDeadlineMs: PEER_TOKEN_CREATE_TIMEOUT_MS,
});
const connections = new ConnectionState();
const handoff = new HandoffState({
    generation: BRIDGE_GENERATION,
    instanceId,
    reconnectGraceMs: HANDOFF_RECONNECT_GRACE_MS,
    // One clock for both halves of the wake-up guard: `ensureBridgeConnected` weighs this state's listener
    // yield against the retry time the connection state stamped, so the two must not be able to read
    // different epochs.
    now: () => connections.now(),
});

const requestBroker = new RequestBroker({
    // Прямо к расширению — один хоп; через peer — два, и его брокер тоже возьмёт
    // себе запас, поэтому наш дедлайн должен быть на запас дальше.
    routeHopCount: () => (connections.extensionReady ? 1 : 2),
    // Ответ, приехавший после того, как запрос уже завершился по таймауту. Раньше
    // терялся молча вместе с типизированным кодом отказа.
    onUnsettled: ({ kind, requestId, detail }) =>
        log(`late ${kind} for settled request ${requestId}${detail ? `: ${detail}` : ''}`),
    routeWbFetch: ({ requestId, url, timeout, authorizationId, authorizationScopeId }) => {
        if (connections.extensionReady) {
            sendWs(connections.extensionSocket, localMessage(requestId, MESSAGE_TYPES.wbFetch, { url, timeout, authorizationId }));
        } else if (connections.peerReady && connections.peerSocket?.readyState === WS_OPEN) {
            connections.peerSocket.send(
                JSON.stringify({
                    type: 'peer_wb_fetch',
                    requestId,
                    url,
                    // Бюджет уходит без изменений: он подписан бэкендом. Запас берём
                    // себе через routeHopCount, а не отнимаем у запроса.
                    timeout,
                    authorizationId,
                    authorizationScopeId,
                })
            );
        } else {
            throw new ToolExecutionError(
                'EXTENSION_DISCONNECTED',
                'The e-Comet Chrome extension is not connected. Open an authenticated Wildberries tab and retry.',
                'extension',
                true
            );
        }
    },
    routeSellerOperation: ({ requestId, sellerOperation, timeout, authorizationId, authorizationScopeId }) => {
        if (connections.extensionReady) {
            sendWs(
                connections.extensionSocket,
                localMessage(requestId, MESSAGE_TYPES.wbFetch, { authorizationId, sellerOperation, timeout })
            );
            return;
        }
        if (connections.peerReady && connections.peerSocket?.readyState === WS_OPEN) {
            connections.peerSocket.send(
                JSON.stringify({
                    type: 'peer_seller_operation',
                    requestId,
                    authorizationScopeId,
                    authorizationId,
                    sellerOperation,
                    timeout,
                })
            );
            return;
        }
        throw new ToolExecutionError(
            'EXTENSION_DISCONNECTED',
            'The e-Comet Chrome extension is not connected. Open an authenticated Wildberries tab and retry.',
            'extension',
            true
        );
    },
    routeAuthorization: ({ requestId, token }) => {
        if (connections.extensionReady && !connections.extensionBrowserJobReady) {
            throw new ToolExecutionError(
                'EXTENSION_UPDATE_REQUIRED',
                'The e-Comet Chrome extension must be updated to support signed browser jobs.',
                'extension',
                false
            );
        }
        if (connections.extensionBrowserJobReady) {
            const extensionSocket = connections.extensionSocket;
            sendWs(extensionSocket, localMessage(requestId, MESSAGE_TYPES.browserJobAuthorize, { token }));
            return {
                isActive: () => connections.extensionReady && connections.extensionSocket === extensionSocket,
                release: (authorizationId) =>
                    requestBroker.requestAuthorizationRelease(authorizationId, ({ requestId: releaseRequestId }) => {
                        if (!connections.extensionReady || connections.extensionSocket !== extensionSocket) {
                            throw new ToolExecutionError(
                                'EXTENSION_DISCONNECTED',
                                'The e-Comet Chrome extension disconnected before releasing browser-job authorization.',
                                'extension',
                                true
                            );
                        }
                        sendWs(
                            extensionSocket,
                            localMessage(releaseRequestId, MESSAGE_TYPES.browserJobAuthorizationRelease, { authorizationId })
                        );
                    }),
            };
        }
        if (connections.peerReady && !connections.peerExtensionBrowserJobReady) {
            throw new ToolExecutionError(
                'EXTENSION_UPDATE_REQUIRED',
                'The e-Comet Chrome extension must be updated to support signed browser jobs.',
                'extension',
                false
            );
        }
        if (connections.peerExtensionBrowserJobReady && connections.peerSocket?.readyState === WS_OPEN) {
            const peerSocket = connections.peerSocket;
            peerSocket.send(JSON.stringify({ type: 'peer_browser_job_authorize', requestId, token }));
            return {
                isActive: () =>
                    connections.peerReady && connections.peerSocket === peerSocket && peerSocket.readyState === WS_OPEN,
                release: (authorizationId) =>
                    requestBroker.requestAuthorizationRelease(authorizationId, ({ requestId: releaseRequestId }) => {
                        if (peerSocket.readyState !== WS_OPEN) {
                            throw new ToolExecutionError(
                                'EXTENSION_DISCONNECTED',
                                'The primary local bridge disconnected before releasing browser-job authorization.',
                                'extension',
                                true
                            );
                        }
                        peerSocket.send(
                            JSON.stringify({
                                type: 'peer_browser_job_authorization_release',
                                requestId: releaseRequestId,
                                authorizationScopeId: requestId,
                            })
                        );
                    }),
            };
        }
        throw new ToolExecutionError(
            'EXTENSION_DISCONNECTED',
            'The e-Comet Chrome extension is not connected. Open an authenticated Wildberries tab and retry.',
            'extension',
            true
        );
    },
});

let runtime;
const broadcastStatus = () => runtime?.status.broadcast();
const extensionProtocol = createExtensionProtocol({
    connections,
    requestBroker,
    handoff,
    sessionNonce: SESSION_NONCE,
    send: sendWs,
    log,
    broadcastStatus,
});
const peerProtocol = createPeerProtocol({
    connections,
    requestBroker,
    handoff,
    send: sendWs,
    log,
    broadcastStatus,
});
runtime = createBridgeRuntime({
    host: HOST,
    port: PORT,
    extensionPath: EXTENSION_PATH,
    peerPath: PEER_PATH,
    createHttpServer: createServer,
    // Deliberately not the platform WebSocket: the peer client must be able to destroy a transport whose
    // remote never completes the closing handshake, which the WHATWG socket cannot do (see websocket-client.mjs).
    createWebSocket: (url) => connectWebSocket(url),
    extensionProtocol,
    peerProtocol,
    handoff,
    connections,
    peerTokenSource,
    log,
});

const requestBrowserJobAuthorization = (...args) => requestBroker.requestAuthorization(...args);
const shutdownController = new AbortController();
const handleMcpMessage = createMcpMessageHandler({
    getBridgeStatus: () => {
        const rawStatus = runtime.status();
        return ({
        ...rawStatus,
        ...deriveBridgeDiagnostics(rawStatus, connections.now()),
        bridgeVersion: BRIDGE_VERSION,
        bridgeGeneration: BRIDGE_GENERATION,
        controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
        extensionProtocolVersion: EXTENSION_PROTOCOL_VERSION,
        instanceId,
        websocket: `ws://${HOST}:${PORT}${EXTENSION_PATH}`,
        resultDirectory: RESULT_DIR,
    });},
    waitForExtensionReady: () => connections.waitForExtensionReady(EXTENSION_READINESS_WAIT_MS),
    // A degraded secondary retries slowly in the background; an actual request is the signal to try again now.
    // The dispatcher owns every wake-up, applying it at its tools/call dispatch point to whichever tools
    // declare a bridge dependency, so routing one through waitForExtensionReady as well would only nudge twice
    // for the same call and split the wiring across two modules.
    ensureBridgeConnected: () => runtime.ensureBridgeConnected(),
    requestBrowserJobAuthorization,
    shutdownSignal: shutdownController.signal,
    log,
});

let shuttingDown = false;
let detachStdio = () => undefined;
const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownController.abort();
    detachStdio();
    runtime.close();
    // Last resort, not the normal path. The wedged-CLOSING peer socket this once existed for is now bounded by
    // the owned transport, which destroys its handle after WS_CLIENT_CLOSE_GRACE_MS, and the broker's own
    // timers are unref'd, so a healthy shutdown drains and exits without ever reaching this. It stays for an
    // unknown straggler only: process.exit() abandons whatever is still buffered, including a result file
    // mid-write, so the grace has to comfortably outlast every bounded wait above. Unref'd, so it never
    // delays a clean exit.
    const exitTimer = setTimeout(() => process.exit(process.exitCode ?? 0), 5000);
    exitTimer.unref?.();
};
detachStdio = attachStdioTransport({ handleMessage: handleMcpMessage, sendError: mcpError, onClose: shutdown });
runtime.start();
