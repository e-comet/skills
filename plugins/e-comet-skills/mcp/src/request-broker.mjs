import { randomUUID } from 'node:crypto';

import {
    AUTHORIZATION_SCOPE_MAX_MS,
    MAX_ACTIVE_AUTHORIZATION_SCOPES,
    REQUEST_TIMEOUT_GRACE_MS,
    REQUEST_TIMEOUT_MS,
} from './config.mjs';
import { ToolExecutionError } from './tool-errors.mjs';
import { isAllowedWbUrl } from './wb-domain.mjs';

export class RequestBroker {
    constructor({
        routeWbFetch,
        routeAuthorization,
        createRequestId = randomUUID,
        defaultTimeout = REQUEST_TIMEOUT_MS,
        // Сколько посредников стоит между нами и расширением на текущем маршруте.
        // Каждый из них ждёт на один запас дольше нижележащего, поэтому наш дедлайн
        // должен быть позже всех. Бюджет самого запроса при этом не меняется.
        routeHopCount = () => 1,
        authorizationScopeMaxMs = AUTHORIZATION_SCOPE_MAX_MS,
        maxActiveAuthorizationScopes = MAX_ACTIVE_AUTHORIZATION_SCOPES,
        onUnsettled,
    }) {
        this.routeWbFetch = routeWbFetch;
        this.routeAuthorization = routeAuthorization;
        this.createRequestId = createRequestId;
        this.defaultTimeout = defaultTimeout;
        this.routeHopCount = routeHopCount;
        this.onUnsettled = onUnsettled;
        this.authorizationScopeMaxMs = authorizationScopeMaxMs;
        this.maxActiveAuthorizationScopes = maxActiveAuthorizationScopes;
    }

    pendingRequests = new Map();
    pendingAuthorizations = new Map();
    activeAuthorizationScopes = new Map();
    inFlightFetches = new Map();

    get activeRequestCount() {
        return this.pendingRequests.size + this.pendingAuthorizations.size + this.activeAuthorizationScopes.size;
    }

    hasPendingAuthorization(requestId) {
        return this.pendingAuthorizations.has(requestId);
    }

    rejectPendingRequests(message) {
        this.#rejectAll(this.pendingRequests, message);
    }

    rejectPendingAuthorizations(message) {
        this.#rejectAll(this.pendingAuthorizations, message);
        for (const requestId of this.activeAuthorizationScopes.keys()) {
            this.#releaseAuthorizationScope(requestId, false);
        }
    }

    invalidateAuthorizationWork() {
        const error = this.#reauthorizationRequired();
        this.#rejectAll(this.pendingRequests, error);
        this.#rejectAll(this.pendingAuthorizations, error);
        for (const requestId of this.activeAuthorizationScopes.keys()) {
            this.#releaseAuthorizationScope(requestId, false);
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
                    expiryTimer: setTimeout(() => this.#releaseAuthorizationScope(requestId, true), this.authorizationScopeMaxMs),
                };
                authorizationScope.expiryTimer.unref?.();
                this.activeAuthorizationScopes.set(requestId, authorizationScope);
                return {
                    authorization,
                    requestWbFetch: (url, fetchTimeout = this.defaultTimeout) =>
                        this.requestWbFetch(url, fetchTimeout, authorization?.authorizationId, requestId),
                    isActive: () => this.#authorizationScopeIsActive(requestId, authorizationScope),
                    release: () => this.#releaseAuthorizationScope(requestId, true),
                };
            }
        );
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
        this.#releaseAuthorizationScope(requestId, true);
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

    #releaseAuthorizationScope(requestId, notifyRoute) {
        const authorizationScope = this.activeAuthorizationScopes.get(requestId);
        if (!authorizationScope) return false;
        this.activeAuthorizationScopes.delete(requestId);
        clearTimeout(authorizationScope.expiryTimer);
        if (notifyRoute && typeof authorizationScope.releaseRoute === 'function') {
            authorizationScope.releaseRoute();
        }
        return true;
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

    #rejectAll(collection, errorOrMessage) {
        for (const [requestId, pending] of collection) {
            clearTimeout(pending.timer);
            pending.reject(errorOrMessage instanceof Error ? errorOrMessage : new Error(errorOrMessage));
            collection.delete(requestId);
        }
    }
}
