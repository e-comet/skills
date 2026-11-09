import { UUID_V4, isPositiveSafeInteger, isRecord } from '../../../shared/values.mjs';
import { FEEDBACK_UPLOAD_DESTINATIONS } from '../domain/constants/limits.const.mjs';
import { feedbackSubmissionFailure } from '../domain/converters/errors.converter.mjs';
import { assertUploadDestination, isPublishableObjectKey } from '../domain/policies/upload-destination.policy.mjs';
import { feedbackDiagnostics, safeFeedbackProperty } from '../../../transport/failures/evidence.mjs';
const ARTIFACT_ID = new RegExp(`^${UUID_V4}$`);
const SHA256 = /^[a-f0-9]{64}$/;
export const safeArtifactId = (artifactId) => typeof artifactId === 'string' && ARTIFACT_ID.test(artifactId) ? artifactId : undefined;
export const submitError = (artifactId, status, code, message, stage, retryable, error = undefined, operation = 'submit') => ({
    ok: false,
    status,
    ...(artifactId === undefined ? {} : { artifactId }),
    error: { code, message, stage, retryable, details: feedbackDiagnostics(error, operation) },
});
const uploadFailure = (artifactId, code, error = undefined, operation = 'upload') => {
    if (code === 'UPLOAD_REJECTED') {
        return submitError(artifactId, 'rejected', code, 'The feedback archive upload was rejected.', 'upload', false, error, operation);
    }
    if (code !== 'UPLOAD_GRANT_INVALID') {
        // WHY: unknown upload failures do not prove rejection before transmission and must never invite replay.
        return submitError(artifactId, 'uncertain', 'UPLOAD_UNCERTAIN', 'The feedback archive upload outcome is uncertain.', 'upload', false, error, operation);
    }
    return submitError(artifactId, 'failed', 'UPLOAD_GRANT_INVALID', 'The feedback upload grant is invalid or has expired.', 'grant', false, error, operation === 'upload' ? 'grant_validation' : operation);
};
/**
 * Re-verifies and uploads one stored archive. Transport fields are injected by the trusted host hook, whose signature
 * the MCP tool verified (in/mcp/routes); `signed` says it did.
 */
