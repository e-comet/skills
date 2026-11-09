import { isRecord as isObject } from '../../shared/values.mjs';
import { FAILURE_DETAIL_VALUES } from '../failures/vocabulary.mjs';
import { MAX_BROWSER_JOB_TOKEN_BYTES, MAX_MCP_MESSAGE_BYTES } from './limits.mjs';
import { array, boolean, described, nonNegativeInteger, object, objectUnion, positiveInteger, string } from './schema.mjs';
// Result fragments every tool shares (spec §6.3): the error, the rejection, the receipt and the running answer, and
// the closed outcome fields of a result. The tools/list golden file pins every schema built from them.
const storageWarnings = array(string);
// The signed tools' transport-only authorization input (WB buyer and Seller tools).
export const triggerUrlProperty = {
    type: 'string',
    minLength: 1,
    maxLength: MAX_BROWSER_JOB_TOKEN_BYTES,
    description: 'Opaque browser authorization injected by the trusted Claude or Codex host hook immediately before this local tool call. ' +
        'It is transport-only; model-authored arguments must omit both triggerUrl and trigger_url, except for an mcp__remote-devices__ tool, which gets the browser_job trigger_url unchanged. The conservative schema maxLength is a character count; ' +
        'runtime authoritatively enforces the 128 KiB UTF-8 byte limit.',
};
// The verified report copy every report tool may describe.
export const fileDeliverySchema = object({
    status: { type: 'string', enum: ['complete', 'partial', 'failed'] },
    copied: nonNegativeInteger,
    failures: array(object({
        resourceIndex: nonNegativeInteger,
        code: { const: 'REPORT_DELIVERY_FAILED' },
        stage: { type: 'string', enum: ['output_directory', 'source', 'copy', 'verification'] },
        reason: {
            type: 'string',
            enum: [
                'invalid_output_directory',
                'invalid_artifact_metadata',
                'source_not_file',
                'integrity_mismatch',
                'filesystem_error',
                'unexpected_error',
            ],
        },
        systemCode: {
            type: 'string',
            enum: [
                'EACCES',
                'EPERM',
                'ENOSPC',
                'EDQUOT',
                'ENOENT',
                'ENOTDIR',
                'EISDIR',
                'EEXIST',
                'EROFS',
                'EMFILE',
                'ENFILE',
                'EIO',
                'ENAMETOOLONG',
            ],
        },
    }, ['resourceIndex', 'code', 'stage', 'reason'])),
}, ['status', 'copied', 'failures']);
export const closedValue = (key) => ({
    type: 'string',
    enum: [...FAILURE_DETAIL_VALUES[key]],
});
// The closed `details` of a local failure: a reason, timeout phase, failure class, WBAAS outcome, filesystem code,
// descriptor rule, Seller refusal and HTTP status, or the request counts of a stopped job.
export const failureDetailsSchema = object({
    ...Object.fromEntries(Object.entries(FAILURE_DETAIL_VALUES).map(([key, values]) => [key, { type: 'string', enum: [...values] }])),
    wbRefused: boolean,
    httpStatus: { type: 'integer', minimum: 100, maximum: 599 },
    completed: nonNegativeInteger,
    pending: nonNegativeInteger,
});
const browserJobRejectionSchema = objectUnion(object({
    schemaVersion: { const: 1 },
    reason: { const: 'invalid_job' },
    diagnostic: {
        type: 'string',
        enum: [
            'job_type',
            'jobs_count',
            'descriptor_type',
            'descriptor_shape',
            'date_from',
            'date_to_or_range',
            'claims_iat_or_jti',
        ],
    },
}, ['schemaVersion', 'reason']), ...[
    'public_key_not_configured',
    'user_not_available',
    'invalid_format',
    'invalid_algorithm',
    'invalid_signature',
    'issuer_mismatch',
    'audience_mismatch',
    'subject_mismatch',
    'expired',
    'token_reuse',
    'ecomet_not_authenticated',
    'activation_storage_unavailable',
    'storage_unavailable',
    'unknown',
].map((reason) => object({ schemaVersion: { const: 1 }, reason: { const: reason } }, ['schemaVersion', 'reason'])), object({
    schemaVersion: { const: 1 },
    reason: { type: 'string', enum: ['device_clock_ahead', 'device_clock_behind'] },
    skewMinutes: nonNegativeInteger,
}, ['schemaVersion', 'reason']));
export const browserJobRejectionDetailsSchema = object({ browserJobRejection: browserJobRejectionSchema }, ['browserJobRejection']);
export const toolErrorSchema = object({
    ok: { const: false },
    code: string,
    message: string,
    stage: {
        type: 'string',
        enum: ['arguments', 'handoff', 'extension', 'authorization', 'execution', 'storage', 'images', 'seller', 'local'],
    },
    retryable: boolean,
    details: objectUnion(object({
        operation: { const: 'create_result' },
        systemCode: { type: 'string', enum: ['EEXIST', 'EACCES', 'EPERM', 'ENOSPC', 'EDQUOT', 'EROFS', 'ENOTDIR', 'EBUSY'] },
    }, ['operation', 'systemCode']), browserJobRejectionDetailsSchema, failureDetailsSchema),
    resultPath: string,
    storageWarnings,
}, ['ok', 'code', 'message', 'stage', 'retryable']);
// The only structured error of the two generic tools: a refusal of arguments outside the input schema. An MCP SDK client
// checks structuredContent against the output schema even on an error, so their schemas must list it. Described field
// by field, because the diagnostic tools' schemas describe every published field.
export const argumentRefusalSchema = described(object({
    ok: described({ const: false }, 'Always false: the call was refused before any work ran.'),
    code: described({ const: 'INVALID_TOOL_ARGUMENTS' }, 'Refusal code for arguments outside the input schema.'),
    message: described(string, 'Names the wrong argument and how to correct it before calling again.'),
    stage: described({ const: 'arguments' }, 'The refusal happened while the arguments were checked.'),
    retryable: described({ const: false }, 'The same arguments fail again; correct them first.'),
}, ['ok', 'code', 'message', 'stage', 'retryable']), 'Refusal of arguments outside the input schema; nothing was run.');
export const operationDiagnosticSchema = described(object({
    schemaVersion: described({ const: 1 }, 'Version of the operation-diagnostic receipt contract.'),
    handle: described(string, 'Opaque handle for one of the last eight real completions in this MCP process.'),
    at: described(string, 'ISO timestamp of the completion; present in a last_operation diagnosis.'),
    tool: described(string, 'Local tool that completed; present in a last_operation diagnosis.'),
    code: described(string, 'Closed error code of the completion, or of its first failed item; omitted when none.'),
    reason: described(string, 'Closed reason or stop reason the completion carried; omitted when none.'),
    stage: described(string, 'Last operation stage established by the producer.'),
    outcome: described({ type: 'string', enum: ['succeeded', 'partial', 'failed', 'uncertain'] }, 'Observed terminal outcome without converting uncertainty into failure.'),
    retryDisposition: described({ type: 'string', enum: ['allowed', 'forbidden', 'requires_new_authorization', 'unknown'] }, 'Whether repeating the original operation is safe under its existing authorization contract.'),
}, ['schemaVersion', 'handle', 'stage', 'outcome', 'retryDisposition']), 'Terminal receipt for one exact real operation completion in this MCP process.');
export const withOperationDiagnostic = (schema) => schema.oneOf
    ? { ...schema, oneOf: schema.oneOf.map(withOperationDiagnostic) }
    : { ...schema, properties: { ...schema.properties, operationDiagnostic: operationDiagnosticSchema } };
