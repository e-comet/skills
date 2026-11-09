import { liveToolAnnotations, ozonAuthorizationRejectedDetailsSchema, ozonHandoffGuidance, ozonHookInjection, ozonPackageContext, ozonScopeGuard, ozonTriggerUrlProperty, preflightFailureSchema, } from './reports.mjs';
import { MAX_OZON_REPORT_PACKAGE_ITEMS, MAX_OZON_SEARCH_POSITIONS_SKUS, MAX_OZON_SEARCH_POSITIONS_TEXT_LENGTH, OZON_SEARCH_POSITIONS_DEFAULT_REGION, OZON_SEARCH_POSITIONS_PLATFORMS, OZON_SEARCH_POSITIONS_STOP_REASONS, } from '../domain/constants/limits.const.mjs';
import { OZON_SEARCH_POSITIONS_TERMINAL_CODE_STAGES } from '../../transport/extension/wire.mjs';
import { BRIDGE_FAILURE_GUIDANCE, authorizationEndGuidance, completeContractGuidance, rejectionAndHandoffGuidance, runningAnswerGuidance, signedDiscovery, } from '../../transport/mcp/prose.mjs';
import { withOperationDiagnostic, withRunningAnswer } from '../../transport/mcp/results.mjs';
import { array, described, object, objectUnion, positiveInteger } from '../../transport/mcp/schema.mjs';
const searchPositionsText = { type: 'string', minLength: 1, maxLength: MAX_OZON_SEARCH_POSITIONS_TEXT_LENGTH };
// Query rows follow the signed order; a complete row has one cell per top-level SKU, an empty row none.
const searchPositionsResultSchema = (() => {
    const details = {
        OZON_REGION_UNAVAILABLE: object({ candidates: array(searchPositionsText, { minItems: 1, maxItems: 5 }) }, ['candidates']),
        OZON_SKU_LIMIT_EXCEEDED: object({ limit: positiveInteger }, ['limit']),
        OZON_AUTHORIZATION_REJECTED: ozonAuthorizationRejectedDetailsSchema,
    };
    const error = objectUnion(...Object.entries({ ...OZON_SEARCH_POSITIONS_TERMINAL_CODE_STAGES, OZON_EXECUTION_INTERRUPTED: 'execution' }).map(([code, stage]) => object({
        code: { const: code },
        message: { type: 'string', minLength: 1, maxLength: 500 },
        stage: { const: stage },
        retryable: { const: false },
        ...(Object.hasOwn(details, code) ? { details: details[code] } : {}),
    }, ['code', 'message', 'stage', 'retryable'])));
    const row = (status, properties = {}) => object({
        itemIndex: { type: 'integer', minimum: 0, maximum: MAX_OZON_REPORT_PACKAGE_ITEMS - 1 },
        query: searchPositionsText,
        status: { const: status },
        ...properties,
    }, ['itemIndex', 'query', 'status', ...Object.keys(properties)]);
    const checkedAt = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' };
    const cell = { oneOf: [positiveInteger, { type: 'string', minLength: 1, maxLength: 32 }] };
    const complete = row('complete', { checkedAt, positions: array(cell, { minItems: 1, maxItems: MAX_OZON_SEARCH_POSITIONS_SKUS }) });
    const empty = row('empty', { checkedAt, positions: array(cell, { maxItems: 0 }) });
    const failed = row('failed', { error });
    const skipped = row('skipped');
    const answered = objectUnion(complete, empty);
    const rows = (items, extra = {}) => ({
        ...array(items, { minItems: 1, maxItems: MAX_OZON_REPORT_PACKAGE_ITEMS }),
        ...extra,
    });
    const table = (ok, statusValue, queries, stopped) => object({
        ok: { const: ok },
        status: { const: statusValue },
        jobType: { const: 'ozon_search_positions' },
        marketplace: { const: 'ozon' },
        region: searchPositionsText,
        platform: { type: 'string', enum: [...OZON_SEARCH_POSITIONS_PLATFORMS] },
        skus: array(positiveInteger, { minItems: 1, maxItems: MAX_OZON_SEARCH_POSITIONS_SKUS, uniqueItems: true }),
        queries,
        stopReason: stopped ? { type: 'string', enum: [...OZON_SEARCH_POSITIONS_STOP_REASONS] } : { type: 'null' },
        ...(stopped ? { error } : {}),
    }, [
        'ok',
        'status',
        'jobType',
        'marketplace',
        'region',
        'platform',
        'skus',
        'queries',
        'stopReason',
        ...(stopped ? ['error'] : []),
    ]);
    return objectUnion(table(true, 'complete', rows(answered), false), table(true, 'partial', rows(objectUnion(complete, empty, failed), { allOf: [{ contains: answered }, { contains: failed }] }), false), table(true, 'partial', rows(objectUnion(complete, empty, failed, skipped), { allOf: [{ contains: answered }, { contains: skipped }] }), true), table(false, 'failed', rows(failed), false), table(false, 'failed', rows(objectUnion(failed, skipped), { contains: skipped }), true), preflightFailureSchema('ozon_search_positions'));
})();
const searchPositionsContract = "Get Ozon search places of given Ozon SKUs (own or competitors') for given search queries as one JSON table: rows are queries, columns are the SKUs. Use for Russian requests about позиции/места товаров в поиске Ozon по фразам. " +
    ozonScopeGuard +
    `Call the remote browser_job exactly once with job {type:"ozon_search_positions",queries:[1-${MAX_OZON_REPORT_PACKAGE_ITEMS} strings],skus:[1-10 integers],region?:string default "Москва",platform?:"ozon"|"select"}, then invoke this local tool exactly once with the identical queries, skus, region and platform. ` +
    ozonHookInjection +
    'Never automatically retry browser_job or this local call, including rate-limited work; a fresh authorization requires an explicit user-directed retry. ' +
    'Queries are trimmed, 1-128 characters and unique after trimming; their order is execution priority. SKUs are unique positive integers. ' +
    `More than ${MAX_OZON_REPORT_PACKAGE_ITEMS} queries or 10 SKUs need several jobs, only on the user's decision. ` +
    'region is a city or area name as Ozon lists it; a word such as «беларусь» inside a query is part of the query, never a region. ' +
    'platform "ozon" is the main Ozon storefront; "select" is Ozon Селект (brand storefront), where empty usually means the goods are not sold in Селект. ' +
    'Read queries[] by itemIndex; each positions[] follows the top-level skus order. A cell is an integer place; "not_found" means Ozon reports no such product for this query, which may also mean a wrong SKU; ' +
    '"not_returned" means the SKU was absent from Ozon\'s answer and the cause is not established; any other text is Ozon\'s own label (for example "499+"), kept as is: never convert it to a number. ' +
    "A place is Ozon's own figure; whether it includes paid promotion is not established, so never call it organic or paid. " +
    'Query status "empty" means Ozon has no data for this query on this platform; it is not "not found" for every SKU. "failed" carries the query error. ' +
    '"skipped" means no result; the query in progress when the package stopped may already have reached Ozon. ' +
    'stopReason and the top-level error explain why queries were skipped; a null stopReason means nothing was skipped, not that every query has places. ' +
    'Places change within hours, so report checkedAt with them. To track history, keep the JSON of each run; build Excel or other files yourself only if the user asks. ' +
    "On the user's decision, a fresh job may include the selected skipped or failed queries; no automatic retry. " +
    "OZON_REGION_UNAVAILABLE: the region matched no Ozon location or several; show details.candidates and ask the user for a precise city, then a new job on the user's decision. " +
    "OZON_SKU_LIMIT_EXCEEDED: more SKUs than Ozon allows for this seller (details.limit); split them into several jobs only on the user's decision. " +
    'OZON_SEARCH_FAILED: Ozon failed this query; report the query as failed, no automatic retry. ' +
    "OZON_RATE_LIMITED: Ozon limited the requests; the package stopped and the remaining queries are skipped; no automatic retry. Ozon counts per minute, so a new job for the skipped queries waits at least a minute, on the user's decision. " +
    "OZON_SEARCH_POSITIONS_CAPABILITY_UNAVAILABLE: the connected extension cannot run this tool; the user updates the e-Comet extension, then a new authorization on the user's decision; opening an Ozon page does not help. " +
    "OZON_ROUTE_NOT_READY: no ready Ozon Seller route was reachable; when its message names the step (open an Ozon Seller tab, choose one company, sign out and in again), relay that step; otherwise its cause is not established: ask the user to check the extension in the same browser profile and refresh any authenticated Ozon Seller page under https://seller.ozon.ru/app, then a new authorization on the user's decision; when the message says the browser connection closed, check local_bridge_status instead of a page. Never use WB-tab recovery for Ozon. " +
    "OZON_CONTEXT_CHANGED: the Seller company changed during the run, so the remaining queries are skipped; a new job on the user's decision pins the then-current company. " +
    "OZON_EXECUTION_INTERRUPTED: the extension's results could not be accepted; an internal e-Comet failure, not a Seller login or route problem; offer an e-Comet bug report. " +
    ozonPackageContext +
    BRIDGE_FAILURE_GUIDANCE +
    rejectionAndHandoffGuidance +
    ozonHandoffGuidance;
