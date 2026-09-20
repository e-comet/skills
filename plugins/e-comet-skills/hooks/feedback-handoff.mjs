#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { MAX_MCP_MESSAGE_BYTES, FEEDBACK_MAX_BYTES as MAX_FEEDBACK_ARCHIVE_BYTES,
    FEEDBACK_ARTIFACT_RETENTION_MS as STATE_RETENTION_MS } from '../mcp/src/config.mjs';
import { sweepExpired } from '../mcp/src/file-retention.mjs';
import { loadHookSecret, signHookFields } from '../mcp/src/hook-signature.mjs';
import { foldFeedbackLineEndings, redactFeedbackText } from '../mcp/src/feedback-report.mjs';
import { isPublishableObjectKey, toolInputSchemas, toolOutputSchemas, validateSchemaValue } from '../mcp/src/tool-schemas.mjs';
import { FEEDBACK_DIAGNOSTIC_FILESYSTEM_CODES, feedbackDiagnostics, safeFeedbackProperty, withFeedbackOperation } from '../mcp/src/feedback-diagnostics.mjs';
import { retryTransientFileOperation } from './transient-file-operation.mjs';
import { withHookDiagnostic } from './hook-diagnostics.mjs';

// PostToolUse can carry one maximum-size MCP request and response. Reserve another 256 KiB for the
// host's session/tool metadata and platform paths while keeping malformed stdin decisively bounded.
const MAX_HOOK_EVENT_BYTES = 2 * MAX_MCP_MESSAGE_BYTES + 256 * 1024;
const MAX_SESSION_ID_BYTES = 512;
const MAX_TRANSCRIPT_PATH_BYTES = 4096;
const MAX_STATE_FILE_BYTES = 64 * 1024;
const CLOCK_SKEW_MS = 5000;
const STORE_DIRECTORY = 'feedback-handoff-v1';
const STATE_FILE_PATTERN = /^([a-f0-9]{64})\.(prepared|grant)\.json$/;
const CLAIMED_MARKER_PATTERN = /^[a-f0-9]{64}\.grant\.claimed$/;
const TEMPORARY_STATE_PATTERN = /^[a-f0-9]{64}\.(?:prepared|grant)\.[0-9a-f-]{36}\.tmp$/;
const ARTIFACT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
// The hook is dependency-free, so mirror the exact remote report_issue enum at this trust boundary.
const FEEDBACK_KINDS = new Set(['bug', 'wrong_data', 'missing_capability', 'unclear_contract']);
const SUBMIT_TARGET_TOOL = 'submit_e_comet_feedback';
const COWORK_UUID_NAMESPACE = '2da262fd-fd1f-4636-90cb-75b02fd1f1f1';
const MAX_UPLOAD_URL_BYTES = 8 * 1024;
const MAX_REQUIRED_HEADERS = 32;
const MAX_HEADER_NAME_BYTES = 128;
const MAX_HEADER_VALUE_BYTES = 8 * 1024;
const MAX_GRANT_PAYLOAD_BYTES = 48 * 1024;
// Numeric expiry uses the same calendar range as the four-digit ISO wire representation.
const MAX_EXPIRES_AT_SECONDS = 253402300799;
const GRANT_START_WINDOW_MS = 30_000;
const GRANT_HANDOFF_RESERVE_MS = 5_000;
// WHY: the grant must survive ordinary Post->Pre scheduling and the start of the PUT. Its expiry
// is not coupled to the uploader's longer wall deadline for completing an already-started request.
const MIN_STAGE_GRANT_REMAINING_MS = GRANT_START_WINDOW_MS + GRANT_HANDOFF_RESERVE_MS;
// A grant claimed inside its last minute can still expire before a bridged device starts the PUT: accepted residual, see docs/local-agent-architecture.md#accepted-residuals.
const MIN_CLAIM_GRANT_REMAINING_MS = GRANT_START_WINDOW_MS;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ISO_EXPIRY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const PROTOTYPE_SPECIAL_HEADER_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const LOCAL_FEEDBACK_TOOL =
    /^mcp__(?:(?:remote-devices__)?plugin_e-comet-skills_)?e[-_]comet[-_]local__(?:prepare_e_comet_feedback|submit_e_comet_feedback)$/;
const CLOUD_FEEDBACK_TOOL =
    /^mcp__remote-devices__plugin_e-comet-skills_e-comet-local__(?:prepare_e_comet_feedback|submit_e_comet_feedback)$/;
const REMOTE_REPORT_ISSUE_TOOL = new RegExp(
    `^mcp__(?:e[-_]comet|e_comet_stage|https_mcp_(?:stage_int_)?e[-_]comet_io_mcp|plugin_e-comet-skills_e-comet|remote-devices__plugin_e-comet-skills_e-comet|${COWORK_UUID_NAMESPACE})__report_issue$`
);

const ownedErrors = new WeakMap();
class FeedbackHandoffError extends Error {
    constructor(code, message, cause) {
        super(message, { cause });
        this.name = 'FeedbackHandoffError';
        this.code = code;
        ownedErrors.set(this, { code, message });
    }
}

const byteLength = (value) => Buffer.byteLength(value, 'utf8');
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validateSessionId = (sessionId) => {
    if (
        typeof sessionId !== 'string' ||
        byteLength(sessionId) < 1 ||
        byteLength(sessionId) > MAX_SESSION_ID_BYTES
    ) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_SESSION', 'The feedback handoff session is invalid.');
    }
    return sessionId;
};

const sessionIdFromEvent = (event) => validateSessionId(event.session_id ?? event.sessionId);
const eventNameFromEvent = (event) => event.hook_event_name ?? event.hookEventName;
const toolNameFromEvent = (event) => event.tool_name ?? event.toolName;
const toolInputFromEvent = (event) => event.tool_input ?? event.toolInput;
const toolResponseFromEvent = (event) => event.tool_response ?? event.toolResponse;

const hashSessionId = (sessionId) =>
    createHash('sha256').update(validateSessionId(sessionId), 'utf8').digest('hex');

const resolveStoreDirectory = (env) => {
    const pluginData = env.CLAUDE_PLUGIN_DATA || env.PLUGIN_DATA;
    if (typeof pluginData !== 'string' || !pluginData.trim()) {
        throw new FeedbackHandoffError(
            'FEEDBACK_DATA_DIR_UNAVAILABLE',
            'The desktop client did not provide writable plugin storage.'
        );
    }
    return join(resolve(pluginData), STORE_DIRECTORY);
};

export const cloudPostToolOutput = result => ({ exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PostToolUse', updatedToolOutput: [{ type: 'text', text: JSON.stringify(result) }],
} }), stderr: '' });
const preparedPathForSession = (dataDirectory, sessionId) =>
    join(dataDirectory, `${hashSessionId(sessionId)}.prepared.json`);
const grantPathForSession = (dataDirectory, sessionId) =>
    join(dataDirectory, `${hashSessionId(sessionId)}.grant.json`);
const claimedMarkerPathForSession = (dataDirectory, sessionId) =>
    join(dataDirectory, `${hashSessionId(sessionId)}.grant.claimed`);

