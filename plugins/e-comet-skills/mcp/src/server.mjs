#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import net from 'node:net';
import { release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pruneArtifacts } from './artifact-store.mjs';
import { detectPlatformCause, readComspecState } from './bridge-cause.mjs';
import { createBridgeClientRuntime } from './bridge-client-runtime.mjs';
import { deriveBridgeDiagnostics } from './bridge-diagnostics.mjs';
import { ensureRegistration, readUserLevelHostsPolicy, resolveNativeHostName, runBounded } from './bridge-registration.mjs';
import { createBrokerClient } from './broker-client.mjs';
import { probeBrowserExtensionInstall } from './browser-extension-install.mjs';
import {
    ALLOWED_EXTENSION_IDS,
    BRIDGE_VERSION,
    EXTENSION_ID_OVERRIDE_ENABLED,
    EXTENSION_PROTOCOL_VERSION,
    PROFILE_STATE_DIR,
    STORAGE_LAYOUT,
} from './config.mjs';
import { ConnectionState } from './connection-state.mjs';
import { collectStaticFacts, diagnosticCheck, hostRestartFacts, isHostRuntimeVersion } from './diagnostic-facts.mjs';
import { BRIDGE_IDENTIFIER } from './bridge-codes.mjs';
import { createTransportEvents } from './transport-events.mjs';
import { createExtensionProtocol, extensionDisconnectedError } from './extension-protocol.mjs';
import { maintainFeedbackArtifacts } from './feedback-artifact-store.mjs';
import { localMessage, MESSAGE_TYPES } from './extension-vocabulary.mjs';
import { createMcpMessageHandler } from './mcp-dispatcher.mjs';
import { mcpError } from './mcp-protocol.mjs';
import { CLIENT_PROTOCOL_VERSION, EXTENSION_ORIGIN } from './native-framing.mjs';
import { RequestBroker } from './request-broker.mjs';
import { pruneResults } from './result-store.mjs';
import { createDiagnosticSnapshotRoute, createOzonPromotionRoute } from './server-routing.mjs';
import { collectExtensionLog } from './extension-log.mjs';
import { attachStdioTransport } from './stdio-transport.mjs';
import { ToolExecutionError } from './tool-errors.mjs';
import { storageStatus } from './storage-layout.mjs';

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
    console.error(`[e-comet-local-bridge] Node.js 22 or newer is required; found ${process.versions.node}`);
    process.exit(1);
}

const log = (...args) => console.error('[e-comet-local-bridge]', ...args);
const instanceId = randomUUID();
// The origin the broker registration admits: the published extension, or the unpacked one a test or development run
// names through the extension-id override.
const registrationOrigin = EXTENSION_ID_OVERRIDE_ENABLED && ALLOWED_EXTENSION_IDS.size > 0
    ? `chrome-extension://${[...ALLOWED_EXTENSION_IDS][0]}/`
    : EXTENSION_ORIGIN;
const connections = new ConnectionState();
// Transport events that otherwise reach only stderr, shared by the request broker (late answers) and the bridge runtime.
const transportEvents = createTransportEvents();
// A spawned test server never reads this machine's browser policies or profiles: it reports no install observed.
const readsDevice = process.env.NODE_ENV !== 'test';
let runtime;
// Sends to the current broker session; without one it throws EXTENSION_DISCONNECTED.
const sendExtension = (message) => runtime.sendExtension(message);

