import {
    DEFAULT_IMAGE_PHOTOS,
    DEFAULT_RETURNED_PRODUCTS,
    FEEDBACK_KINDS,
    MAX_BROWSER_JOB_TOKEN_BYTES,
    MAX_IMAGE_ARTICLES,
    MAX_IMAGE_BASKET,
    MAX_IMAGE_PHOTOS,
    MAX_PRODUCT_ARTICLES,
    MAX_RETURNED_PRODUCTS,
} from './config.mjs';
import { PEER_REJECTION_CODES } from './connection-state.mjs';
import {
    EXTENSION_UPDATE_URL,
    OZON_PROMOTION_CAPABILITY,
    OZON_PROMOTION_MIN_EXTENSION_VERSION,
} from './extension-vocabulary.mjs';
import { OZON_EXTENSION_OUTDATED_REASON, OZON_PROMOTION_TERMINAL_CODE_STAGES } from './tool-errors.mjs';

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
];

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

const pageSchema = object({
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
    key: string,
    ok: boolean,
    httpStatus: integer,
    error: string,
}, ['key', 'ok']);

const productCardSchema = object({
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

export const toolErrorSchema = object({
    ok: { const: false },
    code: string,
    message: string,
    stage: {
        type: 'string',
        enum: ['arguments', 'handoff', 'extension', 'authorization', 'execution', 'storage', 'images', 'seller', 'local'],
    },
    retryable: boolean,
    resultPath: string,
    storageWarnings,
}, ['ok', 'code', 'message', 'stage', 'retryable']);

const productCardSuccessSchema = object({
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
    status: { type: 'string', enum: ['ok', 'not_found'] },
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

const sellerReviewsSuccessSchema = object({
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
        code: { type: 'string', enum: Object.values(PEER_REJECTION_CODES) },
        since: string,
        retryAt: string,
    },
    ['code']
);

const bridgeStatusSchema = object({
    ok: { const: true },
    extensionConnected: boolean,
    browserJobSupported: boolean,
    bridgeRole: { type: 'string', enum: ['primary', 'secondary', 'disconnected'] },
    bridgeTransitioning: boolean,
    listenerState: { type: 'string', enum: ['pending', 'listening', 'address_in_use', 'failed'] },
    state: { type: 'string', enum: ['initializing', 'listen_failed', 'waiting_for_extension', 'extension_connected_no_wb_tab', 'extension_contended', 'extension_context_unknown', 'peer_context_unknown', 'ready', 'extension_update_required', 'peer_reconnecting', 'peer_unavailable'] },
    recommendedAction: { type: 'string', enum: ['CLOSE_DUPLICATE_EXTENSIONS', 'FIX_PEER_TOKEN_PERMISSIONS', 'NONE', 'WAIT_FOR_EXTENSION', 'OPEN_OR_REFRESH_WB', 'OPEN_AUTHENTICATED_WB', 'UPDATE_EXTENSION', 'RESTART_DESKTOP_HOSTS', 'USE_PRIMARY_AGENT'] },
    extension: object({
        state: { type: 'string', enum: ['never_connected', 'connected', 'disconnected'] },
        route: { type: 'string', enum: ['direct', 'peer', 'none'] },
        lastConnectedAt: string,
        lastDisconnectedAt: string,
        version: string,
        ozonSellerPromotionReportSupported: boolean,
    }, ['state', 'route']),
    peer: object({ bridgeVersion: string, browserContextPropagationSupported: boolean }),
    browserContext: object({
        state: { type: 'string', enum: ['unknown', 'known'] },
        wbTabConnected: boolean,
        sellerTabConnected: boolean,
        changedAt: string,
    }, ['state']),
    extensionLastConnectedAtMs: { type: ['number', 'null'] },
    extensionLastDisconnectedAtMs: { type: ['number', 'null'] },
    extensionTakeovers: object({
        count: { type: 'integer' },
        lastAtMs: { type: ['number', 'null'] },
        saturated: boolean,
    }, ['count', 'lastAtMs', 'saturated']),
    extensionVersion: string,
    ozonSellerPromotionReportSupported: boolean,
    peerRejection: peerRejectionSchema,
    bridgeVersion: string,
    bridgeGeneration: positiveInteger,
    controlProtocolVersion: positiveInteger,
    extensionProtocolVersion: positiveInteger,
    instanceId: string,
    websocket: string,
    resultDirectory: string,
}, ['ok', 'extensionConnected', 'bridgeRole']);

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
            },
            ['code', 'message', 'stage', 'retryable']
        )
    )
);