export const contract = {
    name: 'ozon_search_positions',
    description: 'Ozon search places of given SKUs for given queries, as one JSON table of queries by SKUs. Use for Russian requests about позиции/места товаров в поиске Ozon по фразам. ' +
        signedDiscovery('ozon_search_positions', 'ozon_search_positions') +
        'Never automatically retry browser_job or the local call, including rate-limited work; a fresh job may include only user-selected skipped or failed queries. ' +
        'status "empty" means Ozon has no data for that query, not that the SKUs were not found. ' +
        completeContractGuidance,
    // The canonicalizer checks trimming, uniqueness after trimming and the 128-character bound, as the signer does.
    inputSchema: object({
        queries: described(array({ type: 'string', minLength: 1 }, { minItems: 1, maxItems: MAX_OZON_REPORT_PACKAGE_ITEMS }), `Search queries in execution order, identical to the signed job: 1-${MAX_OZON_SEARCH_POSITIONS_TEXT_LENGTH} characters after trimming, unique.`),
        skus: described(array(positiveInteger, { minItems: 1, maxItems: MAX_OZON_SEARCH_POSITIONS_SKUS, uniqueItems: true }), "Ozon SKUs (own or competitors') in result column order, identical to the signed job."),
        region: described({ type: 'string', minLength: 1, default: OZON_SEARCH_POSITIONS_DEFAULT_REGION }, 'City or area name as Ozon lists it, identical to the signed job; never a word taken from a query.'),
        platform: described({ type: 'string', enum: [...OZON_SEARCH_POSITIONS_PLATFORMS], default: 'ozon' }, 'ozon is the main storefront; select is Ozon Select (brand storefront). Identical to the signed job.'),
        triggerUrl: ozonTriggerUrlProperty,
    }, ['queries', 'skus']),
    outputSchema: withRunningAnswer(withOperationDiagnostic(searchPositionsResultSchema)),
    // Read-only: Ozon only adds a checked query to the screen's input suggestions, an accepted residual, see
    // docs/architecture/residuals/ozon.md.
    annotations: liveToolAnnotations,
    workflow: {
        appliesTo: ['browser_job', 'ozon_search_positions'],
        text: `${searchPositionsContract.trimEnd()} ${authorizationEndGuidance} ${runningAnswerGuidance}`,
    },
};
