import { ARTIFACT_MAX_FILE_BYTES, EXTENSION_PROTOCOL_VERSION, MAX_BROWSER_JOB_TEXT_LENGTH } from './config.mjs';
import { MAX_OZON_REPORT_PACKAGE_ITEMS } from './ozon-report-package-domain.mjs';
import {
    AUTHORIZATION_FETCH_ERROR_CODES,
    EXTENSION_TO_CLIENT_MESSAGE_TYPES,
    isSellerOperationStage,
    localMessage,
    MESSAGE_TYPES,
    OZON_ANALYTICS_CAPABILITY,
    OZON_ANALYTICS_SERVER_MESSAGE_TYPES,
    OZON_ANALYTICS_TERMINAL_CODE_STAGES,
    isOzonAnalyticsTerminalDetails,
    isOzonExecutionInterruptionDetails,
    OZON_PROMOTION_CAPABILITY,
    OZON_PROMOTION_PACKAGE_CAPABILITY,
    OZON_PROMOTION_SERVER_MESSAGE_TYPES,
    RETRYABLE_FETCH_ERROR_CODES,
    SELLER_OPERATION_STAGES,
    UNCLASSIFIED_FETCH_ERROR_CODE,
} from './extension-vocabulary.mjs';
import { parseAnalyticsDateRange } from './ozon-analytics-domain.mjs';
import { parseOzonPromotionPeriod } from './ozon-promotion-domain.mjs';
import { ToolExecutionError, safeExternalToolError, safeOzonPromotionToolError } from './tool-errors.mjs';
import { encodeFrame } from './websocket.mjs';

const MAX_ID_LENGTH = 128;
const MAX_STREAM_CHUNK_BYTES = 256 * 1024;
const MAX_BASE64_STREAM_CHUNK_LENGTH = 4 * Math.ceil(MAX_STREAM_CHUNK_BYTES / 3);
const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_SAFE_MESSAGE_LENGTH = 500;

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isNonNegativeSafeInteger = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const hasOnlyKeys = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
const isBoundedString = (value, maxLength) => typeof value === 'string' && value.length > 0 && value.length <= maxLength;
const isValidBase64Chunk = (value) => {
    if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > MAX_BASE64_STREAM_CHUNK_LENGTH ||
        !BASE64_PATTERN.test(value)
    ) {
        return false;
    }
    const decoded = Buffer.from(value, 'base64');
    return decoded.toString('base64') === value && decoded.byteLength <= MAX_STREAM_CHUNK_BYTES;
};
export const isValidOzonReportPhase = (value) =>
    isRecord(value) && hasOnlyKeys(value, ['family', 'frameId', 'itemIndex', 'phase']) &&
    ['promotion', 'analytics'].includes(value.family) && isBoundedString(value.frameId, 128) &&
    isNonNegativeSafeInteger(value.itemIndex) && value.itemIndex < MAX_OZON_REPORT_PACKAGE_ITEMS &&
    ['pre_create', 'create_dispatched', 'create_settled', 'polling', 'downloading', 'streaming'].includes(value.phase);

export const isValidSellerOperation = (value) => {
    if (!isRecord(value) || !hasOnlyKeys(value, ['exportIndex', 'isAnswered', 'stage', 'reportId'])) return false;
    if (
        !isNonNegativeSafeInteger(value.exportIndex) ||
        typeof value.isAnswered !== 'boolean' ||
        !isSellerOperationStage(value.stage)
    ) {
        return false;
    }
    return value.stage === SELLER_OPERATION_STAGES.create
        ? value.reportId === undefined
        : typeof value.reportId === 'string' && value.reportId.length > 0 && value.reportId.length <= MAX_BROWSER_JOB_TEXT_LENGTH;
};
export const isValidSellerStreamStart = (value) =>
    isRecord(value) &&
    hasOnlyKeys(value, ['mimeType', 'declaredSize']) &&
    value.mimeType === XLSX_MIME_TYPE &&
    (value.declaredSize === undefined ||
        (isNonNegativeSafeInteger(value.declaredSize) && value.declaredSize <= ARTIFACT_MAX_FILE_BYTES));
export const isValidSellerStreamChunk = (value) =>
    isRecord(value) && hasOnlyKeys(value, ['index', 'data']) && isNonNegativeSafeInteger(value.index) && isValidBase64Chunk(value.data);
