import { createHash, randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { UUID_V4, isNonNegativeSafeInteger } from '../../shared/values.mjs';
import { currentStorageLayout, requireStorageTarget } from '../files/layout.mjs';
import { sweepExpired } from '../files/retention.mjs';
import { ARTIFACT_MAX_CHUNK_BYTES, ARTIFACT_MAX_FILE_BYTES, ARTIFACT_MAX_JOB_BYTES, ARTIFACT_RETENTION_MS } from '../limits.mjs';
import { assertXlsxPackage } from './xlsx.mjs';
// The one XLSX grammar of this root, today's and yesterday's: `<uuid>.xlsx` on Windows,
// `<uuid>-<safe-name>` elsewhere (the safe name always ends in `.xlsx`), and that name plus `.part`
// while it is being written. Only these two spellings are ours: a `.part` of some other program in a
// relocated root, and whatever an older release left behind, are never touched.
const ARTIFACT_FILE_PATTERN = new RegExp(`^${UUID_V4}(?:-[a-zA-Z0-9._-]{1,180})?\\.xlsx$`);
const ARTIFACT_PARTIAL_PATTERN = new RegExp(`^${UUID_V4}(?:-[a-zA-Z0-9._-]{1,180})?\\.xlsx\\.part$`);
const asError = (error) => (error instanceof Error ? error : new Error(String(error)));
export class ArtifactStoreError extends Error {
    constructor(code, message, options = {}) {
        super(message, options);
        this.name = 'ArtifactStoreError';
        this.code = code;
        if (options.retryable !== undefined)
            this.retryable = options.retryable === true;
    }
}
// A rejected workbook write keeps a closed class (spec 7.4): `disk` with the filesystem code, a `limit`, an `integrity`
// mismatch, or a stream in the wrong `format`. The text stays local; only the class and code leave this process.
const rejected = (artifactClass, message) => Object.assign(new Error(message), { artifactClass });
const isSweptArtifactName = (name, entry) => !entry.isDirectory() && (ARTIFACT_PARTIAL_PATTERN.test(name) || ARTIFACT_FILE_PATTERN.test(name));
const sweepArtifacts = (directory, { retentionMs, now }) => sweepExpired({ directory, ownName: isSweptArtifactName, retentionMs, now });
const ensurePrivateDirectory = async (directory) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32')
        await chmod(directory, 0o700);
};
const ensurePrivateFile = async (path) => {
    if (process.platform !== 'win32')
        await chmod(path, 0o600);
};
const clock = (now) => (typeof now === 'function' ? now : () => now);
const safeArtifactName = (fileName) => {
    if (typeof fileName !== 'string' || fileName.length === 0)
        throw new Error('Artifact file name is required');
    const sanitized = basename(fileName)
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/^\.+/, '')
        .slice(0, 180);
    const baseName = sanitized || 'artifact';
    return baseName.toLowerCase().endsWith('.xlsx') ? baseName : `${baseName}.xlsx`;
};
const decodeCanonicalBase64 = (base64Data, maxChunkBytes) => {
    if (typeof base64Data !== 'string' || base64Data.length === 0)
        throw rejected('format', 'Artifact chunk must use canonical base64');
    const maximumEncodedLength = Math.ceil(maxChunkBytes / 3) * 4;
    if (base64Data.length > maximumEncodedLength)
        throw rejected('format', `Artifact encoded chunk exceeds the ${maximumEncodedLength}-byte chunk limit`);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64Data)) {
        throw rejected('format', 'Artifact chunk must use canonical base64');
    }
    const bytes = Buffer.from(base64Data, 'base64');
    if (bytes.toString('base64') !== base64Data)
        throw rejected('format', 'Artifact chunk must use canonical base64');
    return bytes;
};
/**
 * Sweeps exactly one root: the current artifacts root by default, or any directory the caller names.
 */
