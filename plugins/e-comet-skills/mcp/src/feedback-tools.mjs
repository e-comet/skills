import { constants } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { lstat, open } from 'node:fs/promises';

import { BRIDGE_VERSION, FEEDBACK_EXTENSION_LOG_MAX_BYTES, FEEDBACK_MAX_BYTES, FEEDBACK_MAX_SUMMARY_LENGTH, FEEDBACK_UPLOAD_DESTINATIONS } from './config.mjs';
import { collectFeedbackExtensionLog } from './feedback-device-evidence.mjs';
import { assertHookFields, loadHookSecret, verifyHookSignature } from './hook-signature.mjs';
import { feedbackArtifactStorageUnavailable, loadVerifiedFeedbackArtifact, registerFeedbackArtifact, retireFeedbackArtifact } from './feedback-artifact-store.mjs';
import { serializeFeedbackMetadata } from './feedback-metadata.mjs';
import { foldFeedbackLineEndings, redactFeedbackText, renderFeedbackReport } from './feedback-report.mjs';
import { extractFeedbackToolCalls } from './feedback-tool-calls.mjs';
import { createFeedbackZip, feedbackZipFramingBytes } from './feedback-zip.mjs';
import { assertUploadDestination, putFeedbackArchive } from './feedback-upload.mjs';
import { FeedbackPreparationError, feedbackSubmissionFailure } from './feedback-errors.mjs';
import { feedbackDiagnostics, safeFeedbackProperty, withFeedbackOperation } from './feedback-diagnostics.mjs';
import { diagnosticCheck } from './diagnostic-facts.mjs';
import { isPublishableObjectKey } from './tool-schemas.mjs';

// Codex runs its hooks beside this process and asks to trust them again after every plugin update. An unsigned call
// from it means its hooks did not run, so it fails closed before report_issue spends one of the few authorizations the
// service issues per hour. Claude Code is left out: an older Cowork device bridge also named itself claude-code.
const HOOKED_CLIENTS = new Set(['codex-mcp-client']);
const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;

const transcriptUnavailable = (cause) => new FeedbackPreparationError('TRANSCRIPT_UNAVAILABLE', cause);
const claimInvalid = (cause) => new FeedbackPreparationError('FEEDBACK_CLAIM_INVALID', cause);
const hookHandoffUnavailable = (cause) => new FeedbackPreparationError('FEEDBACK_HOOK_HANDOFF_UNAVAILABLE', cause);
const signatureInvalid = () => Object.assign(
    new Error('The trusted feedback handoff claim could not be verified.'),
    { code: 'FEEDBACK_CLAIM_INVALID', feedbackReason: 'claim_signature_invalid' },
);

/**
 * Verifies the fields the trusted hook injected against the shared local secret. A malformed request
 * fails as a binding mismatch before any filesystem access; only a well-formed one reads the secret.
 * @param {{ tool: string, sessionHash?: unknown, signature?: unknown, fields: Record<string, unknown> }} request
 */
const verifyHookFields = async ({ tool, sessionHash, signature, fields }) => {
    try {
        assertHookFields({ tool, sessionHash, fields });
        const secret = await loadHookSecret({ create: false });
        if (!verifyHookSignature({ secret, tool, sessionHash, fields, signature })) throw signatureInvalid();
    } catch (error) {
        throw withFeedbackOperation(error, 'claim_consume');
    }
};
const safeSummary = (summary) => {
    const text = redactFeedbackText(foldFeedbackLineEndings(summary)).toWellFormed();
    let end = Math.min(text.length, FEEDBACK_MAX_SUMMARY_LENGTH);
    if (end < text.length && /[\ud800-\udbff]/u.test(text[end - 1])) end -= 1;
    return text.slice(0, end);
};
const safeArtifactId = (artifactId) => (typeof artifactId === 'string' && ARTIFACT_ID.test(artifactId) ? artifactId : undefined);

// Compare bigint stats: NTFS file IDs exceed 2^53, and neighbouring IDs collide as numbers.
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
// Reader metadata stays process-private and does not alter the Buffer API or source bytes.
const truncatedTranscripts = new WeakSet();

