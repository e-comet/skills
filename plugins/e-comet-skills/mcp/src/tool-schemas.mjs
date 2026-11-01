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
import { BRIDGE_CODES, BRIDGE_COMSPEC_STATES, BRIDGE_OWNERS, BRIDGE_REGISTRATION_STATES, BRIDGE_RUNTIME_RECHECKS, BRIDGE_RUNTIMES, BRIDGE_STATUS_CODES } from './bridge-codes.mjs';
import { FEEDBACK_DIAGNOSTIC_OPERATIONS, FEEDBACK_DIAGNOSTIC_ERROR_TYPES, FEEDBACK_DIAGNOSTIC_SYSTEM_CODES, FEEDBACK_DIAGNOSTIC_MODULES, FEEDBACK_DIAGNOSTIC_REASONS } from './feedback-diagnostics.mjs';
import { CONTRACT_TOOL_NAMES } from './tool-contracts.mjs';
import {
    EXTENSION_UPDATE_URL,
    FETCH_ERROR_CODES,
    OZON_ANALYTICS_TERMINAL_CODE_STAGES,
    OZON_PROMOTION_CAPABILITY,
    OZON_PROMOTION_MIN_EXTENSION_VERSION,
    OZON_SEARCH_POSITIONS_TERMINAL_CODE_STAGES,
} from './extension-vocabulary.mjs';
import { ARTIFACT_FAILURE_CLASSES, DESCRIPTOR_RULES, FAILURE_DETAIL_VALUES, OZON_EXTENSION_OUTDATED_REASON, OZON_PROMOTION_TERMINAL_CODE_STAGES } from './tool-errors.mjs';
import { MAX_OZON_REPORT_PACKAGE_ITEMS } from './ozon-report-package-domain.mjs';
import { OZON_PACKAGE_STOP_REASONS, OZON_SEARCH_POSITIONS_STOP_REASONS } from './ozon-report-package-result.mjs';
import {
    MAX_OZON_SEARCH_POSITIONS_SKUS,
    MAX_OZON_SEARCH_POSITIONS_TEXT_LENGTH,
    OZON_SEARCH_POSITIONS_DEFAULT_REGION,
    OZON_SEARCH_POSITIONS_PLATFORMS,
} from './ozon-search-positions-domain.mjs';
import { DIAGNOSTIC_STATES, EXTENSION_INSTALL_VOCABULARY, extensionInstallFactsSchema, extensionLogFactsSchema, HOST_LAST_FAILURES, hookPermissionsFactsSchema } from './diagnostic-facts.mjs';
import { TRANSPORT_EVENT_KINDS } from './transport-events.mjs';
// The producers validate their facts against these; the feedback projection reads the same objects.
export { extensionInstallFactsSchema, hookPermissionsFactsSchema };

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
const nullable = (schema, nullDescription) => ({ oneOf: [schema, described({ type: 'null' }, nullDescription)] });
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

