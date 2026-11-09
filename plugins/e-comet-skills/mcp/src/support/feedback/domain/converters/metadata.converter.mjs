import { isNonNegativeSafeInteger } from '../../../../shared/values.mjs';
import { FEEDBACK_MAX_BYTES } from '../constants/limits.const.mjs';
/**
 * Serializes the bounded, closed metadata document stored in every feedback archive.
 * `extensionLogRows` counts the rows of extension-log.json (0 without the file); `extensionLogTrimmed` says rows were
 * left out to fit a limit. The file's scope follows the history choice: every row with it, connection rows without.
 * The relations between the fields are checked here.
 */
export const serializeFeedbackMetadata = ({ createdAt, version, platform, arch, transcriptIncluded, transcriptSizeBytes, transcriptTruncated, extensionLogRows = 0, extensionLogTrimmed = false, }) => {
    // Production producer fields are fixed build/runtime values. The single aggregate feedback
    // package limit intentionally owns sizing instead of a second per-entry metadata limit.
    const timestamp = Date.parse(createdAt);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== createdAt)
        throw new TypeError('Feedback metadata createdAt is invalid');
    if (transcriptTruncated && !transcriptIncluded)
        throw new TypeError('Feedback metadata transcript truncation is invalid');
    if (!isNonNegativeSafeInteger(transcriptSizeBytes) ||
        transcriptSizeBytes > FEEDBACK_MAX_BYTES ||
        (!transcriptIncluded && transcriptSizeBytes !== 0)) {
        throw new TypeError('Feedback metadata transcript size is invalid');
    }
    if (!isNonNegativeSafeInteger(extensionLogRows))
        throw new TypeError('Feedback metadata extension log is invalid');
    const serialized = `${JSON.stringify({
        schemaVersion: 1,
        createdAt,
        producer: { component: 'e-comet-local-mcp', version, platform, arch },
        transcript: {
            included: transcriptIncluded,
            format: transcriptIncluded ? 'host-native-jsonl' : null,
            sizeBytes: transcriptSizeBytes,
            ...(transcriptTruncated ? { truncated: true } : {}),
        },
        extensionLog: {
            included: extensionLogRows > 0,
            rows: extensionLogRows,
            scope: transcriptIncluded ? 'all' : 'connection',
            trimmed: extensionLogTrimmed,
        },
    })}\n`;
    return Buffer.from(serialized, 'utf8');
};
