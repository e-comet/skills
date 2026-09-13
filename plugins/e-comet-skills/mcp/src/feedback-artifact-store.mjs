import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FEEDBACK_ARTIFACT_RETENTION_MS, FEEDBACK_ARTIFACT_STORAGE, FEEDBACK_KINDS, FEEDBACK_MAX_BYTES } from './config.mjs';
import { FeedbackPreparationError } from './feedback-errors.mjs';
import { sweepExpired } from './file-retention.mjs';
import { requireStorageTarget } from './storage-layout.mjs';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const ARTIFACT_ID_PATTERN = new RegExp(`^${UUID}$`);
// A published artifact directory `report-<uuid>` or an unfinished `report-<uuid>.pending`. The name
// deliberately differs from the bare `<uuid>` of the previous release: a session started before an
// update keeps that release's process alive, and its maintenance removes every bare-UUID directory
// missing from its manifest, whatever its age.
const OWN_ENTRY_PATTERN = new RegExp(`^report-${UUID}(?:\\.pending)?$`);
const artifactDirectoryName = (artifactId) => `report-${artifactId}`;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FEEDBACK_KIND_SET = new Set(FEEDBACK_KINDS);
const MAX_META_BYTES = 4096;

const storageError = (message, reason) => Object.assign(new Error(message), { feedbackReason: reason });
// Registration keeps filesystem diagnostics private; the preparation boundary maps them to this stable public outcome.
export const feedbackArtifactStorageUnavailable = (cause) => new FeedbackPreparationError('FEEDBACK_STORAGE_UNAVAILABLE', cause);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const asNodeError = (error) => (error instanceof Error ? error : new Error(String(error)));
const isNotFound = (error) => error?.code === 'ENOENT';
const clock = (now) => (typeof now === 'function' ? now : () => now);
// Whatever an older release left in this root under other names is never touched.
const isSweptName = (name) => OWN_ENTRY_PATTERN.test(name);
const assertPositiveInteger = (value, name) => {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`Feedback ${name} must be a positive safe integer`);
};
const assertBytes = (value, name, maximum) => {
    if (!Buffer.isBuffer(value)) throw new TypeError(`Feedback ${name} bytes must be a Buffer`);
    if (value.length === 0) throw new RangeError(`Feedback ${name} bytes must not be empty`);
    if (value.length > maximum) throw new RangeError(`Feedback ${name} exceeds the ${maximum}-byte limit`);
};
const assertClock = (nowMs) => {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RangeError('Feedback artifact clock must return a non-negative safe integer');
    return nowMs;
};
const assertArtifactId = (value) => {
    if (!value || typeof value !== 'object' || !ARTIFACT_ID_PATTERN.test(value.artifactId)) throw new RangeError('Feedback artifact ID is invalid');
    return value.artifactId;
};
const tightenExistingPrivateDirectory = async (directory, platform) => {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Feedback artifact directory must be a private real directory');
    if (platform !== 'win32') await chmod(directory, 0o700);
};
const ensurePrivateDirectory = async (directory, platform) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await tightenExistingPrivateDirectory(directory, platform);
};
const ensurePrivateFile = async (path, platform) => {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Feedback artifact file must be a regular non-symlink file');
    if (platform !== 'win32') await chmod(path, 0o600);
};
const reportResource = (artifactDirectory, artifactId) => ({
    uri: pathToFileURL(join(artifactDirectory, artifactDirectoryName(artifactId), 'report.md')).href,
    name: 'report.md',
    mimeType: 'text/markdown',
});
const validMeta = (meta, artifactId) =>
    meta && typeof meta === 'object' && Object.keys(meta).length === 6 &&
    meta.artifactId === artifactId && FEEDBACK_KIND_SET.has(meta.kind) &&
    Number.isSafeInteger(meta.sizeBytes) && meta.sizeBytes > 0 && SHA256_PATTERN.test(meta.sha256) &&
    typeof meta.transcriptIncluded === 'boolean' && Number.isSafeInteger(meta.createdAtMs) && meta.createdAtMs >= 0;
