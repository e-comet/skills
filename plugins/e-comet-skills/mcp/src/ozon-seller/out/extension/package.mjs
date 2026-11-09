import { MAX_OZON_REPORT_PACKAGE_ITEMS, OZON_PROMOTION_OPERATION_MAX_MS } from '../../domain/constants/limits.const.mjs';
import { normalizeOzonPromotionError, ozonPromotionError } from '../../domain/converters/errors.converter.mjs';
import { isOzonPackageNotStarted } from '../../domain/converters/package-result.converter.mjs';
import { isSearchPositionsSkuList } from '../../domain/policies/search-positions.policy.mjs';
import { isValidOzonSearchPositionsResult } from './validators.mjs';
import { hasExactOwnKeys, isRecord } from '../../../shared/values.mjs';
import { ARTIFACT_MAX_FILE_BYTES } from '../../../storage/limits.mjs';
// Parse boundary: frame payloads were checked by the frame validators; signed jobs and items are read field by field.
const signedField = (key) => (job) => (isRecord(job) ? job[key] : undefined);
// The correlation type of an Ozon report package; its frames are delivered by the request broker under it.
export const OZON_PACKAGE = 'ozon_package';
// Signed job type and items per package family. A result-only family has no create, phases or streams:
// each item ends with one terminal result, which must also match the signed request.
const OZON_PACKAGE_FAMILIES = {
    promotion: { jobType: 'ozon_seller_promotion_reports', signedItems: signedField('periods') },
    analytics: { jobType: 'ozon_seller_analytics_report', signedItems: signedField('reports') },
    positions: {
        jobType: 'ozon_search_positions',
        signedItems: signedField('queries'),
        resultOnly: true,
        // Cells follow the signed SKUs in order; the wire parser could only check them against each other. The signed job
        // was checked before the package was requested.
        resultValidator: (job) => {
            const skus = signedField('skus')(job);
            return (itemIndex, result) => isValidOzonSearchPositionsResult({ ...(isRecord(result) ? result : {}), itemIndex }, isSearchPositionsSkuList(skus) ? skus : []);
        },
    },
};
const exactOzonPackageItemsEqual = (family, requested, signed) => {
    if (!Array.isArray(requested) || !Array.isArray(signed) || requested.length !== signed.length)
        return false;
    const signedItems = signed;
    if (family === 'positions')
        return requested.every((query, index) => typeof query === 'string' && query === signedItems[index]);
    const fields = family === 'promotion' ? ['dateFrom', 'dateTo'] : ['dateFrom', 'dateTo', 'breakdown'];
    return requested.every((item, index) => {
        const signedItem = signedItems[index];
        if (!isRecord(item) || !isRecord(signedItem))
            return false;
        if (!hasExactOwnKeys(item, fields) || !hasExactOwnKeys(signedItem, fields))
            return false;
        // The signature binds ordered field values, not the incidental JSON object insertion order chosen by each host.
        return fields.every((field) => item[field] === signedItem[field]);
    });
};
/**
 * The Ozon package state machine over the correlation broker (refactor spec §7.4): one package per signed authorization,
 * checked against the lease's active scope, its authorization, the attested job type and the exact signed items before
 * it is sent through `route`; items run in order, each with its phases, its workbook stream and its result, and a
 * result-only family (search positions) with its result alone. `reservation` is the one Ozon reservation it shares with
 * the promotion state machine.
 */
