#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { issueFeedbackClaim } from '../mcp/src/feedback-claim.mjs';

const MAX_HOOK_EVENT_BYTES = 1024 * 1024;
const MAX_SESSION_ID_BYTES = 512;
const MAX_TRANSCRIPT_PATH_BYTES = 4096;
const MAX_STATE_FILE_BYTES = 64 * 1024;
const MAX_FEEDBACK_ARCHIVE_BYTES = 1024 * 1024;
const MAX_PENDING_ENTRIES = 128;
const STATE_RETENTION_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5000;
const STORE_DIRECTORY = 'feedback-handoff-v1';
const STORE_LOCK_NAME = '.feedback-handoff.lock';
const STORE_LOCK_STALE_MS = 30_000;
const LOCK_RETRY_DELAY_MS = 5;
const LOCK_RETRY_LIMIT = 200;
const LOCK_RELEASE_RETRY_LIMIT = 20;
const TRANSIENT_WINDOWS_LOCK_ERRORS = new Set(['EPERM', 'EBUSY']);
const STATE_FILE_PATTERN = /^([a-f0-9]{64})\.(prepared|grant)\.json$/;
const ARTIFACT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
// The hook is dependency-free, so mirror the exact remote report_issue enum at this trust boundary.
const FEEDBACK_KINDS = new Set(['bug', 'wrong_data', 'missing_capability', 'unclear_contract']);
const SUBMIT_TARGET_TOOL = 'submit_e_comet_feedback';
const COWORK_UUID_NAMESPACE = '2da262fd-fd1f-4636-90cb-75b02fd1f1f1';
const MAX_UPLOAD_URL_BYTES = 8 * 1024;
const MAX_OBJECT_KEY_BYTES = 1024;
const MAX_REQUIRED_HEADERS = 32;
const MAX_HEADER_NAME_BYTES = 128;
const MAX_HEADER_VALUE_BYTES = 8 * 1024;
const MAX_GRANT_PAYLOAD_BYTES = 48 * 1024;
const UPLOAD_TIMEOUT_MS = 15_000;
const GRANT_HANDOFF_RESERVE_MS = 5_000;
// WHY: staging promises enough lifetime for both ordinary Post->Pre scheduling and the complete one-shot PUT.
const MIN_STAGE_GRANT_REMAINING_MS = UPLOAD_TIMEOUT_MS + GRANT_HANDOFF_RESERVE_MS;
// WHY: once PreToolUse starts, charging the scheduling reserve again rejects grants that still cover the complete PUT.
const MIN_CLAIM_GRANT_REMAINING_MS = UPLOAD_TIMEOUT_MS;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const OBJECT_KEY_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ISO_EXPIRY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const PROTOTYPE_SPECIAL_HEADER_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const LOCAL_FEEDBACK_TOOL =
    /^mcp__(?:(?:remote-devices__)?plugin_e-comet-skills_)?e[-_]comet[-_]local__(?:prepare_e_comet_feedback|submit_e_comet_feedback)$/;
const REMOTE_REPORT_ISSUE_TOOL = new RegExp(
    `^mcp__(?:e[-_]comet|e_comet_stage|https_mcp_stage_int_e_comet_io_mcp|plugin_e-comet-skills_e-comet|remote-devices__plugin_e-comet-skills_e-comet|${COWORK_UUID_NAMESPACE})__report_issue$`
);

class FeedbackHandoffError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'FeedbackHandoffError';
        this.code = code;
    }
}

const byteLength = (value) => Buffer.byteLength(value, 'utf8');
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const wait = (delayMs) => new Promise((resolveWait) => setTimeout(resolveWait, delayMs));

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

const preparedPathForSession = (dataDirectory, sessionId) =>
    join(dataDirectory, `${hashSessionId(sessionId)}.prepared.json`);
const grantPathForSession = (dataDirectory, sessionId) =>
    join(dataDirectory, `${hashSessionId(sessionId)}.grant.json`);

const ensurePrivateStoreDirectory = async (dataDirectory) => {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(dataDirectory, 0o700);
};