const closedValue = (key) => ({ type: 'string', enum: [...FAILURE_DETAIL_VALUES[key]] });
// The closed `details` of a local failure: a reason, timeout phase, failure class, WBAAS outcome, filesystem code,
// descriptor rule, Seller refusal and HTTP status, or the request counts of a stopped job.
const failureDetailsSchema = object({
    ...Object.fromEntries(Object.keys(FAILURE_DETAIL_VALUES).map((key) => [key, closedValue(key)])),
    wbRefused: boolean,
    httpStatus: { type: 'integer', minimum: 100, maximum: 599 },
    completed: nonNegativeInteger,
    pending: nonNegativeInteger,
});
const buyerErrorProperties = {
    skipped: boolean,
    errorDetails: object({
        code: { type: 'string', enum: [...Object.values(FETCH_ERROR_CODES), 'WB_FETCH_FAILED', 'WB_RATE_LIMITED', 'WB_REQUEST_FAILED'] },
        stage: { const: 'execution' },
        retryable: boolean,
        phase: closedValue('phase'),
        recovery: closedValue('recovery'),
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
    ...['public_key_not_configured', 'user_not_available', 'invalid_format', 'invalid_algorithm', 'invalid_signature', 'issuer_mismatch', 'audience_mismatch', 'subject_mismatch', 'expired', 'token_reuse', 'ecomet_not_authenticated', 'activation_storage_unavailable', 'storage_unavailable', 'unknown']
        .map((reason) => object({ schemaVersion: { const: 1 }, reason: { const: reason } }, ['schemaVersion', 'reason'])),
    object({ schemaVersion: { const: 1 }, reason: { type: 'string', enum: ['device_clock_ahead', 'device_clock_behind'] }, skewMinutes: nonNegativeInteger }, ['schemaVersion', 'reason'])
);
const browserJobRejectionDetailsSchema = object({ browserJobRejection: browserJobRejectionSchema }, ['browserJobRejection']);
// An Ozon authorization failure carries either the extension's rejection or, when no broker answered, the bridge cause,
// or the local descriptor rule the signed job broke.
const ozonAuthorizationRejectedDetailsSchema = objectUnion(browserJobRejectionDetailsSchema,
    object({ bridgeCode: { type: 'string', enum: [...BRIDGE_CODES] } }, ['bridgeCode']),
    object({ rule: { type: 'string', enum: [...DESCRIPTOR_RULES] } }, ['rule']));
const artifactRejectedDetailsSchema = object({ class: { type: 'string', enum: [...ARTIFACT_FAILURE_CLASSES] }, systemCode: closedValue('systemCode') }, ['class']);

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
    }, ['operation', 'systemCode']), browserJobRejectionDetailsSchema, failureDetailsSchema),
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
    httpStatus: integer,
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

const filtersQuerySchema = object({
    skipped: boolean,
    errorDetails: object({
        code: {
            type: 'string',
            enum: [...Object.values(FETCH_ERROR_CODES), 'WB_FETCH_FAILED', 'WB_RATE_LIMITED', 'WB_REQUEST_FAILED',
                'WB_UNRELIABLE_RESPONSE', 'WB_FULL_LISTS_INCOMPLETE'],
        },
        stage: { const: 'execution' },
        retryable: boolean,
        phase: closedValue('phase'),
        recovery: closedValue('recovery'),
    }, ['code', 'stage', 'retryable']),
    query: string,
    status: { type: 'string', enum: ['ok', 'partial', 'empty', 'request_failed', 'rate_limited'] },
    httpStatus: integer,
    filterKeys: array(string),
    error: string,
}, ['query', 'status']);

const filterSchema = object({
    kind: { type: 'string', enum: ['characteristic', 'category'] },
    name: string,
    key: string,
    complete: boolean,
    values: array(string),
    queryCount: positiveInteger,
}, ['kind', 'name', 'key', 'complete', 'values', 'queryCount']);