const readMeta = async (directory, artifactId) => {
    const path = join(directory, 'meta.json');
    let meta;
    try {
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_META_BYTES) throw storageError('Feedback artifact metadata is invalid', 'artifact_integrity');
        meta = JSON.parse((await readFile(path)).toString('utf8'));
    } catch (error) {
        if (isNotFound(error)) throw storageError('Feedback artifact is missing or expired', 'artifact_missing');
        if (error?.feedbackReason) throw error;
        // Only unparseable content is corruption. A filesystem refusal (EACCES, EIO, EBUSY) keeps its
        // own code and cause, as today: support must see the real reason, not a false integrity claim.
        if (error instanceof SyntaxError) throw storageError('Feedback artifact metadata is invalid', 'artifact_integrity');
        throw asNodeError(error);
    }
    if (!validMeta(meta, artifactId)) throw storageError('Feedback artifact metadata is invalid', 'artifact_integrity');
    return meta;
};
// One directory, one pass: artifact directories and unfinished ones by their own mtime, nothing else.
const sweepOwn = (artifactDirectory, retentionMs, nowMs) =>
    sweepExpired({ directory: artifactDirectory, ownName: isSweptName, retentionMs, now: nowMs, recursive: true });

/**
 * @param {{ artifactDirectory?: string, storageTarget?: { state: string, path?: string, reason?: string }, now?: number | (() => number), retentionMs?: number }} options
 * @returns {Promise<Error[]>}
 */
export const maintainFeedbackArtifacts = async (options = {}) => {
    const { retentionMs = FEEDBACK_ARTIFACT_RETENTION_MS, now = Date.now } = options;
    const storageTarget = options.storageTarget ?? FEEDBACK_ARTIFACT_STORAGE;
    const explicit = options.artifactDirectory !== undefined;
    if (!explicit && storageTarget.state !== 'ready') return [];
    const artifactDirectory = explicit ? options.artifactDirectory : storageTarget.path;
    assertPositiveInteger(retentionMs, 'artifact retention');
    const nowMs = assertClock(clock(now)());
    return sweepOwn(artifactDirectory, retentionMs, nowMs);
};

/**
 * @param {{ kind: string, includeTranscript: boolean, reportBytes: Buffer, archiveBytes: Buffer }} artifact
 * @param {{ artifactDirectory?: string, storageTarget?: { state: string, path?: string, reason?: string }, retentionMs?: number, now?: number | (() => number), platform?: NodeJS.Platform, createArtifactId?: () => string }} options
 */
export const registerFeedbackArtifact = async (artifact, options = {}) => {
    const { retentionMs = FEEDBACK_ARTIFACT_RETENTION_MS, now = Date.now, platform = process.platform, createArtifactId = randomUUID } = options;
    const artifactDirectory = options.artifactDirectory ?? requireStorageTarget(options.storageTarget ?? FEEDBACK_ARTIFACT_STORAGE, 'feedbackArtifacts');
    if (!artifact || typeof artifact !== 'object' || !FEEDBACK_KIND_SET.has(artifact.kind)) throw new RangeError('Feedback kind is invalid');
    if (typeof artifact.includeTranscript !== 'boolean') throw new TypeError('Feedback transcript inclusion must be a boolean');
    assertBytes(artifact.reportBytes, 'report', FEEDBACK_MAX_BYTES);
    assertBytes(artifact.archiveBytes, 'archive', FEEDBACK_MAX_BYTES);
    assertPositiveInteger(retentionMs, 'artifact retention');
    if (typeof createArtifactId !== 'function') throw new TypeError('Feedback artifact ID factory must be a function');
    const nowMs = assertClock(clock(now)());
    const artifactId = createArtifactId();
    if (!ARTIFACT_ID_PATTERN.test(artifactId)) throw new Error('Feedback artifact ID is invalid');
    const directory = artifactDirectory;
    await ensurePrivateDirectory(directory, platform);
    const meta = {
        artifactId,
        kind: artifact.kind,
        sizeBytes: artifact.archiveBytes.length,
        sha256: sha256(artifact.archiveBytes),
        transcriptIncluded: artifact.includeTranscript,
        createdAtMs: nowMs,
    };
    const finalPath = join(directory, artifactDirectoryName(artifactId));
    const pendingPath = `${finalPath}.pending`;
    await mkdir(pendingPath, { mode: 0o700 });
    try {
        await tightenExistingPrivateDirectory(pendingPath, platform);
        /** @type {Array<[string, Buffer]>} */
        const files = [['report.md', artifact.reportBytes], ['feedback.zip', artifact.archiveBytes], ['meta.json', Buffer.from(`${JSON.stringify(meta)}\n`, 'utf8')]];
        for (const [name, bytes] of files) {
            const path = join(pendingPath, name);
            await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
            await ensurePrivateFile(path, platform);
        }
        await rename(pendingPath, finalPath);
    } catch (error) {
        // Own unfinished data only; a leftover that survives this removal ages out with the next sweep.
        await rm(pendingPath, { recursive: true, force: true }).catch(() => undefined);
        throw asNodeError(error);
    }
    void sweepOwn(artifactDirectory, retentionMs, nowMs);
    return { ...meta, reportResource: reportResource(artifactDirectory, artifactId) };
};

