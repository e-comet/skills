import { createSessionMessages, parseServerMessage } from '../bridge/broker/messages.mjs';
import { safeExternalToolError } from '../bridge/broker/sanitize.mjs';
import { safeOzonPromotionToolError } from '../ozon-seller/domain/converters/errors.converter.mjs';
import { OZON_OPERATION_TYPES, isValidOzonOperationPayload } from '../ozon-seller/out/extension/validators.mjs';
import { ToolExecutionError } from '../shared/coded-error.mjs';
import { isOneOf, isRecord } from '../shared/values.mjs';
import { AUTHORIZATION_FETCH_ERROR_CODES, localMessage, MESSAGE_TYPES, RETRYABLE_FETCH_ERROR_CODES, SELLER_FAILURE_CLASSES, SELLER_FAILURE_REASONS, UNCLASSIFIED_FETCH_ERROR_CODE, WB_FETCH_TIMEOUT_PHASES, wbaasRecoveryOutcome, } from '../transport/extension/wire.mjs';
import { fetchFailureGuidance } from '../transport/failures/vocabulary.mjs';
import { isValidSellerStreamChunk, isValidSellerStreamEnd, isValidSellerStreamStart } from '../wb-seller/out/extension/validators.mjs';
// Parse boundary: a payload as the extension sent it, checked by the family validators.
const isValidOperationPayload = (type, payload) => {
    if (!isValidOzonOperationPayload(type, payload))
        return false;
    if (type === MESSAGE_TYPES.wbFetchStreamStart) {
        if (!isValidSellerStreamStart(payload))
            return false;
    }
    if (type === MESSAGE_TYPES.wbFetchStreamChunk) {
        if (!isValidSellerStreamChunk(payload))
            return false;
    }
    if (type === MESSAGE_TYPES.wbFetchStreamEnd) {
        if (!isValidSellerStreamEnd(payload))
            return false;
    }
    return true;
};
export const parseExtensionServerMessage = (value) => parseServerMessage(value, { operationTypes: OZON_OPERATION_TYPES, isValidOperationPayload });
// The closed evidence a `wb_fetch_result` failure may carry beside its code (contract `wbFetchResultFields`).
// Parse boundary: the fetch response as the extension sent it, read field by field.
const sellerFailureReasons = SELLER_FAILURE_REASONS;
export const fetchFailureDetails = (code, response) => {
    const details = {};
    if (code === 'WB_FETCH_TIMEOUT' && isOneOf(WB_FETCH_TIMEOUT_PHASES, response.phase))
        details.phase = response.phase;
    if (isOneOf(sellerFailureReasons[code] ?? [], response.reason))
        details.reason = response.reason;
    if (isOneOf(SELLER_FAILURE_CLASSES, response.class) && typeof response.wbRefused === 'boolean') {
        Object.assign(details, { class: response.class, wbRefused: response.wbRefused });
        if (typeof response.httpStatus === 'number' &&
            Number.isSafeInteger(response.httpStatus) &&
            response.httpStatus >= 100 &&
            response.httpStatus <= 599) {
            details.httpStatus = response.httpStatus;
        }
    }
    const recovery = wbaasRecoveryOutcome(response.wbaasRecovery);
    if (recovery)
        details.recovery = recovery;
    return Object.keys(details).length ? details : undefined;
};
/**
 * Runs today's extension session over a broker session (bridge/broker/messages.mjs) with the family frames: the WB fetch
 * results and seller streams, and the Ozon operations with their acknowledgements.
 */
