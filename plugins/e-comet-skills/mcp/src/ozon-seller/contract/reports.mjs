import { MAX_OZON_REPORT_PACKAGE_ITEMS, OZON_PACKAGE_STOP_REASONS } from '../domain/constants/limits.const.mjs';
import { BRIDGE_CODES } from '../../transport/diagnostics/bridge-codes.mjs';
import { ARTIFACT_FAILURE_CLASSES, DESCRIPTOR_RULES } from '../../transport/failures/vocabulary.mjs';
import { MAX_BROWSER_JOB_TOKEN_BYTES } from '../../transport/mcp/limits.mjs';
import { coworkCopyStep } from '../../transport/mcp/prose.mjs';
import { browserJobRejectionDetailsSchema, closedValue, fileDeliverySchema } from '../../transport/mcp/results.mjs';
import { array, nonNegativeInteger, object, objectUnion } from '../../transport/mcp/schema.mjs';
// What the Ozon tools' contracts share: the trigger input, dates, artifacts and errors of a report, the package result,
// the preflight refusal and the Ozon workflow prose.
// An Ozon authorization failure carries either the extension's rejection or, when no broker answered, the bridge cause,
// or the local descriptor rule the signed job broke.
export const ozonAuthorizationRejectedDetailsSchema = objectUnion(browserJobRejectionDetailsSchema, object({ bridgeCode: { type: 'string', enum: [...BRIDGE_CODES] } }, ['bridgeCode']), object({ rule: { type: 'string', enum: [...DESCRIPTOR_RULES] } }, ['rule']));
export const artifactRejectedDetailsSchema = object({ class: { type: 'string', enum: [...ARTIFACT_FAILURE_CLASSES] }, systemCode: closedValue('systemCode') }, ['class']);
export const ozonTriggerUrlProperty = {
    type: 'string',
    minLength: 1,
    maxLength: MAX_BROWSER_JOB_TOKEN_BYTES,
    description: 'Opaque browser authorization injected by the trusted Claude or Codex host hook immediately before this Ozon tool call. It is transport-only; model-authored arguments must omit both triggerUrl and trigger_url, except for an mcp__remote-devices__ tool, which gets the browser_job trigger_url unchanged.',
};
export const canonicalDateProperty = {
    type: 'string',
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    description: 'Canonical Gregorian calendar date in YYYY-MM-DD form.',
};
export const ozonPromotionArtifactSchema = object({
    name: { type: 'string', pattern: '^ozon-seller-promotion-\\d{4}-\\d{2}-\\d{2}-\\d{4}-\\d{2}-\\d{2}\\.xlsx$' },
    mimeType: { const: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    size: nonNegativeInteger,
    sha256: { type: 'string', minLength: 64, maxLength: 64 },
}, ['name', 'mimeType', 'size', 'sha256']);
export const localStorageUnavailableSchema = object({
    code: { const: 'LOCAL_STORAGE_UNAVAILABLE' },
    message: { const: 'Local output storage is unavailable.' },
    stage: { const: 'storage' },
    retryable: { const: false },
}, ['code', 'message', 'stage', 'retryable']);
const ozonExecutionInterruptionDetailsSchema = objectUnion(object({ phase: { type: 'string', enum: ['pre_create', 'create_dispatched'] }, createOutcome: { const: 'not_started' } }, [
    'phase',
    'createOutcome',
]), object({ phase: { const: 'create_settled' }, createOutcome: { const: 'confirmed' } }, ['phase', 'createOutcome']), object({
    phase: { type: 'string', enum: ['polling', 'downloading', 'streaming'] },
    createOutcome: { type: 'string', enum: ['not_started', 'confirmed'] },
}, ['phase', 'createOutcome']));
export const ozonPackageError = (codeStages, analytics = false) => objectUnion(...Object.entries(codeStages).map(([code, stage]) => object({
    code: { const: code },
    message: { type: 'string', minLength: 1, maxLength: 500 },
    stage: { const: stage },
    retryable: { const: false },
    ...(analytics && code === 'REPORT_TERMINAL_FAILURE'
        ? {
            details: object({
                marketplaceErrorCode: { type: 'integer', minimum: -2147483648, maximum: 2147483647 },
            }, ['marketplaceErrorCode']),
        }
        : {}),
    ...(code === 'OZON_EXECUTION_INTERRUPTED' ? { details: ozonExecutionInterruptionDetailsSchema } : {}),
    ...(code === 'OZON_AUTHORIZATION_REJECTED' ? { details: ozonAuthorizationRejectedDetailsSchema } : {}),
    ...(code === 'ARTIFACT_REJECTED' ? { details: artifactRejectedDetailsSchema } : {}),
}, ['code', 'message', 'stage', 'retryable'])), localStorageUnavailableSchema);
export const promotionPeriodFields = {
    dateFrom: canonicalDateProperty,
    dateTo: canonicalDateProperty,
};
export const packageItemSchemas = (fields, artifactSchema, errorSchema) => {
    fields = { ...fields, itemIndex: { type: 'integer', minimum: 0, maximum: MAX_OZON_REPORT_PACKAGE_ITEMS - 1 } };
    const requiredFields = Object.keys(fields);
    const complete = object({ ...fields, status: { const: 'complete' }, artifact: artifactSchema }, [
        ...requiredFields,
        'status',
        'artifact',
    ]);
    const failed = object({ ...fields, status: { const: 'failed' }, error: errorSchema }, [...requiredFields, 'status', 'error']);
    const skipped = object({ ...fields, status: { const: 'skipped' } }, [...requiredFields, 'status']);
    return {
        complete,
        failed,
        skipped,
        error: errorSchema,
        any: objectUnion(complete, failed, skipped),
        incomplete: objectUnion(failed, skipped),
    };
};
export const packageResultSchema = (jobType, propertyName, itemSchemas) => {
    const result = (ok, statusValue, items, skipped = false, preexecution = false) => object({
        ok: { const: ok },
        status: { const: statusValue },
        jobType: { const: jobType },
        [propertyName]: items,
        fileDelivery: fileDeliverySchema,
        stopReason: skipped ? { type: 'string', enum: OZON_PACKAGE_STOP_REASONS } : { type: 'null' },
        ...(preexecution ? { error: itemSchemas.error } : {}),
    }, ['ok', 'status', 'jobType', propertyName, 'stopReason', ...(preexecution ? ['error'] : [])]);
    const completeItems = array(itemSchemas.complete, { minItems: 1, maxItems: MAX_OZON_REPORT_PACKAGE_ITEMS });
    const partialItems = {
        ...array(itemSchemas.any, { minItems: 2, maxItems: MAX_OZON_REPORT_PACKAGE_ITEMS }),
        allOf: [
            { contains: itemSchemas.complete, minContains: 1 },
            { contains: itemSchemas.incomplete, minContains: 1 },
        ],
    };
    const failedItems = array(itemSchemas.incomplete, { minItems: 1, maxItems: MAX_OZON_REPORT_PACKAGE_ITEMS });
    return objectUnion(result(true, 'complete', completeItems), result(true, 'partial', { ...partialItems, items: objectUnion(itemSchemas.complete, itemSchemas.failed) }), result(true, 'partial', { ...partialItems, contains: itemSchemas.skipped }, true), result(false, 'failed', { ...failedItems, items: itemSchemas.failed }), result(false, 'failed', { ...failedItems, allOf: [{ contains: itemSchemas.skipped }, { contains: itemSchemas.failed }] }, true), result(false, 'failed', array(itemSchemas.skipped, { minItems: 1, maxItems: MAX_OZON_REPORT_PACKAGE_ITEMS }), true, true), preflightFailureSchema(jobType));
};
// Invalid arguments are never echoed: the failure names only the broken rule.
export const preflightFailureSchema = (jobType) => object({
    ok: { const: false },
    status: { const: 'failed' },
    jobType: { const: jobType },
    stopReason: { type: 'null' },
    error: object({
        code: { const: 'PREFLIGHT_FAILED' },
        message: { type: 'string', minLength: 1, maxLength: 500 },
        stage: { const: 'preflight' },
        retryable: { const: false },
    }, ['code', 'message', 'stage', 'retryable']),
}, ['ok', 'status', 'jobType', 'error', 'stopReason']);
export const ozonScopeGuard = 'e-Comet Ozon tools cover exactly three needs: Ozon Seller promotion analytics reports, Ozon Seller general analytics reports, and Ozon search places of given SKUs for given queries. ' +
    'When the user asks for any other Ozon report or data (returns, finance, products, traffic, campaigns, orders), no e-Comet Ozon tool applies: ' +
    'do not call browser_job, do not substitute the nearest tool, and do not run any Ozon tool as a probe; say that only these three exist and ask what the user wants. ';
export const ozonHookInjection = 'The trusted Claude Code or Codex host hook injects the opaque transport-only triggerUrl; model-authored arguments must omit both triggerUrl and trigger_url. ' +
    coworkCopyStep +
    'Never decode, print, edit, or expose that authorization. ';
export const ozonPackageContext = 'The extension automatically uses the first ready Seller context and pins its company for this package; never ask the user to focus a tab. A fresh authorization uses the then-current context and does not guarantee the previous company. ' +
    'Do not use local_bridge_status to pre-approve or skip the signed operation; the family capability and typed operation result are authoritative. ';
export const ozonHandoffGuidance = 'OZON_AUTHORIZATION_REJECTED with the message "The trusted browser-job hook did not provide Ozon authorization." is the same missing handoff; treat it exactly like BROWSER_JOB_HANDOFF_REQUIRED. ';
export const ozonPackageAuthorizationWorkflow = (browserJobType, businessArguments) => ozonScopeGuard +
    `Call the remote browser_job exactly once with job {type:"${browserJobType}",${businessArguments}}, then invoke this local tool exactly once with the identical business array. ` +
    ozonHookInjection +
    'Never automatically retry browser_job or the local report call; a fresh authorization requires an explicit user-directed retry. ' +
    'Caller order is execution priority; acceptance does not guarantee that every item will finish. ' +
    'For a user-directed continuation, include only the selected skipped items in a fresh package. Do not silently include completed or failed items. ' +
    'CREATE_OUTCOME_UNKNOWN means creation may already have succeeded: explain that uncertainty and obtain a separate, item-specific retry decision. ' +
    'Neither report family currently provides safe automated reconciliation; ordinary promotion preflight may create another report. ' +
    'Use itemIndex to correlate the ordered results and stopReason to explain skipped work; a null stopReason means nothing was skipped, not that every item succeeded. ' +
    'OZON_EXECUTION_INTERRUPTED identifies an internal phase-delivery failure, not a Seller login or route diagnosis. ' +
    'Use its safe phase/createOutcome evidence: confirmed creation must not be repeated automatically; skipped work has not run. Offer an e-Comet bug report for persistent internal failures. ' +
    ozonPackageContext +
    ozonHandoffGuidance;
export const liveToolAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
};
// Report generation adds saved marketplace reports even though its business purpose is data retrieval.
export const reportToolAnnotations = { ...liveToolAnnotations, readOnlyHint: false };
