import { BRIDGE_COMSPEC_STATES, BRIDGE_IDENTIFIER, BRIDGE_OWNERS, BRIDGE_REGISTRATION_STATES, BRIDGE_RUNTIME_RECHECKS, BRIDGE_RUNTIMES, BRIDGE_STATUS_CODES } from './bridge-codes.mjs';
import { EXTENSION_INSTALL_VOCABULARY, EXTENSION_SNAPSHOT_VOCABULARY, HOST_LAST_FAILURES, MCP_CONFIGURATION_FACTS as MCP_CONFIGURATION, extensionInstallFactsSchema, extensionLogFactsSchema, extensionSnapshotFactsSchema, hookPermissionsFactsSchema, isCanonicalTimestamp, isOsRelease } from './diagnostic-facts.mjs';
import { TRANSPORT_EVENT_KINDS } from './transport-events.mjs';
import { validateSchemaValue } from './schema-validation.mjs';

const STATES = new Set(['passed', 'failed', 'unknown', 'not_checked', 'unsupported']);
const MAX_TEXT_LENGTH = 128;
// The full projection with every evidence check measured about 6 KiB; the report keeps it within twice that and more.
const FEEDBACK_DEVICE_SNAPSHOT_MAX_BYTES = 16 * 1024;

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_TEXT_LENGTH
    && !/[\u0000-\u001f\u007f]/u.test(value) ? value : undefined;
const iso = value => (isCanonicalTimestamp(value) ? value : undefined);
const compact = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
const bool = value => typeof value === 'boolean' ? value : undefined;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0 ? value : undefined;
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
        tabs: value.tabs,
        pendingUpdateVersion: value.pendingUpdateVersion,
    });
    return validateSchemaValue(normalized, extensionSnapshotFactsSchema) ? normalized : undefined;
};

const LAYOUTS = ['installed_plugin', 'canonical_source'];
const packageLayoutFacts = value => (record(value) && onlyKeys(value, ['layout']) && LAYOUTS.includes(value.layout) ? { layout: value.layout } : undefined);
const packageMetadataFacts = name => value => (record(value) && onlyKeys(value, ['name', 'version']) && value.name === name && text(value.version) ? { name, version: value.version } : undefined);
const mcpConfigurationFacts = value => (record(value) && onlyKeys(value, Object.keys(MCP_CONFIGURATION))
    && Object.entries(MCP_CONFIGURATION).every(([key, expected]) => value[key] === expected) ? { ...MCP_CONFIGURATION } : undefined);

