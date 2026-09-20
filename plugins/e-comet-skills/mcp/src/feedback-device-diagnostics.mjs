import { PEER_REJECTION_CODES } from './connection-state.mjs';
import { EXTENSION_SNAPSHOT_VOCABULARY, extensionInstallFactsSchema, extensionSnapshotFactsSchema, hookPermissionsFactsSchema, isCanonicalTimestamp } from './diagnostic-facts.mjs';
import { validateSchemaValue } from './schema-validation.mjs';

const STATES = new Set(['passed', 'failed', 'unknown', 'not_checked', 'unsupported']);
const MAX_TEXT_LENGTH = 128;
// The cloud hook validates the device projection before it can enter an archive; these caps bound that
// untrusted input. The full projection with every evidence check measured about 6 KiB, so both keep
// twofold headroom without admitting an unbounded placeholder. The margin is measured, not enforced on
// the device: see the accepted residual "Device projection caps are a measured margin, not an enforced
// one" in docs/local-agent-architecture.md#accepted-residuals before reporting the gate again.
export const FEEDBACK_DEVICE_DIAGNOSTICS_MAX_BYTES = 12 * 1024;
export const FEEDBACK_DEVICE_SNAPSHOT_MAX_BYTES = 16 * 1024;

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_TEXT_LENGTH
    && !/[\u0000-\u001f\u007f]/u.test(value) ? value : undefined;
const iso = value => (isCanonicalTimestamp(value) ? value : undefined);
// A millisecond mark past the four-digit-year range renders as an expanded 27-character year that no
// consumer accepts, so it is dropped as one optional field rather than carried into the projection.
const isoFromMs = value => iso(Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? new Date(value).toISOString() : undefined);
const compact = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
const bool = value => typeof value === 'boolean' ? value : undefined;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0 ? value : undefined;
const nonNegativeInteger = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const onlyKeys = (value, keys) => Object.keys(value).every(key => keys.includes(key));
const exactFacts = schema => value => (validateSchemaValue(value, schema) ? value : undefined);

const storageTarget = value => {
    if (!record(value)) return undefined;
    if (value.state === 'ready' && ['plugin_data', 'application_data', 'override'].includes(value.backend))
        return { state: 'ready', backend: value.backend };
    if (value.state === 'unavailable' && ['plugin_data_missing', 'plugin_data_invalid', 'plugin_data_conflict', 'application_data_invalid', 'override_invalid'].includes(value.reason))
        return { state: 'unavailable', reason: value.reason };
    return undefined;
};

// The wire admits a looser snapshot than a report should carry: keep the canonical time and a
// non-empty version only when they are canonical, keep every safe capability, and let the shared
// schema decide the closed fields. An unknown key is a forged placeholder, never a real extension.
// Capability strings reach the archive as the extension wrote them; see the accepted residual
// "Extension-authored capability strings are archived unredacted" in
// docs/local-agent-architecture.md#accepted-residuals for why redacting the serialized document is worse.
const extensionSnapshotFacts = value => {
    if (!record(value) || !onlyKeys(value, EXTENSION_SNAPSHOT_VOCABULARY.keys) || !record(value.activationIdentity) || !record(value.storageRead) || !record(value.ports)) return undefined;
    const normalized = compact({
        protocolVersion: value.protocolVersion,
        observedAt: iso(value.observedAt),
        extensionVersion: text(value.extensionVersion),
        capabilities: Array.isArray(value.capabilities) ? value.capabilities.filter(item => text(item) !== undefined) : undefined,
        activationIdentity: { state: value.activationIdentity.state },
        storageRead: { state: value.storageRead.state },
        ports: Object.fromEntries(EXTENSION_SNAPSHOT_VOCABULARY.ports.map(key => [key, value.ports[key]])),
    });
    return validateSchemaValue(normalized, extensionSnapshotFactsSchema) ? normalized : undefined;
};