export const isValidSellerStreamEnd = (value) =>
    isRecord(value) &&
    hasOnlyKeys(value, ['size', 'sha256']) &&
    isNonNegativeSafeInteger(value.size) &&
    typeof value.sha256 === 'string' &&
    SHA256_PATTERN.test(value.sha256);
export const isValidOzonPromotionOperation = (value) => {
    if (
        !isRecord(value) ||
        !hasOnlyKeys(value, ['dateFrom', 'dateTo', 'deadlineAt']) ||
        !Number.isSafeInteger(value.deadlineAt) ||
        value.deadlineAt <= 0
    ) {
        return false;
    }
    try {
        parseOzonPromotionPeriod(value.dateFrom, value.dateTo);
        return true;
    } catch {
        return false;
    }
};
export const isValidOzonReportPackageRequest = (value) => {
    if (
        !isRecord(value) ||
        !hasOnlyKeys(value, ['family', 'items', 'deadlineAt']) ||
        !Number.isSafeInteger(value.deadlineAt) ||
        value.deadlineAt <= 0 ||
        !Array.isArray(value.items) ||
        value.items.length < 1 ||
        value.items.length > MAX_OZON_REPORT_PACKAGE_ITEMS ||
        (value.family !== 'promotion' && value.family !== 'analytics')
    ) {
        return false;
    }
    return value.items.every((item) => {
        if (!isRecord(item)) return false;
        if (value.family === 'promotion') {
            if (!hasOnlyKeys(item, ['dateFrom', 'dateTo']) || Object.keys(item).length !== 2) return false;
            try {
                parseOzonPromotionPeriod(item.dateFrom, item.dateTo);
                return true;
            } catch {
                return false;
            }
        }
        if (!hasOnlyKeys(item, ['dateFrom', 'dateTo', 'breakdown']) || Object.keys(item).length !== 3) return false;
        if (item.breakdown !== 'period' && item.breakdown !== 'daily') return false;
        try {
            parseAnalyticsDateRange(item.dateFrom, item.dateTo);
            return true;
        } catch {
            return false;
        }
    });
};
const isValidOzonStreamStart = (value, indexed = false) =>
    isRecord(value) &&
    hasOnlyKeys(value, ['frameId', 'itemIndex', 'name', 'mimeType', 'declaredSize']) &&
    (!indexed || isNonNegativeSafeInteger(value.itemIndex)) &&
    (indexed || value.itemIndex === undefined) &&
    isBoundedString(value.frameId, MAX_ID_LENGTH) &&
    isBoundedString(value.name, MAX_BROWSER_JOB_TEXT_LENGTH) &&
    value.mimeType === XLSX_MIME_TYPE &&
    (value.declaredSize === undefined ||
        (isNonNegativeSafeInteger(value.declaredSize) && value.declaredSize <= ARTIFACT_MAX_FILE_BYTES));
const isValidOzonStreamChunk = (value, indexed = false) =>
    isRecord(value) &&
    hasOnlyKeys(value, ['frameId', 'itemIndex', 'index', 'data']) &&
    (!indexed || isNonNegativeSafeInteger(value.itemIndex)) &&
    (indexed || value.itemIndex === undefined) &&
    isBoundedString(value.frameId, MAX_ID_LENGTH) &&
    isNonNegativeSafeInteger(value.index) &&
    isValidBase64Chunk(value.data);
const isValidOzonStreamEnd = (value, indexed = false) =>
    isRecord(value) &&
    hasOnlyKeys(value, ['frameId', 'itemIndex', 'size', 'sha256']) &&
    (!indexed || isNonNegativeSafeInteger(value.itemIndex)) &&
    (indexed || value.itemIndex === undefined) &&
    isBoundedString(value.frameId, MAX_ID_LENGTH) &&
    isNonNegativeSafeInteger(value.size) &&
    value.size <= ARTIFACT_MAX_FILE_BYTES &&
    typeof value.sha256 === 'string' &&
    SHA256_PATTERN.test(value.sha256);
