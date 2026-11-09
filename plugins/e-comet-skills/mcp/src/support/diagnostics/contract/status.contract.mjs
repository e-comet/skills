import { BRIDGE_COMSPEC_STATES, BRIDGE_OWNERS, BRIDGE_REGISTRATION_STATES, BRIDGE_RUNTIMES, BRIDGE_RUNTIME_RECHECKS, BRIDGE_STATUS_CODES, } from '../../../transport/diagnostics/bridge-codes.mjs';
import { EXTENSION_INSTALL_VOCABULARY, HOST_LAST_FAILURES, extensionLogFactsSchema } from '../../../transport/diagnostics/facts.mjs';
import { DIAGNOSTIC_STATES } from '../../../transport/diagnostics/vocabulary.mjs';
import { TRANSPORT_EVENT_KINDS } from '../../../transport/extension/events.mjs';
import { array, boolean, described, nonNegativeInteger, nullable, number, object, objectUnion, positiveInteger, string, } from '../../../transport/mcp/schema.mjs';
const storageTargetStatusSchema = objectUnion(described(object({
    state: described({ const: 'ready' }, 'Configuration resolved a target; this does not prove the target is writable.'),
    backend: described({ type: 'string', enum: ['plugin_data', 'application_data', 'override'] }, 'Configuration source that resolved this target, without exposing its filesystem path.'),
}, ['state', 'backend']), 'A configured target resolved successfully; no write was attempted.'), described(object({
    state: described({ const: 'unavailable' }, 'Configuration could not resolve this target; this does not identify a host-installation failure.'),
    reason: described({
        type: 'string',
        enum: [
            'plugin_data_missing',
            'plugin_data_invalid',
            'plugin_data_conflict',
            'application_data_invalid',
            'override_invalid',
        ],
    }, 'Closed configuration reason for the unavailable target; paths and raw environment values are omitted.'),
}, ['state', 'reason']), 'A configured target could not be resolved; this does not prove the plugin is absent or disabled.'));
const storageStatusSchema = object({
    results: described(storageTargetStatusSchema, 'Resolved storage configuration for ordinary tool results.'),
    marketplaceArtifacts: described(storageTargetStatusSchema, 'Resolved storage configuration for marketplace report artifacts.'),
    feedbackArtifacts: described(storageTargetStatusSchema, 'Resolved storage configuration for explicit-consent feedback artifacts.'),
}, ['results', 'marketplaceArtifacts', 'feedbackArtifacts']);
const diagnosticBase = (check, facts, causes = ['unknown']) => object({
    check: described({ const: check }, 'Stable identifier for the observation represented by this check.'),
    state: described({ type: 'string', enum: DIAGNOSTIC_STATES }, 'Result of this bounded observation; unknown and unsupported remain distinct from failure.'),
    observedAt: described(string, 'ISO timestamp at which this check made its observation.'),
    source: described(string, 'Component that produced this fact, without implying evidence from another execution plane.'),
    executionPlane: described(string, 'Execution plane on which the check actually ran.'),
    ...(facts
        ? { facts: described(facts, 'Typed facts observed by this check; omitted when the source supplied no safe facts.') }
        : {}),
    cause: described({ type: 'string', enum: causes }, 'Safe closed cause classification; omitted when the state needs no cause or none was observed.'),
    evidenceRefs: described(array(described(string, 'One safe reference to separately retained evidence, not an embedded path or raw error.')), 'Safe references to separately retained evidence; omitted when no such evidence exists.'),
    nextCheck: described(string, 'Smallest named observation that can discriminate the remaining uncertainty; omitted when none is needed.'),
}, ['check', 'state', 'observedAt', 'source', 'executionPlane']);
const bridgeDiagnosticsSchema = object({
    snapshot: described(diagnosticBase('snapshot'), 'Timestamped production of the status snapshot; it is not a product-health verdict.'),
    runtime: described(diagnosticBase('runtime', object({
        nodeVersion: described(string, 'Version of the Node.js process executing this MCP server.'),
        platform: described(string, 'Node.js platform identifier for the process executing this MCP server.'),
        arch: described(string, 'Node.js architecture identifier for the process executing this MCP server.'),
        bridgeVersion: described(string, 'Version of the local bridge build executing this check.'),
        mcpProtocolVersion: described(string, 'MCP protocol version negotiated with the current client; omitted when unavailable.'),
        osRelease: described(string, 'Release of the operating system kernel, as os.release() reports it.'),
    }, ['nodeVersion', 'platform', 'arch', 'bridgeVersion'])), 'Facts about the Node.js process running this MCP server.'),
    client: described(diagnosticBase('client', object({
        name: described(string, 'Bounded client name supplied in MCP initialize metadata.'),
        version: described(string, 'Bounded client version supplied in MCP initialize metadata.'),
        provenance: described({ const: 'client_reported' }, 'Marks these values as client-reported rather than trusted host identity.'),
        hostRuntimeVersion: described(string, 'DeepSeek Harness runtime version the native adapter resolved its peers against; present only under that adapter.'),
        hostLastFailure: described({ type: 'string', enum: [...HOST_LAST_FAILURES] }, 'Closed class of the last failure of the local module the native DeepSeek adapter started again; present only under that adapter after a failure.'),
        hostRestarts: described(nonNegativeInteger, 'How many times the native DeepSeek adapter started the local module again; present only under that adapter after a restart.'),
    }, ['name', 'version', 'provenance'])), 'Sanitized MCP initialize metadata; it does not prove host identity or hook support.'),
    routeFreshness: described(diagnosticBase('route_freshness', object({
        lastObservedAt: described(string, 'Timestamp of an actually observed route response; omitted when no producer supplies one.'),
    }, ['lastObservedAt'])), 'Freshness of a real extension-route observation, never inferred from browser-context changes.'),
    extensionLog: described(diagnosticBase('extension_log', extensionLogFactsSchema, [
        'permission_denied',
        'io_error',
        'directory_absent',
        'corrupt',
        'unavailable',
        'unknown',
    ]), "The e-Comet extension's own record of its native connection, read from the browser profile on disk by the last tool call that found no broker or the last runtime extension_log diagnosis; present only after one, and dropped when a broker connects."),
    storage: described(diagnosticBase('storage', object({
        scope: described({ const: 'configuration' }, 'Declares that these storage facts cover configuration resolution only.'),
        targets: described(storageStatusSchema, 'Sanitized configured storage targets without paths or write claims.'),
    }, ['scope', 'targets'])), 'Read-only storage configuration observation; it does not test writability.'),
}, ['snapshot', 'runtime', 'client', 'routeFreshness', 'storage']);
const bridgeStatusSchema = described(object({
    ok: described({ const: true }, 'Confirms that the status response was constructed; it is not a product-health result.'),
    code: described({ type: 'string', enum: [...BRIDGE_STATUS_CODES] }, 'Closed cause of the current bridge state, read first. connected and connecting are healthy states. A BRIDGE_* value names the one observed reason no extension route exists; BRIDGE_NO_BROWSER is the one used when nothing more specific was observed. A route lost mid-job is EXTENSION_DISCONNECTED on the failing tool call; status never returns it and names the cause found since. The other fields are the evidence behind it.'),
    owner: described({ type: 'string', enum: [...BRIDGE_OWNERS] }, 'Who can act on the cause in code: user, administrator (whoever manages the computer), e_comet, or unknown. Absent while connected or connecting.'),
    comspec: described({ type: 'string', enum: [...BRIDGE_COMSPEC_STATES] }, 'Whether the Windows ComSpec variable names an existing cmd.exe, read by the last tool call that found no broker or runtime extension_log diagnosis; unknown when this process has no ComSpec, since it sees its host environment, not the browser one; present only on Windows with code BRIDGE_HOST_START_FAILED.'),
    extensionConnected: described(boolean, 'Whether this process currently holds an extension session through a broker.'),
    browserJobSupported: described(boolean, 'Whether the effective route advertised browser-job support; it does not prove a particular operation will succeed.'),
    state: described({
        type: 'string',
        enum: [
            'initializing',
            'waiting_for_extension',
            'extension_connected_no_wb_tab',
            'extension_context_unknown',
            'ready',
            'extension_update_required',
        ],
    }, 'Ordered compatibility summary of observed bridge state, not a complete fault list or retry instruction.'),
    extension: described(object({
        state: described({ type: 'string', enum: ['never_connected', 'connected', 'disconnected'] }, 'Effective extension connection observation, including retained disconnected state.'),
        route: described({ type: 'string', enum: ['direct', 'none'] }, 'direct while this process holds an extension session through a broker, otherwise none.'),
        lastConnectedAt: described(string, 'ISO timestamp of the last observed effective extension connection; omitted if never observed.'),
        lastDisconnectedAt: described(string, 'ISO timestamp of the last observed effective extension disconnection; omitted if never observed.'),
        version: described(string, 'Version last reported by the effective extension route; retained after disconnect and omitted if unobserved.'),
        ozonSellerPromotionReportSupported: described(boolean, 'Capability reported for a single Ozon promotion report; omission means unobserved.'),
        ozonSellerPromotionReportsSupported: described(boolean, 'Capability reported for packaged Ozon promotion reports; omission means unobserved.'),
        ozonSellerAnalyticsReportSupported: described(boolean, 'Capability reported for an Ozon analytics report; omission means unobserved.'),
        ozonSearchPositionsSupported: described(boolean, 'Capability reported for Ozon search positions; omission means unobserved.'),
    }, ['state', 'route']), "Browser-extension observation from this process's broker session."),
    browserContext: described(object({
        state: described({ type: 'string', enum: ['unknown', 'known'] }, 'Whether registered WB browser-port facts were observed.'),
        wbTabConnected: described(boolean, 'Whether the extension reports a registered standalone WB page port; this does not prove login.'),
        sellerTabConnected: described(boolean, 'Whether the extension reports a registered WB Seller page port; this does not describe Ozon.'),
        changedAt: described(string, 'ISO timestamp when the registered-port observation changed; it is not a freshness guarantee.'),
    }, ['state']), 'Extension-reported WB and WB Seller port registration; it does not cover Ozon readiness.'),
    extensionLastConnectedAtMs: described({
        oneOf: [
            described(number, 'Observed effective extension connection time as Unix epoch milliseconds.'),
            described({ type: 'null' }, 'No effective extension connection has ever been observed.'),
        ],
    }, 'Legacy millisecond copy of the effective extension connection time; null means never observed.'),
    extensionLastDisconnectedAtMs: described({
        oneOf: [
            described(number, 'Observed effective extension disconnection time as Unix epoch milliseconds.'),
            described({ type: 'null' }, 'No effective extension disconnection has ever been observed.'),
        ],
    }, 'Legacy millisecond copy of the effective extension disconnection time; null means never observed.'),
    extensionVersion: described(string, 'Legacy copy of the effective extension version; it is not independent evidence.'),
    ozonSellerPromotionReportSupported: described(boolean, 'Legacy copy of the single-promotion-report capability; omission means unobserved.'),
    ozonSellerPromotionReportsSupported: described(boolean, 'Legacy copy of the packaged-promotion-reports capability; omission means unobserved.'),
    ozonSellerAnalyticsReportSupported: described(boolean, 'Legacy copy of the analytics-report capability; omission means unobserved.'),
    ozonSearchPositionsSupported: described(boolean, 'Legacy copy of the search-positions capability; omission means unobserved.'),
    bridgeVersion: described(string, 'Version of the local bridge build producing this status.'),
    extensionProtocolVersion: described(positiveInteger, 'Extension protocol version supported by this bridge build.'),
    registration: described(nullable(described(object({
        state: described({ type: 'string', enum: [...BRIDGE_REGISTRATION_STATES] }, 'Outcome of the last registration check: registered wrote something, current found it up to date, disabled means this run registers nothing, failed means a step failed, denied means macOS refused a browser folder. Another refused browser folder fails it only when no folder holds the manifest; otherwise it stays registered or current with the refusal in error.'),
        version: described(string, 'Plugin version the registration was made for.'),
        runtime: described(nullable(described({ type: 'string', enum: [...BRIDGE_RUNTIMES] }, 'Runtime the launcher starts: path_node is Node found on PATH, host_executable is the host application own executable.'), 'No runtime was resolved.'), 'Runtime the launcher starts; null when none was resolved.'),
        manifestWrittenAt: described(nullable(described(string, 'ISO timestamp of the newest host manifest.'), 'The manifest time is unknown.'), 'ISO timestamp of the newest host manifest; null when it is unknown.'),
        verifiedSinceAt: described(nullable(described(string, 'ISO timestamp since which the registration has stayed unchanged.'), 'The time is unknown.'), 'ISO timestamp since which the registration the browser reads (manifest, launcher and, on Windows, the registry key) has stayed unchanged; null when it is unknown.'),
        runtimeRecheck: described({ type: 'string', enum: [...BRIDGE_RUNTIME_RECHECKS] }, 'Whether the last check also ran the launcher runtime with -v: not_run outside a repair or when the launcher was just written, passed when it still runs, repaired when it was missing or too old and the launcher was re-pointed to another runtime, failed when no other runtime was found, inconclusive when the answer proved nothing; the launcher is left as it is unless repaired.'),
        error: described(nullable(described(object({
            name: described(string, 'Name of the registration step that failed.'),
            code: described(nullable(described(string, 'System or exit code of the failure.'), 'The failure carried no code.'), 'System or exit code of the failure; null when there was none. Never a message or a path.'),
        }, ['name', 'code']), 'The registration step that failed, as a step name and a code.'), 'The last check had no failure.'), 'The failed registration step; null when the last check had no failure.'),
    }, ['state', 'version', 'runtime', 'manifestWrittenAt', 'error']), 'Result of one registration check by this process.'), 'No registration check has run in this process.'), 'Last browser-host registration check made by this process; null before the broker client has run one.'),
    userLevelHosts: described(array(described(object({
        browser: described({ type: 'string', enum: [...EXTENSION_INSTALL_VOCABULARY.browsers] }, 'Browser the policy was read for.'),
        allowed: described(nullable(described(boolean, 'The policy allows or forbids hosts registered per user.'), 'No policy is set for this browser.'), 'Whether the NativeMessagingUserLevelHosts policy allows hosts registered per user; null when no policy is set.'),
        hostBlocked: described(nullable(described(boolean, 'true: the block list holds * or the e-Comet host and the allow list does not name it; false: the lists do not block it.'), 'No block list was read for this browser.'), 'Whether the NativeMessagingBlocklist and NativeMessagingAllowlist policies block the e-Comet host; null when no block list is set.'),
    }, ['browser', 'allowed', 'hostBlocked']), 'The native messaging policies of one browser.')), 'Per browser, the native messaging policies that decide whether it may start the e-Comet host; empty when none was read.'),
    policyReadFailed: described(array(described({ type: 'string', enum: [...EXTENSION_INSTALL_VOCABULARY.browsers] }, 'Browser whose policy read observed nothing.'), { uniqueItems: true }), 'Browsers whose native messaging policy could not be read (a timeout, or the reader did not start): their null userLevelHosts values are unknown, not unset; empty when every read worked.'),
    extensionInstall: described(nullable(described({ type: 'object', additionalProperties: true }, 'Facts of the extension_install probe, defined in DIAGNOSTICS.md.'), 'No extension_install probe has run.'), 'Chromium profile facts from the extension_install probe, in the shape e_comet_diagnose reports them; null until a probe has run.'),
    brokers: described(array(described(object({
        pid: described(positiveInteger, 'Process id of the broker, as its entry names it.'),
        browser: described(string, 'Browser brand the extension reported to that broker.'),
        extensionVersion: described(string, 'Extension version that broker saw; omitted when the extension reported none.'),
        brokerVersion: described(string, 'Plugin version of that broker.'),
        startedAt: described(string, 'ISO timestamp at which that broker wrote its entry.'),
        current: described(boolean, 'Whether this process is connected to that broker.'),
    }, ['pid', 'browser', 'brokerVersion', 'startedAt', 'current']), 'One live broker entry without its nonce or endpoint.')), 'Live broker entries, newest first, without their nonce or endpoint; empty when none is running.'),
    lastFailureRecord: described(nullable(described(object({
        name: described(string, 'Error name a broker recorded when it failed.'),
        code: described(nullable(described(string, 'Error code a broker recorded.'), 'The broker recorded no code.'), 'Error code a broker recorded; null when it recorded none.'),
        at: described(string, 'ISO timestamp at which the broker recorded the failure.'),
    }, ['name', 'code', 'at']), 'One broker failure record.'), 'No failure record applies.'), 'Newest broker failure record that is newer than every live entry and than this process last good session; null when there is none.'),
    clientProtocolVersion: described(positiveInteger, 'Client protocol version this plugin speaks to a broker.'),
    brokerProtocolVersion: described(nullable(described(positiveInteger, 'Client protocol version the broker reported.'), 'No broker session is open.'), 'Client protocol version the connected broker reported; null without a broker session.'),
    brokerVersion: described(nullable(described(string, 'Plugin version of the connected broker.'), 'No broker session is open.'), 'Plugin version of the connected broker; null without a broker session.'),
    transportEvents: described(array(described(object({
        at: described(string, 'ISO timestamp at which this process first saw the event.'),
        kind: described({ type: 'string', enum: [...TRANSPORT_EVENT_KINDS] }, 'late_answer, connect_failed, session_end, registration_step_failed or failure_record_seen.'),
        code: described(string, 'Short identifier that names the event: a typed code, a system code or a step; never a request id or a message.'),
    }, ['at', 'kind', 'code']), 'One transport event this process saw.'), { maxItems: 32 }), 'The last transport events this process saw, oldest first; a repeat of the newest is not listed again.'),
    instanceId: described(string, 'Ephemeral identifier of this local bridge process; it is not a host or user identity.'),
    storage: described(storageStatusSchema, 'Read-only resolution status for the three configured storage targets.'),
    diagnostics: described(bridgeDiagnosticsSchema, 'Typed passive observations collected with this status response.'),
}, ['ok', 'extensionConnected', 'code', 'storage']), 'Passive local bridge status response; successful construction is distinct from product health.');
export const schemaContractTerms = (schema = bridgeStatusSchema) => {
    const terms = new Set();
    const visit = (node, path) => {
        if (!node || typeof node !== 'object')
            return;
        if (path)
            terms.add(path);
        if (Array.isArray(node.enum))
            for (const value of node.enum)
                terms.add(`${path}=${value}`);
        if (Object.hasOwn(node, 'const') && ['string', 'boolean', 'number'].includes(typeof node.const))
            terms.add(`${path}=${node.const}`);
        for (const alternative of node.oneOf ?? [])
            visit(alternative, path);
        for (const [name, child] of Object.entries(node.properties ?? {}))
            visit(child, path ? `${path}.${name}` : name);
    };
    visit(schema, '');
    return [...terms].sort();
};
export const contract = {
    name: 'local_bridge_status',
    description: 'Observed facts only; no task recovery action. ' +
        'Read code first: connected and connecting are healthy; BRIDGE_* names the observed reason no extension route exists, BRIDGE_NO_BROWSER when nothing more specific was seen; a tool error EXTENSION_DISCONNECTED means a route was lost mid-job. ' +
        'Use user intent and typed results for next steps, never status alone. ' +
        'Feedback is independent. ' +
        'WB context proves neither login nor Ozon readiness; no WB-tab recovery for Ozon. ' +
        'Versions/capabilities never gate a tool. ' +
        'extension.version: extension; brokers: browser-started bridge processes; version skew does not prove a cause. ' +
        'extensionConnected:false means no route; it does not establish why: no disabled-extension or wrong-profile claim without typed evidence. ' +
        'ready means only local bridge/protocol and observed WB/seller browser context; each typed tool checks live WB or seller prerequisites. ' +
        'Hide raw paths/errors. ' +
        'Translate the stable state into a short user-facing explanation; keep codes in English. ' +
        'Russian examples: waiting_for_extension: Локальный компонент запущен и ждёт подключения расширения. ' +
        'extension_connected_no_wb_tab: Расширение подключено; зарегистрированная вкладка Wildberries не наблюдается. ' +
        'extension_context_unknown: Расширение подключено, но контекст вкладок не получен. ' +
        'ready: Локальный компонент и расширение подключены; найдена вкладка Wildberries. ' +
        'Load packaged mcp/DIAGNOSTICS.md for field/enum semantics.',
    inputSchema: described(object({}), 'No arguments: this tool passively observes existing local bridge state.'),
    outputSchema: bridgeStatusSchema,
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
};
