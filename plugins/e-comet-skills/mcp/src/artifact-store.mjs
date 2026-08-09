import { createHash, randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    ARTIFACT_DIR,
    ARTIFACT_MAX_CHUNK_BYTES,
    ARTIFACT_MAX_FILE_BYTES,
    ARTIFACT_MAX_FILES,
    ARTIFACT_MAX_JOB_BYTES,
    ARTIFACT_MAX_TOTAL_BYTES,
    ARTIFACT_RETENTION_MS,
} from './config.mjs';

const defaultFileSystem = { appendFile, chmod, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile };
const jobUsage = new Map();
const activePartPaths = new Set();
const ARTIFACT_LOCK_RETRY_LIMIT = 200;
const ARTIFACT_LOCK_RETRY_DELAY_MS = 25;
const ARTIFACT_LOCK_STALE_MS = 30_000;
const ARTIFACT_PIN_REMOVE_RETRY_LIMIT = 3;
const ARTIFACT_DEFERRED_RELEASE_RETRY_LIMIT = 3;
const ARTIFACT_DEFERRED_RELEASE_RETRY_DELAY_MS = 1_000;
const TRANSIENT_ARTIFACT_PIN_REMOVE_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM']);
const RETRYABLE_ARTIFACT_RELEASE_ERRORS = new Set([...TRANSIENT_ARTIFACT_PIN_REMOVE_ERRORS, 'ARTIFACT_STORE_BUSY']);
const ARTIFACT_LOCK_OWNER_PATTERN = /^([1-9]\d{0,9})-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const asError = (error) => (error instanceof Error ? error : new Error(String(error)));
export class ArtifactStoreError extends Error {
    constructor(code, message, options = {}) {
        super(message, options);
        this.name = 'ArtifactStoreError';
        this.code = code;
        if (options.retryable !== undefined) this.retryable = options.retryable === true;
    }
}
const isPositiveSafeInteger = (value) => Number.isSafeInteger(value) && value > 0;
const ensurePrivateDirectory = async (directory, fileSystem = defaultFileSystem, platform = process.platform) => {
    await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
    if (platform !== 'win32') await fileSystem.chmod(directory, 0o700);
};
const ensurePrivateFile = async (path, fileSystem = defaultFileSystem, platform = process.platform) => {
    if (platform !== 'win32') await fileSystem.chmod(path, 0o600);
};
const safeArtifactName = (fileName) => {
    if (typeof fileName !== 'string' || fileName.length === 0) throw new Error('Artifact file name is required');
    const sanitized = basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 180);
    const baseName = sanitized || 'artifact';
    return baseName.toLowerCase().endsWith('.xlsx') ? baseName : `${baseName}.xlsx`;
};
const decodeCanonicalBase64 = (base64Data, maxChunkBytes) => {
    if (typeof base64Data !== 'string' || base64Data.length === 0) throw new Error('Artifact chunk must use canonical base64');
    const maximumEncodedLength = Math.ceil(maxChunkBytes / 3) * 4;
    if (base64Data.length > maximumEncodedLength) throw new Error(`Artifact encoded chunk exceeds the ${maximumEncodedLength}-byte chunk limit`);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64Data)) {
        throw new Error('Artifact chunk must use canonical base64');
    }
    const bytes = Buffer.from(base64Data, 'base64');
    if (bytes.toString('base64') !== base64Data) throw new Error('Artifact chunk must use canonical base64');
    return bytes;
};
const validateLimits = ({ maxChunkBytes, maxFileBytes, maxJobBytes, maxTotalBytes, maxFiles, retentionMs }) => {
    if (![maxChunkBytes, maxFileBytes, maxJobBytes, maxTotalBytes, maxFiles, retentionMs].every(isPositiveSafeInteger)) {
        throw new Error('Artifact limits must be positive safe integers');
    }
};
const acquireJob = (jobId, maxJobBytes) => {
    const usage = jobUsage.get(jobId) || {
        bytes: 0,
        writers: 0,
        maxJobBytes,
        pinGroups: new Map(),
        deferredReleaseAttempts: 0,
        releaseRetryScheduled: false,
    };
    usage.writers += 1;
    jobUsage.set(jobId, usage);
    return usage;
};
const ACTIVE_PART_PATTERN = /^\.active-([1-9]\d{0,9})-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.part$/;
const ACTIVE_ARTIFACT_PIN_PATTERN =
    /^\.active-artifact-([1-9]\d{0,9})-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pin$/;