const removeFile = async (path) => {
    for (let attempt = 0; attempt < LOCK_RELEASE_RETRY_LIMIT; attempt += 1) {
        try {
            await unlink(path);
            return;
        } catch (error) {
            if (error?.code === 'ENOENT') return;
            if (!TRANSIENT_WINDOWS_LOCK_ERRORS.has(error?.code) || attempt === LOCK_RELEASE_RETRY_LIMIT - 1) {
                throw error;
            }
            await wait(LOCK_RETRY_DELAY_MS);
        }
    }
};

const releaseStoreLock = async ({ lockPath, ownerPath }) => {
    await removeFile(ownerPath);
    for (let attempt = 0; attempt < LOCK_RELEASE_RETRY_LIMIT; attempt += 1) {
        try {
            await rmdir(lockPath);
            return;
        } catch (error) {
            if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) return;
            if (!TRANSIENT_WINDOWS_LOCK_ERRORS.has(error?.code) || attempt === LOCK_RELEASE_RETRY_LIMIT - 1) {
                throw error;
            }
            await wait(LOCK_RETRY_DELAY_MS);
        }
    }
};

const acquireStoreLock = async (dataDirectory, fileNow) => {
    const lockPath = join(dataDirectory, STORE_LOCK_NAME);
    for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt += 1) {
        const ownerId = `${process.pid}-${randomUUID()}`;
        const candidatePath = join(dataDirectory, `.lock-candidate-${ownerId}`);
        const candidateOwnerPath = join(candidatePath, ownerId);
        await mkdir(candidatePath, { mode: 0o700 });
        try {
            await writeFile(candidateOwnerPath, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
            await rename(candidatePath, lockPath);
            return () => releaseStoreLock({ lockPath, ownerPath: join(lockPath, ownerId) });
        } catch (error) {
            await rm(candidatePath, { recursive: true, force: true });
            if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error?.code)) throw error;
        }

        try {
            const lockStat = await stat(lockPath);
            if (fileNow() - lockStat.mtimeMs > STORE_LOCK_STALE_MS) {
                const stalePath = join(dataDirectory, `.stale-lock-${process.pid}-${randomUUID()}`);
                try {
                    const currentStat = await stat(lockPath);
                    if (
                        currentStat.dev !== lockStat.dev ||
                        currentStat.ino !== lockStat.ino ||
                        currentStat.mtimeMs !== lockStat.mtimeMs
                    ) {
                        continue;
                    }
                    await rename(lockPath, stalePath);
                    await rm(stalePath, { recursive: true, force: true });
                } catch (error) {
                    if (error?.code !== 'ENOENT') throw error;
                }
                continue;
            }
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
        await wait(LOCK_RETRY_DELAY_MS);
    }
    throw new FeedbackHandoffError('FEEDBACK_BUSY', 'Another feedback handoff is still in progress.');
};

const withStoreLock = async (dataDirectory, fileNow, operation) => {
    const release = await acquireStoreLock(dataDirectory, fileNow);
    let operationFailed = false;
    try {
        return await operation();
    } catch (error) {
        operationFailed = true;
        throw error;
    } finally {
        try {
            await release();
        } catch (error) {
            if (!operationFailed) throw error;
        }
    }
};

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
        expiresAt > Math.floor(Number.MAX_SAFE_INTEGER / 1000) ||
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
        typeof grant.objectKey !== 'string' ||
        byteLength(grant.objectKey) < 1 ||
        byteLength(grant.objectKey) > MAX_OBJECT_KEY_BYTES ||
        OBJECT_KEY_CONTROL_CHARACTERS.test(grant.objectKey) ||
        !isRecord(grant.requiredHeaders) ||
        !Number.isSafeInteger(grant.expiresAt) ||
        grant.expiresAt < 1 ||
        grant.expiresAt > Math.floor(Number.MAX_SAFE_INTEGER / 1000) ||
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

