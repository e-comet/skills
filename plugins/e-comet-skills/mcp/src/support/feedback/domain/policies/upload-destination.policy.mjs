import { FEEDBACK_REPORT_ID_MAX_LENGTH, FEEDBACK_UPLOAD_DESTINATIONS } from '../constants/limits.const.mjs';
import { FeedbackUploadError } from '../converters/errors.converter.mjs';
const destinationRefused = (cause = undefined) => Object.assign(new FeedbackUploadError('UPLOAD_DESTINATION_REFUSED', 'The feedback upload destination is not an e-Comet storage location.', cause), { feedbackReason: 'destination_refused' });
/**
 * Pins a signed upload URL to e-Comet storage. Exact hostname, default port, https, no credentials, no fragment,
 * and a path that starts with an allowed bucket prefix. WHATWG URL parsing collapses dot segments for https,
 * percent-encoded ones (`%2e`, `%2E`) included, but it decodes nothing else: an escaped separator such as `%2f`
 * stays inside its segment here and becomes one only where the storage service itself decodes it. So this test is
 * not a general proof that a path stays below its prefix. It is sufficient here only because every allowed prefix
 * is bucket-level — the bucket segment of S3 path style, behind the storage proxy's fixed `/storage` mount, which
 * forwards the raw request path rather than a decoded one — so whatever follows, an accepted URL still addresses
 * the pinned bucket. A deeper prefix would need the escaped separators resolved the way the service resolves them.
 */
export const assertUploadDestination = (uploadUrl, destinations = FEEDBACK_UPLOAD_DESTINATIONS, requiredHeaders = {}) => {
    let target;
    try {
        target = new URL(uploadUrl);
    }
    catch (error) {
        throw destinationRefused(error);
    }
    if (target.protocol !== 'https:' || target.port !== '' || target.username || target.password || target.hash)
        throw destinationRefused();
    const allowed = destinations.some(({ hostname, pathPrefix }) => target.hostname === hostname && target.pathname.startsWith(pathPrefix));
    // An escaped separator would leave the bucket only where something on the way decodes it; refuse it rather than
    // rely on the storage proxy forwarding the raw path.
    if (!allowed || /%2f|%5c/i.test(target.pathname))
        throw destinationRefused();
    // S3 virtual-host addressing selects the bucket from Host, even when the connection URL is pinned.
    // A grant no hook signed must not replace that authority through its required headers.
    if (Object.entries(requiredHeaders).some(([name, value]) => name.toLowerCase() === 'host' && (typeof value !== 'string' || value.toLowerCase() !== target.host))) {
        throw destinationRefused();
    }
    return target;
};
// The storage object key an accepted upload wrote, published as this report's support reference. Every
// route that accepts, stores, re-emits or publishes that key tests it here, so the value cannot pass one
// boundary and fail another; the byte bound is at least as strict as the schema's code-unit maxLength.
const REPORT_ID_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
export const isPublishableObjectKey = (value) => typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= FEEDBACK_REPORT_ID_MAX_LENGTH &&
    !REPORT_ID_CONTROL_CHARACTERS.test(value);
