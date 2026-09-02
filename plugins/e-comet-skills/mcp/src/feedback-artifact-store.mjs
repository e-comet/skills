import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    FEEDBACK_ARTIFACT_DIR,
    FEEDBACK_ARTIFACT_MAX_FILES,
    FEEDBACK_ARTIFACT_MAX_TOTAL_BYTES,
    FEEDBACK_ARTIFACT_RETENTION_MS,
    FEEDBACK_KINDS,
    FEEDBACK_MAX_ARCHIVE_BYTES,
    FEEDBACK_MAX_REPORT_BYTES,
} from './config.mjs';

const MANIFEST_SCHEMA_VERSION = 1;
const MAX_MANIFEST_BYTES = 64 * 1024;
const ARTIFACT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FEEDBACK_KIND_SET = new Set(FEEDBACK_KINDS);
const FEEDBACK_STORE_LOCK_RETRY_LIMIT = 200;
const FEEDBACK_STORE_LOCK_RETRY_DELAY_MS = 25;
const FEEDBACK_STORE_LOCK_STALE_MS = 30_000;
const FEEDBACK_STORE_LOCK_OWNER_PATTERN = /^([1-9]\d{0,9})-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PENDING_ARTIFACT_PATTERN = /^\.pending-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const PENDING_MANIFEST_PATTERN = /^\.pending-manifest-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const FEEDBACK_MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;

const assertPositiveInteger = (value, name) => {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`Feedback ${name} must be a positive safe integer`);
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const asNodeError = (error) => (error instanceof Error ? error : new Error(String(error)));
const isNotFound = (error) => error?.code === 'ENOENT';
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const lockOwnerPid = (name) => {
    const match = FEEDBACK_STORE_LOCK_OWNER_PATTERN.exec(name);
    const pid = match ? Number(match[1]) : Number.NaN;
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
};
const isProcessAlive = (pid) => {
    if (pid === process.pid) return true;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === 'ESRCH' ? false : undefined;
    }
};

const ensurePrivateDirectory = async (directory, platform) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Feedback artifact directory must be a private real directory');
    if (platform !== 'win32') await chmod(directory, 0o700);
};

const ensurePrivateFile = async (path, platform) => {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Feedback artifact file must be a regular non-symlink file');
    if (platform !== 'win32') await chmod(path, 0o600);
};

const assertBytes = (value, name, maximum, { allowEmpty = false } = {}) => {
    if (!Buffer.isBuffer(value)) throw new TypeError(`Feedback ${name} bytes must be a Buffer`);
    if (!allowEmpty && value.length === 0) throw new RangeError(`Feedback ${name} bytes must not be empty`);
    if (value.length > maximum) throw new RangeError(`Feedback ${name} exceeds the ${maximum}-byte limit`);
};

const artifactPath = (artifactDirectory, artifactId) => join(artifactDirectory, artifactId);
const manifestPath = (artifactDirectory) => join(artifactDirectory, 'manifest.json');
const emptyManifest = () => ({ schemaVersion: MANIFEST_SCHEMA_VERSION, artifacts: [], pendingCleanup: [] });

const validManifestEntry = (entry) =>
    entry &&
    typeof entry === 'object' &&
    Object.keys(entry).length === 6 &&
    ARTIFACT_ID_PATTERN.test(entry.artifactId) &&
    FEEDBACK_KIND_SET.has(entry.kind) &&
    Number.isSafeInteger(entry.sizeBytes) &&
    entry.sizeBytes > 0 &&
    SHA256_PATTERN.test(entry.sha256) &&
    typeof entry.transcriptIncluded === 'boolean' &&
    Number.isSafeInteger(entry.createdAtMs) &&
    entry.createdAtMs >= 0;

