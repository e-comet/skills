import { closedOutcomeFields } from './feedback-tool-calls.mjs';

const RETRY_DISPOSITIONS = new Set(['allowed', 'forbidden', 'requires_new_authorization', 'unknown']);
// A diagnosis may come several calls after the operation it asks about; eight completions cover a typical recovery.
const RECEIPTS_KEPT = 8;
const TOOL = /^[a-z][a-z0-9_]{0,63}$/;
const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const REASON = /^[a-z][a-z0-9_]{1,31}$/;
const closed = (value, grammar) => (typeof value === 'string' && grammar.test(value) ? value : undefined);

export const createOperationDiagnostics = (/** @type {any} */ { now = Date.now, randomUUID } = {}) => {
    /** @type {any[]} */
    const receipts = [];
    const uuid = randomUUID ?? (() => globalThis.crypto.randomUUID());
    return Object.freeze({
        record({ tool = undefined, code = undefined, reason = undefined, stage, outcome, retryDisposition }) {
            if (!RETRY_DISPOSITIONS.has(retryDisposition)) throw new TypeError('Invalid retry disposition.');
            const receipt = Object.freeze({ schemaVersion: 1, handle: uuid(), at: new Date(now()).toISOString(),
                ...Object.fromEntries(Object.entries({ tool: closed(tool, TOOL), code: closed(code, CODE), reason: closed(reason, REASON) })
                    .filter(([, value]) => value !== undefined)),
                stage, outcome, retryDisposition });
            receipts.push(receipt);
            if (receipts.length > RECEIPTS_KEPT) receipts.shift();
            return receipt;
        },
        read(handle) {
            return (typeof handle === 'string' && receipts.find((receipt) => receipt.handle === handle)) || null;
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
    // What the receipt keeps besides the disposition: the tool, its closed code (or the first failed item's) and reason.
    const fields = closedOutcomeFields(value);
    const named = { tool: toolName, ...(fields.code ?? fields.itemCode ? { code: fields.code ?? fields.itemCode } : {}),
        ...(fields.reason ?? fields.stopReason ? { reason: fields.reason ?? fields.stopReason } : {}) };
    const facts = (/** @type {{ stage: string, outcome: string, retryDisposition: string }} */ disposition) => ({ ...named, ...disposition });
    if (code === 'CREATE_OUTCOME_UNKNOWN' || itemCodes.includes('CREATE_OUTCOME_UNKNOWN') || itemCodes.includes('REPORT_CREATE_OUTCOME_UNKNOWN')
        || code === 'UPLOAD_UNCERTAIN' || value.status === 'uncertain') {
        return facts({ stage, outcome: 'uncertain', retryDisposition: 'forbidden' });
    }
    if (error?.recommendedAction === 'RETRY_FEEDBACK_ONCE') return facts({ stage, outcome: 'failed', retryDisposition: 'allowed' });
    // An answered result stays partial even when a stop error explains why its remaining items were skipped.
    if (value.ok === true) return facts({ stage, outcome: value.status === 'partial' ? 'partial' : 'succeeded', retryDisposition: 'forbidden' });
    if (['OZON_ROUTE_NOT_READY', 'EXTENSION_UPDATE_REQUIRED', 'BROWSER_JOB_REAUTHORIZATION_REQUIRED'].includes(code)) {
        return facts({ stage, outcome: 'failed', retryDisposition: 'requires_new_authorization' });
    }
    if (value.ok === false && typeof value.status === 'string' && code === undefined) {
        return facts({ stage, outcome: value.status === 'partial' ? 'partial' : 'failed', retryDisposition: 'forbidden' });
    }
    if (code === 'BROWSER_JOB_HANDOFF_REQUIRED' || code === 'FEEDBACK_HOOK_HANDOFF_UNAVAILABLE'
        || code === 'FEEDBACK_CLAIM_INVALID' || code === 'BROWSER_JOB_AUTHORIZATION_TIMEOUT' || code === 'OZON_AUTHORIZATION_REJECTED') {
        return facts({ stage, outcome: 'failed', retryDisposition: 'unknown' });
    }
    if (code === 'FEEDBACK_SUBMISSION_FAILED') return facts({ stage, outcome: 'failed', retryDisposition: 'forbidden' });
    return facts({ stage, outcome: 'failed', retryDisposition: error?.retryable === false ? 'forbidden' : 'unknown' });
};

// The result carries the disposition the agent acts on; the tool, code, reason and time stay in the receipt that
// e_comet_diagnose reads by handle, so they cost no tokens on every result.
export const decorateOperationResult = (result, receipt) => {
    if (!result || !result.structuredContent || typeof result.structuredContent !== 'object' || Array.isArray(result.structuredContent)) return result;
    const { schemaVersion, handle, stage, outcome, retryDisposition } = receipt;
    const structuredContent = { ...result.structuredContent, operationDiagnostic: { schemaVersion, handle, stage, outcome, retryDisposition } };
    const content = Array.isArray(result.content) ? [...result.content] : [];
    const textIndex = content.findIndex((item) => item?.type === 'text');
    const text = { type: 'text', text: JSON.stringify(structuredContent, null, 2) };
    if (textIndex < 0) content.unshift(text); else content[textIndex] = text;
    return { ...result, content, structuredContent };
};
