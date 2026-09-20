export const DIAGNOSTIC_STATES = Object.freeze(['passed', 'failed', 'unknown', 'not_checked', 'unsupported']);
export const DIAGNOSTIC_CAUSES = Object.freeze(['permission_denied', 'insecure_permissions', 'missing', 'directory_absent', 'corrupt', 'unsupported', 'io_error', 'address_in_use', 'listen_failed', 'unavailable', 'unknown']);

const safeText = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value);

export const sanitizeClientInfo = (value) => value && safeText(value.name) && safeText(value.version)
    ? Object.freeze({ name: value.name, version: value.version }) : null;

export const diagnosticCheck = (/** @type {any} */ input) => {
    const { check, state, observedAt, source, executionPlane, facts, cause, evidenceRefs, nextCheck } = input;
    if (!DIAGNOSTIC_STATES.includes(state)) throw new TypeError(`Unrecognized diagnostic state: ${state}`);
    if (cause !== undefined && !DIAGNOSTIC_CAUSES.includes(cause)) throw new TypeError(`Unrecognized diagnostic cause: ${cause}`);
    return Object.freeze({ check, state, observedAt, source, executionPlane,
        ...(facts === undefined ? {} : { facts: Object.freeze(facts) }),
        ...(cause === undefined ? {} : { cause }),
        ...(evidenceRefs === undefined ? {} : { evidenceRefs: Object.freeze([...evidenceRefs]) }),
        ...(nextCheck === undefined ? {} : { nextCheck }),
    });
};

export const collectStaticFacts = (/** @type {any} */ input) => {
    const { platform, arch, versions = {}, storageLayout = {}, pairingObservation, observedAt = new Date().toISOString() } = input;
    const checks = [
        diagnosticCheck({ check: 'runtime', state: 'passed', observedAt, source: 'node_process', executionPlane: 'device', facts: {
            nodeVersion: versions.node, platform, arch, ...(versions.bridge ? { bridgeVersion: versions.bridge } : {}),
            ...(versions.mcp ? { mcpProtocolVersion: versions.mcp } : {}),
        } }),
        diagnosticCheck({ check: 'storage', state: 'passed', observedAt, source: 'resolved_configuration', executionPlane: 'device', facts: {
            scope: 'configuration', targets: Object.fromEntries(Object.entries(storageLayout).map(([name, target]) => [name,
                target?.state === 'ready' ? { state: 'ready', backend: target.backend } : { state: 'unavailable', reason: target?.reason ?? 'invalid_path' }
            ])),
        } }),
    ];
    if (pairingObservation) checks.push(diagnosticCheck({ check: 'pairing_source', state: pairingObservation.state === 'passed' ? 'passed' : 'failed', observedAt: pairingObservation.observedAt ?? observedAt,
        source: 'peer_token_source', executionPlane: 'device', ...(pairingObservation.reason ? { cause: pairingObservation.reason } : {}) }));
    return checks;
};