const isValidOzonResult = (value, allowSkipped = false) => {
    // Promotion may carry date context; analytics below deliberately requires its own exact error keys.
    if (!isRecord(value) || !hasOnlyKeys(value, ['ok', 'status', 'error'])) return false;
    if (value.ok === true) return Object.keys(value).length === 1;
    const skipped = allowSkipped && value.status === 'skipped' && Object.keys(value).length === 3;
    if (value.ok !== false || (!skipped && Object.keys(value).length !== 2) || !isRecord(value.error)) return false;
    const error = value.error;
    if (
        !hasOnlyKeys(error, ['code', 'stage', 'retryable', 'message', 'dateFrom', 'dateTo', 'details']) ||
        (Object.hasOwn(error, 'details') && (!allowSkipped || !isOzonExecutionInterruptionDetails(error.code, error.details))) ||
        typeof error.message !== 'string' ||
        error.message.length === 0 ||
        error.message.length > MAX_SAFE_MESSAGE_LENGTH
    ) {
        return false;
    }
    try {
        safeOzonPromotionToolError(error);
        if ((error.dateFrom === undefined) !== (error.dateTo === undefined)) return false;
        if (error.dateFrom !== undefined) parseOzonPromotionPeriod(error.dateFrom, error.dateTo);
        return true;
    } catch {
        return false;
    }
};
const isValidIndexedOzonResult = (value, family) => {
    if (!isRecord(value) || !isNonNegativeSafeInteger(value.itemIndex)) return false;
    const { itemIndex: _itemIndex, ...result } = value;
    if (family === 'promotion') return isValidOzonResult(result, true);
    if (!isRecord(result) || !hasOnlyKeys(result, ['ok', 'status', 'error'])) return false;
    if (result.ok === true) return Object.keys(result).length === 1;
    const skipped = result.status === 'skipped' && Object.keys(result).length === 3;
    if (result.ok !== false || (!skipped && Object.keys(result).length !== 2) || !isRecord(result.error)) return false;
    const error = result.error;
    return (
        hasOnlyKeys(error, ['code', 'stage', 'retryable', 'message', 'details']) &&
        (!Object.hasOwn(error, 'details') || (!skipped && isOzonAnalyticsTerminalDetails(error.code, error.details)) ||
            isOzonExecutionInterruptionDetails(error.code, error.details)) &&
        OZON_ANALYTICS_TERMINAL_CODE_STAGES[error.code] === error.stage &&
        error.retryable === false &&
        typeof error.message === 'string' &&
        error.message.length > 0 &&
        error.message.length <= MAX_SAFE_MESSAGE_LENGTH
    );
};
export const parseExtensionServerMessage = (value) => {
    if (
        !isRecord(value) ||
        typeof value.id !== 'string' ||
        value.id.length === 0 ||
        value.id.length > MAX_ID_LENGTH ||
        typeof value.type !== 'string' ||
        (!EXTENSION_TO_CLIENT_MESSAGE_TYPES.includes(value.type) &&
            !OZON_PROMOTION_SERVER_MESSAGE_TYPES.includes(value.type) &&
            !OZON_ANALYTICS_SERVER_MESSAGE_TYPES.includes(value.type) && value.type !== MESSAGE_TYPES.ozonReportPhase) ||
        !isRecord(value.payload)
    ) {
        return { ok: false };
    }

    const { payload, type } = value;
    if (type === MESSAGE_TYPES.ozonReportPhase && !isValidOzonReportPhase(payload)) return { ok: false };
    if (type === MESSAGE_TYPES.wbFetchStreamStart) {
        if (!isValidSellerStreamStart(payload)) return { ok: false };
    }
    if (type === MESSAGE_TYPES.wbFetchStreamChunk) {
        if (!isValidSellerStreamChunk(payload)) return { ok: false };
    }
    if (type === MESSAGE_TYPES.wbFetchStreamEnd) {
        if (!isValidSellerStreamEnd(payload)) return { ok: false };
    }
    if (type === MESSAGE_TYPES.browserJobAuthorizationReleaseResult) {
        const validSuccess = payload.released === true && Object.keys(payload).length === 1;
        const validError =
            isRecord(payload.error) &&
            hasOnlyKeys(payload, ['error']) &&
            Object.keys(payload).length === 1 &&
            hasOnlyKeys(payload.error, ['code', 'message']) &&
            Object.keys(payload.error).length === 2 &&
            typeof payload.error.code === 'string' &&
            typeof payload.error.message === 'string';
        if (!validSuccess && !validError) return { ok: false };
    }
    if (
        type === MESSAGE_TYPES.ozonPromotionStreamStart &&
        !isValidOzonStreamStart(payload, Object.hasOwn(payload, 'itemIndex'))
    )
        return { ok: false };
    if (
        type === MESSAGE_TYPES.ozonPromotionStreamChunk &&
        !isValidOzonStreamChunk(payload, Object.hasOwn(payload, 'itemIndex'))
    )
        return { ok: false };
    if (type === MESSAGE_TYPES.ozonPromotionStreamEnd && !isValidOzonStreamEnd(payload, Object.hasOwn(payload, 'itemIndex')))
        return { ok: false };
    if (
        type === MESSAGE_TYPES.ozonPromotionResult &&
        !(Object.hasOwn(payload, 'itemIndex') ? isValidIndexedOzonResult(payload, 'promotion') : isValidOzonResult(payload))
    )
        return { ok: false };
    if (type === MESSAGE_TYPES.ozonAnalyticsStreamStart && !isValidOzonStreamStart(payload, true)) return { ok: false };
    if (type === MESSAGE_TYPES.ozonAnalyticsStreamChunk && !isValidOzonStreamChunk(payload, true)) return { ok: false };
    if (type === MESSAGE_TYPES.ozonAnalyticsStreamEnd && !isValidOzonStreamEnd(payload, true)) return { ok: false };
    if (type === MESSAGE_TYPES.ozonAnalyticsResult && !isValidIndexedOzonResult(payload, 'analytics')) return { ok: false };

    return { ok: true, message: value };
};

