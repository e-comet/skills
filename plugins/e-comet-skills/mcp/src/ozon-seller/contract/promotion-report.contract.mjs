import { artifactRejectedDetailsSchema, canonicalDateProperty, localStorageUnavailableSchema, ozonAuthorizationRejectedDetailsSchema, ozonHandoffGuidance, ozonHookInjection, ozonPromotionArtifactSchema, ozonScopeGuard, ozonTriggerUrlProperty, reportToolAnnotations, } from './reports.mjs';
import { EXTENSION_UPDATE_URL, OZON_PROMOTION_CAPABILITY, OZON_PROMOTION_MIN_EXTENSION_VERSION } from '../../transport/extension/wire.mjs';
import { OZON_EXTENSION_OUTDATED_REASON, OZON_PROMOTION_TERMINAL_CODE_STAGES } from '../../transport/failures/vocabulary.mjs';
import { BRIDGE_FAILURE_GUIDANCE, authorizationEndGuidance, completeContractGuidance, rejectionAndHandoffGuidance, reportDeliveryGuidance, runningAnswerGuidance, signedDiscovery, } from '../../transport/mcp/prose.mjs';
import { fileDeliverySchema, withOperationDiagnostic, withRunningAnswer } from '../../transport/mcp/results.mjs';
import { object, objectUnion, string } from '../../transport/mcp/schema.mjs';
// Устаревшее расширение не получает собственный терминальный код: набор кодов зафиксирован в общем
// с расширением контракте. Диагноз едет в message и в этих полях, поэтому его видно и агенту, и в
// структурированном ответе, а обычный отказ маршрута остаётся без details.
const ozonExtensionOutdatedDetailsSchema = object({
    reason: { const: OZON_EXTENSION_OUTDATED_REASON },
    requiredCapability: { const: OZON_PROMOTION_CAPABILITY },
    requiredExtensionVersion: { const: OZON_PROMOTION_MIN_EXTENSION_VERSION },
    updateUrl: { const: EXTENSION_UPDATE_URL },
    installedExtensionVersion: string,
}, ['reason', 'requiredCapability', 'requiredExtensionVersion', 'updateUrl']);
const ozonPromotionErrorSchema = objectUnion(...Object.entries(OZON_PROMOTION_TERMINAL_CODE_STAGES).map(([code, stage]) => object({
    code: { const: code },
    message: { type: 'string', minLength: 1, maxLength: 500 },
    stage: { const: stage },
    retryable: { const: false },
    ...(code === 'OZON_ROUTE_NOT_READY' ? { details: ozonExtensionOutdatedDetailsSchema } : {}),
    ...(code === 'OZON_AUTHORIZATION_REJECTED' ? { details: ozonAuthorizationRejectedDetailsSchema } : {}),
    ...(code === 'ARTIFACT_REJECTED' ? { details: artifactRejectedDetailsSchema } : {}),
}, ['code', 'message', 'stage', 'retryable'])));
const ozonPromotionSuccessSchema = object({
    ok: { const: true },
    status: { const: 'complete' },
    jobType: { const: 'ozon_seller_promotion_report' },
    dateFrom: canonicalDateProperty,
    dateTo: canonicalDateProperty,
    artifact: ozonPromotionArtifactSchema,
    fileDelivery: fileDeliverySchema,
}, ['ok', 'status', 'jobType', 'dateFrom', 'dateTo', 'artifact']);
const ozonPromotionFailureSchema = object({
    ok: { const: false },
    status: { const: 'failed' },
    jobType: { const: 'ozon_seller_promotion_report' },
    dateFrom: canonicalDateProperty,
    dateTo: canonicalDateProperty,
    error: objectUnion(ozonPromotionErrorSchema, localStorageUnavailableSchema),
}, ['ok', 'status', 'jobType', 'dateFrom', 'dateTo', 'error']);
const ozonPromotionPreflightFailureSchema = object({
    ok: { const: false },
    status: { const: 'failed' },
    jobType: { const: 'ozon_seller_promotion_report' },
    error: object({
        code: { const: 'PREFLIGHT_FAILED' },
        message: { type: 'string', minLength: 1, maxLength: 500 },
        stage: { const: 'preflight' },
        retryable: { const: false },
    }, ['code', 'message', 'stage', 'retryable']),
}, ['ok', 'status', 'jobType', 'error']);
const ozonAuthorizationWorkflow = ozonScopeGuard +
    'This typed local tool owns the Ozon workflow. First call the remote browser_job({job:{type:"ozon_seller_promotion_report",dateFrom,dateTo}}) exactly once, then invoke this tool with the same dates as soon as it returns, never in the same parallel step. ' +
    ozonHookInjection +
    'local_bridge_status reports legacy WB browser context and must not be used to gate this Ozon tool; the Ozon capability and typed operation result are authoritative. ' +
    'Its extension version and Ozon capability fields are informational only: use them to explain a failure, never to skip or pre-approve this call. ';