// A canonical 24-character UTC timestamp, the only time form every report consumer accepts.
export const isCanonicalTimestamp = (value) => {
    if (typeof value !== 'string' || value.length !== 24 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value;
};

// The fact vocabularies below are the producers' own: the probes validate their output against these
// schemas, the tool catalog publishes them, and the feedback projection admits exactly what they admit.
// One definition means a family added on the producer side can never silently vanish from a report.
const closed = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const list = (items, extra = {}) => ({ type: 'array', items, ...extra });
const string = { type: 'string' };
const boolean = { type: 'boolean' };
const nonNegativeInteger = { type: 'integer', minimum: 0 };
const enumeration = (values) => ({ type: 'string', enum: [...values] });

export const HOOK_PERMISSIONS_VOCABULARY = Object.freeze({
    events: Object.freeze(['preToolUse', 'postToolUse', 'postToolUseFailure', 'unknown']),
    families: Object.freeze(['browser_authorization_restore', 'browser_authorization_capture', 'update_check', 'feedback_authorization_restore',
        'feedback_authorization_capture', 'feedback_cloud_processing', 'feedback_failure_recovery', 'plugin_hook']),
    trust: Object.freeze(['trusted', 'untrusted', 'modified', 'managed', 'unknown']),
    trustCounters: Object.freeze(['trusted', 'untrusted', 'modified', 'managed']),
    statuses: Object.freeze(['ready', 'disabled', 'review_required', 'missing', 'incomplete_inventory', 'unsupported']),
    installationMatch: Object.freeze(['matched', 'not_verified']),
    failureReasons: Object.freeze(['timeout', 'process_missing', 'permission_denied', 'process_closed', 'protocol_error', 'response_too_large']),
    failurePhases: Object.freeze(['startup', 'initialize', 'request', 'response', 'transport']),
    inspector: 'transient_config_reader',
});
const hookPermissionsInventoryFactsSchema = closed({
    host: { const: 'codex' }, context: { const: 'configuration_snapshot' },
    configured: nonNegativeInteger, enabled: nonNegativeInteger,
    trust: closed(Object.fromEntries(HOOK_PERMISSIONS_VOCABULARY.trustCounters.map((key) => [key, nonNegativeInteger])), [...HOOK_PERMISSIONS_VOCABULARY.trustCounters]),
    hooks: list(closed({
        eventName: enumeration(HOOK_PERMISSIONS_VOCABULARY.events), family: enumeration(HOOK_PERMISSIONS_VOCABULARY.families),
        enabled: boolean, trustStatus: enumeration(HOOK_PERMISSIONS_VOCABULARY.trust),
    }, ['eventName', 'family', 'enabled', 'trustStatus'])),
    warnings: boolean, errors: boolean,
    status: enumeration(HOOK_PERMISSIONS_VOCABULARY.statuses),
    inspector: { const: HOOK_PERMISSIONS_VOCABULARY.inspector },
    installationMatch: enumeration(HOOK_PERMISSIONS_VOCABULARY.installationMatch),
    currentApplicationMatch: { const: 'not_verified' },
    missing: list(string, { uniqueItems: true }),
}, ['host', 'context', 'configured', 'enabled', 'trust', 'hooks', 'warnings', 'errors', 'status', 'inspector', 'installationMatch', 'currentApplicationMatch']);
const hookPermissionsFailureFactsSchema = closed({
    host: { const: 'codex' }, context: { const: 'configuration_probe' }, inspector: { const: HOOK_PERMISSIONS_VOCABULARY.inspector },
    status: { const: 'failed' },
    failure: closed({ reason: enumeration(HOOK_PERMISSIONS_VOCABULARY.failureReasons), phase: enumeration(HOOK_PERMISSIONS_VOCABULARY.failurePhases) }, ['reason', 'phase']),
}, ['host', 'context', 'inspector', 'status', 'failure']);
export const hookPermissionsFactsSchema = { type: 'object', oneOf: [hookPermissionsInventoryFactsSchema, hookPermissionsFailureFactsSchema] };

export const EXTENSION_INSTALL_VOCABULARY = Object.freeze({
    browsers: Object.freeze(['chrome', 'edge', 'yandex', 'opera']),
    profileSources: Object.freeze(['local_state', 'default_only']),
    counters: Object.freeze(['profilesChecked', 'installedProfiles', 'enabledProfiles', 'unknownProfiles', 'readFailures']),
    extensionId: /^[a-p]{32}$/,
    version: /^[\w.+-]{1,32}$/,
});
export const extensionInstallFactsSchema = closed({
    extensionId: { type: 'string', pattern: EXTENSION_INSTALL_VOCABULARY.extensionId.source },
    browsers: list(closed({
        browser: enumeration(EXTENSION_INSTALL_VOCABULARY.browsers),
        profileSource: enumeration(EXTENSION_INSTALL_VOCABULARY.profileSources),
        ...Object.fromEntries(EXTENSION_INSTALL_VOCABULARY.counters.map((key) => [key, nonNegativeInteger])),
        versions: list({ type: 'string', pattern: EXTENSION_INSTALL_VOCABULARY.version.source }, { uniqueItems: true }),
        lastUsedDaysAgo: nonNegativeInteger,
    }, ['browser', 'profileSource', ...EXTENSION_INSTALL_VOCABULARY.counters, 'versions'])),
}, ['extensionId', 'browsers']);

// The report-side shape of one negotiated diagnostic_snapshot_v1. The wire validator in the extension
// protocol admits any short strings for the time and version and an unbounded capability list; here
// the canonical time and a non-empty version are optional, so a looser extension build keeps its
// activation, storage and port facts in a report instead of losing the whole observation.
export const EXTENSION_SNAPSHOT_VOCABULARY = Object.freeze({
    keys: Object.freeze(['protocolVersion', 'observedAt', 'extensionVersion', 'capabilities', 'activationIdentity', 'storageRead', 'ports']),
    activation: Object.freeze(['present', 'absent', 'unknown']),
    storageRead: Object.freeze(['passed', 'failed', 'unknown']),
    ports: Object.freeze(['wb', 'wbSeller', 'ozon']),
});
const portSchema = { oneOf: [boolean, { const: 'unknown' }] };
export const extensionSnapshotFactsSchema = closed({
    protocolVersion: { const: 1 },
    observedAt: { type: 'string', minLength: 24, maxLength: 24 },
    extensionVersion: { type: 'string', minLength: 1, maxLength: 128 },
    capabilities: list({ type: 'string', minLength: 1, maxLength: 128 }),
    activationIdentity: closed({ state: enumeration(EXTENSION_SNAPSHOT_VOCABULARY.activation) }, ['state']),
    storageRead: closed({ state: enumeration(EXTENSION_SNAPSHOT_VOCABULARY.storageRead) }, ['state']),
    ports: closed(Object.fromEntries(EXTENSION_SNAPSHOT_VOCABULARY.ports.map((key) => [key, portSchema])), [...EXTENSION_SNAPSHOT_VOCABULARY.ports]),
}, ['protocolVersion', 'capabilities', 'activationIdentity', 'storageRead', 'ports']);