export const createExtensionProtocol = ({
    connections,
    requestBroker,
    handoff,
    sessionNonce,
    send,
    log,
    broadcastStatus,
}) => {
    const handleMessage = async (state, rawMessage) => {
        const socket = state.socket;
        let message;
        try {
            message = JSON.parse(rawMessage);
        } catch {
            return;
        }

        const parsed = parseExtensionServerMessage(message);
        if (!parsed.ok) return;
        message = parsed.message;

        const { payload, type } = message;
        if (type === MESSAGE_TYPES.helloAck) {
            if (state.extensionHandshakeComplete) {
                log('rejected duplicate extension hello_ack');
                socket.end(encodeFrame('', 0x8));
                return;
            }
            if (message.id !== state.helloId || payload.sessionNonce !== sessionNonce) {
                log('rejected extension hello_ack with an invalid session nonce');
                socket.end(encodeFrame('', 0x8));
                return;
            }
            if (payload.protocolVersion !== EXTENSION_PROTOCOL_VERSION) {
                log(`rejected extension protocol ${payload.protocolVersion}; expected ${EXTENSION_PROTOCOL_VERSION}`);
                socket.end(encodeFrame('', 0x8));
                return;
            }

            state.extensionHandshakeComplete = true;
            if (connections.extensionSocket && connections.extensionSocket !== socket) {
                requestBroker.invalidateAuthorizationWork();
            }
            const previousSocket = connections.connectExtension(
                socket,
                {
                    browserJobSupported: Array.isArray(payload.capabilities) && payload.capabilities.includes('browser_job'),
                    ozonSellerPromotionReportSupported:
                        Array.isArray(payload.capabilities) && payload.capabilities.includes(OZON_PROMOTION_CAPABILITY),
                    ozonSellerPromotionReportsSupported:
                        Array.isArray(payload.capabilities) && payload.capabilities.includes(OZON_PROMOTION_PACKAGE_CAPABILITY),
                    ozonSellerAnalyticsReportSupported:
                        Array.isArray(payload.capabilities) && payload.capabilities.includes(OZON_ANALYTICS_CAPABILITY),
                    version: payload.extensionVersion,
                }
            );
            previousSocket?.end(encodeFrame('', 0x8));
            handoff.markTopologySettled();
            log(`extension connected, version ${payload.extensionVersion || 'unknown'}`);
            broadcastStatus();
            return;
        }

        if (!state.extensionHandshakeComplete) {
            log('rejected extension operational message before hello_ack');
            socket.end(encodeFrame('', 0x8));
            return;
        }

        if (type === MESSAGE_TYPES.ping) {
            const context = payload.browserContext;
            if (
                context &&
                Object.keys(context).length === 2 &&
                typeof context.wbTabConnected === 'boolean' &&
                typeof context.sellerTabConnected === 'boolean' &&
                connections.updateBrowserContext(socket, context)
            ) {
                broadcastStatus();
            }
            send(socket, localMessage(message.id, MESSAGE_TYPES.pong, { at: Date.now() }));
            return;
        }

        // Конверт уровня протокола (невалидный payload, слишком большое сообщение,
        // неизвестный тип). Его id совпадает с id исходного сообщения, поэтому он
        // закрывает ровно тот запрос, который расширение отвергло. Без этой ветки
        // вызов висел до полного таймаута без всякой диагностики.
        if (type === MESSAGE_TYPES.error) {
            const code = typeof payload.code === 'string' ? payload.code : 'EXTENSION_PROTOCOL_ERROR';
            const detail = typeof payload.message === 'string' ? payload.message : 'The extension rejected the message.';
            // stage: 'execution' — отвергнутое на протоколе сообщение проваливает свою
            // единицу, а не авторизацию. Со стадией 'authorization' задание обрывалось
            // целиком, и агент шёл жечь новый JWT на задании, которое упадёт так же.
            const rejection = safeExternalToolError(
                { code, message: detail, stage: 'execution', retryable: false },
                'The extension rejected a local-agent message.'
            );
            // Коллекцию выбираем по принадлежности: `a() || b()` всегда дёргал первую и
            // печатал ложный «поздний ответ» на каждый протокольный отказ авторизации.
            const settled = requestBroker.hasPendingAuthorization(message.id)
                ? requestBroker.rejectAuthorization(message.id, rejection)
                : requestBroker.hasPendingAuthorizationRelease(message.id)
                  ? requestBroker.rejectAuthorizationRelease(message.id, rejection)
                  : requestBroker.hasPendingOzonPromotionOperation(message.id)
                    ? requestBroker.rejectOzonPromotionReport(message.id, rejection)
                  : requestBroker.hasPendingOzonReportPackage(message.id)
                    ? requestBroker.rejectOzonReportPackage(message.id, rejection)
                  : requestBroker.hasPendingSellerOperation(message.id)
                    ? requestBroker.rejectSellerOperation(message.id, rejection)
                    : requestBroker.rejectFetch(message.id, rejection);
            log(`extension rejected message ${message.id}: ${code}${settled ? '' : ' (no pending request)'}`);
            return;
        }

        if (type === MESSAGE_TYPES.browserJobAuthorizeResult) {
            if (payload.error) {
                requestBroker.rejectAuthorization(message.id, safeExternalToolError(payload.error));
            } else {
                requestBroker.resolveAuthorization(message.id, payload.authorization);
            }
            return;
        }

        if (type === MESSAGE_TYPES.browserJobAuthorizationReleaseResult) {
            if (payload.error) {
                requestBroker.rejectAuthorizationRelease(
                    message.id,
                    safeExternalToolError(
                        { ...payload.error, stage: 'extension', retryable: false },
                        'The extension could not confirm browser job authorization release.'
                    )
                );
            } else {
                requestBroker.resolveAuthorizationRelease(message.id);
            }
            return;
        }

        if (type === MESSAGE_TYPES.wbFetchStreamStart) {
            await requestBroker.startSellerStream(message.id, payload);
            return;
        }

        if (type === MESSAGE_TYPES.wbFetchStreamChunk) {
            await requestBroker.appendSellerStreamChunk(message.id, payload.index, payload.data);
            return;
        }

        if (type === MESSAGE_TYPES.wbFetchStreamEnd) {
            await requestBroker.endSellerStream(message.id, payload);
            return;
        }

        if (type === MESSAGE_TYPES.ozonReportPhase) {
            const handled = await requestBroker.recordOzonReportPackagePhase(message.id, payload.family, payload);
            if (handled) send(socket, localMessage(message.id,
                payload.family === 'promotion' ? MESSAGE_TYPES.ozonPromotionStreamAck : MESSAGE_TYPES.ozonAnalyticsStreamAck,
                { frameId: payload.frameId }));
            return;
        }
        if (type === MESSAGE_TYPES.ozonPromotionStreamStart) {
            const handled = Object.hasOwn(payload, 'itemIndex')
                ? await requestBroker.startOzonReportPackageStream(message.id, 'promotion', payload)
                : await requestBroker.startOzonPromotionStream(message.id, payload);
            if (handled) {
                send(socket, localMessage(message.id, MESSAGE_TYPES.ozonPromotionStreamAck, { frameId: payload.frameId }));
            }
            return;
        }

        if (type === MESSAGE_TYPES.ozonPromotionStreamChunk) {
            const handled = Object.hasOwn(payload, 'itemIndex')
                ? await requestBroker.appendOzonReportPackageStreamChunk(message.id, 'promotion', payload)
                : await requestBroker.appendOzonPromotionStreamChunk(message.id, payload);
            if (handled) {
                send(socket, localMessage(message.id, MESSAGE_TYPES.ozonPromotionStreamAck, { frameId: payload.frameId }));
            }
            return;
        }

        if (type === MESSAGE_TYPES.ozonPromotionStreamEnd) {
            const handled = Object.hasOwn(payload, 'itemIndex')
                ? await requestBroker.endOzonReportPackageStream(message.id, 'promotion', payload)
                : await requestBroker.endOzonPromotionStream(message.id, payload);
            if (handled) {
                send(socket, localMessage(message.id, MESSAGE_TYPES.ozonPromotionStreamAck, { frameId: payload.frameId }));
            }
            return;
        }

        if (type === MESSAGE_TYPES.ozonPromotionResult) {
            if (Object.hasOwn(payload, 'itemIndex')) {
                const { itemIndex, ...result } = payload;
                await requestBroker.resolveOzonReportPackageItem(message.id, 'promotion', itemIndex, result);
            } else if (requestBroker.hasPendingOzonReportPackage(message.id)) {
                requestBroker.rejectOzonReportPackage(message.id, new ToolExecutionError(
                    'ARTIFACT_REJECTED',
                    'The Ozon report package received a result without its item index.',
                    'artifact',
                    false
                ));
            } else if (payload.ok) requestBroker.resolveOzonPromotionReport(message.id, payload);
            else requestBroker.rejectOzonPromotionReport(message.id, safeOzonPromotionToolError(payload.error));
            return;
        }

        if (
            type === MESSAGE_TYPES.ozonAnalyticsStreamStart ||
            type === MESSAGE_TYPES.ozonAnalyticsStreamChunk ||
            type === MESSAGE_TYPES.ozonAnalyticsStreamEnd
        ) {
            const handled =
                type === MESSAGE_TYPES.ozonAnalyticsStreamStart
                    ? await requestBroker.startOzonReportPackageStream(message.id, 'analytics', payload)
                    : type === MESSAGE_TYPES.ozonAnalyticsStreamChunk
                      ? await requestBroker.appendOzonReportPackageStreamChunk(message.id, 'analytics', payload)
                      : await requestBroker.endOzonReportPackageStream(message.id, 'analytics', payload);
            if (handled) {
                send(socket, localMessage(message.id, MESSAGE_TYPES.ozonAnalyticsStreamAck, { frameId: payload.frameId }));
            }
            return;
        }

        if (type === MESSAGE_TYPES.ozonAnalyticsResult) {
            const { itemIndex, ...result } = payload;
            await requestBroker.resolveOzonReportPackageItem(message.id, 'analytics', itemIndex, result);
            return;
        }

        if (type !== MESSAGE_TYPES.wbFetchResult) return;
        if (typeof payload.response?.error === 'string') {
            const code = typeof payload.response.code === 'string' ? payload.response.code : UNCLASSIFIED_FETCH_ERROR_CODE;
            const authorizationFailure = AUTHORIZATION_FETCH_ERROR_CODES.includes(code);
            const retryable = RETRYABLE_FETCH_ERROR_CODES.includes(code);
            const rejection = safeExternalToolError(
                {
                    code,
                    message: payload.response.error,
                    stage: authorizationFailure ? 'authorization' : 'execution',
                    retryable,
                },
                'Wildberries request failed.'
            );
            if (requestBroker.hasPendingSellerOperation(message.id)) requestBroker.rejectSellerOperation(message.id, rejection);
            else requestBroker.rejectFetch(message.id, rejection);
        } else if (requestBroker.hasPendingSellerOperation(message.id)) {
            requestBroker.resolveSellerOperation(message.id, payload.response);
        } else {
            requestBroker.resolveFetch(message.id, payload.response, { includeRequestId: true });
        }
    };

    const onDisconnect = (state) => {
        if (!connections.disconnectExtension(state.socket)) return false;
        requestBroker.rejectPendingRequests(
            new ToolExecutionError(
                    'EXTENSION_DISCONNECTED',
                    'The extension disconnected before returning the WB response. Open an authenticated Wildberries tab and retry.',
                    'extension',
                    true
                )
        );
        requestBroker.rejectPendingAuthorizations(
            new ToolExecutionError(
                    'EXTENSION_DISCONNECTED',
                    'The extension disconnected before authorizing the browser job. Open an authenticated Wildberries tab and retry.',
                    'extension',
                    true
                )
        );
        log('extension disconnected');
        broadcastStatus();
        return true;
    };

    return { handleMessage, onDisconnect };
};