// A bridge tool's answer while its job still runs: not a failure; e_comet_run_result returns the final answer.
const runningAnswerSchema = object({
    ok: { const: true },
    status: { const: 'running' },
    runId: string,
    tool: string,
    elapsedSeconds: nonNegativeInteger,
    progress: object({ completed: nonNegativeInteger, total: positiveInteger }, ['completed', 'total']),
    nextStep: string,
}, ['ok', 'status', 'runId', 'tool', 'elapsedSeconds', 'nextStep']);
export const withRunningAnswer = (schema) => schema.oneOf ? { ...schema, oneOf: [...schema.oneOf, runningAnswerSchema] } : objectUnion(schema, runningAnswerSchema);
// A result is read only for its closed outcome fields, never copied: `ok`, `status`, and a `code`,
// `stage` and `cause` either at the top level of a failure envelope or nested under `error`, the nested
// causes the error's `details` carry, a package's `stopReason` and the first failed item's `code` and
// `stage`, all in these identifier grammars; any other value stays out, and prose is never parsed. The
// grammars describe our own envelopes, so only our own tools are read for them. Another server's result
// can still say the call failed through `ok` and the host's own flag, but a value this server never
// defined is not ours to put in a support archive.
const OUTCOME_LOWER = /^[a-z][a-z_]{1,31}$/;
// The native cause classes include `http_4xx` and `http_5xx`, so the cause grammar admits digits.
const OUTCOME_CAUSE = /^[a-z][a-z0-9_]{1,31}$/;
const OUTCOME_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
export const OUTCOME_GRAMMARS = {
    status: OUTCOME_LOWER,
    code: OUTCOME_CODE,
    stage: OUTCOME_LOWER,
    cause: OUTCOME_CAUSE,
    reason: OUTCOME_CAUSE,
    bridgeCode: OUTCOME_CODE,
    refusalCode: OUTCOME_CODE,
    systemCode: OUTCOME_CODE,
    stopReason: OUTCOME_LOWER,
    itemCode: OUTCOME_CODE,
    itemStage: OUTCOME_LOWER,
};
// The collections a package result lists its items in; the first failed item explains a stopped package.
const ITEM_COLLECTIONS = ['exports', 'periods', 'reports', 'queries', 'articles', 'products', 'items'];
// The requests a buyer item keeps beneath it: search and recommendation pages, product-card units.
const NESTED_ITEMS = ['pages', 'units'];
// Ozon's numeric error code, a signed 32-bit integer.
export const int32 = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= -2147483648 && value <= 2147483647 ? value : undefined;
const closedField = (candidate, grammar) => typeof candidate === 'string' && grammar.test(candidate) ? candidate : undefined;
// A failure's closed cause: a named reason, else the phase a WB timeout stopped in.
const causeOf = (details) => isObject(details) ? (closedField(details.reason, OUTCOME_CAUSE) ?? closedField(details.phase, OUTCOME_CAUSE)) : undefined;
// An item's failure: its `error` object, or the `errorDetails` a buyer page or unit keeps beside its string `error`.
const failureOf = (entry) => isObject(entry)
    ? [entry.error, entry.errorDetails].find((failure) => isObject(failure) && closedField(failure.code, OUTCOME_CODE) !== undefined)
    : undefined;