const cleanupStore = async (dataDirectory, nowMs, retentionMs) => {
    let entries;
    try {
        entries = await readdir(dataDirectory, { withFileTypes: true });
    } catch (error) {
        if (error?.code === 'ENOENT') return 0;
        throw error;
    }
    let active = 0;
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const match = STATE_FILE_PATTERN.exec(entry.name);
        const path = join(dataDirectory, entry.name);
        if (match) {
            let fresh = false;
            try {
                const state = await readBoundedState(path);
                if (match[2] === 'prepared') {
                    fresh = isFreshEntry(parsePreparedEntry(state), nowMs, retentionMs);
                } else {
                    // A structurally valid expired grant still carries the prepared metadata needed for safe reauthorization.
                    parseGrantEntry(state, { nowMs, retentionMs, allowExpired: true });
                    fresh = true;
                }
            } catch {
                fresh = false;
            }
            if (fresh) active += 1;
            else await removeFile(path);
            continue;
        }
        if (/^\.(?:stage|claim|backup)-/.test(entry.name)) {
            try {
                const fileStat = await stat(path);
                if (fileStat.mtimeMs <= Date.now() - retentionMs) await removeFile(path);
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
        }
    }
    return active;
};

const writeAtomicReplacement = async (path, value) => {
    const dataDirectory = resolve(path, '..');
    const stagePath = join(dataDirectory, `.stage-${process.pid}-${randomUUID()}`);
    const backupPath = join(dataDirectory, `.backup-${process.pid}-${randomUUID()}`);
    const serialized = JSON.stringify(value);
    if (byteLength(serialized) > MAX_STATE_FILE_BYTES) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_STATE', 'The feedback handoff state is invalid.');
    }
    await writeFile(stagePath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    let displaced = false;
    try {
        try {
            await rename(stagePath, path);
        } catch (error) {
            if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
            await rename(path, backupPath);
            displaced = true;
            await rename(stagePath, path);
        }
        if (process.platform !== 'win32') await chmod(path, 0o600);
        if (displaced) await removeFile(backupPath);
    } catch (error) {
        if (displaced) {
            try {
                await rename(backupPath, path);
            } catch {
                // A later operation will remove an incomplete stage or fail closed on the missing state.
            }
        }
        throw error;
    } finally {
        await removeFile(stagePath);
    }
};

const MAX_TOOL_RESULT_JSON_BYTES = 8 * 1024;
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
        !exactKeys(candidate, PREPARED_RESULT_KEYS) ||
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
    fileNow = Date.now,
    retentionMs = STATE_RETENTION_MS,
    maxEntries = MAX_PENDING_ENTRIES,
}) => {
    validateSessionId(sessionId);
    const validated = validatePreparedMetadata(metadata);
    if (
        typeof dataDirectory !== 'string' ||
        !dataDirectory ||
        !Number.isSafeInteger(nowMs) ||
        nowMs < 0 ||
        typeof fileNow !== 'function' ||
        !Number.isSafeInteger(retentionMs) ||
        retentionMs < 1 ||
        !Number.isSafeInteger(maxEntries) ||
        maxEntries < 1
    ) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_STATE', 'The feedback handoff state is invalid.');
    }
    await ensurePrivateStoreDirectory(dataDirectory);
    await withStoreLock(dataDirectory, fileNow, async () => {
        const preparedPath = preparedPathForSession(dataDirectory, sessionId);
        const grantPath = grantPathForSession(dataDirectory, sessionId);
        const active = await cleanupStore(dataDirectory, nowMs, retentionMs);
        const ownsEntry = await stat(preparedPath).then(() => true, () => false) || await stat(grantPath).then(() => true, () => false);
        if (active >= maxEntries && !ownsEntry) {
            throw new FeedbackHandoffError('FEEDBACK_CAPACITY', 'Too many feedback handoffs are waiting locally.');
        }
        await removeFile(grantPath);
        await writeAtomicReplacement(preparedPath, {
            version: 1,
            type: 'prepared',
            createdAtMs: nowMs,
            targetTool: SUBMIT_TARGET_TOOL,
            ...validated,
        });
    });
};

