import { fileURLToPath } from 'node:url';

export const FEEDBACK_DIAGNOSTIC_OPERATIONS = Object.freeze(['prepare', 'input_validation', 'claim_verification', 'transcript_read', 'report_render', 'metadata_encode', 'archive_create', 'artifact_store', 'prepare_result', 'submit', 'grant_validation', 'artifact_read', 'upload', 'handoff_prepare', 'handoff_authorize', 'handoff_submit', 'claim_issue', 'claim_consume']);
export const FEEDBACK_DIAGNOSTIC_ERROR_TYPES = Object.freeze(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AggregateError', 'NonError']);
export const FEEDBACK_DIAGNOSTIC_SYSTEM_CODES = Object.freeze(['EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EDQUOT', 'EROFS', 'EMFILE', 'ENFILE', 'EIO', 'EEXIST', 'ENOTDIR', 'EISDIR', 'ENOTEMPTY', 'EBUSY', 'EINVAL', 'ELOOP', 'EXDEV', 'ENAMETOOLONG', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
export const FEEDBACK_DIAGNOSTIC_FILESYSTEM_CODES = Object.freeze(['EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EDQUOT', 'EROFS', 'EMFILE', 'ENFILE', 'EIO', 'EEXIST', 'ENOTDIR', 'EISDIR', 'ENOTEMPTY', 'EBUSY', 'EINVAL', 'ELOOP', 'EXDEV', 'ENAMETOOLONG']);
export const FEEDBACK_DIAGNOSTIC_MODULES = Object.freeze(['feedback-diagnostics.mjs', 'feedback-errors.mjs', 'feedback-tools.mjs', 'feedback-upload.mjs', 'feedback-claim.mjs', 'feedback-artifact-store.mjs', 'feedback-metadata.mjs', 'feedback-report.mjs', 'feedback-zip.mjs', 'mcp-dispatcher.mjs', 'tool-schemas.mjs']);
export const FEEDBACK_DIAGNOSTIC_REASONS = Object.freeze(['claim_missing', 'claim_already_consumed', 'claim_expired', 'claim_not_yet_valid', 'claim_binding_mismatch', 'claim_signature_invalid', 'claim_record_invalid', 'claim_capacity', 'claim_store_busy', 'storage_busy', 'storage_capacity', 'storage_cleanup_incomplete', 'artifact_missing', 'artifact_ambiguous', 'artifact_expired', 'artifact_integrity', 'invalid_headers', 'network_timeout', 'internal_error']);

const operations = new WeakMap();
const httpStatuses = new WeakMap();
const moduleLocations = FEEDBACK_DIAGNOSTIC_MODULES.flatMap(module => {
    const url = new URL(module, import.meta.url);
    return [[url.href, module], [fileURLToPath(url), module]];
});
const builtins = [TypeError, RangeError, SyntaxError, ReferenceError, URIError, EvalError, AggregateError, Error];

export const safeFeedbackProperty = (value, key) => {
    try { return value?.[key]; } catch { return undefined; }
};

// WHY: preserve private causes without mutating frozen errors or trusting an arbitrary operation property.
export const withFeedbackOperation = (error, operation) => {
    const wrapper = new Error('Feedback operation failed.', { cause: error });
    const code = safeFeedbackProperty(error, 'code');
    if (typeof code === 'string') Object.defineProperty(wrapper, 'code', { value: code });
    operations.set(wrapper, FEEDBACK_DIAGNOSTIC_OPERATIONS.includes(operation) ? operation : 'prepare');
    return wrapper;
};

// Only the upload owner records definitive HTTP evidence; a similarly named foreign property is not evidence.
export const recordFeedbackHttpStatus = (error, status) => {
    if (Number.isInteger(status) && status >= 100 && status <= 599) httpStatuses.set(error, status);
};

const sourcePoint = error => {
    const stack = safeFeedbackProperty(error, 'stack');
    if (typeof stack !== 'string') return undefined;
    for (const frame of stack.slice(0, 16_384).split('\n').slice(1, 25)) {
        if (!/^\s+at /.test(frame)) continue;
        const match = /(?:\(|at )([^()]+):(\d{1,7}):(\d{1,7})\)?$/.exec(frame);
        if (!match) continue;
        const location = moduleLocations.find(([path]) => path === match[1]);
        if (location && Number(match[2]) > 0 && Number(match[3]) > 0) return { module: location[1], line: Number(match[2]), column: Number(match[3]) };
    }
    return undefined;
};

/** Projects bounded evidence only. Never serializes messages, arbitrary names, stack text, or paths. */
export const feedbackDiagnostics = (error, operation = 'prepare') => {
    /** @type {{operation: string, errorType?: string, systemCode?: string, httpStatus?: number, reason?: string, source?: {module: string, line: number, column: number}}} */
    const result = { operation: FEEDBACK_DIAGNOSTIC_OPERATIONS.includes(operation) ? operation : 'prepare' };
    const seen = new Set();
    let current = error;
    for (let depth = 0; depth < 8 && !seen.has(current); depth++) {
        seen.add(current);
        let errorType = 'NonError';
        try { errorType = builtins.find(type => current instanceof type)?.name ?? 'NonError'; } catch { /* Hostile proxies are not diagnostic evidence. */ }
        // Report the deepest inspected cause's built-in type, just like its system evidence.
        // Outer operation wrappers are plain Error by design; reporting their type would hide
        // useful original TypeError/RangeError failures. This is causal evidence, not proof of root cause.
        result.errorType = errorType;
        const ownedOperation = operations.get(current);
        if (ownedOperation) result.operation = ownedOperation;
        const code = safeFeedbackProperty(current, 'code');
        if (FEEDBACK_DIAGNOSTIC_SYSTEM_CODES.includes(code)) result.systemCode = code;
        const reason = safeFeedbackProperty(current, 'feedbackReason');
        if (FEEDBACK_DIAGNOSTIC_REASONS.includes(reason)) result.reason = reason;
        const httpStatus = httpStatuses.get(current);
        if (httpStatus !== undefined) result.httpStatus = httpStatus;
        const source = sourcePoint(current);
        if (source) result.source = source;
        const cause = safeFeedbackProperty(current, 'cause');
        if (cause === undefined || cause === null) break;
        current = cause;
    }
    return result;
};