const ozonPromotionSuccessSchema = object(
    {
        ok: { const: true },
        status: { const: 'complete' },
        jobType: { const: 'ozon_seller_promotion_report' },
        dateFrom: canonicalDateProperty,
        dateTo: canonicalDateProperty,
        artifact: ozonPromotionArtifactSchema,
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
        error: ozonPromotionErrorSchema,
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

const feedbackArtifactId = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
const feedbackSha256 = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const feedbackClaim = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' };
const feedbackSession = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const hookOnlyFeedbackField = (description) => ({
    ...description,
    description:
        `${description.description} Injected by the trusted Claude or Codex host hook immediately before this local tool call; ` +
        'model-authored arguments must omit it and every snake_case alias.',
});
const feedbackPrepareSchema = object(
    {
        kind: { type: 'string', enum: FEEDBACK_KINDS },
        summary: { type: 'string', minLength: 1, maxLength: 512 },
        details: { type: 'string', minLength: 1, maxLength: 4096 },
        includeTranscript: boolean,
        transcriptPath: hookOnlyFeedbackField({ type: 'string', minLength: 1, maxLength: 4096, description: 'Trusted local transcript path.' }),
        feedbackClaim: hookOnlyFeedbackField({ ...feedbackClaim, description: 'One-use local feedback handoff claim.' }),
        feedbackSession: hookOnlyFeedbackField({ ...feedbackSession, description: 'Bound host-session digest for the feedback claim.' }),
    },
    ['kind', 'summary', 'details', 'includeTranscript']
);
const feedbackSubmitSchema = object(
    {
        artifactId: feedbackArtifactId,
        uploadUrl: hookOnlyFeedbackField({ type: 'string', minLength: 1, maxLength: 8192, description: 'Signed HTTPS upload URL.' }),
        requiredHeaders: hookOnlyFeedbackField({ type: 'object', properties: {}, additionalProperties: { type: 'string', maxLength: 8192 }, description: 'Signed required request headers.' }),
        objectKey: hookOnlyFeedbackField({ type: 'string', minLength: 1, maxLength: 1024, description: 'Storage object key.' }),
        expiresAt: hookOnlyFeedbackField({ type: 'integer', minimum: 1, description: 'Upload grant expiry timestamp.' }),
        expectedSize: hookOnlyFeedbackField({ type: 'integer', minimum: 1, maximum: 1024 * 1024, description: 'Expected archive size in bytes.' }),
        expectedSha256: hookOnlyFeedbackField({ ...feedbackSha256, description: 'Expected archive SHA-256.' }),
        feedbackClaim: hookOnlyFeedbackField({ ...feedbackClaim, description: 'One-use local feedback handoff claim.' }),
        feedbackSession: hookOnlyFeedbackField({ ...feedbackSession, description: 'Bound host-session digest for the feedback claim.' }),
    },
    ['artifactId']
);
const feedbackErrorSchema = objectUnion(
    object({ code: { const: 'FEEDBACK_PREPARATION_FAILED' }, message: { type: 'string', minLength: 1, maxLength: 500 }, stage: { const: 'prepare' }, retryable: { const: false } }, ['code', 'message', 'stage', 'retryable']),
    object({ code: { const: 'FEEDBACK_HOOK_HANDOFF_UNAVAILABLE' }, message: { type: 'string', minLength: 1, maxLength: 500 }, stage: { const: 'handoff' }, retryable: { const: false } }, ['code', 'message', 'stage', 'retryable']),
    object({ code: { const: 'TRANSCRIPT_TOO_LARGE' }, message: { type: 'string', minLength: 1, maxLength: 500 }, stage: { const: 'transcript' }, retryable: { const: false } }, ['code', 'message', 'stage', 'retryable']),
    object({ code: { const: 'TRANSCRIPT_UNAVAILABLE' }, message: { type: 'string', minLength: 1, maxLength: 500 }, stage: { const: 'transcript' }, retryable: { const: true } }, ['code', 'message', 'stage', 'retryable']),
    object({ code: { const: 'ARTIFACT_UNAVAILABLE' }, message: { type: 'string', minLength: 1, maxLength: 500 }, stage: { const: 'artifact' }, retryable: { const: false } }, ['code', 'message', 'stage', 'retryable']),
    object({ code: { const: 'UPLOAD_GRANT_INVALID' }, message: { type: 'string', minLength: 1, maxLength: 500 }, stage: { const: 'grant' }, retryable: { const: false } }, ['code', 'message', 'stage', 'retryable']),
    object({ code: { const: 'UPLOAD_REJECTED' }, message: { type: 'string', minLength: 1, maxLength: 500 }, stage: { const: 'upload' }, retryable: { const: false } }, ['code', 'message', 'stage', 'retryable']),
    object({ code: { const: 'UPLOAD_UNCERTAIN' }, message: { type: 'string', minLength: 1, maxLength: 500 }, stage: { const: 'upload' }, retryable: { const: false } }, ['code', 'message', 'stage', 'retryable'])
);
const feedbackPrepareSuccessSchema = object(
    { ok: { const: true }, status: { const: 'prepared' }, artifactId: feedbackArtifactId, kind: { type: 'string', enum: FEEDBACK_KINDS }, sizeBytes: positiveInteger, sha256: feedbackSha256, transcriptIncluded: boolean, summary: { type: 'string', minLength: 1, maxLength: 512 } },
    ['ok', 'status', 'artifactId', 'kind', 'sizeBytes', 'sha256', 'transcriptIncluded', 'summary']
);
const feedbackPrepareFailureSchema = object(
    { ok: { const: false }, status: { const: 'failed' }, error: feedbackErrorSchema },
    ['ok', 'status', 'error']
);
const feedbackSubmitSuccessSchema = object(
    { ok: { const: true }, status: { const: 'uploaded' }, artifactId: feedbackArtifactId, transcriptIncluded: boolean },
    ['ok', 'status', 'artifactId', 'transcriptIncluded']
);
const feedbackSubmitFailureSchema = object(
    { ok: { const: false }, status: { type: 'string', enum: ['failed', 'rejected', 'uncertain'] }, artifactId: feedbackArtifactId, error: feedbackErrorSchema },
    ['ok', 'status', 'artifactId', 'error']
);

export const toolInputSchemas = {
    local_bridge_status: object({}),
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
    wb_product_card: objectUnion(...liveAggregateSchemas(productCardSuccessSchema), toolErrorSchema),
    wb_search_by_query: objectUnion(...liveAggregateSchemas(searchSuccessSchema), toolErrorSchema),
    wb_check_by_query: objectUnion(...liveAggregateSchemas(checkSuccessSchema), toolErrorSchema),
    wb_recommendations_by_product: objectUnion(...liveAggregateSchemas(recommendationsSuccessSchema), toolErrorSchema),
    wb_seller_reviews: objectUnion(sellerReviewsSuccessSchema, toolErrorSchema),
    prepare_e_comet_feedback: objectUnion(feedbackPrepareSuccessSchema, feedbackPrepareFailureSchema),
    submit_e_comet_feedback: objectUnion(feedbackSubmitSuccessSchema, feedbackSubmitFailureSchema),
    wb_product_images: objectUnion(...liveAggregateSchemas(imagesSuccessSchema), toolErrorSchema),
    ozon_seller_promotion_report: objectUnion(ozonPromotionSuccessSchema, ozonPromotionFailureSchema, ozonPromotionPreflightFailureSchema),
};

export const validateSchemaValue = (value, schema) => {
    if (schema.oneOf) {
        return schema.oneOf.filter((candidate) => validateSchemaValue(value, candidate)).length === 1;
    }
    if (Object.hasOwn(schema, 'const')) return Object.is(value, schema.const);
    if (!schema.type) return true;
    if (schema.type === 'object') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const properties = schema.properties || {};
        if ((schema.required || []).some((name) => !Object.hasOwn(value, name))) return false;
        return Object.entries(value).every(([name, propertyValue]) => {
            if (!Object.hasOwn(properties, name)) {
                if (schema.additionalProperties === false) return false;
                if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
                    return validateSchemaValue(propertyValue, schema.additionalProperties);
                }
                return true;
            }
            const propertySchema = properties[name];
            return validateSchemaValue(propertyValue, propertySchema);
        });
    }
    if (schema.type === 'array') {
        if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return false;
        if (schema.uniqueItems && new Set(value).size !== value.length) return false;
        return value.every((item) => validateSchemaValue(item, schema.items));
    }
    if (schema.type === 'string') {
        return (
            typeof value === 'string' &&
            value.length >= (schema.minLength ?? 0) &&
            value.length <= (schema.maxLength ?? Infinity) &&
            (!schema.enum || schema.enum.includes(value)) &&
            (!schema.pattern || new RegExp(schema.pattern).test(value))
        );
    }
    if (schema.type === 'integer') {
        return (
            Number.isSafeInteger(value) &&
            value >= (schema.minimum ?? -Infinity) &&
            value <= (schema.maximum ?? Infinity)
        );
    }
    if (schema.type === 'number') {
        return (
            typeof value === 'number' &&
            Number.isFinite(value) &&
            value >= (schema.minimum ?? -Infinity) &&
            value <= (schema.maximum ?? Infinity) &&
            value > (schema.exclusiveMinimum ?? -Infinity) &&
            value < (schema.exclusiveMaximum ?? Infinity)
        );
    }
    if (schema.type === 'boolean') return typeof value === 'boolean';
    if (schema.type === 'null') return value === null;
    return false;
};
