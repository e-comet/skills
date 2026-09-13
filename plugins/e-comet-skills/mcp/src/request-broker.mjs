import { randomUUID } from 'node:crypto';
import { isOzonPackageNotStarted } from './ozon-report-package-result.mjs';
import { MAX_OZON_REPORT_PACKAGE_ITEMS } from './ozon-report-package-domain.mjs';

import {
    AUTHORIZATION_RELEASE_TIMEOUT_MS,
    AUTHORIZATION_SCOPE_MAX_MS,
    ARTIFACT_MAX_FILE_BYTES,
    MAX_SELLER_REVIEW_PHYSICAL_REPORTS,
    MAX_ACTIVE_AUTHORIZATION_SCOPES,
    REQUEST_TIMEOUT_GRACE_MS,
    REQUEST_TIMEOUT_MS,
    SELLER_AUTHORIZATION_SCOPE_MAX_MS,
} from './config.mjs';
import { isValidOzonPromotionOperation, isValidSellerOperation } from './extension-protocol.mjs';
import { SELLER_OPERATION_STAGES } from './extension-vocabulary.mjs';
import { OZON_PROMOTION_TERMINAL_CODE_STAGES, ToolExecutionError } from './tool-errors.mjs';
import { StorageUnavailableError } from './storage-layout.mjs';
import { isAllowedWbUrl, validTimeout } from './wb-domain.mjs';

export const OZON_PROMOTION_OPERATION_MAX_MS = 8 * 60 * 1000;
const OZON_PROMOTION_OPERATION_MIN_MS = 1000;
const isValidOzonPromotionTimeout = (value) =>
    Number.isSafeInteger(value) && value >= OZON_PROMOTION_OPERATION_MIN_MS && value <= OZON_PROMOTION_OPERATION_MAX_MS;
const ozonPromotionError = (code, message) => {
    const stage = OZON_PROMOTION_TERMINAL_CODE_STAGES[code];
    if (stage === undefined) throw new TypeError(`Unknown Ozon promotion terminal code: ${code}`);
    return new ToolExecutionError(code, message, stage, false);
};
const normalizeOzonPromotionError = (error, fallbackCode, fallbackMessage) =>
    // The consumer's own writer can fail before opening a stream. Preserve this local
    // diagnosis without adding storage errors to the extension/peer terminal vocabulary.
    error instanceof StorageUnavailableError || (error instanceof ToolExecutionError &&
    OZON_PROMOTION_TERMINAL_CODE_STAGES[error.code] === error.stage &&
    error.retryable === false)
        ? error
        : ozonPromotionError(fallbackCode, fallbackMessage);

const exactOzonPackageItemsEqual = (family, requested, signed) => {
    if (!Array.isArray(requested) || !Array.isArray(signed) || requested.length !== signed.length) return false;
    const fields = family === 'promotion' ? ['dateFrom', 'dateTo'] : ['dateFrom', 'dateTo', 'breakdown'];
    return requested.every((item, index) => {
        const signedItem = signed[index];
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
        if (!signedItem || typeof signedItem !== 'object' || Array.isArray(signedItem)) return false;
        const requestedKeys = Object.keys(item);
        const signedKeys = Object.keys(signedItem);
        if (requestedKeys.length !== fields.length || signedKeys.length !== fields.length) return false;
        if (!fields.every((field) => Object.hasOwn(item, field) && Object.hasOwn(signedItem, field))) return false;
        // The signature binds ordered field values, not the incidental JSON object insertion order chosen by each host.
        return fields.every((field) => item[field] === signedItem[field]);
    });
};

export class RequestBroker {
    constructor({
        routeWbFetch,
        routeSellerOperation,
        routeOzonPromotionReport = undefined,
        routeAuthorization,
        createRequestId = randomUUID,
        defaultTimeout = REQUEST_TIMEOUT_MS,
        authorizationReleaseTimeout = AUTHORIZATION_RELEASE_TIMEOUT_MS,
        // Сколько посредников стоит между нами и расширением на текущем маршруте.
        // Каждый из них ждёт на один запас дольше нижележащего, поэтому наш дедлайн
        // должен быть позже всех. Бюджет самого запроса при этом не меняется.
        routeHopCount = () => 1,
        authorizationScopeMaxMs = AUTHORIZATION_SCOPE_MAX_MS,
        sellerAuthorizationScopeMaxMs = SELLER_AUTHORIZATION_SCOPE_MAX_MS,
        maxActiveAuthorizationScopes = MAX_ACTIVE_AUTHORIZATION_SCOPES,
        maxPendingSellerOperations = MAX_SELLER_REVIEW_PHYSICAL_REPORTS,
        onUnsettled,
    }) {
        this.routeWbFetch = routeWbFetch;
        this.routeSellerOperation = routeSellerOperation;
        this.routeOzonPromotionReport = routeOzonPromotionReport;
        this.routeAuthorization = routeAuthorization;
        this.createRequestId = createRequestId;
        this.defaultTimeout = defaultTimeout;
        this.authorizationReleaseTimeout = authorizationReleaseTimeout;
        this.routeHopCount = routeHopCount;
        this.onUnsettled = onUnsettled;
        this.authorizationScopeMaxMs = authorizationScopeMaxMs;
        this.sellerAuthorizationScopeMaxMs = sellerAuthorizationScopeMaxMs;
        this.maxActiveAuthorizationScopes = maxActiveAuthorizationScopes;
        this.maxPendingSellerOperations = maxPendingSellerOperations;
    }

    pendingRequests = new Map();
    pendingAuthorizations = new Map();
    pendingAuthorizationReleases = new Map();
    pendingSellerOperations = new Map();
    pendingOzonPromotionOperations = new Map();
    pendingOzonReportPackages = new Map();
    ozonReportReservation = null;
    activeAuthorizationScopes = new Map();
    inFlightFetches = new Map();

    get activeRequestCount() {
        return (
            this.pendingRequests.size +
            this.pendingAuthorizations.size +
            this.pendingAuthorizationReleases.size +
            this.pendingSellerOperations.size +
            (this.ozonReportReservation === null ? 0 : 1) +
            this.activeAuthorizationScopes.size
        );
    }

    hasPendingAuthorization(requestId) {
        return this.pendingAuthorizations.has(requestId);
    }

    hasPendingAuthorizationRelease(requestId) {
        return this.pendingAuthorizationReleases.has(requestId);
    }

    hasPendingSellerOperation(requestId) {
        return this.pendingSellerOperations.has(requestId);
    }

    hasPendingOzonPromotionOperation(requestId) {
        return this.pendingOzonPromotionOperations.has(requestId);
    }

    hasPendingOzonReportPackage(requestId) {
        return this.pendingOzonReportPackages.has(requestId);
    }

    rejectPendingRequests(message) {
        this.#rejectAll(this.pendingRequests, message);
        this.#rejectAll(this.pendingAuthorizationReleases, message);
        this.#rejectAllSellerOperations(message);
        this.#rejectAllOzonPromotionOperations(message);
        this.#rejectAllOzonReportPackages(message);
    }

    rejectPendingAuthorizations(message) {
        this.#rejectAll(this.pendingAuthorizations, message);
        for (const requestId of this.activeAuthorizationScopes.keys()) {
            this.#releaseAuthorizationScopeInBackground(requestId, false);
        }
    }

    invalidateAuthorizationWork() {
        const error = this.#reauthorizationRequired();
        this.#rejectAll(this.pendingRequests, error);
        this.#rejectAll(this.pendingAuthorizationReleases, error);
        this.#rejectAllSellerOperations(error);
        this.#rejectAllOzonPromotionOperations(error);
        this.#rejectAllOzonReportPackages(error);
        this.#rejectAll(this.pendingAuthorizations, error);
        for (const requestId of this.activeAuthorizationScopes.keys()) {
            this.#releaseAuthorizationScopeInBackground(requestId, false);
        }
    }

