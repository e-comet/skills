export const DIAGNOSTIC_STATES = Object.freeze(['passed', 'failed', 'unknown', 'not_checked', 'unsupported']);
export const MCP_CONFIGURATION_FACTS = Object.freeze({ transport: 'stdio', command: 'node', cwd: '.', entrypoint: 'mcp/src/server.mjs' });
export const DIAGNOSTIC_CAUSES = Object.freeze(['permission_denied', 'missing', 'directory_absent', 'corrupt', 'unsupported', 'io_error', 'unavailable', 'unknown']);

const safeText = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value);

export const sanitizeClientInfo = (value) => value && safeText(value.name) && safeText(value.version)
    ? Object.freeze({ name: value.name, version: value.version }) : null;

// The DeepSeek Harness runtime version the native adapter passes to the local module: one bounded version grammar
// shared by the adapter that reads it from the resolved peer manifest and the server that admits it into facts.
export const isHostRuntimeVersion = (value) => typeof value === 'string' && /^[0-9A-Za-z.+-]{1,64}$/.test(value);
// The operating system's own release string (os.release()): Windows `10.0.26200`, macOS `24.1.0`, Linux kernels with a
// vendor suffix. The same bounded grammar, plus the underscore some kernels carry.
export const isOsRelease = (value) => typeof value === 'string' && /^[0-9A-Za-z._+-]{1,64}$/.test(value);
// What the native DeepSeek adapter passes about the local module it restarted: the closed class of the last failure
// (runtime.mjs localFailureOf) and how many times it started the module again.
export const HOST_LAST_FAILURES = Object.freeze(['spawn_failed', 'timeout', 'exited', 'protocol', 'unknown']);
export const hostRestartFacts = (/** @type {Record<string, string | undefined>} */ env) => ({
    ...(HOST_LAST_FAILURES.includes(/** @type {string} */ (env.ECOMET_HOST_LAST_FAILURE)) ? { hostLastFailure: env.ECOMET_HOST_LAST_FAILURE } : {}),
    ...(/^\d{1,6}$/.test(env.ECOMET_HOST_RESTARTS ?? '') ? { hostRestarts: Number(env.ECOMET_HOST_RESTARTS) } : {}),
});

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
    const { platform, arch, versions = {}, storageLayout = {}, observedAt = new Date().toISOString() } = input;
    return [
        diagnosticCheck({ check: 'runtime', state: 'passed', observedAt, source: 'node_process', executionPlane: 'device', facts: {
            nodeVersion: versions.node, platform, arch, ...(versions.bridge ? { bridgeVersion: versions.bridge } : {}),
            ...(versions.mcp ? { mcpProtocolVersion: versions.mcp } : {}),
            ...(isOsRelease(versions.os) ? { osRelease: versions.os } : {}),
        } }),
        diagnosticCheck({ check: 'storage', state: 'passed', observedAt, source: 'resolved_configuration', executionPlane: 'device', facts: {
            scope: 'configuration', targets: Object.fromEntries(Object.entries(storageLayout).map(([name, target]) => [name,
                target?.state === 'ready' ? { state: 'ready', backend: target.backend } : { state: 'unavailable', reason: target?.reason ?? 'invalid_path' }
            ])),
        } }),
    ];
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
        'feedback_authorization_capture', 'plugin_hook']),
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
    browsers: Object.freeze(['chrome', 'edge', 'brave', 'yandex', 'opera']),
    profileSources: Object.freeze(['local_state', 'default_only']),
    profileStates: Object.freeze(['enabled', 'disabled', 'unknown']),
    extensionId: /^[a-p]{32}$/,
    // The directory names Chromium gives a profile, and `other` for a directory it did not name that way: any other
    // name would be free text, and an unusual directory name can identify its owner, in a report.
    profile: /^(?:Default|Profile [1-9]\d{0,2}|other)$/,
    version: /^[\w.+-]{1,32}$/,
    // At most 31 distinct reason values, each from 1 to 1 << 30: Chromium 155 stores a list of values, and an older
    // bitmask splits into at most 31 bits.
    maxDisableReasons: 31,
    maxDisableReason: 2 ** 30,
    // Generous for a person's browser profiles; the cap keeps the report projection bounded (accepted residual
    // "Device projection caps are a measured margin" in docs/local-agent-architecture.md#accepted-residuals).
    maxProfiles: 32,
});
const extensionVersion = { type: 'string', pattern: EXTENSION_INSTALL_VOCABULARY.version.source };
const extensionProfileSchema = closed({
    profile: { type: 'string', pattern: EXTENSION_INSTALL_VOCABULARY.profile.source },
    state: enumeration(EXTENSION_INSTALL_VOCABULARY.profileStates),
    disableReasons: list({ type: 'integer', minimum: 1, maximum: EXTENSION_INSTALL_VOCABULARY.maxDisableReason },
        { uniqueItems: true, maxItems: EXTENSION_INSTALL_VOCABULARY.maxDisableReasons }),
    permissionsIncrease: boolean,
    version: extensionVersion,
    pendingVersion: extensionVersion,
    lastUsedDaysAgo: nonNegativeInteger,
}, ['profile', 'state', 'disableReasons', 'permissionsIncrease']);
export const extensionInstallFactsSchema = closed({
    extensionId: { type: 'string', pattern: EXTENSION_INSTALL_VOCABULARY.extensionId.source },
    browsers: list(closed({
        browser: enumeration(EXTENSION_INSTALL_VOCABULARY.browsers),
        profileSource: enumeration(EXTENSION_INSTALL_VOCABULARY.profileSources),
        readFailures: nonNegativeInteger,
        profiles: list(extensionProfileSchema, { maxItems: EXTENSION_INSTALL_VOCABULARY.maxProfiles }),
        // Whether the browser's process singleton shows it running (null: it could not be told), and since when.
        running: { oneOf: [boolean, { type: 'null' }] },
        runningSince: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' },
    }, ['browser', 'profileSource', 'readFailures', 'profiles']), { maxItems: EXTENSION_INSTALL_VOCABULARY.browsers.length }),
}, ['extensionId', 'browsers']);

