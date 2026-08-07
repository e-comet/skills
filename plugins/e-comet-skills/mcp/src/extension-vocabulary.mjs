// Словарь WebSocket-протокола с расширением. Те же имена объявлены enum'ами в
// расширении (src/local-agent-protocol.ts) и закреплены в
// contracts/local-agent-contract.json, поэтому расхождение ловится контрактными
// тестами в обоих репозиториях, а не молчаливым игнорированием сообщения.

export const MESSAGE_TYPES = Object.freeze({
    // local MCP -> расширение
    hello: 'hello',
    wbFetch: 'wb_fetch',
    browserJobAuthorize: 'browser_job_authorize',
    // расширение -> local MCP
    helloAck: 'hello_ack',
    wbFetchResult: 'wb_fetch_result',
    browserJobAuthorizeResult: 'browser_job_authorize_result',
    error: 'error',
    // в обе стороны (heartbeat)
    ping: 'ping',
    pong: 'pong',
});

export const localMessage = (id, type, payload) => ({ id, type, payload });

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
});

export const CLIENT_TO_EXTENSION_MESSAGE_TYPES = Object.freeze([
    MESSAGE_TYPES.browserJobAuthorize,
    MESSAGE_TYPES.hello,
    MESSAGE_TYPES.ping,
    // Ответ на heartbeat расширения. Отсутствие pong в этом списке означало, что
    // расширение отвергало наш ответ как UNKNOWN_MESSAGE_TYPE раз в 20 секунд.
    MESSAGE_TYPES.pong,
    MESSAGE_TYPES.wbFetch,
]);

export const EXTENSION_TO_CLIENT_MESSAGE_TYPES = Object.freeze([
    MESSAGE_TYPES.browserJobAuthorizeResult,
    MESSAGE_TYPES.error,
    MESSAGE_TYPES.helloAck,
    MESSAGE_TYPES.ping,
    MESSAGE_TYPES.pong,
    MESSAGE_TYPES.wbFetchResult,
]);

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

// Из них повторить задание с новой авторизацией имеет смысл только для этих двух:
// исчерпанный URL-бюджет новой попыткой не лечится.
export const RETRYABLE_FETCH_ERROR_CODES = Object.freeze([
    FETCH_ERROR_CODES.browserJobNotAuthorized,
    FETCH_ERROR_CODES.browserJobExpired,
]);

export const UNCLASSIFIED_FETCH_ERROR_CODE = 'WB_FETCH_FAILED';
