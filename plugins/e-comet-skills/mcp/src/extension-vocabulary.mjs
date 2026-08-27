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
    ozonPromotionStreamAck: 'ozon_seller_promotion_report_stream_ack',
    // расширение -> local MCP
    helloAck: 'hello_ack',
    wbFetchResult: 'wb_fetch_result',
    wbFetchStreamStart: 'wb_fetch_stream_start',
    wbFetchStreamChunk: 'wb_fetch_stream_chunk',
    wbFetchStreamEnd: 'wb_fetch_stream_end',
    browserJobAuthorizeResult: 'browser_job_authorize_result',
    browserJobAuthorizationReleaseResult: 'browser_job_authorization_release_result',
    ozonPromotionStreamStart: 'ozon_seller_promotion_report_stream_start',
    ozonPromotionStreamChunk: 'ozon_seller_promotion_report_stream_chunk',
    ozonPromotionStreamEnd: 'ozon_seller_promotion_report_stream_end',
    ozonPromotionResult: 'ozon_seller_promotion_report_result',
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
