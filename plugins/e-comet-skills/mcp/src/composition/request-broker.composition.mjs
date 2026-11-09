import { randomUUID } from 'node:crypto';
import { createCorrelationBroker } from '../bridge/broker/correlation.mjs';
import { AUTHORIZATION_RELEASE_TIMEOUT_MS, AUTHORIZATION_SCOPE_MAX_MS, MAX_ACTIVE_AUTHORIZATION_SCOPES, REQUEST_TIMEOUT_GRACE_MS, } from '../bridge/limits.mjs';
import { OZON_PACKAGE } from '../ozon-seller/out/extension/package.mjs';
import { OZON_PROMOTION } from '../ozon-seller/out/extension/promotion.mjs';
import { ToolExecutionError } from '../shared/coded-error.mjs';
import { REQUEST_TIMEOUT_MS } from '../shared/timeouts.mjs';
import { MESSAGE_TYPES, SELLER_SCOPE_DURATION_MS } from '../transport/extension/wire.mjs';
import { safeFeedbackProperty } from '../transport/failures/evidence.mjs';
import { SELLER_OPERATION } from '../wb-seller/out/extension/operations.mjs';
// The family half of the request broker: the WB fetch, the seller operations and the Ozon operations are wb-client's,
// wb-seller's and ozon-seller's adapters (out/extension), each a caller of the correlation broker's `open` with a frame
// handler (bridge/broker/correlation.mjs). The WB fetch and seller frames are routed here, the Ozon ones through the Ozon
// adapters' own route, and every family frame is delivered here by its id. A seller export and an Ozon package drive many
// reports through one scope, so they get the longer scope ceiling.
const LONG_SCOPE_JOB_TYPES = ['seller_reviews', 'ozon_seller_promotion_reports', 'ozon_seller_analytics_report', 'ozon_search_positions'];
// The request types of the families; the session requests use the wire's message types.
const WB_FETCH = MESSAGE_TYPES.wbFetch;
// What each family's route receives besides the request id.
const FAMILY_ROUTES = {
    [WB_FETCH]: 'routeWbFetch',
    [SELLER_OPERATION]: 'routeSellerOperation',
};
export class RequestBroker {
    constructor({ routeWbFetch, routeSellerOperation, routeAuthorization, routeDiagnosticSnapshot = undefined, createRequestId = randomUUID, defaultTimeout = REQUEST_TIMEOUT_MS, authorizationReleaseTimeout = AUTHORIZATION_RELEASE_TIMEOUT_MS, authorizationScopeMaxMs = AUTHORIZATION_SCOPE_MAX_MS, sellerAuthorizationScopeMaxMs = SELLER_SCOPE_DURATION_MS, maxActiveAuthorizationScopes = MAX_ACTIVE_AUTHORIZATION_SCOPES, onUnsettled, }) {
        this.routeWbFetch = routeWbFetch;
        this.routeSellerOperation = routeSellerOperation;
        this.routeAuthorization = routeAuthorization;
        this.routeDiagnosticSnapshot = routeDiagnosticSnapshot;
        this.createRequestId = createRequestId;
        this.defaultTimeout = defaultTimeout;
        this.authorizationReleaseTimeout = authorizationReleaseTimeout;
        this.onUnsettled = onUnsettled;
        this.correlation = createCorrelationBroker({
            send: (frame) => this.#route(frame),
            limits: {
                requestTimeoutMs: defaultTimeout,
                graceMs: REQUEST_TIMEOUT_GRACE_MS,
                releaseTimeoutMs: authorizationReleaseTimeout,
                scopeMaxMs: authorizationScopeMaxMs,
                maxActiveScopes: maxActiveAuthorizationScopes,
                scopeCeilings: new Map(LONG_SCOPE_JOB_TYPES.map((jobType) => [jobType, sellerAuthorizationScopeMaxMs])),
            },
            createRequestId: () => this.createRequestId(),
            onUnsettled: (event) => this.onUnsettled?.(event),
        });
    }
    // Each family's open requests as their own records, read by the family tests; the registry is the correlation broker's.
    #view(type) {
        return new Map([...this.correlation.requests].filter(([, entry]) => entry.type === type).map(([id, entry]) => [id, entry.state]));
    }
    get pendingRequests() {
        return this.#view(WB_FETCH);
    }
    get pendingAuthorizations() {
        return this.#view(MESSAGE_TYPES.browserJobAuthorize);
    }
    get pendingDiagnosticSnapshots() {
        return this.#view(MESSAGE_TYPES.diagnosticSnapshot);
    }
    get pendingAuthorizationReleases() {
        return this.#view(MESSAGE_TYPES.browserJobAuthorizationRelease);
    }
    get pendingSellerOperations() {
        return this.#view(SELLER_OPERATION);
    }
    get pendingOzonPromotionOperations() {
        return this.#view(OZON_PROMOTION);
    }
    get pendingOzonReportPackages() {
        return this.#view(OZON_PACKAGE);
    }
    get activeAuthorizationScopes() {
        return this.correlation.scopes;
    }
    // Every open request (an Ozon operation or package holds the one Ozon reservation) and every held scope.
    get activeRequestCount() {
        return this.correlation.activeCount;
    }
    // Hands a request's frame to today's route: the session requests' routes, or the family's.
    #route({ id, type, payload }) {
        if (type === MESSAGE_TYPES.browserJobAuthorize)
            return this.routeAuthorization({ requestId: id, token: 'token' in payload ? payload.token : undefined });
        // A diagnostic snapshot is requested only with its route.
        if (type === MESSAGE_TYPES.diagnosticSnapshot) {
            if (!this.routeDiagnosticSnapshot)
                throw new TypeError('Diagnostic snapshot routing is unavailable.');
            return this.routeDiagnosticSnapshot({ requestId: id });
        }
        // A family request has its route; a missing one throws as it always did.
        const routeName = FAMILY_ROUTES[type];
        const route = routeName === undefined ? undefined : this[routeName];
        if (!route)
            throw new TypeError(`No route for ${type} requests.`);
        return route({ requestId: id, ...payload });
    }
    // A frame for the request `id` of `type`; a request that is gone, or of another type, reports the answer as late.
    #deliver(type, kind, id, detail, frame) {
        if (!this.correlation.has(id, type))
            return this.correlation.reportUnsettled(kind, id, detail);
        return this.correlation.dispatch({ id, ...frame });
    }
    reportUnsettled(kind, requestId, detail) {
        return this.correlation.reportUnsettled(kind, requestId, detail);
    }
    hasPendingAuthorization(requestId) {
        return this.correlation.has(requestId, MESSAGE_TYPES.browserJobAuthorize);
    }
    hasPendingDiagnosticSnapshot(requestId) {
        return this.correlation.has(requestId, MESSAGE_TYPES.diagnosticSnapshot);
    }
    hasPendingAuthorizationRelease(requestId) {
        return this.correlation.has(requestId, MESSAGE_TYPES.browserJobAuthorizationRelease);
    }
    hasPendingSellerOperation(requestId) {
        return this.correlation.has(requestId, SELLER_OPERATION);
    }
    hasPendingOzonPromotionOperation(requestId) {
        return this.correlation.has(requestId, OZON_PROMOTION);
    }
    hasPendingOzonReportPackage(requestId) {
        return this.correlation.has(requestId, OZON_PACKAGE);
    }
    rejectPendingRequests(message) {
        this.correlation.rejectAll([
            WB_FETCH,
            MESSAGE_TYPES.diagnosticSnapshot,
            MESSAGE_TYPES.browserJobAuthorizationRelease,
            SELLER_OPERATION,
            OZON_PROMOTION,
            OZON_PACKAGE,
        ], message);
    }
    rejectPendingAuthorizations(message) {
        this.correlation.rejectAll([MESSAGE_TYPES.browserJobAuthorize], message);
        this.correlation.releaseAllScopes(false);
    }
    invalidateAuthorizationWork() {
        const error = this.correlation.reauthorizationRequired();
        this.correlation.rejectAll([
            WB_FETCH,
            MESSAGE_TYPES.browserJobAuthorizationRelease,
            SELLER_OPERATION,
            OZON_PROMOTION,
            OZON_PACKAGE,
            MESSAGE_TYPES.browserJobAuthorize,
        ], error);
        this.correlation.releaseAllScopes(false);
    }
    resolveDiagnosticSnapshot(requestId, snapshot) {
        return this.#deliver(MESSAGE_TYPES.diagnosticSnapshot, 'diagnostic-snapshot-result', requestId, undefined, {
            type: 'result',
            payload: snapshot,
        });
    }
    rejectDiagnosticSnapshot(requestId, error) {
        return this.#deliver(MESSAGE_TYPES.diagnosticSnapshot, 'diagnostic-snapshot-error', requestId, safeFeedbackProperty(error, 'code'), { type: 'error', payload: error });
    }
    requestDiagnosticSnapshot(timeout = this.defaultTimeout) {
        if (this.routeDiagnosticSnapshot === undefined) {
            return Promise.reject(new ToolExecutionError('UNSUPPORTED_CAPABILITY', 'Extension diagnostics are unavailable.', 'extension', false));
        }
        return this.correlation.requestDiagnosticSnapshot(timeout);
    }
    resolveAuthorization(requestId, authorization) {
        return this.#deliver(MESSAGE_TYPES.browserJobAuthorize, 'authorization-result', requestId, undefined, {
            type: 'result',
            payload: authorization,
        });
    }
    rejectAuthorization(requestId, error) {
        return this.#deliver(MESSAGE_TYPES.browserJobAuthorize, 'authorization-error', requestId, safeFeedbackProperty(error, 'code'), {
            type: 'error',
            payload: error,
        });
    }
    resolveAuthorizationRelease(requestId) {
        return this.#deliver(MESSAGE_TYPES.browserJobAuthorizationRelease, 'authorization-release-result', requestId, undefined, {
            type: 'result',
            payload: true,
        });
    }
    rejectAuthorizationRelease(requestId, error) {
        return this.#deliver(MESSAGE_TYPES.browserJobAuthorizationRelease, 'authorization-release-error', requestId, safeFeedbackProperty(error, 'code'), { type: 'error', payload: error });
    }
    // The job's lease: the correlation broker's binding (its id, scope, attested job type, signed job and expiry), the grant,
    // whether the scope is still active, its release.
    requestAuthorization(token, timeout = this.defaultTimeout) {
        return this.correlation.requestAuthorization(token, timeout).then((lease) => ({
            id: lease.id,
            scopeId: lease.scopeId,
            jobType: lease.jobType,
            signedJob: lease.signedJob,
            expiresAt: lease.expiresAt,
            authorization: lease.authorization,
            isActive: lease.isActive,
            release: lease.release,
        }));
    }
    requestAuthorizationRelease(authorizationId, route, timeout = this.authorizationReleaseTimeout) {
        return this.correlation.releaseAuthorization(authorizationId, route, timeout);
    }
    // A response that is no object carries no fields beside the request id.
    resolveFetch(requestId, response, { includeRequestId = false } = {}) {
        return this.#deliver(WB_FETCH, 'fetch-result', requestId, safeFeedbackProperty(response, 'code'), {
            type: 'result',
            payload: includeRequestId ? { ...(typeof response === 'object' ? response : {}), requestId } : response,
        });
    }
    rejectFetch(requestId, error) {
        return this.#deliver(WB_FETCH, 'fetch-error', requestId, safeFeedbackProperty(error, 'code'), { type: 'error', payload: error });
    }
    resolveSellerOperation(requestId, response) {
        return this.#deliver(SELLER_OPERATION, 'seller-result', requestId, undefined, { type: 'result', payload: response });
    }
    rejectSellerOperation(requestId, error) {
        return this.#deliver(SELLER_OPERATION, 'seller-error', requestId, safeFeedbackProperty(error, 'code'), {
            type: 'error',
            payload: error,
        });
    }
    async startSellerStream(requestId, metadata) {
        return this.#deliver(SELLER_OPERATION, 'seller-stream-start', requestId, undefined, { type: 'stream_start', payload: metadata });
    }
    async appendSellerStreamChunk(requestId, index, data) {
        return this.#deliver(SELLER_OPERATION, 'seller-stream-chunk', requestId, index, { type: 'stream_chunk', payload: { index, data } });
    }
    async endSellerStream(requestId, metadata) {
        return this.#deliver(SELLER_OPERATION, 'seller-stream-end', requestId, undefined, { type: 'stream_end', payload: metadata });
    }
    resolveOzonPromotionReport(requestId, result) {
        return this.#deliver(OZON_PROMOTION, 'ozon-result', requestId, undefined, { type: 'result', payload: result });
    }
    rejectOzonPromotionReport(requestId, error) {
        return this.#deliver(OZON_PROMOTION, 'ozon-error', requestId, safeFeedbackProperty(error, 'code'), {
            type: 'error',
            payload: error,
        });
    }
    async startOzonPromotionStream(requestId, metadata) {
        return this.#deliver(OZON_PROMOTION, 'ozon-stream-start', requestId, undefined, { type: 'stream_start', payload: metadata });
    }
    async appendOzonPromotionStreamChunk(requestId, chunk) {
        return this.#deliver(OZON_PROMOTION, 'ozon-stream-chunk', requestId, safeFeedbackProperty(chunk, 'index'), {
            type: 'stream_chunk',
            payload: chunk,
        });
    }
    async endOzonPromotionStream(requestId, metadata) {
        return this.#deliver(OZON_PROMOTION, 'ozon-stream-end', requestId, undefined, { type: 'stream_end', payload: metadata });
    }
    async recordOzonReportPackagePhase(requestId, family, payload) {
        return this.#deliver(OZON_PACKAGE, 'ozon-package-phase', requestId, safeFeedbackProperty(payload, 'itemIndex'), {
            type: 'phase',
            payload: { family, value: payload },
        });
    }
    async startOzonReportPackageStream(requestId, family, metadata) {
        return this.#deliver(OZON_PACKAGE, 'ozon-package-stream-start', requestId, safeFeedbackProperty(metadata, 'itemIndex'), {
            type: 'stream_start',
            payload: { family, value: metadata },
        });
    }
    async appendOzonReportPackageStreamChunk(requestId, family, chunk) {
        return this.#deliver(OZON_PACKAGE, 'ozon-package-stream-chunk', requestId, safeFeedbackProperty(chunk, 'itemIndex'), {
            type: 'stream_chunk',
            payload: { family, value: chunk },
        });
    }
    async endOzonReportPackageStream(requestId, family, metadata) {
        return this.#deliver(OZON_PACKAGE, 'ozon-package-stream-end', requestId, safeFeedbackProperty(metadata, 'itemIndex'), {
            type: 'stream_end',
            payload: { family, value: metadata },
        });
    }
    async resolveOzonReportPackageItem(requestId, family, itemIndex, result) {
        return this.#deliver(OZON_PACKAGE, 'ozon-package-item-result', requestId, itemIndex, {
            type: 'item_result',
            payload: { family, itemIndex, value: result },
        });
    }
    rejectOzonReportPackage(requestId, error) {
        return this.#deliver(OZON_PACKAGE, 'ozon-package-error', requestId, safeFeedbackProperty(error, 'code'), {
            type: 'error',
            payload: error,
        });
    }
}
