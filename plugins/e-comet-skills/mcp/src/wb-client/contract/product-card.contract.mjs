import { authorizationEndGuidance, authorizationWorkflow, completeContractGuidance, localBridgeFailureGuidance, rejectionAndHandoffGuidance, runningAnswerGuidance, signedDiscovery, } from '../../transport/mcp/prose.mjs';
import { toolErrorSchema, withOperationDiagnostic, withRunningAnswer } from '../../transport/mcp/results.mjs';
import { array, boolean, integer, nonNegativeInteger, number, object, objectUnion, positiveInteger, string, } from '../../transport/mcp/schema.mjs';
import { buyerErrorProperties, buyerOutcomeGuidance, liveAggregateSchemas, liveBaseProperties, liveInputSchema, liveToolAnnotations, priceSchema, resultPathGuidance, } from './live.mjs';
const warehouseSchema = object({
    wh: positiveInteger,
    warehouse: string,
    qty: nonNegativeInteger,
    rows: nonNegativeInteger,
}, ['wh', 'qty', 'rows']);
const sizeSchema = object({
    size: string,
    qty: nonNegativeInteger,
    warehouses: nonNegativeInteger,
}, ['size', 'qty', 'warehouses']);
const quantitySchema = object({
    total: nonNegativeInteger,
    byWarehouse: array(warehouseSchema),
    bySize: array(sizeSchema),
}, ['total', 'byWarehouse', 'bySize']);
const unitSchema = object({
    ...buyerErrorProperties,
    key: string,
    ok: boolean,
    httpStatus: integer,
    error: string,
}, ['key', 'ok']);
const productCardSchema = object({
    complete: boolean,
    nmId: positiveInteger,
    ok: boolean,
    status: integer,
    error: string,
    name: string,
    brand: string,
    supplier: string,
    supplierId: positiveInteger,
    rating: number,
    feedbacks: nonNegativeInteger,
    pics: nonNegativeInteger,
    priceRub: priceSchema,
    quantity: quantitySchema,
    imtId: positiveInteger,
    vendorCode: string,
    description: string,
    subjectId: positiveInteger,
    subject: string,
    rootSubject: string,
    options: array({}),
    colors: array(positiveInteger),
    content: object({}, [], true),
    units: array(unitSchema),
}, ['nmId', 'ok', 'units']);
const productCardSuccessSchema = object({
    stopReason: { const: 'rate_limited' },
    ...liveBaseProperties,
    jobType: { const: 'product_card' },
    total: nonNegativeInteger,
    succeeded: nonNegativeInteger,
    failed: nonNegativeInteger,
    products: array(productCardSchema),
}, ['ok', 'status', 'jobType', 'jobId', 'resultPath', 'total', 'succeeded', 'failed', 'products']);
const productCardContract = 'Get live Wildberries product-card data by article ID. Use for Russian requests about остаток, остатки, сток, наличие, склады, размеры, цена, карточка товара, описание, характеристики, or склейка. ' +
    authorizationWorkflow +
    localBridgeFailureGuidance +
    buyerOutcomeGuidance +
    rejectionAndHandoffGuidance +
    'Authorize with job {type:"product_card",product_ids:[integer,...]}; use 1-1000 positive product IDs. Read products[]. For price use priceRub.product; priceRub.basic is the crossed-out/basic price. ' +
    'For stock use quantity.total, quantity.byWarehouse, and quantity.bySize. Warehouse names are already in warehouse; if absent, display wh <id>. Use colors for merged articles, options for characteristics, and description for description. ' +
    'Translate raw field names for the user and render booleans as yes/no. A product-level ok:false is a failed WB request, not proof that the product does not exist. Report partial item errors. ' +
    'product.complete:false means at least one requested part failed; product.ok and succeeded can still indicate useful detail data. Do not claim the complete card or description was obtained. ' +
    'Values are a current WB-session snapshot. ' +
    resultPathGuidance;
export const contract = {
    name: 'wb_product_card',
    description: 'Get live WB stock, sizes, price and product-card data by article ID, including description and characteristics. ' +
        signedDiscovery('wb_product_card', 'product_card') +
        'Never automatically repeat rate-limited work; retain partial results. product.complete:false means an incomplete card even when product.ok is true; failed requests do not prove the product is missing. ' +
        completeContractGuidance,
    inputSchema: liveInputSchema(),
    outputSchema: withRunningAnswer(withOperationDiagnostic(objectUnion(...liveAggregateSchemas(productCardSuccessSchema), toolErrorSchema))),
    annotations: liveToolAnnotations,
    workflow: {
        appliesTo: ['browser_job', 'wb_product_card'],
        text: `${productCardContract.trimEnd()} ${authorizationEndGuidance} ${runningAnswerGuidance}`,
    },
};
