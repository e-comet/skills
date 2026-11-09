import { fieldOf } from '../../shared/values.mjs';
import { createConcurrencyLimiter, runWithConcurrency } from './concurrency.mjs';
import { IMAGE_BASKET_BOUNDS, IMAGE_CONCURRENCY } from '../domain/constants/limits.const.mjs';
import { basketNumberForVol, imageBaseUrl } from '../domain/converters/images.converter.mjs';
// Whether a probe failure is the image service's coded rate limit rather than any other error.
const isRateLimited = (error) => fieldOf(error, 'code') === 'WB_IMAGE_RATE_LIMITED';
export const discoverImageBasket = async (nmId, maxBasket, size, timeout, probe, testOrigin = undefined) => {
    const vol = Math.floor(nmId / 100000);
    const predicted = basketNumberForVol(vol);
    const allBaskets = Array.from({ length: maxBasket }, (_, index) => index + 1);
    const firstFutureBasket = IMAGE_BASKET_BOUNDS.length + 1;
    const candidates = predicted
        ? [predicted, ...allBaskets.filter((basket) => basket !== predicted)]
        : firstFutureBasket <= maxBasket
            ? [...allBaskets.filter((basket) => basket >= firstFutureBasket), ...allBaskets.filter((basket) => basket < firstFutureBasket)]
            : allBaskets;
    let probeFailure;
    for (let index = 0; index < candidates.length; index += IMAGE_CONCURRENCY) {
        const batch = candidates.slice(index, index + IMAGE_CONCURRENCY);
        const matches = await Promise.allSettled(batch.map(async (basket) => {
            const baseUrl = imageBaseUrl(nmId, basket, testOrigin);
            return (await probe(`${baseUrl}/${size}/1.webp`, timeout)) ? { basket, baseUrl } : null;
        }));
        const match = matches.find((result) => result.status === 'fulfilled' && result.value);
        if (match?.status === 'fulfilled')
            return match.value;
        const limited = matches.find((result) => result.status === 'rejected' && isRateLimited(result.reason));
        if (limited?.status === 'rejected')
            throw limited.reason;
        const failure = matches.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected')
            probeFailure ??= failure.reason;
    }
    // Other baskets may still contain a confirmed match after an unavailable edge.
    // If none does, an unverified candidate prevents claiming definitive absence.
    if (probeFailure)
        throw probeFailure;
    return null;
};
const imageError = (error) => ({
    code: isRateLimited(error) ? 'WB_IMAGE_RATE_LIMITED' : 'WB_IMAGE_PROBE_FAILED',
    message: isRateLimited(error)
        ? 'Wildberries limited image requests. Further probes were skipped; found URLs are preserved. Do not retry automatically.'
        : 'The image lookup could not establish whether all requested images exist.',
    stage: 'images',
    retryable: false,
});
/**
 * The image rows of each product, appended to the result file as they finish. A WB rate limit stops every probe not yet
 * started; the probes that found images keep them. `probe(url, timeout, signal)` answers whether one image exists.
 */
export const lookupProductImages = async ({ nmIds, maxPhotos, maxBasket, size, timeout, probe: probeImageExists, shutdownSignal, writer, testOrigin, }) => {
    const currentWriter = writer;
    let rateLimitError;
    const stopProbes = new AbortController();
    const probeSignal = shutdownSignal ? AbortSignal.any([shutdownSignal, stopProbes.signal]) : stopProbes.signal;
    const limitedImageExists = createConcurrencyLimiter(IMAGE_CONCURRENCY, async (url, requestTimeout, markStarted) => {
        if (rateLimitError)
            throw rateLimitError;
        markStarted();
        try {
            return await probeImageExists(url, requestTimeout, probeSignal);
        }
        catch (error) {
            if (isRateLimited(error)) {
                rateLimitError ??= error;
                stopProbes.abort();
            }
            throw rateLimitError ?? error;
        }
    });
    const products = await runWithConcurrency(nmIds, IMAGE_CONCURRENCY, async (nmId) => {
        const imageUrls = [];
        let discovered;
        let failure;
        let started = false;
        const probe = (url, requestTimeout) => limitedImageExists(url, requestTimeout, () => {
            started = true;
        });
        const skipped = Boolean(rateLimitError);
        try {
            if (skipped)
                throw rateLimitError;
            const found = await discoverImageBasket(nmId, maxBasket, size, timeout, probe, testOrigin);
            discovered = found;
            if (found) {
                // Discovery already proved photo 1 exists; retain it even if later probes stop.
                imageUrls.push(`${found.baseUrl}/${size}/1.webp`);
                const outcomes = await runWithConcurrency(Array.from({ length: maxPhotos - 1 }, (_, index) => index + 2), IMAGE_CONCURRENCY, async (photo) => {
                    const url = `${found.baseUrl}/${size}/${photo}.webp`;
                    try {
                        return (await probe(url, timeout)) ? { url } : {};
                    }
                    catch (error) {
                        return { error };
                    }
                });
                for (const outcome of outcomes) {
                    if (outcome.url)
                        imageUrls.push(outcome.url);
                    if (outcome.error)
                        failure ??= outcome.error;
                }
            }
        }
        catch (error) {
            failure = error;
        }
        const result = {
            nmId,
            status: failure ? (!started ? 'skipped' : imageUrls.length ? 'partial' : 'failed') : imageUrls.length ? 'ok' : 'not_found',
            ...(discovered ? { basket: discovered.basket, baseUrl: discovered.baseUrl } : {}),
            imageUrls,
            ...(failure ? { error: imageError(failure) } : {}),
        };
        await currentWriter.append(result);
        return result;
    });
    return { products, rateLimitError };
};