export const createExtensionProtocol = ({ connections, requestBroker, log, broadcastStatus = () => undefined, }) => {
    // A family operation's id when no session request owns it. Ownership decides the collection: `a() || b()` would
    // always touch the first and log a false late response for the others.
    const rejectOperation = (id, rejection) => requestBroker.hasPendingOzonPromotionOperation(id)
        ? requestBroker.rejectOzonPromotionReport(id, rejection)
        : requestBroker.hasPendingOzonReportPackage(id)
            ? requestBroker.rejectOzonReportPackage(id, rejection)
            : requestBroker.hasPendingSellerOperation(id)
                ? requestBroker.rejectSellerOperation(id, rejection)
                : requestBroker.rejectFetch(id, rejection);
    // Parse boundary: a frame the parser accepted (a string id, a type and a payload object), read by its type.
    const handleOperation = async (session, message) => {
        if (!isRecord(message) || typeof message.id !== 'string' || !isRecord(message.payload))
            return;
        const id = message.id, payload = message.payload, type = message.type;
        if (type === MESSAGE_TYPES.wbFetchStreamStart) {
            await requestBroker.startSellerStream(id, payload);
            return;
        }
        if (type === MESSAGE_TYPES.wbFetchStreamChunk) {
            await requestBroker.appendSellerStreamChunk(id, payload.index, payload.data);
            return;
        }
        if (type === MESSAGE_TYPES.wbFetchStreamEnd) {
            await requestBroker.endSellerStream(id, payload);
            return;
        }
        if (type === MESSAGE_TYPES.ozonReportPhase) {
            const handled = await requestBroker.recordOzonReportPackagePhase(id, payload.family, payload);
            if (handled)
                session.send(localMessage(id, payload.family === 'promotion' ? MESSAGE_TYPES.ozonPromotionStreamAck : MESSAGE_TYPES.ozonAnalyticsStreamAck, { frameId: payload.frameId }));
            return;
        }
        if (type === MESSAGE_TYPES.ozonPromotionStreamStart) {
            const handled = Object.hasOwn(payload, 'itemIndex')
                ? await requestBroker.startOzonReportPackageStream(id, 'promotion', payload)
                : await requestBroker.startOzonPromotionStream(id, payload);
            if (handled) {
                session.send(localMessage(id, MESSAGE_TYPES.ozonPromotionStreamAck, { frameId: payload.frameId }));
            }
            return;
        }
        if (type === MESSAGE_TYPES.ozonPromotionStreamChunk) {
            const handled = Object.hasOwn(payload, 'itemIndex')
                ? await requestBroker.appendOzonReportPackageStreamChunk(id, 'promotion', payload)
                : await requestBroker.appendOzonPromotionStreamChunk(id, payload);
            if (handled) {
                session.send(localMessage(id, MESSAGE_TYPES.ozonPromotionStreamAck, { frameId: payload.frameId }));
            }
            return;
        }
        if (type === MESSAGE_TYPES.ozonPromotionStreamEnd) {
            const handled = Object.hasOwn(payload, 'itemIndex')
                ? await requestBroker.endOzonReportPackageStream(id, 'promotion', payload)
                : await requestBroker.endOzonPromotionStream(id, payload);
            if (handled) {
                session.send(localMessage(id, MESSAGE_TYPES.ozonPromotionStreamAck, { frameId: payload.frameId }));
            }
            return;
        }
        if (type === MESSAGE_TYPES.ozonPromotionResult) {
            if (Object.hasOwn(payload, 'itemIndex')) {
                const { itemIndex, ...result } = payload;
                await requestBroker.resolveOzonReportPackageItem(id, 'promotion', itemIndex, result);
            }
            else if (requestBroker.hasPendingOzonReportPackage(id)) {
                requestBroker.rejectOzonReportPackage(id, new ToolExecutionError('ARTIFACT_REJECTED', 'The Ozon report package received a result without its item index.', 'artifact', false));
            }
            else if (payload.ok)
                requestBroker.resolveOzonPromotionReport(id, payload);
            else
                requestBroker.rejectOzonPromotionReport(id, safeOzonPromotionToolError(payload.error));
            return;
        }
        if (type === MESSAGE_TYPES.ozonAnalyticsStreamStart ||
            type === MESSAGE_TYPES.ozonAnalyticsStreamChunk ||
            type === MESSAGE_TYPES.ozonAnalyticsStreamEnd) {
            const handled = type === MESSAGE_TYPES.ozonAnalyticsStreamStart
                ? await requestBroker.startOzonReportPackageStream(id, 'analytics', payload)
                : type === MESSAGE_TYPES.ozonAnalyticsStreamChunk
                    ? await requestBroker.appendOzonReportPackageStreamChunk(id, 'analytics', payload)
                    : await requestBroker.endOzonReportPackageStream(id, 'analytics', payload);
            if (handled) {
                session.send(localMessage(id, MESSAGE_TYPES.ozonAnalyticsStreamAck, { frameId: payload.frameId }));
            }
            return;
        }
        if (type === MESSAGE_TYPES.ozonAnalyticsResult || type === MESSAGE_TYPES.ozonSearchPositionsResult) {
            const { itemIndex, ...result } = payload;
            const family = type === MESSAGE_TYPES.ozonAnalyticsResult ? 'analytics' : 'positions';
            await requestBroker.resolveOzonReportPackageItem(id, family, itemIndex, result);
            return;
        }
        if (type !== MESSAGE_TYPES.wbFetchResult)
            return;
        const response = payload.response;
        if (isRecord(response) && typeof response.error === 'string') {
            const code = typeof response.code === 'string' ? response.code : UNCLASSIFIED_FETCH_ERROR_CODE;
            const authorizationFailure = isOneOf(AUTHORIZATION_FETCH_ERROR_CODES, code);
            const retryable = isOneOf(RETRYABLE_FETCH_ERROR_CODES, code);
            const details = fetchFailureDetails(code, response);
            const rejection = safeExternalToolError({
                code,
                message: fetchFailureGuidance(code, details) ?? response.error,
                stage: authorizationFailure ? 'authorization' : 'execution',
                retryable,
            }, 'Wildberries request failed.');
            if (details)
                rejection.details = details;
            if (requestBroker.hasPendingSellerOperation(id))
                requestBroker.rejectSellerOperation(id, rejection);
            else
                requestBroker.rejectFetch(id, rejection);
        }
        else if (requestBroker.hasPendingSellerOperation(id)) {
            requestBroker.resolveSellerOperation(id, response);
        }
        else {
            requestBroker.resolveFetch(id, response, { includeRequestId: true });
        }
    };
    return createSessionMessages({
        connections,
        requestBroker,
        log,
        broadcastStatus,
        parseMessage: parseExtensionServerMessage,
        rejectOperation,
        handleOperation,
    });
};
