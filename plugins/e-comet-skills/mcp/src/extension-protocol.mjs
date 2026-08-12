import { ARTIFACT_MAX_FILE_BYTES, EXTENSION_PROTOCOL_VERSION, MAX_BROWSER_JOB_TEXT_LENGTH } from './config.mjs';
import {
    AUTHORIZATION_FETCH_ERROR_CODES,
    EXTENSION_TO_CLIENT_MESSAGE_TYPES,
    isSellerOperationStage,
    localMessage,
    MESSAGE_TYPES,
    RETRYABLE_FETCH_ERROR_CODES,
    SELLER_OPERATION_STAGES,
    UNCLASSIFIED_FETCH_ERROR_CODE,
} from './extension-vocabulary.mjs';
import { ToolExecutionError, safeExternalToolError } from './tool-errors.mjs';
import { encodeFrame } from './websocket.mjs';

const MAX_ID_LENGTH = 128;
const MAX_STREAM_CHUNK_BYTES = 256 * 1024;
const MAX_BASE64_STREAM_CHUNK_LENGTH = 4 * Math.ceil(MAX_STREAM_CHUNK_BYTES / 3);
const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isNonNegativeSafeInteger = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const hasOnlyKeys = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
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
export const parseExtensionServerMessage = (value) => {
    if (
        !isRecord(value) ||
        typeof value.id !== 'string' ||
        value.id.length === 0 ||
        value.id.length > MAX_ID_LENGTH ||
        typeof value.type !== 'string' ||
        !EXTENSION_TO_CLIENT_MESSAGE_TYPES.includes(value.type) ||
        !isRecord(value.payload)
    ) {
        return { ok: false };
    }

    const { payload, type } = value;
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
