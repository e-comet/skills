import { FEEDBACK_CLOUD_MAX_BYTES } from './config.mjs';

export const FEEDBACK_HOST_ADAPTER_VERSION = 1;
export const FEEDBACK_CLOUD_TRANSPORT_VERSION = 1;
export const FEEDBACK_CLOUD_ARCHIVE_BASE64_MAX_LENGTH = Math.ceil(FEEDBACK_CLOUD_MAX_BYTES / 3) * 4;

const UUID_V4_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const feedbackHostAdapterMarkerSchema = {
    type: 'object',
    properties: {
        version: { const: FEEDBACK_HOST_ADAPTER_VERSION },
        operationId: { type: 'string', pattern: UUID_V4_RE.source },
        nonce: { type: 'string', pattern: NONCE_RE.source },
    },
    required: ['version', 'operationId', 'nonce'],
    additionalProperties: false,
};

export const feedbackCloudTransportSchema = {
    type: 'object',
    properties: {
        version: { const: FEEDBACK_CLOUD_TRANSPORT_VERSION },
        operationId: { type: 'string', pattern: UUID_V4_RE.source },
        nonce: { type: 'string', pattern: NONCE_RE.source },
        transcriptIncluded: { type: 'boolean' },
        archiveBase64: { type: 'string', minLength: 4, maxLength: FEEDBACK_CLOUD_ARCHIVE_BASE64_MAX_LENGTH, pattern: BASE64_RE.source },
    },
    required: ['version', 'operationId', 'nonce', 'transcriptIncluded', 'archiveBase64'],
    additionalProperties: false,
};

const CLOUD_SUBMIT_KEYS = new Set(['artifactId', 'uploadUrl', 'requiredHeaders', 'objectKey', 'expiresAt', 'expectedSize', 'expectedSha256', 'feedbackCloud']);

export const hasFeedbackCloudTransport = (input) =>
    input !== null && typeof input === 'object' && !Array.isArray(input) && Object.hasOwn(input, 'feedbackCloud');

export const isValidFeedbackCloudSubmitInput = (input) => {
    if (!hasFeedbackCloudTransport(input) || Object.keys(input).some((key) => !CLOUD_SUBMIT_KEYS.has(key))) return false;
    const marker = input.feedbackCloud;
    if (marker === null || typeof marker !== 'object' || Array.isArray(marker)) return false;
    const keys = Object.keys(marker);
    if (keys.length !== 5 || !feedbackCloudTransportSchema.required.every((key) => Object.hasOwn(marker, key))) return false;
    return marker.version === FEEDBACK_CLOUD_TRANSPORT_VERSION
        && typeof marker.operationId === 'string' && UUID_V4_RE.test(marker.operationId)
        && typeof marker.nonce === 'string' && NONCE_RE.test(marker.nonce)
        && typeof marker.transcriptIncluded === 'boolean'
        && typeof marker.archiveBase64 === 'string'
        && marker.archiveBase64.length >= 4 && marker.archiveBase64.length <= FEEDBACK_CLOUD_ARCHIVE_BASE64_MAX_LENGTH
        && BASE64_RE.test(marker.archiveBase64);
};

const INPUT_KEYS = {
    prepare_e_comet_feedback: new Set(['kind', 'summary', 'details', 'includeTranscript', 'feedbackAdapter']),
};

export const hasFeedbackHostAdapterMarker = (input) =>
    input !== null && typeof input === 'object' && Object.hasOwn(input, 'feedbackAdapter');

export const isValidFeedbackHostAdapterInput = (targetTool, input) => {
    const allowed = INPUT_KEYS[targetTool];
    const marker = input?.feedbackAdapter;
    if (!allowed || input === null || typeof input !== 'object' || Array.isArray(input)) return false;
    if (Object.keys(input).some((key) => !allowed.has(key))) return false;
    if (marker === null || typeof marker !== 'object' || Array.isArray(marker)) return false;
    if (Object.keys(marker).length !== 3 || !['version', 'operationId', 'nonce'].every((key) => Object.hasOwn(marker, key))) return false;
    return marker.version === FEEDBACK_HOST_ADAPTER_VERSION
        && typeof marker.operationId === 'string'
        && typeof marker.nonce === 'string'
        && UUID_V4_RE.test(marker.operationId)
        && NONCE_RE.test(marker.nonce);
};

// The cloud prepare handshake compares the complete placeholder, including prose. Treat edits as
// protocol changes and coordinate the adapter version; these strings are not independently editable UI copy.
const messages = {
    prepare_e_comet_feedback: 'The host feedback preparation result is unavailable. Do not authorize or submit feedback from this result.',
};

export const feedbackHostResultUnavailable = (targetTool, marker) => ({
    ok: false,
    status: 'host_result_unavailable',
    adapter: {
        version: marker.version,
        operationId: marker.operationId,
        nonce: marker.nonce,
        targetTool,
    },
    error: {
        code: 'FEEDBACK_HOST_RESULT_UNAVAILABLE',
        message: messages[targetTool],
        stage: 'handoff',
        retryable: false,
    },
});
