import { COMPARISON_CREATE_OUTCOMES, COMPARISON_FAILURE_REASONS, COMPARISON_FILE_STATUSES, COMPARISON_LOCAL_MINUTE_PATTERN, COMPARISON_PERIODS, COMPARISON_STAGES, COMPARISON_STREAM_DEADLINE, } from '../../transport/extension/wire.mjs';
import { completeContractGuidance, coworkCopyStep, rejectionAndHandoffGuidance, sellerCabinetRecoveryGuidance, } from '../../transport/mcp/prose.mjs';
import { failureDetailsSchema, fileDeliverySchema, toolErrorSchema, triggerUrlProperty, withOperationDiagnostic, withRunningAnswer, } from '../../transport/mcp/results.mjs';
import { array, boolean, nonNegativeInteger, object, objectUnion, positiveInteger, string } from '../../transport/mcp/schema.mjs';
const organization = object({ id: string, name: string }, ['id']);
const selectedOrganization = objectUnion(organization, object({ name: string }, ['name']));
const day = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const dateRange = object({ dateFrom: day, dateTo: day }, ['dateFrom', 'dateTo']);
const stage = { type: 'string', enum: COMPARISON_STAGES.filter((value) => value !== 'list_orgs') };
const outcome = { type: 'string', enum: [...COMPARISON_CREATE_OUTCOMES] };
const workbook = object({
    name: string,
    path: string,
    uri: string,
    mimeType: { const: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    size: positiveInteger,
    sha256: { type: 'string', minLength: 64, maxLength: 64 },
}, ['name', 'path', 'uri', 'mimeType', 'size', 'sha256']);
const exportFields = {
    org: selectedOrganization,
    nmIds: array(positiveInteger, { minItems: 2, maxItems: 5, uniqueItems: true }),
    period: { oneOf: [{ type: 'string', enum: [...COMPARISON_PERIODS] }, dateRange] },
    sizeDetails: boolean,
    dateFrom: day,
    dateTo: day,
    source: { type: 'string', enum: ['history', 'created'] },
    createOutcome: outcome,
    orderOutcome: outcome,
    exportId: string,
    fileStatus: { type: 'string', enum: [...COMPARISON_FILE_STATUSES] },
    report: object({
        name: string,
        generatedAt: { oneOf: [string, { type: 'null' }] },
        generatedAtLocal: {
            oneOf: [{ type: 'string', pattern: COMPARISON_LOCAL_MINUTE_PATTERN }, { type: 'null' }],
            description: 'The readiness minute shown in the seller browser, with the UTC offset for that instant.',
        },
        startDate: day,
        endDate: day,
    }, ['name', 'generatedAt']),
    artifact: workbook,
    fileDelivery: fileDeliverySchema,
    releaseError: toolErrorSchema,
};
const exportResult = object({
    ...exportFields,
    ok: boolean,
    status: { const: 'complete' },
    stage: { const: 'download_xlsx' },
}, [
    'ok',
    'status',
    'stage',
    'org',
    'nmIds',
    'period',
    'sizeDetails',
    'dateFrom',
    'dateTo',
    'source',
    'createOutcome',
    'orderOutcome',
    'exportId',
    'fileStatus',
    'artifact',
]);
const stageFailure = object({
    ...exportFields,
    ok: { const: false },
    status: { type: 'string', enum: ['failed', 'partial', 'complete'] },
    stage,
    code: string,
    message: string,
    retryable: { const: false },
    reason: { type: 'string', enum: [...COMPARISON_FAILURE_REASONS] },
    periodWindow: dateRange,
    comparisonLimits: object({ availableComparisons: nonNegativeInteger, remainingInPeriod: nonNegativeInteger }, [
        'availableComparisons',
    ]),
    details: objectUnion(failureDetailsSchema, object({ reason: { const: COMPARISON_STREAM_DEADLINE.reason } }, ['reason'])),
}, ['ok', 'status', 'stage', 'code', 'message', 'retryable']);
const preparationFailure = { ...toolErrorSchema, properties: { ...toolErrorSchema.properties, releaseError: toolErrorSchema } };
const workflow = 'Compare the requested cards and return one original XLSX from the active WB Seller company by default. ' +
    'Each export orders one fresh Excel file even when it reuses a saved comparison. If the seller forbids a new Excel order, explain that this tool needs its own order and stop before signing. ' +
    'Call browser_job once with one seller_card_comparison job, then call this tool. Use one of these example job forms ' +
    '`{"type":"seller_card_comparison","product_ids":[3002,1001],"period":"week"}` or ' +
    '`{"type":"seller_card_comparison","product_ids":[3002,1001],"dateFrom":"2026-11-13","dateTo":"2026-11-18","sizeDetails":true}`. ' +
    'Omit org for the active company. For an explicit choice, set org to {id} with the canonical WB supplier ID returned by wb_seller_list_orgs or {name} with the exact company name. Use wb_seller_list_orgs if the seller asks for companies or needs the canonical ID. ' +
    'Supply one set of 2–5 different positive safe integer WB article IDs, in the requested order. Keep the entire set for every subscription. ' +
    'Use period only for a preset string (today, week, month or quarter). For exact dates, pass both top-level YYYY-MM-DD fields dateFrom and dateTo together and omit period entirely. Omit period, dateFrom and dateTo to use month. ' +
    'Exact dates must be real calendar dates in order and span 1–90 days inclusive, within the last 90 calendar days through today in the seller’s browser. Preserve the dates the seller requested. ' +
    'Today, week and quarter span 1, 7 and 90 local days. WB calendar month starts at the day obtained by going back one calendar month; the older month button spans 30 days. The seller browser determines today. Set sizeDetails:true for size breakdown in Excel; the default is false. ' +
    'allowNewComparison defaults to false and only governs comparison creation. Use true if the seller asked to compare these cards, rather than only retrieve a ready comparison. The grant permits at most one new comparison. Subscription purchases and upgrades are outside the workflow. ' +
    'Wait for each browser_job; call this tool in a later step. Native Codex and Claude Code hooks and the DeepSeek adapter inject authorization. Omit triggerUrl and trigger_url. ' +
    coworkCopyStep +
    'Never decode, edit, print or expose it. ' +
    'For a missing tool, repeat host tool search up to three times. Do not infer an authorization failure from client status. A connected EXTENSION_UPDATE_REQUIRED means the extension lacks comparison support; relay its update step. A BRIDGE_* code identifies the local connection problem; follow its message. ' +
    sellerCabinetRecoveryGuidance +
    'For ENTITY_SELECTION_REQUIRED with details.reason="multiple_seller_documents", ask the seller to leave one Wildberries Seller tab in the connected profile and wait until it loads. ' +
    'For a duplicate company name use the canonical ID from wb_seller_list_orgs. If restoration requires an explicit choice (details.reason="comparison_orphan"), leave one ready Seller tab and ask the seller to choose the company before requesting a fresh grant with org, or have them manually select a different company in WB Seller. ' +
    'complete returns the actual company, articles, inclusive dates, requested sizeDetails, source and one private workbook resource_link. Pass the link to the seller; workbook bytes never enter model context. The archive and the workbook each have a 100 MiB limit. ' +
    'On new_comparison_required from compare, relay the observed comparisonLimits if present (including zero) and ask the seller whether to allow one new comparison if the evidence permits it. For new_comparison_required during create_xlsx, the saved comparison is no longer reusable; use the returned outcomes to explain what happened. ' +
    'On compare/history_charge_required, report WB’s decision that the saved comparison is no longer free to reopen and show the observed comparisonLimits. With a history-only grant and an observed usable balance, ask if the seller wants one charged comparison. If the grant already allowed creation, report the terminal refusal and both outcomes. Let the seller decide the next step. ' +
    'For period_out_of_range, show periodWindow and ask the seller to choose dates within it. For period_unavailable, offer the today, week, month and quarter buttons or their exact dates. For access_unknown, relay the observed failure message and follow its step. Keep the signed period and size selection until the seller chooses a change. ' +
    'comparison_limit or export_limit means WB refused further work. Purchases are outside this workflow. cards_unavailable applies to the full set. HTTP 429 stops the job. ' +
    'access_denied confirms a refusal for the chosen company. If both write outcomes are not_sent, offer another company from the current seller catalog. Wait for the seller’s explicit choice before requesting a fresh signed export. ' +
    'createOutcome and orderOutcome are independent: not_sent, confirmed, rejected, unknown. Keep unknown outcomes even if the other write succeeded or a workbook was recovered. A failed opening after confirmed creation preserves the actual company and selected dates. If the job ends after a possible comparison or order, report the company, known dates, sizeDetails, last fileStatus and observed report fields, then use its Downloads or history recovery step. ' +
    'Never automatically repeat a write or start a replacement order. An expired or interrupted job, including a lost write response, needs same-file recovery when possible. Keep the one set of articles. A later new comparison or order needs the seller’s specific decision. ' +
    'A running result means the existing operation continues. Tell the seller its progress and call e_comet_run_result with that runId until terminal. ' +
    'For an export releaseError, ask the seller to check the active company and keep any completed local XLSX. fileDelivery reports copying to the host e-comet-reports folder independently of the export. For a copy failure recover the original resource_link using the exact artifact.path or URI and verify the file by size and SHA-256. Retention is 24 hours. ' +
    'For Cowork without a project, copies go to Documents/e-comet-reports; request access to that folder only at the seller’s direction. Never ask to mount internal plugin or session storage. The workbook report label and generatedAt are observations from WB; an unknown generatedAt stays unknown. ' +
    rejectionAndHandoffGuidance +
    'RUN_RESULT_UNAVAILABLE means the outcome is unknown: recover from Downloads or history; start a new comparison or order again only if the user asks.';
export const contract = {
    name: 'wb_seller_card_comparison',
    description: 'Compare 2-5 WB cards in the active company. Exports order fresh Excel even from history. If seller forbids it, explain and stop before signing. ' +
        'Unless this task has its complete contract, await describe_e_comet_tool({name:"wb_seller_card_comparison"}). ' +
        'Then await one browser_job with seller_card_comparison and call this tool once. ' +
        'Omit triggerUrl/trigger_url. Native handoff injects it. ' +
        'Only mcp__remote-devices__: trigger_url unchanged as triggerUrl. Keep secret. ' +
        'New comparisons need consent. No auto-repeat. ' +
        'Return the original XLSX for the full ordered set and recover any existing workbook. ' +
        'Specify org only for an explicit company choice. For company lists use wb_seller_list_orgs. ' +
        completeContractGuidance,
    inputSchema: object({ triggerUrl: triggerUrlProperty }),
    outputSchema: withRunningAnswer(withOperationDiagnostic(objectUnion(exportResult, stageFailure, preparationFailure))),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    workflow: { appliesTo: ['browser_job', 'wb_seller_card_comparison'], text: workflow.trimEnd() },
};
