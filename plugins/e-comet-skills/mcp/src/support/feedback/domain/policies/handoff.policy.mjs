import { isAbsolute } from 'node:path';
import { UUID_V4, isNonNegativeSafeInteger, isPositiveSafeInteger, isRecord } from '../../../../shared/values.mjs';
import { FEEDBACK_MAX_BYTES as MAX_FEEDBACK_ARCHIVE_BYTES } from '../constants/limits.const.mjs';
import { foldFeedbackLineEndings, redactFeedbackText } from '../converters/report.converter.mjs';
import { isPublishableObjectKey } from './upload-destination.policy.mjs';
import { MAX_MCP_MESSAGE_BYTES } from '../../../../transport/mcp/limits.mjs';
// The rules of the feedback handoff a hook or the native adapter applies around the feedback tools: prepared and grant
// records, report_issue's grant, the trusted transcript path and the wire budget of a prepared report.
const MAX_TRANSCRIPT_PATH_BYTES = 4096;
export const CLOCK_SKEW_MS = 5000;
export const ARTIFACT_ID_PATTERN = new RegExp(`^${UUID_V4}$`);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
// The hook is dependency-free, so mirror the exact remote report_issue enum at this trust boundary.
export const FEEDBACK_KINDS = new Set(['bug', 'wrong_data', 'missing_capability', 'unclear_contract']);
export const isFeedbackKind = (value) => FEEDBACK_KINDS.has(value);
export const SUBMIT_TARGET_TOOL = 'submit_e_comet_feedback';
const MAX_UPLOAD_URL_BYTES = 8 * 1024;
const MAX_REQUIRED_HEADERS = 32;
const MAX_HEADER_NAME_BYTES = 128;
const MAX_HEADER_VALUE_BYTES = 8 * 1024;
const MAX_GRANT_PAYLOAD_BYTES = 48 * 1024;
// Numeric expiry uses the same calendar range as the four-digit ISO wire representation.
const MAX_EXPIRES_AT_SECONDS = 253402300799;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ISO_EXPIRY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const PROTOTYPE_SPECIAL_HEADER_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const ownedErrors = new WeakMap();
export class FeedbackHandoffError extends Error {
    constructor(code, message, cause) {
        super(message, { cause });
        this.name = 'FeedbackHandoffError';
        this.code = code;
        ownedErrors.set(this, { code, message });
    }
}
const byteLength = (value) => Buffer.byteLength(value, 'utf8');
// The closed code and message of a handoff error this module raised, or undefined for any other value.
export const ownedHandoffError = (error) => (typeof error === 'object' && error !== null ? ownedErrors.get(error) : undefined);
// Parse boundary: a record from a tool result or from disk, checked here.
export const validatePreparedMetadata = (metadata) => {
    if (!isRecord(metadata) ||
        Object.keys(metadata).sort().join('\0') !== ['artifactId', 'kind', 'sha256', 'sizeBytes', 'transcriptIncluded'].sort().join('\0') ||
        typeof metadata.artifactId !== 'string' ||
        !ARTIFACT_ID_PATTERN.test(metadata.artifactId) ||
        !isFeedbackKind(metadata.kind) ||
        !isPositiveSafeInteger(metadata.sizeBytes) ||
        metadata.sizeBytes > MAX_FEEDBACK_ARCHIVE_BYTES ||
        typeof metadata.sha256 !== 'string' ||
        !SHA256_PATTERN.test(metadata.sha256) ||
        typeof metadata.transcriptIncluded !== 'boolean') {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_PREPARED', 'The prepared feedback metadata is invalid.');
    }
    const { artifactId, kind, sizeBytes, sha256, transcriptIncluded } = metadata;
    return { artifactId, kind, sizeBytes, sha256, transcriptIncluded };
};
// Parse boundary: a record read from disk, checked here.
export const parsePreparedEntry = (entry) => {
    if (!isRecord(entry) ||
        Object.keys(entry).sort().join('\0') !==
            ['artifactId', 'createdAtMs', 'kind', 'sha256', 'sizeBytes', 'targetTool', 'transcriptIncluded', 'type', 'version']
                .sort()
                .join('\0') ||
        entry.version !== 1 ||
        entry.type !== 'prepared' ||
        entry.targetTool !== SUBMIT_TARGET_TOOL ||
        !isNonNegativeSafeInteger(entry.createdAtMs)) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_STATE', 'The feedback handoff state is invalid.');
    }
    const metadata = validatePreparedMetadata({
        artifactId: entry.artifactId,
        kind: entry.kind,
        sizeBytes: entry.sizeBytes,
        sha256: entry.sha256,
        transcriptIncluded: entry.transcriptIncluded,
    });
    return { version: 1, type: 'prepared', targetTool: SUBMIT_TARGET_TOOL, createdAtMs: entry.createdAtMs, ...metadata };
};
const cloneHeaders = (entries) => {
    const headers = {};
    for (const [name, value] of entries) {
        Object.defineProperty(headers, name, {
            value,
            enumerable: true,
            configurable: true,
            writable: true,
        });
    }
    return headers;
};
export const normalizeExpiresAt = (value, nowMs) => {
    let expiresAt;
    if (typeof value === 'number' && Number.isFinite(value)) {
        expiresAt = Math.floor(value);
    }
    else if (typeof value === 'string' && byteLength(value) <= 64) {
        const match = ISO_EXPIRY_PATTERN.exec(value);
        if (match) {
            const year = Number(match[1]);
            const month = Number(match[2]);
            const day = Number(match[3]);
            const hour = Number(match[4]);
            const minute = Number(match[5]);
            const second = Number(match[6]);
            const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
            const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
            const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
            const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
            if (daysInMonth !== undefined &&
                day >= 1 &&
                day <= daysInMonth &&
                hour <= 23 &&
                minute <= 59 &&
                second <= 59 &&
                offsetHour <= 23 &&
                offsetMinute <= 59) {
                const parsed = Date.parse(value);
                if (Number.isFinite(parsed))
                    expiresAt = Math.floor(parsed / 1000);
            }
        }
    }
    if (expiresAt === undefined ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt < 1 ||
        expiresAt > MAX_EXPIRES_AT_SECONDS ||
        !isNonNegativeSafeInteger(nowMs) ||
        expiresAt * 1000 <= nowMs) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_GRANT', 'The feedback upload grant is invalid.');
    }
    return expiresAt;
};
// Parse boundary: a grant from report_issue or from disk, checked here.
export const validateUploadGrant = (grant, { nowMs, expectedSize, allowExpired = false }) => {
    if (!isRecord(grant) ||
        Object.keys(grant).sort().join('\0') !== ['expiresAt', 'objectKey', 'requiredHeaders', 'uploadUrl'].sort().join('\0') ||
        typeof grant.uploadUrl !== 'string' ||
        byteLength(grant.uploadUrl) < 1 ||
        byteLength(grant.uploadUrl) > MAX_UPLOAD_URL_BYTES ||
        typeof grant.objectKey !== 'string' ||
        !isPublishableObjectKey(grant.objectKey) ||
        !isRecord(grant.requiredHeaders) ||
        !isPositiveSafeInteger(grant.expiresAt) ||
        grant.expiresAt > MAX_EXPIRES_AT_SECONDS ||
        (!allowExpired && grant.expiresAt * 1000 <= nowMs) ||
        !isPositiveSafeInteger(expectedSize) ||
        expectedSize > MAX_FEEDBACK_ARCHIVE_BYTES) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_GRANT', 'The feedback upload grant is invalid.');
    }
    let target;
    try {
        target = new URL(grant.uploadUrl);
    }
    catch {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_GRANT', 'The feedback upload grant is invalid.');
    }
    if (target.protocol !== 'https:' || target.username || target.password || target.hash) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_GRANT', 'The feedback upload grant is invalid.');
    }
    const entries = Object.entries(grant.requiredHeaders);
    if (entries.length > MAX_REQUIRED_HEADERS) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_GRANT', 'The feedback upload grant is invalid.');
    }
    const seen = new Set();
    const headers = [];
    for (const [name, value] of entries) {
        const normalized = name.toLowerCase();
        if (!HEADER_NAME_PATTERN.test(name) ||
            byteLength(name) > MAX_HEADER_NAME_BYTES ||
            typeof value !== 'string' ||
            byteLength(value) > MAX_HEADER_VALUE_BYTES ||
            HEADER_VALUE_CONTROL_CHARACTERS.test(value) ||
            seen.has(normalized) ||
            normalized === 'transfer-encoding' ||
            PROTOTYPE_SPECIAL_HEADER_NAMES.has(normalized) ||
            (normalized === 'content-length' && value !== String(expectedSize))) {
            throw new FeedbackHandoffError('FEEDBACK_INVALID_GRANT', 'The feedback upload grant is invalid.');
        }
        seen.add(normalized);
        headers.push([name, value]);
    }
    const validated = {
        uploadUrl: grant.uploadUrl,
        objectKey: grant.objectKey,
        requiredHeaders: cloneHeaders(headers),
        expiresAt: grant.expiresAt,
    };
    if (byteLength(JSON.stringify(validated)) > MAX_GRANT_PAYLOAD_BYTES) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_GRANT', 'The feedback upload grant is invalid.');
    }
    return validated;
};
export const grantRefreshRequired = () => new FeedbackHandoffError('FEEDBACK_GRANT_REFRESH_REQUIRED', 'The feedback upload grant needs fresh authorization. Call report_issue again for the same prepared artifact.');
export const requireGrantLifetime = (grant, { nowMs, minimumRemainingMs }) => {
    if (grant.expiresAt * 1000 - nowMs < minimumRemainingMs)
        throw grantRefreshRequired();
};
// Parse boundary: a record read from disk, checked here.
export const parseGrantEntry = (entry, { nowMs, retentionMs, allowExpired = false }) => {
    const expectedKeys = [
        'artifactId',
        'createdAtMs',
        'expiresAt',
        'kind',
        'objectKey',
        'requiredHeaders',
        'sha256',
        'sizeBytes',
        'targetTool',
        'transcriptIncluded',
        'type',
        'uploadUrl',
        'version',
    ];
    if (!isRecord(entry) ||
        Object.keys(entry).sort().join('\0') !== expectedKeys.sort().join('\0') ||
        entry.version !== 1 ||
        entry.type !== 'grant' ||
        entry.targetTool !== SUBMIT_TARGET_TOOL ||
        !isNonNegativeSafeInteger(entry.createdAtMs) ||
        !isFreshEntry({ createdAtMs: entry.createdAtMs }, nowMs, retentionMs)) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_STATE', 'The feedback handoff state is invalid.');
    }
    const metadata = validatePreparedMetadata({
        artifactId: entry.artifactId,
        kind: entry.kind,
        sizeBytes: entry.sizeBytes,
        sha256: entry.sha256,
        transcriptIncluded: entry.transcriptIncluded,
    });
    const grant = validateUploadGrant({
        uploadUrl: entry.uploadUrl,
        objectKey: entry.objectKey,
        requiredHeaders: entry.requiredHeaders,
        expiresAt: entry.expiresAt,
    }, { nowMs, expectedSize: entry.sizeBytes, allowExpired });
    return { ...entry, ...metadata, ...grant };
};
export const isFreshEntry = (entry, nowMs, retentionMs) => entry.createdAtMs <= nowMs + CLOCK_SKEW_MS && nowMs - entry.createdAtMs <= retentionMs;
// Parse boundary: report_issue's model-authored arguments, checked here.
export const validateRemoteInput = (remoteInput) => {
    if (!isRecord(remoteInput) ||
        Object.keys(remoteInput).sort().join('\0') !== ['kind', 'size_bytes'].sort().join('\0') ||
        !isFeedbackKind(remoteInput.kind) ||
        !isPositiveSafeInteger(remoteInput.size_bytes) ||
        remoteInput.size_bytes > MAX_FEEDBACK_ARCHIVE_BYTES) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_INPUT', 'The remote feedback arguments are invalid.');
    }
    return { kind: remoteInput.kind, sizeBytes: remoteInput.size_bytes };
};
export const validateTranscriptPath = (path) => {
    if (typeof path !== 'string' || byteLength(path) < 1 || byteLength(path) > MAX_TRANSCRIPT_PATH_BYTES || !isAbsolute(path)) {
        throw new FeedbackHandoffError('FEEDBACK_TRANSCRIPT_UNAVAILABLE', 'The trusted feedback transcript is unavailable.');
    }
    return path;
};
// Hooks receive arguments, not the host's JSON-RPC id/_meta. Leave bounded headroom
// for supported host envelopes, in addition to measuring the injected fields themselves.
const FEEDBACK_ENVELOPE_RESERVE_BYTES = 4096;
const REPORT_SHORTENING_MARKER = '\n[... middle omitted to fit the feedback request size limit ...]\n';
const shortenReportMiddle = (text, retained) => {
    if (retained >= text.length)
        return text;
    let head = Math.ceil(retained / 2);
    let tail = text.length - Math.floor(retained / 2);
    // Keep surrogate pairs intact without materializing a code-point array of a huge report.
    if (head > 0 && /[\uD800-\uDBFF]/u.test(text[head - 1] ?? '') && /[\uDC00-\uDFFF]/u.test(text[head] ?? ''))
        head -= 1;
    if (tail > 0 && /[\uD800-\uDBFF]/u.test(text[tail - 1] ?? '') && /[\uDC00-\uDFFF]/u.test(text[tail] ?? ''))
        tail += 1;
    return text.slice(0, head) + REPORT_SHORTENING_MARKER + text.slice(tail);
};
// Every route fits the report to the host wire envelope the native route has to satisfy.
export const fitPrepareWireInput = (input, transportFields = {
    feedbackClaim: 'a'.repeat(43),
    feedbackSession: 'a'.repeat(64),
}) => {
    const fits = (value) => byteLength(JSON.stringify({ ...value, ...transportFields })) <= MAX_MCP_MESSAGE_BYTES - FEEDBACK_ENVELOPE_RESERVE_BYTES;
    if (fits(input))
        return input;
    // Cutting a header/key away from its credential value defeats contextual redaction.
    // Redact whole source fields before any cut, then bind only the final safe text. Line endings are
    // folded first, exactly as the canonical report does: redacting lone-CR text unfolded would treat
    // the whole report as one header line and swallow its contents into a single redaction.
    let fitted = {
        ...input,
        summary: redactFeedbackText(foldFeedbackLineEndings(input.summary)),
        details: redactFeedbackText(foldFeedbackLineEndings(input.details)),
    };
    // Details are the ordinary oversized field. Summary is only a last resort when
    // it alone exhausts the budget; normal inputs and the trusted transcript path stay unchanged.
    for (const field of ['details', 'summary']) {
        if (fits(fitted))
            return fitted;
        const original = fitted[field];
        const minimumRetained = Math.min(original.length, 128);
        const shortened = shortenReportMiddle(original, minimumRetained);
        // An omission marker must not enlarge an ordinary field just because another field is huge.
        if (byteLength(JSON.stringify(shortened)) >= byteLength(JSON.stringify(original)))
            continue;
        const minimum = { ...fitted, [field]: shortened };
        if (!fits(minimum)) {
            fitted = minimum;
            continue;
        }
        let low = minimumRetained;
        let high = original.length - 1;
        while (low < high) {
            const retained = Math.ceil((low + high) / 2);
            if (fits({ ...fitted, [field]: shortenReportMiddle(original, retained) }))
                low = retained;
            else
                high = retained - 1;
        }
        return { ...fitted, [field]: shortenReportMiddle(original, low) };
    }
    if (!fits(fitted))
        throw new FeedbackHandoffError('FEEDBACK_INVALID_INPUT', 'The feedback request envelope is too large.');
    return fitted;
};
