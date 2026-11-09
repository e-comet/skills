import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { FEEDBACK_MAX_BYTES } from '../../domain/constants/limits.const.mjs';
import { completeJsonlTail, transcriptUnavailable, truncatedTranscripts, } from '../../domain/policies/transcript-tail.policy.mjs';
import { safeFeedbackProperty } from '../../../../transport/failures/evidence.mjs';
// Compare bigint stats: NTFS file IDs exceed 2^53, and neighbouring IDs collide as numbers.
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
const readBoundedDescriptor = async (handle, size, start = 0) => {
    // WHY: the validated descriptor size freezes the consented snapshot, excluding later appends and rejecting truncation.
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, start + offset);
        if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > bytes.length - offset)
            throw transcriptUnavailable();
        if (bytesRead === 0)
            throw transcriptUnavailable();
        offset += bytesRead;
    }
    return bytes;
};
/**
 * Reads a transcript only when its path continues to resolve to the same regular file as the opened descriptor.
 */
export const readTrustedFeedbackTranscript = async (path, options = {}) => {
    const { lstatImpl = lstat, openImpl = open, maxBytes = FEEDBACK_MAX_BYTES } = options;
    if (typeof path !== 'string' || path.length === 0)
        throw transcriptUnavailable();
    let handle;
    try {
        const before = await lstatImpl(path, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink())
            throw transcriptUnavailable();
        // O_NOFOLLOW blocks replacement by a link on supported platforms; the identity checks are required where
        // that flag is unavailable or ignored (notably Windows reparse points).
        handle = await openImpl(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const descriptor = await handle.stat({ bigint: true });
        const after = await lstatImpl(path, { bigint: true });
        if (!descriptor.isFile() ||
            !after.isFile() ||
            after.isSymbolicLink() ||
            !sameFile(before, descriptor) ||
            !sameFile(descriptor, after)) {
            throw transcriptUnavailable();
        }
        const size = Number(descriptor.size);
        if (!Number.isSafeInteger(size) || size < 0)
            throw transcriptUnavailable();
        // One preceding byte distinguishes a full first record from a partial record at the
        // bounded window boundary. Positional reads never include appends beyond the snapshot.
        const start = Math.max(0, size - maxBytes - 1);
        const bytes = await readBoundedDescriptor(handle, size - start, start);
        const firstRecord = start === 0 ? 0 : bytes.indexOf(0x0a) + 1;
        const aligned = start > 0 && firstRecord === 0 ? Buffer.alloc(0) : bytes.subarray(firstRecord);
        if (start > 0)
            truncatedTranscripts.add(aligned);
        return completeJsonlTail(aligned, maxBytes);
    }
    catch (error) {
        if (safeFeedbackProperty(error, 'code') === 'TRANSCRIPT_UNAVAILABLE')
            throw error;
        throw transcriptUnavailable(error);
    }
    finally {
        await handle?.close().catch(() => undefined);
    }
};