export const pruneArtifacts = async ({ artifactDir = undefined, storageTarget = currentStorageLayout().marketplaceArtifacts, now = Date.now(), retentionMs = ARTIFACT_RETENTION_MS, } = {}) => sweepArtifacts(artifactDir ?? requireStorageTarget(storageTarget, 'marketplaceArtifacts'), { retentionMs, now });
export const createArtifactWriter = async (options = {}) => {
    const { fileName, mimeType, artifactDir: configuredArtifactDir, maxChunkBytes = ARTIFACT_MAX_CHUNK_BYTES, maxFileBytes = ARTIFACT_MAX_FILE_BYTES, maxJobBytes = ARTIFACT_MAX_JOB_BYTES, 
    // One counter per call, created by the caller and shared by every writer of that call (spec
    // §4.2). A writer without one bounds only itself. Nothing outlives the call.
    jobBudget = { bytes: 0 }, retentionMs = ARTIFACT_RETENTION_MS, validateXlsx = false, signal, now = Date.now, } = options;
    const artifactDir = configuredArtifactDir ??
        requireStorageTarget(options.storageTarget ?? currentStorageLayout().marketplaceArtifacts, 'marketplaceArtifacts');
    if (typeof mimeType !== 'string' || mimeType.length === 0)
        throw new Error('Artifact MIME type is required');
    const nowMs = clock(now);
    let aborted = false;
    const abortReason = () => (signal?.reason instanceof Error ? signal.reason : new Error('Artifact writer is aborted'));
    const assertNotAborted = () => {
        if (!aborted && signal?.aborted !== true)
            return;
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
            if (completed)
                return;
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
        if (completed)
            throw new Error('Artifact writer is already complete');
    };
    const requestAbort = () => {
        if (completed)
            return writeChain.then(() => undefined);
        aborted = true;
        writeChain = writeChain.then(removeOwn, removeOwn);
        return writeChain;
    };
    if (signal) {
        signal.addEventListener('abort', () => {
            requestAbort().catch(() => undefined);
        }, { once: true });
        if (signal.aborted)
            requestAbort().catch(() => undefined);
    }
    return {
        appendChunk(index, base64Data) {
            writeChain = writeChain.then(async () => {
                try {
                    assertWritable();
                    if (!Number.isSafeInteger(index) || index !== nextIndex)
                        throw rejected('format', `Unexpected artifact chunk index: expected ${nextIndex}`);
                    const bytes = decodeCanonicalBase64(base64Data, maxChunkBytes);
                    if (bytes.length > maxChunkBytes)
                        throw rejected('format', `Artifact chunk exceeds the ${maxChunkBytes}-byte chunk limit`);
                    if (byteCount + bytes.length > maxFileBytes)
                        throw rejected('limit', `Artifact exceeds the ${maxFileBytes}-byte per-file limit`);
                    // Cross-writer callbacks sharing this budget are serialized by the package broker
                    // or WB export loop. Parallelizing them must revisit reservation before append.
                    if (jobBudget.bytes + bytes.length > maxJobBytes) {
                        // The same call cannot shrink its own workbooks, so a retry of it cannot succeed.
                        throw Object.assign(new ArtifactStoreError('JOB_ARTIFACT_QUOTA_EXCEEDED', `Artifact job quota exceeds the ${maxJobBytes}-byte limit`, { retryable: false }), { artifactClass: 'limit' });
                    }
                    assertNotAborted();
                    await appendFile(partialPath, bytes);
                    assertNotAborted();
                    jobBudget.bytes += bytes.length;
                    jobByteCount += bytes.length;
                    byteCount += bytes.length;
                    hash.update(bytes);
                    nextIndex += 1;
                }
                catch (error) {
                    await fail(error);
                }
            });
            return writeChain;
        },
        complete(completion = {}) {
            const { size, sha256 } = completion;
            const publication = writeChain.then(async () => {
                try {
                    assertWritable();
                    if (!isNonNegativeSafeInteger(size) || size !== byteCount)
                        throw rejected('integrity', 'Artifact declared size does not match written bytes');
                    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256))
                        throw rejected('integrity', 'Artifact SHA-256 must be a lowercase hexadecimal digest');
                    if (hash.digest('hex') !== sha256)
                        throw rejected('integrity', 'Artifact SHA-256 does not match written bytes');
                    assertNotAborted();
                    if (validateXlsx) {
                        const workbook = await readFile(partialPath);
                        assertNotAborted();
                        try {
                            assertXlsxPackage(workbook, { maxFileBytes });
                        }
                        catch (error) {
                            throw Object.assign(asError(error), { artifactClass: 'format' });
                        }
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
                    // boundary is accepted in docs/architecture/residuals/storage.md.
                    sweepArtifacts(artifactDir, { retentionMs, now: nowMs() });
                    return { name, path: deliveredPath, uri: pathToFileURL(deliveredPath).href, mimeType, size: byteCount, sha256 };
                }
                catch (error) {
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