const readManifest = async (artifactDirectory) => {
    const path = manifestPath(artifactDirectory);
    let bytes;
    try {
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_MANIFEST_BYTES) {
            throw new Error('Feedback artifact manifest is invalid');
        }
        bytes = await readFile(path);
    } catch (error) {
        if (isNotFound(error)) return emptyManifest();
        throw asNodeError(error);
    }
    let manifest;
    try {
        manifest = JSON.parse(bytes.toString('utf8'));
    } catch {
        throw new Error('Feedback artifact manifest is invalid');
    }
    if (
        !manifest ||
        typeof manifest !== 'object' ||
        Array.isArray(manifest)
    ) {
        throw new Error('Feedback artifact manifest is invalid');
    }
    const hasLegacyShape = Object.keys(manifest).length === 2 && Object.hasOwn(manifest, 'schemaVersion') && Object.hasOwn(manifest, 'artifacts');
    if (
        (!hasLegacyShape && Object.keys(manifest).length !== 3) ||
        manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
        !Array.isArray(manifest.artifacts) ||
        manifest.artifacts.length > FEEDBACK_ARTIFACT_MAX_FILES ||
        !manifest.artifacts.every(validManifestEntry) ||
        (manifest.pendingCleanup !== undefined && (!Array.isArray(manifest.pendingCleanup) || manifest.pendingCleanup.length > FEEDBACK_ARTIFACT_MAX_FILES || !manifest.pendingCleanup.every(validManifestEntry)))
    ) {
        throw new Error('Feedback artifact manifest is invalid');
    }
    const pendingCleanup = manifest.pendingCleanup ?? [];
    if (manifest.artifacts.length + pendingCleanup.length > FEEDBACK_ARTIFACT_MAX_FILES) {
        throw new Error('Feedback artifact manifest is invalid');
    }
    const allIds = [...manifest.artifacts, ...pendingCleanup].map((entry) => entry.artifactId);
    if (new Set(allIds).size !== allIds.length) throw new Error('Feedback artifact manifest is invalid');
    return { schemaVersion: MANIFEST_SCHEMA_VERSION, artifacts: manifest.artifacts, pendingCleanup };
};

const writeManifest = async (artifactDirectory, manifest, platform) => {
    const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8');
    if (bytes.length > MAX_MANIFEST_BYTES) throw new RangeError('Feedback artifact manifest exceeds its byte limit');
    const temporaryPath = join(artifactDirectory, `.pending-manifest-${randomUUID()}`);
    await writeFile(temporaryPath, bytes, { mode: 0o600, flag: 'wx' });
    try {
        await ensurePrivateFile(temporaryPath, platform);
        await rename(temporaryPath, manifestPath(artifactDirectory));
    } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }
};

const acquireFeedbackStoreLock = async (artifactDirectory) => {
    const lockPath = join(artifactDirectory, '.feedback-artifact-store.lock');
    for (let attempt = 0; attempt < FEEDBACK_STORE_LOCK_RETRY_LIMIT; attempt += 1) {
        const ownerId = `${process.pid}-${randomUUID()}`;
        const candidatePath = join(artifactDirectory, `.feedback-artifact-store-lock-${ownerId}`);
        const ownerPath = join(candidatePath, ownerId);
        await mkdir(candidatePath, { mode: 0o700 });
        try {
            await writeFile(ownerPath, '', { mode: 0o600, flag: 'wx' });
            await rename(candidatePath, lockPath);
            return async () => {
                await rm(join(lockPath, ownerId), { force: true });
                try {
                    await rmdir(lockPath);
                } catch (error) {
                    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error;
                }
            };
        } catch (error) {
            await rm(candidatePath, { recursive: true, force: true });
            if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error?.code)) throw error;
        }
        try {
            const metadata = await stat(lockPath);
            if (Date.now() - metadata.mtimeMs > FEEDBACK_STORE_LOCK_STALE_MS) {
                const owners = (await readdir(lockPath, { withFileTypes: true }))
                    .filter((entry) => entry.isFile())
                    .map((entry) => lockOwnerPid(entry.name))
                    .filter((pid) => pid !== null);
                if (owners.some((pid) => isProcessAlive(pid) !== false)) {
                    await delay(FEEDBACK_STORE_LOCK_RETRY_DELAY_MS);
                    continue;
                }
                const current = await stat(lockPath);
                if (current.dev === metadata.dev && current.ino === metadata.ino && current.mtimeMs === metadata.mtimeMs) {
                    const stalePath = join(artifactDirectory, `.feedback-artifact-store-stale-lock-${process.pid}-${randomUUID()}`);
                    await rename(lockPath, stalePath);
                    await rm(stalePath, { recursive: true, force: true });
                    continue;
                }
            }
        } catch (error) {
            if (!isNotFound(error)) throw error;
        }
        await delay(FEEDBACK_STORE_LOCK_RETRY_DELAY_MS);
    }
    throw new Error('Feedback artifact storage is busy');
};