export const stageUploadGrant = async ({
    dataDirectory,
    sessionId,
    remoteInput,
    grant,
    nowMs = Date.now(),
    fileNow = Date.now,
    retentionMs = STATE_RETENTION_MS,
}) => {
    validateSessionId(sessionId);
    if (
        typeof dataDirectory !== 'string' ||
        !dataDirectory ||
        !Number.isSafeInteger(nowMs) ||
        nowMs < 0 ||
        typeof fileNow !== 'function' ||
        !Number.isSafeInteger(retentionMs) ||
        retentionMs < 1
    ) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_STATE', 'The feedback handoff state is invalid.');
    }
    await ensurePrivateStoreDirectory(dataDirectory);
    await withStoreLock(dataDirectory, fileNow, async () => {
        await cleanupStore(dataDirectory, nowMs, retentionMs);
        const preparedPath = preparedPathForSession(dataDirectory, sessionId);
        const grantPath = grantPathForSession(dataDirectory, sessionId);
        if (await stat(grantPath).then(() => true, () => false)) {
            throw new FeedbackHandoffError(
                'FEEDBACK_GRANT_CONFLICT',
                'Another feedback upload grant is already waiting for this session.'
            );
        }
        let prepared;
        try {
            prepared = parsePreparedEntry(await readBoundedState(preparedPath));
        } catch (error) {
            if (error?.code === 'ENOENT') {
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

        const claimPath = join(dataDirectory, `.claim-prepared-${process.pid}-${randomUUID()}`);
        try {
            await rename(preparedPath, claimPath);
        } catch (error) {
            if (error?.code === 'ENOENT') {
                throw new FeedbackHandoffError(
                    'FEEDBACK_PREPARED_MISSING',
                    'No prepared feedback artifact is waiting for this session.'
                );
            }
            throw error;
        }

        let published = false;
        try {
            await writeAtomicReplacement(grantPath, {
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
            published = true;
        } finally {
            if (published) {
                await removeFile(claimPath);
            } else {
                try {
                    await rename(claimPath, preparedPath);
                } catch (error) {
                    if (error?.code !== 'ENOENT') throw error;
                }
            }
        }
    });
};

const retireGrantAndRestorePrepared = async ({ dataDirectory, sessionId, grantPath, entry }) => {
    const preparedPath = preparedPathForSession(dataDirectory, sessionId);
    const retirementPath = join(dataDirectory, `.claim-grant-${process.pid}-${randomUUID()}`);
    // WHY: remove the doomed grant from the claimable name before republishing metadata, so no retry can use both states.
    await rename(grantPath, retirementPath);
    let restored = false;
    try {
        await writeAtomicReplacement(preparedPath, {
            version: 1,
            type: 'prepared',
            createdAtMs: entry.createdAtMs,
            targetTool: SUBMIT_TARGET_TOOL,
            artifactId: entry.artifactId,
            kind: entry.kind,
            sizeBytes: entry.sizeBytes,
            sha256: entry.sha256,
            transcriptIncluded: entry.transcriptIncluded,
        });
        restored = true;
    } finally {
        if (restored) {
            await removeFile(retirementPath);
        } else {
            try {
                await rename(retirementPath, grantPath);
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
        }
    }
};

export const claimUploadGrant = async ({
    dataDirectory,
    sessionId,
    artifactId,
    targetTool,
    nowMs = Date.now(),
    fileNow = Date.now,
    retentionMs = STATE_RETENTION_MS,
    publishClaim,
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
        typeof fileNow !== 'function' ||
        !Number.isSafeInteger(retentionMs) ||
        retentionMs < 1 ||
        publishClaim !== undefined && typeof publishClaim !== 'function'
    ) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_STATE', 'The feedback handoff state is invalid.');
    }
    await ensurePrivateStoreDirectory(dataDirectory);
    return withStoreLock(dataDirectory, fileNow, async () => {
        await cleanupStore(dataDirectory, nowMs, retentionMs);
        const grantPath = grantPathForSession(dataDirectory, sessionId);
        let entry;
        try {
            entry = parseGrantEntry(await readBoundedState(grantPath), {
                nowMs,
                retentionMs,
                allowExpired: true,
            });
        } catch (error) {
            if (error?.code !== 'ENOENT') await removeFile(grantPath);
            throw new FeedbackHandoffError(
                'FEEDBACK_GRANT_MISSING',
                'No valid feedback upload grant is waiting for this session.'
            );
        }
        if (entry.targetTool !== targetTool) {
            throw new FeedbackHandoffError(
                'FEEDBACK_TOOL_MISMATCH',
                'The feedback upload grant does not match this local tool.'
            );
        }
        if (entry.artifactId !== artifactId) {
            throw new FeedbackHandoffError(
                'FEEDBACK_ARTIFACT_MISMATCH',
                'The feedback upload grant does not match this prepared artifact.'
            );
        }

        if (entry.expiresAt * 1000 - nowMs < MIN_CLAIM_GRANT_REMAINING_MS) {
            await retireGrantAndRestorePrepared({ dataDirectory, sessionId, grantPath, entry });
            throw grantRefreshRequired();
        }

        const transport = {
            uploadUrl: entry.uploadUrl,
            objectKey: entry.objectKey,
            requiredHeaders: entry.requiredHeaders,
            expiresAt: entry.expiresAt,
            expectedSize: entry.sizeBytes,
            expectedSha256: entry.sha256,
        };
        // Publish the short-lived local claim while the validated grant is still protected by this store lock.
        // If publication fails, the grant path is untouched and a later PreToolUse can try again.
        const publication = publishClaim === undefined ? undefined : await publishClaim(transport);

        const claimPath = join(dataDirectory, `.claim-grant-${process.pid}-${randomUUID()}`);
        try {
            await rename(grantPath, claimPath);
        } catch (error) {
            if (error?.code === 'ENOENT') {
                throw new FeedbackHandoffError(
                    'FEEDBACK_GRANT_MISSING',
                    'No valid feedback upload grant is waiting for this session.'
                );
            }
            throw error;
        }
        await removeFile(claimPath);
        return publication === undefined ? transport : { ...transport, publication };
    });
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
        : error.code === 'FEEDBACK_GRANT_MISSING'
            ? 'The trusted e-Comet feedback handoff is unavailable. A disabled, untrusted, or modified hook is one possible cause. Check the client hook settings, then start a new feedback flow. Do not retry automatically.'
            : 'Do not retry automatically. Ask the user before starting a new feedback flow.';
    return JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
                `${error.code}: e-Comet could not safely complete the trusted feedback handoff. ` +
                recovery,
        },
    });
};

