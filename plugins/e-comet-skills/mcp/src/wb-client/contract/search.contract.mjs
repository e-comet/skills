import { authorizationEndGuidance, authorizationWorkflow, completeContractGuidance, localBridgeFailureGuidance, rejectionAndHandoffGuidance, runningAnswerGuidance, signedDiscovery, } from '../../transport/mcp/prose.mjs';
import { toolErrorSchema, withOperationDiagnostic, withRunningAnswer } from '../../transport/mcp/results.mjs';
import { array, boolean, nonNegativeInteger, object, objectUnion, positiveInteger, string } from '../../transport/mcp/schema.mjs';
import { buyerOutcomeGuidance, liveAggregateSchemas, liveBaseProperties, liveInputSchema, liveToolAnnotations, pageSchema, resultPathGuidance, } from './live.mjs';
const searchQuerySchema = object({
    query: string,
    pagesRequested: positiveInteger,
    pagesSucceeded: nonNegativeInteger,
    productsSeen: nonNegativeInteger,
    productsReturned: nonNegativeInteger,
    globalPositionsComplete: boolean,
    pages: array(pageSchema),
}, ['query', 'pagesRequested', 'pagesSucceeded', 'productsSeen', 'productsReturned', 'globalPositionsComplete', 'pages']);
const searchSuccessSchema = object({
    stopReason: { const: 'rate_limited' },
    ...liveBaseProperties,
    jobType: { const: 'search_by_query' },
    pagesRequested: positiveInteger,
    pagesSucceeded: nonNegativeInteger,
    pagesFailed: nonNegativeInteger,
    productFilterApplied: boolean,
    productLimitPerQuery: positiveInteger,
    queries: array(searchQuerySchema),
}, [
    'ok',
    'status',
    'jobType',
    'jobId',
    'resultPath',
    'pagesRequested',
    'pagesSucceeded',
    'pagesFailed',
    'productFilterApplied',
    'queries',
]);
const searchContract = 'Get live Wildberries search results, top products, and positions for one or more phrases. Use for Russian requests about поиск, поисковая выдача, позиция товара, место по запросу, or топ товаров. ' +
    authorizationWorkflow +
    localBridgeFailureGuidance +
    buyerOutcomeGuidance +
    rejectionAndHandoffGuidance +
    'Authorize with job {type:"search_by_query",queries:[{query:string,pages:integer},...]}; use at most 50 pages for each query and 1000 pages total. Start with 1 page for a top list or 2-3 pages when depth is unspecified. ' +
    'For a targeted rank check, put phrases in remote job.queries and target article IDs in local productNmIds. For a top N list, use productLimitPerQuery:N. ' +
    'Read queries[].pages[].products. Use globalPosition only when globalPositionsComplete is true; position is page-local. promoted is always boolean: promoted:true means реклама (paid placement), promoted:false means органика. ' +
    'One product occupies exactly one position per phrase in a snapshot: WB does not also list it organically when it is already rendered as реклама. ' +
    'If a product appears as promoted:true, its organic position for that phrase is not observed at all in this snapshot — not "not found", but fundamentally not visible. ' +
    'Do not infer presence or absence of organic ranking from promoted:true, and never claim the product is "absent from organics" / «нет в органике». ' +
    'Correct wording: "position N, рекламная; organic position for this phrase cannot be determined from this snapshot". ' +
    'To observe the organic position, take a snapshot when реклама for that phrase is not running. ' +
    'If a target is absent, claim only that it was not found within the requested pages/positions, never that it is absent from all WB search results or from organics. Group multiple phrases separately and disclose failed pages. ' +
    'Results are a current WB-session snapshot. ' +
    resultPathGuidance;
export const contract = {
    name: 'wb_search_by_query',
    description: 'Get live WB search positions and top products by phrase. ' +
        signedDiscovery('wb_search_by_query', 'search_by_query') +
        'Never automatically repeat rate-limited work; retain partial results. promoted:true is paid placement; its organic position is not observed. Incomplete pages limit any absence claim to successfully requested coverage. ' +
        completeContractGuidance,
    inputSchema: liveInputSchema('productLimitPerQuery', 'query'),
    outputSchema: withRunningAnswer(withOperationDiagnostic(objectUnion(...liveAggregateSchemas(searchSuccessSchema), toolErrorSchema))),
    annotations: liveToolAnnotations,
    workflow: {
        appliesTo: ['browser_job', 'wb_search_by_query'],
        text: `${searchContract.trimEnd()} ${authorizationEndGuidance} ${runningAnswerGuidance}`,
    },
};
