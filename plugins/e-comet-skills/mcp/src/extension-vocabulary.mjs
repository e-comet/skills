// Словарь WebSocket-протокола с расширением. Те же имена объявлены enum'ами в
// расширении (src/local-agent-protocol.ts) и закреплены в
// contracts/local-agent-contract.json, поэтому расхождение ловится контрактными
// тестами в обоих репозиториях, а не молчаливым игнорированием сообщения.

export const MESSAGE_TYPES = Object.freeze({
    // local MCP -> расширение
    hello: 'hello',
    wbFetch: 'wb_fetch',
    browserJobAuthorize: 'browser_job_authorize',
    browserJobAuthorizationRelease: 'browser_job_authorization_release',
    ozonPromotionOperation: 'ozon_seller_promotion_report_operation',
    ozonPromotionPackageOperation: 'ozon_seller_promotion_reports_operation',
    ozonPromotionStreamAck: 'ozon_seller_promotion_report_stream_ack',
    ozonAnalyticsOperation: 'ozon_seller_analytics_report_operation',
    ozonAnalyticsStreamAck: 'ozon_seller_analytics_report_stream_ack',
    // расширение -> local MCP
    helloAck: 'hello_ack',
    wbFetchResult: 'wb_fetch_result',
    wbFetchStreamStart: 'wb_fetch_stream_start',
    wbFetchStreamChunk: 'wb_fetch_stream_chunk',
    wbFetchStreamEnd: 'wb_fetch_stream_end',
    browserJobAuthorizeResult: 'browser_job_authorize_result',
    browserJobAuthorizationReleaseResult: 'browser_job_authorization_release_result',
    ozonReportPhase: 'ozon_seller_report_phase',
    ozonPromotionStreamStart: 'ozon_seller_promotion_report_stream_start',
    ozonPromotionStreamChunk: 'ozon_seller_promotion_report_stream_chunk',
    ozonPromotionStreamEnd: 'ozon_seller_promotion_report_stream_end',
    ozonPromotionResult: 'ozon_seller_promotion_report_result',
    ozonAnalyticsStreamStart: 'ozon_seller_analytics_report_stream_start',
    ozonAnalyticsStreamChunk: 'ozon_seller_analytics_report_stream_chunk',
    ozonAnalyticsStreamEnd: 'ozon_seller_analytics_report_stream_end',
    ozonAnalyticsResult: 'ozon_seller_analytics_report_result',
    error: 'error',
    // в обе стороны (heartbeat)
    ping: 'ping',
    pong: 'pong',
});

export const localMessage = (id, type, payload) => ({ id, type, payload });

export const PEER_CAPABILITIES = Object.freeze({ browserContextPropagation: 'browser_context_propagation' });

export const peerStatusMessage = ({
    connections,
    handoff,
    bridgeGeneration,
    bridgeVersion,
    controlProtocolVersion,
    extensionProtocolVersion,
}) => ({
    type: 'peer_status',
    extensionConnected: connections.extensionReady,
    browserJobSupported: connections.extensionBrowserJobReady,
    bridgeTransitioning: handoff.transitioning,
    controlProtocolVersion,
    extensionProtocolVersion,
    bridgeGeneration,
    bridgeVersion,
    instanceId: handoff.instanceId,
    capabilities: [PEER_CAPABILITIES.browserContextPropagation],
    browserContext: connections.browserContext,
    ...(connections.extensionOzonPromotionReady === undefined
        ? {}
        : { ozonSellerPromotionReportSupported: connections.extensionOzonPromotionReady === true }),
    ...(connections.extensionOzonPromotionPackageReady === undefined
        ? {}
        : { ozonSellerPromotionReportsSupported: connections.extensionOzonPromotionPackageReady === true }),
    ...(connections.extensionOzonAnalyticsReady === undefined
        ? {}
        : { ozonSellerAnalyticsReportSupported: connections.extensionOzonAnalyticsReady === true }),
    ...(connections.extensionLastConnectedAtMs === null ? {} : { extensionLastConnectedAtMs: connections.extensionLastConnectedAtMs }),
    ...(connections.extensionLastDisconnectedAtMs === null ? {} : { extensionLastDisconnectedAtMs: connections.extensionLastDisconnectedAtMs }),
    // Вторичный процесс сам расширение не видит, поэтому без этого поля конкуренция
    // диагностируется только на первичном — а агент чаще как раз secondary. Передаются
    // метки, а не сводка: получатель считает скользящее окно сам, иначе снимок замер бы у
    // него навсегда — новые `peer_status` при неизменившемся статусе не рассылаются.
    extensionTakeoverAtMs: connections.extensionTakeoverAtMs,
    ...(connections.extensionVersion === undefined ? {} : { extensionVersion: connections.extensionVersion }),
});

