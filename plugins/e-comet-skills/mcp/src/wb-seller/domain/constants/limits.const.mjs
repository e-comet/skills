import { MIN_REQUEST_TIMEOUT_MS } from '../../../shared/timeouts.mjs';
import { isPositiveSafeInteger } from '../../../shared/values.mjs';
import { SELLER_SCOPE_DURATION_MS } from '../../../transport/extension/wire.mjs';
// A seller download streams the whole workbook as base64 frames, so its budget must cover the page-side
// encode plus every chunk rather than the single JSON round trip the generic default was sized for.
// Observed downloads finish in seconds, tens of seconds at worst, so this is headroom over the real
// worst case and not a capacity estimate — keep it tight enough that a wedged stream still surfaces.
export const SELLER_DOWNLOAD_TIMEOUT_MS = 60_000;
export const MAX_SELLER_REVIEW_EXPORTS = 50;
export const MAX_SELLER_REVIEW_PHYSICAL_REPORTS = 100;
export const MAX_SELLER_REVIEW_POLLS_PER_REPORT = 100;
export const MAX_SELLER_REVIEW_DOWNLOAD_ATTEMPTS = 2;
// Порог приёмки расширения. Здесь он объявлен только ради сверки контракта: применяет его
// расширение, а агент держит собственный, заведомо больший темп.
export const MIN_SELLER_OPERATION_INTERVAL_MS = 1000;
// Политика локального агента, а не подписанный лимит: расширение ограничивает, сколько операций
// вправе потратить скоуп, а это — как долго агент продолжает тратить их в отказывающий эндпоинт.
export const MAX_CONSECUTIVE_SELLER_POLL_FAILURES = 3;
export const MAX_CONSECUTIVE_SELLER_EXPORT_FAILURES = 3;
// Темп со стороны агента. Намеренно выше порога приёмки расширения: часы двух процессов и
// round-trip через брокер независимы, поэтому равные значения давали бы ложные срабатывания порога.
export const MIN_SELLER_OPERATION_AGENT_INTERVAL_MS = 1500;
// The executor reserves this much of the signed token for the tail of a job, and the reserve has to
// cover every download attempt the retry loop may make, not just the first. Reserving one attempt
// here while the executor reserves all of them is what left a token outliving the scope ceiling with
// a 60s gap between the job deadline and the scope timer: the second attempt then died as
// BROWSER_JOB_REAUTHORIZATION_REQUIRED instead of the accurate SELLER_JOB_DEADLINE_EXCEEDED.
export const SELLER_JOB_DOWNLOAD_RESERVE_MS = SELLER_DOWNLOAD_TIMEOUT_MS * MAX_SELLER_REVIEW_DOWNLOAD_ATTEMPTS;
export const sellerJobDurationMs = (scopeMaxMs, configuredDuration) => {
    if (!Number.isSafeInteger(scopeMaxMs) || scopeMaxMs <= 0) {
        throw new RangeError('Seller authorization scope maximum must be a positive safe integer');
    }
    const scopeCeiling = Math.max(1, scopeMaxMs - MIN_REQUEST_TIMEOUT_MS);
    const defaultDuration = scopeMaxMs - SELLER_JOB_DOWNLOAD_RESERVE_MS;
    const candidate = isPositiveSafeInteger(configuredDuration) ? configuredDuration : defaultDuration;
    return Math.min(Math.max(1, candidate > 0 ? candidate : scopeCeiling), scopeCeiling);
};
export const SELLER_JOB_MAX_DURATION_MS = sellerJobDurationMs(SELLER_SCOPE_DURATION_MS, SELLER_SCOPE_DURATION_MS - SELLER_JOB_DOWNLOAD_RESERVE_MS);
