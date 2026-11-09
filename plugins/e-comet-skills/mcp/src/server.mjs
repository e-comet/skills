#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import net from 'node:net';
import { release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTransportEvents } from './bridge/broker/events.mjs';
import { extensionDisconnectedError } from './bridge/broker/messages.mjs';
import { createDiagnosticSnapshotRoute } from './bridge/broker/routes.mjs';
import { detectPlatformCause, readComspecState } from './bridge/cause.mjs';
import { createBrokerClient } from './bridge/client/broker-client.mjs';
import { ConnectionState } from './bridge/client/connection-state.mjs';
import { createBridgeClientRuntime } from './bridge/client/session-runtime.mjs';
import { registrationOrigin } from './bridge/limits.mjs';
import { probeBrowserExtensionInstall } from './bridge/profile/extension-install.mjs';
import { collectExtensionLog } from './bridge/profile/extension-log.mjs';
import { ensureRegistration, readUserLevelHostsPolicy, resolveNativeHostName, runBounded } from './bridge/registration.mjs';
import { deriveBridgeDiagnostics } from './bridge/route-state.mjs';
import { SERVER_INSTRUCTIONS, TOOL_CONTRACTS } from './catalog.mjs';
import { createExtensionProtocol } from './composition/extension-protocol.composition.mjs';
import { moduleNameOf } from './composition/module-names.composition.mjs';
import { ozonSellerTools } from './composition/ozon-seller.composition.mjs';
import { RequestBroker } from './composition/request-broker.composition.mjs';
import { supportTools } from './composition/support.composition.mjs';
import { wbClientTools } from './composition/wb-client.composition.mjs';
import { wbSellerTools } from './composition/wb-seller.composition.mjs';
import { mcpError } from './mcp-protocol/framing.mjs';
import { createMcpMessageHandler } from './mcp-protocol/registry/dispatcher.mjs';
import { attachStdioTransport } from './mcp-protocol/stdio.mjs';
import { CLIENT_PROTOCOL_VERSION, EXTENSION_PROTOCOL_VERSION } from './native-framing.mjs';
import { createOzonPackage } from './ozon-seller/out/extension/package.mjs';
import { createOzonPromotionRoute } from './ozon-seller/out/extension/promotion-route.mjs';
import { createOzonPromotion } from './ozon-seller/out/extension/promotion.mjs';
import { ToolExecutionError } from './shared/coded-error.mjs';
import { isRecord } from './shared/values.mjs';
import { documentsFolder } from './storage/delivery.mjs';
import { resolveStorageLayout, storageStatus, useStorageLayout } from './storage/files/layout.mjs';
import { resolveProfileStateDir } from './storage/files/state-paths.mjs';
import { pruneArtifacts } from './storage/writers/artifacts.mjs';
import { pruneResults } from './storage/writers/results.mjs';
import { maintainFeedbackArtifacts } from './support/feedback/out/artifacts/store.mjs';
import { BRIDGE_IDENTIFIER } from './transport/diagnostics/bridge-codes.mjs';
import { hostRestartFacts, isHostRuntimeVersion } from './transport/diagnostics/facts.mjs';
import { collectStaticFacts, diagnosticCheck } from './transport/diagnostics/vocabulary.mjs';
import { localMessage, MESSAGE_TYPES } from './transport/extension/wire.mjs';
import { safeFeedbackProperty, useModuleNames } from './transport/failures/evidence.mjs';
import { createWbFetch } from './wb-client/out/extension/wb-fetch.mjs';
import { createSellerOperations } from './wb-seller/out/extension/operations.mjs';
useModuleNames(moduleNameOf);
// The plugin release version, read once from the manifest beside this package; registration stamps it on the broker copy.
// Never this package's own package.json: a tree with no plugin manifest beside it counts as development.
const readBuildVersion = () => {
    try {
        const manifest = JSON.parse(readFileSync(new URL('../../.codex-plugin/plugin.json', import.meta.url), 'utf8'));
        const version = isRecord(manifest) ? manifest.version : undefined;
        if (typeof version === 'string' && version.length > 0)
            return version;
    }
    catch (error) {
        if (safeFeedbackProperty(error, 'code') !== 'ENOENT')
            throw error;
    }
    return '0.0.0-development';
};
const BRIDGE_VERSION = readBuildVersion();
const PROFILE_STATE_DIR = resolveProfileStateDir();
const STORAGE_LAYOUT = resolveStorageLayout();
useStorageLayout(STORAGE_LAYOUT);
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
    console.error(`[e-comet-local-bridge] Node.js 22 or newer is required; found ${process.versions.node}`);
    process.exit(1);
}
const log = (...args) => console.error('[e-comet-local-bridge]', ...args);
const instanceId = randomUUID();
const connections = new ConnectionState();
// Transport events that otherwise reach only stderr, shared by the request broker (late answers) and the bridge runtime.
const transportEvents = createTransportEvents();
// A spawned test server never reads this machine's browser policies or profiles: it reports no install observed.
const readsDevice = process.env.NODE_ENV !== 'test';
// Sends to the current broker session; without one it throws EXTENSION_DISCONNECTED.
const sendExtension = (message) => runtime.sendExtension(message);
const requestBroker = new RequestBroker({
    // Ответ, приехавший после того, как запрос уже завершился по таймауту. Раньше
    // терялся молча вместе с типизированным кодом отказа. В статус и отчёт идёт только
    // этот код или вид ответа, без id запроса.
    onUnsettled: ({ kind, requestId, detail }) => {
        log(`late ${kind} for settled request ${requestId}${detail ? `: ${detail}` : ''}`);
        transportEvents.add({
            kind: 'late_answer',
            code: typeof detail === 'string' && BRIDGE_IDENTIFIER.test(detail) ? detail : kind.replaceAll('-', '_'),
        });
    },
    routeWbFetch: ({ requestId, url, timeout, authorizationId }) => sendExtension(localMessage(requestId, MESSAGE_TYPES.wbFetch, { url, timeout, authorizationId })),
    routeSellerOperation: ({ requestId, sellerOperation, timeout, authorizationId }) => sendExtension(localMessage(requestId, MESSAGE_TYPES.wbFetch, { authorizationId, sellerOperation, timeout })),
    routeDiagnosticSnapshot: createDiagnosticSnapshotRoute({ connections, sendExtension }),
    routeAuthorization: ({ requestId, token }) => {
        if (connections.extensionReady && !connections.extensionBrowserJobReady) {
            throw new ToolExecutionError('EXTENSION_UPDATE_REQUIRED', 'The e-Comet Chrome extension must be updated to support signed browser jobs.', 'extension', false);
        }
        // A grant belongs to the session it was made in; a later session must not carry its work or its release.
        const session = connections.extensionSession;
        sendExtension(localMessage(requestId, MESSAGE_TYPES.browserJobAuthorize, { token }));
        return {
            isActive: () => connections.extensionSession === session,
            release: (authorizationId) => requestBroker.requestAuthorizationRelease(authorizationId, ({ requestId: releaseRequestId }) => {
                if (connections.extensionSession !== session) {
                    throw extensionDisconnectedError('The extension disconnected before releasing the browser-job authorization.');
                }
                sendExtension(localMessage(releaseRequestId, MESSAGE_TYPES.browserJobAuthorizationRelease, { authorizationId }));
            }),
        };
    },
});
// The Ozon promotion and package state machines share the one Ozon reservation and the Ozon route.
const ozonRoute = createOzonPromotionRoute({ connections, sendExtension });
const ozonReservation = { current: null };
const ozonPromotion = createOzonPromotion({ correlation: requestBroker.correlation, route: ozonRoute, reservation: ozonReservation });
const ozonPackage = createOzonPackage({ correlation: requestBroker.correlation, route: ozonRoute, reservation: ozonReservation });
const extensionProtocol = createExtensionProtocol({ connections, requestBroker, log });
const runtime = createBridgeClientRuntime({
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
        allowedOrigin: registrationOrigin(process.env),
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
    readPolicy: async () => readsDevice
        ? readUserLevelHostsPolicy({
            platform: process.platform,
            run: runBounded,
            hostName: resolveNativeHostName({ env: process.env }),
        })
        : null,
    probe: async () => (readsDevice ? probeBrowserExtensionInstall() : null),
    readExtensionLog: async (options) => (readsDevice ? collectExtensionLog(options) : null),
    comspec: () => readComspecState({ platform: process.platform, env: process.env }),
    transportEvents,
});
const requestBrowserJobAuthorization = (...args) => requestBroker.requestAuthorization(...args);
const shutdownController = new AbortController();
// Only the native DeepSeek adapter sets this: the Harness runtime version it resolved its own peers against.
// Anything outside the version grammar is dropped here rather than carried into a report. A foreign parent environment
// that sets it is "Native DeepSeek host runtime version from the environment" in docs/architecture/residuals/deepseek.md.
const hostRuntimeVersion = isHostRuntimeVersion(process.env.ECOMET_HOST_RUNTIME_VERSION)
    ? process.env.ECOMET_HOST_RUNTIME_VERSION
    : undefined;
