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
import { isValidSellerOperation } from './extension-protocol.mjs';
import { SELLER_OPERATION_STAGES } from './extension-vocabulary.mjs';
import { ToolExecutionError } from './tool-errors.mjs';
import { isAllowedWbUrl, validTimeout } from './wb-domain.mjs';

export class RequestBroker {
    constructor({
        routeWbFetch,
        routeSellerOperation,
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
    activeAuthorizationScopes = new Map();
    inFlightFetches = new Map();

    get activeRequestCount() {
        return (
            this.pendingRequests.size +
            this.pendingAuthorizations.size +
            this.pendingAuthorizationReleases.size +
            this.pendingSellerOperations.size +
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

    rejectPendingRequests(message) {
        this.#rejectAll(this.pendingRequests, message);
        this.#rejectAll(this.pendingAuthorizationReleases, message);
        this.#rejectAllSellerOperations(message);
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