/**
 * @param {{ artifactId: string, expectedSize: number, expectedSha256: string }} request
 * @param {{ artifactDirectory?: string, storageTarget?: { state: string, path?: string, reason?: string }, platform?: NodeJS.Platform, retentionMs?: number, now?: number | (() => number) }} options
 */
export const loadVerifiedFeedbackArtifact = async (request, options = {}) => {
    const { platform = process.platform, retentionMs = FEEDBACK_ARTIFACT_RETENTION_MS, now = Date.now } = options;
    const artifactId = assertArtifactId(request);
    assertPositiveInteger(request.expectedSize, 'expected size');
    if (typeof request.expectedSha256 !== 'string' || !SHA256_PATTERN.test(request.expectedSha256)) throw new RangeError('Feedback expected SHA-256 is invalid');
    assertPositiveInteger(retentionMs, 'artifact retention');
    const nowMs = assertClock(clock(now)());
    const artifactDirectory = options.artifactDirectory ?? requireStorageTarget(options.storageTarget ?? FEEDBACK_ARTIFACT_STORAGE, 'feedbackArtifacts');
    const directory = join(artifactDirectory, artifactDirectoryName(artifactId));
    try {
        await tightenExistingPrivateDirectory(directory, platform);
    } catch (error) {
        if (isNotFound(error)) throw storageError('Feedback artifact is missing or expired', 'artifact_missing');
        throw error;
    }
    const meta = await readMeta(directory, artifactId);
    if (nowMs - meta.createdAtMs > retentionMs) throw storageError('Feedback artifact is expired', 'artifact_expired');
    if (request.expectedSize !== meta.sizeBytes) throw new Error('Feedback expected size does not match the artifact');
    if (request.expectedSha256 !== meta.sha256) throw new Error('Feedback expected SHA-256 does not match the artifact');
    const archivePath = join(directory, 'feedback.zip');
    const archiveMetadata = await lstat(archivePath).catch((error) => {
        if (isNotFound(error)) throw new Error('Feedback archive is missing');
        throw error;
    });
    if (archiveMetadata.isSymbolicLink()) throw new Error('Feedback archive symlink is rejected');
    if (!archiveMetadata.isFile()) throw new Error('Feedback archive is invalid');
    const size = (await stat(archivePath)).size;
    if (size <= 0 || size > FEEDBACK_MAX_BYTES) throw new Error('Feedback archive is invalid');
    const bytes = await readFile(archivePath);
    const actualSha256 = sha256(bytes);
    if (bytes.length !== meta.sizeBytes || bytes.length !== request.expectedSize || actualSha256 !== meta.sha256 || actualSha256 !== request.expectedSha256) {
        throw storageError('Feedback archive integrity verification failed', 'artifact_integrity');
    }
    return { bytes, kind: meta.kind, sizeBytes: meta.sizeBytes, sha256: meta.sha256, transcriptIncluded: meta.transcriptIncluded };
};

/**
 * Removes one definitively uploaded artifact. A removal that fails leaves the directory to the ordinary
 * age sweep and never changes the public upload receipt.
 * @param {{ artifactId: string }} request
 * @param {{ artifactDirectory?: string, storageTarget?: { state: string, path?: string, reason?: string }, platform?: NodeJS.Platform, retentionMs?: number, now?: number | (() => number) }} options
 */
export const retireFeedbackArtifact = async (request, options = {}) => {
    const { platform = process.platform, retentionMs = FEEDBACK_ARTIFACT_RETENTION_MS, now = Date.now } = options;
    const artifactId = assertArtifactId(request);
    const storageTarget = options.storageTarget ?? FEEDBACK_ARTIFACT_STORAGE;
    if (options.artifactDirectory === undefined && storageTarget.state !== 'ready') return { retired: false, localCleanup: 'complete' };
    const artifactDirectory = options.artifactDirectory ?? storageTarget.path;
    const nowMs = assertClock(clock(now)());
    const directory = join(artifactDirectory, artifactDirectoryName(artifactId));
    try {
        await tightenExistingPrivateDirectory(directory, platform);
    } catch (error) {
        if (isNotFound(error)) return { retired: false, localCleanup: 'complete' };
        throw error;
    }
    try {
        await rm(directory, { recursive: true, force: true });
    } catch {
        return { retired: false, localCleanup: 'pending' };
    }
    void sweepOwn(artifactDirectory, retentionMs, nowMs);
    return { retired: true, localCleanup: 'complete' };
};
