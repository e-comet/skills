import { REQUEST_TIMEOUT_GRACE_MS } from '../../../bridge/limits.mjs';
import { ToolExecutionError } from '../../../shared/coded-error.mjs';
import { MESSAGE_TYPES } from '../../../transport/extension/wire.mjs';
import { BUYER_JOB_TYPES } from '../../domain/constants/descriptors.const.mjs';
import { isAllowedWbUrl } from '../../domain/policies/wb-url.policy.mjs';
// A request that ends with its one answer: a result or an error frame.
const settleOnce = (frame, control) => {
    if (!control.close())
        return false;
    if (frame.type === 'error')
        control.reject(frame.payload instanceof Error ? frame.payload : new Error(String(frame.payload)));
    else
        control.resolve(frame.payload);
    return true;
};
/**
 * The WB fetch over the correlation broker (refactor spec §7.4): every URL is checked against the allowlist and the
 * lease's active scope before a frame is sent, and one URL asked twice under the same lease and timeout is sent once.
 */
export const createWbFetch = ({ correlation }) => {
    const inFlightFetches = new Map();
    const fetch = (url, { timeoutMs: timeout, lease }) => {
        const authorizationId = lease?.id;
        const authorizationScopeId = lease?.scopeId;
        if (typeof authorizationId !== 'string' || authorizationId.length === 0) {
            return Promise.reject(new ToolExecutionError('BROWSER_JOB_REQUIRED', 'A signed browser-job authorization is required.', 'arguments', false));
        }
        // Lease binding (spec §7.4): only a buyer or filters job the extension attested may fetch, and only allowed URLs.
        // Not narrowed to one URL family per job type: accepted residual "The WB fetch binds a lease to the buyer job
        // family", docs/architecture/residuals/signed-flow.md.
        if (!BUYER_JOB_TYPES.has(lease?.jobType) || !isAllowedWbUrl(url)) {
            return Promise.reject(new ToolExecutionError('BROWSER_JOB_URL_NOT_ALLOWED', 'Only approved Wildberries internal URLs are allowed.', 'arguments', false));
        }
        if (typeof authorizationScopeId !== 'string') {
            return Promise.reject(correlation.scopeEnded(undefined));
        }
        const authorizationScope = correlation.scopes.get(authorizationScopeId);
        if (!authorizationScope || !correlation.scopeIsActive(authorizationScopeId, authorizationScope)) {
            return Promise.reject(correlation.scopeEnded(authorizationScopeId));
        }
        if (authorizationScope.authorizationId !== authorizationId) {
            return Promise.reject(correlation.scopeEnded(authorizationScopeId));
        }
        const dedupeKey = `${authorizationScopeId}\n${authorizationId}\n${url}\n${timeout}`;
        const existing = inFlightFetches.get(dedupeKey);
        if (existing)
            return existing;
        const request = (async () => {
            // Дальше по маршруту уходит ровно `timeout` — это подписанный бюджет
            // запроса, урезать его нельзя. Себе берём запас на каждый хоп, чтобы наш
            // таймер сработал последним и типизированный отказ снизу успел доехать.
            // The request belongs to its scope before it is sent: a synchronous route may release that scope.
            return correlation.open({
                type: MESSAGE_TYPES.wbFetch,
                payload: { url, timeout, authorizationId, authorizationScopeId },
                timeoutMs: timeout + REQUEST_TIMEOUT_GRACE_MS,
                timeoutError: () => new ToolExecutionError('WB_FETCH_TIMEOUT', `The Wildberries request timed out after ${timeout} ms.`, 'extension', true),
                authorization: { id: authorizationId, scopeId: authorizationScopeId },
                onFrame: settleOnce,
            }).result;
        })();
        inFlightFetches.set(dedupeKey, request);
        request.then(() => inFlightFetches.delete(dedupeKey), () => inFlightFetches.delete(dedupeKey));
        return request;
    };
    return { fetch };
};