const withFeedbackStoreLock = async (artifactDirectory, operation) => {
    const release = await acquireFeedbackStoreLock(artifactDirectory);
    let operationError;
    try {
        return await operation();
    } catch (error) {
        operationError = error;
        throw error;
    } finally {
        try {
            await release();
        } catch (releaseError) {
            if (!operationError) throw releaseError;
        }
    }
};

const reportResource = (artifactDirectory, artifactId) => ({
    uri: pathToFileURL(join(artifactPath(artifactDirectory, artifactId), 'report.md')).href,
    name: 'report.md',
    mimeType: 'text/markdown',
});

const pruneEntries = (entries, { maxArtifacts, maxTotalBytes, retentionMs, nowMs }) => {
    const ordered = [...entries].sort((left, right) => left.createdAtMs - right.createdAtMs || left.artifactId.localeCompare(right.artifactId));
    const expired = ordered.filter((entry) => nowMs - entry.createdAtMs > retentionMs);
    const retained = ordered.filter((entry) => !expired.includes(entry));
    let total = retained.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    const removed = [...expired];
    while (retained.length > maxArtifacts || total > maxTotalBytes) {
        const entry = retained.shift();
        if (!entry) break;
        total -= entry.sizeBytes;
        removed.push(entry);
    }
    return { retained, removed };
};

const totalEntryBytes = (entries) => entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);

const retryPendingCleanup = async (artifactDirectory, entries, removeArtifactImpl) => {
    const remaining = [];
    for (const entry of entries) {
        try {
            await removeArtifactImpl(artifactPath(artifactDirectory, entry.artifactId), { recursive: true, force: true });
        } catch {
            remaining.push(entry);
        }
    }
    return remaining;
};

const manifestEquals = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const removeCrashLeftovers = async (artifactDirectory, manifest, removeArtifactImpl) => {
    const indexed = new Set([...manifest.artifacts, ...manifest.pendingCleanup].map((entry) => entry.artifactId));
    const entries = await readdir(artifactDirectory, { withFileTypes: true });
    let cleanupFailed = false;
    for (const entry of entries) {
        const isPending = PENDING_ARTIFACT_PATTERN.test(entry.name) || PENDING_MANIFEST_PATTERN.test(entry.name);
        const isUnindexedArtifact = ARTIFACT_ID_PATTERN.test(entry.name) && !indexed.has(entry.name);
        if (!isPending && !isUnindexedArtifact) continue;
        try {
            await removeArtifactImpl(join(artifactDirectory, entry.name), { recursive: true, force: true });
        } catch {
            cleanupFailed = true;
        }
    }
    // WHY: unindexed crash survivors have no trustworthy manifest accounting. Reconciliation must fail closed
    // before pruning or admission rather than silently exceeding the physical count or byte quota.
    if (cleanupFailed) throw new Error('Feedback crash leftover cleanup is incomplete');
};

const retainExistingArtifactDirectories = async (artifactDirectory, entries, removeArtifactImpl) => {
    const retained = [];
    for (const entry of entries) {
        const path = artifactPath(artifactDirectory, entry.artifactId);
        try {
            const metadata = await lstat(path);
            if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
                retained.push(entry);
            } else {
                await removeArtifactImpl(path, { recursive: true, force: true }).catch(() => undefined);
            }
        } catch (error) {
            if (!isNotFound(error)) throw error;
        }
    }
    return retained;
};