const specs = {
    bridgeStatusCollection: { check: 'bridge_status_collection', sources: ['feedback_preparation'], planes: ['device'], causes: ['permission_denied', 'unknown'] },
    snapshot: { check: 'snapshot', sources: ['local_bridge_status'], planes: ['device'], causes: ['unknown'] },
    runtime: { check: 'runtime', sources: ['node_process'], planes: ['device'], causes: ['unknown'], facts: value => {
        if (!record(value)) return undefined;
        const core = { nodeVersion: text(value.nodeVersion), platform: text(value.platform), arch: text(value.arch), bridgeVersion: text(value.bridgeVersion) };
        if (Object.values(core).some(item => item === undefined)) return undefined;
        return compact({ ...core, mcpProtocolVersion: text(value.mcpProtocolVersion), osRelease: isOsRelease(value.osRelease) ? value.osRelease : undefined });
    } },
    // The host that runs the plugin is the first triage fact: Cowork, Claude Code, Codex and DeepSeek differ in
    // hooks, transports and budgets. The values are the bounded strings the client sent in MCP initialize, plus
    // what the native DeepSeek adapter passes through the local module's environment: its Harness runtime version,
    // and the closed class of the module's last failure and how often it was started again.
    client: { check: 'client', sources: ['mcp_initialize'], planes: ['client'], causes: ['unknown'], facts: value =>
        record(value) && value.provenance === 'client_reported' ? compact({ name: text(value.name), version: text(value.version), provenance: 'client_reported',
            hostRuntimeVersion: text(value.hostRuntimeVersion), hostLastFailure: HOST_LAST_FAILURES.includes(value.hostLastFailure) ? value.hostLastFailure : undefined,
            hostRestarts: Number.isSafeInteger(value.hostRestarts) && value.hostRestarts >= 0 ? value.hostRestarts : undefined }) : undefined },
    routeFreshness: { check: 'route_freshness', sources: ['extension_heartbeat'], planes: ['device'], causes: ['unknown'], facts: value => {
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
    extensionLog: { check: 'extension_log', sources: ['browser_profile_storage'], planes: ['device'],
        causes: ['permission_denied', 'io_error', 'directory_absent', 'corrupt', 'unavailable', 'unknown'], facts: exactFacts(extensionLogFactsSchema), strict: true },
};

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

const bridgeStates = new Set(['initializing', 'waiting_for_extension', 'extension_connected_no_wb_tab', 'extension_context_unknown', 'ready', 'extension_update_required']);
const selectStorage = storage => {
    if (!record(storage)) return undefined;
    const selected = compact({ results: storageTarget(storage.results), marketplaceArtifacts: storageTarget(storage.marketplaceArtifacts),
        feedbackArtifacts: storageTarget(storage.feedbackArtifacts) });
    return Object.keys(selected).length ? selected : undefined;
};

// The cause code and the registration and broker facts behind it, as closed values only. Error names and codes come
// from the file system and from a broker's record, so only a short identifier (BRIDGE_IDENTIFIER) is kept. The broker
// nonce, endpoint, process ids and times are never copied.
const MAX_BRIDGE_BROWSERS = 8;
// RegExp.test stringifies its argument, so a null or missing name would pass as "null" and sink the whole block at the
// schema; only a string can be an identifier, and a record that is not one is dropped alone.
const bridgeIdentifier = value => typeof value === 'string' && BRIDGE_IDENTIFIER.test(value);
const version = value => (typeof value === 'string' && EXTENSION_INSTALL_VOCABULARY.version.test(value) ? value : undefined);
// The transport event ring sits beside the diagnostics, outside their 12 KiB cap, within its own 4 KiB: the newest
// events are kept, and selectFeedbackDeviceSnapshot drops the oldest until the whole snapshot fits.
const MAX_TRANSPORT_EVENTS = 32;
const MAX_TRANSPORT_EVENTS_BYTES = 4 * 1024;
const selectTransportEvents = value => {
    const events = (Array.isArray(value) ? value : [])
        .filter(event => record(event) && iso(event.at) && TRANSPORT_EVENT_KINDS.includes(event.kind) && bridgeIdentifier(event.code))
        .map(({ at, kind, code }) => ({ at, kind, code })).slice(-MAX_TRANSPORT_EVENTS);
    while (events.length > 0 && Buffer.byteLength(JSON.stringify(events), 'utf8') > MAX_TRANSPORT_EVENTS_BYTES) events.shift();
    return events.length > 0 ? events : undefined;
};
const selectBridgeFailure = value => (record(value) && bridgeIdentifier(value.name) && (value.code === null || value.code === undefined || bridgeIdentifier(value.code))
    ? { name: value.name, code: value.code ?? null } : undefined);
const selectBridge = value => {
    // The already projected form is re-validated as it is, so projecting a projection changes nothing.
    if (record(value.bridge)) return validateSchemaValue(value.bridge, bridgeBlockSchema) ? value.bridge : undefined;
    if (!BRIDGE_STATUS_CODES.includes(value.code)) return undefined;
    const registration = record(value.registration) ? value.registration : {};
    const brokers = Array.isArray(value.brokers) ? value.brokers : [];
    const hosts = Array.isArray(value.userLevelHosts) ? value.userLevelHosts : [];
    // The browsers, from the closed list only, whose policy matches.
    const policyBrowsers = matches => [...new Set(hosts.filter(host => record(host) && matches(host) && EXTENSION_INSTALL_VOCABULARY.browsers.includes(host.browser)).map(host => host.browser))];
    // The browsers whose policy read observed nothing: their null policy is unknown, not unset.
    const unreadPolicies = [...new Set((Array.isArray(value.policyReadFailed) ? value.policyReadFailed : [])
        .filter(browser => EXTENSION_INSTALL_VOCABULARY.browsers.includes(browser)))];
    // Every running broker's version, and the extension behind the serving broker, or the newest one without a session.
    const brokerVersions = [...new Set(brokers.map(broker => (record(broker) ? version(broker.brokerVersion) : undefined)).filter(Boolean))].slice(0, MAX_BRIDGE_BROWSERS);
    const serving = brokers.find(broker => record(broker) && broker.current === true) ?? brokers[0];
    const lastFailureRecord = selectBridgeFailure(value.lastFailureRecord) ?? null;
    const candidate = compact({
        code: value.code,
        registrationState: BRIDGE_REGISTRATION_STATES.includes(registration.state) ? registration.state : undefined,
        registrationError: selectBridgeFailure(registration.error),
        runtime: BRIDGE_RUNTIMES.includes(registration.runtime) ? registration.runtime : undefined,
        brokerCount: brokers.length,
        browsers: [...new Set(brokers.map(broker => (record(broker) ? text(broker.browser) : undefined)).filter(browser => browser !== undefined))].slice(0, MAX_BRIDGE_BROWSERS),
        userLevelHostsDisabled: policyBrowsers(host => host.allowed === false),
        nativeHostBlocked: policyBrowsers(host => host.hostBlocked === true),
        // Omitted when every read worked.
        policyReadFailed: unreadPolicies.length > 0 ? unreadPolicies : undefined,
        lastFailureRecord,
        // Who can act on the cause, and the facts that named it: the ComSpec state and what the repair re-checked.
        owner: BRIDGE_OWNERS.includes(value.owner) ? value.owner : undefined,
        comspec: BRIDGE_COMSPEC_STATES.includes(value.comspec) ? value.comspec : undefined,
        runtimeRecheck: BRIDGE_RUNTIME_RECHECKS.includes(registration.runtimeRecheck) ? registration.runtimeRecheck : undefined,
        // A version mismatch between the plugin, its brokers and the extension is the first fact support checks.
        brokerVersions: brokerVersions.length > 0 ? brokerVersions : undefined,
        servingBrokerVersion: version(value.brokerVersion),
        extensionVersion: record(serving) ? version(serving.extensionVersion) : undefined,
        lastFailureRecordAt: lastFailureRecord ? iso(value.lastFailureRecord.at) : undefined,
    });
    return validateSchemaValue(candidate, bridgeBlockSchema) ? candidate : undefined;
};

export const selectFeedbackDeviceSnapshot = status => {
    if (!record(status)) return {};
    const extension = record(status.extension) ? compact({
            state: ['never_connected', 'connected', 'disconnected'].includes(status.extension.state) ? status.extension.state : undefined,
            route: ['direct', 'none'].includes(status.extension.route) ? status.extension.route : undefined, version: text(status.extension.version),
            lastConnectedAt: iso(status.extension.lastConnectedAt), lastDisconnectedAt: iso(status.extension.lastDisconnectedAt),
            ozonSellerPromotionReportSupported: bool(status.extension.ozonSellerPromotionReportSupported),
            ozonSellerPromotionReportsSupported: bool(status.extension.ozonSellerPromotionReportsSupported),
            ozonSellerAnalyticsReportSupported: bool(status.extension.ozonSellerAnalyticsReportSupported),
            ozonSearchPositionsSupported: bool(status.extension.ozonSearchPositionsSupported),
        }) : undefined;
    const browserContext = record(status.browserContext) && ['unknown', 'known'].includes(status.browserContext.state) ? compact({
        state: status.browserContext.state, wbTabConnected: bool(status.browserContext.wbTabConnected),
        sellerTabConnected: bool(status.browserContext.sellerTabConnected), changedAt: iso(status.browserContext.changedAt),
    }) : undefined;
    const snapshot = compact({
        bridgeStatusCollection: status.bridgeStatusCollection?.check === 'bridge_status_collection'
            ? selectCheck('bridgeStatusCollection', status.bridgeStatusCollection) : undefined,
        bridgeVersion: text(status.bridgeVersion), extensionProtocolVersion: positiveInteger(status.extensionProtocolVersion),
        state: bridgeStates.has(status.state) ? status.state : undefined,
        bridge: selectBridge(status),
        transportEvents: selectTransportEvents(status.transportEvents),
        extension: extension && Object.keys(extension).length ? extension : undefined,
        browserContext, storage: selectStorage(status.storage), diagnostics: selectFeedbackDeviceDiagnostics(status.diagnostics),
    });
    // The ring yields to the rest: its oldest events leave until the whole snapshot fits its 16 KiB.
    while (snapshot.transportEvents && Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > FEEDBACK_DEVICE_SNAPSHOT_MAX_BYTES) {
        snapshot.transportEvents = snapshot.transportEvents.slice(1);
        if (snapshot.transportEvents.length === 0) delete snapshot.transportEvents;
    }
    return snapshot;
};

const diagnosticTimestamp = { type: 'string', minLength: 24, maxLength: 24, pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' };
const nonNegativeIntegerSchema = { type: 'integer', minimum: 0 };
const diagnosticObject = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const versionSchema = { type: 'string', pattern: EXTENSION_INSTALL_VOCABULARY.version.source };
const bridgeFailureSchema = diagnosticObject({ name: { type: 'string', pattern: BRIDGE_IDENTIFIER.source }, code: { oneOf: [{ type: 'string', pattern: BRIDGE_IDENTIFIER.source }, { type: 'null' }] } }, ['name', 'code']);
const policyBrowsersSchema = { type: 'array', items: { type: 'string', enum: [...EXTENSION_INSTALL_VOCABULARY.browsers] }, uniqueItems: true, maxItems: EXTENSION_INSTALL_VOCABULARY.browsers.length };
const bridgeBlockSchema = diagnosticObject({
    code: { type: 'string', enum: [...BRIDGE_STATUS_CODES] },
    owner: { type: 'string', enum: [...BRIDGE_OWNERS] },
    comspec: { type: 'string', enum: [...BRIDGE_COMSPEC_STATES] },
    runtimeRecheck: { type: 'string', enum: [...BRIDGE_RUNTIME_RECHECKS] },
    registrationState: { type: 'string', enum: [...BRIDGE_REGISTRATION_STATES] },
    registrationError: bridgeFailureSchema,
    runtime: { type: 'string', enum: [...BRIDGE_RUNTIMES] },
    brokerCount: nonNegativeIntegerSchema,
    browsers: { type: 'array', items: { type: 'string', pattern: '^[^\\u0000-\\u001f\\u007f]{1,128}$' }, uniqueItems: true, maxItems: MAX_BRIDGE_BROWSERS },
    userLevelHostsDisabled: policyBrowsersSchema,
    nativeHostBlocked: policyBrowsersSchema,
    policyReadFailed: { ...policyBrowsersSchema, minItems: 1 },
    lastFailureRecord: { oneOf: [bridgeFailureSchema, { type: 'null' }] },
    brokerVersions: { type: 'array', items: versionSchema, uniqueItems: true, minItems: 1, maxItems: MAX_BRIDGE_BROWSERS },
    servingBrokerVersion: versionSchema,
    extensionVersion: versionSchema,
    lastFailureRecordAt: diagnosticTimestamp,
}, ['code', 'brokerCount', 'browsers', 'userLevelHostsDisabled', 'nativeHostBlocked', 'lastFailureRecord']);
