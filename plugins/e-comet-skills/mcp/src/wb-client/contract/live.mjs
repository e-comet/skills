import { FETCH_ERROR_CODES } from '../../transport/extension/wire.mjs';
import { closedValue, triggerUrlProperty } from '../../transport/mcp/results.mjs';
import { array, boolean, integer, nonNegativeInteger, number, object, positiveInteger, positiveNumber, string, } from '../../transport/mcp/schema.mjs';
import { DEFAULT_RETURNED_PRODUCTS, MAX_PRODUCT_ARTICLES, MAX_RETURNED_PRODUCTS } from '../domain/constants/limits.const.mjs';
// What the WB buyer tools' contracts share: the live result envelope, the listing page, the projection input and the
// buyer-outcome prose.
export const status = { type: 'string', enum: ['done', 'partial', 'failed'] };
export const liveAggregateSchemas = (schema) => [
    {
        ...schema,
        properties: {
            ...schema.properties,
            ok: { const: true },
            status: { type: 'string', enum: ['done', 'partial'] },
        },
    },
    {
        ...schema,
        properties: {
            ...schema.properties,
            ok: { const: false },
            status: { const: 'failed' },
        },
    },
].flatMap((published) => {
    // Useful inline data survives a failed NDJSON publication. That response must
    // omit resultPath and explain storage failure; neither a fabricated path nor
    // unexplained absence is valid. Keep the alternatives mutually exclusive.
    const { resultPath: _resultPath, ...inlineProperties } = published.properties ?? {};
    return [
        published,
        {
            ...published,
            properties: { ...inlineProperties, storageWarnings: array(string, { minItems: 1 }) },
            required: [...(published.required ?? []).filter((name) => name !== 'resultPath'), 'storageWarnings'],
        },
    ];
});
export const priceSchema = object({
    basic: number,
    product: number,
    logistics: number,
    return: number,
    cashback: number,
});
const listingProductSchema = object({
    nmId: positiveInteger,
    name: string,
    brand: string,
    supplierId: positiveInteger,
    priceRub: priceSchema,
    rating: number,
    feedbacks: nonNegativeInteger,
    pics: nonNegativeInteger,
    promoted: boolean,
    position: positiveInteger,
    globalPosition: positiveInteger,
}, ['nmId', 'position']);
export const buyerErrorProperties = {
    skipped: boolean,
    errorDetails: object({
        code: {
            type: 'string',
            enum: [...Object.values(FETCH_ERROR_CODES), 'WB_FETCH_FAILED', 'WB_RATE_LIMITED', 'WB_REQUEST_FAILED'],
        },
        stage: { const: 'execution' },
        retryable: boolean,
        phase: closedValue('phase'),
        recovery: closedValue('recovery'),
    }, ['code', 'stage', 'retryable']),
};
export const pageSchema = object({
    ...buyerErrorProperties,
    page: positiveInteger,
    ok: boolean,
    httpStatus: integer,
    total: nonNegativeInteger,
    overallTotal: nonNegativeInteger,
    error: string,
    globalPositionsReliable: boolean,
    products: array(listingProductSchema),
}, ['page', 'ok', 'total', 'products']);
export const storageWarnings = array(string);
export const liveBaseProperties = {
    ok: boolean,
    status,
    jobId: string,
    resultPath: string,
    expiresAt: positiveNumber,
    storageWarnings,
};
const projectionProperties = (limitName, scope) => ({
    [limitName]: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_RETURNED_PRODUCTS,
        default: DEFAULT_RETURNED_PRODUCTS,
        description: `Maximum compact products returned for each ${scope}.`,
    },
    productNmIds: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_PRODUCT_ARTICLES,
        uniqueItems: true,
        items: positiveInteger,
        description: 'Target WB article IDs for exact position or recommendation-membership checks.',
    },
});
export const liveInputSchema = (...projection) => object({
    triggerUrl: triggerUrlProperty,
    // Every caller that names a limit names its scope too.
    ...(projection.length ? projectionProperties(...projection) : {}),
});
export const resultPathGuidance = 'resultPath is only a fallback for the current call when the compact result is insufficient; it is not a cache and must not be reused for another request. ' +
    'Use it only when present. If storageWarnings accompany an absent path, preserve the inline data and explain the storage failure; never invent a file path.';
export const buyerOutcomeGuidance = 'When stopReason is "rate_limited", Wildberries returned HTTP 429: no new work was scheduled after that observation, while already in-flight requests may finish. ' +
    'Report the retained results and skipped work; never automatically repeat the job. skipped:true identifies work that was not dispatched, not proof that a product is missing. ' +
    "Use item errorDetails.code/stage/retryable when present to explain the observed failure. For WB_FETCH_TIMEOUT, errorDetails.phase names where it stopped and the item's error text gives the user's step for it: relay that step. Do not infer missing login, extension failure or, without a phase, a root cause from a timeout. " +
    "For errorDetails.recovery refresh_failed or service_unavailable (WB's anti-bot check did not pass in the page), the user opens www.wildberries.ru in that browser and checks that it loads; " +
    'for page_throttled (Chrome throttled a store tab kept in the background), the user keeps one store tab (www.wildberries.ru), closes the other store tabs but not the seller portal, and brings it to the front, since requests go to whichever store tab answers first. ' +
    "Then a new authorization and retry on the user's decision; report if it repeats. Other recovery values only say what the page tried. " +
    'errorDetails.code WB_NOT_AUTHENTICATED means the page had no Wildberries session: the user must sign in to wildberries.ru in the browser and profile that made the request, where the connected extension runs; a browser found by the extension_install probe is only a hint. It is the only code that supports a "not signed in" conclusion; a timeout or WB_FETCH_FAILED does not. Then obtain a new authorization and retry only on the user\'s decision. ';
export const liveToolAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
};