const reconcileStoreUnlocked = async ({
    artifactDirectory,
    manifest,
    maxArtifacts,
    maxTotalBytes,
    retentionMs,
    nowMs,
    platform,
    writeManifestImpl,
    removeArtifactImpl,
}) => {
    const pendingCleanup = await retryPendingCleanup(artifactDirectory, manifest.pendingCleanup, removeArtifactImpl);
    const withPendingRetried = { ...manifest, pendingCleanup };
    await removeCrashLeftovers(artifactDirectory, withPendingRetried, removeArtifactImpl);
    const existing = await retainExistingArtifactDirectories(artifactDirectory, manifest.artifacts, removeArtifactImpl);
    const pendingCleanupBytes = totalEntryBytes(pendingCleanup);
    // WHY: registration passes candidate-reserved limits here. If surviving tombstones alone exceed either
    // limit, admission is impossible and must fail before pruning otherwise-valid active artifacts.
    if (pendingCleanup.length > maxArtifacts) {
        throw new Error('Feedback artifact directory capacity is exhausted by pending cleanup');
    }
    if (pendingCleanupBytes > maxTotalBytes) {
        throw new Error('Feedback artifact byte capacity is exhausted by pending cleanup');
    }
    const { retained, removed } = pruneEntries(existing, {
        maxArtifacts: Math.max(0, maxArtifacts - pendingCleanup.length),
        maxTotalBytes: Math.max(0, maxTotalBytes - pendingCleanupBytes),
        retentionMs,
        nowMs,
    });
    const nextPendingCleanup = [...pendingCleanup, ...removed];
    if (retained.length + nextPendingCleanup.length > FEEDBACK_ARTIFACT_MAX_FILES) {
        throw new Error('Feedback artifact cleanup backlog is full');
    }
    const tombstonedManifest = {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        artifacts: retained,
        pendingCleanup: nextPendingCleanup,
    };
    if (!manifestEquals(manifest, tombstonedManifest)) {
        await writeManifestImpl(artifactDirectory, tombstonedManifest, platform);
    }
    const failedRemoved = await retryPendingCleanup(artifactDirectory, removed, removeArtifactImpl);
    const nextManifest = {
        ...tombstonedManifest,
        pendingCleanup: [...pendingCleanup, ...failedRemoved],
    };
    if (!manifestEquals(tombstonedManifest, nextManifest)) {
        await writeManifestImpl(artifactDirectory, nextManifest, platform);
    }
    if (nextManifest.artifacts.length + nextManifest.pendingCleanup.length > maxArtifacts) {
        throw new Error('Feedback artifact directory capacity is exhausted by pending cleanup');
    }
    if (totalEntryBytes([...nextManifest.artifacts, ...nextManifest.pendingCleanup]) > maxTotalBytes) {
        throw new Error('Feedback artifact byte capacity is exhausted by pending cleanup');
    }
    return nextManifest;
};

/**
 * @param {{ kind: string, includeTranscript: boolean, reportBytes: Buffer, archiveBytes: Buffer }} artifact
 * @param {{ artifactDirectory?: string, maxArtifacts?: number, maxTotalBytes?: number, retentionMs?: number, now?: () => number, platform?: NodeJS.Platform, writeManifestImpl?: typeof writeManifest, removeArtifactImpl?: typeof rm, createArtifactId?: () => string }} options
 */
