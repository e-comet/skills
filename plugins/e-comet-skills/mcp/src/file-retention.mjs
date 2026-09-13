import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const asError = (error) => (error instanceof Error ? error : new Error(String(error)));

/**
 * Removes entries of `directory` whose name `ownName(name, dirent)` recognizes once they are older
 * than `retentionMs` (strictly older: an entry aged exactly `retentionMs` stays). Every entry, file or
 * directory, ages by its own mtime; a directory is removed, recursively, only when `recursive` is
 * true. Unrecognized names are never touched. Two passes over one directory may run at once: an entry
 * the other pass has already removed (`ENOENT`) is a normal outcome. Never rejects: individual
 * failures are returned and reported by one stderr line per pass; the next sweep tries again.
 * @param {{ directory: string, ownName: (name: string, entry: import('node:fs').Dirent) => boolean, retentionMs: number, now?: number, recursive?: boolean }} options
 * @returns {Promise<Error[]>}
 */
export const sweepExpired = async ({ directory, ownName, retentionMs, now = Date.now(), recursive = false }) => {
    const errors = [];
    let entries = [];
    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error?.code === 'ENOENT') return [];
        errors.push(asError(error));
    }
    for (const entry of entries) {
        if (!ownName(entry.name, entry)) continue;
        if (entry.isDirectory() && !recursive) continue;
        const path = join(directory, entry.name);
        try {
            if (now - (await stat(path)).mtimeMs > retentionMs) await rm(path, { force: true, recursive: entry.isDirectory() });
        } catch (error) {
            if (error?.code !== 'ENOENT') errors.push(asError(error));
        }
    }
    // One safe line per pass; paths never enter diagnostics. The next sweep tries again.
    if (errors.length > 0) console.error('STORAGE_CLEANUP_PENDING: Expired local files could not be removed yet.');
    return errors;
};
