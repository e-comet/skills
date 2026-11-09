import { collectFeedbackExtensionLog } from './evidence.mjs';
import { FEEDBACK_EXTENSION_LOG_MAX_BYTES, FEEDBACK_MAX_BYTES, FEEDBACK_MAX_SUMMARY_LENGTH, } from '../domain/constants/limits.const.mjs';
import { FeedbackPreparationError } from '../domain/converters/errors.converter.mjs';
import { serializeFeedbackMetadata } from '../domain/converters/metadata.converter.mjs';
import { foldFeedbackLineEndings, redactFeedbackText, renderFeedbackReport, } from '../domain/converters/report.converter.mjs';
import { completeJsonlTail, transcriptUnavailable, truncatedTranscripts, } from '../domain/policies/transcript-tail.policy.mjs';
import { diagnosticCheck } from '../../../transport/diagnostics/vocabulary.mjs';
import { safeFeedbackProperty, withFeedbackOperation } from '../../../transport/failures/evidence.mjs';
const safeSummary = (summary) => {
    const text = redactFeedbackText(foldFeedbackLineEndings(summary)).toWellFormed();
    let end = Math.min(text.length, FEEDBACK_MAX_SUMMARY_LENGTH);
    if (end < text.length && /[\ud800-\udbff]/u.test(text[end - 1] ?? ''))
        end -= 1;
    return text.slice(0, end);
};
/**
 * Creates and stores an immutable feedback archive. transcriptPath is injected by the trusted host hook; `route` is the
 * one the MCP tool verified (in/mcp/routes).
 * `dependencies` is an internal composition/test seam; production supplies getBridgeStatus and readExtensionLogRows
 * and uses the validated built-in persistence, ZIP, claim, clock, and runtime metadata functions, which the composition
 * root passes as `adapters`.
 */
