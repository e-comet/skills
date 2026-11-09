import { authorizationEndGuidance, authorizationWorkflow, completeContractGuidance, localBridgeFailureGuidance, rejectionAndHandoffGuidance, runningAnswerGuidance, signedDiscovery, } from '../../transport/mcp/prose.mjs';
import { toolErrorSchema, withOperationDiagnostic, withRunningAnswer } from '../../transport/mcp/results.mjs';
import { array, boolean, nonNegativeInteger, nullableNonNegativeInteger, object, objectUnion, positiveInteger, } from '../../transport/mcp/schema.mjs';
import { buyerOutcomeGuidance, liveAggregateSchemas, liveBaseProperties, liveInputSchema, liveToolAnnotations, pageSchema, resultPathGuidance, } from './live.mjs';
const recommendationArticleSchema = object({
    sourceNmId: positiveInteger,
    pagesRequested: positiveInteger,
    pagesSucceeded: nonNegativeInteger,
    overallTotal: nonNegativeInteger,
    totalPages: nullableNonNegativeInteger,
    productsSeen: nonNegativeInteger,
    productsReturned: nonNegativeInteger,
    truncatedByLocalLimit: boolean,
    globalPositionsComplete: boolean,
    pages: array(pageSchema),
}, [
    'sourceNmId',
    'pagesRequested',
    'pagesSucceeded',
    'productsSeen',
    'productsReturned',
    'truncatedByLocalLimit',
    'globalPositionsComplete',
    'pages',
]);
const recommendationsSuccessSchema = object({
    stopReason: { const: 'rate_limited' },
    ...liveBaseProperties,
    jobType: { const: 'recommendations_by_product' },
    complete: boolean,
    truncatedByLocalLimit: boolean,
    pagesRequested: positiveInteger,
    pagesSucceeded: nonNegativeInteger,
    pagesFailed: nonNegativeInteger,
    productFilterApplied: boolean,
    productLimitPerSource: positiveInteger,
    articles: array(recommendationArticleSchema),
}, [
    'ok',
    'status',
    'jobType',
    'jobId',
    'resultPath',
    'complete',
    'truncatedByLocalLimit',
    'pagesRequested',
    'pagesSucceeded',
    'pagesFailed',
    'productFilterApplied',
    'articles',
]);
const recommendationsContract = 'Get live Wildberries recommendation shelves for source article IDs and check whether specific products occur in them. Use for Russian requests about рекомендации, похожие товары, рекомендательная полка, соседние товары, or whether a product встречается в рекомендациях. ' +
    authorizationWorkflow +
    localBridgeFailureGuidance +
    buyerOutcomeGuidance +
    rejectionAndHandoffGuidance +
    'Authorize with job {type:"recommendations_by_product",products:[{product_id:integer,pages?:integer},...]}; use unique source product IDs, at most 50 pages for each product, and 1000 pages total; an omitted pages value counts as 50 toward the total. ' +
    'For первые N recommendations, explicitly request pages: 1 and pass local productLimitPerSource: N. Omit pages only when the user explicitly needs the whole discovered shelf within local limits. ' +
    'For a membership check, put исходные товары in remote job.products and целевые товары in local productNmIds. Read articles[].pages[].products and group results by sourceNmId. ' +
    'Use globalPosition only when globalPositionsComplete is true. If a target is absent, claim only that it was not found in the successfully requested part of that source shelf. ' +
    'Disclose status partial/failed, failed pages, complete:false, and truncatedByLocalLimit:true. Recommendations are a current WB-session snapshot. ' +
    resultPathGuidance;
export const contract = {
    name: 'wb_recommendations_by_product',
    description: 'Get live WB recommendation shelves (similar products) by source article and check target-product membership. ' +
        signedDiscovery('wb_recommendations_by_product', 'recommendations_by_product') +
        'Never automatically repeat rate-limited work; retain partial results. Group by sourceNmId; absence is limited to the successfully requested part of that source shelf. Disclose failed pages, complete:false and truncatedByLocalLimit:true. ' +
        completeContractGuidance,
    inputSchema: liveInputSchema('productLimitPerSource', 'source product'),
    outputSchema: withRunningAnswer(withOperationDiagnostic(objectUnion(...liveAggregateSchemas(recommendationsSuccessSchema), toolErrorSchema))),
    annotations: liveToolAnnotations,
    workflow: {
        appliesTo: ['browser_job', 'wb_recommendations_by_product'],
        text: `${recommendationsContract.trimEnd()} ${authorizationEndGuidance} ${runningAnswerGuidance}`,
    },
};
