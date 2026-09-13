import { createHash, randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    ARTIFACT_MAX_CHUNK_BYTES,
    ARTIFACT_MAX_FILE_BYTES,
    ARTIFACT_MAX_JOB_BYTES,
    ARTIFACT_RETENTION_MS,
    ARTIFACT_STORAGE,
} from './config.mjs';
import { sweepExpired } from './file-retention.mjs';
import { requireStorageTarget } from './storage-layout.mjs';
import { assertXlsxPackage } from './xlsx-package.mjs';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
// The one XLSX grammar of this root, today's and yesterday's: `<uuid>.xlsx` on Windows,
// `<uuid>-<safe-name>` elsewhere (the safe name always ends in `.xlsx`), and that name plus `.part`
// while it is being written. Only these two spellings are ours: a `.part` of some other program in a
// relocated root, and whatever an older release left behind, are never touched.
const ARTIFACT_FILE_PATTERN = new RegExp(`^${UUID}(?:-[a-zA-Z0-9._-]{1,180})?\\.xlsx$`);
const ARTIFACT_PARTIAL_PATTERN = new RegExp(`^${UUID}(?:-[a-zA-Z0-9._-]{1,180})?\\.xlsx\\.part$`);

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
const isSweptArtifactName = (name, entry) => !entry.isDirectory() && (ARTIFACT_PARTIAL_PATTERN.test(name) || ARTIFACT_FILE_PATTERN.test(name));
const sweepArtifacts = (directory, { retentionMs, now }) =>
    sweepExpired({ directory, ownName: isSweptArtifactName, retentionMs, now });
const ensurePrivateDirectory = async (directory) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(directory, 0o700);
};
const ensurePrivateFile = async (path) => {
    if (process.platform !== 'win32') await chmod(path, 0o600);
};
const clock = (now) => (typeof now === 'function' ? now : () => now);
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
const validateLimits = ({ maxChunkBytes, maxFileBytes, maxJobBytes, retentionMs }) => {
    if (![maxChunkBytes, maxFileBytes, maxJobBytes, retentionMs].every(isPositiveSafeInteger)) {
        throw new Error('Artifact limits must be positive safe integers');
    }
};
const validateJobBudget = (jobBudget) => {
    if (typeof jobBudget !== 'object' || jobBudget === null || !Number.isSafeInteger(jobBudget.bytes) || jobBudget.bytes < 0) {
        throw new TypeError('Artifact job budget must be an object with a non-negative bytes counter');
    }
};

/**
 * Sweeps exactly one root: the current artifacts root by default, or any directory the caller names.
 * @param {{ artifactDir?: string, storageTarget?: { state: string, path?: string, reason?: string }, now?: number, retentionMs?: number }} options
 * @returns {Promise<Error[]>}
 */
export const pruneArtifacts = async ({
    artifactDir = undefined,
    storageTarget = ARTIFACT_STORAGE,
    now = Date.now(),
    retentionMs = ARTIFACT_RETENTION_MS,
} = {}) => sweepArtifacts(artifactDir ?? requireStorageTarget(storageTarget, 'marketplaceArtifacts'), { retentionMs, now });

/**
 * @param {{
 *     fileName?: string, mimeType?: string, artifactDir?: string,
 *     storageTarget?: { state: string, path?: string, reason?: string },
 *     maxChunkBytes?: number, maxFileBytes?: number, maxJobBytes?: number, jobBudget?: { bytes: number },
 *     retentionMs?: number, validateXlsx?: boolean, signal?: AbortSignal, now?: number | (() => number),
 * }} options
 */