const safeHookError = (error) => {
    if (error instanceof FeedbackHandoffError) return error;
    return new FeedbackHandoffError('FEEDBACK_STORAGE_ERROR', 'The local feedback handoff failed.');
};

const prepareInputWithTrustedTranscript = (event) => {
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
        hasOwn(toolInput, 'feedback_session')
    ) {
        throw new FeedbackHandoffError(
            'FEEDBACK_MODEL_TRANSPORT',
            'Trusted feedback fields must not be supplied in model-authored input.'
        );
    }
    if (!toolInput.includeTranscript) return { ...toolInput };
    const transcriptPath = transcriptPathFromEvent(event);
    if (transcriptPath === undefined) {
        throw new FeedbackHandoffError(
            'FEEDBACK_TRANSCRIPT_UNAVAILABLE',
            'The trusted feedback transcript is unavailable.'
        );
    }
    return { ...toolInput, transcriptPath };
};

const issueLocalClaim = async ({ event, effectiveInput, targetTool, env, nowMs, expiresAt, issueFeedbackClaimImpl = issueFeedbackClaim }) => {
    const remainingGrantMs = expiresAt === undefined ? 60_000 : expiresAt * 1000 - nowMs;
    const ttlMs = Math.min(60_000, remainingGrantMs);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_GRANT', 'The feedback upload grant is invalid.');
    }
    try {
        return await issueFeedbackClaimImpl(
            {
                sessionId: sessionIdFromEvent(event),
                targetTool,
                input: effectiveInput,
            },
            { env, now: () => nowMs, ttlMs },
        );
    } catch {
        throw new FeedbackHandoffError('FEEDBACK_STORAGE_ERROR', 'The local feedback handoff failed.');
    }
};

