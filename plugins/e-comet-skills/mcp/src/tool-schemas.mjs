import {
    DEFAULT_IMAGE_PHOTOS,
    DEFAULT_RETURNED_PRODUCTS,
    FEEDBACK_KINDS,
    FEEDBACK_MAX_BYTES,
    MAX_BROWSER_JOB_TOKEN_BYTES,
    MAX_IMAGE_ARTICLES,
    MAX_IMAGE_BASKET,
    MAX_IMAGE_PHOTOS,
    MAX_PRODUCT_ARTICLES,
    MAX_RETURNED_PRODUCTS,
} from './config.mjs';
import { PEER_REJECTION_CODES } from './connection-state.mjs';
import { FEEDBACK_DIAGNOSTIC_OPERATIONS, FEEDBACK_DIAGNOSTIC_ERROR_TYPES, FEEDBACK_DIAGNOSTIC_SYSTEM_CODES, FEEDBACK_DIAGNOSTIC_MODULES, FEEDBACK_DIAGNOSTIC_REASONS } from './feedback-diagnostics.mjs';
import { CONTRACT_TOOL_NAMES } from './tool-contracts.mjs';
import { feedbackCloudTransportSchema, feedbackHostAdapterMarkerSchema } from './feedback-host-adapter.mjs';
import {
    EXTENSION_UPDATE_URL,
    FETCH_ERROR_CODES,
    OZON_ANALYTICS_TERMINAL_CODE_STAGES,
    OZON_PROMOTION_CAPABILITY,
    OZON_PROMOTION_MIN_EXTENSION_VERSION,
} from './extension-vocabulary.mjs';
import { OZON_EXTENSION_OUTDATED_REASON, OZON_PROMOTION_TERMINAL_CODE_STAGES } from './tool-errors.mjs';
import { MAX_OZON_REPORT_PACKAGE_ITEMS } from './ozon-report-package-domain.mjs';
import { OZON_PACKAGE_STOP_REASONS } from './ozon-report-package-result.mjs';
import { DIAGNOSTIC_STATES, extensionInstallFactsSchema, hookPermissionsFactsSchema } from './diagnostic-facts.mjs';
// The producers validate their facts against these; the feedback projection reads the same objects.
export { extensionInstallFactsSchema, hookPermissionsFactsSchema };
import { feedbackDeviceSnapshotSchema } from './feedback-device-diagnostics.mjs';

const string = { type: 'string' };
const boolean = { type: 'boolean' };
const number = { type: 'number' };
const integer = { type: 'integer' };
const positiveNumber = { type: 'number', exclusiveMinimum: 0 };
const positiveInteger = { type: 'integer', minimum: 1 };
const nonNegativeInteger = { type: 'integer', minimum: 0 };
const nullableNonNegativeInteger = { oneOf: [nonNegativeInteger, { type: 'null' }] };
const status = { type: 'string', enum: ['done', 'partial', 'failed'] };

const object = (properties, required = [], additionalProperties = false) => ({
    type: 'object',
    properties,
    required,
    additionalProperties,
});

const array = (items, extra = {}) => ({ type: 'array', items, ...extra });
const objectUnion = (...schemas) => ({ type: 'object', oneOf: schemas });
const described = (schema, description) => ({ ...schema, description });
const liveAggregateSchemas = (schema) => [
    {
        ...schema,
        properties: {
            ...schema.properties,
            ok: { const: true },
            status: { type: 'string', enum: ['done', 'partial'] },
        },
    },
    {
        ...schema,
        properties: {
            ...schema.properties,
            ok: { const: false },
            status: { const: 'failed' },
        },
    },
].flatMap((published) => {
    // Useful inline data survives a failed NDJSON publication. That response must
    // omit resultPath and explain storage failure; neither a fabricated path nor
    // unexplained absence is valid. Keep the alternatives mutually exclusive.
    const { resultPath: _resultPath, ...inlineProperties } = published.properties;
    return [published, {
        ...published,
        properties: { ...inlineProperties, storageWarnings: array(string, { minItems: 1 }) },
        required: [...published.required.filter(name => name !== 'resultPath'), 'storageWarnings'],
    }];
});

const priceSchema = object({
    basic: number,
    product: number,
    logistics: number,
    return: number,
    cashback: number,
});

const listingProductSchema = object({
    nmId: positiveInteger,
    name: string,
    brand: string,
    supplierId: positiveInteger,
    priceRub: priceSchema,
    rating: number,
    feedbacks: nonNegativeInteger,
    pics: nonNegativeInteger,
    promoted: boolean,
    position: positiveInteger,
    globalPosition: positiveInteger,
}, ['nmId', 'position']);

const buyerErrorProperties = {
    skipped: boolean,
    errorDetails: object({
        code: { type: 'string', enum: [...Object.values(FETCH_ERROR_CODES), 'WB_FETCH_FAILED', 'WB_RATE_LIMITED', 'WB_REQUEST_FAILED'] },
        stage: { const: 'execution' },
        retryable: boolean,
    }, ['code', 'stage', 'retryable']),
};

const pageSchema = object({
    ...buyerErrorProperties,
    page: positiveInteger,
    ok: boolean,
    httpStatus: integer,
    total: nonNegativeInteger,
    overallTotal: nonNegativeInteger,
    error: string,
    globalPositionsReliable: boolean,
    products: array(listingProductSchema),
}, ['page', 'ok', 'total', 'products']);

const warehouseSchema = object({
    wh: positiveInteger,
    warehouse: string,
    qty: nonNegativeInteger,
    rows: nonNegativeInteger,
}, ['wh', 'qty', 'rows']);

const sizeSchema = object({
    size: string,
    qty: nonNegativeInteger,
    warehouses: nonNegativeInteger,
}, ['size', 'qty', 'warehouses']);

const quantitySchema = object({
    total: nonNegativeInteger,
    byWarehouse: array(warehouseSchema),
    bySize: array(sizeSchema),
}, ['total', 'byWarehouse', 'bySize']);

const unitSchema = object({
    ...buyerErrorProperties,
    key: string,
    ok: boolean,
    httpStatus: integer,
    error: string,
}, ['key', 'ok']);

const productCardSchema = object({
    complete: boolean,
    nmId: positiveInteger,
    ok: boolean,
    status: integer,
    error: string,
    name: string,
    brand: string,
    supplier: string,
    supplierId: positiveInteger,
    rating: number,
    feedbacks: nonNegativeInteger,
    pics: nonNegativeInteger,
    priceRub: priceSchema,
    quantity: quantitySchema,
    imtId: positiveInteger,
    vendorCode: string,
    description: string,
    subjectId: positiveInteger,
    subject: string,
    rootSubject: string,
    options: array({}),
    colors: array(positiveInteger),
    content: object({}, [], true),
    units: array(unitSchema),
}, ['nmId', 'ok', 'units']);

const storageWarnings = array(string);

const liveBaseProperties = {
    ok: boolean,
    status,
    jobId: string,
    resultPath: string,
    expiresAt: positiveNumber,
    storageWarnings,
};

const browserJobRejectionSchema = objectUnion(
    object({ schemaVersion: { const: 1 }, reason: { const: 'invalid_job' }, diagnostic: { type: 'string', enum: ['job_type', 'jobs_count', 'descriptor_type', 'descriptor_shape', 'date_from', 'date_to_or_range', 'claims_iat_or_jti'] } }, ['schemaVersion', 'reason']),
    ...['public_key_not_configured', 'user_not_available', 'invalid_format', 'invalid_algorithm', 'invalid_signature', 'issuer_mismatch', 'audience_mismatch', 'subject_mismatch', 'expired', 'token_reuse', 'ecomet_not_authenticated', 'activation_storage_unavailable', 'unknown']
        .map((reason) => object({ schemaVersion: { const: 1 }, reason: { const: reason } }, ['schemaVersion', 'reason']))
);
const browserJobRejectionDetailsSchema = object({ browserJobRejection: browserJobRejectionSchema }, ['browserJobRejection']);