export const registerFeedbackArtifact = async (artifact, options = {}) => {
    const {
        artifactDirectory = FEEDBACK_ARTIFACT_DIR,
        maxArtifacts = FEEDBACK_ARTIFACT_MAX_FILES,
        maxTotalBytes = FEEDBACK_ARTIFACT_MAX_TOTAL_BYTES,
        retentionMs = FEEDBACK_ARTIFACT_RETENTION_MS,
        now = Date.now,
        platform = process.platform,
        writeManifestImpl = writeManifest,
        removeArtifactImpl = rm,
        createArtifactId = randomUUID,
    } = options;
    if (!artifact || typeof artifact !== 'object' || !FEEDBACK_KIND_SET.has(artifact.kind)) throw new RangeError('Feedback kind is invalid');
    if (typeof artifact.includeTranscript !== 'boolean') throw new TypeError('Feedback transcript inclusion must be a boolean');
    assertBytes(artifact.reportBytes, 'report', FEEDBACK_MAX_REPORT_BYTES);
    assertBytes(artifact.archiveBytes, 'archive', FEEDBACK_MAX_ARCHIVE_BYTES);
    assertPositiveInteger(maxArtifacts, 'artifact count limit');
    assertPositiveInteger(maxTotalBytes, 'artifact total byte limit');
    assertPositiveInteger(retentionMs, 'artifact retention');
    if (typeof writeManifestImpl !== 'function') throw new TypeError('Feedback manifest writer must be a function');
    if (typeof removeArtifactImpl !== 'function') throw new TypeError('Feedback artifact remover must be a function');
    if (typeof createArtifactId !== 'function') throw new TypeError('Feedback artifact ID factory must be a function');
    const nowMs = now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RangeError('Feedback artifact clock must return a non-negative safe integer');
    if (artifact.archiveBytes.length > maxTotalBytes) throw new RangeError(`Feedback archive exceeds the ${maxTotalBytes}-byte storage limit`);

    await ensurePrivateDirectory(artifactDirectory, platform);
    return withFeedbackStoreLock(artifactDirectory, async () => {
        const initialManifest = await readManifest(artifactDirectory);
        const artifactId = createArtifactId();
        if (
            !ARTIFACT_ID_PATTERN.test(artifactId) ||
            [...initialManifest.artifacts, ...initialManifest.pendingCleanup].some((entry) => entry.artifactId === artifactId)
        ) {
            throw new Error('Feedback artifact ID is invalid');
        }
        const manifest = await reconcileStoreUnlocked({
            artifactDirectory,
            manifest: initialManifest,
            // Reserve the candidate's physical directory slot and bytes before any candidate files exist.
            maxArtifacts: maxArtifacts - 1,
            maxTotalBytes: maxTotalBytes - artifact.archiveBytes.length,
            retentionMs,
            nowMs,
            platform,
            writeManifestImpl,
            removeArtifactImpl,
        });
        const pendingPath = join(artifactDirectory, `.pending-${artifactId}`);
        const finalPath = artifactPath(artifactDirectory, artifactId);
        await mkdir(pendingPath, { mode: 0o700 });
        try {
            await ensurePrivateDirectory(pendingPath, platform);
            const reportPath = join(pendingPath, 'report.md');
            const archivePath = join(pendingPath, 'feedback.zip');
            await writeFile(reportPath, artifact.reportBytes, { mode: 0o600, flag: 'wx' });
            await writeFile(archivePath, artifact.archiveBytes, { mode: 0o600, flag: 'wx' });
            await ensurePrivateFile(reportPath, platform);
            await ensurePrivateFile(archivePath, platform);
            await rename(pendingPath, finalPath);
        } catch (error) {
            await rm(pendingPath, { recursive: true, force: true }).catch(() => undefined);
            throw asNodeError(error);
        }

        const entry = {
            artifactId,
            kind: artifact.kind,
            sizeBytes: artifact.archiveBytes.length,
            sha256: sha256(artifact.archiveBytes),
            transcriptIncluded: artifact.includeTranscript,
            createdAtMs: nowMs,
        };
        const nextManifest = {
            schemaVersion: MANIFEST_SCHEMA_VERSION,
            artifacts: [...manifest.artifacts, entry],
            pendingCleanup: manifest.pendingCleanup,
        };
        try {
            await writeManifestImpl(artifactDirectory, nextManifest, platform);
        } catch (error) {
            await rm(finalPath, { recursive: true, force: true }).catch(() => undefined);
            throw asNodeError(error);
        }
        const committed = await readManifest(artifactDirectory);
        const committedEntry = committed.artifacts.find((candidate) => candidate.artifactId === artifactId);
        if (!committedEntry || !manifestEquals(committedEntry, entry)) {
            // Commit status is uncertain. Leave the candidate for the next locked reconciliation rather than
            // deleting a directory that a committed manifest may already reference.
            throw new Error('Feedback artifact was not committed');
        }
        return { ...entry, reportResource: reportResource(artifactDirectory, artifactId) };
    });
};