const LAYOUTS = ['installed_plugin', 'canonical_source'];
const packageLayoutFacts = value => (record(value) && onlyKeys(value, ['layout']) && LAYOUTS.includes(value.layout) ? { layout: value.layout } : undefined);
const packageMetadataFacts = name => value => (record(value) && onlyKeys(value, ['name', 'version']) && value.name === name && text(value.version) ? { name, version: value.version } : undefined);
const MCP_CONFIGURATION = Object.freeze({ transport: 'stdio', command: 'node', cwd: '.', entrypoint: 'mcp/src/server.mjs' });
const mcpConfigurationFacts = value => (record(value) && onlyKeys(value, Object.keys(MCP_CONFIGURATION))
    && Object.entries(MCP_CONFIGURATION).every(([key, expected]) => value[key] === expected) ? { ...MCP_CONFIGURATION } : undefined);

const specs = {
    bridgeStatusCollection: { check: 'bridge_status_collection', sources: ['feedback_preparation'], planes: ['device'], causes: ['permission_denied', 'unknown'] },
    snapshot: { check: 'snapshot', sources: ['local_bridge_status'], planes: ['device'], causes: ['unknown'] },
    runtime: { check: 'runtime', sources: ['node_process'], planes: ['device'], causes: ['unknown'], facts: value => {
        if (!record(value)) return undefined;
        const core = { nodeVersion: text(value.nodeVersion), platform: text(value.platform), arch: text(value.arch), bridgeVersion: text(value.bridgeVersion) };
        if (Object.values(core).some(item => item === undefined)) return undefined;
        return compact({ ...core, mcpProtocolVersion: text(value.mcpProtocolVersion) });
    } },
    // The host that runs the plugin is the first triage fact: Cowork, Claude Code and Codex differ in hooks,
    // transports and budgets. The values are the bounded strings the client sent in MCP initialize.
    client: { check: 'client', sources: ['mcp_initialize'], planes: ['client'], causes: ['unknown'], facts: value =>
        record(value) && value.provenance === 'client_reported' ? compact({ name: text(value.name), version: text(value.version), provenance: 'client_reported' }) : undefined },
    listener: { check: 'listener', sources: ['bridge_runtime'], planes: ['device'], causes: ['address_in_use', 'listen_failed', 'unknown'], facts: value => {
        if (!record(value) || value.operation !== 'bind_listener' || !['pending', 'listening', 'address_in_use', 'failed'].includes(value.listenerState)) return undefined;
        return compact({ operation: 'bind_listener', listenerState: value.listenerState,
            systemCode: ['EACCES', 'EPERM', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EINVAL'].includes(value.systemCode) ? value.systemCode : undefined });
    } },
    pairingSource: { check: 'pairing_source', sources: ['peer_token_source'], planes: ['device'], causes: ['permission_denied', 'insecure_permissions', 'missing', 'corrupt', 'unsupported', 'io_error'] },
    routeFreshness: { check: 'route_freshness', sources: ['extension_heartbeat'], planes: ['device', 'peer'], causes: ['unknown'], facts: value => {
        const lastObservedAt = record(value) ? iso(value.lastObservedAt) : undefined;
        return lastObservedAt ? { lastObservedAt } : undefined;
    } },
    storage: { check: 'storage', sources: ['resolved_configuration'], planes: ['device'], causes: ['unknown'], facts: value => {
        if (!record(value) || value.scope !== 'configuration' || !record(value.targets)) return undefined;
        const targets = compact({ results: storageTarget(value.targets.results), marketplaceArtifacts: storageTarget(value.targets.marketplaceArtifacts),
            feedbackArtifacts: storageTarget(value.targets.feedbackArtifacts) });
        return Object.keys(targets).length ? { scope: 'configuration', targets } : undefined;
    } },
    // Evidence collected at preparation time: one read-only extension snapshot, the packaged installation
    // facts, where the extension is installed, and on Codex the hook trust state. Facts are admitted by
    // the producers' own schemas; anything outside them drops the whole check rather than half of it.
    extensionSnapshot: { check: 'extension_snapshot', sources: ['extension', 'capability_negotiation', 'device_process'], planes: ['device'],
        causes: ['unsupported', 'unavailable', 'corrupt', 'unknown'], facts: extensionSnapshotFacts, strict: true },
    packageLayout: { check: 'package_layout', sources: ['module_location'], planes: ['device'], causes: ['unknown'], facts: packageLayoutFacts, strict: true },
    packageMetadata: { check: 'package_metadata', sources: ['package_metadata'], planes: ['device'], causes: ['missing', 'corrupt', 'io_error'], facts: packageMetadataFacts('@e-comet/local-mcp'), strict: true },
    codexManifest: { check: 'codex_manifest', sources: ['package_metadata'], planes: ['device'], causes: ['missing', 'corrupt', 'io_error'], facts: packageMetadataFacts('e-comet-skills'), strict: true },
    mcpConfiguration: { check: 'mcp_configuration', sources: ['package_metadata'], planes: ['device'], causes: ['missing', 'corrupt', 'io_error'], facts: mcpConfigurationFacts, strict: true },
    entrypoint: { check: 'entrypoint', sources: ['filesystem_metadata'], planes: ['device'], causes: ['missing', 'io_error'], strict: true },
    extensionInstall: { check: 'extension_install', sources: ['browser_profile_metadata'], planes: ['device'],
        causes: ['permission_denied', 'io_error', 'directory_absent', 'unknown'], facts: exactFacts(extensionInstallFactsSchema), strict: true },
    hookPermissions: { check: 'hook_permissions', sources: ['codex_hooks_list', 'device_process'], planes: ['device'],
        causes: ['permission_denied', 'missing', 'unavailable', 'unsupported', 'unknown'], facts: exactFacts(hookPermissionsFactsSchema), strict: true },
};

export const feedbackDeviceDiagnosticsFailure = (error, now = Date.now) => ({
    bridgeStatusCollection: {
        check: 'bridge_status_collection', state: 'failed', observedAt: new Date(now()).toISOString(),
        source: 'feedback_preparation', executionPlane: 'device',
        cause: ['EACCES', 'EPERM'].includes(error?.code) ? 'permission_denied' : 'unknown',
    },
});

const selectCheck = (slot, value) => {
    const spec = specs[slot];
    if (!spec || !record(value) || value.check !== spec.check || !STATES.has(value.state)
        || !spec.sources.includes(value.source) || !spec.planes.includes(value.executionPlane)) return undefined;
    const observedAt = iso(value.observedAt);
    if (!observedAt) return undefined;
    const cause = value.cause === undefined ? undefined : spec.causes.includes(value.cause) ? value.cause : null;
    if (cause === null) return undefined;
    const facts = spec.facts?.(value.facts);
    // Status checks keep their safe fields and shed unknown ones. Evidence checks are strict: facts the
    // producer's own schema does not admit drop the whole check, because a check that kept its state
    // while losing its facts would read as a clean observation of something never observed.
    if (spec.strict && value.facts !== undefined && facts === undefined) return undefined;
    return compact({ check: spec.check, state: value.state, observedAt, source: value.source,
        executionPlane: value.executionPlane, cause, ...(facts && Object.keys(facts).length ? { facts } : {}) });
};

export const selectFeedbackDeviceDiagnostics = value => {
    if (!record(value)) return undefined;
    const selected = {};
    for (const slot of Object.keys(specs)) {
        const check = selectCheck(slot, value[slot]);
        if (check) selected[slot] = check;
    }
    return Object.keys(selected).length ? selected : undefined;
};

const bridgeStates = new Set(['initializing', 'listen_failed', 'waiting_for_extension', 'extension_connected_no_wb_tab', 'extension_contended', 'extension_context_unknown', 'peer_context_unknown', 'ready', 'extension_update_required', 'peer_reconnecting', 'peer_unavailable']);
const peerRejectionCodes = new Set(Object.values(PEER_REJECTION_CODES));
const selectStorage = storage => {
    if (!record(storage)) return undefined;
    const selected = compact({ results: storageTarget(storage.results), marketplaceArtifacts: storageTarget(storage.marketplaceArtifacts),
        feedbackArtifacts: storageTarget(storage.feedbackArtifacts) });
    return Object.keys(selected).length ? selected : undefined;
};
// The device status carries the raw millisecond mark; the projection carries ISO time, so the cloud
// re-projection accepts the already projected form as well.
const selectTakeovers = value => {
    if (!record(value)) return undefined;
    const count = nonNegativeInteger(value.count);
    const saturated = bool(value.saturated);
    if (count === undefined || saturated === undefined) return undefined;
    return compact({ count, saturated, lastAt: iso(value.lastAt) ?? isoFromMs(value.lastAtMs) });
};
const selectPeerRejection = value => (record(value) && peerRejectionCodes.has(value.code)
    ? compact({ code: value.code, since: iso(value.since), retryAt: iso(value.retryAt) }) : undefined);

export const selectFeedbackDeviceSnapshot = status => {
    if (!record(status)) return {};
    const extension = record(status.extension) ? compact({
            state: ['never_connected', 'connected', 'disconnected'].includes(status.extension.state) ? status.extension.state : undefined,
            route: ['direct', 'peer', 'none'].includes(status.extension.route) ? status.extension.route : undefined, version: text(status.extension.version),
            lastConnectedAt: iso(status.extension.lastConnectedAt), lastDisconnectedAt: iso(status.extension.lastDisconnectedAt),
            ozonSellerPromotionReportSupported: bool(status.extension.ozonSellerPromotionReportSupported),
            ozonSellerPromotionReportsSupported: bool(status.extension.ozonSellerPromotionReportsSupported),
            ozonSellerAnalyticsReportSupported: bool(status.extension.ozonSellerAnalyticsReportSupported),
        }) : undefined;
    const peer = record(status.peer) ? compact({ bridgeVersion: text(status.peer.bridgeVersion),
        browserContextPropagationSupported: bool(status.peer.browserContextPropagationSupported) }) : undefined;
    const browserContext = record(status.browserContext) && ['unknown', 'known'].includes(status.browserContext.state) ? compact({
        state: status.browserContext.state, wbTabConnected: bool(status.browserContext.wbTabConnected),
        sellerTabConnected: bool(status.browserContext.sellerTabConnected), changedAt: iso(status.browserContext.changedAt),
    }) : undefined;
    return compact({
        bridgeStatusCollection: status.bridgeStatusCollection?.check === 'bridge_status_collection'
            ? selectCheck('bridgeStatusCollection', status.bridgeStatusCollection) : undefined,
        bridgeVersion: text(status.bridgeVersion), bridgeGeneration: positiveInteger(status.bridgeGeneration),
        controlProtocolVersion: positiveInteger(status.controlProtocolVersion), extensionProtocolVersion: positiveInteger(status.extensionProtocolVersion),
        state: bridgeStates.has(status.state) ? status.state : undefined,
        extension: extension && Object.keys(extension).length ? extension : undefined, peer: peer && Object.keys(peer).length ? peer : undefined,
        extensionTakeovers: selectTakeovers(status.extensionTakeovers),
        peerRejection: selectPeerRejection(status.peerRejection),
        browserContext, storage: selectStorage(status.storage), diagnostics: selectFeedbackDeviceDiagnostics(status.diagnostics),
    });
};

export const isValidFeedbackDeviceSnapshot = value => {
    if (!record(value)) return false;
    const selected = selectFeedbackDeviceSnapshot(value);
    if (!isValidFeedbackDeviceDiagnostics(value.diagnostics)) return false;
    if (value.extension !== undefined && (!record(value.extension) || value.extension.state === undefined || value.extension.route === undefined)) return false;
    if (value.storage !== undefined && (!record(value.storage) || !['results', 'marketplaceArtifacts', 'feedbackArtifacts'].every(key => Object.hasOwn(value.storage, key)))) return false;
    return Object.keys(selected).length > 0 && exact(value, selected) && Buffer.byteLength(JSON.stringify(value), 'utf8') <= FEEDBACK_DEVICE_SNAPSHOT_MAX_BYTES;
};

const exact = (left, right) => {
    if (left === right) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => exact(item, right[index]));
    }
    if (!record(left) || !record(right)) return false;
    const leftKeys = Object.keys(left); const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length && leftKeys.every(key => Object.hasOwn(right, key) && exact(left[key], right[key]));
};

export const isValidFeedbackDeviceDiagnostics = value => {
    const selected = selectFeedbackDeviceDiagnostics(value);
    return selected !== undefined && exact(value, selected) && Buffer.byteLength(JSON.stringify(value), 'utf8') <= FEEDBACK_DEVICE_DIAGNOSTICS_MAX_BYTES;
};

const diagnosticString = { type: 'string', minLength: 1, maxLength: MAX_TEXT_LENGTH };
const diagnosticTimestamp = { type: 'string', minLength: 24, maxLength: 24, pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' };
const nonNegativeIntegerSchema = { type: 'integer', minimum: 0 };
const diagnosticObject = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const checkSchema = (check, sources, planes, facts, causes) => diagnosticObject({
    check: { const: check }, state: { type: 'string', enum: [...STATES] }, observedAt: diagnosticTimestamp,
    source: { type: 'string', enum: sources }, executionPlane: { type: 'string', enum: planes },
    ...(facts ? { facts } : {}), cause: { type: 'string', enum: causes },
}, ['check', 'state', 'observedAt', 'source', 'executionPlane']);
const storageTargetSchema = { type: 'object', oneOf: [
    diagnosticObject({ state: { const: 'ready' }, backend: { type: 'string', enum: ['plugin_data', 'application_data', 'override'] } }, ['state', 'backend']),
    diagnosticObject({ state: { const: 'unavailable' }, reason: { type: 'string', enum: ['plugin_data_missing', 'plugin_data_invalid', 'plugin_data_conflict', 'application_data_invalid', 'override_invalid'] } }, ['state', 'reason']),
] };
const packageMetadataSchema = name => diagnosticObject({ name: { const: name }, version: diagnosticString }, ['name', 'version']);
export const feedbackDeviceDiagnosticsSchema = diagnosticObject({
    bridgeStatusCollection: checkSchema('bridge_status_collection', ['feedback_preparation'], ['device'], undefined, ['permission_denied', 'unknown']),
    snapshot: checkSchema('snapshot', ['local_bridge_status'], ['device'], undefined, ['unknown']),
    runtime: checkSchema('runtime', ['node_process'], ['device'], diagnosticObject({ nodeVersion: diagnosticString, platform: diagnosticString,
        arch: diagnosticString, bridgeVersion: diagnosticString, mcpProtocolVersion: diagnosticString }, ['nodeVersion', 'platform', 'arch', 'bridgeVersion']), ['unknown']),
    client: checkSchema('client', ['mcp_initialize'], ['client'], diagnosticObject({ name: diagnosticString, version: diagnosticString, provenance: { const: 'client_reported' } }, ['provenance']), ['unknown']),
    listener: checkSchema('listener', ['bridge_runtime'], ['device'], diagnosticObject({ operation: { const: 'bind_listener' },
        listenerState: { type: 'string', enum: ['pending', 'listening', 'address_in_use', 'failed'] },
        systemCode: { type: 'string', enum: ['EACCES', 'EPERM', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EINVAL'] } }, ['operation', 'listenerState']), ['address_in_use', 'listen_failed', 'unknown']),
    pairingSource: checkSchema('pairing_source', ['peer_token_source'], ['device'], undefined, ['permission_denied', 'insecure_permissions', 'missing', 'corrupt', 'unsupported', 'io_error']),
    routeFreshness: checkSchema('route_freshness', ['extension_heartbeat'], ['device', 'peer'], diagnosticObject({ lastObservedAt: diagnosticTimestamp }, ['lastObservedAt']), ['unknown']),
    storage: checkSchema('storage', ['resolved_configuration'], ['device'], diagnosticObject({ scope: { const: 'configuration' },
        targets: diagnosticObject({ results: storageTargetSchema, marketplaceArtifacts: storageTargetSchema, feedbackArtifacts: storageTargetSchema }, []) }, ['scope', 'targets']), ['unknown']),
    extensionSnapshot: checkSchema('extension_snapshot', ['extension', 'capability_negotiation', 'device_process'], ['device'], extensionSnapshotFactsSchema, ['unsupported', 'unavailable', 'corrupt', 'unknown']),
    packageLayout: checkSchema('package_layout', ['module_location'], ['device'], diagnosticObject({ layout: { type: 'string', enum: LAYOUTS } }, ['layout']), ['unknown']),
    packageMetadata: checkSchema('package_metadata', ['package_metadata'], ['device'], packageMetadataSchema('@e-comet/local-mcp'), ['missing', 'corrupt', 'io_error']),
    codexManifest: checkSchema('codex_manifest', ['package_metadata'], ['device'], packageMetadataSchema('e-comet-skills'), ['missing', 'corrupt', 'io_error']),
    mcpConfiguration: checkSchema('mcp_configuration', ['package_metadata'], ['device'],
        diagnosticObject(Object.fromEntries(Object.entries(MCP_CONFIGURATION).map(([key, value]) => [key, { const: value }])), Object.keys(MCP_CONFIGURATION)), ['missing', 'corrupt', 'io_error']),
    entrypoint: checkSchema('entrypoint', ['filesystem_metadata'], ['device'], undefined, ['missing', 'io_error']),
    extensionInstall: checkSchema('extension_install', ['browser_profile_metadata'], ['device'], extensionInstallFactsSchema, ['permission_denied', 'io_error', 'directory_absent', 'unknown']),
    hookPermissions: checkSchema('hook_permissions', ['codex_hooks_list', 'device_process'], ['device'], hookPermissionsFactsSchema, ['permission_denied', 'missing', 'unavailable', 'unsupported', 'unknown']),
}, []);

export const feedbackDeviceSnapshotSchema = diagnosticObject({
    bridgeStatusCollection: feedbackDeviceDiagnosticsSchema.properties.bridgeStatusCollection,
    bridgeVersion: diagnosticString,
    bridgeGeneration: { type: 'integer', minimum: 1 }, controlProtocolVersion: { type: 'integer', minimum: 1 }, extensionProtocolVersion: { type: 'integer', minimum: 1 },
    state: { type: 'string', enum: [...bridgeStates] },
    extension: diagnosticObject({ state: { type: 'string', enum: ['never_connected', 'connected', 'disconnected'] }, route: { type: 'string', enum: ['direct', 'peer', 'none'] },
        version: diagnosticString, lastConnectedAt: diagnosticTimestamp, lastDisconnectedAt: diagnosticTimestamp,
        ozonSellerPromotionReportSupported: { type: 'boolean' }, ozonSellerPromotionReportsSupported: { type: 'boolean' }, ozonSellerAnalyticsReportSupported: { type: 'boolean' } }, ['state', 'route']),
    peer: diagnosticObject({ bridgeVersion: diagnosticString, browserContextPropagationSupported: { type: 'boolean' } }, []),
    extensionTakeovers: diagnosticObject({ count: nonNegativeIntegerSchema, saturated: { type: 'boolean' }, lastAt: diagnosticTimestamp }, ['count', 'saturated']),
    peerRejection: diagnosticObject({ code: { type: 'string', enum: [...peerRejectionCodes] }, since: diagnosticTimestamp, retryAt: diagnosticTimestamp }, ['code']),
    browserContext: diagnosticObject({ state: { type: 'string', enum: ['unknown', 'known'] }, wbTabConnected: { type: 'boolean' }, sellerTabConnected: { type: 'boolean' }, changedAt: diagnosticTimestamp }, ['state']),
    storage: diagnosticObject({ results: storageTargetSchema, marketplaceArtifacts: storageTargetSchema, feedbackArtifacts: storageTargetSchema }, []),
    diagnostics: feedbackDeviceDiagnosticsSchema,
}, []);
