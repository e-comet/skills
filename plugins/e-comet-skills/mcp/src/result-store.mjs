import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RESULT_MAX_FILE_BYTES, RESULT_RETENTION_MS, RESULT_STORAGE } from './config.mjs';
import { sweepExpired } from './file-retention.mjs';
import { requireStorageTarget } from './storage-layout.mjs';

const RESULT_JOB_ID_FILE_PART_LENGTH = 128;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
// The one NDJSON grammar of this root: `<safe-job>-<uuid>.ndjson`, and that name plus `.part` while it is
// being written. Only these two spellings are ours: a `.part` of some other program in a relocated root,
// and whatever an older release left behind, are never touched.
const RESULT_FILE_PATTERN = new RegExp(`^[a-zA-Z0-9_-]{1,${RESULT_JOB_ID_FILE_PART_LENGTH}}-${UUID}\\.ndjson$`);
const RESULT_PARTIAL_PATTERN = new RegExp(`^[a-zA-Z0-9_-]{1,${RESULT_JOB_ID_FILE_PART_LENGTH}}-${UUID}\\.ndjson\\.part$`);

const safeFilePart = (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, RESULT_JOB_ID_FILE_PART_LENGTH);
const normalizeError = (error) => (error instanceof Error ? error : new Error(String(error)));
const isSweptResultName = (name, entry) => !entry.isDirectory() && (RESULT_PARTIAL_PATTERN.test(name) || RESULT_FILE_PATTERN.test(name));
const sweepResults = (directory, { retentionMs, now }) =>
    sweepExpired({ directory, ownName: isSweptResultName, retentionMs, now });
const ensurePrivateDirectory = async (directory) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(directory, 0o700);
};
const ensurePrivateFile = async (path) => {
    if (process.platform !== 'win32') await chmod(path, 0o600);
};
const clock = (now) => (typeof now === 'function' ? now : () => now);

/**
 * Sweeps exactly one root: the current results root by default, or any directory the caller names.
 * @param {{ resultDir?: string, storageTarget?: { state: string, path?: string, reason?: string }, now?: number, retentionMs?: number }} options
 * @returns {Promise<Error[]>}
 */
export const pruneResults = async ({
    resultDir = undefined,
    storageTarget = RESULT_STORAGE,
    now = Date.now(),
    retentionMs = RESULT_RETENTION_MS,
} = {}) => sweepResults(resultDir ?? requireStorageTarget(storageTarget, 'results'), { retentionMs, now });

/**
 * @param {string} jobId
 * @param {{ resultDir?: string, storageTarget?: { state: string, path?: string, reason?: string }, maxFileBytes?: number, retentionMs?: number, now?: number | (() => number) }} options
 */
export const createJobWriter = async (
    jobId,
    { resultDir = undefined, storageTarget = RESULT_STORAGE, maxFileBytes = RESULT_MAX_FILE_BYTES, retentionMs = RESULT_RETENTION_MS, now = Date.now } = {}
) => {
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
        get published() { return published; },
        get persistedBytes() { return persistedBytes; },
        append(record) {
            if (closed) return Promise.resolve();
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
                } catch (error) {
                    writeErrors.push(normalizeError(error));
                }
            });
            return writeChain;
        },
        close() {
            if (closePromise) return closePromise;
            closed = true;
            closePromise = (async () => {
                await writeChain;
                try {
                    await rename(partialPath, resultPath);
                    published = true;
                    await ensurePrivateFile(resultPath);
                } catch (error) {
                    writeErrors.push(normalizeError(error));
                }
                // Housekeeping after the response, never part of it: sweep errors stay in stderr.
                void sweepResults(resultDir, { retentionMs, now: nowMs() });
                return [...writeErrors];
            })();
            return closePromise;
        },
        async release() {
            if (released) return;
            released = true;
            await this.close();
            if (!published) await rm(partialPath, { force: true });
        },
    };
};
