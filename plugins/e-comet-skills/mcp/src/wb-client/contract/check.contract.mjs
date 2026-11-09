import { authorizationEndGuidance, authorizationWorkflow, completeContractGuidance, localBridgeFailureGuidance, rejectionAndHandoffGuidance, runningAnswerGuidance, signedDiscovery, } from '../../transport/mcp/prose.mjs';
import { toolErrorSchema, withOperationDiagnostic, withRunningAnswer } from '../../transport/mcp/results.mjs';
import { array, boolean, integer, nonNegativeInteger, object, objectUnion, positiveInteger, string } from '../../transport/mcp/schema.mjs';
import { buyerErrorProperties, buyerOutcomeGuidance, liveAggregateSchemas, liveBaseProperties, liveInputSchema, liveToolAnnotations, resultPathGuidance, } from './live.mjs';
const checkProductSchema = object({
    nmId: positiveInteger,
    name: string,
    brand: string,
}, ['nmId']);
const checkQueryProperties = {
    ...buyerErrorProperties,
    query: string,
    pagesChecked: nonNegativeInteger,
    httpStatus: integer,
    error: string,
};
const checkQueryRequired = ['query', 'found', 'pagesChecked', 'completionReason'];
const checkQuerySchema = objectUnion(object({
    ...checkQueryProperties,
    found: { const: true },
    completionReason: { const: 'found' },
}, checkQueryRequired), object({
    ...checkQueryProperties,
    found: { const: false },
    completionReason: {
        type: 'string',
        enum: ['empty_page', 'repeated_page', 'page_limit', 'request_failed', 'card_failed'],
    },
}, checkQueryRequired));
const checkSuccessSchema = object({
    stopReason: { const: 'rate_limited' },
    ...liveBaseProperties,
    jobType: { const: 'check_by_query' },
    complete: boolean,
    product_id: positiveInteger,
    product: checkProductSchema,
    requestsMade: positiveInteger,
    queries: array(checkQuerySchema),
}, ['ok', 'status', 'jobType', 'jobId', 'resultPath', 'complete', 'product_id', 'requestsMade', 'queries']);
const checkContract = 'Check whether one Wildberries article appears in search results for 1-100 phrases. Use for Russian requests about проверка артикула в выдаче, находится ли артикул по фразе, индексируется ли товар, or по каким запросам виден товар. ' +
    authorizationWorkflow +
    localBridgeFailureGuidance +
    buyerOutcomeGuidance +
    rejectionAndHandoffGuidance +
    'Authorize with job {type:"check_by_query",product_id:integer,queries:[string,...]}; send one positive product ID and 1-100 unique non-empty phrases. Page depth is fixed by the service; do not supply it. ' +
    'Read queries[] separately. For found:true, report only that the product was found for the phrase. For found:false, report only that the product was not found for the phrase. ' +
    'Do not mention pagesChecked, completionReason, page limits, or brand-filtered depth unless the user explicitly asks for diagnostics. Never present pagesChecked as a page, position, rank, or search depth in ordinary unfiltered search. ' +
    'request_failed and card_failed mean the check was incomplete; report that the check was incomplete rather than reporting the product as not found. ' +
    'Do not claim that the product is absent from all Wildberries search results. Results are a current WB-session snapshot. ' +
    resultPathGuidance;
export const contract = {
    name: 'wb_check_by_query',
    description: 'Check whether one WB article appears for queries. ' +
        signedDiscovery('wb_check_by_query', 'check_by_query') +
        'Never automatically repeat rate-limited work; retain partial results. found:true/false means found/not found for that phrase; request_failed or card_failed means incomplete, not not found. Never interpret pagesChecked as rank or ordinary search depth, or claim absence from all WB results. ' +
        completeContractGuidance,
    inputSchema: liveInputSchema(),
    outputSchema: withRunningAnswer(withOperationDiagnostic(objectUnion(...liveAggregateSchemas(checkSuccessSchema), toolErrorSchema))),
    annotations: liveToolAnnotations,
    workflow: {
        appliesTo: ['browser_job', 'wb_check_by_query'],
        text: `${checkContract.trimEnd()} ${authorizationEndGuidance} ${runningAnswerGuidance}`,
    },
};