export const createOzonPackage = ({ correlation, route, reservation, }) => {
    const consumed = new WeakSet();
    const reportUnsettled = (kind, requestId, detail) => correlation.reportUnsettled(kind, requestId, detail);
    // A frame that waited for the previous item's result goes back to its request as the session delivered it.
    const redeliver = (kind, id, detail, frame) => correlation.has(id, OZON_PACKAGE) ? correlation.dispatch({ id, ...frame }) : correlation.reportUnsettled(kind, id, detail);
    // Every frame of the one Ozon package, by its id.
    const ozonPackageFrame = (requestId, pending, frame) => {
        const payload = frame.payload;
        const { family, itemIndex, value } = isRecord(payload) ? payload : {};
        const fields = isRecord(value) ? value : {};
        if (frame.type === 'phase')
            return recordOzonReportPackagePhase(requestId, pending, family, fields);
        if (frame.type === 'stream_start')
            return startOzonReportPackageStream(requestId, pending, family, fields);
        if (frame.type === 'stream_chunk')
            return appendOzonReportPackageStreamChunk(requestId, pending, family, fields);
        if (frame.type === 'stream_end')
            return endOzonReportPackageStream(requestId, pending, family, fields);
        if (frame.type === 'item_result')
            return resolveOzonReportPackageItem(requestId, pending, family, itemIndex, value);
        return rejectOzonReportPackage(requestId, pending, payload);
    };
    // A frame for a later item than the one whose result is being handed over waits for that transition.
    const isLaterItem = (pending, family, itemIndex) => pending.resultTransition !== undefined &&
        pending.family === family &&
        typeof itemIndex === 'number' &&
        itemIndex > pending.nextItemIndex;
    const recordOzonReportPackagePhase = async (requestId, pending, family, payload) => {
        if (isLaterItem(pending, family, payload.itemIndex)) {
            await pending.resultTransition;
            return redeliver('ozon-package-phase', requestId, payload.itemIndex, { type: 'phase', payload: { family, value: payload } });
        }
        const phases = ['pre_create', 'create_dispatched', 'create_settled', 'polling', 'downloading', 'streaming'];
        const { itemIndex, phase } = payload;
        const rank = typeof phase === 'string' ? phases.indexOf(phase) : -1;
        if (!matchesOzonPackageFrame(pending, family, itemIndex) ||
            pending.state !== 'awaiting-item' ||
            typeof phase !== 'string' ||
            rank < 0 ||
            (pending.phase === undefined ? rank !== 0 : rank <= phases.indexOf(pending.phase))) {
            return rejectInvalidOzonPackageStream(requestId, pending);
        }
        pending.phase = phase;
        return enqueueOzonPackageHandler(requestId, pending, pending.handlers.onItemPhase, [itemIndex, phase]);
    };
    const startOzonReportPackageStream = async (requestId, pending, family, metadata) => {
        if (isLaterItem(pending, family, metadata.itemIndex)) {
            await pending.resultTransition;
            return redeliver('ozon-package-stream-start', requestId, metadata.itemIndex, {
                type: 'stream_start',
                payload: { family, value: metadata },
            });
        }
        const { frameId: _frameId, itemIndex, ...handlerMetadata } = metadata;
        if (!matchesOzonPackageFrame(pending, family, itemIndex) || pending.state !== 'awaiting-item') {
            return rejectInvalidOzonPackageStream(requestId, pending);
        }
        const declaredSize = typeof metadata.declaredSize === 'number' ? metadata.declaredSize : undefined;
        pending.state = 'streaming';
        pending.declaredStreamBytes = declaredSize ?? null;
        pending.maxStreamBytes = declaredSize ?? ARTIFACT_MAX_FILE_BYTES;
        return enqueueOzonPackageHandler(requestId, pending, pending.handlers.onItemStart, [
            itemIndex,
            handlerMetadata,
            pending.abortController.signal,
        ]);
    };
    const appendOzonReportPackageStreamChunk = async (requestId, pending, family, chunk) => {
        if (isLaterItem(pending, family, chunk.itemIndex)) {
            await pending.resultTransition;
            return redeliver('ozon-package-stream-chunk', requestId, chunk.itemIndex, {
                type: 'stream_chunk',
                payload: { family, value: chunk },
            });
        }
        const { itemIndex, index, data } = chunk;
        if (!matchesOzonPackageFrame(pending, family, itemIndex) ||
            pending.state !== 'streaming' ||
            typeof index !== 'number' ||
            index !== pending.nextChunkIndex ||
            typeof data !== 'string') {
            return rejectInvalidOzonPackageStream(requestId, pending);
        }
        const decodedBytes = Buffer.byteLength(data, 'base64');
        if (pending.receivedStreamBytes + decodedBytes > pending.maxStreamBytes) {
            return rejectInvalidOzonPackageStream(requestId, pending);
        }
        pending.nextChunkIndex += 1;
        pending.receivedStreamBytes += decodedBytes;
        return enqueueOzonPackageHandler(requestId, pending, pending.handlers.onItemChunk, [itemIndex, index, data]);
    };
    const endOzonReportPackageStream = async (requestId, pending, family, metadata) => {
        if (isLaterItem(pending, family, metadata.itemIndex)) {
            await pending.resultTransition;
            return redeliver('ozon-package-stream-end', requestId, metadata.itemIndex, {
                type: 'stream_end',
                payload: { family, value: metadata },
            });
        }
        const { frameId: _frameId, itemIndex, ...handlerMetadata } = metadata;
        if (!matchesOzonPackageFrame(pending, family, itemIndex) ||
            pending.state !== 'streaming' ||
            metadata.size !== pending.receivedStreamBytes ||
            (pending.declaredStreamBytes !== null && metadata.size !== pending.declaredStreamBytes)) {
            return rejectInvalidOzonPackageStream(requestId, pending);
        }
        pending.state = 'finalizing';
        return enqueueOzonPackageHandler(requestId, pending, pending.handlers.onItemEnd, [itemIndex, handlerMetadata], () => {
            // A failure terminal may already be queued behind this finalization.
            if (pending.state === 'finalizing')
                pending.state = 'awaiting-result';
        });
    };
    const resolveOzonReportPackageItem = async (requestId, pending, family, itemIndex, result) => {
        if (isLaterItem(pending, family, itemIndex)) {
            await pending.resultTransition;
            return redeliver('ozon-package-item-result', requestId, itemIndex, {
                type: 'item_result',
                payload: { family, itemIndex, value: result },
            });
        }
        const { ok, status, error } = isRecord(result) ? result : {};
        const mayFinishWithoutStream = (ok === false || pending.resultOnly) && pending.state === 'awaiting-item';
        const mayFailDuringStream = ok === false && status !== 'skipped' && (pending.state === 'streaming' || pending.state === 'finalizing');
        const mayFinishStream = pending.state === 'awaiting-result' && status !== 'skipped';
        if (!matchesOzonPackageFrame(pending, family, itemIndex, false) ||
            (!mayFinishStream && !mayFinishWithoutStream && !mayFailDuringStream)) {
            return rejectInvalidOzonPackageStream(requestId, pending);
        }
        if (pending.isValidResult?.(itemIndex, result) === false) {
            return rejectInvalidOzonPackageStream(requestId, pending, 'The Ozon package item result does not match the signed request.');
        }
        const deferCleanup = mayFailDuringStream && pending.privateHandlerCount > 0;
        if (deferCleanup) {
            // An authenticated failure ends this item even when its private filesystem call
            // cannot be interrupted. Keep that writer's cleanup owned, but fence every late
            // callback before admitting the next item; a blocked disk must not hide the result.
            pending.handlerGeneration += 1;
            pending.privateHandlerCount = 0;
            pending.handlerChain = Promise.resolve();
            pending.abortController.abort(error);
        }
        pending.state = 'finalizing-result';
        // Result frames have no ACK before the extension sends the next item's phase
        // or skipped terminal. Serialize that transition, not the private I/O chain:
        // a failed terminal must still be able to interrupt a blocked writer.
        // Future indices wait (a skipped remainder can arrive in one TCP read), then
        // undergo the same strict admission checks. Duplicates never wait.
        pending.resultTransition = finishOzonReportPackageItem(requestId, pending, itemIndex, result, deferCleanup).finally(() => {
            pending.resultTransition = undefined;
        });
        return pending.resultTransition;
    };
    const finishOzonReportPackageItem = async (requestId, pending, itemIndex, result, deferCleanup) => {
        const generation = pending.handlerGeneration;
        const commitArtifact = () => {
            if (pending.cancelled ||
                correlation.stateOf(requestId) !== pending ||
                pending.handlerGeneration !== generation ||
                pending.nextItemIndex !== itemIndex ||
                pending.abortController.signal.aborted)
                return false;
            // Transfer cancellation ownership synchronously with public completion.
            // Waiting for the async result callback would leave a published XLSX
            // exposed to disconnect/deadline in its return-to-broker microtask gap.
            pending.abortController = new AbortController();
            return true;
        };
        const handled = await enqueueOzonPackageHandler(requestId, pending, pending.handlers.onItemResult, [
            itemIndex,
            result,
            { deferCleanup, commitArtifact },
        ]);
        if (!handled)
            return false;
        pending.results[itemIndex] = result;
        pending.nextItemIndex += 1;
        pending.phase = undefined;
        if (pending.nextItemIndex === pending.items.length) {
            return settleOzonReportPackage(requestId, pending, pending.results);
        }
        // The matching result commits this item's artifact. Later cancellation belongs to
        // the next item and must not reach writers for already completed resource links.
        pending.abortController = new AbortController();
        pending.state = 'awaiting-item';
        pending.nextChunkIndex = 0;
        pending.receivedStreamBytes = 0;
        pending.declaredStreamBytes = null;
        pending.maxStreamBytes = ARTIFACT_MAX_FILE_BYTES;
        return true;
    };
    const rejectOzonReportPackage = (requestId, pending, error) => {
        return cancelOzonReportPackage(requestId, pending, normalizeOzonPromotionError(error, 'OZON_AUTHORIZATION_REJECTED', 'The extension rejected the Ozon report package.'));
    };
    const takeOzonReportPackage = (requestId, pending) => {
        if (correlation.stateOf(requestId) !== pending)
            return false;
        correlation.close(requestId);
        pending.cancelled = true;
        if (reservation.current?.pending === pending)
            reservation.current = null;
        return true;
    };
    const signalOzonPackageCancellation = (requestId, pending, error) => {
        pending.abortController.abort(error);
        try {
            pending.handlers.onCancel?.(error);
        }
        catch (cancelError) {
            reportUnsettled('ozon-package-cancel-signal', requestId, isRecord(cancelError) ? cancelError.code : undefined);
        }
    };
    const settleOzonReportPackage = (requestId, pending, value) => {
        if (!takeOzonReportPackage(requestId, pending))
            return false;
        pending.resolve(value);
        return true;
    };
    const cancelOzonReportPackage = (requestId, pending, error) => {
        if (!takeOzonReportPackage(requestId, pending))
            return false;
        signalOzonPackageCancellation(requestId, pending, error);
        pending.reject(error);
        return true;
    };
    // A handler of the caller takes the frame's own fields; a stream start also takes the item's cancellation signal.
    const enqueueOzonPackageHandler = (requestId, pending, handler, args, onComplete) => {
        const generation = pending.handlerGeneration;
        const isCurrent = () => !pending.cancelled && correlation.stateOf(requestId) === pending && pending.handlerGeneration === generation;
        const privateIo = [pending.handlers.onItemStart, pending.handlers.onItemChunk, pending.handlers.onItemEnd].some((io) => io === handler);
        if (privateIo)
            pending.privateHandlerCount += 1;
        const handlerPromise = pending.handlerChain.then(async () => {
            if (!isCurrent())
                return false;
            try {
                // A missing handler fails the package as any handler failure does.
                if (handler === undefined)
                    throw new TypeError('The Ozon package handler is missing.');
                await handler(...args);
                return isCurrent();
            }
            finally {
                if (privateIo && pending.handlerGeneration === generation)
                    pending.privateHandlerCount -= 1;
            }
        });
        pending.handlerChain = handlerPromise;
        return handlerPromise.then((handled) => {
            if (handled)
                onComplete?.();
            return handled;
        }, (error) => {
            // A detached old writer may finish/fail after the next item has begun.
            // It retains cleanup ownership but cannot cancel its successor's result.
            if (!isCurrent())
                return false;
            const normalized = normalizeOzonPromotionError(error, 'ARTIFACT_REJECTED', 'The Ozon report package artifact could not be stored safely.');
            if (!cancelOzonReportPackage(requestId, pending, normalized)) {
                reportUnsettled('ozon-package-handler-error', requestId, isRecord(error) ? error.code : undefined);
            }
            return false;
        });
    };
    const rejectInvalidOzonPackageStream = (requestId, pending, message = 'Ozon report package frames arrived out of order or for the wrong family.') => {
        cancelOzonReportPackage(requestId, pending, ozonPromotionError('ARTIFACT_REJECTED', message));
        return false;
    };
    const matchesOzonPackageFrame = (pending, family, itemIndex, streamFrame = true) => {
        return (pending.family === family &&
            !(streamFrame && pending.resultOnly) &&
            Number.isSafeInteger(itemIndex) &&
            itemIndex === pending.nextItemIndex);
    };
    // Parse boundary: the request and its handlers as the job passed them, and the lease binding, each checked before use.
    const requestOzonReportPackage = (packageRequest, handlers, authorizationId, authorizationScopeId) => {
        const rejectBeforeStart = (error) => Promise.resolve(handlers?.onNotStarted?.(error)).then(() => {
            throw error;
        });
        const authorizationScope = typeof authorizationScopeId === 'string' ? correlation.scopes.get(authorizationScopeId) : undefined;
        if (!authorizationScope ||
            typeof authorizationScopeId !== 'string' ||
            !correlation.scopeIsActive(authorizationScopeId, authorizationScope)) {
            return rejectBeforeStart(ozonPromotionError('OZON_AUTHORIZATION_REJECTED', 'The signed Ozon report package authorization is no longer active.'));
        }
        const family = packageRequest?.family;
        const items = packageRequest?.items;
        const familySpec = Object.hasOwn(OZON_PACKAGE_FAMILIES, family) ? OZON_PACKAGE_FAMILIES[family] : undefined;
        const signedItems = familySpec?.signedItems(authorizationScope.job);
        if (familySpec === undefined ||
            authorizationScope.authorizationId !== authorizationId ||
            authorizationScope.jobType !== familySpec.jobType ||
            !Array.isArray(items) ||
            items.length < 1 ||
            items.length > MAX_OZON_REPORT_PACKAGE_ITEMS ||
            !exactOzonPackageItemsEqual(family, items, signedItems) ||
            !Number.isSafeInteger(packageRequest?.deadlineAt) ||
            packageRequest.deadlineAt <= 0) {
            return rejectBeforeStart(ozonPromotionError('OZON_AUTHORIZATION_REJECTED', 'Only an exact matching signed Ozon report package may use this authorization.'));
        }
        const resultOnly = familySpec.resultOnly === true;
        if (!resultOnly && (handlers.onItemStart === undefined || handlers.onItemChunk === undefined || handlers.onItemEnd === undefined)) {
            return rejectBeforeStart(ozonPromotionError('ARTIFACT_REJECTED', 'Ozon package artifact handlers are not ready to receive report streams.'));
        }
        const authorizationExpiresAtMs = authorizationScope.expiresAtMs;
        const effectiveDeadline = Math.min(packageRequest.deadlineAt, authorizationExpiresAtMs);
        const remaining = effectiveDeadline - Date.now();
        if (remaining <= 0 || (remaining < OZON_PROMOTION_OPERATION_MAX_MS && authorizationExpiresAtMs <= packageRequest.deadlineAt)) {
            const tokenWins = authorizationExpiresAtMs <= packageRequest.deadlineAt;
            return rejectBeforeStart(ozonPromotionError(tokenWins ? 'OZON_AUTHORIZATION_REJECTED' : 'OPERATION_DEADLINE_EXCEEDED', tokenWins
                ? 'The signed Ozon report package authorization expires before one item can finish.'
                : 'The Ozon report package deadline has already expired.'));
        }
        if (reservation.current !== null) {
            return rejectBeforeStart(ozonPromotionError('OZON_ADMISSION_CAPACITY_EXHAUSTED', 'Another Ozon report operation is already pending.'));
        }
        if (route === undefined) {
            return rejectBeforeStart(ozonPromotionError('OZON_ROUTE_NOT_READY', 'The Ozon report package route is not available.'));
        }
        // The one Ozon reservation is taken before the package is sent; its settlement is the request's.
        const pending = {
            resolve: () => undefined,
            reject: () => undefined,
            family,
            resultOnly,
            isValidResult: familySpec.resultValidator?.(authorizationScope.job),
            items,
            deadlineAt: packageRequest.deadlineAt,
            authorizationExpiresAtMs,
            handlers,
            results: new Array(items.length),
            nextItemIndex: 0,
            state: 'awaiting-item',
            nextChunkIndex: 0,
            receivedStreamBytes: 0,
            declaredStreamBytes: null,
            maxStreamBytes: ARTIFACT_MAX_FILE_BYTES,
            handlerChain: Promise.resolve(),
            handlerGeneration: 0,
            privateHandlerCount: 0,
            cancelled: false,
            abortController: new AbortController(),
            authorizationScopeId,
        };
        return correlation.open({
            type: OZON_PACKAGE,
            payload: {
                authorizationId,
                authorizationScopeId,
                family,
                items,
                deadlineAt: packageRequest.deadlineAt,
                timeout: OZON_PROMOTION_OPERATION_MAX_MS,
            },
            timeoutMs: Math.max(1, effectiveDeadline - Date.now()),
            // The deadline's terminal passes the abort handler's normalization unchanged.
            timeoutError: () => {
                const tokenWins = authorizationExpiresAtMs <= packageRequest.deadlineAt;
                return ozonPromotionError(tokenWins ? 'OZON_AUTHORIZATION_REJECTED' : 'OPERATION_DEADLINE_EXCEEDED', tokenWins ? 'The signed Ozon report package authorization expired.' : 'The Ozon report package deadline expired.');
            },
            authorization: { id: authorizationScope.authorizationId, scopeId: authorizationScopeId },
            createState: (control) => {
                pending.resolve = control.resolve;
                pending.reject = control.reject;
                reservation.current = { kind: `${family}-package`, pending };
                return pending;
            },
            via: (frame) => route({ requestId: frame.id, ...frame.payload }),
            onFrame: (frame, control) => ozonPackageFrame(control.id, pending, frame),
            onScopeEnded: (_error, scope, control) => cancelOzonReportPackage(control.id, pending, scope.expired
                ? ozonPromotionError('OZON_AUTHORIZATION_REJECTED', 'The signed Ozon report package authorization expired.')
                : ozonPromotionError('OPERATION_CANCELLED', 'The Ozon report package was cancelled with its authorization.')),
            onAbort: (errorOrMessage, control) => cancelOzonReportPackage(control.id, pending, normalizeOzonPromotionError(errorOrMessage, 'OPERATION_CANCELLED', 'The Ozon report package was cancelled because its extension route closed.')),
            onSendError: (error, control) => {
                const cancel = () => cancelOzonReportPackage(control.id, pending, normalizeOzonPromotionError(error, 'OZON_ROUTE_NOT_READY', 'The Ozon report package route is not available.'));
                if (isOzonPackageNotStarted(error)) {
                    Promise.resolve()
                        .then(() => handlers.onNotStarted?.(error))
                        .then(cancel, cancel);
                }
                else
                    cancel();
            },
        }).result;
    };
    // The one package a signed authorization allows, bound to its lease (spec §7.4 lease binding): the lease's
    // authorization id and scope.
    const run = (packageRequest, handlers, lease) => {
        if (lease !== undefined && consumed.has(lease)) {
            return Promise.reject(ozonPromotionError('OZON_AUTHORIZATION_REJECTED', 'This signed Ozon report package authorization has already been used.'));
        }
        if (typeof lease === 'object' && lease !== null)
            consumed.add(lease);
        return requestOzonReportPackage(packageRequest, handlers, lease?.id, lease?.scopeId);
    };
    return { run };
};