    // Ответ на запрос, который уже завершился (обычно по таймауту). Раньше терялся
    // молча — вместе с типизированным кодом, который в нём приехал.
    #reportUnsettled(kind, requestId, detail) {
        this.onUnsettled?.({ kind, requestId, detail });
        return false;
    }

    resolveFetch(requestId, response, { includeRequestId = false } = {}) {
        const pending = this.#take(this.pendingRequests, requestId);
        if (!pending) return this.#reportUnsettled('fetch-result', requestId, response?.code);
        pending.resolve(includeRequestId ? { ...response, requestId } : response);
        return true;
    }

    rejectFetch(requestId, error) {
        const pending = this.#take(this.pendingRequests, requestId);
        if (!pending) return this.#reportUnsettled('fetch-error', requestId, error?.code);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
        return true;
    }

    resolveSellerOperation(requestId, response) {
        const pending = this.pendingSellerOperations.get(requestId);
        if (!pending || pending.state !== 'awaiting-result') return this.#reportUnsettled('seller-result', requestId);
        this.#settleSellerOperation(requestId, pending, (value) => pending.resolve(value), response);
        return true;
    }

    rejectSellerOperation(requestId, error) {
        const pending = this.pendingSellerOperations.get(requestId);
        if (!pending) return this.#reportUnsettled('seller-error', requestId, error?.code);
        this.#cancelSellerOperation(requestId, pending, error);
        return true;
    }

    resolveOzonPromotionReport(requestId, result) {
        const pending = this.pendingOzonPromotionOperations.get(requestId);
        if (!pending) return this.#reportUnsettled('ozon-result', requestId);
        if (pending.state !== 'awaiting-result') {
            this.#cancelOzonPromotionOperation(
                requestId,
                pending,
                ozonPromotionError(
                    'ARTIFACT_REJECTED',
                    'The Ozon promotion result arrived before the artifact stream ended.',
                )
            );
            return false;
        }
        return this.#settleOzonPromotionOperation(requestId, pending, (value) => pending.resolve(value), result);
    }

    rejectOzonPromotionReport(requestId, error) {
        const pending = this.pendingOzonPromotionOperations.get(requestId);
        if (!pending) return this.#reportUnsettled('ozon-error', requestId, error?.code);
        this.#cancelOzonPromotionOperation(
            requestId,
            pending,
            normalizeOzonPromotionError(
                error,
                'OZON_AUTHORIZATION_REJECTED',
                'The extension rejected the Ozon promotion operation.'
            )
        );
        return true;
    }

    async startOzonPromotionStream(requestId, metadata) {
        const pending = this.pendingOzonPromotionOperations.get(requestId);
        if (!pending) return this.#reportUnsettled('ozon-stream-start', requestId);
        if (pending.state !== 'awaiting-stream') return this.#rejectInvalidOzonStream(requestId, pending);
        const { frameId: _frameId, ...handlerMetadata } = metadata;
        pending.state = 'streaming';
        pending.declaredStreamBytes = metadata.declaredSize ?? null;
        pending.maxStreamBytes = metadata.declaredSize ?? ARTIFACT_MAX_FILE_BYTES;
        return this.#enqueueOzonHandler(requestId, pending, pending.streamHandlers.onStart, [handlerMetadata]);
    }

    async appendOzonPromotionStreamChunk(requestId, chunk) {
        const pending = this.pendingOzonPromotionOperations.get(requestId);
        if (!pending) return this.#reportUnsettled('ozon-stream-chunk', requestId, chunk?.index);
        if (pending.state !== 'streaming' || chunk.index !== pending.nextChunkIndex) {
            return this.#rejectInvalidOzonStream(requestId, pending);
        }
        const decodedBytes = Buffer.byteLength(chunk.data, 'base64');
        if (pending.receivedStreamBytes + decodedBytes > pending.maxStreamBytes) {
            return this.#rejectInvalidOzonStream(requestId, pending);
        }
        pending.nextChunkIndex += 1;
        pending.receivedStreamBytes += decodedBytes;
        return this.#enqueueOzonHandler(requestId, pending, pending.streamHandlers.onChunk, [chunk.index, chunk.data]);
    }

    async endOzonPromotionStream(requestId, metadata) {
        const pending = this.pendingOzonPromotionOperations.get(requestId);
        if (!pending) return this.#reportUnsettled('ozon-stream-end', requestId);
        if (
            pending.state !== 'streaming' ||
            metadata.size !== pending.receivedStreamBytes ||
            (pending.declaredStreamBytes !== null && metadata.size !== pending.declaredStreamBytes)
        ) {
            return this.#rejectInvalidOzonStream(requestId, pending);
        }
        pending.state = 'finalizing';
        const { frameId: _frameId, ...handlerMetadata } = metadata;
        return this.#enqueueOzonHandler(requestId, pending, pending.streamHandlers.onEnd, [handlerMetadata], () => {
            pending.state = 'awaiting-result';
        });
    }

    async recordOzonReportPackagePhase(requestId, family, payload) {
        const pending = this.pendingOzonReportPackages.get(requestId);
        if (pending?.resultTransition && pending.family === family && payload?.itemIndex > pending.nextItemIndex) {
            await pending.resultTransition;
            return this.recordOzonReportPackagePhase(requestId, family, payload);
        }
        if (!pending) return this.#reportUnsettled('ozon-package-phase', requestId, payload?.itemIndex);
        const phases = ['pre_create', 'create_dispatched', 'create_settled', 'polling', 'downloading', 'streaming'];
        const rank = phases.indexOf(payload?.phase);
        if (!this.#matchesOzonPackageFrame(pending, family, payload?.itemIndex) || pending.state !== 'awaiting-item' ||
            rank < 0 || (pending.phase === undefined ? rank !== 0 : rank <= phases.indexOf(pending.phase))) {
            return this.#rejectInvalidOzonPackageStream(requestId, pending);
        }
        pending.phase = payload.phase;
        return this.#enqueueOzonPackageHandler(requestId, pending, pending.handlers.onItemPhase,
            [payload.itemIndex, payload.phase]);
    }

    async startOzonReportPackageStream(requestId, family, metadata) {
        const pending = this.pendingOzonReportPackages.get(requestId);
        if (pending?.resultTransition && pending.family === family && metadata?.itemIndex > pending.nextItemIndex) {
            await pending.resultTransition;
            return this.startOzonReportPackageStream(requestId, family, metadata);
        }
        if (!pending) return this.#reportUnsettled('ozon-package-stream-start', requestId, metadata?.itemIndex);
        if (!this.#matchesOzonPackageFrame(pending, family, metadata?.itemIndex) || pending.state !== 'awaiting-item') {
            return this.#rejectInvalidOzonPackageStream(requestId, pending);
        }
        const { frameId: _frameId, itemIndex, ...handlerMetadata } = metadata;
        pending.state = 'streaming';
        pending.declaredStreamBytes = metadata.declaredSize ?? null;
        pending.maxStreamBytes = metadata.declaredSize ?? ARTIFACT_MAX_FILE_BYTES;
        return this.#enqueueOzonPackageHandler(
            requestId,
            pending,
            pending.handlers.onItemStart,
            [itemIndex, handlerMetadata],
            undefined,
            true
        );
    }

    async appendOzonReportPackageStreamChunk(requestId, family, chunk) {
        const pending = this.pendingOzonReportPackages.get(requestId);
        if (pending?.resultTransition && pending.family === family && chunk?.itemIndex > pending.nextItemIndex) {
            await pending.resultTransition;
            return this.appendOzonReportPackageStreamChunk(requestId, family, chunk);
        }
        if (!pending) return this.#reportUnsettled('ozon-package-stream-chunk', requestId, chunk?.itemIndex);
        if (
            !this.#matchesOzonPackageFrame(pending, family, chunk?.itemIndex) ||
            pending.state !== 'streaming' ||
            chunk.index !== pending.nextChunkIndex
        ) {
            return this.#rejectInvalidOzonPackageStream(requestId, pending);
        }
        const decodedBytes = Buffer.byteLength(chunk.data, 'base64');
        if (pending.receivedStreamBytes + decodedBytes > pending.maxStreamBytes) {
            return this.#rejectInvalidOzonPackageStream(requestId, pending);
        }
        pending.nextChunkIndex += 1;
        pending.receivedStreamBytes += decodedBytes;
        return this.#enqueueOzonPackageHandler(requestId, pending, pending.handlers.onItemChunk, [chunk.itemIndex, chunk.index, chunk.data]);
    }

    async endOzonReportPackageStream(requestId, family, metadata) {
        const pending = this.pendingOzonReportPackages.get(requestId);
        if (pending?.resultTransition && pending.family === family && metadata?.itemIndex > pending.nextItemIndex) {
            await pending.resultTransition;
            return this.endOzonReportPackageStream(requestId, family, metadata);
        }
        if (!pending) return this.#reportUnsettled('ozon-package-stream-end', requestId, metadata?.itemIndex);
        if (
            !this.#matchesOzonPackageFrame(pending, family, metadata?.itemIndex) ||
            pending.state !== 'streaming' ||
            metadata.size !== pending.receivedStreamBytes ||
            (pending.declaredStreamBytes !== null && metadata.size !== pending.declaredStreamBytes)
        ) {
            return this.#rejectInvalidOzonPackageStream(requestId, pending);
        }
        pending.state = 'finalizing';
        const { frameId: _frameId, itemIndex, ...handlerMetadata } = metadata;
        return this.#enqueueOzonPackageHandler(requestId, pending, pending.handlers.onItemEnd, [itemIndex, handlerMetadata], () => {
            // A failure terminal may already be queued behind this finalization.
            if (pending.state === 'finalizing') pending.state = 'awaiting-result';
        });
    }

    async resolveOzonReportPackageItem(requestId, family, itemIndex, result) {
        const pending = this.pendingOzonReportPackages.get(requestId);
        if (pending?.resultTransition && pending.family === family && itemIndex > pending.nextItemIndex) {
            await pending.resultTransition;
            return this.resolveOzonReportPackageItem(requestId, family, itemIndex, result);
        }
        if (!pending) return this.#reportUnsettled('ozon-package-item-result', requestId, itemIndex);
        const mayFinishWithoutStream = result?.ok === false && pending.state === 'awaiting-item';
        const mayFailDuringStream = result?.ok === false && result.status !== 'skipped' &&
            (pending.state === 'streaming' || pending.state === 'finalizing');
        const mayFinishStream = pending.state === 'awaiting-result' && result?.status !== 'skipped';
        if (
            !this.#matchesOzonPackageFrame(pending, family, itemIndex) ||
            (!mayFinishStream && !mayFinishWithoutStream && !mayFailDuringStream)
        ) {
            return this.#rejectInvalidOzonPackageStream(requestId, pending);
        }
        const deferCleanup = mayFailDuringStream && pending.privateHandlerCount > 0;
        if (deferCleanup) {
            // An authenticated failure ends this item even when its private filesystem call
            // cannot be interrupted. Keep that writer's cleanup owned, but fence every late
            // callback before admitting the next item; a blocked disk must not hide the result.
            pending.handlerGeneration += 1;
            pending.privateHandlerCount = 0;
            pending.handlerChain = Promise.resolve();
            pending.abortController.abort(result.error);
        }
        pending.state = 'finalizing-result';
        // Result frames have no ACK before the extension sends the next item's phase
        // or skipped terminal. Serialize that transition, not the private I/O chain:
        // a failed terminal must still be able to interrupt a blocked writer.
        // Future indices wait (a skipped remainder can arrive in one TCP read), then
        // undergo the same strict admission checks. Duplicates never wait.
        pending.resultTransition = this.#finishOzonReportPackageItem(requestId, pending, itemIndex, result, deferCleanup)
            .finally(() => { pending.resultTransition = undefined; });
        return pending.resultTransition;
    }

    async #finishOzonReportPackageItem(requestId, pending, itemIndex, result, deferCleanup) {
        const generation = pending.handlerGeneration;
        const commitArtifact = () => {
            if (pending.cancelled || this.pendingOzonReportPackages.get(requestId) !== pending ||
                pending.handlerGeneration !== generation || pending.nextItemIndex !== itemIndex ||
                pending.abortController.signal.aborted) return false;
            // Transfer cancellation ownership synchronously with public completion.
            // Waiting for the async result callback would leave a published XLSX
            // exposed to disconnect/deadline in its return-to-broker microtask gap.
            pending.abortController = new AbortController();
            return true;
        };
        const handled = await this.#enqueueOzonPackageHandler(requestId, pending, pending.handlers.onItemResult,
            [itemIndex, result, { deferCleanup, commitArtifact }]);
        if (!handled) return false;
        pending.results[itemIndex] = result;
        pending.nextItemIndex += 1;
        pending.phase = undefined;
        if (pending.nextItemIndex === pending.items.length) {
            return this.#settleOzonReportPackage(requestId, pending, pending.results);
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
    }

    rejectOzonReportPackage(requestId, error) {
        const pending = this.pendingOzonReportPackages.get(requestId);
        if (!pending) return this.#reportUnsettled('ozon-package-error', requestId, error?.code);
        return this.#cancelOzonReportPackage(
            requestId,
            pending,
            normalizeOzonPromotionError(
                error,
                'OZON_AUTHORIZATION_REJECTED',
                'The extension rejected the Ozon report package.'
            )
        );
    }

    async startSellerStream(requestId, metadata) {
        const pending = this.pendingSellerOperations.get(requestId);
        if (!pending) return this.#reportUnsettled('seller-stream-start', requestId);
        if (pending.state === 'ending') return this.#reportUnsettled('seller-stream-start', requestId);
        if (pending.state !== 'awaiting-result') return this.#rejectInvalidSellerStream(requestId, pending);
        // `declaredSize` is optional on the wire, so an omitted value falls back to the per-file ceiling
        // instead of being reported as an out-of-order frame.
        const { declaredSize, mimeType } = metadata;
        if (
            declaredSize !== undefined &&
            (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > ARTIFACT_MAX_FILE_BYTES)
        ) {
            return this.#rejectInvalidSellerStream(requestId, pending, 'Seller stream declared an unusable artifact size.');
        }
        pending.state = 'streaming';
        pending.declaredStreamBytes = declaredSize ?? null;
        pending.maxStreamBytes = declaredSize ?? ARTIFACT_MAX_FILE_BYTES;
        const streamMetadata = declaredSize === undefined ? { mimeType } : { mimeType, declaredSize };
        return this.#enqueueSellerHandler(requestId, pending, pending.streamHandlers.onStart, [streamMetadata]);
    }

    async appendSellerStreamChunk(requestId, index, data) {
        const pending = this.pendingSellerOperations.get(requestId);
        if (!pending) return this.#reportUnsettled('seller-stream-chunk', requestId, index);
        if (pending.state === 'ending') return this.#reportUnsettled('seller-stream-chunk', requestId, index);
        if (pending.state !== 'streaming' || index !== pending.nextChunkIndex) {
            return this.#rejectInvalidSellerStream(requestId, pending);
        }
        const decodedBytes = Buffer.byteLength(data, 'base64');
        if (pending.receivedStreamBytes + decodedBytes > pending.maxStreamBytes) {
            return this.#rejectInvalidSellerStream(requestId, pending);
        }
        pending.nextChunkIndex += 1;
        pending.receivedStreamBytes += decodedBytes;
        return this.#enqueueSellerHandler(requestId, pending, pending.streamHandlers.onChunk, [index, data]);
    }

    async endSellerStream(requestId, metadata) {
        const pending = this.pendingSellerOperations.get(requestId);
        if (!pending) return this.#reportUnsettled('seller-stream-end', requestId);
        if (pending.state === 'ending') return this.#reportUnsettled('seller-stream-end', requestId);
        if (pending.state !== 'streaming') return this.#rejectInvalidSellerStream(requestId, pending);
        if (
            metadata.size !== pending.receivedStreamBytes ||
            (pending.declaredStreamBytes !== null && metadata.size !== pending.declaredStreamBytes)
        ) {
            return this.#rejectInvalidSellerStream(requestId, pending);
        }
        pending.state = 'ending';
        return this.#enqueueSellerHandler(requestId, pending, pending.streamHandlers.onEnd, [metadata], () =>
            this.#settleSellerOperation(requestId, pending, (value) => pending.resolve(value), metadata)
        );
    }

    resolveAuthorization(requestId, authorization) {
        const pending = this.#take(this.pendingAuthorizations, requestId);
        if (!pending) return this.#reportUnsettled('authorization-result', requestId);
        pending.resolve(authorization);
        return true;
    }

    rejectAuthorization(requestId, error) {
        const pending = this.#take(this.pendingAuthorizations, requestId);
        if (!pending) return this.#reportUnsettled('authorization-error', requestId, error?.code);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
        return true;
    }

    resolveAuthorizationRelease(requestId) {
        const pending = this.#take(this.pendingAuthorizationReleases, requestId);
        if (!pending) return this.#reportUnsettled('authorization-release-result', requestId);
        pending.resolve(true);
        return true;
    }

    rejectAuthorizationRelease(requestId, error) {
        const pending = this.#take(this.pendingAuthorizationReleases, requestId);
        if (!pending) return this.#reportUnsettled('authorization-release-error', requestId, error?.code);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
        return true;
    }

    requestWbFetch(url, timeout = this.defaultTimeout, authorizationId, authorizationScopeId) {
        if (typeof authorizationId !== 'string' || authorizationId.length === 0) {
            return Promise.reject(
                new ToolExecutionError(
                    'BROWSER_JOB_REQUIRED',
                    'A signed browser-job authorization is required.',
                    'arguments',
                    false
                )
            );
        }
        if (!isAllowedWbUrl(url)) {
            return Promise.reject(
                new ToolExecutionError(
                    'BROWSER_JOB_URL_NOT_ALLOWED',
                    'Only approved Wildberries internal URLs are allowed.',
                    'arguments',
                    false
                )
            );
        }
        if (typeof authorizationScopeId !== 'string') {
            return Promise.reject(this.#reauthorizationRequired());
        }
        const authorizationScope = this.activeAuthorizationScopes.get(authorizationScopeId);
        if (!authorizationScope || !this.#authorizationScopeIsActive(authorizationScopeId, authorizationScope)) {
            return Promise.reject(this.#reauthorizationRequired());
        }
        if (authorizationScope.authorizationId !== authorizationId) {
            return Promise.reject(this.#reauthorizationRequired());
        }
        const dedupeKey = `${authorizationScopeId}\n${authorizationId}\n${url}\n${timeout}`;
        const existing = this.inFlightFetches.get(dedupeKey);
        if (existing) return existing;

        const request = (async () => {
            // Дальше по маршруту уходит ровно `timeout` — это подписанный бюджет
            // запроса, урезать его нельзя. Себе берём запас на каждый хоп, чтобы наш
            // таймер сработал последним и типизированный отказ снизу успел доехать.
            return this.#createPending(
                this.pendingRequests,
                timeout + REQUEST_TIMEOUT_GRACE_MS * Math.max(1, this.routeHopCount()),
                () =>
                    new ToolExecutionError(
                        'WB_FETCH_TIMEOUT',
                        `The Wildberries request timed out after ${timeout} ms.`,
                        'extension',
                        true
                    ),
                (requestId) => {
                    // Record ownership before dispatch: a synchronous route may release its scope.
                    this.pendingRequests.get(requestId).authorizationScopeId = authorizationScopeId;
                    return this.routeWbFetch({ requestId, url, timeout, authorizationId, authorizationScopeId });
                }
            );
        })();
        this.inFlightFetches.set(dedupeKey, request);
        void request.then(
            () => this.inFlightFetches.delete(dedupeKey),
            () => this.inFlightFetches.delete(dedupeKey)
        );
        return request;
    }

    requestAuthorization(token, timeout = this.defaultTimeout) {
        if (this.pendingAuthorizations.size + this.activeAuthorizationScopes.size >= this.maxActiveAuthorizationScopes) {
            return Promise.reject(
                new ToolExecutionError(
                    'AUTHORIZATION_SCOPE_CAPACITY_EXCEEDED',
                    'Too many browser job authorization scopes are active.',
                    'local',
                    true
                )
            );
        }
        return this.#createPending(
            this.pendingAuthorizations,
            timeout + REQUEST_TIMEOUT_GRACE_MS * Math.max(1, this.routeHopCount()),
            () =>
                new ToolExecutionError(
                    'BROWSER_JOB_AUTHORIZATION_TIMEOUT',
                    `The extension did not authorize the browser job within ${timeout} ms.`,
                    'extension',
                    true
                ),
            (requestId) => this.routeAuthorization({ requestId, token }),
            (authorization, requestId, routeResult) => {
                const routeBinding =
                    typeof routeResult === 'function'
                        ? { release: routeResult }
                        : routeResult && typeof routeResult === 'object'
                          ? routeResult
                          : {};
                const authorizationScopeLifetimeMs = this.#authorizationScopeLifetime(authorization);
                const authorizationScope = {
                    authorizationId: authorization?.authorizationId,
                    jobType: authorization?.jobType,
                    job: authorization?.job,
                    expiresAtMs: Date.now() + authorizationScopeLifetimeMs,
                    isRouteActive: routeBinding.isActive,
                    releaseRoute: routeBinding.release,
                    expiryTimer: undefined,
                };
                authorizationScope.expiryTimer = setTimeout(() => {
                    authorizationScope.expired = true;
                    this.#releaseAuthorizationScopeInBackground(requestId, true);
                }, authorizationScopeLifetimeMs);
                authorizationScope.expiryTimer.unref?.();
                this.activeAuthorizationScopes.set(requestId, authorizationScope);
                return {
                    authorization,
                    requestWbFetch: (url, fetchTimeout = this.defaultTimeout) =>
                        this.requestWbFetch(url, fetchTimeout, authorization?.authorizationId, requestId),
                    requestSellerOperation: (operation, streamHandlers, sellerTimeout = this.defaultTimeout) =>
                        this.requestSellerOperation(
                            operation,
                            streamHandlers,
                            sellerTimeout,
                            authorization?.authorizationId,
                            requestId
                        ),
                    requestOzonPromotionReport: (() => {
                        let consumed = false;
                        return (operation, streamHandlers, ozonTimeout = OZON_PROMOTION_OPERATION_MAX_MS) => {
                            if (consumed) {
                                return Promise.reject(
                                    ozonPromotionError(
                                        'OZON_AUTHORIZATION_REJECTED',
                                        'This signed Ozon promotion authorization has already been used.'
                                    )
                                );
                            }
                            consumed = true;
                            return this.requestOzonPromotionReport(
                                operation,
                                streamHandlers,
                                ozonTimeout,
                                authorization?.authorizationId,
                                requestId
                            );
                        };
                    })(),
                    requestOzonReportPackage: (() => {
                        let consumed = false;
                        return (packageRequest, handlers) => {
                            if (consumed) {
                                return Promise.reject(
                                    ozonPromotionError(
                                        'OZON_AUTHORIZATION_REJECTED',
                                        'This signed Ozon report package authorization has already been used.'
                                    )
                                );
                            }
                            consumed = true;
                            return this.requestOzonReportPackage(
                                packageRequest,
                                handlers,
                                authorization?.authorizationId,
                                requestId
                            );
                        };
                    })(),
                    isActive: () => this.#authorizationScopeIsActive(requestId, authorizationScope),
                    release: () => this.#releaseAuthorizationScope(requestId, true),
                };
            }
        );
    }

    requestAuthorizationRelease(authorizationId, route, timeout = this.authorizationReleaseTimeout) {
        if (typeof authorizationId !== 'string' || authorizationId.length === 0 || typeof route !== 'function') {
            return Promise.reject(new TypeError('Authorization release requires an authorization ID and route.'));
        }
        return this.#createPending(
            this.pendingAuthorizationReleases,
            timeout + REQUEST_TIMEOUT_GRACE_MS * Math.max(1, this.routeHopCount()),
            () =>
                new ToolExecutionError(
                    'BROWSER_JOB_AUTHORIZATION_RELEASE_TIMEOUT',
                    `The extension did not confirm browser job authorization release within ${timeout} ms.`,
                    'extension',
                    true
                ),
            (requestId) => route({ requestId, authorizationId })
        );
    }

    requestSellerOperation(operation, streamHandlers, timeout, authorizationId, authorizationScopeId) {
        const authorizationScope = this.activeAuthorizationScopes.get(authorizationScopeId);
        if (!authorizationScope || !this.#authorizationScopeIsActive(authorizationScopeId, authorizationScope)) {
            return Promise.reject(this.#reauthorizationRequired());
        }
        if (authorizationScope.authorizationId !== authorizationId || !isValidSellerOperation(operation)) {
            return Promise.reject(
                new ToolExecutionError(
                    'SELLER_OPERATION_NOT_ALLOWED',
                    'Only a valid typed seller operation may be requested through its signed authorization scope.',
                    'arguments',
                    false
                )
            );
        }
        const requiresStreamHandlers = operation.stage === SELLER_OPERATION_STAGES.download;
        if (
            requiresStreamHandlers &&
            (!streamHandlers ||
                typeof streamHandlers.onStart !== 'function' ||
                typeof streamHandlers.onChunk !== 'function' ||
                typeof streamHandlers.onEnd !== 'function')
        ) {
            return Promise.reject(new TypeError('Seller stream handlers must provide onStart, onChunk, and onEnd functions.'));
        }
        const normalizedStreamHandlers = requiresStreamHandlers
            ? streamHandlers
            : { onStart: () => undefined, onChunk: () => undefined, onEnd: () => undefined };
        if (!validTimeout(timeout)) {
            return Promise.reject(
                new ToolExecutionError(
                    'SELLER_OPERATION_TIMEOUT_INVALID',
                    'Seller operation timeout is outside the allowed bounds.',
                    'arguments',
                    false
                )
            );
        }
        if (this.pendingSellerOperations.size >= this.maxPendingSellerOperations) {
            return Promise.reject(
                new ToolExecutionError(
                    'SELLER_OPERATION_CAPACITY_EXCEEDED',
                    'Too many seller operations are pending.',
                    'local',
                    true
                )
            );
        }
        if (typeof this.routeSellerOperation !== 'function') {
            return Promise.reject(new Error('Seller operation routing is unavailable.'));
        }
        return new Promise((resolve, reject) => {
            const requestId = this.createRequestId();
            const timer = setTimeout(() => {
                this.#cancelSellerOperation(
                    requestId,
                    pending,
                    new ToolExecutionError(
                        'SELLER_OPERATION_TIMEOUT',
                        `The seller operation timed out after ${timeout} ms.`,
                        'extension',
                        true
                    )
                );
            }, timeout + REQUEST_TIMEOUT_GRACE_MS * Math.max(1, this.routeHopCount()));
            const pending = {
                resolve,
                reject,
                timer,
                state: 'awaiting-result',
                nextChunkIndex: 0,
                receivedStreamBytes: 0,
                declaredStreamBytes: null,
                maxStreamBytes: ARTIFACT_MAX_FILE_BYTES,
                streamHandlers: normalizedStreamHandlers,
                handlerChain: Promise.resolve(),
                authorizationScopeId,
            };
            this.pendingSellerOperations.set(requestId, pending);
            try {
                this.routeSellerOperation({ requestId, sellerOperation: operation, timeout, authorizationId, authorizationScopeId });
            } catch (error) {
                this.#settleSellerOperation(requestId, pending, (reason) => reject(reason), error);
            }
        });
    }

    requestOzonPromotionReport(operation, streamHandlers, timeout, authorizationId, authorizationScopeId) {
        const authorizationScope = this.activeAuthorizationScopes.get(authorizationScopeId);
        if (!authorizationScope || !this.#authorizationScopeIsActive(authorizationScopeId, authorizationScope)) {
            return Promise.reject(
                ozonPromotionError(
                    'OZON_AUTHORIZATION_REJECTED',
                    'The signed Ozon promotion authorization is no longer active.'
                )
            );
        }
        if (
            authorizationScope.authorizationId !== authorizationId ||
            authorizationScope.jobType !== 'ozon_seller_promotion_report' ||
            !isValidOzonPromotionOperation(operation)
        ) {
            return Promise.reject(
                ozonPromotionError(
                    'OZON_AUTHORIZATION_REJECTED',
                    'Only a matching signed Ozon promotion operation may use this authorization.'
                )
            );
        }
        if (
            !streamHandlers ||
            typeof streamHandlers.onStart !== 'function' ||
            typeof streamHandlers.onChunk !== 'function' ||
            typeof streamHandlers.onEnd !== 'function'
        ) {
            return Promise.reject(
                ozonPromotionError(
                    'ARTIFACT_REJECTED',
                    'Ozon artifact storage is not ready to receive the report stream.'
                )
            );
        }
        if (!isValidOzonPromotionTimeout(timeout)) {
            return Promise.reject(
                ozonPromotionError(
                    'OPERATION_DEADLINE_EXCEEDED',
                    'The Ozon promotion operation timeout must be between one second and eight minutes.'
                )
            );
        }
        const deadlineRemaining = operation.deadlineAt - Date.now();
        if (deadlineRemaining <= 0 || deadlineRemaining > OZON_PROMOTION_OPERATION_MAX_MS) {
            return Promise.reject(
                ozonPromotionError(
                    'OPERATION_DEADLINE_EXCEEDED',
                    deadlineRemaining <= 0
                        ? 'The Ozon promotion operation deadline has expired.'
                        : 'The Ozon promotion operation deadline exceeds the eight-minute lifecycle limit.'
                )
            );
        }
        const boundedTimeout = Math.min(timeout, deadlineRemaining, OZON_PROMOTION_OPERATION_MAX_MS);
        if (this.ozonReportReservation !== null) {
            return Promise.reject(
                ozonPromotionError(
                    'OZON_AUTHORIZATION_REJECTED',
                    'Another Ozon promotion operation is already pending.'
                )
            );
        }
        if (typeof this.routeOzonPromotionReport !== 'function') {
            return Promise.reject(
                ozonPromotionError(
                    'OZON_ROUTE_NOT_READY',
                    'The Ozon promotion operation route is not available.'
                )
            );
        }
        const operationPromise = new Promise((resolve, reject) => {
            const requestId = this.createRequestId();
            const currentPending = {
                resolve,
                reject,
                timer: undefined,
                state: 'awaiting-stream',
                nextChunkIndex: 0,
                receivedStreamBytes: 0,
                declaredStreamBytes: null,
                maxStreamBytes: ARTIFACT_MAX_FILE_BYTES,
                streamHandlers,
                handlerChain: Promise.resolve(),
                cancelled: false,
                abortController: new AbortController(),
                authorizationScopeId,
            };
            currentPending.timer = setTimeout(
                () =>
                    this.#cancelOzonPromotionOperation(
                        requestId,
                        currentPending,
                        ozonPromotionError(
                            'OPERATION_DEADLINE_EXCEEDED',
                            'The Ozon promotion operation deadline expired.'
                        )
                    ),
                Math.min(
                    deadlineRemaining,
                    OZON_PROMOTION_OPERATION_MAX_MS,
                    timeout + REQUEST_TIMEOUT_GRACE_MS * Math.max(1, this.routeHopCount())
                )
            );
            currentPending.timer.unref?.();
            this.pendingOzonPromotionOperations.set(requestId, currentPending);
            this.ozonReportReservation = { kind: 'promotion-single', pending: currentPending };
            try {
                this.routeOzonPromotionReport({
                    requestId,
                    authorizationId,
                    authorizationScopeId,
                    dateFrom: operation.dateFrom,
                    dateTo: operation.dateTo,
                    deadlineAt: operation.deadlineAt,
                    timeout: boundedTimeout,
                });
            } catch (error) {
                this.#settleOzonPromotionOperation(
                    requestId,
                    currentPending,
                    (reason) => reject(reason),
                    normalizeOzonPromotionError(
                        error,
                        'OZON_ROUTE_NOT_READY',
                        'The Ozon promotion operation route is not available.'
                    ),
                    { abort: true }
                );
            }
        });
        return operationPromise;
    }

    requestOzonReportPackage(packageRequest, handlers, authorizationId, authorizationScopeId) {
        const rejectBeforeStart = (error) => Promise.resolve(handlers?.onNotStarted?.(error)).then(() => { throw error; });
        const authorizationScope = this.activeAuthorizationScopes.get(authorizationScopeId);
        if (!authorizationScope || !this.#authorizationScopeIsActive(authorizationScopeId, authorizationScope)) {
            return rejectBeforeStart(
                ozonPromotionError('OZON_AUTHORIZATION_REJECTED', 'The signed Ozon report package authorization is no longer active.')
            );
        }
        const family = packageRequest?.family;
        const items = packageRequest?.items;
        const expectedJobType =
            family === 'promotion'
                ? 'ozon_seller_promotion_reports'
                : family === 'analytics'
                  ? 'ozon_seller_analytics_report'
                  : undefined;
        const signedItems =
            family === 'promotion' ? authorizationScope.job?.periods : family === 'analytics' ? authorizationScope.job?.reports : undefined;
        if (
            authorizationScope.authorizationId !== authorizationId ||
            authorizationScope.jobType !== expectedJobType ||
            !Array.isArray(items) ||
            items.length < 1 ||
            items.length > MAX_OZON_REPORT_PACKAGE_ITEMS ||
            !exactOzonPackageItemsEqual(family, items, signedItems) ||
            !Number.isSafeInteger(packageRequest?.deadlineAt) ||
            packageRequest.deadlineAt <= 0
        ) {
            return rejectBeforeStart(
                ozonPromotionError(
                    'OZON_AUTHORIZATION_REJECTED',
                    'Only an exact matching signed Ozon report package may use this authorization.'
                )
            );
        }
        if (
            !handlers ||
            typeof handlers.onItemStart !== 'function' ||
            typeof handlers.onItemChunk !== 'function' ||
            typeof handlers.onItemEnd !== 'function' ||
            typeof handlers.onItemResult !== 'function'
        ) {
            return rejectBeforeStart(
                ozonPromotionError('ARTIFACT_REJECTED', 'Ozon package artifact handlers are not ready to receive report streams.')
            );
        }
        const authorizationExpiresAtMs = authorizationScope.expiresAtMs;
        const effectiveDeadline = Math.min(packageRequest.deadlineAt, authorizationExpiresAtMs);
        const remaining = effectiveDeadline - Date.now();
        if (remaining <= 0 || (remaining < OZON_PROMOTION_OPERATION_MAX_MS && authorizationExpiresAtMs <= packageRequest.deadlineAt)) {
            const tokenWins = authorizationExpiresAtMs <= packageRequest.deadlineAt;
            return rejectBeforeStart(
                ozonPromotionError(
                    tokenWins ? 'OZON_AUTHORIZATION_REJECTED' : 'OPERATION_DEADLINE_EXCEEDED',
                    tokenWins
                        ? 'The signed Ozon report package authorization expires before one item can finish.'
                        : 'The Ozon report package deadline has already expired.'
                )
            );
        }
        if (this.ozonReportReservation !== null) {
            return rejectBeforeStart(
                ozonPromotionError('OZON_ADMISSION_CAPACITY_EXHAUSTED', 'Another Ozon report operation is already pending.')
            );
        }
        if (typeof this.routeOzonPromotionReport !== 'function') {
            return rejectBeforeStart(ozonPromotionError('OZON_ROUTE_NOT_READY', 'The Ozon report package route is not available.'));
        }
        return new Promise((resolve, reject) => {
            const requestId = this.createRequestId();
            const pending = {
                resolve,
                reject,
                family,
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
                timer: undefined,
            };
            pending.timer = setTimeout(() => {
                const tokenWins = authorizationExpiresAtMs <= packageRequest.deadlineAt;
                this.#cancelOzonReportPackage(
                    requestId,
                    pending,
                    ozonPromotionError(
                        tokenWins ? 'OZON_AUTHORIZATION_REJECTED' : 'OPERATION_DEADLINE_EXCEEDED',
                        tokenWins
                            ? 'The signed Ozon report package authorization expired.'
                            : 'The Ozon report package deadline expired.'
                    )
                );
            }, Math.max(1, effectiveDeadline - Date.now()));
            pending.timer.unref?.();
            this.pendingOzonReportPackages.set(requestId, pending);
            this.ozonReportReservation = { kind: `${family}-package`, pending };
            try {
                this.routeOzonPromotionReport({
                    requestId,
                    authorizationId,
                    authorizationScopeId,
                    family,
                    items,
                    deadlineAt: packageRequest.deadlineAt,
                    timeout: OZON_PROMOTION_OPERATION_MAX_MS,
                });
            } catch (error) {
                const cancel = () => this.#cancelOzonReportPackage(
                    requestId,
                    pending,
                    normalizeOzonPromotionError(error, 'OZON_ROUTE_NOT_READY', 'The Ozon report package route is not available.')
                );
                if (isOzonPackageNotStarted(error)) {
                    Promise.resolve().then(() => handlers.onNotStarted?.(error)).then(cancel, cancel);
                } else cancel();
            }
        });
    }

    // A seller export drives many reports through one scope, so it gets the longer ceiling its executor is
    // deadlined against rather than the single-round-trip default. Either way the signed token wins: a
    // scope must never outlive the authorization it was granted under.
    #authorizationScopeLifetime(authorization) {
        const ceiling = this.#authorizationScopeCeiling(authorization);
        if (typeof authorization?.expiresAt !== 'number' || !Number.isFinite(authorization.expiresAt)) return ceiling;
        return Math.max(0, Math.min(ceiling, authorization.expiresAt * 1000 - Date.now()));
    }

    #authorizationScopeCeiling(authorization) {
        return ['seller_reviews', 'ozon_seller_promotion_reports', 'ozon_seller_analytics_report'].includes(authorization?.jobType)
            ? this.sellerAuthorizationScopeMaxMs
            : this.authorizationScopeMaxMs;
    }

    #authorizationScopeIsActive(requestId, authorizationScope) {
        if (this.activeAuthorizationScopes.get(requestId) !== authorizationScope) return false;
        if (typeof authorizationScope.isRouteActive !== 'function') return true;
        let routeActive = false;
        try {
            routeActive = authorizationScope.isRouteActive() === true;
        } catch {
            routeActive = false;
        }
        if (routeActive) return true;
        this.#releaseAuthorizationScopeInBackground(requestId, true);
        return false;
    }

    // createTimeoutError — фабрика типизированной ошибки: голый Error здесь означал,
    // что таймаут доезжал до агента как UNEXPECTED_LOCAL_ERROR с retryable: false, то
    // есть «повторять бесполезно» ровно там, где повтор будит уснувший service worker.
    #createPending(collection, timeout, createTimeoutError, route, transform = (value, _requestId, _routeResult) => value) {
        return new Promise((resolve, reject) => {
            const requestId = this.createRequestId();
            let routeCompleted = false;
            /** @type {{ type: 'resolve', value: unknown } | { type: 'reject', error: unknown } | undefined} */
            let bufferedSettlement;
            const readBufferedSettlement = () => bufferedSettlement;
            const timer = setTimeout(() => {
                collection.delete(requestId);
                reject(createTimeoutError());
            }, timeout);
            // Unref'd like the authorization-scope expiry above: the deadline must still fire while the process
            // is serving, but it must not be what keeps the event loop alive after shutdown has closed every
            // route. Without this a single in-flight request holds the process open for its whole timeout and
            // pushes shutdown onto the hard-exit backstop.
            timer.unref?.();
            const resolvePending = (value) => {
                try {
                    resolve(transform(value, requestId, pending.routeResult));
                } catch (error) {
                    reject(error);
                }
            };
            const pending = {
                resolve: (value) => {
                    if (!routeCompleted) {
                        bufferedSettlement = { type: 'resolve', value };
                        return;
                    }
                    resolvePending(value);
                },
                reject: (error) => {
                    if (!routeCompleted) {
                        bufferedSettlement = { type: 'reject', error };
                        return;
                    }
                    reject(error);
                },
                timer,
                routeResult: undefined,
            };
            collection.set(requestId, pending);
            try {
                pending.routeResult = route(requestId);
                routeCompleted = true;
                const settlement = readBufferedSettlement();
                if (settlement && settlement.type === 'resolve') resolvePending(settlement.value);
                else if (settlement && settlement.type === 'reject') reject(settlement.error);
            } catch (error) {
                routeCompleted = true;
                clearTimeout(timer);
                collection.delete(requestId);
                reject(error);
            }
        });
    }

    async #releaseAuthorizationScope(requestId, notifyRoute) {
        const authorizationScope = this.activeAuthorizationScopes.get(requestId);
        if (!authorizationScope) return false;
        this.activeAuthorizationScopes.delete(requestId);
        clearTimeout(authorizationScope.expiryTimer);
        // Release must remove buyer correlations synchronously, before any asynchronous route cleanup.
        // Other scopes remain active; their requests must not inherit this operation's terminal cause.
        for (const [fetchRequestId, pending] of this.pendingRequests) {
            if (pending.authorizationScopeId === requestId) this.rejectFetch(fetchRequestId, this.#reauthorizationRequired());
        }
        for (const [sellerRequestId, pending] of this.pendingSellerOperations) {
            if (pending.authorizationScopeId !== requestId) continue;
            this.#cancelSellerOperation(sellerRequestId, pending, this.#reauthorizationRequired());
        }
        for (const [ozonRequestId, pending] of this.pendingOzonPromotionOperations) {
            if (pending.authorizationScopeId !== requestId) continue;
            this.#cancelOzonPromotionOperation(
                ozonRequestId,
                pending,
                ozonPromotionError(
                    'OPERATION_CANCELLED',
                    'The Ozon promotion operation was cancelled with its authorization.'
                )
            );
        }
        for (const [ozonRequestId, pending] of this.pendingOzonReportPackages) {
            if (pending.authorizationScopeId !== requestId) continue;
            this.#cancelOzonReportPackage(
                ozonRequestId,
                pending,
                authorizationScope.expired
                    ? ozonPromotionError(
                          'OZON_AUTHORIZATION_REJECTED',
                          'The signed Ozon report package authorization expired.'
                      )
                    : ozonPromotionError('OPERATION_CANCELLED', 'The Ozon report package was cancelled with its authorization.')
            );
        }
        if (notifyRoute && typeof authorizationScope.releaseRoute === 'function') {
            await authorizationScope.releaseRoute(authorizationScope.authorizationId);
        }
        return true;
    }

    #releaseAuthorizationScopeInBackground(requestId, notifyRoute) {
        void this.#releaseAuthorizationScope(requestId, notifyRoute).catch((error) => {
            this.#reportUnsettled('authorization-release-error', requestId, error?.code);
        });
    }

    #reauthorizationRequired() {
        return new ToolExecutionError(
            'BROWSER_JOB_REAUTHORIZATION_REQUIRED',
            'Browser job authorization must be acquired again after the bridge connection changed.',
            'authorization',
            true
        );
    }

    #take(collection, requestId) {
        const pending = collection.get(requestId);
        if (!pending) return null;
        collection.delete(requestId);
        clearTimeout(pending.timer);
        return pending;
    }

    #settleSellerOperation(requestId, pending, settle, value) {
        if (this.pendingSellerOperations.get(requestId) !== pending) return false;
        this.pendingSellerOperations.delete(requestId);
        pending.cancelled = true;
        clearTimeout(pending.timer);
        settle(value);
        return true;
    }

    #cancelSellerOperation(requestId, pending, error) {
        if (this.pendingSellerOperations.get(requestId) !== pending) return false;
        this.pendingSellerOperations.delete(requestId);
        pending.cancelled = true;
        clearTimeout(pending.timer);
        // Correlation owns settlement, not disk I/O. The executor cancels its private writer
        // as soon as this rejection arrives; queued/late handlers remain fenced below.
        pending.reject(error);
        return true;
    }

    #enqueueSellerHandler(requestId, pending, handler, args, onComplete) {
        const handlerPromise = pending.handlerChain.then(async () => {
            if (pending.cancelled || this.pendingSellerOperations.get(requestId) !== pending) return false;
            await handler(...args);
            return !pending.cancelled && this.pendingSellerOperations.get(requestId) === pending;
        });
        pending.handlerChain = handlerPromise;
        return handlerPromise.then(
            (handled) => {
                if (handled) onComplete?.();
                return handled;
            },
            (error) => {
                this.#settleSellerOperation(requestId, pending, (reason) => pending.reject(reason), error);
                return false;
            }
        );
    }

    #rejectInvalidSellerStream(requestId, pending, reason = 'Seller stream frames arrived out of order.') {
        this.#cancelSellerOperation(
            requestId,
            pending,
            new ToolExecutionError('SELLER_STREAM_INVALID', reason, 'extension', false)
        );
        return false;
    }

    #takeOzonPromotionOperation(requestId, pending) {
        if (this.pendingOzonPromotionOperations.get(requestId) !== pending) return false;
        this.pendingOzonPromotionOperations.delete(requestId);
        pending.cancelled = true;
        clearTimeout(pending.timer);
        if (this.ozonReportReservation?.pending === pending) this.ozonReportReservation = null;
        return true;
    }

    #signalOzonCancellation(requestId, pending, error) {
        pending.abortController.abort(error);
        // A relay handler may itself be waiting for downstream persistence acknowledgement. Break that wait
        // synchronously; private handler/finalizer cleanup is observed separately and never owns broker capacity.
        if (typeof pending.streamHandlers.onCancel === 'function') {
            try {
                pending.streamHandlers.onCancel(error);
            } catch (cancelSignalError) {
                this.#reportUnsettled('ozon-cancel-signal', requestId, cancelSignalError?.code);
            }
        }
    }

    #settleOzonPromotionOperation(requestId, pending, settle, value, { abort = false } = {}) {
        if (!this.#takeOzonPromotionOperation(requestId, pending)) return false;
        if (abort) this.#signalOzonCancellation(requestId, pending, value);
        settle(value);
        return true;
    }

    #cancelOzonPromotionOperation(requestId, pending, error) {
        if (!this.#takeOzonPromotionOperation(requestId, pending)) return false;
        this.#signalOzonCancellation(requestId, pending, error);
        pending.reject(error);
        return true;
    }

    #enqueueOzonHandler(requestId, pending, handler, args, onComplete) {
        const handlerPromise = pending.handlerChain.then(async () => {
            if (pending.cancelled || this.pendingOzonPromotionOperations.get(requestId) !== pending) return false;
            await handler(...args, pending.abortController.signal);
            return !pending.cancelled && this.pendingOzonPromotionOperations.get(requestId) === pending;
        });
        pending.handlerChain = handlerPromise;
        return handlerPromise.then(
            (handled) => {
                if (handled) onComplete?.();
                return handled;
            },
            (error) => {
                const settled = this.#settleOzonPromotionOperation(
                    requestId,
                    pending,
                    (reason) => pending.reject(reason),
                    normalizeOzonPromotionError(
                        error,
                        'ARTIFACT_REJECTED',
                        'The Ozon promotion artifact could not be stored safely.'
                    ),
                    { abort: true }
                );
                if (!settled) this.#reportUnsettled('ozon-handler-error', requestId, error?.code);
                return false;
            }
        );
    }

    #rejectInvalidOzonStream(requestId, pending) {
        this.#cancelOzonPromotionOperation(
            requestId,
            pending,
            ozonPromotionError(
                'ARTIFACT_REJECTED',
                'Ozon promotion stream frames arrived out of order.'
            )
        );
        return false;
    }

    #rejectAllOzonPromotionOperations(errorOrMessage) {
        for (const [requestId, pending] of this.pendingOzonPromotionOperations) {
            this.#cancelOzonPromotionOperation(
                requestId,
                pending,
                normalizeOzonPromotionError(
                    errorOrMessage,
                    'OPERATION_CANCELLED',
                    'The Ozon promotion operation was cancelled because its extension route closed.'
                )
            );
        }
    }

    #matchesOzonPackageFrame(pending, family, itemIndex) {
        return pending.family === family && Number.isSafeInteger(itemIndex) && itemIndex === pending.nextItemIndex;
    }

    #takeOzonReportPackage(requestId, pending) {
        if (this.pendingOzonReportPackages.get(requestId) !== pending) return false;
        this.pendingOzonReportPackages.delete(requestId);
        pending.cancelled = true;
        clearTimeout(pending.timer);
        if (this.ozonReportReservation?.pending === pending) this.ozonReportReservation = null;
        return true;
    }

    #signalOzonPackageCancellation(requestId, pending, error) {
        pending.abortController.abort(error);
        try {
            pending.handlers.onCancel?.(error);
        } catch (cancelError) {
            this.#reportUnsettled('ozon-package-cancel-signal', requestId, cancelError?.code);
        }
    }

    #settleOzonReportPackage(requestId, pending, value) {
        if (!this.#takeOzonReportPackage(requestId, pending)) return false;
        pending.resolve(value);
        return true;
    }

    #cancelOzonReportPackage(requestId, pending, error) {
        if (!this.#takeOzonReportPackage(requestId, pending)) return false;
        this.#signalOzonPackageCancellation(requestId, pending, error);
        pending.reject(error);
        return true;
    }

    #enqueueOzonPackageHandler(requestId, pending, handler, args, onComplete, includeSignal = false) {
        const generation = pending.handlerGeneration;
        const isCurrent = () => !pending.cancelled && this.pendingOzonReportPackages.get(requestId) === pending &&
            pending.handlerGeneration === generation;
        const privateIo = [pending.handlers.onItemStart, pending.handlers.onItemChunk, pending.handlers.onItemEnd].includes(handler);
        const signal = pending.abortController.signal;
        if (privateIo) pending.privateHandlerCount += 1;
        const handlerPromise = pending.handlerChain.then(async () => {
            if (!isCurrent()) return false;
            try {
                await handler(...args, ...(includeSignal ? [signal] : []));
                return isCurrent();
            } finally {
                if (privateIo && pending.handlerGeneration === generation) pending.privateHandlerCount -= 1;
            }
        });
        pending.handlerChain = handlerPromise;
        return handlerPromise.then(
            (handled) => {
                if (handled) onComplete?.();
                return handled;
            },
            (error) => {
                // A detached old writer may finish/fail after the next item has begun.
                // It retains cleanup ownership but cannot cancel its successor's result.
                if (!isCurrent()) return false;
                const normalized = normalizeOzonPromotionError(
                    error,
                    'ARTIFACT_REJECTED',
                    'The Ozon report package artifact could not be stored safely.'
                );
                if (!this.#cancelOzonReportPackage(requestId, pending, normalized)) {
                    this.#reportUnsettled('ozon-package-handler-error', requestId, error?.code);
                }
                return false;
            }
        );
    }

    #rejectInvalidOzonPackageStream(requestId, pending) {
        this.#cancelOzonReportPackage(
            requestId,
            pending,
            ozonPromotionError('ARTIFACT_REJECTED', 'Ozon report package frames arrived out of order or for the wrong family.')
        );
        return false;
    }

    #rejectAllOzonReportPackages(errorOrMessage) {
        for (const [requestId, pending] of this.pendingOzonReportPackages) {
            this.#cancelOzonReportPackage(
                requestId,
                pending,
                normalizeOzonPromotionError(
                    errorOrMessage,
                    'OPERATION_CANCELLED',
                    'The Ozon report package was cancelled because its extension route closed.'
                )
            );
        }
    }

    #rejectAllSellerOperations(errorOrMessage) {
        for (const [requestId, pending] of this.pendingSellerOperations) {
            this.#cancelSellerOperation(requestId, pending, errorOrMessage instanceof Error ? errorOrMessage : new Error(errorOrMessage));
        }
    }

    #rejectAll(collection, errorOrMessage) {
        for (const [requestId, pending] of collection) {
            clearTimeout(pending.timer);
            pending.reject(errorOrMessage instanceof Error ? errorOrMessage : new Error(errorOrMessage));
            collection.delete(requestId);
        }
    }
}