export const processHookEvent = async (event, _options = {}) => {
    if (!isRecord(event)) {
        const error = new FeedbackHandoffError('FEEDBACK_INVALID_EVENT', 'The desktop hook event is invalid.');
        return { exitCode: 2, stdout: '', stderr: `${error.code}: ${error.message}` };
    }

    const eventName = eventNameFromEvent(event);
    const toolName = toolNameFromEvent(event);
    if (
        eventName === 'PostToolUse' &&
        typeof toolName === 'string' &&
        REMOTE_REPORT_ISSUE_TOOL.test(toolName)
    ) {
        try {
            const { env = process.env, nowMs = Date.now(), fileNow = Date.now } = _options;
            const sessionId = sessionIdFromEvent(event);
            const remoteInput = toolInputFromEvent(event);
            const authored = validateRemoteInput(remoteInput);
            const grant = extractUploadGrant(toolResponseFromEvent(event), {
                nowMs,
                expectedSize: authored.sizeBytes,
            });
            await stageUploadGrant({
                dataDirectory: resolveStoreDirectory(env),
                sessionId,
                remoteInput,
                grant,
                nowMs,
                fileNow,
            });
            return { exitCode: 0, stdout: '', stderr: '' };
        } catch (error) {
            const safeError = safeHookError(error);
            return { exitCode: 2, stdout: '', stderr: `${safeError.code}: ${safeError.message}` };
        }
    }
    if (
        eventName === 'PostToolUse' &&
        typeof toolName === 'string' &&
        LOCAL_FEEDBACK_TOOL.test(toolName) &&
        toolName.endsWith('__prepare_e_comet_feedback')
    ) {
        try {
            const { env = process.env, nowMs = Date.now(), fileNow = Date.now } = _options;
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
                fileNow,
            });
            return { exitCode: 0, stdout: '', stderr: '' };
        } catch (error) {
            const safeError = safeHookError(error);
            return { exitCode: 2, stdout: '', stderr: `${safeError.code}: ${safeError.message}` };
        }
    }
    if (
        eventName === 'PreToolUse' &&
        typeof toolName === 'string' &&
        LOCAL_FEEDBACK_TOOL.test(toolName) &&
        toolName.endsWith('__prepare_e_comet_feedback')
    ) {
        try {
            const { env = process.env, nowMs = Date.now(), issueFeedbackClaimImpl = issueFeedbackClaim } = _options;
            const effectiveInput = prepareInputWithTrustedTranscript(event);
            const claim = await issueLocalClaim({
                event,
                effectiveInput,
                targetTool: 'prepare_e_comet_feedback',
                env,
                nowMs,
                issueFeedbackClaimImpl,
            });
            return {
                exitCode: 0,
                stdout: preToolUseOutput({
                    ...effectiveInput,
                    feedbackClaim: claim.claimToken,
                    feedbackSession: claim.sessionBinding,
                }),
                stderr: '',
            };
        } catch (error) {
            const safeError = safeHookError(error);
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
            const { env = process.env, nowMs = Date.now(), fileNow = Date.now, issueFeedbackClaimImpl = issueFeedbackClaim } = _options;
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
            const authorized = await claimUploadGrant({
                dataDirectory: resolveStoreDirectory(env),
                sessionId,
                artifactId: toolInput.artifactId,
                targetTool: toolName.slice(toolName.lastIndexOf('__') + 2),
                nowMs,
                fileNow,
                publishClaim: async (transport) => {
                    const effectiveInput = { ...toolInput, ...transport };
                    const claim = await issueLocalClaim({
                        event,
                        effectiveInput,
                        targetTool: SUBMIT_TARGET_TOOL,
                        env,
                        nowMs,
                        expiresAt: transport.expiresAt,
                        issueFeedbackClaimImpl,
                    });
                    return { effectiveInput, claim };
                },
            });
            const { effectiveInput, claim } = authorized.publication;
            return {
                exitCode: 0,
                stdout: preToolUseOutput({
                    ...effectiveInput,
                    feedbackClaim: claim.claimToken,
                    feedbackSession: claim.sessionBinding,
                }),
                stderr: '',
            };
        } catch (error) {
            const safeError = safeHookError(error);
            return { exitCode: 0, stdout: deniedPreToolUseOutput(safeError), stderr: '' };
        }
    }

    return { exitCode: 0, stdout: '', stderr: '' };
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
if (isMain) await main();
