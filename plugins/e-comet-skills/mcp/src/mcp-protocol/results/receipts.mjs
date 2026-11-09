import { isOneOf, isRecord } from '../../shared/values.mjs';
import { closedOutcomeFields } from '../../transport/mcp/results.mjs';
// A diagnosis may come several calls after the operation it asks about; eight completions cover a typical recovery.
const RECEIPTS_KEPT = 8;
const TOOL = /^[a-z][a-z0-9_]{0,63}$/;
const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const REASON = /^[a-z][a-z0-9_]{1,31}$/;
const closed = (value, grammar) => (typeof value === 'string' && grammar.test(value) ? value : undefined);
export const createOperationDiagnostics = ({ now = Date.now, randomUUID, } = {}) => {
    const receipts = [];
    const uuid = randomUUID ?? (() => globalThis.crypto.randomUUID());
    return {
        record({ tool = undefined, code = undefined, reason = undefined, stage, outcome, retryDisposition }) {
            const receipt = {
                schemaVersion: 1,
                handle: uuid(),
                at: new Date(now()).toISOString(),
                ...Object.fromEntries(Object.entries({ tool: closed(tool, TOOL), code: closed(code, CODE), reason: closed(reason, REASON) }).filter(([, value]) => value !== undefined)),
                stage,
                outcome,
                retryDisposition,
            };
            receipts.push(receipt);
            if (receipts.length > RECEIPTS_KEPT)
                receipts.shift();
            return receipt;
        },
        read(handle) {
            return (typeof handle === 'string' && receipts.find((receipt) => receipt.handle === handle)) || null;
        },
    };
};
// A read boundary: the summarizer reads any tool's result by its shared field names. None of them is a field of a
// primitive or an array, so those read as no fields.
const fieldsOf = (value) => (isRecord(value) ? value : {});
const listOf = (value) => (Array.isArray(value) ? value : []);
export const operationFactsFromResult = (toolName, result) => {
    const value = fieldsOf(fieldsOf(result).structuredContent);
    const error = fieldsOf(value.error ?? value);
    const code = error.code;
    // Every result of ours names its stage in text.
    const namedStage = error.stage ??
        (toolName === 'submit_e_comet_feedback'
            ? 'upload'
            : toolName === 'prepare_e_comet_feedback'
                ? 'prepare'
                : (value.stage ?? 'execution'));
    const stage = typeof namedStage === 'string' ? namedStage : String(namedStage);
    const itemCodes = [...listOf(value.periods), ...listOf(value.reports), ...listOf(value.exports)].map((item) => fieldsOf(fieldsOf(item).error).code);
    // What the receipt keeps besides the disposition: the tool, its closed code (or the first failed item's) and reason.
    const fields = closedOutcomeFields(value);
    const named = {
        tool: toolName,
        ...((fields.code ?? fields.itemCode) ? { code: fields.code ?? fields.itemCode } : {}),
        ...((fields.reason ?? fields.stopReason) ? { reason: fields.reason ?? fields.stopReason } : {}),
    };
    const facts = (disposition) => ({ ...named, ...disposition });
    if (code === 'CREATE_OUTCOME_UNKNOWN' ||
        itemCodes.includes('CREATE_OUTCOME_UNKNOWN') ||
        itemCodes.includes('REPORT_CREATE_OUTCOME_UNKNOWN') ||
        code === 'UPLOAD_UNCERTAIN' ||
        value.status === 'uncertain') {
        return facts({ stage, outcome: 'uncertain', retryDisposition: 'forbidden' });
    }
    if (error.recommendedAction === 'RETRY_FEEDBACK_ONCE')
        return facts({ stage, outcome: 'failed', retryDisposition: 'allowed' });
    // An answered result stays partial even when a stop error explains why its remaining items were skipped.
    if (value.ok === true)
        return facts({ stage, outcome: value.status === 'partial' ? 'partial' : 'succeeded', retryDisposition: 'forbidden' });
    if (isOneOf(['OZON_ROUTE_NOT_READY', 'EXTENSION_UPDATE_REQUIRED', 'BROWSER_JOB_REAUTHORIZATION_REQUIRED'], code)) {
        return facts({ stage, outcome: 'failed', retryDisposition: 'requires_new_authorization' });
    }
    if (value.ok === false && typeof value.status === 'string' && code === undefined) {
        return facts({ stage, outcome: value.status === 'partial' ? 'partial' : 'failed', retryDisposition: 'forbidden' });
    }
    if (code === 'BROWSER_JOB_HANDOFF_REQUIRED' ||
        code === 'FEEDBACK_HOOK_HANDOFF_UNAVAILABLE' ||
        code === 'FEEDBACK_CLAIM_INVALID' ||
        code === 'BROWSER_JOB_AUTHORIZATION_TIMEOUT' ||
        code === 'OZON_AUTHORIZATION_REJECTED') {
        return facts({ stage, outcome: 'failed', retryDisposition: 'unknown' });
    }
    if (code === 'FEEDBACK_SUBMISSION_FAILED')
        return facts({ stage, outcome: 'failed', retryDisposition: 'forbidden' });
    return facts({ stage, outcome: 'failed', retryDisposition: error.retryable === false ? 'forbidden' : 'unknown' });
};
// The tools that record no receipt (spec §6.4): status and diagnosis observe, the generic tools relay.
export const RECEIPT_EXEMPT_TOOLS = [
    'local_bridge_status',
    'e_comet_diagnose',
    'describe_e_comet_tool',
    'e_comet_run_result',
];
// The result carries the disposition the agent acts on; the tool, code, reason and time stay in the receipt that
// e_comet_diagnose reads by handle, so they cost no tokens on every result.
// A read boundary as above: any tool's result, decorated in place of its structured content and text.
export const decorateOperationResult = (result, receipt) => {
    if (!isRecord(result) || !isRecord(result.structuredContent))
        return result;
    const { schemaVersion, handle, stage, outcome, retryDisposition } = receipt;
    const structuredContent = {
        ...result.structuredContent,
        operationDiagnostic: { schemaVersion, handle, stage, outcome, retryDisposition },
    };
    const content = [...listOf(result.content)];
    const textIndex = content.findIndex((item) => isRecord(item) && item.type === 'text');
    const text = { type: 'text', text: JSON.stringify(structuredContent, null, 2) };
    if (textIndex < 0)
        content.unshift(text);
    else
        content[textIndex] = text;
    return { ...result, content, structuredContent };
};
// Records a tool's receipt and puts its disposition on the result. A diagnostic must never replace the business result.
export const withReceipt = (diagnostics, toolName, result) => {
    if (RECEIPT_EXEMPT_TOOLS.includes(toolName))
        return result;
    try {
        return decorateOperationResult(result, diagnostics.record(operationFactsFromResult(toolName, result)));
    }
    catch {
        return result;
    }
};
