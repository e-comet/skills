const RETRY_DISPOSITIONS = new Set(['allowed', 'forbidden', 'requires_new_authorization', 'unknown']);

export const createOperationDiagnostics = (/** @type {any} */ { now = Date.now, randomUUID } = {}) => {
    let latest = null;
    const uuid = randomUUID ?? (() => globalThis.crypto.randomUUID());
    return Object.freeze({
        record({ stage, outcome, retryDisposition, evidence: _evidence = undefined }) {
            if (!RETRY_DISPOSITIONS.has(retryDisposition)) throw new TypeError('Invalid retry disposition.');
            latest = Object.freeze({ schemaVersion: 1, handle: uuid(), stage, outcome, retryDisposition });
            void now();
            return latest;
        },
        read(handle) {
            return typeof handle === 'string' && latest?.handle === handle ? latest : null;
        },
    });
};

const valueOf = (result) => result?.structuredContent;

export const operationFactsFromResult = (toolName, result) => {
    const value = valueOf(result) ?? {};
    const error = value.error ?? value;
    const code = error?.code;
    const stage = error?.stage ?? (toolName === 'submit_e_comet_feedback' ? 'upload'
        : toolName === 'prepare_e_comet_feedback' ? 'prepare' : value.stage ?? 'execution');
    const itemCodes = [...(value.periods ?? []), ...(value.reports ?? []), ...(value.exports ?? [])]
        .map((item) => item?.error?.code);
    if (code === 'CREATE_OUTCOME_UNKNOWN' || itemCodes.includes('CREATE_OUTCOME_UNKNOWN')
        || code === 'UPLOAD_UNCERTAIN' || value.status === 'uncertain') {
        return { stage, outcome: 'uncertain', retryDisposition: 'forbidden' };
    }
    if (error?.recommendedAction === 'RETRY_FEEDBACK_ONCE') return { stage, outcome: 'failed', retryDisposition: 'allowed' };
    if (['OZON_ROUTE_NOT_READY', 'EXTENSION_UPDATE_REQUIRED', 'BROWSER_JOB_REAUTHORIZATION_REQUIRED'].includes(code)) {
        return { stage, outcome: 'failed', retryDisposition: 'requires_new_authorization' };
    }
    if (value.ok === true) return { stage, outcome: value.status === 'partial' ? 'partial' : 'succeeded', retryDisposition: 'forbidden' };
    if (value.ok === false && typeof value.status === 'string' && code === undefined) {
        return { stage, outcome: value.status === 'partial' ? 'partial' : 'failed', retryDisposition: 'forbidden' };
    }
    if (code === 'BROWSER_JOB_HANDOFF_REQUIRED' || code === 'FEEDBACK_HOOK_HANDOFF_UNAVAILABLE'
        || code === 'FEEDBACK_CLAIM_INVALID' || code === 'BROWSER_JOB_AUTHORIZATION_TIMEOUT' || code === 'OZON_AUTHORIZATION_REJECTED') {
        return { stage, outcome: 'failed', retryDisposition: 'unknown' };
    }
    if (code === 'FEEDBACK_SUBMISSION_FAILED') return { stage, outcome: 'failed', retryDisposition: 'forbidden' };
    return { stage, outcome: 'failed', retryDisposition: error?.retryable === false ? 'forbidden' : 'unknown' };
};

export const decorateOperationResult = (result, receipt) => {
    if (!result || !result.structuredContent || typeof result.structuredContent !== 'object' || Array.isArray(result.structuredContent)) return result;
    const structuredContent = { ...result.structuredContent, operationDiagnostic: receipt };
    const content = Array.isArray(result.content) ? [...result.content] : [];
    const textIndex = content.findIndex((item) => item?.type === 'text');
    const text = { type: 'text', text: JSON.stringify(structuredContent, null, 2) };
    if (textIndex < 0) content.unshift(text); else content[textIndex] = text;
    return { ...result, content, structuredContent };
};