export const createArtifactWriter = async (options = {}) => {
    const {
        fileName,
        mimeType,
        artifactDir: configuredArtifactDir,
        maxChunkBytes = ARTIFACT_MAX_CHUNK_BYTES,
        maxFileBytes = ARTIFACT_MAX_FILE_BYTES,
        maxJobBytes = ARTIFACT_MAX_JOB_BYTES,
        // One counter per call, created by the caller and shared by every writer of that call (spec
        // §4.2). A writer without one bounds only itself. Nothing outlives the call.
        jobBudget = { bytes: 0 },
        retentionMs = ARTIFACT_RETENTION_MS,
        validateXlsx = false,
        signal,
        now = Date.now,
    } = options;
    const artifactDir = configuredArtifactDir ?? requireStorageTarget(options.storageTarget ?? ARTIFACT_STORAGE, 'marketplaceArtifacts');
    if (typeof mimeType !== 'string' || mimeType.length === 0) throw new Error('Artifact MIME type is required');
    validateLimits({ maxChunkBytes, maxFileBytes, maxJobBytes, retentionMs });
    validateJobBudget(jobBudget);
    if (signal !== undefined && (typeof signal !== 'object' || typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean')) {
        throw new TypeError('Artifact writer signal must be an AbortSignal');
    }
    const nowMs = clock(now);
    let aborted = false;
    const abortReason = () => (signal?.reason instanceof Error ? signal.reason : new Error('Artifact writer is aborted'));
    const assertNotAborted = () => {
        if (!aborted && signal?.aborted !== true) return;
        aborted = true;
        throw abortReason();
    };
    assertNotAborted();
    const name = safeArtifactName(fileName);
    await ensurePrivateDirectory(artifactDir);
    assertNotAborted();
    const identity = randomUUID();
    // MSIX adds a package prefix to the real Windows path. Keep that path short for external workbook
    // viewers; the descriptive name stays in metadata.
    const artifactPath = join(artifactDir, process.platform === 'win32' ? `${identity}.xlsx` : `${identity}-${name}`);
    const partialPath = `${artifactPath}.part`;
    await writeFile(partialPath, Buffer.alloc(0), { mode: 0o600, flag: 'wx' });
    await ensurePrivateFile(partialPath);

    let writeChain = Promise.resolve();
    let nextIndex = 0;
    let byteCount = 0;
    let jobByteCount = 0;
    const hash = createHash('sha256');
    let completed = false;
    let removal;
    // Own unfinished data only: a published workbook is immutable and survives any later abort.
    const removeOwn = () => {
        removal ??= (async () => {
            if (completed) return;
            jobBudget.bytes -= jobByteCount;
            jobByteCount = 0;
            await rm(partialPath, { force: true });
            await rm(artifactPath, { force: true });
        })().catch(() => {
            // Memoize the warning with cleanup so later aborts preserve the primary error without log spam.
            console.error('STORAGE_CLEANUP_PENDING: Unfinished local workbook files could not be removed yet.');
        });
        return removal;
    };
    // Cleanup of the own unfinished file is best-effort: a leftover `.part` ages out with the next
    // sweep, and a removal failure never replaces the error the caller actually hit (spec §4.2).
    const fail = async (error) => {
        const primary = asError(error);
        aborted = true;
        await removeOwn();
        throw primary;
    };
    const assertWritable = () => {
        assertNotAborted();
        if (completed) throw new Error('Artifact writer is already complete');
    };
    const requestAbort = () => {
        if (completed) return writeChain.then(() => undefined);
        aborted = true;
        writeChain = writeChain.then(removeOwn, removeOwn);
        return writeChain;
    };
    if (signal) {
        signal.addEventListener('abort', () => { void requestAbort().catch(() => undefined); }, { once: true });
        if (signal.aborted) void requestAbort().catch(() => undefined);
    }

    return {
        appendChunk(index, base64Data) {
            writeChain = writeChain.then(async () => {
                try {
                    assertWritable();
                    if (!Number.isSafeInteger(index) || index !== nextIndex) throw new Error(`Unexpected artifact chunk index: expected ${nextIndex}`);
                    const bytes = decodeCanonicalBase64(base64Data, maxChunkBytes);
                    if (bytes.length > maxChunkBytes) throw new Error(`Artifact chunk exceeds the ${maxChunkBytes}-byte chunk limit`);
                    if (byteCount + bytes.length > maxFileBytes) throw new Error(`Artifact exceeds the ${maxFileBytes}-byte per-file limit`);
                    // Cross-writer callbacks sharing this budget are serialized by the package broker
                    // or WB export loop. Parallelizing them must revisit reservation before append.
                    if (jobBudget.bytes + bytes.length > maxJobBytes) {
                        throw new ArtifactStoreError('JOB_ARTIFACT_QUOTA_EXCEEDED', `Artifact job quota exceeds the ${maxJobBytes}-byte limit`);
                    }
                    assertNotAborted();
                    await appendFile(partialPath, bytes);
                    assertNotAborted();
                    jobBudget.bytes += bytes.length;
                    jobByteCount += bytes.length;
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
            const publication = writeChain.then(async () => {
                try {
                    assertWritable();
                    if (!Number.isSafeInteger(size) || size < 0 || size !== byteCount) throw new Error('Artifact declared size does not match written bytes');
                    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Artifact SHA-256 must be a lowercase hexadecimal digest');
                    if (hash.digest('hex') !== sha256) throw new Error('Artifact SHA-256 does not match written bytes');
                    assertNotAborted();
                    if (validateXlsx) {
                        const workbook = await readFile(partialPath);
                        assertNotAborted();
                        assertXlsxPackage(workbook, { maxFileBytes });
                    }
                    assertNotAborted();
                    await rename(partialPath, artifactPath);
                    assertNotAborted();
                    await ensurePrivateFile(artifactPath);
                    // The logical AppData path can exist only in the producer's MSIX view; external Excel needs
                    // the finalized physical path.
                    const deliveredPath = process.platform === 'win32' ? await realpath(artifactPath) : artifactPath;
                    assertNotAborted();
                    // Complete only once the caller can actually receive this workbook. A failure between the
                    // rename and here is not a publication: nobody learns the path, so the file is removed with
                    // the rest of this writer's own unfinished data and its bytes go back to the job budget.
                    // From here on the workbook is immutable and no later failure may remove it.
                    completed = true;
                    // Housekeeping after the response, never part of it: sweep errors stay in stderr.
                    // Expired files can occupy space before this publication-driven sweep; that capacity
                    // boundary is accepted in docs/local-agent-architecture.md#accepted-residuals.
                    void sweepArtifacts(artifactDir, { retentionMs, now: nowMs() });
                    return { name, path: deliveredPath, uri: pathToFileURL(deliveredPath).href, mimeType, size: byteCount, sha256 };
                } catch (error) {
                    await fail(error);
                }
            });
            // Later calls queue behind the publication whatever its outcome; the caller sees the outcome here.
            writeChain = publication.then(() => undefined, () => undefined);
            return publication;
        },
        abort() {
            return requestAbort();
        },
    };
};