export const toolErrorSchema = object({
    ok: { const: false },
    code: string,
    message: string,
    stage: {
        type: 'string',
        enum: ['arguments', 'handoff', 'extension', 'authorization', 'execution', 'storage', 'images', 'seller', 'local'],
    },
    retryable: boolean,
    details: objectUnion(object({
        operation: { const: 'create_result' },
        systemCode: { type: 'string', enum: ['EEXIST', 'EACCES', 'EPERM', 'ENOSPC', 'EDQUOT', 'EROFS', 'ENOTDIR', 'EBUSY'] },
    }, ['operation', 'systemCode']), browserJobRejectionDetailsSchema),
    resultPath: string,
    storageWarnings,
}, ['ok', 'code', 'message', 'stage', 'retryable']);

const productCardSuccessSchema = object({
    stopReason: { const: 'rate_limited' },
    ...liveBaseProperties,
    jobType: { const: 'product_card' },
    total: nonNegativeInteger,
    succeeded: nonNegativeInteger,
    failed: nonNegativeInteger,
    products: array(productCardSchema),
}, ['ok', 'status', 'jobType', 'jobId', 'resultPath', 'total', 'succeeded', 'failed', 'products']);

const searchQuerySchema = object({
    query: string,
    pagesRequested: positiveInteger,
    pagesSucceeded: nonNegativeInteger,
    productsSeen: nonNegativeInteger,
    productsReturned: nonNegativeInteger,
    globalPositionsComplete: boolean,
    pages: array(pageSchema),
}, ['query', 'pagesRequested', 'pagesSucceeded', 'productsSeen', 'productsReturned', 'globalPositionsComplete', 'pages']);

const searchSuccessSchema = object({
    stopReason: { const: 'rate_limited' },
    ...liveBaseProperties,
    jobType: { const: 'search_by_query' },
    pagesRequested: positiveInteger,
    pagesSucceeded: nonNegativeInteger,
    pagesFailed: nonNegativeInteger,
    productFilterApplied: boolean,
    productLimitPerQuery: positiveInteger,
    queries: array(searchQuerySchema),
}, ['ok', 'status', 'jobType', 'jobId', 'resultPath', 'pagesRequested', 'pagesSucceeded', 'pagesFailed', 'productFilterApplied', 'queries']);

const checkProductSchema = object({
    nmId: positiveInteger,
    name: string,
    brand: string,
}, ['nmId']);

const checkQueryProperties = {
    ...buyerErrorProperties,
    query: string,
    pagesChecked: nonNegativeInteger,
    error: string,
};
const checkQueryRequired = ['query', 'found', 'pagesChecked', 'completionReason'];
const checkQuerySchema = objectUnion(
    object(
        {
            ...checkQueryProperties,
            found: { const: true },
            completionReason: { const: 'found' },
        },
        checkQueryRequired
    ),
    object(
        {
            ...checkQueryProperties,
            found: { const: false },
            completionReason: {
                type: 'string',
                enum: ['empty_page', 'repeated_page', 'page_limit', 'request_failed', 'card_failed'],
            },
        },
        checkQueryRequired
    )
);

const checkSuccessSchema = object({
    stopReason: { const: 'rate_limited' },
    ...liveBaseProperties,
    jobType: { const: 'check_by_query' },
    complete: boolean,
    product_id: positiveInteger,
    product: checkProductSchema,
    requestsMade: positiveInteger,
    queries: array(checkQuerySchema),
}, ['ok', 'status', 'jobType', 'jobId', 'resultPath', 'complete', 'product_id', 'requestsMade', 'queries']);

const recommendationArticleSchema = object({
    sourceNmId: positiveInteger,
    pagesRequested: positiveInteger,
    pagesSucceeded: nonNegativeInteger,
    overallTotal: nonNegativeInteger,
    totalPages: nullableNonNegativeInteger,
    productsSeen: nonNegativeInteger,
    productsReturned: nonNegativeInteger,
    truncatedByLocalLimit: boolean,
    globalPositionsComplete: boolean,
    pages: array(pageSchema),
}, [
    'sourceNmId',
    'pagesRequested',
    'pagesSucceeded',
    'productsSeen',
    'productsReturned',
    'truncatedByLocalLimit',
    'globalPositionsComplete',
    'pages',
]);

const recommendationsSuccessSchema = object({
    stopReason: { const: 'rate_limited' },
    ...liveBaseProperties,
    jobType: { const: 'recommendations_by_product' },
    complete: boolean,
    truncatedByLocalLimit: boolean,
    pagesRequested: positiveInteger,
    pagesSucceeded: nonNegativeInteger,
    pagesFailed: nonNegativeInteger,
    productFilterApplied: boolean,
    productLimitPerSource: positiveInteger,
    articles: array(recommendationArticleSchema),
}, ['ok', 'status', 'jobType', 'jobId', 'resultPath', 'complete', 'truncatedByLocalLimit', 'pagesRequested', 'pagesSucceeded', 'pagesFailed', 'productFilterApplied', 'articles']);

const imageProductSchema = object({
    nmId: positiveInteger,
    status: { type: 'string', enum: ['ok', 'not_found', 'partial', 'failed', 'skipped'] },
    error: object({
        code: { enum: ['WB_IMAGE_RATE_LIMITED', 'WB_IMAGE_PROBE_FAILED'] },
        message: string, stage: { const: 'images' }, retryable: { const: false },
    }, ['code', 'message', 'stage', 'retryable']),
    basket: positiveInteger,
    baseUrl: string,
    imageUrls: array(string),
}, ['nmId', 'status', 'imageUrls']);