const completeJsonlTail = (bytes, maxBytes) => {
    // Reports usually follow the failure immediately. Retain the latest complete physical
    // records, without interpreting host-specific branches or rewriting the consented bytes.
    const finalNewline = bytes.lastIndexOf(0x0a);
    let completeEnd = finalNewline + 1;
    const finalRecord = bytes.subarray(completeEnd);
    if (finalRecord.length > maxBytes) {
        // A bounded native read cannot retain this whole final record. Apply the same
        // boundary to injected readers without decoding/parsing an oversized suffix.
        completeEnd = bytes.length;
    } else if (finalRecord.length > 0) {
        try {
            // JSONL permits a complete final value without LF. Check only that suffix;
            // the frozen bytes stay unchanged and partial host appends remain excluded.
            JSON.parse(finalRecord.toString('utf8'));
            completeEnd = bytes.length;
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
        }
    }
    let start = 0;
    if (completeEnd > maxBytes) {
        const precedingNewline = bytes.indexOf(0x0a, completeEnd - maxBytes - 1);
        start = precedingNewline < 0 ? completeEnd : precedingNewline + 1;
    }
    const complete = bytes.subarray(start, completeEnd);
    if (start > 0 || truncatedTranscripts.has(bytes)) truncatedTranscripts.add(complete);
    // Validate every boundary, including the injected reader and budget fitting, without
    // allocating a discarded string for each potentially 32 MiB transcript buffer.
    if (!isUtf8(complete)) throw transcriptUnavailable(new TypeError('Invalid transcript UTF-8'));
    return complete;
};

const readBoundedDescriptor = async (handle, size, start = 0) => {
    // WHY: the validated descriptor size freezes the consented snapshot, excluding later appends and rejecting truncation.
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, start + offset);
        if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > bytes.length - offset) throw transcriptUnavailable();
        if (bytesRead === 0) throw transcriptUnavailable();
        offset += bytesRead;
    }
    return bytes;
};

/**
 * Reads a transcript only when its path continues to resolve to the same regular file as the opened descriptor.
 * @param {string} path
 * @param {{ lstatImpl?: typeof import('node:fs/promises').lstat, openImpl?: typeof open, maxBytes?: number }} options
 */
