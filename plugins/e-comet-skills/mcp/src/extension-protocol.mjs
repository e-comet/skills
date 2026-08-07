import { EXTENSION_PROTOCOL_VERSION } from './config.mjs';
import {
    AUTHORIZATION_FETCH_ERROR_CODES,
    localMessage,
    MESSAGE_TYPES,
    RETRYABLE_FETCH_ERROR_CODES,
    UNCLASSIFIED_FETCH_ERROR_CODE,
} from './extension-vocabulary.mjs';
import { ToolExecutionError, safeExternalToolError } from './tool-errors.mjs';
import { encodeFrame } from './websocket.mjs';

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

        const isMessage =
            typeof message?.id === 'string' &&
            message.id.length > 0 &&
            typeof message.type === 'string' &&
            message.payload &&
            typeof message.payload === 'object' &&
            !Array.isArray(message.payload);
        if (!isMessage) return;

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
                Array.isArray(payload.capabilities) && payload.capabilities.includes('browser_job')
            );
            previousSocket?.end(encodeFrame('', 0x8));
            handoff.markRoutable(connections.effectiveExtensionReady);
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

        if (type !== MESSAGE_TYPES.wbFetchResult) return;
        if (typeof payload.response?.error === 'string') {
            const code = typeof payload.response.code === 'string' ? payload.response.code : UNCLASSIFIED_FETCH_ERROR_CODE;
            const authorizationFailure = AUTHORIZATION_FETCH_ERROR_CODES.includes(code);
            const retryable = RETRYABLE_FETCH_ERROR_CODES.includes(code);
            requestBroker.rejectFetch(
                message.id,
                safeExternalToolError(
                    {
                        code,
                        message: payload.response.error,
                        stage: authorizationFailure ? 'authorization' : 'execution',
                        retryable,
                    },
                    'Wildberries request failed.'
                )
            );
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