/**
 * @param {{ artifactId: string, expectedSize: number, expectedSha256: string }} request
 * @param {{ artifactDirectory?: string, platform?: NodeJS.Platform, retentionMs?: number, now?: () => number, writeManifestImpl?: typeof writeManifest, removeArtifactImpl?: typeof rm }} options
 */
export const loadVerifiedFeedbackArtifact = async (request, options = {}) => {
    const {
        artifactDirectory = FEEDBACK_ARTIFACT_DIR,
        platform = process.platform,
        retentionMs = FEEDBACK_ARTIFACT_RETENTION_MS,
        now = Date.now,
        writeManifestImpl = writeManifest,
        removeArtifactImpl = rm,
    } = options;
    if (!request || typeof request !== 'object' || !ARTIFACT_ID_PATTERN.test(request.artifactId)) throw new RangeError('Feedback artifact ID is invalid');
    assertPositiveInteger(request.expectedSize, 'expected size');
    if (typeof request.expectedSha256 !== 'string' || !SHA256_PATTERN.test(request.expectedSha256)) {
        throw new RangeError('Feedback expected SHA-256 is invalid');
    }
    assertPositiveInteger(retentionMs, 'artifact retention');
    if (typeof now !== 'function' || typeof writeManifestImpl !== 'function' || typeof removeArtifactImpl !== 'function') {
        throw new TypeError('Feedback artifact load dependencies are invalid');
    }
    const nowMs = now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RangeError('Feedback artifact clock must return a non-negative safe integer');
    await ensurePrivateDirectory(artifactDirectory, platform);
    return withFeedbackStoreLock(artifactDirectory, async () => {
        const manifest = await reconcileStoreUnlocked({
            artifactDirectory,
            manifest: await readManifest(artifactDirectory),
            maxArtifacts: FEEDBACK_ARTIFACT_MAX_FILES,
            maxTotalBytes: FEEDBACK_ARTIFACT_MAX_TOTAL_BYTES,
            retentionMs,
            nowMs,
            platform,
            writeManifestImpl,
            removeArtifactImpl,
        });
        const entry = manifest.artifacts.find((candidate) => candidate.artifactId === request.artifactId);
        if (!entry) throw new Error('Feedback artifact is missing or expired');
        if (request.expectedSize !== entry.sizeBytes) throw new Error('Feedback expected size does not match the artifact');
        if (request.expectedSha256 !== entry.sha256) throw new Error('Feedback expected SHA-256 does not match the artifact');

        const directory = artifactPath(artifactDirectory, entry.artifactId);
        const directoryMetadata = await lstat(directory).catch((error) => {
            if (isNotFound(error)) throw new Error('Feedback artifact is missing');
            throw error;
        });
        if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) throw new Error('Feedback artifact directory is invalid');
        const archivePath = join(directory, 'feedback.zip');
        const archiveMetadata = await lstat(archivePath).catch((error) => {
            if (isNotFound(error)) throw new Error('Feedback archive is missing');
            throw error;
        });
        if (archiveMetadata.isSymbolicLink()) throw new Error('Feedback archive symlink is rejected');
        if (!archiveMetadata.isFile()) throw new Error('Feedback archive is invalid');
        const size = (await stat(archivePath)).size;
        if (size <= 0 || size > FEEDBACK_MAX_ARCHIVE_BYTES) throw new Error('Feedback archive is invalid');
        const bytes = await readFile(archivePath);
        const actualSha256 = sha256(bytes);
        if (bytes.length !== entry.sizeBytes || bytes.length !== request.expectedSize || actualSha256 !== entry.sha256 || actualSha256 !== request.expectedSha256) {
            throw new Error('Feedback archive integrity verification failed');
        }
        return { bytes, kind: entry.kind, sizeBytes: entry.sizeBytes, sha256: entry.sha256, transcriptIncluded: entry.transcriptIncluded };
    });
};