const hasSessionHandoff = async (directory, sessionId) => {
    for (const path of [preparedPathForSession(directory, sessionId), grantPathForSession(directory, sessionId)]) {
        try {
            await stat(path);
            return true;
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
    return false;
};

const cloudHandoffForSession = async (env, sessionId) => {
    // The remote report_issue namespace identifies its provider, not the local prepare/submit
    // consumer. Both consumers can use that provider; route this grant through the session's prepared
    // state. Without matching prepared metadata, stageUploadGrant rejects rather than creating a
    // native grant.
    const directory = join(resolveStoreDirectory(env), '..', 'feedback-cloud-v1', 'handoff');
    return await hasSessionHandoff(directory, sessionId) ? directory : undefined;
};

const ensurePrivateStoreDirectory = async (dataDirectory) => {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(dataDirectory, 0o700);
};

const removeFile = (path) => retryTransientFileOperation(() => rm(path, { force: true }));
// Removal that has to distinguish "gone" from "removed by me": `force` would report success for a file
// another claimer already consumed. Same transient-lock patience as removeFile, ENOENT still raised.
const consumeFile = (path) => retryTransientFileOperation(() => unlink(path));

const isOwnStateName = (name) =>
    STATE_FILE_PATTERN.test(name) || CLAIMED_MARKER_PATTERN.test(name) || TEMPORARY_STATE_PATTERN.test(name);

// Housekeeping only. Age is the file's own mtime, never the caller's logical clock, so a host or test
// clock offset can never remove live state; record freshness stays with createdAtMs. Only this grammar
// is swept: the previous build's lock directory, candidates and claim files in the same root are
// unknown names here and are neither removed nor read.
const sweepState = (dataDirectory, retentionMs) => sweepExpired({
    directory: dataDirectory,
    ownName: isOwnStateName,
    retentionMs: retentionMs + CLOCK_SKEW_MS,
});

const publishState = async (path, value) => {
    const serialized = JSON.stringify(value);
    if (byteLength(serialized) > MAX_STATE_FILE_BYTES) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_STATE', 'The feedback handoff state is invalid.');
    }
    // One writer per session publishes by rename: there is nothing to elect and nothing to back up.
    const temporaryPath = `${path.replace(/\.json$/, '')}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try {
        if (process.platform !== 'win32') await chmod(temporaryPath, 0o600);
        await retryTransientFileOperation(() => rename(temporaryPath, path));
    } finally {
        await removeFile(temporaryPath).catch(() => undefined);
    }
};

// Reads through a symlink, unlike the cloud store's lstat: accepted residual, see docs/local-agent-architecture.md#accepted-residuals.
const readBoundedState = async (path) => {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_STATE_FILE_BYTES) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_STATE', 'The feedback handoff state is invalid.');
    }
    const text = await readFile(path, 'utf8');
    if (byteLength(text) > MAX_STATE_FILE_BYTES) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_STATE', 'The feedback handoff state is invalid.');
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_STATE', 'The feedback handoff state is invalid.');
    }
};

const validatePreparedMetadata = (metadata) => {
    if (
        !isRecord(metadata) ||
        Object.keys(metadata).sort().join('\0') !==
            ['artifactId', 'kind', 'sha256', 'sizeBytes', 'transcriptIncluded'].sort().join('\0') ||
        typeof metadata.artifactId !== 'string' ||
        !ARTIFACT_ID_PATTERN.test(metadata.artifactId) ||
        !FEEDBACK_KINDS.has(metadata.kind) ||
        !Number.isSafeInteger(metadata.sizeBytes) ||
        metadata.sizeBytes < 1 ||
        metadata.sizeBytes > MAX_FEEDBACK_ARCHIVE_BYTES ||
        typeof metadata.sha256 !== 'string' ||
        !SHA256_PATTERN.test(metadata.sha256) ||
        typeof metadata.transcriptIncluded !== 'boolean'
    ) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_PREPARED', 'The prepared feedback metadata is invalid.');
    }
    return { ...metadata };
};

const parsePreparedEntry = (entry) => {
    if (
        !isRecord(entry) ||
        Object.keys(entry).sort().join('\0') !==
            [
                'artifactId',
                'createdAtMs',
                'kind',
                'sha256',
                'sizeBytes',
                'targetTool',
                'transcriptIncluded',
                'type',
                'version',
            ].sort().join('\0') ||
        entry.version !== 1 ||
        entry.type !== 'prepared' ||
        entry.targetTool !== SUBMIT_TARGET_TOOL ||
        !Number.isSafeInteger(entry.createdAtMs) ||
        entry.createdAtMs < 0
    ) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_STATE', 'The feedback handoff state is invalid.');
    }
    validatePreparedMetadata({
        artifactId: entry.artifactId,
        kind: entry.kind,
        sizeBytes: entry.sizeBytes,
        sha256: entry.sha256,
        transcriptIncluded: entry.transcriptIncluded,
    });
    return entry;
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
    } else if (typeof value === 'string' && byteLength(value) <= 64) {
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
            if (
                daysInMonth !== undefined &&
                day >= 1 &&
                day <= daysInMonth &&
                hour <= 23 &&
                minute <= 59 &&
                second <= 59 &&
                offsetHour <= 23 &&
                offsetMinute <= 59
            ) {
                const parsed = Date.parse(value);
                if (Number.isFinite(parsed)) expiresAt = Math.floor(parsed / 1000);
            }
        }
    }
    if (
        !Number.isSafeInteger(expiresAt) ||
        expiresAt < 1 ||
        expiresAt > MAX_EXPIRES_AT_SECONDS ||
        !Number.isSafeInteger(nowMs) ||
        nowMs < 0 ||
        expiresAt * 1000 <= nowMs
    ) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_GRANT', 'The feedback upload grant is invalid.');
    }
    return expiresAt;
};

const validateUploadGrant = (grant, { nowMs, expectedSize, allowExpired = false }) => {
    if (
        !isRecord(grant) ||
        Object.keys(grant).sort().join('\0') !==
            ['expiresAt', 'objectKey', 'requiredHeaders', 'uploadUrl'].sort().join('\0') ||
        typeof grant.uploadUrl !== 'string' ||
        byteLength(grant.uploadUrl) < 1 ||
        byteLength(grant.uploadUrl) > MAX_UPLOAD_URL_BYTES ||
        !isPublishableObjectKey(grant.objectKey) ||
        !isRecord(grant.requiredHeaders) ||
        !Number.isSafeInteger(grant.expiresAt) ||
        grant.expiresAt < 1 ||
        grant.expiresAt > MAX_EXPIRES_AT_SECONDS ||
        !allowExpired && grant.expiresAt * 1000 <= nowMs ||
        !Number.isSafeInteger(expectedSize) ||
        expectedSize < 1 ||
        expectedSize > MAX_FEEDBACK_ARCHIVE_BYTES
    ) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_GRANT', 'The feedback upload grant is invalid.');
    }
    let target;
    try {
        target = new URL(grant.uploadUrl);
    } catch {
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
    for (const [name, value] of entries) {
        const normalized = name.toLowerCase();
        if (
            !HEADER_NAME_PATTERN.test(name) ||
            byteLength(name) > MAX_HEADER_NAME_BYTES ||
            typeof value !== 'string' ||
            byteLength(value) > MAX_HEADER_VALUE_BYTES ||
            HEADER_VALUE_CONTROL_CHARACTERS.test(value) ||
            seen.has(normalized) ||
            normalized === 'transfer-encoding' ||
            PROTOTYPE_SPECIAL_HEADER_NAMES.has(normalized) ||
            normalized === 'content-length' && value !== String(expectedSize)
        ) {
            throw new FeedbackHandoffError('FEEDBACK_INVALID_GRANT', 'The feedback upload grant is invalid.');
        }
        seen.add(normalized);
    }
    const validated = {
        uploadUrl: grant.uploadUrl,
        objectKey: grant.objectKey,
        requiredHeaders: cloneHeaders(entries),
        expiresAt: grant.expiresAt,
    };
    if (byteLength(JSON.stringify(validated)) > MAX_GRANT_PAYLOAD_BYTES) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_GRANT', 'The feedback upload grant is invalid.');
    }
    return validated;
};

const grantRefreshRequired = () => new FeedbackHandoffError(
    'FEEDBACK_GRANT_REFRESH_REQUIRED',
    'The feedback upload grant needs fresh authorization. Call report_issue again for the same prepared artifact.'
);

const requireGrantLifetime = (grant, { nowMs, minimumRemainingMs }) => {
    if (grant.expiresAt * 1000 - nowMs < minimumRemainingMs) throw grantRefreshRequired();
};

const parseGrantEntry = (entry, { nowMs, retentionMs, allowExpired = false }) => {
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
    if (
        !isRecord(entry) ||
        Object.keys(entry).sort().join('\0') !== expectedKeys.sort().join('\0') ||
        entry.version !== 1 ||
        entry.type !== 'grant' ||
        entry.targetTool !== SUBMIT_TARGET_TOOL ||
        !Number.isSafeInteger(entry.createdAtMs) ||
        entry.createdAtMs < 0 ||
        !isFreshEntry(entry, nowMs, retentionMs)
    ) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_STATE', 'The feedback handoff state is invalid.');
    }
    const metadata = validatePreparedMetadata({
        artifactId: entry.artifactId,
        kind: entry.kind,
        sizeBytes: entry.sizeBytes,
        sha256: entry.sha256,
        transcriptIncluded: entry.transcriptIncluded,
    });
    const grant = validateUploadGrant(
        {
            uploadUrl: entry.uploadUrl,
            objectKey: entry.objectKey,
            requiredHeaders: entry.requiredHeaders,
            expiresAt: entry.expiresAt,
        },
        { nowMs, expectedSize: entry.sizeBytes, allowExpired }
    );
    return { ...entry, ...metadata, ...grant };
};

const isFreshEntry = (entry, nowMs, retentionMs) =>
    entry.createdAtMs <= nowMs + CLOCK_SKEW_MS && nowMs - entry.createdAtMs <= retentionMs;

const MAX_TOOL_RESULT_JSON_BYTES = MAX_MCP_MESSAGE_BYTES;
const PREPARED_RESULT_KEYS = [
    'artifactId',
    'kind',
    'ok',
    'sha256',
    'sizeBytes',
    'status',
    'summary',
    'transcriptIncluded',
];
const GRANT_RESULT_KEYS = ['expires_at', 'object_key', 'required_headers', 'upload_url'];
const exactKeys = (candidate, keys) =>
    Object.keys(candidate).sort().join('\0') === [...keys].sort().join('\0');
const exactKeysWithOptionalOperationDiagnostic = (candidate, keys) => {
    const names = Object.keys(candidate).filter((name) => name !== 'operationDiagnostic');
    return names.sort().join('\0') === [...keys].sort().join('\0');
};

const parseWholeBoundedJson = (text, invalid) => {
    if (typeof text !== 'string' || byteLength(text) > MAX_TOOL_RESULT_JSON_BYTES) throw invalid();
    const trimmed = text.trim();
    if (!trimmed) throw invalid();
    try {
        return JSON.parse(trimmed);
    } catch {
        throw invalid();
    }
};

const looksLikeJsonCandidate = (text) => {
    if (typeof text !== 'string') return false;
    return text.trimStart().startsWith('{');
};

const contentJsonRecords = (content, invalid) => {
    if (!Array.isArray(content)) return [];
    const candidates = [];
    for (const item of content) {
        if (!isRecord(item) || item.type !== 'text' || typeof item.text !== 'string') continue;
        if (!looksLikeJsonCandidate(item.text)) continue;
        candidates.push(parseWholeBoundedJson(item.text, invalid));
    }
    return candidates;
};

const invalidPrepared = () =>
    new FeedbackHandoffError('FEEDBACK_INVALID_PREPARED', 'The prepared feedback result is invalid.');

const validatePreparedResult = (candidate) => {
    if (
        !isRecord(candidate) ||
        !exactKeysWithOptionalOperationDiagnostic(candidate, PREPARED_RESULT_KEYS) ||
        !validateSchemaValue(candidate, toolOutputSchemas.prepare_e_comet_feedback) ||
        candidate.ok !== true ||
        candidate.status !== 'prepared' ||
        typeof candidate.summary !== 'string' ||
        byteLength(candidate.summary) < 1 ||
        byteLength(candidate.summary) > 2048
    ) {
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

export const extractPreparedMetadata = (toolResponse) => {
    let envelope;
    let candidates = [];
    if (Array.isArray(toolResponse)) {
        envelope = toolResponse;
    } else if (isRecord(toolResponse)) {
        if (hasOwn(toolResponse, 'isError') && typeof toolResponse.isError !== 'boolean') throw invalidPrepared();
        if (toolResponse.isError === true) throw invalidPrepared();
        for (const key of ['structuredContent', 'structured_content']) {
            if (hasOwn(toolResponse, key)) candidates.push(toolResponse[key]);
        }
        if (hasOwn(toolResponse, 'content') && !Array.isArray(toolResponse.content)) throw invalidPrepared();
        envelope = toolResponse.content;
    } else {
        throw invalidPrepared();
    }
    candidates.push(...contentJsonRecords(envelope, invalidPrepared));
    if (candidates.length === 0) throw invalidPrepared();
    const validated = candidates.map(validatePreparedResult);
    const canonical = JSON.stringify(validated[0]);
    if (validated.some((candidate) => JSON.stringify(candidate) !== canonical)) {
        throw new FeedbackHandoffError('FEEDBACK_AMBIGUOUS_PREPARED', 'The prepared feedback result is ambiguous.');
    }
    const { summary: _summary, ...metadata } = validated[0];
    return metadata;
};

const invalidGrant = () =>
    new FeedbackHandoffError('FEEDBACK_INVALID_GRANT', 'The feedback upload grant is invalid.');

const rawGrantCandidates = (toolResponse) => {
    if (Array.isArray(toolResponse)) return contentJsonRecords(toolResponse, invalidGrant);
    if (typeof toolResponse === 'string') {
        return [parseWholeBoundedJson(toolResponse, invalidGrant)];
    }
    if (!isRecord(toolResponse)) return [];
    if (hasOwn(toolResponse, 'isError') && typeof toolResponse.isError !== 'boolean') throw invalidGrant();
    if (toolResponse.isError === true) throw invalidGrant();
    const candidates = [];
    for (const key of ['structuredContent', 'structured_content']) {
        if (hasOwn(toolResponse, key)) candidates.push(toolResponse[key]);
    }
    if (hasOwn(toolResponse, 'content') && !Array.isArray(toolResponse.content)) throw invalidGrant();
    candidates.push(...contentJsonRecords(toolResponse.content, invalidGrant));
    return candidates;
};

export const extractUploadGrant = (toolResponse, { nowMs = Date.now(), expectedSize } = {}) => {
    const candidates = rawGrantCandidates(toolResponse);
    if (candidates.length === 0) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_GRANT', 'The feedback upload grant is invalid.');
    }
    const validated = candidates.map((candidate) => {
        if (
            !isRecord(candidate) ||
            !exactKeys(candidate, GRANT_RESULT_KEYS)
        ) {
            throw invalidGrant();
        }
        return validateUploadGrant(
            {
                uploadUrl: candidate.upload_url,
                objectKey: candidate.object_key,
                requiredHeaders: candidate.required_headers,
                expiresAt: normalizeExpiresAt(candidate.expires_at, nowMs),
            },
            { nowMs, expectedSize }
        );
    });
    const fingerprint = (candidate) =>
        JSON.stringify([
            candidate.uploadUrl,
            candidate.objectKey,
            Object.entries(candidate.requiredHeaders).sort(([left], [right]) => left.localeCompare(right)),
            candidate.expiresAt,
        ]);
    const canonical = fingerprint(validated[0]);
    if (validated.some((candidate) => fingerprint(candidate) !== canonical)) {
        throw new FeedbackHandoffError('FEEDBACK_AMBIGUOUS_GRANT', 'The feedback upload grant is ambiguous.');
    }
    return validated[0];
};

const validateRemoteInput = (remoteInput) => {
    if (
        !isRecord(remoteInput) ||
        Object.keys(remoteInput).sort().join('\0') !== ['kind', 'size_bytes'].sort().join('\0') ||
        !FEEDBACK_KINDS.has(remoteInput.kind) ||
        !Number.isSafeInteger(remoteInput.size_bytes) ||
        remoteInput.size_bytes < 1 ||
        remoteInput.size_bytes > MAX_FEEDBACK_ARCHIVE_BYTES
    ) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_INPUT', 'The remote feedback arguments are invalid.');
    }
    return { kind: remoteInput.kind, sizeBytes: remoteInput.size_bytes };
};

export const stagePreparedArtifact = async ({
    dataDirectory,
    sessionId,
    metadata,
    nowMs = Date.now(),
    retentionMs = STATE_RETENTION_MS,
}) => {
    validateSessionId(sessionId);
    const validated = validatePreparedMetadata(metadata);
    if (
        typeof dataDirectory !== 'string' ||
        !dataDirectory ||
        !Number.isSafeInteger(nowMs) ||
        nowMs < 0 ||
        !Number.isSafeInteger(retentionMs) ||
        retentionMs < 1
    ) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_STATE', 'The feedback handoff state is invalid.');
    }
    await ensurePrivateStoreDirectory(dataDirectory);
    await sweepState(dataDirectory, retentionMs);
    // There is no count to refuse on: every session is admitted. Nothing re-stages prepared for
    // recovery either: claiming a grant leaves the prepared record in place.
    // A newer prepared artifact always clears the session's pending authorization and its marker.
    await removeFile(grantPathForSession(dataDirectory, sessionId));
    await removeFile(claimedMarkerPathForSession(dataDirectory, sessionId));
    await publishState(preparedPathForSession(dataDirectory, sessionId), {
        version: 1,
        type: 'prepared',
        createdAtMs: nowMs,
        targetTool: SUBMIT_TARGET_TOOL,
        ...validated,
    });
};

export const stageUploadGrant = async ({
    dataDirectory,
    sessionId,
    remoteInput,
    grant,
    nowMs = Date.now(),
    retentionMs = STATE_RETENTION_MS,
}) => {
    validateSessionId(sessionId);
    if (
        typeof dataDirectory !== 'string' ||
        !dataDirectory ||
        !Number.isSafeInteger(nowMs) ||
        nowMs < 0 ||
        !Number.isSafeInteger(retentionMs) ||
        retentionMs < 1
    ) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_STATE', 'The feedback handoff state is invalid.');
    }
    await ensurePrivateStoreDirectory(dataDirectory);
    await sweepState(dataDirectory, retentionMs);
    const grantPath = grantPathForSession(dataDirectory, sessionId);
    // Preserve the waiting authorization. Its presence does not establish expiry or upload outcome;
    // submit checks those before dispatch. Expired-grant replacement stays an accepted residual:
    // docs/local-agent-architecture.md#accepted-residuals.
    if (await stat(grantPath).then(() => true, () => false)) {
        throw new FeedbackHandoffError(
            'FEEDBACK_GRANT_CONFLICT',
            'An upload authorization is already staged for the prepared artifact in this session. Submit the same artifactId, preserving the existing history choice: that call checks expiry and any recorded upload outcome before sending. Request another authorization only if that check asks for a refresh.'
        );
    }
    let prepared;
    try {
        prepared = parsePreparedEntry(await readBoundedState(preparedPathForSession(dataDirectory, sessionId)));
    } catch (error) {
        if (safeFeedbackProperty(error, 'code') === 'ENOENT') {
            throw new FeedbackHandoffError(
                'FEEDBACK_PREPARED_MISSING',
                'No prepared feedback artifact is waiting for this session.'
            );
        }
        throw error;
    }
    if (!isFreshEntry(prepared, nowMs, retentionMs)) {
        throw new FeedbackHandoffError(
            'FEEDBACK_PREPARED_MISSING',
            'No prepared feedback artifact is waiting for this session.'
        );
    }
    const authored = validateRemoteInput(remoteInput);
    if (authored.kind !== prepared.kind || authored.sizeBytes !== prepared.sizeBytes) {
        throw new FeedbackHandoffError(
            'FEEDBACK_PREPARED_MISMATCH',
            'The upload request does not match the prepared feedback artifact.'
        );
    }
    const validatedGrant = validateUploadGrant(grant, { nowMs, expectedSize: prepared.sizeBytes });
    // WHY: reject a doomed response while the same prepared artifact is still available for fresh authorization.
    requireGrantLifetime(validatedGrant, { nowMs, minimumRemainingMs: MIN_STAGE_GRANT_REMAINING_MS });
    // A fresh authorization always outlives a consumed one: clear the marker before publishing, so no
    // window exists where a claimable grant sits behind an old election.
    await removeFile(claimedMarkerPathForSession(dataDirectory, sessionId));
    await publishState(grantPath, {
        version: 1,
        type: 'grant',
        createdAtMs: nowMs,
        targetTool: SUBMIT_TARGET_TOOL,
        artifactId: prepared.artifactId,
        kind: prepared.kind,
        sizeBytes: prepared.sizeBytes,
        sha256: prepared.sha256,
        transcriptIncluded: prepared.transcriptIncluded,
        ...validatedGrant,
    });
};

// A claim marker lives for one hook run. One left behind by a hook killed mid-claim would deny every
// later submit of the session until the next prepare, so a marker older than any possible run is
// removed and the election retried once. Age is the file's own clock, like every other sweep.
// Two claimers that both observe one stale marker can each remove what the other just created and both
// hold the election; nothing here prevents that, because the outcome is one repeated PUT of the same
// archive to the same object key, which storage answers with 412. See the accepted residuals in
// docs/local-agent-architecture.md#accepted-residuals.
const STALE_CLAIM_MARKER_MS = 60_000;
const createClaimMarker = async (markerPath) => {
    const create = () => writeFile(markerPath, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try {
        await create();
        return;
    } catch (error) {
        if (safeFeedbackProperty(error, 'code') !== 'EEXIST') throw error;
    }
    const metadata = await stat(markerPath).catch(() => undefined);
    if (metadata !== undefined && Date.now() - metadata.mtimeMs > STALE_CLAIM_MARKER_MS) {
        await removeFile(markerPath).catch(() => undefined);
    }
    await create();
};

/**
 * Returns the transport of the grant staged for one prepared artifact. The native route consumes it:
 * nothing else there elects a single uploader, so the claim itself has to be the one-shot election. The
 * cloud route does not, because its exclusive attempt file already elects one uploader, and a refusal
 * that sent nothing would otherwise cost one of the few authorizations the service issues per hour;
 * that route discards the grant once the upload it covered has ended.
 */
export const claimUploadGrant = async ({
    dataDirectory,
    sessionId,
    artifactId,
    targetTool,
    nowMs = Date.now(),
    retentionMs = STATE_RETENTION_MS,
    consume = true,
}) => {
    validateSessionId(sessionId);
    if (targetTool !== SUBMIT_TARGET_TOOL) {
        throw new FeedbackHandoffError(
            'FEEDBACK_TOOL_MISMATCH',
            'The feedback upload grant does not match this local tool.'
        );
    }
    if (typeof artifactId !== 'string' || !ARTIFACT_ID_PATTERN.test(artifactId)) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_INPUT', 'The feedback submission arguments are invalid.');
    }
    if (
        typeof dataDirectory !== 'string' ||
        !dataDirectory ||
        !Number.isSafeInteger(nowMs) ||
        nowMs < 0 ||
        !Number.isSafeInteger(retentionMs) ||
        retentionMs < 1
    ) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_STATE', 'The feedback handoff state is invalid.');
    }
    await ensurePrivateStoreDirectory(dataDirectory);
    await sweepState(dataDirectory, retentionMs);
    const grantPath = grantPathForSession(dataDirectory, sessionId);
    const markerPath = claimedMarkerPathForSession(dataDirectory, sessionId);
    const grantMissing = (cause) => new FeedbackHandoffError(
        'FEEDBACK_GRANT_MISSING',
        'No valid feedback upload grant is waiting for this session.',
        cause,
    );
    // Exclusive create is the one-shot election: a rename reports success to more than one native
    // Windows caller, and reading only after winning keeps a later winner from seeing consumed bytes.
    if (consume) {
        try {
            await createClaimMarker(markerPath);
        } catch (error) {
            // Only an existing marker means a consumed grant; any other failure is a storage error.
            if (safeFeedbackProperty(error, 'code') !== 'EEXIST') throw error;
            throw grantMissing(error);
        }
    }
    // A claim that consumes nothing holds no election to release.
    const releaseElection = async () => { if (consume) await removeFile(markerPath).catch(() => undefined); };
    let entry;
    try {
        entry = parseGrantEntry(await readBoundedState(grantPath), { nowMs, retentionMs, allowExpired: true });
    } catch (error) {
        // Nothing was consumed, so the election is released: a marker left here would hide the grant a
        // concurrent report_issue is publishing right now, or one a later read could still serve, until
        // the next prepare. Unreadable state never carries authority and is removed with it.
        await releaseElection();
        if (error instanceof FeedbackHandoffError) await removeFile(grantPath);
        if (!(error instanceof FeedbackHandoffError) && safeFeedbackProperty(error, 'code') !== 'ENOENT') throw error;
        throw grantMissing(error);
    }
    if (entry.artifactId !== artifactId) {
        // Nothing was consumed: release the election so the matching submit can still claim this grant.
        await releaseElection();
        throw new FeedbackHandoffError(
            'FEEDBACK_ARTIFACT_MISMATCH',
            'The feedback upload grant does not match this prepared artifact.'
        );
    }
    if (entry.expiresAt * 1000 - nowMs < MIN_CLAIM_GRANT_REMAINING_MS) {
        // The doomed authorization is removed on both routes; the prepared artifact stays for the one
        // fresh report_issue this refusal names, which a kept grant would otherwise refuse as a conflict.
        await removeFile(grantPath);
        await releaseElection();
        throw grantRefreshRequired();
    }
    if (consume) {
        // Consume the grant before releasing the election: no second reader may observe it. The removal
        // is strict, because a grant that is already gone was consumed by someone else and this call
        // holds no authorization. A grant that cannot be removed right now was not consumed either, so
        // the election is released with the error.
        try {
            await consumeFile(grantPath);
        } catch (error) {
            await removeFile(markerPath).catch(() => undefined);
            if (safeFeedbackProperty(error, 'code') === 'ENOENT') throw grantMissing(error);
            throw error;
        }
        await removeFile(markerPath);
    }
    return {
        uploadUrl: entry.uploadUrl,
        objectKey: entry.objectKey,
        requiredHeaders: entry.requiredHeaders,
        expiresAt: entry.expiresAt,
        expectedSize: entry.sizeBytes,
        expectedSha256: entry.sha256,
    };
};

/**
 * Removes the authorization staged for this session once the upload it covered has ended. Only the
 * route that does not consume on claim needs it, and whatever is staged is that same authorization: a
 * new preparation clears the session's grant, and only one can be staged at a time.
 */
export const discardUploadGrant = async ({ dataDirectory, sessionId }) => {
    validateSessionId(sessionId);
    if (typeof dataDirectory !== 'string' || !dataDirectory) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_STATE', 'The feedback handoff state is invalid.');
    }
    await removeFile(grantPathForSession(dataDirectory, sessionId));
};

const validateTranscriptPath = (path) => {
    if (
        typeof path !== 'string' ||
        byteLength(path) < 1 ||
        byteLength(path) > MAX_TRANSCRIPT_PATH_BYTES ||
        !isAbsolute(path)
    ) {
        throw new FeedbackHandoffError(
            'FEEDBACK_TRANSCRIPT_UNAVAILABLE',
            'The trusted feedback transcript is unavailable.'
        );
    }
    return path;
};

const transcriptPathFromEvent = (event) => {
    const candidates = [event.transcript_path, event.transcriptPath].filter((value) => value !== undefined);
    if (candidates.length === 0) return undefined;
    if (candidates.length > 1 && candidates.some((value) => value !== candidates[0])) {
        throw new FeedbackHandoffError(
            'FEEDBACK_TRANSCRIPT_UNAVAILABLE',
            'The trusted feedback transcript is unavailable.'
        );
    }
    // Codex may explicitly report that its transcript path is unavailable.
    if (candidates[0] === null) return undefined;
    return validateTranscriptPath(candidates[0]);
};

const preToolUseOutput = (updatedInput) =>
    JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput,
        },
    });

const deniedPreToolUseOutput = (error) => {
    const recovery = error.code === 'FEEDBACK_GRANT_REFRESH_REQUIRED'
        ? 'Call report_issue again for the same prepared artifact.'
        : error.code === 'FEEDBACK_ARTIFACT_MISMATCH'
            ? 'Nothing was sent and the existing authorization is kept. Use the artifactId from the prepared result associated with the existing authorization, preserving its consent and history choice. If that association is unclear, inspect the preparation and authorization results first; do not request another authorization or recreate the report to bypass the mismatch.'
        : error.code === 'FEEDBACK_GRANT_MISSING'
            ? 'This submit call was blocked before upload; the hook ran. No upload was attempted by this call. This does not establish the outcome of an earlier submit. Do not retry automatically with unchanged state. Check the observed call sequence: if report_issue has not been called for this prepared artifact and no earlier upload has an uncertain outcome, find remote e-Comet report_issue and call it once with the prepared kind and size_bytes, then submit the same artifactId, preserving the existing consent and history choice. If report_issue is unavailable, stop and report that the remote authorization tool is unavailable; check the remote e-Comet connector status and ask to connect only when it is observed disconnected. If report_issue was already called, inspect its result and handoff evidence instead of repeating it or guessing a cause.'
            : 'Do not retry automatically. Ask the user before starting a new feedback flow.';
    return JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
                `${error.code}: ${error.message} ${JSON.stringify(error.details)} ` + recovery,
        },
    });
};

const safeHookError = (error, operation) => {
    const details = feedbackDiagnostics(error, operation);
    const owned = ownedErrors.get(error);
    if (owned) return { ...owned, details };
    // Cloud helpers cross a module boundary, so use only closed diagnostic reasons,
    // never an exception's arbitrary message or code, for public classification.
    const cloudFailures = {
        invalid_input: ['FEEDBACK_INVALID_INPUT', 'The authored feedback arguments are invalid.'],
        invalid_state: ['FEEDBACK_INVALID_STATE', 'The trusted cloud feedback state could not be verified.'],
        state_missing: ['FEEDBACK_STATE_MISSING', 'The cloud feedback state is absent; the outcome of an earlier upload cannot be established.'],
        storage_unavailable: ['FEEDBACK_DATA_DIR_UNAVAILABLE', 'The host did not provide cloud feedback storage.'],
        upload_already_started: ['FEEDBACK_UPLOAD_ALREADY_STARTED', 'An existing upload attempt prevents another request.'],
    };
    const cloudFailure = cloudFailures[details.reason];
    if (cloudFailure) return { code: cloudFailure[0], message: cloudFailure[1], details };
    const filesystemBlocked = FEEDBACK_DIAGNOSTIC_FILESYSTEM_CODES.includes(details.systemCode);
    if (filesystemBlocked) return { code: 'FEEDBACK_STORAGE_ERROR', message: 'A local feedback filesystem operation could not complete.', details };
    if (safeFeedbackProperty(error, 'code') === 'FEEDBACK_CLAIM_INVALID') {
        return { code: 'FEEDBACK_CLAIM_INVALID', message: 'The trusted feedback handoff claim could not be verified.', details };
    }
    return { code: 'FEEDBACK_INTERNAL_ERROR', message: 'The local feedback handoff failed internally.', details: { ...details, reason: 'internal_error' } };
};

const cloudDenialRecovery = (code, target) => {
    if (code === 'FEEDBACK_INVALID_INPUT') {
        return 'Correct the authored arguments using the existing user consent and history choice; this denial did not start an upload.';
    }
    // A preparation denial precedes every authorization and upload of this flow, so the submit wording
    // about unestablished upload state would describe a state this call cannot have produced.
    if (target === 'prepare_e_comet_feedback') {
        return 'This preparation did not start and no upload state exists; fix the named prerequisite and prepare again with the same consent and history choice.';
    }
    return 'Existing upload state could not be established; do not obtain another grant or start another feedback flow to bypass this failure. Preserve the same artifact and safe evidence for support.';
};

export const prepareInputWithTrustedTranscript = (event) => {
    validateSessionId(event.session_id ?? event.sessionId);
    const toolInput = toolInputFromEvent(event);
    if (!isRecord(toolInput) || !FEEDBACK_KINDS.has(toolInput.kind) || typeof toolInput.includeTranscript !== 'boolean') {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_INPUT', 'The feedback preparation arguments are invalid.');
    }
    if (
        hasOwn(toolInput, 'transcriptPath') ||
        hasOwn(toolInput, 'transcript_path') ||
        hasOwn(toolInput, 'feedbackClaim') ||
        hasOwn(toolInput, 'feedback_claim') ||
        hasOwn(toolInput, 'feedbackSession') ||
        hasOwn(toolInput, 'feedback_session') ||
        hasOwn(toolInput, 'feedbackAdapter') ||
        hasOwn(toolInput, 'feedback_adapter')
    ) {
        throw new FeedbackHandoffError(
            'FEEDBACK_MODEL_TRANSPORT',
            'Trusted feedback fields must not be supplied in model-authored input.'
        );
    }
    if (!validateSchemaValue(toolInput, toolInputSchemas.prepare_e_comet_feedback)) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_INPUT', 'The feedback preparation arguments are invalid.');
    }
    const transcriptPath = transcriptPathFromEvent(event);
    if (transcriptPath === undefined && toolInput.includeTranscript) {
        throw new FeedbackHandoffError(
            'FEEDBACK_TRANSCRIPT_UNAVAILABLE',
            'The trusted feedback transcript is unavailable.'
        );
    }
    return { ...toolInput, ...(transcriptPath === undefined ? {} : { transcriptPath }) };
};

// Hooks receive arguments, not the host's JSON-RPC id/_meta. Leave bounded headroom
// for supported host envelopes, in addition to measuring the injected fields themselves.
export const FEEDBACK_ENVELOPE_RESERVE_BYTES = 4096;
const REPORT_SHORTENING_MARKER = '\n[... middle omitted to fit the feedback request size limit ...]\n';
const shortenReportMiddle = (text, retained) => {
    if (retained >= text.length) return text;
    let head = Math.ceil(retained / 2);
    let tail = text.length - Math.floor(retained / 2);
    // Keep surrogate pairs intact without materializing a code-point array of a huge report.
    if (head > 0 && /[\uD800-\uDBFF]/u.test(text[head - 1]) && /[\uDC00-\uDFFF]/u.test(text[head] ?? '')) head -= 1;
    if (tail > 0 && /[\uD800-\uDBFF]/u.test(text[tail - 1]) && /[\uDC00-\uDFFF]/u.test(text[tail] ?? '')) tail += 1;
    return text.slice(0, head) + REPORT_SHORTENING_MARKER + text.slice(tail);
};
// The cloud route fits the same report into its smaller archive budget, so the caller may lower the
// limit; the default stays the host wire envelope every route has to satisfy. That route must also
// measure what canonical prepare will render: redaction expands credential-like text, so measuring the
// authored text alone would stage a report no retry of it could ever archive. The stored text is
// redacted exactly once more downstream, which is what `measureRendered` projects here.
export const fitPrepareWireInput = (input, transportFields = {
    feedbackClaim: 'a'.repeat(43), feedbackSession: 'a'.repeat(64),
}, { limitBytes = MAX_MCP_MESSAGE_BYTES - FEEDBACK_ENVELOPE_RESERVE_BYTES, measureRendered = false } = {}) => {
    // Canonical rendering folds line endings before redacting, and the header redactors match to the
    // end of a line: measuring CR-delimited text unfolded would collapse a whole report into one match.
    const redacted = (value) => (typeof value === 'string' ? redactFeedbackText(foldFeedbackLineEndings(value)) : value);
    const measured = (value) => (measureRendered
        ? { ...value, summary: redacted(value.summary), details: redacted(value.details) } : value);
    const wireBytes = (value) => byteLength(JSON.stringify({ ...value, ...transportFields }));
    // The archive projection can shrink credentials or expand redaction markers. Both it and the
    // actual injected input must fit: measuring only the projection lets oversized raw text escape.
    const fits = (value) => wireBytes(value) <= limitBytes && wireBytes(measured(value)) <= limitBytes;
    if (fits(input)) return input;
    // Cutting a header/key away from its credential value defeats contextual redaction.
    // Redact whole source fields before any cut, then bind only the final safe text. Line endings are
    // folded first, exactly as the canonical report does: redacting lone-CR text unfolded would treat
    // the whole report as one header line and swallow its contents into a single redaction.
    let fitted = { ...input,
        summary: redactFeedbackText(foldFeedbackLineEndings(input.summary)), details: redactFeedbackText(foldFeedbackLineEndings(input.details)) };
    // Details are the ordinary oversized field. Summary is only a last resort when
    // it alone exhausts the budget; normal inputs and the trusted transcript path stay unchanged.
    for (const field of ['details', 'summary']) {
        if (fits(fitted)) return fitted;
        const original = fitted[field];
        const minimumRetained = Math.min(original.length, 128);
        const shortened = shortenReportMiddle(original, minimumRetained);
        // An omission marker must not enlarge an ordinary field just because another field is huge.
        if (byteLength(JSON.stringify(shortened)) >= byteLength(JSON.stringify(original))) continue;
        const minimum = { ...fitted, [field]: shortened };
        if (!fits(minimum)) { fitted = minimum; continue; }
        let low = minimumRetained;
        let high = original.length - 1;
        while (low < high) {
            const retained = Math.ceil((low + high) / 2);
            if (fits({ ...fitted, [field]: shortenReportMiddle(original, retained) })) low = retained;
            else high = retained - 1;
        }
        return { ...fitted, [field]: shortenReportMiddle(original, low) };
    }
    if (!fits(fitted)) throw new FeedbackHandoffError('FEEDBACK_INVALID_INPUT', 'The feedback request envelope is too large.');
    return fitted;
};

// The shared secret is loaded before any authorization is consumed: a storage failure must not cost
// the user a fresh report_issue. The operation tag keeps the existing handoff diagnostics vocabulary.
const loadSigningSecret = async (env) => {
    try {
        return await loadHookSecret({ env, create: true });
    } catch (error) {
        throw withFeedbackOperation(error, 'claim_issue');
    }
};

const processHookEventAuthoritative = async (event, _options = {}) => {
    if (!isRecord(event)) {
        const error = new FeedbackHandoffError('FEEDBACK_INVALID_EVENT', 'The desktop hook event is invalid.');
        return { exitCode: 2, stdout: '', stderr: `${error.code}: ${error.message}` };
    }

    const eventName = eventNameFromEvent(event);
    const toolName = toolNameFromEvent(event);
    // This measured bridge namespace identifies the split-filesystem surface. OS and
    // model-authored adapter fields never select cloud execution.
    // Native matchers tolerate historical spelling aliases; that does not attest an
    // underscore-spelled cloud consumer. Broaden this boundary only with host evidence.
    if (CLOUD_FEEDBACK_TOOL.test(toolName)
        && (['PreToolUse', 'PostToolUse'].includes(eventName)
            || (eventName === 'PostToolUseFailure' && toolName.endsWith('__prepare_e_comet_feedback')))) {
        try {
            const { processCloudFeedbackEvent } = await import('./feedback-cloud.mjs');
            return await processCloudFeedbackEvent(event, _options);
        } catch (error) {
            const submit = toolName.endsWith('__submit_e_comet_feedback');
            const safeError = safeHookError(error, submit ? 'handoff_submit' : 'handoff_prepare');
            return eventName === 'PreToolUse'
                ? { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
                    permissionDecisionReason: `${safeError.code}: ${safeError.message} ${JSON.stringify(safeError.details)} This call was blocked before dispatch. ${cloudDenialRecovery(safeError.code, submit ? 'submit_e_comet_feedback' : 'prepare_e_comet_feedback')}` } }), stderr: '' }
                : { exitCode: 2, stdout: '', stderr: `${safeError.code}: ${safeError.message} ${JSON.stringify(safeError.details)}` };
        }
    }
    if (
        eventName === 'PostToolUse' &&
        typeof toolName === 'string' &&
        REMOTE_REPORT_ISSUE_TOOL.test(toolName)
    ) {
        // A failed authorization already carries the only fact that matters here, and the service
        // issues very few of them per hour: replacing an exhausted-limit error with a handoff outcome
        // would hide why the report cannot be sent. Nothing is staged for a result that granted nothing.
        if (isRecord(toolResponseFromEvent(event)) && toolResponseFromEvent(event).isError === true) {
            return { exitCode: 0, stdout: '', stderr: '' };
        }
        let cloudDirectory;
        try {
            const { env = process.env, nowMs = Date.now() } = _options;
            const sessionId = sessionIdFromEvent(event);
            cloudDirectory = await cloudHandoffForSession(env, sessionId);
            // A remote grant names kind/size, not the consumer route. If both
            // routes retain this session, matching sizes cannot prove ownership.
            if (cloudDirectory && await hasSessionHandoff(resolveStoreDirectory(env), sessionId)) {
                throw new FeedbackHandoffError('FEEDBACK_PREPARED_MISMATCH',
                    'Both native and cloud prepared state exist for this session. Inspect the prepared results and handoff evidence before continuing; no grant was staged.');
            }
            const remoteInput = toolInputFromEvent(event);
            const authored = validateRemoteInput(remoteInput);
            const grant = extractUploadGrant(toolResponseFromEvent(event), {
                nowMs,
                expectedSize: authored.sizeBytes,
            });
            await stageUploadGrant({
                dataDirectory: cloudDirectory ?? resolveStoreDirectory(env),
                sessionId,
                remoteInput,
                grant,
                nowMs,
            });
            if (cloudDirectory) return cloudPostToolOutput({ ok: true, status: 'grant_staged',
                message: 'Upload authorization is staged privately for the prepared artifact in this session. Submit only its artifactId.' });
            return { exitCode: 0, stdout: '', stderr: '' };
        } catch (error) {
            const safeError = safeHookError(error, 'handoff_authorize');
            if (cloudDirectory) return cloudPostToolOutput({ ok: false, status: 'grant_not_staged', error: safeError });
            return { exitCode: 2, stdout: '', stderr: `${safeError.code}: ${safeError.message} ${JSON.stringify(safeError.details)}` };
        }
    }
    if (
        eventName === 'PostToolUse' &&
        typeof toolName === 'string' &&
        LOCAL_FEEDBACK_TOOL.test(toolName) &&
        toolName.endsWith('__prepare_e_comet_feedback')
    ) {
        // A failed tool already supplies its diagnostic. Blocking PostToolUse would replace it.
        if (isRecord(toolResponseFromEvent(event)) && toolResponseFromEvent(event).isError === true) {
            return { exitCode: 0, stdout: '', stderr: '' };
        }
        try {
            const { env = process.env, nowMs = Date.now() } = _options;
            const sessionId = sessionIdFromEvent(event);
            const toolInput = toolInputFromEvent(event);
            if (
                !isRecord(toolInput) ||
                !FEEDBACK_KINDS.has(toolInput.kind) ||
                typeof toolInput.includeTranscript !== 'boolean'
            ) {
                throw new FeedbackHandoffError(
                    'FEEDBACK_INVALID_INPUT',
                    'The feedback preparation arguments are invalid.'
                );
            }
            const metadata = extractPreparedMetadata(toolResponseFromEvent(event));
            if (
                metadata.kind !== toolInput.kind ||
                metadata.transcriptIncluded !== toolInput.includeTranscript
            ) {
                throw new FeedbackHandoffError(
                    'FEEDBACK_PREPARED_MISMATCH',
                    'The prepared feedback result does not match the requested report.'
                );
            }
            await stagePreparedArtifact({
                dataDirectory: resolveStoreDirectory(env),
                sessionId,
                metadata,
                nowMs,
            });
            return { exitCode: 0, stdout: '', stderr: '' };
        } catch (error) {
            const safeError = safeHookError(error, 'handoff_prepare');
            return { exitCode: 2, stdout: '', stderr: `${safeError.code}: ${safeError.message} ${JSON.stringify(safeError.details)}` };
        }
    }
    if (
        eventName === 'PreToolUse' &&
        typeof toolName === 'string' &&
        LOCAL_FEEDBACK_TOOL.test(toolName) &&
        toolName.endsWith('__prepare_e_comet_feedback')
    ) {
        try {
            const { env = process.env, nowMs = Date.now() } = _options;
            void nowMs;
            // Bind the fitted input's transcript path, never a path that will be rewritten later.
            const effectiveInput = fitPrepareWireInput(prepareInputWithTrustedTranscript(event));
            const secret = await loadSigningSecret(env);
            const feedbackSession = hashSessionId(sessionIdFromEvent(event));
            const fields = effectiveInput.transcriptPath === undefined ? {} : { transcriptPath: effectiveInput.transcriptPath };
            return {
                exitCode: 0,
                stdout: preToolUseOutput({
                    ...effectiveInput,
                    feedbackClaim: signHookFields({ secret, tool: 'prepare_e_comet_feedback', sessionHash: feedbackSession, fields }),
                    feedbackSession,
                }),
                stderr: '',
            };
        } catch (error) {
            const safeError = safeHookError(error, 'handoff_prepare');
            return { exitCode: 0, stdout: deniedPreToolUseOutput(safeError), stderr: '' };
        }
    }
    if (
        eventName === 'PreToolUse' &&
        typeof toolName === 'string' &&
        LOCAL_FEEDBACK_TOOL.test(toolName) &&
        toolName.endsWith('__submit_e_comet_feedback')
    ) {
        try {
            const { env = process.env, nowMs = Date.now() } = _options;
            const sessionId = sessionIdFromEvent(event);
            const toolInput = toolInputFromEvent(event);
            if (!isRecord(toolInput)) {
                throw new FeedbackHandoffError(
                    'FEEDBACK_INVALID_INPUT',
                    'The feedback submission arguments are invalid.'
                );
            }
            if (Object.keys(toolInput).sort().join('\0') !== 'artifactId') {
                throw new FeedbackHandoffError(
                    'FEEDBACK_MODEL_TRANSPORT',
                    'Trusted feedback fields must not be supplied in model-authored input.'
                );
            }
            // Load the signing secret before the one-shot claim: an unavailable secret must never cost
            // the user a fresh remote authorization.
            const secret = await loadSigningSecret(env);
            const transport = await claimUploadGrant({
                dataDirectory: resolveStoreDirectory(env),
                sessionId,
                artifactId: toolInput.artifactId,
                targetTool: toolName.slice(toolName.lastIndexOf('__') + 2),
                nowMs,
            });
            const effectiveInput = { ...toolInput, ...transport };
            const feedbackSession = hashSessionId(sessionId);
            return {
                exitCode: 0,
                stdout: preToolUseOutput({
                    ...effectiveInput,
                    feedbackClaim: signHookFields({ secret, tool: SUBMIT_TARGET_TOOL, sessionHash: feedbackSession, fields: effectiveInput }),
                    feedbackSession,
                }),
                stderr: '',
            };
        } catch (error) {
            const safeError = safeHookError(error, 'handoff_submit');
            return { exitCode: 0, stdout: deniedPreToolUseOutput(safeError), stderr: '' };
        }
    }

    return { exitCode: 0, stdout: '', stderr: '' };
};

const feedbackDiagnosticOutcome = (result, eventName) => {
    if (eventName === 'PostToolUseFailure') return 'failed';
    try {
        const output = JSON.parse(result.stdout).hookSpecificOutput;
        if (output.permissionDecision === 'deny') return 'denied';
        const replaced = output.updatedToolOutput?.[0]?.text;
        if (typeof replaced === 'string') {
            const status = JSON.parse(replaced).status;
            if (status === 'uncertain') return 'uncertain';
            if (['failed', 'not_started', 'grant_not_staged'].includes(status)) return 'failed';
        }
    } catch { /* Empty successful native Post output is expected. */ }
    return 'succeeded';
};

export const processHookEvent = async (event, options = {}) => {
    const result = await processHookEventAuthoritative(event, options);
    const eventName = event?.hook_event_name ?? event?.hookEventName;
    const toolName = event?.tool_name ?? event?.toolName;
    let cloud = CLOUD_FEEDBACK_TOOL.test(toolName);
    const target = typeof toolName === 'string' ? toolName.slice(toolName.lastIndexOf('__') + 2) : '';
    const family = target === 'prepare_e_comet_feedback' ? 'feedback_prepare'
        : target === 'submit_e_comet_feedback' ? 'feedback_submit'
            : REMOTE_REPORT_ISSUE_TOOL.test(toolName) ? 'feedback_authorization' : undefined;
    const routedLocal = cloud || LOCAL_FEEDBACK_TOOL.test(toolName);
    const routedRemote = eventName === 'PostToolUse' && REMOTE_REPORT_ISSUE_TOOL.test(toolName);
    if (!family || result.exitCode !== 0 || (!routedRemote && !routedLocal)
        || !['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(eventName)) return result;
    if (eventName === 'PostToolUse' && family === 'feedback_prepare'
        && isRecord(toolResponseFromEvent(event)) && toolResponseFromEvent(event).isError === true) return result;
    if (eventName === 'PostToolUse' && family === 'feedback_authorization'
        && isRecord(toolResponseFromEvent(event)) && toolResponseFromEvent(event).isError === true) return result;
    let decision;
    let updatedToolOutput = false;
    if (result.stdout) {
        try {
            const output = JSON.parse(result.stdout).hookSpecificOutput;
            decision = output?.permissionDecision;
            updatedToolOutput = output?.updatedToolOutput !== undefined;
            if (family === 'feedback_authorization' && updatedToolOutput) cloud = true;
        } catch { return result; }
    }
    if (eventName === 'PreToolUse' && decision !== 'deny') {
        try {
            if (JSON.parse(result.stdout).hookSpecificOutput?.updatedInput === undefined) return result;
        } catch { return result; }
    }
    return withHookDiagnostic(result, () => ({
        event: eventName, toolFamily: family,
        handler: cloud && family !== 'feedback_authorization' ? 'feedback_cloud' : 'feedback_handoff',
        stage: eventName === 'PreToolUse' ? decision === 'deny' ? 'call_denied' : 'input_rewritten'
            : updatedToolOutput ? 'result_replaced' : family === 'feedback_authorization' ? 'handoff_staged' : 'result_observed',
        outcome: feedbackDiagnosticOutcome(result, eventName),
        observedAt: new Date(options.nowMs ?? options.cloud?.now?.() ?? Date.now()).toISOString(),
        executionPlane: cloud ? 'cloud' : 'native',
    }));
};

const readStdin = async () => {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
        bytes += chunk.length;
        if (bytes > MAX_HOOK_EVENT_BYTES) {
            throw new FeedbackHandoffError('FEEDBACK_EVENT_TOO_LARGE', 'The desktop hook event is too large.');
        }
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_EVENT', 'The desktop hook event is invalid.');
    }
};

const main = async () => {
    let result;
    try {
        result = await processHookEvent(await readStdin());
    } catch (error) {
        const safeError = safeHookError(error);
        result = { exitCode: 2, stdout: '', stderr: `${safeError.code}: ${safeError.message}` };
    }
    if (result.stdout) process.stdout.write(`${result.stdout}\n`);
    if (result.stderr) process.stderr.write(`${result.stderr}\n`);
    process.exitCode = result.exitCode;
};

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
// Finish module evaluation before a cloud executor imports the reusable handoff
// helpers. Awaiting main here would form a dynamic-import/top-level-await cycle.
if (isMain) void main();
