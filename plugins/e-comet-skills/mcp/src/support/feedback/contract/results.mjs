import { validateSchemaValue } from '../../../shared/schema-validate.mjs';
import { hasExactOwnKeys, isRecord } from '../../../shared/values.mjs';
import { contract as prepareContract } from './prepare.contract.mjs';
import { FeedbackHandoffError, normalizeExpiresAt, validatePreparedMetadata, validateUploadGrant, } from '../domain/policies/handoff.policy.mjs';
import { contentJsonRecords, parseWholeBoundedJson } from '../../../transport/mcp/results.mjs';
const byteLength = (value) => Buffer.byteLength(value, 'utf8');
const PREPARED_RESULT_KEYS = ['artifactId', 'kind', 'ok', 'sha256', 'sizeBytes', 'status', 'summary', 'transcriptIncluded'];
const GRANT_RESULT_KEYS = ['expires_at', 'object_key', 'required_headers', 'upload_url'];
const exactKeysWithOptionalOperationDiagnostic = (candidate, keys) => {
    const names = Object.keys(candidate).filter((name) => name !== 'operationDiagnostic');
    return names.sort().join('\0') === [...keys].sort().join('\0');
};
const invalidPrepared = () => new FeedbackHandoffError('FEEDBACK_INVALID_PREPARED', 'The prepared feedback result is invalid.');
// Parse boundary: one candidate record of the prepare result, checked here.
const validatePreparedResult = (candidate) => {
    if (!isRecord(candidate) ||
        !exactKeysWithOptionalOperationDiagnostic(candidate, PREPARED_RESULT_KEYS) ||
        !validateSchemaValue(candidate, prepareContract.outputSchema) ||
        candidate.ok !== true ||
        candidate.status !== 'prepared' ||
        typeof candidate.summary !== 'string' ||
        byteLength(candidate.summary) < 1 ||
        byteLength(candidate.summary) > 2048) {
        throw invalidPrepared();
    }
    const metadata = validatePreparedMetadata({
        artifactId: candidate.artifactId,
        kind: candidate.kind,
        sizeBytes: candidate.sizeBytes,
        sha256: candidate.sha256,
        transcriptIncluded: candidate.transcriptIncluded,
    });
    return { ...metadata, summary: candidate.summary };
};
// Parse boundary: the prepare tool's result as the host recorded it.
export const extractPreparedMetadata = (toolResponse) => {
    let envelope;
    const candidates = [];
    if (Array.isArray(toolResponse)) {
        envelope = toolResponse;
    }
    else if (isRecord(toolResponse)) {
        if (Object.hasOwn(toolResponse, 'isError') && typeof toolResponse.isError !== 'boolean')
            throw invalidPrepared();
        if (toolResponse.isError === true)
            throw invalidPrepared();
        for (const key of ['structuredContent', 'structured_content']) {
            if (Object.hasOwn(toolResponse, key))
                candidates.push(toolResponse[key]);
        }
        if (Object.hasOwn(toolResponse, 'content') && !Array.isArray(toolResponse.content))
            throw invalidPrepared();
        envelope = toolResponse.content;
    }
    else {
        throw invalidPrepared();
    }
    const records = contentJsonRecords(envelope, invalidPrepared);
    candidates.push(...records);
    const [first, ...others] = candidates.map(validatePreparedResult);
    if (first === undefined)
        throw invalidPrepared();
    const canonical = JSON.stringify(first);
    if (others.some((candidate) => JSON.stringify(candidate) !== canonical)) {
        throw new FeedbackHandoffError('FEEDBACK_AMBIGUOUS_PREPARED', 'The prepared feedback result is ambiguous.');
    }
    const { summary: _summary, ...metadata } = first;
    return metadata;
};
const invalidGrant = () => new FeedbackHandoffError('FEEDBACK_INVALID_GRANT', 'The feedback upload grant is invalid.');
// Parse boundary: report_issue's result as the host recorded it.
const rawGrantCandidates = (toolResponse) => {
    if (Array.isArray(toolResponse))
        return contentJsonRecords(toolResponse, invalidGrant);
    if (typeof toolResponse === 'string') {
        return [parseWholeBoundedJson(toolResponse, invalidGrant)];
    }
    if (!isRecord(toolResponse))
        return [];
    if (Object.hasOwn(toolResponse, 'isError') && typeof toolResponse.isError !== 'boolean')
        throw invalidGrant();
    if (toolResponse.isError === true)
        throw invalidGrant();
    const candidates = [];
    for (const key of ['structuredContent', 'structured_content']) {
        if (Object.hasOwn(toolResponse, key))
            candidates.push(toolResponse[key]);
    }
    if (Object.hasOwn(toolResponse, 'content') && !Array.isArray(toolResponse.content))
        throw invalidGrant();
    const records = contentJsonRecords(toolResponse.content, invalidGrant);
    candidates.push(...records);
    return candidates;
};
export const extractUploadGrant = (toolResponse, { nowMs = Date.now(), expectedSize } = {}) => {
    // Parse boundary: each candidate record, checked here.
    const [first, ...others] = rawGrantCandidates(toolResponse).map((candidate) => {
        if (!isRecord(candidate) || !hasExactOwnKeys(candidate, GRANT_RESULT_KEYS)) {
            throw invalidGrant();
        }
        return validateUploadGrant({
            uploadUrl: candidate.upload_url,
            objectKey: candidate.object_key,
            requiredHeaders: candidate.required_headers,
            expiresAt: normalizeExpiresAt(candidate.expires_at, nowMs),
        }, { nowMs, expectedSize });
    });
    const fingerprint = (candidate) => JSON.stringify([
        candidate.uploadUrl,
        candidate.objectKey,
        Object.entries(candidate.requiredHeaders).sort(([left], [right]) => left.localeCompare(right)),
        candidate.expiresAt,
    ]);
    // No candidate at all is an invalid grant too.
    if (first === undefined)
        throw invalidGrant();
    const canonical = fingerprint(first);
    if (others.some((candidate) => fingerprint(candidate) !== canonical)) {
        throw new FeedbackHandoffError('FEEDBACK_AMBIGUOUS_GRANT', 'The feedback upload grant is ambiguous.');
    }
    return first;
};