/**
 * Removes one definitively uploaded artifact. The manifest first moves the entry into pendingCleanup so any
 * filesystem failure remains durable and ordinary maintenance can retry it.
 * @param {{ artifactId: string }} request
 * @param {{ artifactDirectory?: string, maxArtifacts?: number, platform?: NodeJS.Platform, retentionMs?: number, now?: () => number, writeManifestImpl?: typeof writeManifest, removeArtifactImpl?: typeof rm }} options
 */
export const retireFeedbackArtifact = async (request, options = {}) => {
    const {
        artifactDirectory = FEEDBACK_ARTIFACT_DIR,
        maxArtifacts = FEEDBACK_ARTIFACT_MAX_FILES,
        platform = process.platform,
        retentionMs = FEEDBACK_ARTIFACT_RETENTION_MS,
        now = Date.now,
        writeManifestImpl = writeManifest,
        removeArtifactImpl = rm,
    } = options;
    if (!request || typeof request !== 'object' || !ARTIFACT_ID_PATTERN.test(request.artifactId)) {
        throw new RangeError('Feedback artifact ID is invalid');
    }
    assertPositiveInteger(maxArtifacts, 'artifact count limit');
    assertPositiveInteger(retentionMs, 'artifact retention');
    if (typeof now !== 'function' || typeof writeManifestImpl !== 'function' || typeof removeArtifactImpl !== 'function') {
        throw new TypeError('Feedback artifact retirement dependencies are invalid');
    }
    const nowMs = now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RangeError('Feedback artifact clock must return a non-negative safe integer');
    await ensurePrivateDirectory(artifactDirectory, platform);
    return withFeedbackStoreLock(artifactDirectory, async () => {
        const manifest = await reconcileStoreUnlocked({
            artifactDirectory,
            manifest: await readManifest(artifactDirectory),
            maxArtifacts,
            maxTotalBytes: FEEDBACK_ARTIFACT_MAX_TOTAL_BYTES,
            retentionMs,
            nowMs,
            platform,
            writeManifestImpl,
            removeArtifactImpl,
        });
        const entry = manifest.artifacts.find((candidate) => candidate.artifactId === request.artifactId);
        if (!entry) {
            const pending = manifest.pendingCleanup.some((candidate) => candidate.artifactId === request.artifactId);
            let physical = false;
            try {
                await lstat(artifactPath(artifactDirectory, request.artifactId));
                physical = true;
            } catch (error) {
                if (!isNotFound(error)) throw error;
            }
            // WHY: reconciliation may have tombstoned the target before retirement acquired the lock. A
            // non-throwing no-op is complete only when neither the manifest nor disk still retains the target.
            return { retired: false, localCleanup: pending || physical ? 'pending' : 'complete' };
        }
        const pendingCleanup = [...manifest.pendingCleanup, entry];
        const tombstoned = {
            schemaVersion: MANIFEST_SCHEMA_VERSION,
            artifacts: manifest.artifacts.filter((candidate) => candidate.artifactId !== entry.artifactId),
            pendingCleanup,
        };
        if (tombstoned.artifacts.length + tombstoned.pendingCleanup.length > maxArtifacts) {
            throw new Error('Feedback artifact cleanup backlog is full');
        }
        // WHY: publish and verify the tombstone before deleting either report.md or feedback.zip. A failed
        // directory removal then remains discoverable across process death and is retried by maintenance.
        await writeManifestImpl(artifactDirectory, tombstoned, platform);
        const committed = await readManifest(artifactDirectory);
        const committedTombstone = committed.pendingCleanup.find((candidate) => candidate.artifactId === entry.artifactId);
        if (
            committed.artifacts.some((candidate) => candidate.artifactId === entry.artifactId) ||
            !committedTombstone ||
            !manifestEquals(committedTombstone, entry)
        ) {
            throw new Error('Feedback artifact retirement was not committed');
        }
        await removeArtifactImpl(artifactPath(artifactDirectory, entry.artifactId), { recursive: true, force: true });
        const retired = {
            ...committed,
            pendingCleanup: committed.pendingCleanup.filter((candidate) => candidate.artifactId !== entry.artifactId),
        };
        await writeManifestImpl(artifactDirectory, retired, platform);
        const committedRetirement = await readManifest(artifactDirectory);
        const indexed = [...committedRetirement.artifacts, ...committedRetirement.pendingCleanup]
            .some((candidate) => candidate.artifactId === entry.artifactId);
        return { retired: !indexed, localCleanup: indexed ? 'pending' : 'complete' };
    });
};

