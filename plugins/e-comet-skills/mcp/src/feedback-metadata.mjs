import { FEEDBACK_MAX_BYTES } from './config.mjs';

/**
 * Serializes the bounded, closed metadata document stored in every feedback archive.
 * `extensionLogRows` counts the rows of extension-log.json (0 without the file); `extensionLogTrimmed` says rows were
 * left out to fit a limit. The file's scope follows the history choice: every row with it, connection rows without.
 * @param {{ createdAt?: string, version?: string, platform?: string, arch?: string, transcriptIncluded?: boolean, transcriptSizeBytes?: number, transcriptTruncated?: true, extensionLogRows?: number, extensionLogTrimmed?: boolean }} input
 */
export const serializeFeedbackMetadata = ({ createdAt, version, platform, arch, transcriptIncluded, transcriptSizeBytes, transcriptTruncated,
    extensionLogRows = 0, extensionLogTrimmed = false } = {}) => {
    // Production producer fields are fixed build/runtime values. The single aggregate feedback
    // package limit intentionally owns sizing instead of a second per-entry metadata limit.
    const timestamp = typeof createdAt === 'string' ? Date.parse(createdAt) : Number.NaN;
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== createdAt) throw new TypeError('Feedback metadata createdAt is invalid');
    for (const [name, value] of Object.entries({ version, platform, arch })) {
        if (typeof value !== 'string' || value.length === 0) throw new TypeError(`Feedback metadata ${name} is invalid`);
    }
    if (typeof transcriptIncluded !== 'boolean') throw new TypeError('Feedback metadata transcript inclusion is invalid');
    if (transcriptTruncated !== undefined && (transcriptTruncated !== true || !transcriptIncluded)) throw new TypeError('Feedback metadata transcript truncation is invalid');
    if (
        !Number.isSafeInteger(transcriptSizeBytes) ||
        transcriptSizeBytes < 0 ||
        transcriptSizeBytes > FEEDBACK_MAX_BYTES ||
        !transcriptIncluded && transcriptSizeBytes !== 0
    ) {
        throw new TypeError('Feedback metadata transcript size is invalid');
    }
    if (!Number.isSafeInteger(extensionLogRows) || extensionLogRows < 0 || typeof extensionLogTrimmed !== 'boolean') throw new TypeError('Feedback metadata extension log is invalid');
    const serialized = `${JSON.stringify({
        schemaVersion: 1,
        createdAt,
        producer: { component: 'e-comet-local-mcp', version, platform, arch },
        transcript: {
            included: transcriptIncluded,
            format: transcriptIncluded ? 'host-native-jsonl' : null,
            sizeBytes: transcriptSizeBytes,
            ...(transcriptTruncated === true ? { truncated: true } : {}),
        },
        extensionLog: { included: extensionLogRows > 0, rows: extensionLogRows, scope: transcriptIncluded ? 'all' : 'connection', trimmed: extensionLogTrimmed },
    })}\n`;
    return Buffer.from(serialized, 'utf8');
};
