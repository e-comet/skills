// The correlation broker (refactor spec §7.4): one registry of open requests by id, their deadlines and cancellation,
// the authorization scopes and their leases with the global cap, and their release on disconnect. It knows only session
// messages: a context's adapter opens a request with a frame handler and receives every frame that carries the request's
// id through `dispatch`; its acknowledgements go out under the same id. `send` hands a request's frame to the route.
import { randomUUID } from 'node:crypto';
import { AUTHORIZATION_RELEASE_TIMEOUT_MS, AUTHORIZATION_SCOPE_MAX_MS, MAX_ACTIVE_AUTHORIZATION_SCOPES, REQUEST_TIMEOUT_GRACE_MS, } from '../limits.mjs';
import { ToolExecutionError } from '../../shared/coded-error.mjs';
import { REQUEST_TIMEOUT_MS } from '../../shared/timeouts.mjs';
import { isRecord } from '../../shared/values.mjs';
import { MESSAGE_TYPES } from '../../transport/extension/wire.mjs';
export const CORRELATION_LIMITS = {
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    graceMs: REQUEST_TIMEOUT_GRACE_MS,
    releaseTimeoutMs: AUTHORIZATION_RELEASE_TIMEOUT_MS,
    scopeMaxMs: AUTHORIZATION_SCOPE_MAX_MS,
    maxActiveScopes: MAX_ACTIVE_AUTHORIZATION_SCOPES,
    scopeCeilings: new Map(),
};
// Only the newest ended scopes are kept, so a later call through a dead lease still names why it ended.
const ENDED_SCOPES_KEPT = 64;
const asError = (errorOrMessage) => (errorOrMessage instanceof Error ? errorOrMessage : new Error(String(errorOrMessage)));
const isCallable = (value) => typeof value === 'function';
export function createCorrelationBroker({ send, limits = CORRELATION_LIMITS, now = () => Date.now(), createRequestId = randomUUID, onUnsettled, }) {
    const requests = new Map();
    const scopes = new Map();
    const endedScopes = new Map();
    // Ответ на запрос, который уже завершился (обычно по таймауту). Раньше терялся
    // молча — вместе с типизированным кодом, который в нём приехал.
    const reportUnsettled = (kind, requestId, detail) => {
        onUnsettled?.({ kind, requestId, detail });
        return false;
    };
    // Removes an open request and its deadline; false when it is no longer open.
    const close = (id) => {
        const entry = requests.get(id);
        if (!entry)
            return false;
        requests.delete(id);
        clearTimeout(entry.timer);
        return true;
    };
    function open(request) {
        const id = createRequestId();
        let control;
        const result = new Promise((resolve, reject) => {
            let sent = false;
            let buffered;
            const settle = (value) => {
                try {
                    resolve(request.transform ? request.transform(value, control) : value);
                }
                catch (error) {
                    reject(error);
                }
            };
            control = {
                id,
                state: undefined,
                sendResult: undefined,
                resolve: (value) => {
                    if (!sent)
                        buffered = { type: 'resolve', value };
                    else
                        settle(value);
                },
                reject: (error) => {
                    if (!sent)
                        buffered = { type: 'reject', error };
                    else
                        reject(error);
                },
                send: (frame) => send({ id, ...frame }),
                close: () => close(id),
                isOpen: () => requests.get(id)?.control === control,
            };
            control.state = request.createState?.(control);
            const entry = {
                type: request.type,
                state: control.state,
                scopeId: request.authorization?.scopeId,
                control,
                onFrame: request.onFrame,
                onScopeEnded: request.onScopeEnded,
                onAbort: request.onAbort,
                timer: undefined,
            };
            if (request.timeoutMs !== undefined) {
                // A deadline ends the request as a cancellation does, through its own abort handler, so a requester that
                // holds a reservation releases it on every path.
                entry.timer = setTimeout(() => {
                    abort(id, request.timeoutError?.() ?? new Error('The request timed out.'));
                }, request.timeoutMs);
                // Unref'd like the scope expiry below: the deadline must still fire while the process is serving, but it must
                // not be what keeps the event loop alive after shutdown has closed every route.
                if (request.unrefTimer !== false)
                    entry.timer.unref?.();
            }
            requests.set(id, entry);
            try {
                const frame = { id, type: request.type, payload: request.payload };
                control.sendResult = request.via ? request.via(frame) : send(frame);
                sent = true;
                const settlement = buffered;
                if (settlement?.type === 'resolve')
                    settle(settlement.value);
                else if (settlement?.type === 'reject')
                    reject(settlement.error);
            }
            catch (error) {
                sent = true;
                if (request.onSendError)
                    request.onSendError(error, control);
                else {
                    close(id);
                    reject(error);
                }
            }
        });
        return { id, result, cancel: (reason) => abort(id, reason ?? new Error('The request was cancelled.')) };
    }
    // Ends one open request as a closed session or a cancellation does: the request's own handler, or a plain rejection.
    const abort = (id, errorOrMessage) => {
        const entry = requests.get(id);
        if (!entry)
            return false;
        if (entry.onAbort)
            entry.onAbort(errorOrMessage, entry.control);
        else {
            close(id);
            entry.control.reject(asError(errorOrMessage));
        }
        return true;
    };
    // Routes a frame by its id to the request that owns it. False when no open request does; otherwise what the
    // request's frame handler answered (true without one).
    const dispatch = (frame) => {
        const entry = typeof frame.id === 'string' ? requests.get(frame.id) : undefined;
        if (!entry)
            return false;
        return entry.onFrame ? entry.onFrame(frame, entry.control) : true;
    };
    // Every open request of each type, in the order given, ends as a closed session ends it.
    const rejectAll = (types, errorOrMessage) => {
        for (const type of types) {
            for (const [id, entry] of requests)
                if (entry.type === type)
                    abort(id, errorOrMessage);
        }
    };
    const has = (id, type) => {
        const entry = requests.get(id);
        return entry !== undefined && (type === undefined || entry.type === type);
    };
    const stateOf = (id) => requests.get(id)?.state;
    const count = (type) => {
        let total = 0;
        for (const entry of requests.values())
            if (entry.type === type)
                total += 1;
        return total;
    };
    // Why a scope ended (spec 7.2): it expired, its bridge connection changed, or its job released it.
    const reauthorizationRequired = (reason = 'route_changed', ceilingMs = limits.scopeMaxMs) => {
        const message = reason === 'expired'
            ? 'Browser job authorization must be acquired again: it expired, and one authorization lasts at most ' +
                `${Math.max(1, Math.round(ceilingMs / 60_000))} minutes. Split the remaining work into smaller jobs and request a new browser job for each.`
            : reason === 'released'
                ? 'Browser job authorization must be acquired again: this one was released when its job ended. Request a new browser job for further work.'
                : 'Browser job authorization must be acquired again after the bridge connection changed. Request a new browser job for the remaining work.';
        const error = new ToolExecutionError('BROWSER_JOB_REAUTHORIZATION_REQUIRED', message, 'authorization', true);
        error.details = { reason };
        return error;
    };
    const scopeEnded = (scopeId) => {
        const ended = scopeId === undefined ? undefined : endedScopes.get(scopeId);
        return reauthorizationRequired(ended?.reason, ended?.ceilingMs);
    };
    // A seller export drives many reports through one scope, so it gets the longer ceiling its executor is deadlined
    // against rather than the single-round-trip default. Either way the signed token wins: a scope must never outlive the
    // authorization it was granted under.
    // Parse boundary: the grant is the extension's answer, read field by field.
    const scopeCeiling = (grant) => limits.scopeCeilings.get(grant.jobType) ?? limits.scopeMaxMs;
    const scopeLifetime = (grant) => {
        const ceiling = scopeCeiling(grant);
        if (typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt))
            return ceiling;
        return Math.max(0, Math.min(ceiling, grant.expiresAt * 1000 - now()));
    };
    const releaseScope = async (scopeId, notifyRoute, reason = undefined) => {
        const scope = scopes.get(scopeId);
        if (!scope)
            return false;
        scopes.delete(scopeId);
        clearTimeout(scope.expiryTimer);
        // Later calls through the same lease name the same cause; only the newest few ended scopes are kept.
        endedScopes.set(scopeId, { reason: scope.expired ? 'expired' : (reason ?? 'route_changed'), ceilingMs: scope.ceilingMs });
        const oldest = endedScopes.keys().next();
        if (endedScopes.size > ENDED_SCOPES_KEPT && !oldest.done)
            endedScopes.delete(oldest.value);
        // Release must end the scope's requests synchronously, before any asynchronous route cleanup. Other scopes remain
        // active; their requests must not inherit this operation's terminal cause.
        for (const [id, entry] of requests) {
            if (entry.scopeId !== scopeId)
                continue;
            if (entry.onScopeEnded)
                entry.onScopeEnded(scopeEnded(scopeId), scope, entry.control);
            else {
                close(id);
                entry.control.reject(scopeEnded(scopeId));
            }
        }
        if (notifyRoute && scope.releaseRoute !== undefined)
            await scope.releaseRoute(scope.authorizationId);
        return true;
    };
    const releaseScopeInBackground = (scopeId, notifyRoute) => {
        releaseScope(scopeId, notifyRoute).catch((error) => {
            reportUnsettled('authorization-release-error', scopeId, isRecord(error) ? error.code : undefined);
        });
    };
    // Ends every scope; on a closed session nothing is sent for them.
    const releaseAllScopes = (notifyRoute) => {
        for (const scopeId of scopes.keys())
            releaseScopeInBackground(scopeId, notifyRoute);
    };
    const scopeIsActive = (scopeId, scope = scopes.get(scopeId)) => {
        if (!scope || scopes.get(scopeId) !== scope)
            return false;
        if (scope.isRouteActive === undefined)
            return true;
        let routeActive;
        try {
            routeActive = scope.isRouteActive() === true;
        }
        catch {
            routeActive = false;
        }
        if (routeActive)
            return true;
        releaseScopeInBackground(scopeId, true);
        return false;
    };
    const requestAuthorization = (token, timeoutMs = limits.requestTimeoutMs) => {
        if (count(MESSAGE_TYPES.browserJobAuthorize) + scopes.size >= limits.maxActiveScopes) {
            return Promise.reject(new ToolExecutionError('AUTHORIZATION_SCOPE_CAPACITY_EXCEEDED', 'Too many browser job authorization scopes are active.', 'local', true));
        }
        // The extension answers with the grant; the transform builds the lease from it.
        return open({
            type: MESSAGE_TYPES.browserJobAuthorize,
            payload: { token },
            timeoutMs: timeoutMs + limits.graceMs,
            timeoutError: () => new ToolExecutionError('BROWSER_JOB_AUTHORIZATION_TIMEOUT', `The extension did not authorize the browser job within ${timeoutMs} ms.`, 'extension', true),
            onFrame: (frame, control) => {
                if (!control.close())
                    return false;
                if (frame.type === 'error')
                    control.reject(asError(frame.payload));
                else
                    control.resolve(frame.payload);
                return true;
            },
            // Parse boundary: the grant and the route's binding are read field by field.
            transform: (authorization, control) => {
                const scopeId = control.id;
                const grant = isRecord(authorization) ? authorization : {};
                const sendResult = control.sendResult;
                const binding = isCallable(sendResult)
                    ? { release: sendResult }
                    : isRecord(sendResult)
                        ? sendResult
                        : {};
                const lifetimeMs = scopeLifetime(grant);
                const scope = {
                    authorizationId: grant.authorizationId,
                    jobType: grant.jobType,
                    job: grant.job,
                    expiresAtMs: now() + lifetimeMs,
                    ceilingMs: scopeCeiling(grant),
                    isRouteActive: isCallable(binding.isActive) ? binding.isActive : undefined,
                    releaseRoute: isCallable(binding.release) ? binding.release : undefined,
                    expiryTimer: undefined,
                };
                scope.expiryTimer = setTimeout(() => {
                    scope.expired = true;
                    releaseScopeInBackground(scopeId, true);
                }, lifetimeMs);
                scope.expiryTimer.unref?.();
                scopes.set(scopeId, scope);
                return {
                    id: grant.authorizationId,
                    scopeId,
                    jobType: grant.jobType,
                    signedJob: grant.job,
                    expiresAt: grant.expiresAt,
                    authorization,
                    isActive: () => scopeIsActive(scopeId, scope),
                    release: () => releaseScope(scopeId, true, 'released'),
                };
            },
        }).result;
    };
    const releaseAuthorization = (authorizationId, route, timeoutMs = limits.releaseTimeoutMs) => {
        if (typeof authorizationId !== 'string' || authorizationId.length === 0) {
            return Promise.reject(new TypeError('Authorization release requires an authorization ID.'));
        }
        return open({
            type: MESSAGE_TYPES.browserJobAuthorizationRelease,
            payload: { authorizationId },
            timeoutMs: timeoutMs + limits.graceMs,
            timeoutError: () => new ToolExecutionError('BROWSER_JOB_AUTHORIZATION_RELEASE_TIMEOUT', `The extension did not confirm browser job authorization release within ${timeoutMs} ms.`, 'extension', true),
            via: (frame) => route({ requestId: frame.id, authorizationId }),
            onFrame: (frame, control) => {
                if (!control.close())
                    return false;
                if (frame.type === 'error')
                    control.reject(asError(frame.payload));
                else
                    control.resolve(true);
                return true;
            },
        }).result;
    };
    const requestDiagnosticSnapshot = (timeoutMs = limits.requestTimeoutMs) => open({
        type: MESSAGE_TYPES.diagnosticSnapshot,
        payload: {},
        timeoutMs,
        unrefTimer: false,
        timeoutError: () => new ToolExecutionError('EXTENSION_DIAGNOSTIC_TIMEOUT', 'The extension diagnostic snapshot timed out.', 'extension', true),
        onFrame: (frame, control) => {
            if (!control.close())
                return false;
            if (frame.type === 'error')
                control.reject(asError(frame.payload));
            else
                control.resolve(frame.payload);
            return true;
        },
    }).result;
    return {
        requests,
        scopes,
        open,
        dispatch,
        has,
        stateOf,
        count,
        close,
        abort,
        rejectAll,
        reportUnsettled,
        requestAuthorization,
        releaseAuthorization,
        requestDiagnosticSnapshot,
        releaseScope,
        releaseAllScopes,
        scopeIsActive,
        scopeEnded,
        reauthorizationRequired,
        get activeCount() {
            return requests.size + scopes.size;
        },
    };
}