export const CLIENT_TO_EXTENSION_MESSAGE_TYPES = Object.freeze([
    MESSAGE_TYPES.browserJobAuthorize,
    MESSAGE_TYPES.browserJobAuthorizationRelease,
    MESSAGE_TYPES.hello,
    MESSAGE_TYPES.ping,
    // Ответ на heartbeat расширения. Отсутствие pong в этом списке означало, что
    // расширение отвергало наш ответ как UNKNOWN_MESSAGE_TYPE раз в 20 секунд.
    MESSAGE_TYPES.pong,
    MESSAGE_TYPES.wbFetch,
]);

export const EXTENSION_TO_CLIENT_MESSAGE_TYPES = Object.freeze([
    MESSAGE_TYPES.browserJobAuthorizeResult,
    MESSAGE_TYPES.browserJobAuthorizationReleaseResult,
    MESSAGE_TYPES.error,
    MESSAGE_TYPES.helloAck,
    MESSAGE_TYPES.ping,
    MESSAGE_TYPES.pong,
    MESSAGE_TYPES.wbFetchResult,
    MESSAGE_TYPES.wbFetchStreamStart,
    MESSAGE_TYPES.wbFetchStreamChunk,
    MESSAGE_TYPES.wbFetchStreamEnd,
]);

export const OZON_PROMOTION_CAPABILITY = 'ozon_seller_promotion_report@1';
export const OZON_PROMOTION_PACKAGE_CAPABILITY = 'ozon_seller_promotion_reports@1';
export const OZON_ANALYTICS_CAPABILITY = 'ozon_seller_analytics_report@1';
// Supported floor for the released singular @1 contract, not the first build that advertised it.
// Package tools require 1.5.7 separately; raising their floor must not change singular guidance
// or its public error-details schema. Runtime admission checks the advertised capability.
export const OZON_PROMOTION_MIN_EXTENSION_VERSION = '1.5.6';
// Единственный поддерживаемый канал обновления расширения.
export const EXTENSION_UPDATE_URL = 'https://chromewebstore.google.com/detail/e-comet/apeallgchpgibifmbgefkhifidihmodh';
export const OZON_PROMOTION_CLIENT_MESSAGE_TYPES = Object.freeze([
    MESSAGE_TYPES.ozonPromotionOperation,
    MESSAGE_TYPES.ozonPromotionStreamAck,
]);
export const OZON_PROMOTION_SERVER_MESSAGE_TYPES = Object.freeze([
    MESSAGE_TYPES.ozonPromotionStreamStart,
    MESSAGE_TYPES.ozonPromotionStreamChunk,
    MESSAGE_TYPES.ozonPromotionStreamEnd,
    MESSAGE_TYPES.ozonPromotionResult,
]);
export const OZON_ANALYTICS_CLIENT_MESSAGE_TYPES = Object.freeze([
    MESSAGE_TYPES.ozonAnalyticsOperation,
    MESSAGE_TYPES.ozonAnalyticsStreamAck,
]);
export const OZON_ANALYTICS_SERVER_MESSAGE_TYPES = Object.freeze([
    MESSAGE_TYPES.ozonAnalyticsStreamStart,
    MESSAGE_TYPES.ozonAnalyticsStreamChunk,
    MESSAGE_TYPES.ozonAnalyticsStreamEnd,
    MESSAGE_TYPES.ozonAnalyticsResult,
]);
export const OZON_ANALYTICS_TERMINAL_CODE_STAGES = Object.freeze({
    OZON_AUTHORIZATION_REJECTED: 'authorization',
    OZON_ADMISSION_CAPACITY_EXHAUSTED: 'extension',
    OZON_ROUTE_NOT_READY: 'route',
    OZON_ANALYTICS_CAPABILITY_UNAVAILABLE: 'context',
    OZON_CONTEXT_CHANGED: 'context',
    PREFLIGHT_FAILED: 'preflight',
    CREATE_REJECTED: 'create',
    CREATE_SERVICE_UNAVAILABLE: 'create',
    CREATE_OUTCOME_UNKNOWN: 'create',
    POLL_FAILED: 'poll',
    POLL_EXHAUSTED: 'poll',
    REPORT_TERMINAL_FAILURE: 'poll',
    DOWNLOAD_REJECTED: 'download',
    OZON_RATE_LIMITED: 'rate_limit',
    ARTIFACT_REJECTED: 'artifact',
    OZON_EXECUTION_INTERRUPTED: 'execution',
    OPERATION_CANCELLED: 'cancelled',
    OPERATION_DEADLINE_EXCEEDED: 'deadline',
});
export const EXTENSION_CAPABILITIES = Object.freeze(['wb_fetch', 'browser_job', 'seller_reviews']);

