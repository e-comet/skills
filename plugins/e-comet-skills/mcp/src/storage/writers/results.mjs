import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UUID_V4 } from '../../shared/values.mjs';
import { currentStorageLayout, requireStorageTarget } from '../files/layout.mjs';
import { sweepExpired } from '../files/retention.mjs';
import { RESULT_MAX_FILE_BYTES, RESULT_RETENTION_MS } from '../limits.mjs';
const RESULT_JOB_ID_FILE_PART_LENGTH = 128;
// The one NDJSON grammar of this root: `<safe-job>-<uuid>.ndjson`, and that name plus `.part` while it is
// being written. Only these two spellings are ours: a `.part` of some other program in a relocated root,
// and whatever an older release left behind, are never touched.
const RESULT_FILE_PATTERN = new RegExp(`^[a-zA-Z0-9_-]{1,${RESULT_JOB_ID_FILE_PART_LENGTH}}-${UUID_V4}\\.ndjson$`);
const RESULT_PARTIAL_PATTERN = new RegExp(`^[a-zA-Z0-9_-]{1,${RESULT_JOB_ID_FILE_PART_LENGTH}}-${UUID_V4}\\.ndjson\\.part$`);
const safeFilePart = (value) => String(value)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, RESULT_JOB_ID_FILE_PART_LENGTH);
const normalizeError = (error) => (error instanceof Error ? error : new Error(String(error)));
const isSweptResultName = (name, entry) => !entry.isDirectory() && (RESULT_PARTIAL_PATTERN.test(name) || RESULT_FILE_PATTERN.test(name));
const sweepResults = (directory, { retentionMs, now }) => sweepExpired({ directory, ownName: isSweptResultName, retentionMs, now });
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
/**
 * Sweeps exactly one root: the current results root by default, or any directory the caller names.
 */
export const pruneResults = async ({ resultDir = undefined, storageTarget = currentStorageLayout().results, now = Date.now(), retentionMs = RESULT_RETENTION_MS, } = {}) => sweepResults(resultDir ?? requireStorageTarget(storageTarget, 'results'), { retentionMs, now });
export const createJobWriter = async (jobId, { resultDir = undefined, storageTarget = currentStorageLayout().results, maxFileBytes = RESULT_MAX_FILE_BYTES, retentionMs = RESULT_RETENTION_MS, now = Date.now, } = {}) => {
    resultDir ??= requireStorageTarget(storageTarget, 'results');
    const nowMs = clock(now);
    await ensurePrivateDirectory(resultDir);
    const resultPath = join(resultDir, `${safeFilePart(jobId)}-${randomUUID()}.ndjson`);
    const partialPath = `${resultPath}.part`;
    await writeFile(partialPath, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await ensurePrivateFile(partialPath);
    const writeErrors = [];
    let writeChain = Promise.resolve();
    let persistedBytes = 0;
    let fileLimitReached = false;
    let closed = false;
    let closePromise;
    let published = false;
    let released = false;
    return {
        resultPath,
        get published() {
            return published;
        },
        get persistedBytes() {
            return persistedBytes;
        },
        append(record) {
            if (closed)
                return Promise.resolve();
            writeChain = writeChain.then(async () => {
                try {
                    const serialized = `${JSON.stringify(record)}\n`;
                    const nextBytes = Buffer.byteLength(serialized);
                    if (persistedBytes + nextBytes > maxFileBytes) {
                        if (!fileLimitReached) {
                            fileLimitReached = true;
                            writeErrors.push(new Error(`Result exceeds the ${maxFileBytes}-byte per-file limit`));
                        }
                        return;
                    }
                    await appendFile(partialPath, serialized, 'utf8');
                    persistedBytes += nextBytes;
                }
                catch (error) {
                    writeErrors.push(normalizeError(error));
                }
            });
            return writeChain;
        },
        close() {
            if (closePromise)
                return closePromise;
            closed = true;
            closePromise = (async () => {
                await writeChain;
                try {
                    await rename(partialPath, resultPath);
                    published = true;
                    await ensurePrivateFile(resultPath);
                }
                catch (error) {
                    writeErrors.push(normalizeError(error));
                }
                // Housekeeping after the response, never part of it: sweep errors stay in stderr.
                sweepResults(resultDir, { retentionMs, now: nowMs() });
                return [...writeErrors];
            })();
            return closePromise;
        },
        async release() {
            if (released)
                return;
            released = true;
            await this.close();
            if (!published)
                await rm(partialPath, { force: true });
        },
    };
};
