import { randomUUID } from 'node:crypto';

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
    error instanceof ToolExecutionError &&
    OZON_PROMOTION_TERMINAL_CODE_STAGES[error.code] === error.stage &&
    error.retryable === false
        ? error
        : ozonPromotionError(fallbackCode, fallbackMessage);

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
    ozonPromotionReservation = null;
    activeAuthorizationScopes = new Map();
    inFlightFetches = new Map();

    get activeRequestCount() {
        return (
            this.pendingRequests.size +
            this.pendingAuthorizations.size +
            this.pendingAuthorizationReleases.size +
            this.pendingSellerOperations.size +
            (this.ozonPromotionReservation === null ? 0 : 1) +
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

    rejectPendingRequests(message) {
        this.#rejectAll(this.pendingRequests, message);
        this.#rejectAll(this.pendingAuthorizationReleases, message);
        this.#rejectAllSellerOperations(message);
        this.#rejectAllOzonPromotionOperations(message);
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
                (requestId) => this.routeWbFetch({ requestId, url, timeout, authorizationId, authorizationScopeId })
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
                const authorizationScope = {
                    authorizationId: authorization?.authorizationId,
                    jobType: authorization?.jobType,
                    isRouteActive: routeBinding.isActive,
                    releaseRoute: routeBinding.release,
                    expiryTimer: setTimeout(
                        () => this.#releaseAuthorizationScopeInBackground(requestId, true),
                        this.#authorizationScopeLifetime(authorization)
                    ),
                };
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
        if (this.ozonPromotionReservation !== null) {
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
            this.ozonPromotionReservation = currentPending;
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

    // A seller export drives many reports through one scope, so it gets the longer ceiling its executor is
    // deadlined against rather than the single-round-trip default. Either way the signed token wins: a
    // scope must never outlive the authorization it was granted under.
    #authorizationScopeLifetime(authorization) {
        const ceiling =
            authorization?.jobType === 'seller_reviews' ? this.sellerAuthorizationScopeMaxMs : this.authorizationScopeMaxMs;
        if (typeof authorization?.expiresAt !== 'number' || !Number.isFinite(authorization.expiresAt)) return ceiling;
        return Math.max(0, Math.min(ceiling, authorization.expiresAt * 1000 - Date.now()));
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
        if (pending.state === 'ending') {
            pending.reject(error);
            return true;
        }
        void pending.handlerChain.then(
            () => pending.reject(error),
            () => pending.reject(error)
        );
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
        if (this.ozonPromotionReservation === pending) this.ozonPromotionReservation = null;
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
