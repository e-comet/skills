import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
    RESULT_DIR,
    RESULT_ACTIVE_STALE_MS,
    RESULT_MAX_FILE_BYTES,
    RESULT_MAX_FILES,
    RESULT_MAX_TOTAL_BYTES,
    RESULT_RETENTION_MS,
} from './config.mjs';

const RESULT_JOB_ID_FILE_PART_LENGTH = 128;
const safeFilePart = (value) => value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, RESULT_JOB_ID_FILE_PART_LENGTH);

const normalizeError = (error) => (error instanceof Error ? error : new Error(String(error)));
const ACTIVE_RESULT_PREFIX = '.active-';
const ensurePrivateResultDirectory = async (resultDir) => {
    await mkdir(resultDir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
        await chmod(resultDir, 0o700);
    }
};
const ensurePrivateResultFile = async (resultPath) => {
    if (process.platform !== 'win32') {
        await chmod(resultPath, 0o600);
    }
};

export const pruneResults = async ({
    resultDir = RESULT_DIR,
    now = Date.now(),
    retentionMs = RESULT_RETENTION_MS,
    activeStaleMs = RESULT_ACTIVE_STALE_MS,
    maxTotalBytes = RESULT_MAX_TOTAL_BYTES,
    maxFiles = RESULT_MAX_FILES,
    excludePaths = [],
} = {}) => {
    const errors = [];
    const excluded = new Set(excludePaths);
    await ensurePrivateResultDirectory(resultDir);
    let entries;
    try {
        entries = await readdir(resultDir, { withFileTypes: true });
    } catch (error) {
        return [normalizeError(error)];
    }

    const files = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.ndjson')) continue;
        const path = join(resultDir, entry.name);
        try {
            await ensurePrivateResultFile(path);
            const metadata = await stat(path);
            const active = entry.name.startsWith(ACTIVE_RESULT_PREFIX);
            if (active && !excluded.has(path) && now - metadata.mtimeMs > activeStaleMs) {
                await rm(path, { force: true });
            } else if (!active && !excluded.has(path) && now - metadata.mtimeMs > retentionMs) {
                await rm(path, { force: true });
            } else if (!active) {
                files.push({ path, size: metadata.size, mtimeMs: metadata.mtimeMs });
            }
        } catch (error) {
            errors.push(normalizeError(error));
        }
    }

    files.sort((left, right) => left.mtimeMs - right.mtimeMs);
    let totalBytes = files.reduce((total, file) => total + file.size, 0);
    let totalFiles = files.length;
    for (const file of files) {
        if (totalBytes <= maxTotalBytes && totalFiles <= maxFiles) break;
        if (excluded.has(file.path)) continue;
        try {
            await rm(file.path, { force: true });
            totalBytes -= file.size;
            totalFiles -= 1;
        } catch (error) {
            errors.push(normalizeError(error));
        }
    }
    return errors;
};

export const createJobWriter = async (
    jobId,
    {
        resultDir = RESULT_DIR,
        append = appendFile,
        maxFileBytes = RESULT_MAX_FILE_BYTES,
        retentionMs = RESULT_RETENTION_MS,
        activeStaleMs = RESULT_ACTIVE_STALE_MS,
        maxTotalBytes = RESULT_MAX_TOTAL_BYTES,
        maxFiles = RESULT_MAX_FILES,
    } = {}
) => {
    await ensurePrivateResultDirectory(resultDir);
    const retentionOptions = { resultDir, retentionMs, activeStaleMs, maxTotalBytes, maxFiles };
    const writeErrors = await pruneResults(retentionOptions);
    const resultName = `${safeFilePart(jobId)}-${randomUUID()}.ndjson`;
    const resultPath = join(resultDir, resultName);
    const activeResultPath = join(resultDir, `${ACTIVE_RESULT_PREFIX}${resultName}`);
    await writeFile(activeResultPath, '', { encoding: 'utf8', mode: 0o600 });
    await ensurePrivateResultFile(activeResultPath);
    let writeChain = Promise.resolve();
    let persistedBytes = 0;
    let fileLimitReached = false;
    let closed = false;
    let closePromise;
    return {
        resultPath,
        get persistedBytes() {
            return persistedBytes;
        },
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
                    await append(activeResultPath, serialized, 'utf8');
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
                    await rename(activeResultPath, resultPath);
                    await ensurePrivateResultFile(resultPath);
                } catch (error) {
                    writeErrors.push(normalizeError(error));
                }
                writeErrors.push(...(await pruneResults({ ...retentionOptions, excludePaths: [resultPath] })));
                return [...writeErrors];
            })();
            return closePromise;
        },
    };
};