const partOwnerPid = (name) => {
    const match = ACTIVE_PART_PATTERN.exec(name);
    if (!match) return null;
    const pid = Number(match[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
};
const artifactPinOwnerPid = (name) => {
    const match = ACTIVE_ARTIFACT_PIN_PATTERN.exec(name);
    if (!match) return null;
    const pid = Number(match[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
};
const lockOwnerPid = (name) => {
    const match = ARTIFACT_LOCK_OWNER_PATTERN.exec(name);
    if (!match) return null;
    const pid = Number(match[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
};
const defaultIsProcessAlive = (pid) => {
    if (pid === process.pid) return true;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error?.code === 'ESRCH') return false;
        return undefined;
    }
};
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const defaultScheduleDeferredRelease = (retry, delayMs) => {
    const timer = setTimeout(() => {
        void retry();
    }, delayMs);
    timer.unref();
};
// The lock must live on the same filesystem as the artifacts it guards, so callers that inject a
// `fileSystem` place the lock beside their artifact directory instead of on the real disk.
const acquireArtifactStoreLock = async (artifactDir, fileSystem = defaultFileSystem) => {
    const lockPath = join(artifactDir, '.artifact-store.lock');
    for (let attempt = 0; attempt < ARTIFACT_LOCK_RETRY_LIMIT; attempt += 1) {
        const ownerId = `${process.pid}-${randomUUID()}`;
        const candidatePath = join(artifactDir, `.artifact-store-lock-${ownerId}`);
        const candidateOwnerPath = join(candidatePath, ownerId);
        await fileSystem.mkdir(candidatePath, { mode: 0o700 });
        try {
            await fileSystem.writeFile(candidateOwnerPath, '', { flag: 'wx', mode: 0o600 });
            await fileSystem.rename(candidatePath, lockPath);
            const ownerPath = join(lockPath, ownerId);
            return async () => {
                await fileSystem.rm(ownerPath, { force: true });
                try {
                    await fileSystem.rmdir(lockPath);
                } catch (error) {
                    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error;
                }
            };
        } catch (error) {
            await fileSystem.rm(candidatePath, { recursive: true, force: true });
            if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error?.code)) throw error;
        }
        try {
            const lockMetadata = await fileSystem.stat(lockPath);
            if (Date.now() - lockMetadata.mtimeMs > ARTIFACT_LOCK_STALE_MS) {
                const ownerEntries = (await fileSystem.readdir(lockPath, { withFileTypes: true })).filter((entry) => entry.isFile());
                const ownerPids = ownerEntries.map((entry) => lockOwnerPid(entry.name)).filter((pid) => pid !== null);
                if (ownerPids.some((ownerPid) => defaultIsProcessAlive(ownerPid) !== false)) {
                    await delay(ARTIFACT_LOCK_RETRY_DELAY_MS);
                    continue;
                }
                const currentMetadata = await fileSystem.stat(lockPath);
                if (
                    currentMetadata.dev === lockMetadata.dev &&
                    currentMetadata.ino === lockMetadata.ino &&
                    currentMetadata.mtimeMs === lockMetadata.mtimeMs
                ) {
                    const stalePath = join(artifactDir, `.artifact-store-stale-lock-${process.pid}-${randomUUID()}`);
                    await fileSystem.rename(lockPath, stalePath);
                    await fileSystem.rm(stalePath, { recursive: true, force: true });
                    continue;
                }
            }
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
        await delay(ARTIFACT_LOCK_RETRY_DELAY_MS);
    }
    throw new ArtifactStoreError('ARTIFACT_STORE_BUSY', 'Artifact storage is busy; retry the export');
};
const withArtifactStoreLock = async (artifactDir, operation, fileSystem = defaultFileSystem) => {
    const release = await acquireArtifactStoreLock(artifactDir, fileSystem);
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

const removeArtifactPin = async (pinPath, fileSystem) => {
    for (let attempt = 1; attempt <= ARTIFACT_PIN_REMOVE_RETRY_LIMIT; attempt += 1) {
        try {
            await fileSystem.rm(pinPath, { force: true });
            return;
        } catch (error) {
            if (!TRANSIENT_ARTIFACT_PIN_REMOVE_ERRORS.has(error?.code) || attempt === ARTIFACT_PIN_REMOVE_RETRY_LIMIT) throw error;
            await delay(ARTIFACT_LOCK_RETRY_DELAY_MS);
        }
    }
};
const isRetryableArtifactReleaseError = (error) => RETRYABLE_ARTIFACT_RELEASE_ERRORS.has(error?.code);

const scheduleDeferredArtifactRelease = (jobId, usage, scheduleDeferredRelease) => {
    if (usage.releaseRetryScheduled || usage.deferredReleaseAttempts >= ARTIFACT_DEFERRED_RELEASE_RETRY_LIMIT) return;
    usage.releaseRetryScheduled = true;
    try {
        scheduleDeferredRelease(async () => {
            usage.releaseRetryScheduled = false;
            if (jobUsage.get(jobId) !== usage) return;
            usage.deferredReleaseAttempts += 1;
            try {
                await releaseArtifactJob(jobId, { scheduleDeferredRelease });
            } catch {
                // releaseArtifactJob schedules the next bounded retry for transient pin failures.
            }
        }, ARTIFACT_DEFERRED_RELEASE_RETRY_DELAY_MS);
    } catch {
        usage.releaseRetryScheduled = false;
    }
};

export const releaseArtifactJob = async (jobId, { scheduleDeferredRelease = defaultScheduleDeferredRelease } = {}) => {
    const usage = jobUsage.get(jobId);
    if (!usage) return false;
    if (usage.writers > 0) throw new Error('Cannot release artifact job while active artifact writers remain');
    try {
        for (const { artifactDir, fileSystem, pinPaths } of usage.pinGroups.values()) {
            await withArtifactStoreLock(
                artifactDir,
                () => Promise.all([...pinPaths].map((pinPath) => removeArtifactPin(pinPath, fileSystem))),
                fileSystem
            );
        }
    } catch (error) {
        if (isRetryableArtifactReleaseError(error)) {
            scheduleDeferredArtifactRelease(jobId, usage, scheduleDeferredRelease);
        }
        throw error;
    }
    jobUsage.delete(jobId);
    return true;
};

const pruneArtifactsUnlocked = async ({
    artifactDir = ARTIFACT_DIR,
    now = Date.now(),
    retentionMs = ARTIFACT_RETENTION_MS,
    maxTotalBytes = ARTIFACT_MAX_TOTAL_BYTES,
    maxFiles = ARTIFACT_MAX_FILES,
    excludePaths = [],
    fileSystem = defaultFileSystem,
    platform = process.platform,
    isProcessAlive = defaultIsProcessAlive,
} = {}) => {
    const errors = [];
    const protectedPaths = new Set(excludePaths);
    const fs = { ...defaultFileSystem, ...fileSystem };
    await ensurePrivateDirectory(artifactDir, fs, platform);
    let entries;
    try {
        entries = await fs.readdir(artifactDir, { withFileTypes: true });
    } catch (error) {
        return [asError(error)];
    }

    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ownerPid = artifactPinOwnerPid(entry.name);
        if (ownerPid === null) continue;
        const pinPath = join(artifactDir, entry.name);
        try {
            if ((await isProcessAlive(ownerPid)) === false) {
                await fs.rm(pinPath, { force: true });
                continue;
            }
            await ensurePrivateFile(pinPath, fs, platform);
            const artifactName = await fs.readFile(pinPath, 'utf8');
            if (basename(artifactName) !== artifactName || !artifactName.endsWith('.xlsx')) {
                throw new Error(`Artifact pin ${entry.name} contains an invalid artifact name`);
            }
            protectedPaths.add(join(artifactDir, artifactName));
        } catch (error) {
            errors.push(asError(error));
        }
    }
    if (errors.length > 0) return errors;

    const completed = [];
    let retainedPartBytes = 0;
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const path = join(artifactDir, entry.name);
        if (entry.name.endsWith('.part')) {
            try {
                const metadata = await fs.stat(path);
                let removed = false;
                if (!protectedPaths.has(path) && !activePartPaths.has(path) && now - metadata.mtimeMs > retentionMs) {
                    const ownerPid = partOwnerPid(entry.name);
                    if (ownerPid !== null && (await isProcessAlive(ownerPid)) === false) {
                        await fs.rm(path, { force: true });
                        removed = true;
                    }
                }
                if (!removed) {
                    retainedPartBytes += metadata.size;
                }
            } catch (error) {
                errors.push(asError(error));
            }
            continue;
        }
        if (!entry.name.endsWith('.xlsx')) continue;
        try {
            await ensurePrivateFile(path, fs, platform);
            const metadata = await fs.stat(path);
            if (!protectedPaths.has(path) && now - metadata.mtimeMs > retentionMs) {
                await fs.rm(path, { force: true });
            } else {
                completed.push({ path, size: metadata.size, mtimeMs: metadata.mtimeMs });
            }
        } catch (error) {
            errors.push(asError(error));
        }
    }

    completed.sort((left, right) => left.mtimeMs - right.mtimeMs);
    let totalBytes = retainedPartBytes + completed.reduce((total, artifact) => total + artifact.size, 0);
    let totalFiles = completed.length;
    for (const artifact of completed) {
        if (totalBytes <= maxTotalBytes && totalFiles <= maxFiles) break;
        if (protectedPaths.has(artifact.path)) continue;
        try {
            await fs.rm(artifact.path, { force: true });
            totalBytes -= artifact.size;
            totalFiles -= 1;
        } catch (error) {
            errors.push(asError(error));
        }
    }
    return errors;
};

export const pruneArtifacts = async (options = {}) => {
    const artifactDir = options.artifactDir ?? ARTIFACT_DIR;
    const fs = { ...defaultFileSystem, ...(options.fileSystem ?? {}) };
    const platform = options.platform ?? process.platform;
    await ensurePrivateDirectory(artifactDir, fs, platform);
    return withArtifactStoreLock(artifactDir, () => pruneArtifactsUnlocked(options), fs);
};

const artifactTotalBytes = async (artifactDir, fs) => {
    let totalBytes = 0;
    for (const entry of await fs.readdir(artifactDir, { withFileTypes: true })) {
        if (!entry.isFile() || (!entry.name.endsWith('.xlsx') && !entry.name.endsWith('.part'))) continue;
        totalBytes += (await fs.stat(join(artifactDir, entry.name))).size;
    }
    return totalBytes;
};

const artifactCompletedFileCount = async (artifactDir, fs) =>
    (await fs.readdir(artifactDir, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.xlsx')).length;

/**
 * @param {{
 *     jobId?: string,
 *     fileName?: string,
 *     mimeType?: string,
 *     artifactDir?: string,
 *     maxChunkBytes?: number,
 *     maxFileBytes?: number,
 *     maxJobBytes?: number,
 *     maxTotalBytes?: number,
 *     maxFiles?: number,
 *     retentionMs?: number,
 *     fileSystem?: Partial<typeof defaultFileSystem>,
 *     platform?: NodeJS.Platform,
 * }} options
 */
export const createArtifactWriter = async (options = {}) => {
    const {
        jobId,
        fileName,
        mimeType,
        artifactDir = ARTIFACT_DIR,
        maxChunkBytes = ARTIFACT_MAX_CHUNK_BYTES,
        maxFileBytes = ARTIFACT_MAX_FILE_BYTES,
        maxJobBytes = ARTIFACT_MAX_JOB_BYTES,
        maxTotalBytes = ARTIFACT_MAX_TOTAL_BYTES,
        maxFiles = ARTIFACT_MAX_FILES,
        retentionMs = ARTIFACT_RETENTION_MS,
        fileSystem = {},
        platform = process.platform,
    } = options;
    if (typeof jobId !== 'string' || jobId.length === 0) throw new Error('Artifact job ID is required');
    if (typeof mimeType !== 'string' || mimeType.length === 0) throw new Error('Artifact MIME type is required');
    validateLimits({ maxChunkBytes, maxFileBytes, maxJobBytes, maxTotalBytes, maxFiles, retentionMs });
    const name = safeArtifactName(fileName);
    const usage = acquireJob(jobId, maxJobBytes);
    const fs = { ...defaultFileSystem, ...fileSystem };
    const identity = randomUUID();
    const partialPath = join(artifactDir, `.active-${process.pid}-${identity}.part`);
    const artifactPath = join(artifactDir, `${identity}-${name}`);
    const pinPath = join(artifactDir, `.active-artifact-${process.pid}-${identity}.pin`);
    try {
        await ensurePrivateDirectory(artifactDir, fs, platform);
        await withArtifactStoreLock(artifactDir, async () => {
            const pruneErrors = await pruneArtifactsUnlocked({ artifactDir, retentionMs, maxTotalBytes, maxFiles, fileSystem: fs, platform });
            if (pruneErrors.length > 0) throw new Error(`Unable to prune artifact storage: ${pruneErrors[0].message}`);
            await fs.writeFile(partialPath, Buffer.alloc(0), { mode: 0o600, flag: 'wx' });
            await ensurePrivateFile(partialPath, fs, platform);
        }, fs);
    } catch (error) {
        usage.writers -= 1;
        try {
            await fs.rm(partialPath, { force: true });
        } catch (cleanupError) {
            throw new AggregateError([asError(error), asError(cleanupError)], 'Artifact writer setup failed and cleanup failed');
        }
        throw asError(error);
    }
    activePartPaths.add(partialPath);

    /** @type {Promise<unknown>} */
    let writeChain = Promise.resolve();
    let nextIndex = 0;
    let byteCount = 0;
    const hash = createHash('sha256');
    let aborted = false;
    let completed = false;
    let writerClosed = false;
    const closeWriter = ({ discardBytes }) => {
        if (writerClosed) return;
        if (discardBytes) usage.bytes -= byteCount;
        usage.writers -= 1;
        writerClosed = true;
    };
    const cleanupPaths = async () => {
        const cleanup = await withArtifactStoreLock(artifactDir, async () => {
            activePartPaths.delete(partialPath);
            return Promise.allSettled([
                fs.rm(partialPath, { force: true }),
                fs.rm(artifactPath, { force: true }),
                fs.rm(pinPath, { force: true }),
            ]);
        }, fs);
        const rejected = cleanup.find((result) => result.status === 'rejected');
        if (rejected?.status === 'rejected') throw rejected.reason;
    };
    const abortInternal = async () => {
        if (completed || aborted) return;
        aborted = true;
        closeWriter({ discardBytes: true });
        await cleanupPaths();
    };
    const fail = async (error) => {
        const primaryError = asError(error);
        try {
            await abortInternal();
        } catch (cleanupError) {
            const aggregate = new AggregateError([primaryError, asError(cleanupError)], 'Artifact storage failed and cleanup failed');
            if (primaryError instanceof ArtifactStoreError) Object.assign(aggregate, { code: primaryError.code });
            throw aggregate;
        }
        throw primaryError;
    };
    const assertWritable = () => {
        if (aborted) throw new Error('Artifact writer is aborted');
        if (completed) throw new Error('Artifact writer is already complete');
    };

    return {
        appendChunk(index, base64Data) {
            writeChain = writeChain.then(async () => {
                try {
                    assertWritable();
                    if (!Number.isSafeInteger(index) || index !== nextIndex) throw new Error(`Unexpected artifact chunk index: expected ${nextIndex}`);
                    const bytes = decodeCanonicalBase64(base64Data, maxChunkBytes);
                    if (bytes.length > maxChunkBytes) throw new Error(`Artifact chunk exceeds the ${maxChunkBytes}-byte chunk limit`);
                    if (byteCount + bytes.length > maxFileBytes) throw new Error(`Artifact exceeds the ${maxFileBytes}-byte per-file limit`);
                    if (usage.bytes + bytes.length > usage.maxJobBytes) {
                        throw new ArtifactStoreError(
                            'JOB_ARTIFACT_QUOTA_EXCEEDED',
                            `Artifact job quota exceeds the ${usage.maxJobBytes}-byte limit`
                        );
                    }
                    await withArtifactStoreLock(artifactDir, async () => {
                        // Measured fresh under the lock on every chunk. Carrying a per-writer running total
                        // instead would let a concurrent process's writes go unseen, so this writer could
                        // keep appending past the shared quota by as much as its own remaining file.
                        let totalBytes = await artifactTotalBytes(artifactDir, fs);
                        if (totalBytes + bytes.length > maxTotalBytes) {
                            await pruneArtifactsUnlocked({
                                artifactDir,
                                retentionMs,
                                maxTotalBytes: maxTotalBytes - bytes.length,
                                maxFiles,
                                excludePaths: [partialPath, artifactPath],
                                fileSystem: fs,
                                platform,
                            });
                            totalBytes = await artifactTotalBytes(artifactDir, fs);
                        }
                        if (totalBytes + bytes.length > maxTotalBytes) {
                            throw new ArtifactStoreError(
                                'ARTIFACT_TOTAL_QUOTA_EXCEEDED',
                                `Artifact storage quota exceeds the ${maxTotalBytes}-byte limit`
                            );
                        }
                        usage.bytes += bytes.length;
                        try {
                            await fs.appendFile(partialPath, bytes);
                        } catch (error) {
                            usage.bytes -= bytes.length;
                            throw error;
                        }
                    }, fs);
                    byteCount += bytes.length;
                    hash.update(bytes);
                    nextIndex += 1;
                } catch (error) {
                    await fail(error);
                }
            });
            return writeChain;
        },
        /** @param {{ size?: number, sha256?: string }} completion */
        complete(completion = {}) {
            const { size, sha256 } = completion;
            writeChain = writeChain.then(async () => {
                try {
                    assertWritable();
                    if (!Number.isSafeInteger(size) || size < 0 || size !== byteCount) throw new Error('Artifact declared size does not match written bytes');
                    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Artifact SHA-256 must be a lowercase hexadecimal digest');
                    if (hash.digest('hex') !== sha256) throw new Error('Artifact SHA-256 does not match written bytes');
                    await withArtifactStoreLock(artifactDir, async () => {
                        await fs.rename(partialPath, artifactPath);
                        activePartPaths.delete(partialPath);
                        await ensurePrivateFile(artifactPath, fs, platform);
                        await fs.writeFile(pinPath, basename(artifactPath), { mode: 0o600, flag: 'wx' });
                        await ensurePrivateFile(pinPath, fs, platform);
                        const pruneErrorsAfterPublish = await pruneArtifactsUnlocked({
                            artifactDir,
                            retentionMs,
                            maxTotalBytes,
                            maxFiles,
                            excludePaths: [artifactPath],
                            fileSystem: fs,
                            platform,
                        });
                        if (pruneErrorsAfterPublish.length > 0) throw new Error(`Unable to prune artifact storage: ${pruneErrorsAfterPublish[0].message}`);
                        if ((await artifactCompletedFileCount(artifactDir, fs)) > maxFiles) {
                            throw new ArtifactStoreError(
                                'ARTIFACT_FILE_QUOTA_EXCEEDED',
                                `Artifact storage quota exceeds the ${maxFiles}-file limit`,
                                { retryable: true }
                            );
                        }
                    }, fs);
                    let pinGroup = usage.pinGroups.get(artifactDir);
                    if (!pinGroup) {
                        pinGroup = { artifactDir, fileSystem: fs, pinPaths: new Set() };
                        usage.pinGroups.set(artifactDir, pinGroup);
                    }
                    pinGroup.pinPaths.add(pinPath);
                    completed = true;
                    closeWriter({ discardBytes: false });
                    return { name, path: artifactPath, uri: pathToFileURL(artifactPath).href, mimeType, size: byteCount, sha256 };
                } catch (error) {
                    if (completed) {
                        completed = false;
                        writerClosed = false;
                        usage.writers += 1;
                    }
                    await fail(error);
                }
            });
            return writeChain;
        },
        abort() {
            writeChain = writeChain.then(
                () => abortInternal(),
                () => abortInternal()
            );
            return writeChain;
        },
    };
};