// The same adapter's account of the module it restarted: the last failure class and the restart count, closed values only.
const hostRestarts = hostRestartFacts(process.env);
const osRelease = release();
// Diagnosis uses the broker's business deadline; feedback preparation passes its own shorter one.
const requestExtensionDiagnosticSnapshot = (timeoutMs) => requestBroker.requestDiagnosticSnapshot(timeoutMs);
// The session facts the dispatcher passes: the client's sanitized initialize metadata.
const getBridgeStatus = (metadata = {}) => {
    const { clientInfo, protocolVersion, clientObservedAt } = metadata;
    // The extension log evidence becomes the closed extension_log check and the last frame time the route_freshness
    // check; their times and system code stay here.
    const { extensionLog, routeLastObservedAtMs, ...rawStatus } = runtime.status();
    const observedAt = new Date().toISOString();
    const storage = storageStatus(STORAGE_LAYOUT);
    const derived = deriveBridgeDiagnostics({ ...rawStatus, extensionLog, routeLastObservedAtMs, observedAt });
    const staticChecks = Object.fromEntries(collectStaticFacts({
        platform: process.platform,
        arch: process.arch,
        versions: {
            node: process.version,
            bridge: BRIDGE_VERSION,
            ...(protocolVersion ? { mcp: protocolVersion } : {}),
            os: osRelease,
        },
        storageLayout: storage,
        observedAt,
    }).map((check) => [check.check, check]));
    return {
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
            client: diagnosticCheck({
                check: 'client',
                state: clientInfo ? 'passed' : 'not_checked',
                observedAt: clientObservedAt ?? observedAt,
                source: 'mcp_initialize',
                executionPlane: 'client',
                ...(clientInfo
                    ? {
                        facts: {
                            ...clientInfo,
                            provenance: 'client_reported',
                            ...(hostRuntimeVersion ? { hostRuntimeVersion } : {}),
                            ...hostRestarts,
                        },
                    }
                    : {}),
            }),
            storage: staticChecks.storage,
        },
    };
};
// Verified workbook copies go to the Claude project. Cowork runs one device process for all its conversations, with
// CLAUDE_PLUGIN_ROOT but no project, so its copies go to Documents, a folder its agent may request access to; the
// plugin's own storage is never that folder (owner's choice, 2026-11-03). Codex and DeepSeek read the original paths.
const reportOutputDirectory = process.env.CLAUDE_PROJECT_DIR ?? (process.env.CLAUDE_PLUGIN_ROOT ? documentsFolder() : undefined);
const handleMcpMessage = createMcpMessageHandler({
    contracts: TOOL_CONTRACTS,
    instructions: SERVER_INSTRUCTIONS,
    version: BRIDGE_VERSION,
    // The support tools: status, diagnosis and feedback, over this process's bridge, profiles and storage; the WB buyer
    // tools over its broker connection, authorization and WB fetch; the seller export over its seller operations; and the
    // Ozon reports and positions over the Ozon state machines.
    registerTools: (registry) => [
        ...supportTools(registry, {
            version: BRIDGE_VERSION,
            storageLayout: STORAGE_LAYOUT,
            requestExtensionDiagnosticSnapshot,
            refreshBridgeFacts: (options) => runtime.refreshDeviceFacts(options),
            // A diagnosis and a report read the log of the browser the runtime names; a diagnosis's read becomes the kept one.
            extensionLogTarget: () => runtime.extensionLogTarget(),
            replaceExtensionLog: (evidence) => runtime.replaceExtensionLog(evidence),
        }),
        ...wbClientTools(registry, {
            ensureBroker: () => runtime.ensureBroker(),
            requestBrowserJobAuthorization,
            wbFetch: createWbFetch({ correlation: requestBroker.correlation }),
            shutdownSignal: shutdownController.signal,
            log,
        }),
        ...wbSellerTools(registry, {
            ensureBroker: () => runtime.ensureBroker(),
            requestBrowserJobAuthorization,
            sellerOperations: createSellerOperations({ correlation: requestBroker.correlation }),
            reportOutputDirectory,
        }),
        ...ozonSellerTools(registry, {
            getBridgeStatus,
            ensureBroker: () => runtime.ensureBroker(),
            requestBrowserJobAuthorization,
            ozonPromotion,
            ozonPackage,
            reportOutputDirectory,
        }),
    ],
    getBridgeStatus,
    // Discovery and registration start once the host has its handshake answer, so neither delays it.
    onInitialized: () => runtime.onInitialized(),
    // A tool that needs the extension starts a connect attempt at once instead of waiting for the next re-list.
    kick: () => runtime.kick(),
    requestExtensionDiagnosticSnapshot,
    diagnosticSnapshotV2Ready: () => connections.extensionDiagnosticSnapshotV2Ready,
});
let storageSweepStart;
let shuttingDown = false;
let detachStdio = () => undefined;
const shutdown = () => {
    if (shuttingDown)
        return;
    shuttingDown = true;
    if (storageSweepStart !== undefined)
        clearImmediate(storageSweepStart);
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
    if (outcomes.some((outcome) => outcome.status === 'rejected'))
        log('local storage cleanup failed');
};
const CURRENT_STORAGE_SWEEPS = [() => maintainFeedbackArtifacts(), () => pruneArtifacts(), () => pruneResults()];
storageSweepStart = setImmediate(() => {
    storageSweepStart = undefined;
    if (shuttingDown)
        return;
    // One pass per process start, plus the writer-driven sweeps of prepare and retire: an unsent
    // archive therefore lives at most until the next start. See the accepted residuals in
    // docs/architecture/residuals/storage.md for why no maintenance timer exists.
    sweepLocalStorage(CURRENT_STORAGE_SWEEPS);
});
storageSweepStart.unref?.();
