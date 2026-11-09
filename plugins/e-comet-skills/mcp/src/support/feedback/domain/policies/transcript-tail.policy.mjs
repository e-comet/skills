import { isUtf8 } from 'node:buffer';
import { FeedbackPreparationError } from '../converters/errors.converter.mjs';
export const transcriptUnavailable = (cause) => new FeedbackPreparationError('TRANSCRIPT_UNAVAILABLE', cause);
// Reader metadata stays process-private and does not alter the Buffer API or source bytes.
export const truncatedTranscripts = new WeakSet();
export const completeJsonlTail = (bytes, maxBytes) => {
    // Reports usually follow the failure immediately. Retain the latest complete physical
    // records, without interpreting host-specific branches or rewriting the consented bytes.
    const finalNewline = bytes.lastIndexOf(0x0a);
    let completeEnd = finalNewline + 1;
    const finalRecord = bytes.subarray(completeEnd);
    if (finalRecord.length > maxBytes) {
        // A bounded native read cannot retain this whole final record. Apply the same
        // boundary to injected readers without decoding/parsing an oversized suffix.
        completeEnd = bytes.length;
    }
    else if (finalRecord.length > 0) {
        try {
            // JSONL permits a complete final value without LF. Check only that suffix;
            // the frozen bytes stay unchanged and partial host appends remain excluded.
            JSON.parse(finalRecord.toString('utf8'));
            completeEnd = bytes.length;
        }
        catch (error) {
            if (!(error instanceof SyntaxError))
                throw error;
        }
    }
    let start = 0;
    if (completeEnd > maxBytes) {
        const precedingNewline = bytes.indexOf(0x0a, completeEnd - maxBytes - 1);
        start = precedingNewline < 0 ? completeEnd : precedingNewline + 1;
    }
    const complete = bytes.subarray(start, completeEnd);
    if (start > 0 || truncatedTranscripts.has(bytes))
        truncatedTranscripts.add(complete);
    // Validate every boundary, including the injected reader and budget fitting, without
    // allocating a discarded string for each potentially 32 MiB transcript buffer.
    if (!isUtf8(complete))
        throw transcriptUnavailable(new TypeError('Invalid transcript UTF-8'));
    return complete;
};
