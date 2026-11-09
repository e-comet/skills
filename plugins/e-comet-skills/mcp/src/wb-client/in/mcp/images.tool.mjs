import { randomUUID } from 'node:crypto';
import { invalidArgumentsMessage, validateArguments } from '../../../mcp-protocol/registry/validate.mjs';
import { textResult, toolFailure } from '../../../mcp-protocol/results/serialize.mjs';
import { ToolExecutionError } from '../../../shared/coded-error.mjs';
import { fieldOf, isUnknownArray } from '../../../shared/values.mjs';
import { lookupProductImages } from '../../application/product-images.mjs';
import { contract } from '../../contract/images.contract.mjs';
import { DEFAULT_IMAGE_PHOTOS, MAX_IMAGE_BASKET } from '../../domain/constants/limits.const.mjs';
/**
 * wb_product_images: a public image-CDN lookup that never uses the bridge. Products without images are a normal negative
 * result: only an execution failure sets the MCP error flag.
 */
// `imageOrigin()` names the test-only image host, read when a call starts.
export const createImagesTool = ({ answer, results, images, shutdownSignal, log, imageOrigin, }) => ({
    needsBridge: false,
    // Parse boundary: the call's arguments, checked against the contract first; the contract's types narrow them.
    run: async (id, args = {}) => {
        const nmIds = fieldOf(args, 'nmIds');
        const maxPhotos = fieldOf(args, 'maxPhotos') ?? DEFAULT_IMAGE_PHOTOS;
        const maxBasket = fieldOf(args, 'maxBasket') ?? MAX_IMAGE_BASKET;
        const size = fieldOf(args, 'size') ?? 'big';
        const timeout = fieldOf(args, 'timeout') ?? 5000;
        const validation = validateArguments(contract.inputSchema, args);
        if (!validation.ok ||
            !isUnknownArray(nmIds) ||
            !nmIds.every((nmId) => typeof nmId === 'number') ||
            typeof maxPhotos !== 'number' ||
            typeof maxBasket !== 'number' ||
            typeof size !== 'string' ||
            typeof timeout !== 'number') {
            await answer(id, textResult(toolFailure(new ToolExecutionError('INVALID_TOOL_ARGUMENTS', invalidArgumentsMessage('wb_product_images', validation), 'arguments', false)), true));
            return;
        }
        const jobId = randomUUID();
        let writer;
        let writerClosePromise;
        const closeWriter = async () => {
            if (!writer)
                return [];
            writerClosePromise ??= writer.close();
            return writerClosePromise;
        };
        try {
            writer = await results.create(jobId);
            const resultPath = writer.resultPath;
            const { products, rateLimitError } = await lookupProductImages({
                nmIds,
                maxPhotos,
                maxBasket,
                size,
                timeout,
                probe: images.exists,
                shutdownSignal,
                writer,
                testOrigin: imageOrigin(),
            });
            const writeErrors = await closeWriter();
            const succeeded = products.filter((product) => product.imageUrls.length > 0).length;
            const complete = products.every((product) => product.status === 'ok');
            const hasErrors = products.some((product) => product.error);
            // A completed probe with only not_found rows is a normal negative result; only execution failures set MCP isError below.
            await answer(id, textResult({
                ok: succeeded > 0,
                status: complete ? 'done' : succeeded > 0 ? 'partial' : 'failed',
                ...(rateLimitError ? { stopReason: 'rate_limited' } : {}),
                jobId,
                total: products.length,
                succeeded,
                failed: products.length - succeeded,
                size,
                products,
                ...(writer.published !== false ? { resultPath } : {}),
                ...(writeErrors.length > 0 ? { storageWarnings: writeErrors.map((error) => error.message) } : {}),
            }, hasErrors));
        }
        catch (error) {
            const partialWriter = writer;
            const writeErrors = await closeWriter().catch(() => []);
            const partialResult = partialWriter
                ? {
                    ...(partialWriter.published !== false && partialWriter.persistedBytes > 0
                        ? { resultPath: partialWriter.resultPath }
                        : {}),
                    ...(writeErrors.length > 0 ? { storageWarnings: writeErrors.map((writeError) => writeError.message) } : {}),
                }
                : {};
            const evidence = results.creationEvidence(error);
            await answer(id, textResult({
                ...toolFailure(error, {
                    code: 'IMAGE_LOOKUP_FAILED',
                    message: 'The Wildberries image lookup could not be completed.',
                    stage: 'images',
                    retryable: true,
                }),
                ...(evidence ? { details: evidence } : {}),
                ...partialResult,
            }, true));
        }
        finally {
            try {
                await writer?.release?.();
            }
            catch {
                log('result ownership cleanup failed after image lookup response; result remains protected');
            }
        }
    },
});