const filtersSuccessSchema = object({
    stopReason: { const: 'rate_limited' },
    ...liveBaseProperties,
    jobType: { const: 'filters_by_query' },
    complete: boolean,
    requestsMade: nonNegativeInteger,
    queries: array(filtersQuerySchema),
    filters: array(filterSchema),
}, ['ok', 'status', 'jobType', 'jobId', 'resultPath', 'complete', 'requestsMade', 'queries', 'filters']);

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
    details: failureDetailsSchema,
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
    // Present when Wildberries answered a status poll in an unrecognized shape and the export stopped.
    stopReason: { const: 'unrecognized_response' },
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
    runtime: described(diagnosticBase('runtime', object({ nodeVersion: described(string, 'Version of the Node.js process executing this MCP server.'), platform: described(string, 'Node.js platform identifier for the process executing this MCP server.'), arch: described(string, 'Node.js architecture identifier for the process executing this MCP server.'), bridgeVersion: described(string, 'Version of the local bridge build executing this check.'), mcpProtocolVersion: described(string, 'MCP protocol version negotiated with the current client; omitted when unavailable.'), osRelease: described(string, 'Release of the operating system kernel, as os.release() reports it.') }, ['nodeVersion', 'platform', 'arch', 'bridgeVersion'])), 'Facts about the Node.js process running this MCP server.'),
    client: described(diagnosticBase('client', object({ name: described(string, 'Bounded client name supplied in MCP initialize metadata.'), version: described(string, 'Bounded client version supplied in MCP initialize metadata.'), provenance: described({ const: 'client_reported' }, 'Marks these values as client-reported rather than trusted host identity.'), hostRuntimeVersion: described(string, 'DeepSeek Harness runtime version the native adapter resolved its peers against; present only under that adapter.'), hostLastFailure: described({ type: 'string', enum: [...HOST_LAST_FAILURES] }, 'Closed class of the last failure of the local module the native DeepSeek adapter started again; present only under that adapter after a failure.'), hostRestarts: described(nonNegativeInteger, 'How many times the native DeepSeek adapter started the local module again; present only under that adapter after a restart.') }, ['name', 'version', 'provenance'])), 'Sanitized MCP initialize metadata; it does not prove host identity or hook support.'),
    routeFreshness: described(diagnosticBase('route_freshness', object({ lastObservedAt: described(string, 'Timestamp of an actually observed route response; omitted when no producer supplies one.') }, ['lastObservedAt'])), 'Freshness of a real extension-route observation, never inferred from browser-context changes.'),
    extensionLog: described(diagnosticBase('extension_log', extensionLogFactsSchema, ['permission_denied', 'io_error', 'directory_absent', 'corrupt', 'unavailable', 'unknown']), 'The e-Comet extension\'s own record of its native connection, read from the browser profile on disk by the last tool call that found no broker or the last runtime extension_log diagnosis; present only after one, and dropped when a broker connects.'),
    storage: described(diagnosticBase('storage', object({ scope: described({ const: 'configuration' }, 'Declares that these storage facts cover configuration resolution only.'), targets: described(storageStatusSchema, 'Sanitized configured storage targets without paths or write claims.') }, ['scope', 'targets'])), 'Read-only storage configuration observation; it does not test writability.'),
}, ['snapshot', 'runtime', 'client', 'routeFreshness', 'storage']);

const bridgeStatusSchema = described(object({
    ok: described({ const: true }, 'Confirms that the status response was constructed; it is not a product-health result.'),
    code: described({ type: 'string', enum: [...BRIDGE_STATUS_CODES] }, 'Closed cause of the current bridge state, read first. connected and connecting are healthy states. A BRIDGE_* value names the one observed reason no extension route exists; BRIDGE_NO_BROWSER is the one used when nothing more specific was observed. A route lost mid-job is EXTENSION_DISCONNECTED on the failing tool call; status never returns it and names the cause found since. The other fields are the evidence behind it.'),
    owner: described({ type: 'string', enum: [...BRIDGE_OWNERS] }, 'Who can act on the cause in code: user, administrator (whoever manages the computer), e_comet, or unknown. Absent while connected or connecting.'),
    comspec: described({ type: 'string', enum: [...BRIDGE_COMSPEC_STATES] }, 'Whether the Windows ComSpec variable names an existing cmd.exe, read by the last tool call that found no broker or runtime extension_log diagnosis; unknown when this process has no ComSpec, since it sees its host environment, not the browser one; present only on Windows with code BRIDGE_HOST_START_FAILED.'),
    extensionConnected: described(boolean, 'Whether this process currently holds an extension session through a broker.'),
    browserJobSupported: described(boolean, 'Whether the effective route advertised browser-job support; it does not prove a particular operation will succeed.'),
    state: described({ type: 'string', enum: ['initializing', 'waiting_for_extension', 'extension_connected_no_wb_tab', 'extension_context_unknown', 'ready', 'extension_update_required'] }, 'Ordered compatibility summary of observed bridge state, not a complete fault list or retry instruction.'),
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
    }, ['state', 'route']), 'Browser-extension observation from this process\'s broker session.'),
    browserContext: described(object({
        state: described({ type: 'string', enum: ['unknown', 'known'] }, 'Whether registered WB browser-port facts were observed.'),
        wbTabConnected: described(boolean, 'Whether the extension reports a registered standalone WB page port; this does not prove login.'),
        sellerTabConnected: described(boolean, 'Whether the extension reports a registered WB Seller page port; this does not describe Ozon.'),
        changedAt: described(string, 'ISO timestamp when the registered-port observation changed; it is not a freshness guarantee.'),
    }, ['state']), 'Extension-reported WB and WB Seller port registration; it does not cover Ozon readiness.'),
    extensionLastConnectedAtMs: described({ oneOf: [described(number, 'Observed effective extension connection time as Unix epoch milliseconds.'), described({ type: 'null' }, 'No effective extension connection has ever been observed.')] }, 'Legacy millisecond copy of the effective extension connection time; null means never observed.'),
    extensionLastDisconnectedAtMs: described({ oneOf: [described(number, 'Observed effective extension disconnection time as Unix epoch milliseconds.'), described({ type: 'null' }, 'No effective extension disconnection has ever been observed.')] }, 'Legacy millisecond copy of the effective extension disconnection time; null means never observed.'),
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

