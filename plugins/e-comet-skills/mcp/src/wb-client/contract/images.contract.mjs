import { toolErrorSchema, withOperationDiagnostic } from '../../transport/mcp/results.mjs';
import { array, boolean, nonNegativeInteger, object, objectUnion, positiveInteger, string } from '../../transport/mcp/schema.mjs';
import { liveAggregateSchemas, status, storageWarnings } from './live.mjs';
import { DEFAULT_IMAGE_PHOTOS, MAX_IMAGE_ARTICLES, MAX_IMAGE_BASKET, MAX_IMAGE_PHOTOS, } from '../domain/constants/limits.const.mjs';
const imageProductSchema = object({
    nmId: positiveInteger,
    status: { type: 'string', enum: ['ok', 'not_found', 'partial', 'failed', 'skipped'] },
    error: object({
        code: { enum: ['WB_IMAGE_RATE_LIMITED', 'WB_IMAGE_PROBE_FAILED'] },
        message: string,
        stage: { const: 'images' },
        retryable: { const: false },
    }, ['code', 'message', 'stage', 'retryable']),
    basket: positiveInteger,
    baseUrl: string,
    imageUrls: array(string),
}, ['nmId', 'status', 'imageUrls']);
const imagesSuccessSchema = object({
    stopReason: { const: 'rate_limited' },
    ok: boolean,
    status,
    jobId: string,
    total: nonNegativeInteger,
    succeeded: nonNegativeInteger,
    failed: nonNegativeInteger,
    size: { type: 'string', enum: ['big', 'tm'] },
    products: array(imageProductSchema),
    resultPath: string,
    storageWarnings,
}, ['ok', 'status', 'jobId', 'total', 'succeeded', 'failed', 'size', 'products', 'resultPath']);
export const contract = {
    name: 'wb_product_images',
    description: 'Find public Wildberries product image URLs by article ID. Use for Russian requests about фото, фотографии, картинки, изображения, ссылки на фото, or галерея товара. ' +
        'Call it directly; it needs neither remote browser_job nor the Chrome extension. Send at most 20 IDs per call and preserve input order across batches. ' +
        'Use products[].imageUrls rather than guessing CDN URLs. Report succeeded and failed counts. status "not_found" means the current image-CDN probe found no photos; it does not mean that the product does not exist. ' +
        'Rate-limited or unverified probes are failed/partial/skipped, not not_found. Preserve every returned URL, explain partial coverage and stopReason:"rate_limited", and do not automatically repeat the scan. A rate limit on an observed host does not prove a site-wide ban.',
    inputSchema: object({
        nmIds: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_IMAGE_ARTICLES,
            uniqueItems: true,
            items: { type: 'integer', minimum: 10000, maximum: 9999999999 },
        },
        maxPhotos: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_IMAGE_PHOTOS,
            default: DEFAULT_IMAGE_PHOTOS,
        },
        maxBasket: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_IMAGE_BASKET,
            default: MAX_IMAGE_BASKET,
        },
        size: { type: 'string', enum: ['big', 'tm'], default: 'big' },
        timeout: { type: 'number', minimum: 1000, maximum: 30000, default: 5000 },
    }, ['nmIds']),
    outputSchema: withOperationDiagnostic(objectUnion(...liveAggregateSchemas(imagesSuccessSchema), toolErrorSchema)),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
    },
};