/**
 * Reconciles crash leftovers and applies retention/quota limits without preparing a new artifact.
 * @param {{ artifactDirectory?: string, maxArtifacts?: number, maxTotalBytes?: number, retentionMs?: number, now?: () => number, platform?: NodeJS.Platform, writeManifestImpl?: typeof writeManifest, removeArtifactImpl?: typeof rm }} options
 */
export const maintainFeedbackArtifacts = async (options = {}) => {
    const {
        artifactDirectory = FEEDBACK_ARTIFACT_DIR,
        maxArtifacts = FEEDBACK_ARTIFACT_MAX_FILES,
        maxTotalBytes = FEEDBACK_ARTIFACT_MAX_TOTAL_BYTES,
        retentionMs = FEEDBACK_ARTIFACT_RETENTION_MS,
        now = Date.now,
        platform = process.platform,
        writeManifestImpl = writeManifest,
        removeArtifactImpl = rm,
    } = options;
    assertPositiveInteger(maxArtifacts, 'artifact count limit');
    assertPositiveInteger(maxTotalBytes, 'artifact total byte limit');
    assertPositiveInteger(retentionMs, 'artifact retention');
    if (typeof now !== 'function' || typeof writeManifestImpl !== 'function' || typeof removeArtifactImpl !== 'function') {
        throw new TypeError('Feedback artifact maintenance dependencies are invalid');
    }
    const nowMs = now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RangeError('Feedback artifact clock must return a non-negative safe integer');
    await ensurePrivateDirectory(artifactDirectory, platform);
    await withFeedbackStoreLock(artifactDirectory, async () => {
        await reconcileStoreUnlocked({
            artifactDirectory,
            manifest: await readManifest(artifactDirectory),
            maxArtifacts,
            maxTotalBytes,
            retentionMs,
            nowMs,
            platform,
            writeManifestImpl,
            removeArtifactImpl,
        });
    });
};

/**
 * Starts one immediate and then non-overlapping periodic maintenance loop.
 * @param {{ intervalMs?: number, maintain?: () => Promise<void>, setIntervalImpl?: typeof setInterval, clearIntervalImpl?: typeof clearInterval, onError?: (error: Error) => void }} options
 */
export const startFeedbackArtifactMaintenance = (options = {}) => {
    const {
        intervalMs = FEEDBACK_MAINTENANCE_INTERVAL_MS,
        maintain = maintainFeedbackArtifacts,
        setIntervalImpl = setInterval,
        clearIntervalImpl = clearInterval,
        onError = () => undefined,
    } = options;
    if (
        !Number.isSafeInteger(intervalMs) ||
        intervalMs < 1 ||
        intervalMs > FEEDBACK_ARTIFACT_RETENTION_MS ||
        typeof maintain !== 'function' ||
        typeof setIntervalImpl !== 'function' ||
        typeof clearIntervalImpl !== 'function' ||
        typeof onError !== 'function'
    ) {
        throw new TypeError('Feedback artifact maintenance scheduler is invalid');
    }
    let running;
    let stopped = false;
    const run = () => {
        if (stopped) return Promise.resolve();
        if (running) return running;
        running = Promise.resolve()
            .then(() => maintain())
            .catch((error) => onError(asNodeError(error)))
            .finally(() => {
                running = undefined;
            });
        return running;
    };
    const ready = run();
    const timer = setIntervalImpl(run, intervalMs);
    timer?.unref?.();
    return {
        ready,
        stop: () => {
            if (stopped) return;
            stopped = true;
            clearIntervalImpl(timer);
        },
    };
};
