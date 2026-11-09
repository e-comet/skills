import { BRIDGE_FAILURE_GUIDANCE, authorizationEndGuidance, completeContractGuidance, coworkCopyStep, rejectionAndHandoffGuidance, runningAnswerGuidance, signedDiscovery, } from '../../transport/mcp/prose.mjs';
import { failureDetailsSchema, fileDeliverySchema, toolErrorSchema, triggerUrlProperty, withOperationDiagnostic, withRunningAnswer, } from '../../transport/mcp/results.mjs';
import { array, boolean, nonNegativeInteger, object, objectUnion, positiveInteger, string } from '../../transport/mcp/schema.mjs';
const sellerArtifactSchema = object({
    name: string,
    path: string,
    uri: string,
    mimeType: { const: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    size: nonNegativeInteger,
    sha256: { type: 'string', minLength: 64, maxLength: 64 },
}, ['name', 'path', 'uri', 'mimeType', 'size', 'sha256']);
const sellerExportErrorSchema = object({
    code: string,
    message: string,
    stage: string,
    retryable: boolean,
    details: failureDetailsSchema,
}, ['code', 'message', 'stage', 'retryable']);
const sellerExportSchema = object({
    product_id: positiveInteger,
    dateFrom: string,
    dateTo: string,
    isAnswered: boolean,
    ratings: array({ type: 'integer', minimum: 1, maximum: 5 }, { minItems: 1, maxItems: 5, uniqueItems: true }),
    content: { const: 'media' },
    status: { type: 'string', enum: ['complete', 'failed', 'skipped'] },
    artifact: sellerArtifactSchema,
    error: sellerExportErrorSchema,
}, ['isAnswered', 'status']);
const sellerReviewsSuccessSchema = object({
    fileDelivery: fileDeliverySchema,
    ok: boolean,
    status: { type: 'string', enum: ['complete', 'partial', 'failed'] },
    jobType: { const: 'seller_reviews' },
    jobId: string,
    org: object({ id: string, name: string }, [], false),
    exports: array(sellerExportSchema, { minItems: 1 }),
    // Present when Wildberries answered a status poll in an unrecognized shape and the export stopped.
    stopReason: { const: 'unrecognized_response' },
    // Present when the exports themselves are described accurately but restoring the seller cabinet failed.
    releaseError: toolErrorSchema,
}, ['ok', 'status', 'jobType', 'jobId', 'exports']);
const sellerReviewsContract = 'Original WB seller-review XLSX. ' +
    'Call remote browser_job once: job {type:"seller_reviews",exports:[{product_id?:int,dateFrom?,dateTo?,isAnswered?:bool,ratings?:[1|2|3|4|5,...],content?},...],org?}, then this tool once it returns, never in the same parallel step. ' +
    'Trusted Claude Code/Codex hooks inject authorization: omit triggerUrl/trigger_url. ' +
    coworkCopyStep +
    'Never decode, print, edit or expose it. ' +
    'Never infer authorization failure from status. ' +
    rejectionAndHandoffGuidance +
    'Repeat host tool search up to 3x for a missing tool; never repeat browser_job or this tool; explain confirmed errors. ' +
    'One array includes all filters. ' +
    'Omit product_id/ratings/content for all products/ratings/content; content:"media" means photo/video. ' +
    'Omitted dates mean all time; otherwise both inclusive YYYY-MM-DD dates. ' +
    'Omitted isAnswered produces separate answered and unanswered workbooks. ' +
    'Omit org for active seller company; another requires explicit user choice and one signed {id} or exact {name}. ' +
    'For legacy-restoration ENTITY_SELECTION_REQUIRED, ask company, then reauthorize explicitly; never guess. ' +
    "SELLER_LOGIN_REQUIRED means no signed-in seller cabinet tab: the user opens seller.wildberries.ru in the browser where the extension is connected and signs in; then one fresh browser_job on the user's decision. " +
    "SELLER_AUTH_UNAVAILABLE with reason access_token_missing, seller_token_missing or both_missing: the user reloads the seller portal tab and signs in if it asks, then one fresh browser_job on the user's decision; the same reason again, header_too_long or reader_failed is an e-Comet defect to report, never repeated. " +
    'stopReason "unrecognized_response" with SELLER_RESPONSE_INVALID: WB answered the report status in a shape e-Comet does not recognize; no user step, an e-Comet defect to report, never repeated. ' +
    'Max 50 exports/100 reports, 100 MiB/XLSX, 500 MiB/job. ' +
    "JOB_ARTIFACT_QUOTA_EXCEEDED: the job's workbooks passed 500 MiB; split it into smaller exports, each with its own browser_job on the user's decision. " +
    'Artifacts retained for 24 hours, never evicted by another export. ' +
    'Return all resource links; summarize complete/failed/skipped. ' +
    'Empty workbook cannot establish ownership. ' +
    'Never auto-retry rate limits/uncertain creates. ' +
    'Project output gets verified e-comet-reports copies; fileDelivery.stage/reason/systemCode diagnose delivery. ' +
    'Cowork without a project: copies in Documents/e-comet-reports; ask the user to allow that folder, then device_request_folder_access it (auto mode refuses unrequested access). ' +
    'Workbooks declare a one-cell sheet range: read every row (openpyxl without read_only). ' +
    'Never mount Cowork internal storage. ' +
    'Use exact resource_link.uri/artifact.path, not name. ' +
    'Opening/search/listing failure cannot prove deletion: check exact file via host filesystem capability; if uncheckable, report verification gap. ' +
    'Recover same workbook; preserve original, verify copies by size/SHA-256; never regenerate for delivery failure. ' +
    BRIDGE_FAILURE_GUIDANCE +
    'LOCAL_STORAGE_FAILED: use details.systemCode/message, never guess. ' +
    'ARTIFACT_TOO_LARGE: no redownload; offer user-selected narrower export, retain workbooks. ' +
    'Metadata/private links only; bytes never enter tool result or model context, no base64. ' +
    'Read/summarize only if separately asked.';
// Report generation adds saved marketplace reports even though its business purpose is data retrieval.
const reportToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
export const contract = {
    name: 'wb_seller_reviews',
    description: 'Export original WB seller-review XLSX workbooks with filters. ' +
        signedDiscovery('wb_seller_reviews', 'seller_reviews') +
        'Return all private resource links, preserve completed workbooks and summarize failed/skipped work; bytes never enter model context. Artifacts are retained for 24 hours. Never automatically retry rate limits or uncertain creates, or regenerate completed reports for delivery failure; recover the same original workbook. ' +
        completeContractGuidance,
    inputSchema: object({ triggerUrl: triggerUrlProperty }),
    outputSchema: withRunningAnswer(withOperationDiagnostic(objectUnion(sellerReviewsSuccessSchema, toolErrorSchema))),
    annotations: reportToolAnnotations,
    workflow: {
        appliesTo: ['browser_job', 'wb_seller_reviews'],
        text: `${sellerReviewsContract.trimEnd()} ${authorizationEndGuidance} ${runningAnswerGuidance}`,
    },
};