const requestBroker = new RequestBroker({
    // Ответ, приехавший после того, как запрос уже завершился по таймауту. Раньше
    // терялся молча вместе с типизированным кодом отказа. В статус и отчёт идёт только
    // этот код или вид ответа, без id запроса.
    onUnsettled: ({ kind, requestId, detail }) => {
        log(`late ${kind} for settled request ${requestId}${detail ? `: ${detail}` : ''}`);
        transportEvents.add({ kind: 'late_answer', code: typeof detail === 'string' && BRIDGE_IDENTIFIER.test(detail) ? detail : kind.replaceAll('-', '_') });
    },
    routeWbFetch: ({ requestId, url, timeout, authorizationId }) =>
        sendExtension(localMessage(requestId, MESSAGE_TYPES.wbFetch, { url, timeout, authorizationId })),
    routeSellerOperation: ({ requestId, sellerOperation, timeout, authorizationId }) =>
        sendExtension(localMessage(requestId, MESSAGE_TYPES.wbFetch, { authorizationId, sellerOperation, timeout })),
    routeOzonPromotionReport: createOzonPromotionRoute({ connections, sendExtension }),
    routeDiagnosticSnapshot: createDiagnosticSnapshotRoute({ connections, sendExtension }),
    routeAuthorization: ({ requestId, token }) => {
        if (connections.extensionReady && !connections.extensionBrowserJobReady) {
            throw new ToolExecutionError(
                'EXTENSION_UPDATE_REQUIRED',
                'The e-Comet Chrome extension must be updated to support signed browser jobs.',
                'extension',
                false
            );
        }
        // A grant belongs to the session it was made in; a later session must not carry its work or its release.
        const session = connections.extensionSession;
        sendExtension(localMessage(requestId, MESSAGE_TYPES.browserJobAuthorize, { token }));
        return {
            isActive: () => connections.extensionSession === session,
            release: (authorizationId) =>
                requestBroker.requestAuthorizationRelease(authorizationId, ({ requestId: releaseRequestId }) => {
                    if (connections.extensionSession !== session) {
                        throw extensionDisconnectedError('The extension disconnected before releasing the browser-job authorization.');
                    }
                    sendExtension(localMessage(releaseRequestId, MESSAGE_TYPES.browserJobAuthorizationRelease, { authorizationId }));
                }),
        };
    },
});

const extensionProtocol = createExtensionProtocol({ connections, requestBroker, log });
runtime = createBridgeClientRuntime({
    brokerClient: createBrokerClient({
        rendezvousDir: join(PROFILE_STATE_DIR, 'bridges'),
        platform: process.platform,
        pluginVersion: BRIDGE_VERSION,
        instanceId,
        net,
        fs: fsPromises,
        now: Date.now,
        log,
    }),
    registration: ({ repair = false } = {}) => ensureRegistration({
        repair,
        platform: process.platform,
        env: process.env,
        stateDir: PROFILE_STATE_DIR,
        srcDir: dirname(fileURLToPath(import.meta.url)),
        hostName: resolveNativeHostName({ env: process.env }),
        allowedOrigin: registrationOrigin,
        version: BRIDGE_VERSION,
        execPath: process.execPath,
        now: Date.now,
        fs: fsPromises,
        run: runBounded,
        log,
    }),
    extensionProtocol,
    connections,
    log,
    platformCause: detectPlatformCause(),
    readPolicy: async () => (readsDevice
        ? readUserLevelHostsPolicy({ platform: process.platform, run: runBounded, hostName: resolveNativeHostName({ env: process.env }) }) : null),
    probe: async () => (readsDevice ? probeBrowserExtensionInstall() : null),
    readExtensionLog: async (options) => (readsDevice ? collectExtensionLog(options) : null),
    comspec: () => readComspecState({ platform: process.platform, env: process.env }),
    transportEvents,
});

const requestBrowserJobAuthorization = (...args) => requestBroker.requestAuthorization(...args);
const shutdownController = new AbortController();
// Only the native DeepSeek adapter sets this: the Harness runtime version it resolved its own peers against.
// Anything outside the version grammar is dropped here rather than carried into a report. A foreign parent environment
// that sets it is "Native DeepSeek host runtime version from the environment" in docs/local-agent-architecture.md#accepted-residuals.
const hostRuntimeVersion = isHostRuntimeVersion(process.env.ECOMET_HOST_RUNTIME_VERSION) ? process.env.ECOMET_HOST_RUNTIME_VERSION : undefined;
// The same adapter's account of the module it restarted: the last failure class and the restart count, closed values only.
const hostRestarts = hostRestartFacts(process.env);
const osRelease = release();