// Стадия операции продавца внутри payload'а `wb_fetch`. Расширение решает по ней,
// какой admission применить, поэтому набор объявлен enum'ом SellerOperationStage в
// src/local-agent-protocol.ts и закреплён в контракте наравне с именами сообщений.
export const SELLER_OPERATION_STAGES = Object.freeze({
    create: 'create',
    poll: 'poll',
    download: 'download',
});

export const isSellerOperationStage = (value) => Object.values(SELLER_OPERATION_STAGES).includes(value);

// Коды внутри `wb_fetch_result.response.code`.
export const FETCH_ERROR_CODES = Object.freeze({
    browserJobExpired: 'BROWSER_JOB_EXPIRED',
    browserJobNotAuthorized: 'BROWSER_JOB_NOT_AUTHORIZED',
    browserJobRequired: 'BROWSER_JOB_REQUIRED',
    browserJobUrlNotAllowed: 'BROWSER_JOB_URL_NOT_ALLOWED',
    duplicateRequestId: 'DUPLICATE_REQUEST_ID',
    sessionClosed: 'SESSION_CLOSED',
    tooManyPendingRequests: 'TOO_MANY_PENDING_REQUESTS',
    wbFetchTimeout: 'WB_FETCH_TIMEOUT',
    wbNotAuthenticated: 'WB_NOT_AUTHENTICATED',
});

// Подмножество, требующее свежей авторизации: попадает в stage `authorization`.
export const AUTHORIZATION_FETCH_ERROR_CODES = Object.freeze([
    FETCH_ERROR_CODES.browserJobNotAuthorized,
    FETCH_ERROR_CODES.browserJobExpired,
    FETCH_ERROR_CODES.browserJobUrlNotAllowed,
]);

// Коды, при которых повтор имеет смысл. Из авторизационных это только два: исчерпанный URL-бюджет
// новой попыткой не лечится. Рейт-лимит кабинета сюда же, хотя авторизации не касается: это ровно то
// состояние, которое лечится ожиданием, и пакет он останавливает, а не запрещает повторить позже.
// Флаг ниоткуда не запускает автоповтор — он сообщает вызывающему, стоит ли пробовать снова.
export const RETRYABLE_FETCH_ERROR_CODES = Object.freeze([
    FETCH_ERROR_CODES.browserJobNotAuthorized,
    FETCH_ERROR_CODES.browserJobExpired,
    'SELLER_CABINET_RATE_LIMITED',
]);

export const UNCLASSIFIED_FETCH_ERROR_CODE = 'WB_FETCH_FAILED';

// Numeric Ozon evidence is deliberately narrower than free-form diagnostic details.
export const isOzonAnalyticsTerminalDetails = (code, value) => code === 'REPORT_TERMINAL_FAILURE' &&
    value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 1 && Object.hasOwn(value, 'marketplaceErrorCode') &&
    Number.isSafeInteger(value.marketplaceErrorCode) && value.marketplaceErrorCode >= -2147483648 &&
    value.marketplaceErrorCode <= 2147483647;

export const isOzonExecutionInterruptionDetails = (code, value) => code === 'OZON_EXECUTION_INTERRUPTED' &&
    value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 2 && Object.hasOwn(value, 'phase') && Object.hasOwn(value, 'createOutcome') &&
    ((['pre_create', 'create_dispatched'].includes(value.phase) && value.createOutcome === 'not_started') ||
        (value.phase === 'create_settled' && value.createOutcome === 'confirmed') ||
        (['polling', 'downloading', 'streaming'].includes(value.phase) && ['not_started', 'confirmed'].includes(value.createOutcome)));