const sellerArtifactSchema = object({
    name: string,
    path: string,
    uri: string,
    mimeType: { const: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    size: nonNegativeInteger,
    sha256: { type: 'string', minLength: 64, maxLength: 64 },
}, ['name', 'path', 'uri', 'mimeType', 'size', 'sha256']);

const sellerExportErrorSchema = object({
    code: string,
    message: string,
    stage: string,
    retryable: boolean,
}, ['code', 'message', 'stage', 'retryable']);

const sellerExportSchema = object({
    product_id: positiveInteger,
    dateFrom: string,
    dateTo: string,
    isAnswered: boolean,
    ratings: array({ type: 'integer', minimum: 1, maximum: 5 }, { minItems: 1, maxItems: 5, uniqueItems: true }),
    content: { const: 'media' },
    status: { type: 'string', enum: ['complete', 'failed', 'skipped'] },
    artifact: sellerArtifactSchema,
    error: sellerExportErrorSchema,
}, ['isAnswered', 'status']);

const fileDeliverySchema = object({
    status: { type: 'string', enum: ['complete', 'partial', 'failed'] },
    copied: nonNegativeInteger,
    failures: array(object({
        resourceIndex: nonNegativeInteger,
        code: { const: 'REPORT_DELIVERY_FAILED' },
        stage: { type: 'string', enum: ['output_directory', 'source', 'copy', 'verification'] },
        reason: { type: 'string', enum: ['invalid_output_directory', 'invalid_artifact_metadata', 'source_not_file', 'integrity_mismatch', 'filesystem_error', 'unexpected_error'] },
        systemCode: { type: 'string', enum: ['EACCES', 'EPERM', 'ENOSPC', 'EDQUOT', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EEXIST', 'EROFS', 'EMFILE', 'ENFILE', 'EIO', 'ENAMETOOLONG'] },
    }, ['resourceIndex', 'code', 'stage', 'reason'])),
}, ['status', 'copied', 'failures']);

const sellerReviewsSuccessSchema = object({
    fileDelivery: fileDeliverySchema,
    ok: boolean,
    status: { type: 'string', enum: ['complete', 'partial', 'failed'] },
    jobType: { const: 'seller_reviews' },
    jobId: string,
    org: object({ id: string, name: string }, [], false),
    exports: array(sellerExportSchema, { minItems: 1 }),
    // Present when the exports themselves are described accurately but restoring the seller cabinet failed.
    releaseError: toolErrorSchema,
}, ['ok', 'status', 'jobType', 'jobId', 'exports']);

const imagesSuccessSchema = object({
    stopReason: { const: 'rate_limited' },
    ok: boolean,
    status,
    jobId: string,
    total: nonNegativeInteger,
    succeeded: nonNegativeInteger,
    failed: nonNegativeInteger,
    size: { type: 'string', enum: ['big', 'tm'] },
    products: array(imageProductSchema),
    resultPath: string,
    storageWarnings,
}, ['ok', 'status', 'jobId', 'total', 'succeeded', 'failed', 'size', 'products', 'resultPath']);

// Present only while the bridge cannot reach a primary peer or bind its own listener: a healthy status omits
// it entirely rather than carrying a null-filled object into the agent's context. `code` is the closed local
// vocabulary from PEER_REJECTION_CODES, never text received over the socket.
//
// Only `code` is required. Both timestamps are best-effort by design: `retryAt` is absent whenever no retry is
// armed, and `peerRejectionStatus` omits either one rather than throwing on a clock value Date cannot
// represent. Requiring `since` here would turn that deliberate omission into a schema violation in the one
// tool an operator reaches for when the bridge is already wedged.
const peerRejectionSchema = object(
    {
        // Derived, never restated: a hand-copied list would let a new rejection code ship as tool output that
        // fails this very schema, in the one tool an operator reads when the bridge is already wedged.
        code: described({ type: 'string', enum: Object.values(PEER_REJECTION_CODES) }, 'Current safe classification of the continuous authenticated-peer rejection streak.'),
        since: described(string, 'ISO timestamp when the current continuous peer-rejection streak began; omitted when no safe time is available.'),
        retryAt: described(string, 'ISO timestamp of the scheduled peer reconnect; omitted when no retry is armed.'),
    },
    ['code']
);

const storageTargetStatusSchema = objectUnion(
    described(object({ state: described({ const: 'ready' }, 'Configuration resolved a target; this does not prove the target is writable.'), backend: described({ type: 'string', enum: ['plugin_data', 'application_data', 'override'] }, 'Configuration source that resolved this target, without exposing its filesystem path.') }, ['state', 'backend']), 'A configured target resolved successfully; no write was attempted.'),
    described(object(
        {
            state: described({ const: 'unavailable' }, 'Configuration could not resolve this target; this does not identify a host-installation failure.'),
            reason: described({
                type: 'string',
                enum: ['plugin_data_missing', 'plugin_data_invalid', 'plugin_data_conflict', 'application_data_invalid', 'override_invalid'],
            }, 'Closed configuration reason for the unavailable target; paths and raw environment values are omitted.'),
        },
        ['state', 'reason']
    ), 'A configured target could not be resolved; this does not prove the plugin is absent or disabled.')
);

const storageStatusSchema = object(
    {
        results: described(storageTargetStatusSchema, 'Resolved storage configuration for ordinary tool results.'),
        marketplaceArtifacts: described(storageTargetStatusSchema, 'Resolved storage configuration for marketplace report artifacts.'),
        feedbackArtifacts: described(storageTargetStatusSchema, 'Resolved storage configuration for explicit-consent feedback artifacts.'),
    },
    ['results', 'marketplaceArtifacts', 'feedbackArtifacts']
);

const diagnosticBase = (check, facts, causes = ['unknown']) => object({
    check: described({ const: check }, 'Stable identifier for the observation represented by this check.'), state: described({ type: 'string', enum: DIAGNOSTIC_STATES }, 'Result of this bounded observation; unknown and unsupported remain distinct from failure.'), observedAt: described(string, 'ISO timestamp at which this check made its observation.'),
    source: described(string, 'Component that produced this fact, without implying evidence from another execution plane.'), executionPlane: described(string, 'Execution plane on which the check actually ran.'), ...(facts ? { facts: described(facts, 'Typed facts observed by this check; omitted when the source supplied no safe facts.') } : {}),
    cause: described({ type: 'string', enum: causes }, 'Safe closed cause classification; omitted when the state needs no cause or none was observed.'), evidenceRefs: described(array(described(string, 'One safe reference to separately retained evidence, not an embedded path or raw error.')), 'Safe references to separately retained evidence; omitted when no such evidence exists.'), nextCheck: described(string, 'Smallest named observation that can discriminate the remaining uncertainty; omitted when none is needed.'),
}, ['check', 'state', 'observedAt', 'source', 'executionPlane']);

const bridgeDiagnosticsSchema = object({
    snapshot: described(diagnosticBase('snapshot'), 'Timestamped production of the status snapshot; it is not a product-health verdict.'),
    runtime: described(diagnosticBase('runtime', object({ nodeVersion: described(string, 'Version of the Node.js process executing this MCP server.'), platform: described(string, 'Node.js platform identifier for the process executing this MCP server.'), arch: described(string, 'Node.js architecture identifier for the process executing this MCP server.'), bridgeVersion: described(string, 'Version of the local bridge build executing this check.'), mcpProtocolVersion: described(string, 'MCP protocol version negotiated with the current client; omitted when unavailable.') }, ['nodeVersion', 'platform', 'arch', 'bridgeVersion'])), 'Facts about the Node.js process running this MCP server.'),
    client: described(diagnosticBase('client', object({ name: described(string, 'Bounded client name supplied in MCP initialize metadata.'), version: described(string, 'Bounded client version supplied in MCP initialize metadata.'), provenance: described({ const: 'client_reported' }, 'Marks these values as client-reported rather than trusted host identity.') }, ['name', 'version', 'provenance'])), 'Sanitized MCP initialize metadata; it does not prove host identity or hook support.'),
    listener: described(diagnosticBase('listener', object({ operation: described({ const: 'bind_listener' }, 'Names the already-observed listener bind operation; status does not retry it.'), listenerState: described({ type: 'string', enum: ['pending', 'listening', 'address_in_use', 'failed'] }, 'Last listener bind event observed by the bridge, not current port ownership.'), systemCode: described({ type: 'string', enum: ['EACCES', 'EPERM', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EINVAL'] }, 'Allowlisted operating-system code from the bind observation; omitted when unavailable.') }, ['operation', 'listenerState']), ['address_in_use', 'listen_failed', 'unknown']), 'Existing listener-bind observation; a healthy secondary can report address_in_use as passed.'),
    pairingSource: described(diagnosticBase('pairing_source', undefined, ['permission_denied', 'insecure_permissions', 'missing', 'corrupt', 'unsupported', 'io_error']), 'Safe pairing-source classification with no token, path, owner, or raw exception.'),
    routeFreshness: described(diagnosticBase('route_freshness', object({ lastObservedAt: described(string, 'Timestamp of an actually observed route response; omitted when no producer supplies one.') }, ['lastObservedAt'])), 'Freshness of a real extension-route observation, never inferred from browser-context changes.'),
    storage: described(diagnosticBase('storage', object({ scope: described({ const: 'configuration' }, 'Declares that these storage facts cover configuration resolution only.'), targets: described(storageStatusSchema, 'Sanitized configured storage targets without paths or write claims.') }, ['scope', 'targets'])), 'Read-only storage configuration observation; it does not test writability.'),
}, ['snapshot', 'runtime', 'client', 'listener', 'pairingSource', 'routeFreshness', 'storage']);

const bridgeStatusSchema = described(object({
    ok: described({ const: true }, 'Confirms that the status response was constructed; it is not a product-health result.'),
    extensionConnected: described(boolean, 'Whether an effective direct or authenticated-peer extension route is currently observed.'),
    browserJobSupported: described(boolean, 'Whether the effective route advertised browser-job support; it does not prove a particular operation will succeed.'),
    bridgeRole: described({ type: 'string', enum: ['primary', 'secondary', 'disconnected'] }, 'Current local bridge role; secondary is a normal healthy role when another primary owns the listener.'),
    bridgeTransitioning: described(boolean, 'Whether the bridge is currently changing role; it does not authorize waiting or retrying a business operation.'),
    listenerState: described({ type: 'string', enum: ['pending', 'listening', 'address_in_use', 'failed'] }, 'Last listener bind event, which does not independently identify current port ownership.'),
    state: described({ type: 'string', enum: ['initializing', 'listen_failed', 'waiting_for_extension', 'extension_connected_no_wb_tab', 'extension_contended', 'extension_context_unknown', 'peer_context_unknown', 'ready', 'extension_update_required', 'peer_reconnecting', 'peer_unavailable'] }, 'Ordered compatibility summary of observed bridge state, not a complete fault list or retry instruction.'),
    extension: described(object({
        state: described({ type: 'string', enum: ['never_connected', 'connected', 'disconnected'] }, 'Effective extension connection observation, including retained disconnected state.'),
        route: described({ type: 'string', enum: ['direct', 'peer', 'none'] }, 'Route supplying the effective extension observation.'),
        lastConnectedAt: described(string, 'ISO timestamp of the last observed effective extension connection; omitted if never observed.'),
        lastDisconnectedAt: described(string, 'ISO timestamp of the last observed effective extension disconnection; omitted if never observed.'),
        version: described(string, 'Version last reported by the effective extension route; retained after disconnect and omitted if unobserved.'),
        ozonSellerPromotionReportSupported: described(boolean, 'Capability reported for a single Ozon promotion report; omission means unobserved.'),
        ozonSellerPromotionReportsSupported: described(boolean, 'Capability reported for packaged Ozon promotion reports; omission means unobserved.'),
        ozonSellerAnalyticsReportSupported: described(boolean, 'Capability reported for an Ozon analytics report; omission means unobserved.'),
    }, ['state', 'route']), 'Effective browser-extension observation from a direct or authenticated-peer route.'),
    peer: described(object({
        bridgeVersion: described(string, 'Bridge version reported by the authenticated primary peer.'),
        browserContextPropagationSupported: described(boolean, 'Whether the authenticated primary advertises browser-context propagation.'),
        diagnosticForwardingSupported: described(boolean, 'Whether the authenticated primary advertised diagnostic_snapshot_forwarding_v1. False includes legacy or other primaries that did not advertise it. This field alone says nothing about extension capability or whether a diagnostic snapshot request will succeed.'),
    }), 'Authenticated primary-peer metadata; normally omitted on a primary.'),
    browserContext: described(object({
        state: described({ type: 'string', enum: ['unknown', 'known'] }, 'Whether registered WB browser-port facts were observed.'),
        wbTabConnected: described(boolean, 'Whether the extension reports a registered standalone WB page port; this does not prove login.'),
        sellerTabConnected: described(boolean, 'Whether the extension reports a registered WB Seller page port; this does not describe Ozon.'),
        changedAt: described(string, 'ISO timestamp when the registered-port observation changed; it is not a freshness guarantee.'),
    }, ['state']), 'Extension-reported WB and WB Seller port registration; it does not cover Ozon readiness.'),
    extensionLastConnectedAtMs: described({ oneOf: [described(number, 'Observed effective extension connection time as Unix epoch milliseconds.'), described({ type: 'null' }, 'No effective extension connection has ever been observed.')] }, 'Legacy millisecond copy of the effective extension connection time; null means never observed.'),
    extensionLastDisconnectedAtMs: described({ oneOf: [described(number, 'Observed effective extension disconnection time as Unix epoch milliseconds.'), described({ type: 'null' }, 'No effective extension disconnection has ever been observed.')] }, 'Legacy millisecond copy of the effective extension disconnection time; null means never observed.'),
    extensionTakeovers: described(object({
        count: described({ type: 'integer' }, 'Number of takeovers retained within the bounded recent observation window.'),
        lastAtMs: described({ oneOf: [described(number, 'Last observed takeover time as Unix epoch milliseconds.'), described({ type: 'null' }, 'No extension takeover has ever been observed.')] }, 'Last observed takeover time in milliseconds; it can fall outside the count window.'),
        saturated: described(boolean, 'Whether the bounded counter is a lower bound because more takeovers occurred than retained.'),
    }, ['count', 'lastAtMs', 'saturated']), 'Bounded recent observations of extension socket takeovers without browser-profile identity.'),
    extensionVersion: described(string, 'Legacy copy of the effective extension version; it is not independent evidence.'),
    ozonSellerPromotionReportSupported: described(boolean, 'Legacy copy of the single-promotion-report capability; omission means unobserved.'),
    ozonSellerPromotionReportsSupported: described(boolean, 'Legacy copy of the packaged-promotion-reports capability; omission means unobserved.'),
    ozonSellerAnalyticsReportSupported: described(boolean, 'Legacy copy of the analytics-report capability; omission means unobserved.'),
    peerRejection: described(peerRejectionSchema, 'Current continuous peer-rejection streak; omitted when none is active.'),
    bridgeVersion: described(string, 'Version of the local bridge build producing this status.'),
    bridgeGeneration: described(positiveInteger, 'Compatibility generation used for coordinated bridge replacement.'),
    controlProtocolVersion: described(positiveInteger, 'Local authenticated peer-control protocol version.'),
    extensionProtocolVersion: described(positiveInteger, 'Extension protocol version supported by this bridge build.'),
    instanceId: described(string, 'Ephemeral identifier of this local bridge process; it is not a host or user identity.'),
    websocket: described(string, 'Configured loopback WebSocket endpoint; it does not prove ownership or reachability.'),
    storage: described(storageStatusSchema, 'Read-only resolution status for the three configured storage targets.'),
    diagnostics: described(bridgeDiagnosticsSchema, 'Typed passive observations collected with this status response.'),
}, ['ok', 'extensionConnected', 'bridgeRole', 'storage']), 'Passive local bridge status response; successful construction is distinct from product health.');

const operationDiagnosticSchema = described(object({
    schemaVersion: described({ const: 1 }, 'Version of the operation-diagnostic receipt contract.'), handle: described(string, 'Opaque handle for the latest real completion in this MCP process.'), stage: described(string, 'Last operation stage established by the producer.'), outcome: described({ type: 'string', enum: ['succeeded', 'partial', 'failed', 'uncertain'] }, 'Observed terminal outcome without converting uncertainty into failure.'),
    retryDisposition: described({ type: 'string', enum: ['allowed', 'forbidden', 'requires_new_authorization', 'unknown'] }, 'Whether repeating the original operation is safe under its existing authorization contract.'),
}, ['schemaVersion', 'handle', 'stage', 'outcome', 'retryDisposition']), 'Terminal receipt for one exact real operation completion in this MCP process.');
export const codexMcpAuthFactsSchema = object({
    host: { const: 'codex' }, context: { const: 'configuration_snapshot' },
    inspector: { const: 'cli_config_reader' },
    status: { type: 'string', enum: ['not_logged_in', 'credentials_present', 'unknown_status', 'missing', 'ambiguous'] },
    installationMatch: { const: 'not_verified' },
    servers: array(object({
        role: { type: 'string', enum: ['remote', 'local'] },
        authStatus: { type: 'string', enum: ['unknown', 'unsupported', 'notLoggedIn', 'bearerToken', 'oAuth'] },
        enabled: boolean,
    }, ['role', 'authStatus'])),
}, ['host', 'context', 'inspector', 'status', 'installationMatch', 'servers']);
const diagnosisCheckSchema = described(object({
    check: described(string, 'Stable identifier for this bounded diagnostic observation.'), state: described({ type: 'string', enum: DIAGNOSTIC_STATES }, 'Observation result, preserving unknown, unsupported, and not_checked separately.'), observedAt: described(string, 'ISO timestamp at which this check made its observation.'), source: described(string, 'Component that produced the check without implying another execution plane.'), executionPlane: described(string, 'Execution plane on which this check actually ran.'),
    facts: described({ type: 'object', additionalProperties: true }, 'Check-specific sanitized facts defined in DIAGNOSTICS.md; omitted when unavailable.'), cause: described(string, 'Safe cause classification defined for this check; omitted when none was observed.'), evidenceRefs: described(array(described(string, 'One safe reference to separately retained evidence, not an embedded path or raw error.')), 'Safe references to separately retained evidence; omitted when none exist.'), nextCheck: described(string, 'Smallest named observation that can discriminate remaining uncertainty.'),
}, ['check', 'state', 'observedAt', 'source', 'executionPlane']), 'One bounded diagnostic observation with explicit provenance and omission semantics.');
const diagnosisSchema = described(object({
    schemaVersion: described({ const: 1 }, 'Version of the scoped diagnosis response contract.'), scope: described({ type: 'string', enum: ['installation', 'runtime', 'last_operation'] }, 'Diagnostic scope actually evaluated by this response.'),
    mode: described({ type: 'string', enum: ['passive', 'safe_probes'] }, 'Requested observation mode; safe_probes runs only explicitly allowlisted probes.'), checks: described(array(described(diagnosisCheckSchema, 'One bounded DiagnosticCheck in response order.')), 'Ordered bounded checks produced for the selected scope and mode.'), operation: described(operationDiagnosticSchema, 'Receipt for the exact requested operation handle; omitted outside a matched last_operation diagnosis.'),
}, ['schemaVersion', 'scope', 'mode', 'checks']), 'Scoped technical diagnosis response that preserves uncertainty and never repeats business work.');

const withOperationDiagnostic = (schema) => schema.oneOf
    ? { ...schema, oneOf: schema.oneOf.map(withOperationDiagnostic) }
    : { ...schema, properties: { ...schema.properties, operationDiagnostic: operationDiagnosticSchema } };

const triggerUrlProperty = {
    type: 'string',
    minLength: 1,
    maxLength: MAX_BROWSER_JOB_TOKEN_BYTES,
    description:
        'Opaque browser authorization injected by the trusted Claude or Codex host hook immediately before this local tool call. ' +
        'It is transport-only; model-authored arguments must omit both triggerUrl and trigger_url. The conservative schema maxLength is a character count; ' +
        'runtime authoritatively enforces the 128 KiB UTF-8 byte limit.',
};

const ozonTriggerUrlProperty = {
    type: 'string',
    minLength: 1,
    maxLength: MAX_BROWSER_JOB_TOKEN_BYTES,
    description:
        'Opaque browser authorization injected by the trusted Claude or Codex host hook immediately before this Ozon tool call. It is transport-only; model-authored arguments must omit both triggerUrl and trigger_url.',
};

const canonicalDateProperty = {
    type: 'string',
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    description: 'Canonical Gregorian calendar date in YYYY-MM-DD form.',
};

const ozonPromotionArtifactSchema = object(
    {
        name: { type: 'string', pattern: '^ozon-seller-promotion-\\d{4}-\\d{2}-\\d{2}-\\d{4}-\\d{2}-\\d{2}\\.xlsx$' },
        mimeType: { const: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        size: nonNegativeInteger,
        sha256: { type: 'string', minLength: 64, maxLength: 64 },
    },
    ['name', 'mimeType', 'size', 'sha256']
);

const ozonAnalyticsArtifactSchema = object(
    {
        name: { type: 'string', pattern: '^ozon-seller-analytics-(period|daily)-\\d{4}-\\d{2}-\\d{2}-\\d{4}-\\d{2}-\\d{2}\\.xlsx$' },
        mimeType: { const: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        size: nonNegativeInteger,
        sha256: { type: 'string', minLength: 64, maxLength: 64 },
    },
    ['name', 'mimeType', 'size', 'sha256']
);

// Устаревшее расширение не получает собственный терминальный код: набор кодов зафиксирован в общем
// с расширением контракте. Диагноз едет в message и в этих полях, поэтому его видно и агенту, и в
// структурированном ответе, а обычный отказ маршрута остаётся без details.
const ozonExtensionOutdatedDetailsSchema = object(
    {
        reason: { const: OZON_EXTENSION_OUTDATED_REASON },
        requiredCapability: { const: OZON_PROMOTION_CAPABILITY },
        requiredExtensionVersion: { const: OZON_PROMOTION_MIN_EXTENSION_VERSION },
        updateUrl: { const: EXTENSION_UPDATE_URL },
        installedExtensionVersion: string,
    },
    ['reason', 'requiredCapability', 'requiredExtensionVersion', 'updateUrl']
);

const ozonPromotionErrorSchema = objectUnion(
    ...Object.entries(OZON_PROMOTION_TERMINAL_CODE_STAGES).map(([code, stage]) =>
        object(
            {
                code: { const: code },
                message: { type: 'string', minLength: 1, maxLength: 500 },
                stage: { const: stage },
                retryable: { const: false },
                ...(code === 'OZON_ROUTE_NOT_READY' ? { details: ozonExtensionOutdatedDetailsSchema } : {}),
                ...(code === 'OZON_AUTHORIZATION_REJECTED' ? { details: browserJobRejectionDetailsSchema } : {}),
            },
            ['code', 'message', 'stage', 'retryable']
        )
    )
);

const localStorageUnavailableSchema = object(
    {
        code: { const: 'LOCAL_STORAGE_UNAVAILABLE' },
        message: { const: 'Local output storage is unavailable.' },
        stage: { const: 'storage' },
        retryable: { const: false },
    },
    ['code', 'message', 'stage', 'retryable']
);

const ozonPromotionSuccessSchema = object(
    {
        ok: { const: true },
        status: { const: 'complete' },
        jobType: { const: 'ozon_seller_promotion_report' },
        dateFrom: canonicalDateProperty,
        dateTo: canonicalDateProperty,
        artifact: ozonPromotionArtifactSchema,
        fileDelivery: fileDeliverySchema,
    },
    ['ok', 'status', 'jobType', 'dateFrom', 'dateTo', 'artifact']
);

const ozonPromotionFailureSchema = object(
    {
        ok: { const: false },
        status: { const: 'failed' },
        jobType: { const: 'ozon_seller_promotion_report' },
        dateFrom: canonicalDateProperty,
        dateTo: canonicalDateProperty,
        error: objectUnion(ozonPromotionErrorSchema, localStorageUnavailableSchema),
    },
    ['ok', 'status', 'jobType', 'dateFrom', 'dateTo', 'error']
);

const ozonPromotionPreflightFailureSchema = object(
    {
        ok: { const: false },
        status: { const: 'failed' },
        jobType: { const: 'ozon_seller_promotion_report' },
        error: object(
            {
                code: { const: 'PREFLIGHT_FAILED' },
                message: { type: 'string', minLength: 1, maxLength: 500 },
                stage: { const: 'preflight' },
                retryable: { const: false },
            },
            ['code', 'message', 'stage', 'retryable']
        ),
    },
    ['ok', 'status', 'jobType', 'error']
);

const ozonExecutionInterruptionDetailsSchema = objectUnion(
    object({ phase: { type: 'string', enum: ['pre_create', 'create_dispatched'] }, createOutcome: { const: 'not_started' } }, ['phase', 'createOutcome']),
    object({ phase: { const: 'create_settled' }, createOutcome: { const: 'confirmed' } }, ['phase', 'createOutcome']),
    object({ phase: { type: 'string', enum: ['polling', 'downloading', 'streaming'] },
        createOutcome: { type: 'string', enum: ['not_started', 'confirmed'] } }, ['phase', 'createOutcome'])
);

const ozonPackageError = (codeStages, analytics = false) =>
    objectUnion(
        ...Object.entries(codeStages).map(([code, stage]) =>
            object(
                {
                    code: { const: code },
                    message: { type: 'string', minLength: 1, maxLength: 500 },
                    stage: { const: stage },
                    retryable: { const: false },
                    ...(analytics && code === 'REPORT_TERMINAL_FAILURE' ? { details: object({
                        marketplaceErrorCode: { type: 'integer', minimum: -2147483648, maximum: 2147483647 },
                    }, ['marketplaceErrorCode']) } : {}),
                    ...(code === 'OZON_EXECUTION_INTERRUPTED' ? { details: ozonExecutionInterruptionDetailsSchema } : {}),
                    ...(code === 'OZON_AUTHORIZATION_REJECTED' ? { details: browserJobRejectionDetailsSchema } : {}),
                },
                ['code', 'message', 'stage', 'retryable']
            )
        ),
        localStorageUnavailableSchema
    );


const promotionPeriodFields = {
    dateFrom: canonicalDateProperty,
    dateTo: canonicalDateProperty,
};
const analyticsReportFields = {
    ...promotionPeriodFields,
    breakdown: { type: 'string', enum: ['period', 'daily'] },
};
const packageItemSchemas = (fields, artifactSchema, errorSchema) => {
    fields = { ...fields, itemIndex: { type: 'integer', minimum: 0, maximum: MAX_OZON_REPORT_PACKAGE_ITEMS - 1 } };
    const requiredFields = Object.keys(fields);
    const complete = object(
        { ...fields, status: { const: 'complete' }, artifact: artifactSchema },
        [...requiredFields, 'status', 'artifact']
    );
    const failed = object(
        { ...fields, status: { const: 'failed' }, error: errorSchema },
        [...requiredFields, 'status', 'error']
    );
    const skipped = object({ ...fields, status: { const: 'skipped' } }, [...requiredFields, 'status']);
    return { complete, failed, skipped, error: errorSchema, any: objectUnion(complete, failed, skipped), incomplete: objectUnion(failed, skipped) };
};

const promotionPackageItems = packageItemSchemas(
    promotionPeriodFields,
    ozonPromotionArtifactSchema,
    ozonPackageError(OZON_PROMOTION_TERMINAL_CODE_STAGES)
);
const analyticsPackageItems = packageItemSchemas(
    analyticsReportFields,
    ozonAnalyticsArtifactSchema,
    ozonPackageError(OZON_ANALYTICS_TERMINAL_CODE_STAGES, true)
);

const packageResultSchema = (jobType, propertyName, itemSchemas) => {
    const result = (ok, statusValue, items, skipped = false, preexecution = false) =>
        object(
            {
                ok: { const: ok },
                status: { const: statusValue },
                jobType: { const: jobType },
                [propertyName]: items,
                fileDelivery: fileDeliverySchema,
                stopReason: skipped ? { type: 'string', enum: OZON_PACKAGE_STOP_REASONS } : { type: 'null' },
                ...(preexecution ? { error: itemSchemas.error } : {}),
            },
            ['ok', 'status', 'jobType', propertyName, 'stopReason', ...(preexecution ? ['error'] : [])]
        );
    const completeItems = array(itemSchemas.complete, { minItems: 1, maxItems: MAX_OZON_REPORT_PACKAGE_ITEMS });
    const partialItems = {
        ...array(itemSchemas.any, { minItems: 2, maxItems: MAX_OZON_REPORT_PACKAGE_ITEMS }),
        allOf: [
            { contains: itemSchemas.complete, minContains: 1 },
            { contains: itemSchemas.incomplete, minContains: 1 },
        ],
    };
    const failedItems = array(itemSchemas.incomplete, { minItems: 1, maxItems: MAX_OZON_REPORT_PACKAGE_ITEMS });
    const preflightFailure = object(
        {
            ok: { const: false },
            status: { const: 'failed' },
            jobType: { const: jobType },
            stopReason: { type: 'null' },
            error: object(
                {
                    code: { const: 'PREFLIGHT_FAILED' },
                    message: { type: 'string', minLength: 1, maxLength: 500 },
                    stage: { const: 'preflight' },
                    retryable: { const: false },
                },
                ['code', 'message', 'stage', 'retryable']
            ),
        },
        ['ok', 'status', 'jobType', 'error', 'stopReason']
    );
    return objectUnion(
        result(true, 'complete', completeItems),
        result(true, 'partial', { ...partialItems, items: objectUnion(itemSchemas.complete, itemSchemas.failed) }),
        result(true, 'partial', { ...partialItems, contains: itemSchemas.skipped }, true),
        result(false, 'failed', { ...failedItems, items: itemSchemas.failed }),
        result(false, 'failed', { ...failedItems, allOf: [{ contains: itemSchemas.skipped }, { contains: itemSchemas.failed }] }, true),
        result(false, 'failed', array(itemSchemas.skipped, { minItems: 1, maxItems: MAX_OZON_REPORT_PACKAGE_ITEMS }), true, true),
        preflightFailure
    );
};

const projectionProperties = (limitName, scope) => ({
    [limitName]: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_RETURNED_PRODUCTS,
        default: DEFAULT_RETURNED_PRODUCTS,
        description: `Maximum compact products returned for each ${scope}.`,
    },
    productNmIds: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_PRODUCT_ARTICLES,
        uniqueItems: true,
        items: positiveInteger,
        description: 'Target WB article IDs for exact position or recommendation-membership checks.',
    },
});

const liveInputSchema = (limitName, scope) =>
    object({
        triggerUrl: triggerUrlProperty,
        ...(limitName ? projectionProperties(limitName, scope) : {}),
    });

export const feedbackArtifactIdSchema = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
const feedbackSha256 = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const feedbackClaim = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' };
const feedbackSession = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const hookOnlyFeedbackField = (description) => ({
    ...description,
    description:
        `${description.description} Injected by the trusted Claude or Codex host hook immediately before this local tool call; ` +
        'model-authored arguments must omit it and every snake_case alias.',
});
// Preserve authored report text: the STDIO message limit and trusted prepare hook enforce
// MAX_MCP_MESSAGE_BYTES before rendering. The archive budget also includes the transcript;
// it is not a replacement per-field allowance for model-authored summary/details.
const feedbackPrepareSchema = object(
    {
        kind: { type: 'string', enum: FEEDBACK_KINDS },
        summary: { type: 'string', minLength: 1 },
        details: { type: 'string', minLength: 1 },
        includeTranscript: boolean,
        transcriptPath: hookOnlyFeedbackField({ type: 'string', minLength: 1, maxLength: 4096, description: 'Trusted local transcript path.' }),
        feedbackClaim: hookOnlyFeedbackField({ ...feedbackClaim, description: 'Local feedback handoff signature injected by the trusted host hook.' }),
        feedbackSession: hookOnlyFeedbackField({ ...feedbackSession, description: 'Bound host-session digest for the feedback claim.' }),
        feedbackAdapter: hookOnlyFeedbackField({ ...feedbackHostAdapterMarkerSchema, description: 'Host feedback result adapter marker.' }),
    },
    ['kind', 'summary', 'details', 'includeTranscript']
);
const feedbackSubmitSchema = object(
    {
        artifactId: feedbackArtifactIdSchema,
        uploadUrl: hookOnlyFeedbackField({ type: 'string', minLength: 1, maxLength: 8192, description: 'Signed HTTPS upload URL.' }),
        requiredHeaders: hookOnlyFeedbackField({ type: 'object', properties: {}, additionalProperties: { type: 'string', maxLength: 8192 }, description: 'Signed required request headers.' }),
        objectKey: hookOnlyFeedbackField({ type: 'string', minLength: 1, maxLength: 1024, description: 'Storage object key.' }),
        expiresAt: hookOnlyFeedbackField({ type: 'integer', minimum: 1, description: 'Upload grant expiry timestamp.' }),
        expectedSize: hookOnlyFeedbackField({ type: 'integer', minimum: 1, maximum: FEEDBACK_MAX_BYTES, description: 'Expected archive size in bytes.' }),
        expectedSha256: hookOnlyFeedbackField({ ...feedbackSha256, description: 'Expected archive SHA-256.' }),
        feedbackClaim: hookOnlyFeedbackField({ ...feedbackClaim, description: 'Local feedback handoff signature injected by the trusted host hook.' }),
        feedbackSession: hookOnlyFeedbackField({ ...feedbackSession, description: 'Bound host-session digest for the feedback claim.' }),
        feedbackCloud: hookOnlyFeedbackField({ ...feedbackCloudTransportSchema, description: 'Cloud transport injected by the trusted cloud hook: grant-bound archive bytes for device-side upload.' }),
    },
    ['artifactId']
);
// Every feedback error message is bounded the same way. Hook-authored messages import this bound instead
// of restating it, so a published result can never fall out of the schema it is validated against.
export const FEEDBACK_MESSAGE_MAX_LENGTH = 500;
const feedbackMessage = { type: 'string', minLength: 1, maxLength: FEEDBACK_MESSAGE_MAX_LENGTH };
export const feedbackDiagnosticsSchema = object({
    operation: { type: 'string', enum: FEEDBACK_DIAGNOSTIC_OPERATIONS },
    errorType: { type: 'string', enum: FEEDBACK_DIAGNOSTIC_ERROR_TYPES },
    systemCode: { type: 'string', enum: FEEDBACK_DIAGNOSTIC_SYSTEM_CODES },
    reason: { type: 'string', enum: FEEDBACK_DIAGNOSTIC_REASONS },
    httpStatus: { type: 'integer', minimum: 100, maximum: 599 },
    source: object({ module: { type: 'string', enum: FEEDBACK_DIAGNOSTIC_MODULES }, line: { type: 'integer', minimum: 1, maximum: 9999999 }, column: { type: 'integer', minimum: 1, maximum: 9999999 } }, ['module', 'line', 'column']),
}, ['operation']);
const feedbackErrorObject = (properties, required) => object({ ...properties, details: feedbackDiagnosticsSchema }, required);
const feedbackErrorSchema = objectUnion(
    feedbackErrorObject({ code: { const: 'FEEDBACK_SUBMISSION_FAILED' }, message: feedbackMessage, stage: { const: 'submit' }, retryable: { const: false } }, ['code', 'message', 'stage', 'retryable']),
    feedbackErrorObject({ code: { const: 'FEEDBACK_HOOK_HANDOFF_UNAVAILABLE' }, message: feedbackMessage, stage: { const: 'handoff' }, retryable: { const: false } }, ['code', 'message', 'stage', 'retryable']),
    feedbackErrorObject({ code: { const: 'ARTIFACT_UNAVAILABLE' }, message: feedbackMessage, stage: { const: 'artifact' }, retryable: { const: false } }, ['code', 'message', 'stage', 'retryable']),
    feedbackErrorObject({ code: { const: 'UPLOAD_GRANT_INVALID' }, message: feedbackMessage, stage: { const: 'grant' }, retryable: { const: false } }, ['code', 'message', 'stage', 'retryable']),
    feedbackErrorObject({ code: { const: 'UPLOAD_REJECTED' }, message: feedbackMessage, stage: { const: 'upload' }, retryable: { const: false } }, ['code', 'message', 'stage', 'retryable']),
    feedbackErrorObject({ code: { const: 'UPLOAD_UNCERTAIN' }, message: feedbackMessage, stage: { const: 'upload' }, retryable: { const: false } }, ['code', 'message', 'stage', 'retryable']),
    feedbackErrorObject({ code: { const: 'UPLOAD_DESTINATION_REFUSED' }, message: feedbackMessage, stage: { const: 'grant' }, retryable: { const: false } }, ['code', 'message', 'stage', 'retryable']),
    feedbackErrorObject({ code: { const: 'FEEDBACK_ARCHIVE_MISMATCH' }, message: feedbackMessage, stage: { const: 'artifact' }, retryable: { const: false } }, ['code', 'message', 'stage', 'retryable'])
);
const feedbackPreparationErrorSchema = objectUnion(
    feedbackErrorObject({ code: { const: 'FEEDBACK_INPUT_INVALID' }, message: feedbackMessage, stage: { const: 'prepare' }, retryable: { const: false }, recommendedAction: { const: 'RETRY_WITH_VALID_REPORT' } }, ['code', 'message', 'stage', 'retryable', 'recommendedAction']),
    feedbackErrorObject({ code: { const: 'FEEDBACK_HOOK_HANDOFF_UNAVAILABLE' }, message: feedbackMessage, stage: { const: 'handoff' }, retryable: { const: false }, recommendedAction: { const: 'CHECK_FEEDBACK_HOOKS' } }, ['code', 'message', 'stage', 'retryable', 'recommendedAction']),
    feedbackErrorObject({ code: { const: 'FEEDBACK_CLAIM_INVALID' }, message: feedbackMessage, stage: { const: 'handoff' }, retryable: { const: false }, recommendedAction: { const: 'RESTART_FEEDBACK_FLOW' } }, ['code', 'message', 'stage', 'retryable', 'recommendedAction']),
    feedbackErrorObject({ code: { const: 'TRANSCRIPT_UNAVAILABLE' }, message: feedbackMessage, stage: { const: 'transcript' }, retryable: { const: true }, recommendedAction: { const: 'RETRY_FEEDBACK_ONCE' } }, ['code', 'message', 'stage', 'retryable', 'recommendedAction']),
    feedbackErrorObject({ code: { const: 'FEEDBACK_ARCHIVE_FAILED' }, message: feedbackMessage, stage: { const: 'archive' }, retryable: { const: true }, recommendedAction: { const: 'RETRY_FEEDBACK_ONCE' } }, ['code', 'message', 'stage', 'retryable', 'recommendedAction']),
    feedbackErrorObject({ code: { const: 'FEEDBACK_STORAGE_UNAVAILABLE' }, message: feedbackMessage, stage: { const: 'storage' }, retryable: { const: true }, recommendedAction: { const: 'CHECK_LOCAL_STORAGE' } }, ['code', 'message', 'stage', 'retryable', 'recommendedAction']),
    feedbackErrorObject({ code: { const: 'FEEDBACK_PREPARATION_FAILED' }, message: feedbackMessage, stage: { const: 'prepare' }, retryable: { const: true }, recommendedAction: { const: 'RETRY_FEEDBACK_ONCE' } }, ['code', 'message', 'stage', 'retryable', 'recommendedAction'])
);
const feedbackPrepareSuccessSchema = object(
    { ok: { const: true }, status: { const: 'prepared' }, artifactId: feedbackArtifactIdSchema, kind: { type: 'string', enum: FEEDBACK_KINDS }, sizeBytes: positiveInteger, sha256: feedbackSha256, transcriptIncluded: boolean, summary: { type: 'string', minLength: 1, maxLength: 512 } },
    ['ok', 'status', 'artifactId', 'kind', 'sizeBytes', 'sha256', 'transcriptIncluded', 'summary']
);
const feedbackPrepareFailureSchema = object(
    { ok: { const: false }, status: { const: 'failed' }, error: feedbackPreparationErrorSchema },
    ['ok', 'status', 'error']
);
// The storage object key an accepted upload wrote, published as this report's support reference. Every
// route that accepts, stores, re-emits or publishes that key tests it here, so the value cannot pass one
// boundary and fail another; the byte bound is at least as strict as the schema's code-unit maxLength.
export const FEEDBACK_REPORT_ID_MAX_LENGTH = 1024;
const REPORT_ID_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
export const isPublishableObjectKey = (value) =>
    typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= FEEDBACK_REPORT_ID_MAX_LENGTH
    && !REPORT_ID_CONTROL_CHARACTERS.test(value);
const feedbackSubmitSuccessSchema = object(
    { ok: { const: true }, status: { const: 'uploaded' }, artifactId: feedbackArtifactIdSchema, transcriptIncluded: boolean,
        reportId: { type: 'string', minLength: 1, maxLength: FEEDBACK_REPORT_ID_MAX_LENGTH } },
    ['ok', 'status', 'artifactId', 'transcriptIncluded', 'reportId']
);
const feedbackSubmitFailureSchema = object(
    { ok: { const: false }, status: { type: 'string', enum: ['failed', 'rejected', 'uncertain'] }, artifactId: feedbackArtifactIdSchema, error: feedbackErrorSchema },
    ['ok', 'status', 'error']
);
const feedbackCloudNotStartedSchema = object({
    ok: { const: false }, status: { const: 'not_started' }, artifactId: feedbackArtifactIdSchema,
    // insufficient_execution_budget is no longer produced: no hook uploads, so neither runs a budget
    // check. It stays accepted so attempt and operation records the previous build wrote remain
    // readable for the rest of their 24-hour retention.
    reason: { type: 'string', enum: ['insufficient_execution_budget', 'FEEDBACK_GRANT_REFRESH_REQUIRED'] },
    error: feedbackErrorObject({ code: { type: 'string', enum: ['insufficient_execution_budget', 'FEEDBACK_GRANT_REFRESH_REQUIRED', 'FEEDBACK_GRANT_MISSING', 'FEEDBACK_SUBMISSION_FAILED'] },
        message: feedbackMessage, stage: { const: 'handoff' }, retryable: { const: false } }, ['code', 'message', 'stage', 'retryable']),
}, ['ok', 'status', 'artifactId', 'error']);
const feedbackPrepareHostUnavailableSchema = object(
    {
        ok: { const: false },
        status: { const: 'host_result_unavailable' },
        adapter: object({
            ...feedbackHostAdapterMarkerSchema.properties,
            targetTool: { const: 'prepare_e_comet_feedback' },
        }, ['version', 'operationId', 'nonce', 'targetTool']),
        bridgeStatus: feedbackDeviceSnapshotSchema,
        error: object({
            code: { const: 'FEEDBACK_HOST_RESULT_UNAVAILABLE' },
            message: feedbackMessage,
            stage: { const: 'handoff' },
            retryable: { const: false },
        }, ['code', 'message', 'stage', 'retryable']),
    },
    ['ok', 'status', 'adapter', 'bridgeStatus', 'error']
);

const describedToolName = described(
    { type: 'string', enum: [...CONTRACT_TOOL_NAMES] },
    'Exact local e-Comet tool whose current supported tool contract is requested.'
);

const describedToolContractSchema = object({
    schemaVersion: { const: 1 },
    type: { const: 'e_comet_tool_contract' },
    requestedTool: { type: 'string', enum: [...CONTRACT_TOOL_NAMES] },
    appliesTo: array({
        type: 'string',
        enum: ['browser_job', ...CONTRACT_TOOL_NAMES, 'report_issue'],
    }, { minItems: 2, maxItems: 3, uniqueItems: true }),
    contract: { type: 'string', minLength: 1 },
}, ['schemaVersion', 'type', 'requestedTool', 'appliesTo', 'contract']);

export const toolInputSchemas = {
    local_bridge_status: described(object({}), 'No arguments: this tool passively observes existing local bridge state.'),
    e_comet_diagnose: described(object({
        scope: described({ type: 'string', enum: ['installation', 'runtime', 'last_operation'] }, 'Evidence domain to inspect: packaged installation, current bridge runtime, or one exact operation receipt.'),
        mode: described({ type: 'string', enum: ['passive', 'safe_probes'] }, 'Passive reads existing facts; safe_probes additionally runs only the explicitly selected allowlisted probes.'),
        operationHandle: described(string, 'Opaque handle returned by the exact terminal operation; required only for last_operation and never substitutes the latest result.'),
        probes: described(array(described({ type: 'string', enum: ['storage_write', 'extension_snapshot', 'hook_permissions', 'codex_mcp_auth', 'extension_install'] }, 'storage_write, hook_permissions, codex_mcp_auth and extension_install apply only to installation; extension_snapshot applies only to runtime.'), { uniqueItems: true }), 'Allowlisted probes requested for safe_probes mode; an inapplicable requested probe is not executed and is omitted from checks.'),
    }, ['scope', 'mode']), 'Selects one diagnostic scope and observation mode without authorizing a business operation.'),
    describe_e_comet_tool: described(
        object({ name: describedToolName }, ['name']),
        'Selects one current supported tool contract without executing a business operation.'
    ),
    wb_product_card: liveInputSchema(),
    wb_search_by_query: liveInputSchema('productLimitPerQuery', 'query'),
    wb_check_by_query: liveInputSchema(),
    wb_recommendations_by_product: liveInputSchema('productLimitPerSource', 'source product'),
    wb_seller_reviews: liveInputSchema(),
    prepare_e_comet_feedback: feedbackPrepareSchema,
    submit_e_comet_feedback: feedbackSubmitSchema,
    ozon_seller_promotion_report: object(
        {
            dateFrom: canonicalDateProperty,
            dateTo: canonicalDateProperty,
            triggerUrl: ozonTriggerUrlProperty,
        },
        ['dateFrom', 'dateTo']
    ),
    ozon_seller_promotion_reports: object(
        {
            periods: array(object(promotionPeriodFields, ['dateFrom', 'dateTo']), {
                minItems: 1,
                maxItems: MAX_OZON_REPORT_PACKAGE_ITEMS,
                uniqueItems: true,
            }),
            triggerUrl: ozonTriggerUrlProperty,
        },
        ['periods']
    ),
    ozon_seller_analytics_report: object(
        {
            reports: array(object(analyticsReportFields, ['dateFrom', 'dateTo', 'breakdown']), {
                minItems: 1,
                maxItems: MAX_OZON_REPORT_PACKAGE_ITEMS,
                uniqueItems: true,
            }),
            triggerUrl: ozonTriggerUrlProperty,
        },
        ['reports']
    ),
    wb_product_images: object(
        {
            nmIds: {
                type: 'array',
                minItems: 1,
                maxItems: MAX_IMAGE_ARTICLES,
                uniqueItems: true,
                items: { type: 'integer', minimum: 10000, maximum: 9999999999 },
            },
            maxPhotos: {
                type: 'integer',
                minimum: 1,
                maximum: MAX_IMAGE_PHOTOS,
                default: DEFAULT_IMAGE_PHOTOS,
            },
            maxBasket: {
                type: 'integer',
                minimum: 1,
                maximum: MAX_IMAGE_BASKET,
                default: MAX_IMAGE_BASKET,
            },
            size: { type: 'string', enum: ['big', 'tm'], default: 'big' },
            timeout: { type: 'number', minimum: 1000, maximum: 30000, default: 5000 },
        },
        ['nmIds']
    ),
};

export const toolOutputSchemas = {
    local_bridge_status: bridgeStatusSchema,
    e_comet_diagnose: diagnosisSchema,
    describe_e_comet_tool: describedToolContractSchema,
    wb_product_card: withOperationDiagnostic(objectUnion(...liveAggregateSchemas(productCardSuccessSchema), toolErrorSchema)),
    wb_search_by_query: withOperationDiagnostic(objectUnion(...liveAggregateSchemas(searchSuccessSchema), toolErrorSchema)),
    wb_check_by_query: withOperationDiagnostic(objectUnion(...liveAggregateSchemas(checkSuccessSchema), toolErrorSchema)),
    wb_recommendations_by_product: withOperationDiagnostic(objectUnion(...liveAggregateSchemas(recommendationsSuccessSchema), toolErrorSchema)),
    wb_seller_reviews: withOperationDiagnostic(objectUnion(sellerReviewsSuccessSchema, toolErrorSchema)),
    prepare_e_comet_feedback: withOperationDiagnostic(objectUnion(feedbackPrepareSuccessSchema, feedbackPrepareFailureSchema, feedbackPrepareHostUnavailableSchema)),
    submit_e_comet_feedback: withOperationDiagnostic(objectUnion(feedbackSubmitSuccessSchema, feedbackSubmitFailureSchema, feedbackCloudNotStartedSchema)),
    wb_product_images: withOperationDiagnostic(objectUnion(...liveAggregateSchemas(imagesSuccessSchema), toolErrorSchema)),
    ozon_seller_promotion_report: withOperationDiagnostic(objectUnion(ozonPromotionSuccessSchema, ozonPromotionFailureSchema, ozonPromotionPreflightFailureSchema)),
    ozon_seller_promotion_reports: withOperationDiagnostic(packageResultSchema(
        'ozon_seller_promotion_reports',
        'periods',
        promotionPackageItems
    )),
    ozon_seller_analytics_report: withOperationDiagnostic(packageResultSchema(
        'ozon_seller_analytics_report',
        'reports',
        analyticsPackageItems
    )),
};

export const schemaContractTerms = (schema = bridgeStatusSchema) => {
    const terms = new Set();
    const visit = (node, path) => {
        if (!node || typeof node !== 'object') return;
        if (path) terms.add(path);
        if (Array.isArray(node.enum)) for (const value of node.enum) terms.add(`${path}=${value}`);
        if (Object.hasOwn(node, 'const') && ['string', 'boolean', 'number'].includes(typeof node.const)) terms.add(`${path}=${node.const}`);
        for (const alternative of node.oneOf ?? []) visit(alternative, path);
        for (const [name, child] of Object.entries(node.properties ?? {})) visit(child, path ? `${path}.${name}` : name);
    };
    visit(schema, '');
    return Object.freeze([...terms].sort());
};

export { validateSchemaValue } from './schema-validation.mjs';