const handleMcpMessage = createMcpMessageHandler({
    reportOutputDirectory: process.env.CLAUDE_PROJECT_DIR,
    getBridgeStatus: (/** @type {any} */ metadata = {}) => {
        const { clientInfo, protocolVersion, clientObservedAt } = metadata;
        // The extension log evidence becomes the closed extension_log check and the last frame time the route_freshness
        // check; their times and system code stay here.
        const { extensionLog, routeLastObservedAtMs, ...rawStatus } = runtime.status();
        const observedAt = new Date().toISOString();
        const storage = storageStatus(STORAGE_LAYOUT);
        const derived = deriveBridgeDiagnostics({ ...rawStatus, extensionLog, routeLastObservedAtMs, observedAt });
        const staticChecks = Object.fromEntries(collectStaticFacts({
            platform: process.platform, arch: process.arch,
            versions: { node: process.version, bridge: BRIDGE_VERSION, mcp: protocolVersion, os: osRelease },
            storageLayout: storage, observedAt,
        }).map((check) => [check.check, check]));
        return ({
            ...rawStatus,
            ...derived,
            clientProtocolVersion: CLIENT_PROTOCOL_VERSION,
            bridgeVersion: BRIDGE_VERSION,
            extensionProtocolVersion: EXTENSION_PROTOCOL_VERSION,
            instanceId,
            storage,
            diagnostics: {
                ...derived.diagnostics,
                runtime: staticChecks.runtime,
                client: diagnosticCheck({ check: 'client', state: clientInfo ? 'passed' : 'not_checked', observedAt: clientObservedAt ?? observedAt,
                    source: 'mcp_initialize', executionPlane: 'client',
                    ...(clientInfo ? { facts: { ...clientInfo, provenance: 'client_reported', ...(hostRuntimeVersion ? { hostRuntimeVersion } : {}), ...hostRestarts } } : {}) }),
                storage: staticChecks.storage,
            },
        });
    },
    ensureBroker: () => runtime.ensureBroker(),
    refreshBridgeFacts: (options) => runtime.refreshDeviceFacts(options),
    // A diagnosis and a report read the log of the browser the runtime names; a diagnosis's read becomes the kept one.
    extensionLogTarget: () => runtime.extensionLogTarget(),
    replaceExtensionLog: (evidence) => runtime.replaceExtensionLog(evidence),
    // Discovery and registration start once the host has its handshake answer, so neither delays it.
    onInitialized: () => runtime.onInitialized(),
    // A tool that needs the extension starts a connect attempt at once instead of waiting for the next re-list.
    kick: () => runtime.kick(),
    requestBrowserJobAuthorization,
    // Diagnosis uses the broker's business deadline; feedback preparation passes its own shorter one.
    requestExtensionDiagnosticSnapshot: (timeoutMs) => requestBroker.requestDiagnosticSnapshot(timeoutMs),
    diagnosticSnapshotV2Ready: () => connections.extensionDiagnosticSnapshotV2Ready,
    shutdownSignal: shutdownController.signal,
    log,
});

let storageSweepStart;
let shuttingDown = false;
let detachStdio = () => undefined;
const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (storageSweepStart !== undefined) clearImmediate(storageSweepStart);
    shutdownController.abort();
    detachStdio();
    runtime.close();
    // Last resort, not the normal path: a healthy shutdown drains and exits without reaching this. It stays for an
    // unknown straggler only: process.exit() abandons whatever is still buffered, including a result file mid-write,
    // so the grace has to comfortably outlast every bounded wait above. Unref'd, so it never delays a clean exit.
    const exitTimer = setTimeout(() => process.exit(process.exitCode ?? 0), 5000);
    exitTimer.unref?.();
};
detachStdio = attachStdioTransport({ handleMessage: handleMcpMessage, sendError: mcpError, onClose: shutdown });
// One sweep of expired local files after STDIO is live, so a slow filesystem can never
// extend the host's cold-start handshake; later sweeps follow each writer.
// Every root is swept on its own: one unavailable root (StorageUnavailableError) never skips the
// others. Paths and raw storage errors are intentionally excluded from diagnostics.
// Per-file failures are already reported by sweepExpired; this catches enclosing root failures.
const sweepLocalStorage = async (sweeps) => {
    const outcomes = await Promise.allSettled(sweeps.map((sweep) => sweep()));
    if (outcomes.some((outcome) => outcome.status === 'rejected')) log('local storage cleanup failed');
};
const CURRENT_STORAGE_SWEEPS = [() => maintainFeedbackArtifacts(), () => pruneArtifacts(), () => pruneResults()];
storageSweepStart = setImmediate(() => {
    storageSweepStart = undefined;
    if (shuttingDown) return;
    // One pass per process start, plus the writer-driven sweeps of prepare and retire: an unsent
    // archive therefore lives at most until the next start. See the accepted residuals in
    // docs/local-agent-architecture.md#accepted-residuals for why no maintenance timer exists.
    void sweepLocalStorage(CURRENT_STORAGE_SWEEPS);
});
storageSweepStart.unref?.();