const operationDiagnosticSchema = described(object({
    schemaVersion: described({ const: 1 }, 'Version of the operation-diagnostic receipt contract.'), handle: described(string, 'Opaque handle for one of the last eight real completions in this MCP process.'),
    at: described(string, 'ISO timestamp of the completion; present in a last_operation diagnosis.'), tool: described(string, 'Local tool that completed; present in a last_operation diagnosis.'),
    code: described(string, 'Closed error code of the completion, or of its first failed item; omitted when none.'), reason: described(string, 'Closed reason or stop reason the completion carried; omitted when none.'),
    stage: described(string, 'Last operation stage established by the producer.'), outcome: described({ type: 'string', enum: ['succeeded', 'partial', 'failed', 'uncertain'] }, 'Observed terminal outcome without converting uncertainty into failure.'),
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

// A bridge tool's answer while its job still runs: not a failure; e_comet_run_result returns the final answer.
const runningAnswerSchema = object({
    ok: { const: true },
    status: { const: 'running' },
    runId: string,
    tool: string,
    elapsedSeconds: nonNegativeInteger,
    progress: object({ completed: nonNegativeInteger, total: positiveInteger }, ['completed', 'total']),
    nextStep: string,
}, ['ok', 'status', 'runId', 'tool', 'elapsedSeconds', 'nextStep']);
const withRunningAnswer = (schema) => schema.oneOf
    ? { ...schema, oneOf: [...schema.oneOf, runningAnswerSchema] }
    : objectUnion(schema, runningAnswerSchema);

const triggerUrlProperty = {
    type: 'string',
    minLength: 1,
    maxLength: MAX_BROWSER_JOB_TOKEN_BYTES,
    description:
        'Opaque browser authorization injected by the trusted Claude or Codex host hook immediately before this local tool call. ' +
        'It is transport-only; model-authored arguments must omit both triggerUrl and trigger_url, except for an mcp__remote-devices__ tool, which gets the browser_job trigger_url unchanged. The conservative schema maxLength is a character count; ' +
        'runtime authoritatively enforces the 128 KiB UTF-8 byte limit.',
};

const ozonTriggerUrlProperty = {
    type: 'string',
    minLength: 1,
    maxLength: MAX_BROWSER_JOB_TOKEN_BYTES,
    description:
        'Opaque browser authorization injected by the trusted Claude or Codex host hook immediately before this Ozon tool call. It is transport-only; model-authored arguments must omit both triggerUrl and trigger_url, except for an mcp__remote-devices__ tool, which gets the browser_job trigger_url unchanged.',
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
                ...(code === 'OZON_AUTHORIZATION_REJECTED' ? { details: ozonAuthorizationRejectedDetailsSchema } : {}),
                ...(code === 'ARTIFACT_REJECTED' ? { details: artifactRejectedDetailsSchema } : {}),
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
                    ...(code === 'OZON_AUTHORIZATION_REJECTED' ? { details: ozonAuthorizationRejectedDetailsSchema } : {}),
                    ...(code === 'ARTIFACT_REJECTED' ? { details: artifactRejectedDetailsSchema } : {}),
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
    return objectUnion(
        result(true, 'complete', completeItems),
        result(true, 'partial', { ...partialItems, items: objectUnion(itemSchemas.complete, itemSchemas.failed) }),
        result(true, 'partial', { ...partialItems, contains: itemSchemas.skipped }, true),
        result(false, 'failed', { ...failedItems, items: itemSchemas.failed }),
        result(false, 'failed', { ...failedItems, allOf: [{ contains: itemSchemas.skipped }, { contains: itemSchemas.failed }] }, true),
        result(false, 'failed', array(itemSchemas.skipped, { minItems: 1, maxItems: MAX_OZON_REPORT_PACKAGE_ITEMS }), true, true),
        preflightFailureSchema(jobType)
    );
};

// Invalid arguments are never echoed: the failure names only the broken rule.
const preflightFailureSchema = (jobType) => object(
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

const searchPositionsText = { type: 'string', minLength: 1, maxLength: MAX_OZON_SEARCH_POSITIONS_TEXT_LENGTH };
// Query rows follow the signed order; a complete row has one cell per top-level SKU, an empty row none.
const searchPositionsResultSchema = (() => {
    const details = {
        OZON_REGION_UNAVAILABLE: object({ candidates: array(searchPositionsText, { minItems: 1, maxItems: 5 }) }, ['candidates']),
        OZON_SKU_LIMIT_EXCEEDED: object({ limit: positiveInteger }, ['limit']),
        OZON_AUTHORIZATION_REJECTED: ozonAuthorizationRejectedDetailsSchema,
    };
    const error = objectUnion(...Object.entries({ ...OZON_SEARCH_POSITIONS_TERMINAL_CODE_STAGES, OZON_EXECUTION_INTERRUPTED: 'execution' })
        .map(([code, stage]) => object({
            code: { const: code },
            message: { type: 'string', minLength: 1, maxLength: 500 },
            stage: { const: stage },
            retryable: { const: false },
            ...(Object.hasOwn(details, code) ? { details: details[code] } : {}),
        }, ['code', 'message', 'stage', 'retryable'])));
    const row = (status, properties = {}) => object(
        { itemIndex: { type: 'integer', minimum: 0, maximum: MAX_OZON_REPORT_PACKAGE_ITEMS - 1 }, query: searchPositionsText, status: { const: status }, ...properties },
        ['itemIndex', 'query', 'status', ...Object.keys(properties)]
    );
    const checkedAt = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' };
    const cell = { oneOf: [positiveInteger, { type: 'string', minLength: 1, maxLength: 32 }] };
    const complete = row('complete', { checkedAt, positions: array(cell, { minItems: 1, maxItems: MAX_OZON_SEARCH_POSITIONS_SKUS }) });
    const empty = row('empty', { checkedAt, positions: array(cell, { maxItems: 0 }) });
    const failed = row('failed', { error });
    const skipped = row('skipped');
    const answered = objectUnion(complete, empty);
    const rows = (items, extra = {}) => ({ ...array(items, { minItems: 1, maxItems: MAX_OZON_REPORT_PACKAGE_ITEMS }), ...extra });
    const table = (ok, statusValue, queries, stopped) => object(
        {
            ok: { const: ok },
            status: { const: statusValue },
            jobType: { const: 'ozon_search_positions' },
            marketplace: { const: 'ozon' },
            region: searchPositionsText,
            platform: { type: 'string', enum: [...OZON_SEARCH_POSITIONS_PLATFORMS] },
            skus: array(positiveInteger, { minItems: 1, maxItems: MAX_OZON_SEARCH_POSITIONS_SKUS, uniqueItems: true }),
            queries,
            stopReason: stopped ? { type: 'string', enum: [...OZON_SEARCH_POSITIONS_STOP_REASONS] } : { type: 'null' },
            ...(stopped ? { error } : {}),
        },
        ['ok', 'status', 'jobType', 'marketplace', 'region', 'platform', 'skus', 'queries', 'stopReason', ...(stopped ? ['error'] : [])]
    );
    return objectUnion(
        table(true, 'complete', rows(answered), false),
        table(true, 'partial', rows(objectUnion(complete, empty, failed), { allOf: [{ contains: answered }, { contains: failed }] }), false),
        table(true, 'partial', rows(objectUnion(complete, empty, failed, skipped), { allOf: [{ contains: answered }, { contains: skipped }] }), true),
        table(false, 'failed', rows(failed), false),
        table(false, 'failed', rows(objectUnion(failed, skipped), { contains: skipped }), true),
        preflightFailureSchema('ozon_search_positions')
    );
})();

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
// The upload grant: in Cowork no hook can change the device call, so the model copies it from report_issue there.
const grantFeedbackField = (description) => ({
    ...description,
    description:
        `${description.description} Injected by the trusted Claude Code or Codex host hook immediately before this local tool call, and ` +
        'model-authored arguments omit it, except for an mcp__remote-devices__ tool, which copies it from report_issue and the prepared result.',
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
    },
    ['kind', 'summary', 'details', 'includeTranscript']
);
const feedbackSubmitSchema = object(
    {
        artifactId: feedbackArtifactIdSchema,
        uploadUrl: grantFeedbackField({ type: 'string', minLength: 1, maxLength: 8192, description: 'Signed HTTPS upload URL.' }),
        requiredHeaders: grantFeedbackField({ type: 'object', properties: {}, additionalProperties: { type: 'string', maxLength: 8192 }, description: 'Signed required request headers.' }),
        objectKey: grantFeedbackField({ type: 'string', minLength: 1, maxLength: 1024, description: 'Storage object key.' }),
        // Untyped: the hook injects Unix seconds, a Cowork model copies report_issue's ISO time; submit checks either.
        expiresAt: grantFeedbackField({ description: 'Upload grant expiry: Unix seconds, or report_issue expires_at as it came.' }),
        expectedSize: grantFeedbackField({ type: 'integer', minimum: 1, maximum: FEEDBACK_MAX_BYTES, description: 'Expected archive size in bytes.' }),
        expectedSha256: grantFeedbackField({ ...feedbackSha256, description: 'Expected archive SHA-256.' }),
        feedbackClaim: hookOnlyFeedbackField({ ...feedbackClaim, description: 'Local feedback handoff signature injected by the trusted host hook.' }),
        feedbackSession: hookOnlyFeedbackField({ ...feedbackSession, description: 'Bound host-session digest for the feedback claim.' }),
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
    feedbackErrorObject({ code: { const: 'UPLOAD_DESTINATION_REFUSED' }, message: feedbackMessage, stage: { const: 'grant' }, retryable: { const: false } }, ['code', 'message', 'stage', 'retryable']),
    feedbackErrorObject({ code: { const: 'UPLOAD_REJECTED' }, message: feedbackMessage, stage: { const: 'upload' }, retryable: { const: false } }, ['code', 'message', 'stage', 'retryable']),
    feedbackErrorObject({ code: { const: 'UPLOAD_UNCERTAIN' }, message: feedbackMessage, stage: { const: 'upload' }, retryable: { const: false } }, ['code', 'message', 'stage', 'retryable'])
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
        probes: described(array(described({ type: 'string', enum: ['storage_write', 'extension_snapshot', 'hook_permissions', 'codex_mcp_auth', 'extension_install', 'extension_log'] }, 'storage_write, hook_permissions, codex_mcp_auth and extension_install apply only to installation; extension_snapshot and extension_log apply only to runtime.'), { uniqueItems: true }), 'Allowlisted probes requested for safe_probes mode; an inapplicable requested probe is not executed and is omitted from checks.'),
    }, ['scope', 'mode']), 'Selects one diagnostic scope and observation mode without authorizing a business operation.'),
    describe_e_comet_tool: described(
        object({ name: describedToolName }, ['name']),
        'Selects one current supported tool contract without executing a business operation.'
    ),
    wb_product_card: liveInputSchema(),
    wb_search_by_query: liveInputSchema('productLimitPerQuery', 'query'),
    wb_check_by_query: liveInputSchema(),
    wb_filters_by_query: liveInputSchema(),
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
    // The canonicalizer checks trimming, uniqueness after trimming and the 128-character bound, as the signer does.
    ozon_search_positions: object(
        {
            queries: described(array({ type: 'string', minLength: 1 }, { minItems: 1, maxItems: MAX_OZON_REPORT_PACKAGE_ITEMS }),
                `Search queries in execution order, identical to the signed job: 1-${MAX_OZON_SEARCH_POSITIONS_TEXT_LENGTH} characters after trimming, unique.`),
            skus: described(array(positiveInteger, { minItems: 1, maxItems: MAX_OZON_SEARCH_POSITIONS_SKUS, uniqueItems: true }),
                'Ozon SKUs (own or competitors\') in result column order, identical to the signed job.'),
            region: described({ type: 'string', minLength: 1, default: OZON_SEARCH_POSITIONS_DEFAULT_REGION },
                'City or area name as Ozon lists it, identical to the signed job; never a word taken from a query.'),
            platform: described({ type: 'string', enum: [...OZON_SEARCH_POSITIONS_PLATFORMS], default: 'ozon' },
                'ozon is the main storefront; select is Ozon Select (brand storefront). Identical to the signed job.'),
            triggerUrl: ozonTriggerUrlProperty,
        },
        ['queries', 'skus']
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
    e_comet_run_result: object(
        { runId: described({ type: 'string', minLength: 1, maxLength: 64 }, 'The runId from a "running" answer of a long e-Comet tool.') },
        ['runId']
    ),
};

export const toolOutputSchemas = {
    local_bridge_status: bridgeStatusSchema,
    e_comet_diagnose: diagnosisSchema,
    describe_e_comet_tool: describedToolContractSchema,
    wb_product_card: withRunningAnswer(withOperationDiagnostic(objectUnion(...liveAggregateSchemas(productCardSuccessSchema), toolErrorSchema))),
    wb_search_by_query: withRunningAnswer(withOperationDiagnostic(objectUnion(...liveAggregateSchemas(searchSuccessSchema), toolErrorSchema))),
    wb_check_by_query: withRunningAnswer(withOperationDiagnostic(objectUnion(...liveAggregateSchemas(checkSuccessSchema), toolErrorSchema))),
    wb_filters_by_query: withRunningAnswer(withOperationDiagnostic(objectUnion(...liveAggregateSchemas(filtersSuccessSchema), toolErrorSchema))),
    wb_recommendations_by_product: withRunningAnswer(withOperationDiagnostic(objectUnion(...liveAggregateSchemas(recommendationsSuccessSchema), toolErrorSchema))),
    wb_seller_reviews: withRunningAnswer(withOperationDiagnostic(objectUnion(sellerReviewsSuccessSchema, toolErrorSchema))),
    prepare_e_comet_feedback: withOperationDiagnostic(objectUnion(feedbackPrepareSuccessSchema, feedbackPrepareFailureSchema)),
    submit_e_comet_feedback: withOperationDiagnostic(objectUnion(feedbackSubmitSuccessSchema, feedbackSubmitFailureSchema)),
    wb_product_images: withOperationDiagnostic(objectUnion(...liveAggregateSchemas(imagesSuccessSchema), toolErrorSchema)),
    ozon_seller_promotion_report: withRunningAnswer(withOperationDiagnostic(objectUnion(ozonPromotionSuccessSchema, ozonPromotionFailureSchema, ozonPromotionPreflightFailureSchema))),
    ozon_seller_promotion_reports: withRunningAnswer(withOperationDiagnostic(packageResultSchema(
        'ozon_seller_promotion_reports',
        'periods',
        promotionPackageItems
    ))),
    ozon_seller_analytics_report: withRunningAnswer(withOperationDiagnostic(packageResultSchema(
        'ozon_seller_analytics_report',
        'reports',
        analyticsPackageItems
    ))),
    ozon_search_positions: withRunningAnswer(withOperationDiagnostic(searchPositionsResultSchema)),
    // Returns any of the ten finished answers unchanged, so only their shared envelope is typed: a union of their schemas
    // would add about 395 KB to tools/list, and the original tools' schemas keep the finished answers typed.
    e_comet_run_result: object({
        ok: boolean,
        status: string,
        runId: string,
        tool: string,
        code: string,
        message: string,
        stage: string,
        retryable: boolean,
    }, ['ok'], true),
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