const listOf = (value) => (Array.isArray(value) ? value : []);
/**
 * The closed outcome fields of one of our own results, each in its grammar or absent: the top-level fields, the nested
 * causes under the error's `details` (a rejection's reason included), a package's `stopReason`, and the code, stage and
 * cause of the first failed item, buyer page or product-card unit. The operation receipt reads the same fields.
 * Parse boundary: `value` is a result this process or a transcript produced, read only through these grammars.
 */
export const closedOutcomeFields = (value) => {
    const error = isObject(value.error) ? value.error : undefined;
    const details = isObject(error?.details) ? error.details : isObject(value.details) ? value.details : undefined;
    const item = ITEM_COLLECTIONS.flatMap((key) => listOf(value[key]))
        .flatMap((entry) => [entry, ...NESTED_ITEMS.flatMap((key) => (isObject(entry) ? listOf(entry[key]) : []))])
        .map(failureOf)
        .find(Boolean);
    const fields = {
        status: closedField(value.status, OUTCOME_LOWER),
        code: closedField(value.code, OUTCOME_CODE) ?? closedField(error?.code, OUTCOME_CODE),
        stage: closedField(value.stage, OUTCOME_LOWER) ?? closedField(error?.stage, OUTCOME_LOWER),
        // The native DeepSeek adapter classifies a failed call (network, timeout, http_4xx, http_5xx, protocol, unknown).
        cause: closedField(value.cause, OUTCOME_CAUSE) ?? closedField(error?.cause, OUTCOME_CAUSE),
        reason: causeOf(details) ??
            closedField(isObject(details?.browserJobRejection) ? details.browserJobRejection.reason : undefined, OUTCOME_CAUSE) ??
            causeOf(isObject(item?.details) ? item.details : item),
        bridgeCode: closedField(details?.bridgeCode, OUTCOME_CODE),
        refusalCode: closedField(details?.refusalCode, OUTCOME_CODE),
        systemCode: closedField(details?.systemCode, OUTCOME_CODE),
        marketplaceErrorCode: int32(details?.marketplaceErrorCode),
        stopReason: closedField(value.stopReason, OUTCOME_LOWER),
        itemCode: closedField(item?.code, OUTCOME_CODE),
        itemStage: closedField(item?.stage, OUTCOME_LOWER),
    };
    return Object.fromEntries(Object.entries(fields).filter(([, field]) => field !== undefined));
};
// One whole JSON text of a tool result, bounded like an MCP message; anything else is the caller's `invalid()`.
export const parseWholeBoundedJson = (text, invalid) => {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_MCP_MESSAGE_BYTES)
        throw invalid();
    const trimmed = text.trim();
    if (!trimmed)
        throw invalid();
    try {
        return JSON.parse(trimmed);
    }
    catch {
        throw invalid();
    }
};
const looksLikeJsonCandidate = (text) => {
    if (typeof text !== 'string')
        return false;
    return text.trimStart().startsWith('{');
};
// The JSON objects among a result's text blocks; prose blocks are skipped, a malformed object is `invalid()`.
// Parse boundary: the content blocks of a host-handed result.
export const contentJsonRecords = (content, invalid) => {
    const candidates = [];
    for (const item of listOf(content)) {
        if (!isObject(item) || item.type !== 'text' || typeof item.text !== 'string')
            continue;
        if (!looksLikeJsonCandidate(item.text))
            continue;
        candidates.push(parseWholeBoundedJson(item.text, invalid));
    }
    return candidates;
};
