import { REQUEST_TIMEOUT_GRACE_MS } from '../../../bridge/limits.mjs';
import { ToolExecutionError } from '../../../shared/coded-error.mjs';
import { validTimeout } from '../../../shared/timeouts.mjs';
import { fieldOf, isNonNegativeSafeInteger } from '../../../shared/values.mjs';
import { ARTIFACT_MAX_FILE_BYTES } from '../../../storage/limits.mjs';
import { SELLER_OPERATION_STAGES } from '../../../transport/extension/wire.mjs';
import { MAX_SELLER_REVIEW_PHYSICAL_REPORTS } from '../../domain/constants/limits.const.mjs';
import { isValidSellerOperation, isValidSellerStreamEnd } from './validators.mjs';
// The correlation type of a seller operation; its frames are routed and delivered by the request broker under it.
export const SELLER_OPERATION = 'seller_operation';
/**
 * The Seller state machine over the correlation broker (refactor spec §7.4): one typed seller operation per request,
 * checked against the lease's active scope, its authorization and the attested job type before it is sent; a download
 * streams its workbook through the caller's handlers, in order, and ends with the stream's end.
 */
export const createSellerOperations = ({ correlation, maxPending = MAX_SELLER_REVIEW_PHYSICAL_REPORTS, }) => {
    const reportUnsettled = (kind, requestId, detail) => correlation.reportUnsettled(kind, requestId, detail);
    const settleSellerOperation = (requestId, pending, settle, value) => {
        if (correlation.stateOf(requestId) !== pending)
            return false;
        correlation.close(requestId);
        pending.cancelled = true;
        settle(value);
        return true;
    };
    const cancelSellerOperation = (requestId, pending, error) => {
        if (correlation.stateOf(requestId) !== pending)
            return false;
        correlation.close(requestId);
        pending.cancelled = true;
        // Correlation owns settlement, not disk I/O. The executor cancels its private writer
        // as soon as this rejection arrives; queued/late handlers remain fenced below.
        pending.reject(error);
        return true;
    };
    const enqueueSellerHandler = (requestId, pending, handler, args, onComplete) => {
        const handlerPromise = pending.handlerChain.then(async () => {
            if (pending.cancelled || correlation.stateOf(requestId) !== pending)
                return false;
            await handler(...args);
            return !pending.cancelled && correlation.stateOf(requestId) === pending;
        });
        pending.handlerChain = handlerPromise;
        return handlerPromise.then((handled) => {
            if (handled)
                onComplete?.();
            return handled;
        }, (error) => {
            settleSellerOperation(requestId, pending, (reason) => pending.reject(reason), error);
            return false;
        });
    };
    const rejectInvalidSellerStream = (requestId, pending, reason = 'Seller stream frames arrived out of order.') => {
        cancelSellerOperation(requestId, pending, new ToolExecutionError('SELLER_STREAM_INVALID', reason, 'extension', false));
        return false;
    };
    // Parse boundary: the frame payloads were checked by the session's validators.
    const startSellerStream = async (requestId, pending, metadata) => {
        if (pending.state === 'ending')
            return reportUnsettled('seller-stream-start', requestId);
        if (pending.state !== 'awaiting-result')
            return rejectInvalidSellerStream(requestId, pending);
        // `declaredSize` is optional on the wire, so an omitted value falls back to the per-file ceiling
        // instead of being reported as an out-of-order frame.
        const declaredSize = fieldOf(metadata, 'declaredSize');
        const mimeType = fieldOf(metadata, 'mimeType');
        if (declaredSize !== undefined && (!isNonNegativeSafeInteger(declaredSize) || declaredSize > ARTIFACT_MAX_FILE_BYTES)) {
            return rejectInvalidSellerStream(requestId, pending, 'Seller stream declared an unusable artifact size.');
        }
        pending.state = 'streaming';
        pending.declaredStreamBytes = declaredSize ?? null;
        pending.maxStreamBytes = declaredSize ?? ARTIFACT_MAX_FILE_BYTES;
        const streamMetadata = declaredSize === undefined ? { mimeType } : { mimeType, declaredSize };
        return enqueueSellerHandler(requestId, pending, pending.streamHandlers.onStart, [streamMetadata]);
    };
    const appendSellerStreamChunk = async (requestId, pending, index, data) => {
        if (pending.state === 'ending')
            return reportUnsettled('seller-stream-chunk', requestId, index);
        if (pending.state !== 'streaming' || index !== pending.nextChunkIndex || typeof data !== 'string') {
            return rejectInvalidSellerStream(requestId, pending);
        }
        const decodedBytes = Buffer.byteLength(data, 'base64');
        if (pending.receivedStreamBytes + decodedBytes > pending.maxStreamBytes) {
            return rejectInvalidSellerStream(requestId, pending);
        }
        pending.nextChunkIndex += 1;
        pending.receivedStreamBytes += decodedBytes;
        return enqueueSellerHandler(requestId, pending, pending.streamHandlers.onChunk, [index, data]);
    };
    const endSellerStream = async (requestId, pending, metadata) => {
        if (pending.state === 'ending')
            return reportUnsettled('seller-stream-end', requestId);
        if (pending.state !== 'streaming')
            return rejectInvalidSellerStream(requestId, pending);
        if (!isValidSellerStreamEnd(metadata) ||
            metadata.size !== pending.receivedStreamBytes ||
            (pending.declaredStreamBytes !== null && metadata.size !== pending.declaredStreamBytes)) {
            return rejectInvalidSellerStream(requestId, pending);
        }
        pending.state = 'ending';
        return enqueueSellerHandler(requestId, pending, pending.streamHandlers.onEnd, [metadata], () => settleSellerOperation(requestId, pending, (value) => pending.resolve(value), metadata));
    };
    // Every frame of one seller operation, by its id.
    const sellerFrame = (requestId, pending, { type, payload }) => {
        if (type === 'result') {
            if (pending.state !== 'awaiting-result')
                return reportUnsettled('seller-result', requestId);
            settleSellerOperation(requestId, pending, (value) => pending.resolve(value), payload);
            return true;
        }
        if (type === 'error') {
            cancelSellerOperation(requestId, pending, payload);
            return true;
        }
        if (type === 'stream_start')
            return startSellerStream(requestId, pending, payload);
        if (type === 'stream_chunk')
            return appendSellerStreamChunk(requestId, pending, fieldOf(payload, 'index'), fieldOf(payload, 'data'));
        return endSellerStream(requestId, pending, payload);
    };
    // One typed seller operation under `lease`: the lease's scope must be active, its authorization the scope's and its
    // attested job type seller_reviews (spec §7.4 lease binding); a download needs its three stream handlers.
    const run = (operation, streamHandlers, timeout, lease) => {
        const authorizationId = lease?.id;
        // Scopes are kept by string ids, so any other value names no scope.
        const authorizationScopeId = typeof lease?.scopeId === 'string' ? lease.scopeId : undefined;
        const authorizationScope = authorizationScopeId === undefined ? undefined : correlation.scopes.get(authorizationScopeId);
        if (authorizationScopeId === undefined ||
            !authorizationScope ||
            !correlation.scopeIsActive(authorizationScopeId, authorizationScope)) {
            return Promise.reject(correlation.scopeEnded(authorizationScopeId));
        }
        if (authorizationScope.authorizationId !== authorizationId ||
            lease?.jobType !== 'seller_reviews' ||
            !isValidSellerOperation(operation)) {
            return Promise.reject(new ToolExecutionError('SELLER_OPERATION_NOT_ALLOWED', 'Only a valid typed seller operation may be requested through its signed authorization scope.', 'arguments', false));
        }
        const requiresStreamHandlers = operation.stage === SELLER_OPERATION_STAGES.download;
        if (requiresStreamHandlers && !streamHandlers) {
            return Promise.reject(new TypeError('Seller stream handlers must provide onStart, onChunk, and onEnd functions.'));
        }
        const normalizedStreamHandlers = requiresStreamHandlers && streamHandlers
            ? streamHandlers
            : { onStart: () => undefined, onChunk: () => undefined, onEnd: () => undefined };
        if (timeout === undefined || !validTimeout(timeout)) {
            return Promise.reject(new ToolExecutionError('SELLER_OPERATION_TIMEOUT_INVALID', 'Seller operation timeout is outside the allowed bounds.', 'arguments', false));
        }
        if (correlation.count(SELLER_OPERATION) >= maxPending) {
            return Promise.reject(new ToolExecutionError('SELLER_OPERATION_CAPACITY_EXCEEDED', 'Too many seller operations are pending.', 'local', true));
        }
        // The operation's own record, which its frames find; the request's settlement joins it once the request opens.
        const pending = {
            resolve: () => undefined,
            reject: () => undefined,
            state: 'awaiting-result',
            nextChunkIndex: 0,
            receivedStreamBytes: 0,
            declaredStreamBytes: null,
            maxStreamBytes: ARTIFACT_MAX_FILE_BYTES,
            streamHandlers: normalizedStreamHandlers,
            handlerChain: Promise.resolve(),
            authorizationScopeId,
        };
        return correlation.open({
            type: SELLER_OPERATION,
            payload: { sellerOperation: operation, timeout, authorizationId, authorizationScopeId },
            timeoutMs: timeout + REQUEST_TIMEOUT_GRACE_MS,
            unrefTimer: false,
            timeoutError: () => new ToolExecutionError('SELLER_OPERATION_TIMEOUT', `The seller operation timed out after ${timeout} ms.`, 'extension', true),
            authorization: { id: authorizationScope.authorizationId, scopeId: authorizationScopeId },
            createState: (control) => Object.assign(pending, { resolve: control.resolve, reject: control.reject }),
            onFrame: (frame, control) => sellerFrame(control.id, pending, frame),
            onScopeEnded: (error, _scope, control) => cancelSellerOperation(control.id, pending, error),
            onAbort: (errorOrMessage, control) => cancelSellerOperation(control.id, pending, errorOrMessage instanceof Error
                ? errorOrMessage
                : new Error(errorOrMessage === undefined ? undefined : String(errorOrMessage))),
            onSendError: (error, control) => settleSellerOperation(control.id, pending, (reason) => control.reject(reason), error),
        }).result;
    };
    return { run };
};
