import { ToolExecutionError } from '../../shared/coded-error.mjs';
import { hasOnlyOwnKeys, hasOwnKeys, isNonNegativeSafeInteger, isOneOf, isRecord } from '../../shared/values.mjs';
const BROWSER_JOB_REJECTION_CODES = new Set(['BROWSER_JOB_REJECTED', 'BROWSER_JOB_ACCOUNT_MISMATCH']);
export const BROWSER_JOB_REJECTION_REASONS = new Set([
    'public_key_not_configured',
    'user_not_available',
    'invalid_format',
    'invalid_algorithm',
    'invalid_signature',
    'issuer_mismatch',
    'audience_mismatch',
    'subject_mismatch',
    'expired',
    'invalid_job',
    'token_reuse',
    'ecomet_not_authenticated',
    'activation_storage_unavailable',
    'device_clock_ahead',
    'device_clock_behind',
    'storage_unavailable',
    'unknown',
]);
export const BROWSER_JOB_INVALID_JOB_DIAGNOSTICS = new Set([
    'job_type',
    'jobs_count',
    'descriptor_type',
    'descriptor_shape',
    'date_from',
    'date_to_or_range',
    'claims_iat_or_jti',
]);
export const DEVICE_CLOCK_REASONS = ['device_clock_ahead', 'device_clock_behind'];
// Parse boundary: `value` comes from the extension and is narrowed here.
export const parseBrowserJobRejection = (code, value) => {
    if (!BROWSER_JOB_REJECTION_CODES.has(code) ||
        !isRecord(value) ||
        !hasOnlyOwnKeys(value, ['schemaVersion', 'reason', 'diagnostic', 'skewMinutes']) ||
        !hasOwnKeys(value, ['schemaVersion', 'reason']) ||
        value.schemaVersion !== 1 ||
        typeof value.reason !== 'string' ||
        !BROWSER_JOB_REJECTION_REASONS.has(value.reason))
        return undefined;
    const reason = value.reason, diagnostic = value.diagnostic, skewMinutes = value.skewMinutes;
    if (diagnostic !== undefined &&
        (reason !== 'invalid_job' || typeof diagnostic !== 'string' || !BROWSER_JOB_INVALID_JOB_DIAGNOSTICS.has(diagnostic)))
        return undefined;
    if (skewMinutes !== undefined &&
        (!isOneOf(DEVICE_CLOCK_REASONS, reason) || !isNonNegativeSafeInteger(skewMinutes) || skewMinutes > 1_000_000))
        return undefined;
    return {
        schemaVersion: 1,
        reason,
        ...(diagnostic === undefined ? {} : { diagnostic }),
        ...(skewMinutes === undefined ? {} : { skewMinutes }),
    };
};
// The agent's next step and its owner for a refusal reason the extension names (spec 7.2). A reason without a row
// keeps the extension's own message.
const AUTHORIZE_AGAIN = 'then request a new browser job.';
export const rejectionGuidance = (rejection) => {
    const skew = rejection?.skewMinutes === undefined ? '' : ` by about ${rejection.skewMinutes} minutes`;
    if (rejection?.reason === 'device_clock_ahead')
        return (`This computer's clock runs ahead${skew}, so the extension saw the browser job as expired. ` +
            `Ask the user to sync the system clock, ${AUTHORIZE_AGAIN}`);
    if (rejection?.reason === 'device_clock_behind')
        return (`This computer's clock runs behind${skew}, so the browser job looked issued in the future. ` +
            `Ask the user to sync the system clock, ${AUTHORIZE_AGAIN}`);
    if (rejection?.reason === 'storage_unavailable')
        return ('The browser could not read or write the extension storage. ' +
            `Ask the user to restart the browser, ${AUTHORIZE_AGAIN} If it repeats, offer to report it.`);
    return undefined;
};
export const browserJobRejectionDetails = (error) => {
    // Only this process sets the field, and only with a parsed rejection; parsing it again restores its type.
    const browserJobRejection = error instanceof ToolExecutionError && error.details?.browserJobRejection
        ? parseBrowserJobRejection('BROWSER_JOB_REJECTED', error.details.browserJobRejection)
        : undefined;
    return browserJobRejection ? { browserJobRejection } : undefined;
};