// Parse boundary: the call's arguments, already checked against the tool's input schema.
export const prepareFeedback = async (input = {}, dependencies, adapters, route) => {
    const { getBridgeStatus, registerArtifact = adapters.registerArtifact, readTranscript = adapters.readTranscript, createZip = adapters.createZip, now = Date.now, platform = process.platform, arch = process.arch, version, maxBytes = FEEDBACK_MAX_BYTES, readExtensionLogRows = undefined, } = dependencies;
    if (getBridgeStatus === undefined)
        throw new TypeError('Feedback preparation dependencies are invalid');
    const { kind, summary, details, includeTranscript, transcriptPath } = input;
    // The extension's own log for extension-log.json, read alongside the status within the evidence deadline. Raw log
    // text never enters the result below.
    const extensionLogRead = collectFeedbackExtensionLog({
        readExtensionLogRows,
        includeTranscript: includeTranscript === true,
        maxBytes: FEEDBACK_EXTENSION_LOG_MAX_BYTES,
    }).then((log) => log && { bytes: Buffer.from(log.text, 'utf8'), rows: log.rows, trimmed: log.trimmed });
    let diagnostics = {};
    try {
        diagnostics = await getBridgeStatus();
    }
    catch (error) {
        // Diagnostics are optional; reporting must remain possible during bridge failures.
        const code = safeFeedbackProperty(error, 'code');
        diagnostics = {
            bridgeStatusCollection: diagnosticCheck({
                check: 'bridge_status_collection',
                state: 'failed',
                observedAt: new Date(now()).toISOString(),
                source: 'feedback_preparation',
                executionPlane: 'device',
                cause: ['EACCES', 'EPERM'].includes(code) ? 'permission_denied' : 'unknown',
            }),
        };
    }
    const atOperation = (operation, action) => {
        try {
            return action();
        }
        catch (error) {
            throw withFeedbackOperation(error, operation);
        }
    };
    // Validate the authored report before transcript I/O. Reuse this report if no calls
    // are available, including hosts that cannot provide a path when history is declined.
    let reportBytes = atOperation('report_render', () => renderFeedbackReport({ kind, summary, details, diagnostics, includeTranscript, route, toolCalls: [] }));
    // The render above already refused a kind or summary that is not a string.
    if (typeof kind !== 'string' || typeof summary !== 'string')
        throw new FeedbackPreparationError('FEEDBACK_INPUT_INVALID');
    let snapshot;
    if (transcriptPath !== undefined || includeTranscript === true) {
        let toolCalls;
        let toolCallsTruncated;
        try {
            // One bounded read serves both the diagnostic tool names and the optional raw history.
            // The shared package budget is the most any archive can carry, so a host session larger
            // than it yields its newest complete records instead of loading and decoding a snapshot
            // that no archive could hold. Extraction stays inside this boundary: every failure on
            // the transcript path, including decoding, belongs to the transcript category.
            const selected = await readTranscript(transcriptPath, { maxBytes: FEEDBACK_MAX_BYTES });
            if (!Buffer.isBuffer(selected))
                throw transcriptUnavailable();
            snapshot = completeJsonlTail(selected, FEEDBACK_MAX_BYTES);
            toolCallsTruncated = truncatedTranscripts.has(snapshot);
            toolCalls = adapters.extractToolCalls(snapshot);
        }
        catch (error) {
            throw transcriptUnavailable(error);
        }
        // The per-archive budget applies only afterwards, when raw history is selected.
        if (toolCalls.length > 0 || toolCallsTruncated) {
            reportBytes = atOperation('report_render', () => renderFeedbackReport({ kind, summary, details, diagnostics, includeTranscript, route, toolCalls, toolCallsTruncated }));
        }
    }
    const createdAt = atOperation('metadata_encode', () => new Date(now()).toISOString());
    const transcriptIncluded = includeTranscript === true;
    let transcriptTruncated = false;
    let extensionLog = await extensionLogRead;
    let extensionLogTrimmed = extensionLog?.trimmed === true;
    const serializeMetadata = (transcriptSizeBytes) => atOperation('metadata_encode', () => serializeFeedbackMetadata({
        createdAt,
        version,
        platform,
        arch,
        transcriptIncluded,
        transcriptSizeBytes,
        ...(transcriptTruncated ? { transcriptTruncated: true } : {}),
        extensionLogRows: extensionLog?.rows ?? 0,
        extensionLogTrimmed,
    }));
    // extension-log.json follows report.md and metadata.json: a report that leaves it no room drops it whole, and the
    // history tail takes what it leaves.
    const logFraming = atOperation('archive_create', () => adapters.archiveFramingBytes({ includeTranscript: transcriptIncluded, includeExtensionLog: true }));
    if (extensionLog && logFraming + reportBytes.length + serializeMetadata(0).length + extensionLog.bytes.length > maxBytes) {
        extensionLog = undefined;
        extensionLogTrimmed = true;
    }
    const extensionLogLength = extensionLog?.bytes.length ?? 0;
    const framingBytes = atOperation('archive_create', () => adapters.archiveFramingBytes({ includeTranscript: transcriptIncluded, includeExtensionLog: extensionLog !== undefined }));
    let transcriptBytes;
    if (transcriptIncluded) {
        const provisionalMetadataBytes = serializeMetadata(0);
        const remaining = Math.max(0, maxBytes - framingBytes - reportBytes.length - provisionalMetadataBytes.length - extensionLogLength);
        // The history was read above whenever it is included.
        if (snapshot === undefined)
            throw transcriptUnavailable();
        transcriptBytes = completeJsonlTail(snapshot, remaining);
        transcriptTruncated = truncatedTranscripts.has(transcriptBytes);
    }
    const fitSourceBudget = () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const metadataBytes = serializeMetadata(transcriptBytes?.length ?? 0);
            if (transcriptBytes === undefined)
                return metadataBytes;
            const remaining = Math.max(0, maxBytes - framingBytes - reportBytes.length - metadataBytes.length - extensionLogLength);
            const shortened = completeJsonlTail(transcriptBytes, remaining);
            if (shortened.length === transcriptBytes.length)
                return metadataBytes;
            transcriptBytes = shortened;
            transcriptTruncated = truncatedTranscripts.has(transcriptBytes);
        }
        return serializeMetadata(transcriptBytes?.length ?? 0);
    };
    const metadataBytes = fitSourceBudget();
    let archiveBytes;
    try {
        archiveBytes = await createZip({
            reportBytes,
            metadataBytes,
            ...(transcriptBytes === undefined ? {} : { transcriptBytes }),
            ...(extensionLog ? { extensionLogBytes: extensionLog.bytes } : {}),
        }, { maxBytes });
    }
    catch (error) {
        throw new FeedbackPreparationError('FEEDBACK_ARCHIVE_FAILED', error);
    }
    let artifact;
    try {
        // Production reaches the built-in registrar only after input and archive validation, so
        // remaining failures belong to the local persistence/capacity boundary. Arbitrary injected
        // registrar failures exist only through the internal test seam described above.
        artifact = await registerArtifact({ kind, includeTranscript, reportBytes, archiveBytes });
    }
    catch (error) {
        throw adapters.storageUnavailable(error);
    }
    return atOperation('prepare_result', () => {
        const prepared = {
            ok: true,
            status: 'prepared',
            artifactId: artifact.artifactId,
            kind,
            sizeBytes: artifact.sizeBytes,
            sha256: artifact.sha256,
            transcriptIncluded: artifact.transcriptIncluded,
            summary: safeSummary(summary),
        };
        // The report is available to the MCP renderer as a local resource, but never becomes model-visible
        // structured data (and therefore cannot carry a local path into the report payload).
        Object.defineProperty(prepared, 'reportResource', { value: artifact.reportResource });
        return prepared;
    });
};
// The preparation's closed outcome: the failure kind follows the error's code.
const PREPARATION_KINDS = {
    FEEDBACK_INPUT_INVALID: 'input_invalid',
    FEEDBACK_HOOK_HANDOFF_UNAVAILABLE: 'handoff_unavailable',
    FEEDBACK_CLAIM_INVALID: 'claim_invalid',
    TRANSCRIPT_UNAVAILABLE: 'transcript_unavailable',
    FEEDBACK_ARCHIVE_FAILED: 'archive_failed',
    FEEDBACK_STORAGE_UNAVAILABLE: 'storage_unavailable',
};
export const preparationOutcome = (error) => {
    const code = safeFeedbackProperty(error, 'code');
    return {
        kind: (typeof code === 'string' && Object.hasOwn(PREPARATION_KINDS, code) ? PREPARATION_KINDS[code] : undefined) ??
            'preparation_failed',
        error,
    };
};
// Parse boundary: the call's arguments, already checked against the tool's input schema.
export const prepareOutcome = async (input, dependencies, adapters, route) => {
    try {
        return { kind: 'prepared', prepared: await prepareFeedback(input, dependencies, adapters, route) };
    }
    catch (error) {
        return preparationOutcome(error);
    }
};