export const readTrustedFeedbackTranscript = async (path, options = {}) => {
    const { lstatImpl = lstat, openImpl = open, maxBytes = FEEDBACK_MAX_BYTES } = options;
    if (typeof path !== 'string' || path.length === 0) throw transcriptUnavailable();
    if (typeof lstatImpl !== 'function' || typeof openImpl !== 'function' || !Number.isSafeInteger(maxBytes) || maxBytes < 0) throw transcriptUnavailable();
    let handle;
    try {
        const before = await lstatImpl(path, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink()) throw transcriptUnavailable();
        // O_NOFOLLOW blocks replacement by a link on supported platforms; the identity checks are required where
        // that flag is unavailable or ignored (notably Windows reparse points).
        handle = await openImpl(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const descriptor = await handle.stat({ bigint: true });
        const after = await lstatImpl(path, { bigint: true });
        if (!descriptor.isFile() || !after.isFile() || after.isSymbolicLink() || !sameFile(before, descriptor) || !sameFile(descriptor, after)) {
            throw transcriptUnavailable();
        }
        const size = Number(descriptor.size);
        if (!Number.isSafeInteger(size) || size < 0) throw transcriptUnavailable();
        // One preceding byte distinguishes a full first record from a partial record at the
        // bounded window boundary. Positional reads never include appends beyond the snapshot.
        const start = Math.max(0, size - maxBytes - 1);
        const bytes = await readBoundedDescriptor(handle, size - start, start);
        const firstRecord = start === 0 ? 0 : bytes.indexOf(0x0a) + 1;
        const aligned = start > 0 && firstRecord === 0 ? Buffer.alloc(0) : bytes.subarray(firstRecord);
        if (start > 0) truncatedTranscripts.add(aligned);
        return completeJsonlTail(aligned, maxBytes);
    } catch (error) {
        if (safeFeedbackProperty(error, 'code') === 'TRANSCRIPT_UNAVAILABLE') throw error;
        throw transcriptUnavailable(error);
    } finally {
        await handle?.close().catch(() => undefined);
    }
};

/** @typedef {(input: { reportBytes: Buffer, metadataBytes: Buffer, transcriptBytes?: Buffer, extensionLogBytes?: Buffer }, options: { maxBytes: number }) => Buffer | Promise<Buffer>} FeedbackZipCreator */

/**
 * Creates and stores an immutable feedback archive. transcriptPath is injected by the trusted host hook.
 * `dependencies` is an internal composition/test seam; production supplies getBridgeStatus and readExtensionLogRows
 * and uses the validated built-in persistence, ZIP, claim, clock, and runtime metadata functions.
 * @param {{ kind?: string, summary?: string, details?: string, includeTranscript?: boolean, transcriptPath?: string, feedbackClaim?: string, feedbackSession?: string }} input
 * @param {{ getBridgeStatus?: () => unknown, registerArtifact?: typeof registerFeedbackArtifact, readTranscript?: (path: string, options: { maxBytes: number }) => Promise<Buffer>, verifySignature?: (request: { tool: string, sessionHash?: unknown, signature?: unknown, fields: Record<string, unknown> }) => unknown, createZip?: FeedbackZipCreator, now?: () => number, platform?: string, arch?: string, version?: string, maxBytes?: number, readExtensionLogRows?: () => Promise<{ rows?: unknown }>, clientName?: string }} dependencies
 */
export const prepareECometFeedback = async (input = {}, dependencies = {}) => {
    const {
        getBridgeStatus,
        registerArtifact = registerFeedbackArtifact,
        readTranscript = readTrustedFeedbackTranscript,
        verifySignature = verifyHookFields,
        createZip = createFeedbackZip,
        now = Date.now,
        platform = process.platform,
        arch = process.arch,
        version = BRIDGE_VERSION,
        maxBytes = FEEDBACK_MAX_BYTES,
        readExtensionLogRows = undefined,
        // The MCP client the host named at initialize. Cowork's device bridge names the plugin, not Claude Code.
        clientName = undefined,
    } = dependencies;
    if (typeof getBridgeStatus !== 'function' || typeof registerArtifact !== 'function' || typeof readTranscript !== 'function' || typeof verifySignature !== 'function' || typeof createZip !== 'function' || typeof now !== 'function' || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
        throw new TypeError('Feedback preparation dependencies are invalid');
    }
    const { kind, summary, details, includeTranscript, transcriptPath, feedbackClaim, feedbackSession } = input;
    // WHY: a host whose hook cannot change this call (Cowork since 2026-10-30) calls it unsigned. Such a report
    // never carries history: only a signed hook may name a transcript path, so a model cannot point this process at a
    // file. Accepted residual "Cowork reports go unsigned and without history".
    const signed = feedbackClaim !== undefined || feedbackSession !== undefined || transcriptPath !== undefined;
    if (!signed && (includeTranscript === true || HOOKED_CLIENTS.has(clientName))) throw hookHandoffUnavailable();
    const route = signed ? 'native' : 'unsigned';
    if (signed) {
        const hookFields = transcriptPath === undefined ? {} : { transcriptPath };
        try {
            // WHY: hook fields are only data until this process verifies the trusted signature over them.
            // Verifying first prevents a skipped or untrusted hook from reaching a transcript or artifact write.
            await verifySignature({ tool: 'prepare_e_comet_feedback', sessionHash: feedbackSession, signature: feedbackClaim, fields: hookFields });
        } catch (error) {
            throw claimInvalid(error);
        }
    }
    // The extension's own log for extension-log.json, read alongside the status within the evidence deadline. Raw log
    // text never enters the result below.
    const extensionLogRead = collectFeedbackExtensionLog({ readExtensionLogRows, includeTranscript: includeTranscript === true, maxBytes: FEEDBACK_EXTENSION_LOG_MAX_BYTES })
        .then((log) => log && { bytes: Buffer.from(log.text, 'utf8'), rows: log.rows, trimmed: log.trimmed });
    let diagnostics = {};
    try {
        diagnostics = await getBridgeStatus();
    } catch (error) {
        // Diagnostics are optional; reporting must remain possible during bridge failures.
        const code = safeFeedbackProperty(error, 'code');
        diagnostics = { bridgeStatusCollection: diagnosticCheck({ check: 'bridge_status_collection', state: 'failed',
            observedAt: new Date(now()).toISOString(), source: 'feedback_preparation', executionPlane: 'device',
            cause: ['EACCES', 'EPERM'].includes(code) ? 'permission_denied' : 'unknown' }) };
    }
    const atOperation = (operation, action) => {
        try { return action(); } catch (error) { throw withFeedbackOperation(error, operation); }
    };
    // Validate the authored report before transcript I/O. Reuse this report if no calls
    // are available, including hosts that cannot provide a path when history is declined.
    let reportBytes = atOperation('report_render', () => renderFeedbackReport({ kind, summary, details, diagnostics, includeTranscript, route, toolCalls: [] }));
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
            if (!Buffer.isBuffer(selected)) throw transcriptUnavailable();
            snapshot = completeJsonlTail(selected, FEEDBACK_MAX_BYTES);
            toolCallsTruncated = truncatedTranscripts.has(snapshot);
            toolCalls = extractFeedbackToolCalls(snapshot);
        } catch (error) {
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
        createdAt, version, platform, arch, transcriptIncluded, transcriptSizeBytes,
        ...(transcriptTruncated ? { transcriptTruncated: true } : {}),
        extensionLogRows: extensionLog?.rows ?? 0, extensionLogTrimmed,
    }));
    // extension-log.json follows report.md and metadata.json: a report that leaves it no room drops it whole, and the
    // history tail takes what it leaves.
    const logFraming = atOperation('archive_create', () => feedbackZipFramingBytes({ includeTranscript: transcriptIncluded, includeExtensionLog: true }));
    if (extensionLog && logFraming + reportBytes.length + serializeMetadata(0).length + extensionLog.bytes.length > maxBytes) {
        extensionLog = undefined;
        extensionLogTrimmed = true;
    }
    const extensionLogLength = extensionLog?.bytes.length ?? 0;
    const framingBytes = atOperation('archive_create', () => feedbackZipFramingBytes({ includeTranscript: transcriptIncluded, includeExtensionLog: extensionLog !== undefined }));
    let transcriptBytes;
    if (transcriptIncluded) {
        const provisionalMetadataBytes = serializeMetadata(0);
        const remaining = Math.max(0, maxBytes - framingBytes - reportBytes.length - provisionalMetadataBytes.length - extensionLogLength);
        transcriptBytes = completeJsonlTail(snapshot, remaining);
        transcriptTruncated = truncatedTranscripts.has(transcriptBytes);
    }
    const fitSourceBudget = () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const metadataBytes = serializeMetadata(transcriptBytes?.length ?? 0);
            if (transcriptBytes === undefined) return metadataBytes;
            const remaining = Math.max(0, maxBytes - framingBytes - reportBytes.length - metadataBytes.length - extensionLogLength);
            const shortened = completeJsonlTail(transcriptBytes, remaining);
            if (shortened.length === transcriptBytes.length) return metadataBytes;
            transcriptBytes = shortened;
            transcriptTruncated = truncatedTranscripts.has(transcriptBytes);
        }
        return serializeMetadata(transcriptBytes?.length ?? 0);
    };
    const metadataBytes = fitSourceBudget();
    let archiveBytes;
    try {
        archiveBytes = await createZip(
            { reportBytes, metadataBytes, ...(transcriptBytes === undefined ? {} : { transcriptBytes }), ...(extensionLog ? { extensionLogBytes: extensionLog.bytes } : {}) },
            { maxBytes },
        );
    } catch (error) {
        throw new FeedbackPreparationError('FEEDBACK_ARCHIVE_FAILED', error);
    }
    let artifact;
    try {
        // Production reaches the built-in registrar only after input and archive validation, so
        // remaining failures belong to the local persistence/capacity boundary. Arbitrary injected
        // registrar failures exist only through the internal test seam described above.
        artifact = await registerArtifact({ kind, includeTranscript, reportBytes, archiveBytes });
    } catch (error) {
        throw feedbackArtifactStorageUnavailable(error);
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

const submitError = (artifactId, status, code, message, stage, retryable, error = undefined, operation = 'submit') => ({
    ok: false,
    status,
    ...(artifactId === undefined ? {} : { artifactId }),
    error: { code, message, stage, retryable, details: feedbackDiagnostics(error, operation) },
});

const uploadFailure = (artifactId, code, error = undefined, operation = 'upload') => {
    if (code === 'UPLOAD_REJECTED') {
        return submitError(artifactId, 'rejected', code, 'The feedback archive upload was rejected.', 'upload', false, error, operation);
    }
    if (code !== 'UPLOAD_GRANT_INVALID') {
        // WHY: unknown upload failures do not prove rejection before transmission and must never invite replay.
        return submitError(artifactId, 'uncertain', 'UPLOAD_UNCERTAIN', 'The feedback archive upload outcome is uncertain.', 'upload', false, error, operation);
    }
    return submitError(artifactId, 'failed', 'UPLOAD_GRANT_INVALID', 'The feedback upload grant is invalid or has expired.', 'grant', false, error, operation === 'upload' ? 'grant_validation' : operation);
};

/**
 * Re-verifies and uploads one stored archive. Transport fields are injected by the trusted host hook.
 * @param {{ artifactId?: string, uploadUrl?: string, requiredHeaders?: Record<string, string>, objectKey?: string, expiresAt?: number | string, expectedSize?: number, expectedSha256?: string, feedbackClaim?: string, feedbackSession?: string }} input
 * @param {{ loadArtifact?: typeof loadVerifiedFeedbackArtifact, retireArtifact?: typeof retireFeedbackArtifact, upload?: typeof putFeedbackArchive, now?: () => number, verifySignature?: (request: { tool: string, sessionHash?: unknown, signature?: unknown, fields: Record<string, unknown> }) => unknown, destinations?: ReadonlyArray<{ hostname: string, pathPrefix: string }> }} dependencies
 */
const submitFeedback = async (input = {}, dependencies = {}) => {
    const { loadArtifact = loadVerifiedFeedbackArtifact, retireArtifact = retireFeedbackArtifact, upload = putFeedbackArchive, now = Date.now, verifySignature = verifyHookFields,
        destinations = FEEDBACK_UPLOAD_DESTINATIONS } = dependencies;
    const artifactId = safeArtifactId(input.artifactId);
    if (typeof loadArtifact !== 'function' || typeof retireArtifact !== 'function' || typeof upload !== 'function' || typeof now !== 'function' || typeof verifySignature !== 'function' || !Array.isArray(destinations)) {
        throw new TypeError('Feedback submission dependencies are invalid.');
    }
    if (
        artifactId !== undefined &&
        input.uploadUrl === undefined &&
        input.requiredHeaders === undefined &&
        input.objectKey === undefined &&
        input.expiresAt === undefined &&
        input.expectedSize === undefined &&
        input.expectedSha256 === undefined &&
        input.feedbackClaim === undefined &&
        input.feedbackSession === undefined
    ) {
        return submitError(artifactId, 'failed', 'FEEDBACK_HOOK_HANDOFF_UNAVAILABLE', 'The trusted e-Comet hook handoff is unavailable.', 'handoff', false, undefined, 'handoff_submit');
    }
    // Native authority is a signature. A grant the model copied (Cowork, whose hook cannot change this call) has
    // none, so only e-Comet's own storage may receive it: accepted residual "Cowork reports go unsigned and without
    // history". The model copies report_issue's expires_at as it came, an ISO time or epoch seconds.
    const signed = input.feedbackClaim !== undefined || input.feedbackSession !== undefined;
    const expiresAt = typeof input.expiresAt === 'string' ? Math.floor(Date.parse(input.expiresAt) / 1000) : input.expiresAt;
    let unsignedReportId;
    if (signed) {
        const hookFields = {
            artifactId: input.artifactId,
            uploadUrl: input.uploadUrl,
            requiredHeaders: input.requiredHeaders,
            objectKey: input.objectKey,
            expiresAt: input.expiresAt,
            expectedSize: input.expectedSize,
            expectedSha256: input.expectedSha256,
        };
        try {
            // WHY: verify before artifact reads or request creation so raw transport values never confer
            // authority. The signature covers this artifactId, so a swapped one cannot reuse another grant.
            await verifySignature({ tool: 'submit_e_comet_feedback', sessionHash: input.feedbackSession, signature: input.feedbackClaim, fields: hookFields });
        } catch (error) {
            return submitError(artifactId, 'failed', 'UPLOAD_GRANT_INVALID', 'The trusted feedback handoff claim could not be verified.', 'grant', false, error, 'claim_verification');
        }
    } else if (typeof input.uploadUrl === 'string' && URL.canParse(input.uploadUrl)) {
        // A URL the copy left out or garbled is an incomplete grant, refused below; a well-formed one must lead to e-Comet
        // storage.
        let target;
        try {
            target = assertUploadDestination(input.uploadUrl, destinations, input.requiredHeaders ?? {});
        } catch (error) {
            return submitError(artifactId, 'failed', 'UPLOAD_DESTINATION_REFUSED', 'The feedback upload destination is not an e-Comet storage location.', 'grant', false, error, 'grant_validation');
        }
        // The object the URL writes is the report's identifier, so a slip in the copied objectKey cannot misname it.
        const { pathPrefix } = destinations.find(({ hostname, pathPrefix: prefix }) => target.hostname === hostname && target.pathname.startsWith(prefix));
        try { unsignedReportId = decodeURIComponent(target.pathname.slice(pathPrefix.length)); } catch { /* a garbled escape, refused below */ }
    }
    if (
        artifactId === undefined ||
        typeof input.uploadUrl !== 'string' ||
        !input.requiredHeaders ||
        typeof input.requiredHeaders !== 'object' ||
        Array.isArray(input.requiredHeaders) ||
        typeof input.objectKey !== 'string' ||
        (!signed && (typeof unsignedReportId !== 'string' || !isPublishableObjectKey(unsignedReportId))) ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt * 1000 <= now() ||
        !Number.isSafeInteger(input.expectedSize) ||
        input.expectedSize <= 0 ||
        typeof input.expectedSha256 !== 'string' ||
        !SHA256.test(input.expectedSha256)
    ) {
        return uploadFailure(artifactId, 'UPLOAD_GRANT_INVALID');
    }
    let artifact;
    try {
        artifact = await loadArtifact({ artifactId, expectedSize: input.expectedSize, expectedSha256: input.expectedSha256 });
        if (!artifact || !Buffer.isBuffer(artifact.bytes) || artifact.bytes.length !== input.expectedSize || artifact.transcriptIncluded !== true && artifact.transcriptIncluded !== false) {
            throw new Error('invalid artifact');
        }
    } catch (error) {
        return submitError(artifactId, 'failed', 'ARTIFACT_UNAVAILABLE', 'The prepared feedback archive is unavailable.', 'artifact', false, error, 'artifact_read');
    }
    try {
        await upload({
            uploadUrl: input.uploadUrl,
            requiredHeaders: input.requiredHeaders,
            expiresAt,
            bytes: artifact.bytes,
        });
    } catch (error) {
        return uploadFailure(artifactId, safeFeedbackProperty(error, 'code'), error);
    }
    // Retirement/tombstone reconciliation is private maintenance. Storage acceptance is the only public outcome.
    await retireArtifact({ artifactId }).catch(() => undefined);
    // The object key the accepted upload wrote is the one identifier both the seller and support can name.
    // It is published only here, after acceptance: an unaccepted grant names an object that does not exist.
    return { ok: true, status: 'uploaded', artifactId, transcriptIncluded: artifact.transcriptIncluded, reportId: signed ? input.objectKey : unsignedReportId };
};

/** @type {typeof submitFeedback} */
export const submitECometFeedback = async (input = {}, dependencies = {}) => {
    try { return await submitFeedback(input, dependencies); }
    catch (error) { return feedbackSubmissionFailure(error, safeFeedbackProperty(input, 'artifactId')); }
};