// Parse boundary: the call's arguments, already checked against the tool's input schema; the grant is checked below.
const submit = async (input = {}, dependencies = {}, adapters, signed) => {
    const { loadArtifact = adapters.loadArtifact, retireArtifact = adapters.retireArtifact, upload = adapters.upload, now = Date.now, destinations = FEEDBACK_UPLOAD_DESTINATIONS, } = dependencies;
    const artifactId = safeArtifactId(input.artifactId);
    // A test seam may pass anything as destinations; checking an unknown view keeps their declared type below.
    if (typeof loadArtifact !== 'function' ||
        typeof retireArtifact !== 'function' ||
        typeof upload !== 'function' ||
        typeof now !== 'function' ||
        !Array.isArray(destinations)) {
        throw new TypeError('Feedback submission dependencies are invalid.');
    }
    // A grant the model copied (Cowork) has no signature, so only e-Comet's own storage may receive it: accepted residual
    // "Cowork reports go unsigned and without history". The model copies report_issue's expires_at as it came, an ISO time
    // or epoch seconds.
    const expiresAt = typeof input.expiresAt === 'string' ? Math.floor(Date.parse(input.expiresAt) / 1000) : input.expiresAt;
    let unsignedReportId;
    if (!signed && typeof input.uploadUrl === 'string' && URL.canParse(input.uploadUrl)) {
        // A URL the copy left out or garbled is an incomplete grant, refused below; a well-formed one must lead to e-Comet
        // storage.
        let target;
        try {
            // The input schema admits only an object of header strings there.
            target = assertUploadDestination(input.uploadUrl, destinations, isRecord(input.requiredHeaders) ? input.requiredHeaders : {});
        }
        catch (error) {
            return submitError(artifactId, 'failed', 'UPLOAD_DESTINATION_REFUSED', 'The feedback upload destination is not an e-Comet storage location.', 'grant', false, error, 'grant_validation');
        }
        // The object the URL writes is the report's identifier, so a slip in the copied objectKey cannot misname it.
        // The destination check above accepted the URL, so one destination matches it.
        const destination = destinations.find(({ hostname, pathPrefix }) => target.hostname === hostname && target.pathname.startsWith(pathPrefix));
        if (destination) {
            try {
                unsignedReportId = decodeURIComponent(target.pathname.slice(destination.pathPrefix.length));
            }
            catch {
                /* a garbled escape, refused below */
            }
        }
    }
    if (artifactId === undefined ||
        typeof input.uploadUrl !== 'string' ||
        !isRecord(input.requiredHeaders) ||
        typeof input.objectKey !== 'string' ||
        (!signed && (typeof unsignedReportId !== 'string' || !isPublishableObjectKey(unsignedReportId))) ||
        typeof expiresAt !== 'number' ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt * 1000 <= now() ||
        !isPositiveSafeInteger(input.expectedSize) ||
        typeof input.expectedSha256 !== 'string' ||
        !SHA256.test(input.expectedSha256)) {
        return uploadFailure(artifactId, 'UPLOAD_GRANT_INVALID');
    }
    let artifact;
    try {
        artifact = await loadArtifact({ artifactId, expectedSize: input.expectedSize, expectedSha256: input.expectedSha256 });
        if (!artifact ||
            !Buffer.isBuffer(artifact.bytes) ||
            artifact.bytes.length !== input.expectedSize ||
            (artifact.transcriptIncluded !== true && artifact.transcriptIncluded !== false)) {
            throw new Error('invalid artifact');
        }
    }
    catch (error) {
        return submitError(artifactId, 'failed', 'ARTIFACT_UNAVAILABLE', 'The prepared feedback archive is unavailable.', 'artifact', false, error, 'artifact_read');
    }
    try {
        await upload({
            uploadUrl: input.uploadUrl,
            requiredHeaders: input.requiredHeaders,
            expiresAt,
            bytes: artifact.bytes,
        });
    }
    catch (error) {
        return uploadFailure(artifactId, safeFeedbackProperty(error, 'code'), error);
    }
    // Retirement/tombstone reconciliation is private maintenance. Storage acceptance is the only public outcome.
    await retireArtifact({ artifactId }).catch(() => undefined);
    // The object key the accepted upload wrote is the one identifier both the seller and support can name.
    // It is published only here, after acceptance: an unaccepted grant names an object that does not exist.
    return {
        ok: true,
        status: 'uploaded',
        artifactId,
        transcriptIncluded: artifact.transcriptIncluded,
        reportId: signed ? input.objectKey : unsignedReportId,
    };
};
// Parse boundary: the call's arguments, already checked against the tool's input schema.
export const submitFeedback = async (input = {}, dependencies = {}, adapters, signed) => {
    try {
        return await submit(input, dependencies, adapters, signed);
    }
    catch (error) {
        return feedbackSubmissionFailure(error, safeFeedbackProperty(input, 'artifactId'));
    }
};
// The submission's closed outcome: the kind follows the result's code.
const SUBMIT_KINDS = {
    FEEDBACK_HOOK_HANDOFF_UNAVAILABLE: 'handoff_unavailable',
    UPLOAD_GRANT_INVALID: 'grant_invalid',
    UPLOAD_DESTINATION_REFUSED: 'destination_refused',
    ARTIFACT_UNAVAILABLE: 'artifact_unavailable',
    UPLOAD_REJECTED: 'upload_rejected',
    UPLOAD_UNCERTAIN: 'upload_uncertain',
};
// Parse boundary: a result, ours or a test seam's, read by its closed code; the code is read as the property key it was.
export const submitOutcome = (result) => {
    const error = result.ok ? undefined : result.error;
    const code = String(isRecord(error) ? error.code : undefined);
    return {
        kind: result.ok ? 'uploaded' : ((Object.hasOwn(SUBMIT_KINDS, code) ? SUBMIT_KINDS[code] : undefined) ?? 'submission_failed'),
        result,
    };
};
