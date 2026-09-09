export const OZON_PACKAGE_STOP_REASONS = Object.freeze([
    'authorization_unavailable',
    'capability_unavailable',
    'seller_context_unavailable',
    'capacity_unavailable',
    'deadline_exceeded',
    'rate_limited',
    'cancelled',
    'artifact_unavailable',
    'systemic_failure_breaker',
    'execution_interrupted',
]);

const reasonsByCode = Object.freeze({
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
});

export const ozonPackageStopReason = (code) => Object.hasOwn(reasonsByCode, code) ? reasonsByCode[code] : 'execution_interrupted';

// Only the local routing boundary can attest that nothing reached a transport.
// A peer/page cannot forge this evidence by adding a property to an error payload.
const preexecutionErrors = new WeakSet();
export const markOzonPackageNotStarted = (error) => { preexecutionErrors.add(error); return error; };
export const isOzonPackageNotStarted = (error) => preexecutionErrors.has(error);

export const rejectedOzonPackage = (jobType, property, items, error) => ({
    ok: false,
    status: 'failed',
    jobType,
    [property]: items.map((item, itemIndex) => ({ ...item, itemIndex, status: 'skipped' })),
    error,
    stopReason: ozonPackageStopReason(error.code),
});