const promotionContract = 'Download the Ozon Seller promotion analytics report for one requested period as one XLSX workbook. ' +
    ozonAuthorizationWorkflow +
    reportDeliveryGuidance +
    rejectionAndHandoffGuidance +
    BRIDGE_FAILURE_GUIDANCE +
    ozonHandoffGuidance +
    'Use canonical inclusive dateFrom/dateTo dates with at most 89 inclusive days. One call produces one period and one workbook. ' +
    'Neighboring analytics are unavailable in this first tool: it does not provide product, traffic, finance, campaign, or other Ozon reports. ' +
    'The operation may create a saved report in Ozon, but it does not change products, campaigns, budgets, or seller settings. ' +
    'CREATE_OUTCOME_UNKNOWN means the report may already exist: explain the uncertainty and obtain a separate user decision before another create attempt; never automatically retry it. ' +
    'For legacy singular compatibility, ARTIFACT_REJECTED may describe an internal acknowledgement failure in its message; the code alone is not proof of a disk problem. Preserve any stated confirmed create outcome and do not repeat it automatically. ' +
    'An OZON_ROUTE_NOT_READY failure carrying error.details.reason "extension_outdated" means the installed e-Comet extension is too old for this report: tell the user to update the extension to the version in error.details and retry, ' +
    `and do not tell them to open the report page. This operation requires extension ${OZON_PROMOTION_MIN_EXTENSION_VERSION} or newer and any authenticated Ozon Seller page under https://seller.ozon.ru/app, not an exact promotion-overview route and never a Wildberries tab. ` +
    'The same code without those details means no ready Ozon route was reachable: when its message names the step (open an Ozon Seller tab, choose one company, sign out and in again), relay that step; otherwise it does not establish a cause. A timeout is not proof of disconnection. If status reports extensionConnected:false, its code names the cause; never invent another. ' +
    'For an unready route whose message names no step, ask the user to check the extension in the same browser profile and refresh any authenticated Ozon /app page, then obtain a new authorization before retrying; when the message says the browser connection closed, check local_bridge_status instead of a page. Never reuse the consumed one-use authorization, automatically loop, or use WB-tab recovery for Ozon. ' +
    'Returns compact metadata and exactly one private resource_link. The resource_link contains a local file URI; workbook bytes, base64, company context, report identifiers, and request details are not included in model content.';
export const contract = {
    name: 'ozon_seller_promotion_report',
    description: 'Download one Ozon Seller promotion report XLSX for one requested period. ' +
        signedDiscovery('ozon_seller_promotion_report', 'ozon_seller_promotion_report') +
        'May create a saved report. CREATE_OUTCOME_UNKNOWN means creation may have succeeded: obtain a separate retry decision. Never automatically repeat uncertain creates, rate-limited work or completed reports for delivery failure; preserve the private resource link and recover the same workbook. ' +
        "An unready route's message names its step when the extension knows the cause; extension_outdated details require an extension update. Never use WB-tab recovery or local_bridge_status to gate Ozon. " +
        completeContractGuidance,
    inputSchema: object({
        dateFrom: canonicalDateProperty,
        dateTo: canonicalDateProperty,
        triggerUrl: ozonTriggerUrlProperty,
    }, ['dateFrom', 'dateTo']),
    outputSchema: withRunningAnswer(withOperationDiagnostic(objectUnion(ozonPromotionSuccessSchema, ozonPromotionFailureSchema, ozonPromotionPreflightFailureSchema))),
    annotations: reportToolAnnotations,
    workflow: {
        appliesTo: ['browser_job', 'ozon_seller_promotion_report'],
        text: `${promotionContract.trimEnd()} ${authorizationEndGuidance} ${runningAnswerGuidance}`,
    },
};
