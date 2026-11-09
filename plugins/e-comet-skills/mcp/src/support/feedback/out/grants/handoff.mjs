import { randomUUID } from 'node:crypto';
import { chmod, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createClaimMarker, ensurePrivateStoreDirectory } from '../../../../handoff/grants/file-store.mjs';
import { GRANT_POLICIES } from '../../../../handoff/grants/policy.mjs';
import { hashSessionId as sessionHash, isValidSessionId, SESSION_ID_MAX_BYTES } from '../../../../handoff/session.mjs';
import { loadHookSecret, signHookFields } from '../../../../handoff/signature.mjs';
import { resolvePluginDataRoot } from '../../../../storage/files/layout.mjs';
import { sweepExpired } from '../../../../storage/files/retention.mjs';
import { RETRY_POLICIES, retryTransientFileOperation } from '../../../../storage/files/transient-retry.mjs';
import { FEEDBACK_ARTIFACT_RETENTION_MS as STATE_RETENTION_MS } from '../../domain/constants/limits.const.mjs';
import { ARTIFACT_ID_PATTERN, CLOCK_SKEW_MS, FeedbackHandoffError, grantRefreshRequired, isFreshEntry, parseGrantEntry, parsePreparedEntry, requireGrantLifetime, SUBMIT_TARGET_TOOL, validatePreparedMetadata, validateRemoteInput, validateUploadGrant, } from '../../domain/policies/handoff.policy.mjs';
import { safeFeedbackProperty, withFeedbackOperation } from '../../../../transport/failures/evidence.mjs';
// The handoff's records in the host's plugin data: one prepared record and one grant per session, published by rename,
// and the claim marker that elects one submit.
const MAX_STATE_FILE_BYTES = 64 * 1024;
const STORE_DIRECTORY = 'feedback-handoff-v1';
const STATE_FILE_PATTERN = /^([a-f0-9]{64})\.(prepared|grant)\.json$/;
const CLAIMED_MARKER_PATTERN = /^[a-f0-9]{64}\.grant\.claimed$/;
const TEMPORARY_STATE_PATTERN = /^[a-f0-9]{64}\.(?:prepared|grant)\.[0-9a-f-]{36}\.tmp$/;
const byteLength = (value) => Buffer.byteLength(value, 'utf8');
const validateSessionId = (sessionId) => {
    if (!isValidSessionId(sessionId, SESSION_ID_MAX_BYTES.FEEDBACK)) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_SESSION', 'The feedback handoff session is invalid.');
    }
    return sessionId;
};
const hashSessionId = (sessionId) => sessionHash(validateSessionId(sessionId));
const resolveStoreDirectory = (env) => {
    const pluginData = resolvePluginDataRoot(env, 'feedback');
    if (pluginData.state !== 'ready') {
        throw new FeedbackHandoffError('FEEDBACK_DATA_DIR_UNAVAILABLE', 'The desktop client did not provide writable plugin storage.');
    }
    return join(pluginData.path, STORE_DIRECTORY);
};
const preparedPathForSession = (dataDirectory, sessionId) => join(dataDirectory, `${hashSessionId(sessionId)}.prepared.json`);
const grantPathForSession = (dataDirectory, sessionId) => join(dataDirectory, `${hashSessionId(sessionId)}.grant.json`);
const claimedMarkerPathForSession = (dataDirectory, sessionId) => join(dataDirectory, `${hashSessionId(sessionId)}.grant.claimed`);
const hasPreparedState = async (env, sessionId) => {
    try {
        return await stat(preparedPathForSession(resolveStoreDirectory(env), validateSessionId(sessionId))).then(() => true, () => false);
    }
    catch {
        return false;
    }
};
const removeFile = (path) => retryTransientFileOperation(() => rm(path, { force: true }), RETRY_POLICIES.FEEDBACK);
// Removal that has to distinguish "gone" from "removed by me": `force` would report success for a file
// another claimer already consumed. Same transient-lock patience as removeFile, ENOENT still raised.
const consumeFile = (path) => retryTransientFileOperation(() => unlink(path), RETRY_POLICIES.FEEDBACK);
const isOwnStateName = (name) => STATE_FILE_PATTERN.test(name) || CLAIMED_MARKER_PATTERN.test(name) || TEMPORARY_STATE_PATTERN.test(name);
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
        if (process.platform !== 'win32')
            await chmod(temporaryPath, 0o600);
        await retryTransientFileOperation(() => rename(temporaryPath, path), RETRY_POLICIES.FEEDBACK);
    }
    finally {
        await removeFile(temporaryPath).catch(() => undefined);
    }
};
// Reads through a symlink: accepted residual, see docs/architecture/residuals/feedback.md.
// Parse boundary: the record's JSON, which the domain checks.
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
    }
    catch {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_STATE', 'The feedback handoff state is invalid.');
    }
};
/** Read-only native recovery uses the same validated, retained state as the hooks. */
export const readPreparedArtifact = async ({ env = process.env, sessionId, nowMs = Date.now(), }) => {
    validateSessionId(sessionId);
    let entry;
    try {
        entry = parsePreparedEntry(await readBoundedState(preparedPathForSession(resolveStoreDirectory(env), sessionId)));
    }
    catch (error) {
        if (safeFeedbackProperty(error, 'code') === 'ENOENT')
            return undefined;
        throw error;
    }
    if (!isFreshEntry(entry, nowMs, STATE_RETENTION_MS))
        return undefined;
    return validatePreparedMetadata({
        artifactId: entry.artifactId,
        kind: entry.kind,
        sizeBytes: entry.sizeBytes,
        sha256: entry.sha256,
        transcriptIncluded: entry.transcriptIncluded,
    });
};
export const stagePreparedArtifact = async ({ dataDirectory, sessionId, metadata, nowMs = Date.now(), retentionMs = STATE_RETENTION_MS, }) => {
    validateSessionId(sessionId);
    const validated = validatePreparedMetadata(metadata);
    if (typeof dataDirectory !== 'string' ||
        !dataDirectory ||
        !Number.isSafeInteger(nowMs) ||
        nowMs < 0 ||
        !Number.isSafeInteger(retentionMs) ||
        retentionMs < 1) {
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
export const stageUploadGrant = async ({ dataDirectory, sessionId, remoteInput, grant, nowMs = Date.now(), retentionMs = STATE_RETENTION_MS, }) => {
    validateSessionId(sessionId);
    if (typeof dataDirectory !== 'string' ||
        !dataDirectory ||
        !Number.isSafeInteger(nowMs) ||
        nowMs < 0 ||
        !Number.isSafeInteger(retentionMs) ||
        retentionMs < 1) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_STATE', 'The feedback handoff state is invalid.');
    }
    await ensurePrivateStoreDirectory(dataDirectory);
    await sweepState(dataDirectory, retentionMs);
    const grantPath = grantPathForSession(dataDirectory, sessionId);
    // Preserve the waiting authorization. Its presence does not establish expiry or upload outcome;
    // submit checks those before dispatch. Expired-grant replacement stays an accepted residual:
    // docs/architecture/residuals/feedback.md.
    if (await stat(grantPath).then(() => true, () => false)) {
        throw new FeedbackHandoffError('FEEDBACK_GRANT_CONFLICT', 'An upload authorization is already staged for the prepared artifact in this session. Submit the same artifactId, preserving the existing history choice: that call checks expiry and any recorded upload outcome before sending. Request another authorization only if that check asks for a refresh.');
    }
    let prepared;
    try {
        prepared = parsePreparedEntry(await readBoundedState(preparedPathForSession(dataDirectory, sessionId)));
    }
    catch (error) {
        if (safeFeedbackProperty(error, 'code') === 'ENOENT') {
            throw new FeedbackHandoffError('FEEDBACK_PREPARED_MISSING', 'No prepared feedback artifact is waiting for this session.');
        }
        throw error;
    }
    if (!isFreshEntry(prepared, nowMs, retentionMs)) {
        throw new FeedbackHandoffError('FEEDBACK_PREPARED_MISSING', 'No prepared feedback artifact is waiting for this session.');
    }
    const authored = validateRemoteInput(remoteInput);
    if (authored.kind !== prepared.kind || authored.sizeBytes !== prepared.sizeBytes) {
        throw new FeedbackHandoffError('FEEDBACK_PREPARED_MISMATCH', 'The upload request does not match the prepared feedback artifact.');
    }
    const validatedGrant = validateUploadGrant(grant, { nowMs, expectedSize: prepared.sizeBytes });
    // WHY: reject a doomed response while the same prepared artifact is still available for fresh authorization.
    requireGrantLifetime(validatedGrant, { nowMs, minimumRemainingMs: GRANT_POLICIES.FEEDBACK.minStageRemainingMs });
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
/**
 * Consumes the grant staged for one prepared artifact and returns its transport. Nothing else elects a
 * single uploader, so the claim itself is the one-shot election.
 */
export const claimUploadGrant = async ({ dataDirectory, sessionId, artifactId, targetTool, nowMs = Date.now(), retentionMs = STATE_RETENTION_MS, }) => {
    validateSessionId(sessionId);
    if (targetTool !== SUBMIT_TARGET_TOOL) {
        throw new FeedbackHandoffError('FEEDBACK_TOOL_MISMATCH', 'The feedback upload grant does not match this local tool.');
    }
    if (typeof artifactId !== 'string' || !ARTIFACT_ID_PATTERN.test(artifactId)) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_INPUT', 'The feedback submission arguments are invalid.');
    }
    if (typeof dataDirectory !== 'string' ||
        !dataDirectory ||
        !Number.isSafeInteger(nowMs) ||
        nowMs < 0 ||
        !Number.isSafeInteger(retentionMs) ||
        retentionMs < 1) {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_STATE', 'The feedback handoff state is invalid.');
    }
    await ensurePrivateStoreDirectory(dataDirectory);
    await sweepState(dataDirectory, retentionMs);
    const grantPath = grantPathForSession(dataDirectory, sessionId);
    const markerPath = claimedMarkerPathForSession(dataDirectory, sessionId);
    const grantMissing = (cause) => new FeedbackHandoffError('FEEDBACK_GRANT_MISSING', 'No valid feedback upload grant is waiting for this session.', cause);
    // Exclusive create is the one-shot election: a rename reports success to more than one native
    // Windows caller, and reading only after winning keeps a later winner from seeing consumed bytes.
    try {
        await createClaimMarker(markerPath, { staleMarkerMs: GRANT_POLICIES.FEEDBACK.staleMarkerMs, remove: removeFile });
    }
    catch (error) {
        // Only an existing marker means a consumed grant; any other failure is a storage error.
        if (safeFeedbackProperty(error, 'code') !== 'EEXIST')
            throw error;
        throw grantMissing(error);
    }
    const releaseElection = () => removeFile(markerPath).catch(() => undefined);
    let entry;
    try {
        entry = parseGrantEntry(await readBoundedState(grantPath), { nowMs, retentionMs, allowExpired: true });
    }
    catch (error) {
        // Nothing was consumed, so the election is released: a marker left here would hide the grant a
        // concurrent report_issue is publishing right now, or one a later read could still serve, until
        // the next prepare. Unreadable state never carries authority and is removed with it.
        await releaseElection();
        if (error instanceof FeedbackHandoffError)
            await removeFile(grantPath);
        if (!(error instanceof FeedbackHandoffError) && safeFeedbackProperty(error, 'code') !== 'ENOENT')
            throw error;
        throw grantMissing(error);
    }
    if (entry.artifactId !== artifactId) {
        // Nothing was consumed: release the election so the matching submit can still claim this grant.
        await releaseElection();
        throw new FeedbackHandoffError('FEEDBACK_ARTIFACT_MISMATCH', 'The feedback upload grant does not match this prepared artifact.');
    }
    if (entry.expiresAt * 1000 - nowMs < GRANT_POLICIES.FEEDBACK.minClaimRemainingMs) {
        // The doomed authorization is removed; the prepared artifact stays for the one
        // fresh report_issue this refusal names, which a kept grant would otherwise refuse as a conflict.
        await removeFile(grantPath);
        await releaseElection();
        throw grantRefreshRequired();
    }
    // Consume the grant before releasing the election: no second reader may observe it. The removal
    // is strict, because a grant that is already gone was consumed by someone else and this call
    // holds no authorization. A grant that cannot be removed right now was not consumed either, so
    // the election is released with the error.
    try {
        await consumeFile(grantPath);
    }
    catch (error) {
        await releaseElection();
        if (safeFeedbackProperty(error, 'code') === 'ENOENT')
            throw grantMissing(error);
        throw error;
    }
    await removeFile(markerPath);
    return {
        uploadUrl: entry.uploadUrl,
        objectKey: entry.objectKey,
        requiredHeaders: entry.requiredHeaders,
        expiresAt: entry.expiresAt,
        expectedSize: entry.sizeBytes,
        expectedSha256: entry.sha256,
    };
};
// The shared secret is loaded before any authorization is consumed: a storage failure must not cost
// the user a fresh report_issue. The operation tag keeps the existing handoff diagnostics vocabulary.
const loadSigningSecret = async (env) => {
    try {
        return await loadHookSecret({ env, create: true });
    }
    catch (error) {
        throw withFeedbackOperation(error, 'claim_issue');
    }
};
/** The handoff's grants port over the plugin data of `env`; the store directory is resolved on every call. */
export const createFileFeedbackGrants = ({ env }) => ({
    validSession: (sessionId) => validateSessionId(sessionId),
    sessionHash: (sessionId) => hashSessionId(sessionId),
    hasPrepared: (sessionId) => hasPreparedState(env, sessionId),
    readPrepared: ({ sessionId, nowMs }) => readPreparedArtifact({ env, sessionId, nowMs }),
    stagePrepared: ({ sessionId, metadata, nowMs }) => stagePreparedArtifact({ dataDirectory: resolveStoreDirectory(env), sessionId, metadata, nowMs }),
    stageGrant: ({ sessionId, remoteInput, grant, nowMs }) => stageUploadGrant({ dataDirectory: resolveStoreDirectory(env), sessionId, remoteInput, grant, nowMs }),
    claimGrant: ({ sessionId, artifactId, targetTool, nowMs }) => claimUploadGrant({ dataDirectory: resolveStoreDirectory(env), sessionId, artifactId, targetTool, nowMs }),
    // The secret is loaded before anything is claimed; the signer then signs as often as the call needs.
    loadSigner: async () => {
        const secret = await loadSigningSecret(env);
        return (request) => signHookFields({ secret, ...request });
    },
});
