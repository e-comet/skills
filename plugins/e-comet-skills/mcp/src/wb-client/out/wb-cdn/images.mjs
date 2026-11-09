const imageRequestSignal = (timeout, shutdownSignal) => shutdownSignal ? AbortSignal.any([AbortSignal.timeout(timeout), shutdownSignal]) : AbortSignal.timeout(timeout);
export class ImageProbeError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export const imageExists = async (url, timeout, shutdownSignal) => {
    const classify = (response) => {
        if (response.ok)
            return true;
        if (response.status === 404 || response.status === 410)
            return false;
        throw new ImageProbeError(response.status === 429 ? 'WB_IMAGE_RATE_LIMITED' : 'WB_IMAGE_PROBE_FAILED', response.status === 429
            ? 'Wildberries image service limited requests; no further probes were started.'
            : 'The image service could not confirm whether this image exists.');
    };
    try {
        shutdownSignal?.throwIfAborted();
        const response = await fetch(url, { method: 'HEAD', signal: imageRequestSignal(timeout, shutdownSignal) });
        if (response.status !== 403 && response.status !== 405)
            return classify(response);
        // Only observed HEAD incompatibility permits GET, never timeout or throttling.
        shutdownSignal?.throwIfAborted();
        const fallback = await fetch(url, {
            headers: { Range: 'bytes=0-0' },
            signal: imageRequestSignal(timeout, shutdownSignal),
        });
        try {
            return classify(fallback);
        }
        finally {
            await fallback.body?.cancel?.().catch(() => undefined);
        }
    }
    catch (error) {
        if (error instanceof ImageProbeError)
            throw error;
        throw new ImageProbeError('WB_IMAGE_PROBE_FAILED', 'The image probe did not complete; image absence is not established.');
    }
};
