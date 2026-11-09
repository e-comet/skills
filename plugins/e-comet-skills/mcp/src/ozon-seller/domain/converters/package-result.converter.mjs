import { isRecord } from '../../../shared/values.mjs';
import { SELLER_SCOPE_DURATION_MS } from '../../../transport/extension/wire.mjs';
const SIGNED_EXPIRY_SAFETY_RESERVE_MS = 1000;
// The extension refuses a package deadline after the signed expiry, so one second of it is held back.
// Parse boundary: the signed grant, whose expiry is read only when it is a finite number.
export const ozonPackageDeadline = (authorization, startedAt) => {
    const expiresAt = isRecord(authorization) ? authorization.expiresAt : undefined;
    return Math.min(startedAt + SELLER_SCOPE_DURATION_MS, typeof expiresAt === 'number' && Number.isFinite(expiresAt)
        ? Math.floor(expiresAt * 1000 - SIGNED_EXPIRY_SAFETY_RESERVE_MS)
        : Infinity);
};
const reasonsByCode = {
    OZON_AUTHORIZATION_REJECTED: 'authorization_unavailable',
    BROWSER_JOB_REAUTHORIZATION_REQUIRED: 'authorization_unavailable',
    OZON_ANALYTICS_CAPABILITY_UNAVAILABLE: 'capability_unavailable',
    OZON_ROUTE_NOT_READY: 'seller_context_unavailable',
    OZON_CONTEXT_CHANGED: 'seller_context_unavailable',
    OZON_ADMISSION_CAPACITY_EXHAUSTED: 'capacity_unavailable',
    OPERATION_DEADLINE_EXCEEDED: 'deadline_exceeded',
    OZON_RATE_LIMITED: 'rate_limited',
    OPERATION_CANCELLED: 'cancelled',
    ARTIFACT_REJECTED: 'artifact_unavailable',
    LOCAL_STORAGE_UNAVAILABLE: 'artifact_unavailable',
    SYSTEMIC_FAILURE_BREAKER: 'systemic_failure_breaker',
};
// Parse boundary: a code from any failure.
export const ozonPackageStopReason = (code) => (typeof code === 'string' && Object.hasOwn(reasonsByCode, code) ? reasonsByCode[code] : undefined) ?? 'execution_interrupted';
// Only the local routing boundary can attest that nothing reached a transport.
// A page cannot forge this evidence by adding a property to an error payload.
const preexecutionErrors = new WeakSet();
export const markOzonPackageNotStarted = (error) => {
    preexecutionErrors.add(error);
    return error;
};
export const isOzonPackageNotStarted = (error) => typeof error === 'object' && error !== null && preexecutionErrors.has(error);
// The closed failure of a package refused before it started: every item skipped.
export const rejectedOzonPackage = (jobType, property, items, error) => ({
    ok: false,
    status: 'failed',
    jobType,
    [property]: items.map((item, itemIndex) => ({ ...item, itemIndex, status: 'skipped' })),
    error,
    stopReason: ozonPackageStopReason(error.code),
});
