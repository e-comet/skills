import { FETCH_ERROR_CODES } from '../../transport/extension/wire.mjs';
import { authorizationEndGuidance, authorizationWorkflow, completeContractGuidance, localBridgeFailureGuidance, rejectionAndHandoffGuidance, runningAnswerGuidance, signedDiscovery, } from '../../transport/mcp/prose.mjs';
import { closedValue, toolErrorSchema, withOperationDiagnostic, withRunningAnswer } from '../../transport/mcp/results.mjs';
import { array, boolean, integer, nonNegativeInteger, object, objectUnion, positiveInteger, string } from '../../transport/mcp/schema.mjs';
import { buyerOutcomeGuidance, liveAggregateSchemas, liveBaseProperties, liveInputSchema, liveToolAnnotations, resultPathGuidance, } from './live.mjs';
const filtersQuerySchema = object({
    skipped: boolean,
    errorDetails: object({
        code: {
            type: 'string',
            enum: [
                ...Object.values(FETCH_ERROR_CODES),
                'WB_FETCH_FAILED',
                'WB_RATE_LIMITED',
                'WB_REQUEST_FAILED',
                'WB_UNRELIABLE_RESPONSE',
                'WB_FULL_LISTS_INCOMPLETE',
            ],
        },
        stage: { const: 'execution' },
        retryable: boolean,
        phase: closedValue('phase'),
        recovery: closedValue('recovery'),
    }, ['code', 'stage', 'retryable']),
    query: string,
    status: { type: 'string', enum: ['ok', 'partial', 'empty', 'request_failed', 'rate_limited'] },
    httpStatus: integer,
    filterKeys: array(string),
    error: string,
}, ['query', 'status']);
const filterSchema = object({
    kind: { type: 'string', enum: ['characteristic', 'category'] },
    name: string,
    key: string,
    complete: boolean,
    values: array(string),
    queryCount: positiveInteger,
}, ['kind', 'name', 'key', 'complete', 'values', 'queryCount']);
const filtersSuccessSchema = object({
    stopReason: { const: 'rate_limited' },
    ...liveBaseProperties,
    jobType: { const: 'filters_by_query' },
    complete: boolean,
    requestsMade: nonNegativeInteger,
    queries: array(filtersQuerySchema),
    filters: array(filterSchema),
}, ['ok', 'status', 'jobType', 'jobId', 'resultPath', 'complete', 'requestsMade', 'queries', 'filters']);
const filtersContract = 'Get the Wildberries search filters for 1-50 phrases: every card characteristic (Цвет, Состав, Материал, Сезон…) with all its values, and the categories (предметы) WB shows for each phrase. Use for Russian requests about фильтры выдачи, фильтры по запросу, «Все фильтры», значения фильтров, or заполнить характеристики / доп. поля карточки как в фильтрах WB. ' +
    authorizationWorkflow +
    localBridgeFailureGuidance +
    buyerOutcomeGuidance +
    rejectionAndHandoffGuidance +
    'Authorize with job {type:"filters_by_query",queries:[string,...]}; send 1-50 unique non-empty phrases as a shopper types them. ' +
    "Read filters[]: one entry per filter across all phrases; values are WB's exact spellings in WB's order, the union over the phrases; queryCount counts the phrases that show the filter, and queries[].filterKeys lists the filters of each phrase. " +
    'Quote values verbatim when advising what to fill in a card. complete:false means WB returned only the first values of that list: say the list may be longer. ' +
    'Per phrase, empty means WB found nothing for it; request_failed with WB_UNRELIABLE_RESPONSE means WB answered with decoy data, which was discarded; partial means some lists stayed truncated. Never present a failed phrase as one without filters. ' +
    'Brand, seller, price, delivery and yes/no filters are not returned. Which phrase showed which value is in the result file. Results are a current WB-session snapshot. ' +
    resultPathGuidance;
export const contract = {
    name: 'wb_filters_by_query',
    description: 'Get the WB search filters for phrases: every card characteristic with all its values, and the categories, as on the search page under «Все фильтры». ' +
        signedDiscovery('wb_filters_by_query', 'filters_by_query') +
        "Never automatically repeat rate-limited work; retain partial results. Values are WB's exact spellings; complete:false means only the first values were returned. empty means WB found nothing for the phrase; a failed phrase is not a phrase without filters. " +
        completeContractGuidance,
    inputSchema: liveInputSchema(),
    outputSchema: withRunningAnswer(withOperationDiagnostic(objectUnion(...liveAggregateSchemas(filtersSuccessSchema), toolErrorSchema))),
    annotations: liveToolAnnotations,
    workflow: {
        appliesTo: ['browser_job', 'wb_filters_by_query'],
        text: `${filtersContract.trimEnd()} ${authorizationEndGuidance} ${runningAnswerGuidance}`,
    },
};
