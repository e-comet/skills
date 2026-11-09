// The default request timeout and the bounds a signed descriptor's timeout must keep; the extension applies the same
// bounds (refactor spec §6.3).
export const REQUEST_TIMEOUT_MS = 45000;
export const MIN_REQUEST_TIMEOUT_MS = 1000;
export const MAX_REQUEST_TIMEOUT_MS = 120000;
export const validTimeout = (timeout) => typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= MIN_REQUEST_TIMEOUT_MS && timeout <= MAX_REQUEST_TIMEOUT_MS;