// The report-side shape of one negotiated diagnostic_snapshot_v1. The wire validator in the extension
// protocol admits any short strings for the time and version and an unbounded capability list; here
// the canonical time and a non-empty version are optional, so a looser extension build keeps its
// activation, storage and port facts in a report instead of losing the whole observation.
// Version 2 adds `tabs` (readiness: a port of that type answered its last ping) and `pendingUpdateVersion`.
export const EXTENSION_SNAPSHOT_VOCABULARY = Object.freeze({
    keys: Object.freeze(['protocolVersion', 'observedAt', 'extensionVersion', 'capabilities', 'activationIdentity', 'storageRead', 'ports',
        'tabs', 'pendingUpdateVersion']),
    activation: Object.freeze(['present', 'absent', 'unknown']),
    storageRead: Object.freeze(['passed', 'failed', 'unknown']),
    ports: Object.freeze(['wb', 'wbSeller', 'ozon']),
});
const portSchema = { oneOf: [boolean, { const: 'unknown' }] };
const tabReadinessSchema = closed({ ready: boolean, lastPingAgeMs: nonNegativeInteger }, ['ready']);
export const extensionSnapshotFactsSchema = closed({
    protocolVersion: { type: 'integer', minimum: 1, maximum: 2 },
    tabs: closed(Object.fromEntries(EXTENSION_SNAPSHOT_VOCABULARY.ports.map((key) => [key, tabReadinessSchema])), [...EXTENSION_SNAPSHOT_VOCABULARY.ports]),
    pendingUpdateVersion: { type: 'string', pattern: '^\\d{1,9}(\\.\\d{1,9}){0,3}$' },
    observedAt: { type: 'string', minLength: 24, maxLength: 24 },
    extensionVersion: { type: 'string', minLength: 1, maxLength: 128 },
    capabilities: list({ type: 'string', minLength: 1, maxLength: 128 }),
    activationIdentity: closed({ state: enumeration(EXTENSION_SNAPSHOT_VOCABULARY.activation) }, ['state']),
    storageRead: closed({ state: enumeration(EXTENSION_SNAPSHOT_VOCABULARY.storageRead) }, ['state']),
    ports: closed(Object.fromEntries(EXTENSION_SNAPSHOT_VOCABULARY.ports.map((key) => [key, portSchema])), [...EXTENSION_SNAPSHOT_VOCABULARY.ports]),
}, ['protocolVersion', 'capabilities', 'activationIdentity', 'storageRead', 'ports']);

// The extension_log check (extension-log.mjs): how the reader fared, and Chrome's native-port close text reduced to a
// class, so the text itself never reaches a result, a status or a report.
export const EXTENSION_LOG_VOCABULARY = Object.freeze({
    readerStates: Object.freeze(['read', 'no_log', 'no_profile', 'unreadable', 'format_unknown', 'truncated']),
    closeClasses: Object.freeze(['host_not_found', 'host_forbidden', 'host_blocked', 'host_exited', 'start_failed', 'communication_error', 'other']),
});
// Published as it is in the local_bridge_status output schema, so every node carries its description.
const described = (schema, description) => ({ ...schema, description });
const secondsAgo = (what) => described(nonNegativeInteger, `Whole seconds before the observation since ${what}.`);
export const extensionLogFactsSchema = closed({
    reader: described(enumeration(EXTENSION_LOG_VOCABULARY.readerStates), 'How the reader fared: read, no_log, no_profile, unreadable, format_unknown or truncated.'),
    browser: described(enumeration(EXTENSION_INSTALL_VOCABULARY.browsers), 'Browser whose profile held the log that decided.'),
    lastTriggerAgoS: secondsAgo('something last asked the extension to open the connector'),
    lastHandshakeAgoS: secondsAgo('the connector last answered the extension'),
    lastClose: described(closed({
        class: described(enumeration(EXTENSION_LOG_VOCABULARY.closeClasses), 'The browser close reason reduced to a closed class; its text is never returned.'),
        agoS: secondsAgo('that close'),
        handshaken: described(boolean, 'Whether the connector had answered before the close.'),
    }, ['class', 'agoS', 'handshaken']), 'The last time the browser closed the connector port.'),
    missingStreak: described(closed({
        open: described(boolean, 'Whether the run of not-found or forbidden closes is still going on.'),
        startedAgoS: secondsAgo('the run began'),
    }, ['open', 'startedAgoS']), 'The run of not-found or forbidden closes the extension retries every 15 s.'),
    startFailures: described(nonNegativeInteger, 'Failed connector starts since the browser started, or all of them when that start is unknown.'),
    refused: described({ const: 'extension_id_mismatch' }, 'The extension refused to open the connector because its own ID is not the one it was built for.'),
}, ['reader', 'startFailures']);
