import { ToolExecutionError } from '../../shared/coded-error.mjs';
import { fieldOf, isUnknownArray } from '../../shared/values.mjs';
import { SELLER_OPERATION_STAGES } from '../../transport/extension/wire.mjs';
import { LOCAL_STORAGE_MESSAGES, artifactFailureDetails, artifactFailureMessage, closedFailureDetails, } from '../../transport/failures/vocabulary.mjs';
import { validateAuthorizedJobLimits } from './job-limits.mjs';
import { MAX_CONSECUTIVE_SELLER_EXPORT_FAILURES, MAX_CONSECUTIVE_SELLER_POLL_FAILURES, MIN_SELLER_OPERATION_AGENT_INTERVAL_MS, MAX_SELLER_REVIEW_DOWNLOAD_ATTEMPTS, MAX_SELLER_REVIEW_POLLS_PER_REPORT, SELLER_DOWNLOAD_TIMEOUT_MS, SELLER_JOB_MAX_DURATION_MS, } from '../domain/constants/limits.const.mjs';
const SELLER_XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SELLER_ABORT_CODES = new Set([
    'SELLER_LOGIN_REQUIRED',
    'SELLER_AUTH_UNAVAILABLE',
    'SELLER_STATE_UNAVAILABLE',
    // Raised before the create request ever reaches the page, so every remaining export would fail the
    // same way: abort the package instead of re-driving cabinet activation once per export.
    'SELLER_PORT_UNAVAILABLE',
    'ENTITY_CATALOG_UNAVAILABLE',
    'ENTITY_SELECTION_REQUIRED',
    'ENTITY_NOT_AVAILABLE',
    'BROWSER_JOB_REAUTHORIZATION_REQUIRED',
    'JOB_ARTIFACT_QUOTA_EXCEEDED',
    // The cabinet itself refused us. Every remaining export would be refused the same way under the
    // same seller token, so the package stops instead of proving it once per export. Deliberately not
    // routed through AUTHORIZATION_FETCH_ERROR_CODES: stage `authorization` would abort too, but it
    // also puts the code on the re-authorization path, and re-signing the browser job token cannot
    // revive a dead cabinet session.
    'SELLER_CABINET_UNAUTHORIZED',
    'SELLER_CABINET_RATE_LIMITED',
    // The extension admission floor. A correct agent pacing above it never trips it, so a trip means
    // this job is sending faster than the trust boundary allows and retrying would only hit the same
    // rejection.
    'SELLER_OPERATION_RATE_LIMITED',
]);
const normalizeSellerExports = (exports) => exports.flatMap((sellerExport) => {
    const base = {
        ...(sellerExport.product_id === undefined ? {} : { product_id: sellerExport.product_id }),
        ...(sellerExport.dateFrom === undefined ? {} : { dateFrom: sellerExport.dateFrom }),
        ...(sellerExport.dateTo === undefined ? {} : { dateTo: sellerExport.dateTo }),
        ...(sellerExport.ratings === undefined ? {} : { ratings: [...sellerExport.ratings].sort((left, right) => left - right) }),
        ...(sellerExport.content === undefined ? {} : { content: sellerExport.content }),
    };
    if (sellerExport.isAnswered === undefined) {
        return [
            { ...base, isAnswered: false, section: 'unanswered' },
            { ...base, isAnswered: true, section: 'answered' },
        ];
    }
    return [
        {
            ...base,
            isAnswered: sellerExport.isAnswered,
            section: sellerExport.isAnswered ? 'answered' : 'unanswered',
        },
    ];
});
// Every field `sellerExportIdentity` treats as distinguishing has to reach the name too, or two exports
// that differ only by rating or media filter arrive at the agent as identically named resource links.
const sellerArtifactName = (sellerExport) => {
    const period = sellerExport.dateFrom ? `${sellerExport.dateFrom}_${sellerExport.dateTo}` : 'all-time';
    const ratings = sellerExport.ratings === undefined ? 'any-rating' : `stars${[...sellerExport.ratings].join('')}`;
    const content = sellerExport.content === undefined ? 'any-content' : sellerExport.content;
    return `wb-reviews-${sellerExport.product_id ?? 'all-products'}-${sellerExport.section}-${period}-${ratings}-${content}.xlsx`;
};
// Parse boundary: a failure may be anything an operation or a writer threw; only a coded error keeps its fields.
const sellerError = (error, fallbackCode, fallbackMessage, stage = 'execution', retryable = false) => {
    if (error instanceof ToolExecutionError) {
        const details = closedFailureDetails(error.details);
        return {
            code: error.code,
            message: error.message,
            stage: error.stage,
            retryable: error.retryable,
            ...(details ? { details } : {}),
        };
    }
    // A local workbook write: a filesystem refusal is LOCAL_STORAGE_FAILED with its code, any other its closed class.
    const artifact = artifactFailureDetails(error);
    if (artifact?.systemCode) {
        const messages = LOCAL_STORAGE_MESSAGES;
        return {
            code: 'LOCAL_STORAGE_FAILED',
            message: messages[artifact.systemCode],
            stage: 'storage',
            retryable: true,
            details: artifact,
        };
    }
    const errorCode = fieldOf(error, 'code');
    const errorRetryable = fieldOf(error, 'retryable');
    const code = typeof errorCode === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(errorCode) ? errorCode : fallbackCode;
    return {
        code,
        message: artifactFailureMessage(artifact) ?? fallbackMessage,
        stage: fieldOf(error, 'stage') || stage,
        retryable: typeof errorRetryable === 'boolean' ? errorRetryable : retryable,
        ...(artifact ? { details: artifact } : {}),
    };
};
// A per-operation timeout is retryable by construction: the poll and download loops already own their
// own retry budgets, so it must not be swallowed by the stage-based package abort below. WB_FETCH_TIMEOUT
// belongs here for the same reason and is in fact the common one: the extension's own request timer fires
// before the agent's, which carries a grace margin, so a slow cabinet reaches us under that code rather
// than as SELLER_OPERATION_TIMEOUT. It arrives with retryable false, so nothing else marks it survivable.
const SELLER_RETRY_ONLY_CODES = new Set(['SELLER_OPERATION_TIMEOUT', 'WB_FETCH_TIMEOUT']);
// Whether a failure's code is one of `codes`.
const hasCodeIn = (codes, error) => {
    const code = fieldOf(error, 'code');
    return typeof code === 'string' && codes.has(code);
};
// Parse boundary: whatever an operation or a writer threw.
const abortsSellerPackage = (error) => {
    const stage = fieldOf(error, 'stage');
    return stage === 'storage' && fieldOf(error, 'retryable') === false
        ? true
        : hasCodeIn(SELLER_RETRY_ONLY_CODES, error)
            ? false
            : stage === 'authorization' || stage === 'extension' || hasCodeIn(SELLER_ABORT_CODES, error);
};
// Parse boundary: the cabinet's answers as the extension relayed them.
const reportIdFromCreate = (response) => fieldOf(fieldOf(response, 'data'), 'reportId') ?? fieldOf(response, 'reportId');
// A poll answer is recognized when it names this report's status or lists reports; anything else is not "still running".
const isRecognizedPoll = (response) => [fieldOf(response, 'data'), response].some((body) => (typeof fieldOf(body, 'reportId') === 'string' && typeof fieldOf(body, 'status') === 'string') ||
    Array.isArray(fieldOf(body, 'reportsInfo')));
const unrecognizedPoll = () => new ToolExecutionError('SELLER_RESPONSE_INVALID', 'Wildberries answered the review report status in a shape e-Comet does not recognize, so the export stopped instead of polling until it ' +
    'times out. This is an e-Comet defect: offer to report it; do not repeat the export automatically.', 'execution', false);
const reportStatusFromPoll = (response, reportId) => {
    const data = fieldOf(response, 'data');
    const dataStatus = fieldOf(data, 'status');
    if (fieldOf(data, 'reportId') === reportId && typeof dataStatus === 'string')
        return dataStatus;
    const status = fieldOf(response, 'status');
    if (fieldOf(response, 'reportId') === reportId && typeof status === 'string')
        return status;
    const reports = fieldOf(data, 'reportsInfo') ?? fieldOf(response, 'reportsInfo');
    return isUnknownArray(reports)
        ? fieldOf(reports.find((report) => fieldOf(report, 'reportId') === reportId), 'status')
        : undefined;
};
const delay = (milliseconds) => milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();
/**
 * Executes a signed seller-review report workflow. The extension has already validated
 * the descriptor; this executor only expands its immutable scope into physical reports.
 */
export const executeSellerReviewsJob = async ({ authorization, requestSellerOperation, createArtifactWriter, 
// One byte counter per call, shared by every writer of this export (spec §4.2).
jobBudget = { bytes: 0 }, 
// Keep the same cadence as the current WB feedbacks-front report polling saga.
pollIntervalMs = 3000, minSellerOperationIntervalMs = MIN_SELLER_OPERATION_AGENT_INTERVAL_MS, maxPollsPerReport = MAX_SELLER_REVIEW_POLLS_PER_REPORT, maxConsecutivePollFailures = MAX_CONSECUTIVE_SELLER_POLL_FAILURES, maxConsecutiveExportFailures = MAX_CONSECUTIVE_SELLER_EXPORT_FAILURES, maxDownloadAttempts = MAX_SELLER_REVIEW_DOWNLOAD_ATTEMPTS, downloadTimeoutMs = SELLER_DOWNLOAD_TIMEOUT_MS, maxJobDurationMs = SELLER_JOB_MAX_DURATION_MS, now = Date.now, delay: delayFn = delay, }) => {
    // Stop starting new work before the job can be cancelled out from under itself. Without this the
    // scope expiry timer cancels whatever is in flight with BROWSER_JOB_REAUTHORIZATION_REQUIRED, which
    // reads as an authorization failure rather than as a job that ran out of budget. The signed token is
    // the real ceiling — nothing rejects a short-lived one — so a five-minute token deadlines the job in
    // five minutes, not in `maxJobDurationMs`. The reserve has to cover every download attempt the loop
    // below is allowed to make, not just the first, or the retry is what crosses the expiry.
    const downloadReserveMs = downloadTimeoutMs * Math.max(1, maxDownloadAttempts);
    const expiresAt = fieldOf(authorization, 'expiresAt');
    const authorizationExpiresAtMs = typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? expiresAt * 1000 - downloadReserveMs : Infinity;
    const jobDeadline = Math.min(now() + maxJobDurationMs, authorizationExpiresAtMs);
    const deadlineExceeded = () => now() >= jobDeadline;
    const deadlineFailure = (result) => ({
        ...result,
        status: 'failed',
        error: {
            code: 'SELLER_JOB_DEADLINE_EXCEEDED',
            message: 'The seller export ran out of authorized time before this report could start.',
            stage: 'execution',
            retryable: true,
        },
    });
    let lastSellerOperationSentAt;
    // The poll cadence only ever covered poll-to-poll. Create-to-first-poll, poll-to-download and
    // export-to-export had no pacing at all, which is what let a package burst at the cabinet.
    const pacedRequestSellerOperation = async (...args) => {
        if (lastSellerOperationSentAt !== undefined) {
            // Date.now is not monotonic: an NTP correction or a VM resume can step it backwards, and an
            // unclamped remainder would then sleep past the signed token instead of pacing by it.
            const elapsedMs = Math.max(0, now() - lastSellerOperationSentAt);
            const waitMs = minSellerOperationIntervalMs - elapsedMs;
            if (waitMs > 0)
                await delayFn(waitMs);
        }
        lastSellerOperationSentAt = now();
        return requestSellerOperation(...args);
    };
    // Any other job type fails the check.
    const { job } = validateAuthorizedJobLimits(authorization);
    const physicalExports = normalizeSellerExports(job.exports);
    const exports = [];
    let packageAborted = false;
    let stopReason;
    let consecutiveExportFailures = 0;
    // Every export result goes through here so the package can notice that it is failing the same
    // way over and over: a create that keeps failing costs one request per export, and without a
    // counter the run proves that once for every remaining export.
    const recordExport = (entry, { systemic = true } = {}) => {
        exports.push(entry);
        if (entry.status === 'complete') {
            consecutiveExportFailures = 0;
            return;
        }
        if (entry.status !== 'failed' || !systemic) {
            consecutiveExportFailures = 0;
            return;
        }
        consecutiveExportFailures += 1;
        if (consecutiveExportFailures >= maxConsecutiveExportFailures)
            packageAborted = true;
    };
    for (const [exportIndex, sellerExport] of physicalExports.entries()) {
        const result = {
            ...(sellerExport.product_id === undefined ? {} : { product_id: sellerExport.product_id }),
            isAnswered: sellerExport.isAnswered,
            ...(sellerExport.dateFrom === undefined ? {} : { dateFrom: sellerExport.dateFrom }),
            ...(sellerExport.dateTo === undefined ? {} : { dateTo: sellerExport.dateTo }),
            ...(sellerExport.ratings === undefined ? {} : { ratings: [...sellerExport.ratings] }),
            ...(sellerExport.content === undefined ? {} : { content: sellerExport.content }),
        };
        if (!packageAborted && deadlineExceeded()) {
            packageAborted = true;
            recordExport(deadlineFailure(result));
            continue;
        }
        if (packageAborted) {
            recordExport({ ...result, status: 'skipped' });
            continue;
        }
        let reportId;
        try {
            const createResponse = await pacedRequestSellerOperation({
                exportIndex,
                isAnswered: sellerExport.isAnswered,
                stage: SELLER_OPERATION_STAGES.create,
            });
            const createdReportId = reportIdFromCreate(createResponse);
            if (typeof createdReportId !== 'string' || createdReportId.length === 0) {
                throw new ToolExecutionError('REPORT_CREATE_OUTCOME_UNKNOWN', 'Wildberries did not confirm creation of the review report.', 'execution', false);
            }
            reportId = createdReportId;
        }
        catch (error) {
            const normalized = sellerError(error, 'REPORT_FAILED', 'Wildberries could not create the review report.');
            recordExport({ ...result, status: 'failed', error: normalized });
            packageAborted = packageAborted || abortsSellerPackage(error);
            continue;
        }
        let reportReady = false;
        let pollFailure;
        let pollBreakerTripped = false;
        // Only a status Wildberries actually returned is its verdict. Deciding that from the error
        // code instead would have caught the create stage's REPORT_FAILED fallback, which means the
        // opposite there — that the failure could not be classified at all.
        let reportVerdict = false;
        let consecutivePollFailures = 0;
        for (let poll = 0; poll < maxPollsPerReport; poll += 1) {
            try {
                const pollResponse = await pacedRequestSellerOperation({
                    exportIndex,
                    isAnswered: sellerExport.isAnswered,
                    stage: SELLER_OPERATION_STAGES.poll,
                    reportId,
                });
                // Reset on the response itself, not on a usable status: the request succeeded, so
                // whatever the line below makes of it is a fresh failure rather than a repeat.
                consecutivePollFailures = 0;
                if (!isRecognizedPoll(pollResponse)) {
                    pollFailure = unrecognizedPoll();
                    stopReason = 'unrecognized_response';
                    packageAborted = true;
                    break;
                }
                const status = reportStatusFromPoll(pollResponse, reportId);
                if (status === 'complete') {
                    reportReady = true;
                    break;
                }
                if (status === 'stopped' || status === 'error') {
                    reportVerdict = true;
                    pollFailure = new ToolExecutionError(status === 'stopped' ? 'REPORT_STOPPED' : 'REPORT_FAILED', status === 'stopped' ? 'Wildberries stopped the review report.' : 'Wildberries failed the review report.', 'execution', false);
                    break;
                }
            }
            catch (error) {
                if (abortsSellerPackage(error)) {
                    pollFailure = error;
                    packageAborted = true;
                    break;
                }
                pollFailure = error;
                consecutivePollFailures += 1;
                // Repeated failures are not "not ready yet": a successful poll returning inProgress
                // resets the counter, so reaching the threshold means the endpoint is answering
                // badly and the rest of the budget would be spent for nothing. Only a retryable
                // cause leaves the remaining exports alive.
                if (consecutivePollFailures >= maxConsecutivePollFailures) {
                    pollBreakerTripped = true;
                    // Slowness is not refusal. A cabinet that keeps timing out may still finish the
                    // next report, so the export gives up while the package goes on; only a failure
                    // that says the cabinet will answer the same way for everyone stops the run.
                    if (fieldOf(error, 'retryable') !== true && !hasCodeIn(SELLER_RETRY_ONLY_CODES, error)) {
                        packageAborted = true;
                    }
                    break;
                }
            }
            if (poll + 1 >= maxPollsPerReport)
                break;
            // Give up polling in time to still download whatever is already complete rather than
            // letting the scope expiry cancel the operation mid-poll.
            if (now() + pollIntervalMs >= jobDeadline)
                break;
            await delayFn(pollIntervalMs);
        }
        if (!reportReady) {
            // A tripped breaker carries the real cause: reporting it as a timeout would tell the
            // agent to wait longer for a report that was never being refused for time reasons. An
            // opaque failure has no cause to carry, so it must at least not claim to be a
            // retryable timeout while the package it just stopped stays stopped.
            const error = stopReason === 'unrecognized_response'
                ? pollFailure
                : pollBreakerTripped
                    ? pollFailure instanceof ToolExecutionError
                        ? pollFailure
                        : new ToolExecutionError('REPORT_POLL_FAILED', 'Wildberries stopped answering polls for this review report.', 'execution', false)
                    : pollFailure instanceof ToolExecutionError && abortsSellerPackage(pollFailure)
                        ? pollFailure
                        : pollFailure instanceof ToolExecutionError && ['REPORT_STOPPED', 'REPORT_FAILED'].includes(pollFailure.code)
                            ? pollFailure
                            : new ToolExecutionError('REPORT_TIMEOUT', 'Wildberries did not complete the review report in time.', 'execution', true);
            recordExport({
                ...result,
                status: 'failed',
                error: sellerError(error, 'REPORT_TIMEOUT', 'Wildberries did not complete the review report in time.'),
            }, { systemic: !reportVerdict });
            continue;
        }
        // Polling can burn the whole budget on its own, so the report being ready is not proof there
        // is still time to fetch it. Crossing here would surface as an authorization failure.
        if (deadlineExceeded()) {
            packageAborted = true;
            recordExport(deadlineFailure(result));
            continue;
        }
        let artifact;
        let downloadError;
        for (let attempt = 0; attempt < maxDownloadAttempts; attempt += 1) {
            // The reserve covers every attempt, but a first attempt that ran long can still eat it.
            if (attempt > 0 && deadlineExceeded())
                break;
            let writer;
            // Ownership is per attempt: cancelling a later export must never invalidate an
            // earlier accepted XLSX. A completion arriving after cancellation is fenced;
            // an already accepted completion survives a later enclosing transport failure.
            const writerController = new AbortController();
            let activeHandlers = 0;
            const withWriterOwnership = async (operation) => {
                activeHandlers += 1;
                try {
                    writerController.signal.throwIfAborted();
                    return await operation();
                }
                finally {
                    activeHandlers -= 1;
                }
            };
            try {
                await pacedRequestSellerOperation({ exportIndex, isAnswered: sellerExport.isAnswered, stage: SELLER_OPERATION_STAGES.download, reportId }, {
                    onStart: () => withWriterOwnership(async () => {
                        if (writer)
                            throw new Error('Seller artifact stream started more than once');
                        writer = await createArtifactWriter({
                            fileName: sellerArtifactName(sellerExport),
                            mimeType: SELLER_XLSX_MIME_TYPE,
                            signal: writerController.signal,
                            jobBudget,
                        });
                        if (writerController.signal.aborted) {
                            try {
                                await writer.abort();
                            }
                            catch {
                                console.error('ARTIFACT_CLEANUP_FAILED: Deferred WB workbook cleanup failed.');
                            }
                            writerController.signal.throwIfAborted();
                        }
                    }),
                    onChunk: (index, data) => withWriterOwnership(async () => {
                        if (!writer)
                            throw new Error('Seller artifact stream chunk arrived before start');
                        await writer.appendChunk(index, data);
                    }),
                    onEnd: ({ size, sha256 }) => withWriterOwnership(async () => {
                        if (!writer)
                            throw new Error('Seller artifact stream ended before start');
                        const completed = await writer.complete({ size, sha256 });
                        writerController.signal.throwIfAborted();
                        artifact = completed;
                    }),
                }, downloadTimeoutMs);
                if (!artifact)
                    throw new Error('Seller artifact stream completed without publishing an artifact');
                break;
            }
            catch (error) {
                downloadError = error;
                if (artifact)
                    break;
                writerController.abort(error);
                if (activeHandlers > 0) {
                    // The real writer marks cancellation synchronously and owns cleanup behind
                    // its write chain. Keep that cleanup caught without holding the public result
                    // hostage to a filesystem operation. Do not retry while old I/O is outstanding.
                    if (writer)
                        writer.abort().catch(() => {
                            console.error('ARTIFACT_CLEANUP_FAILED: Deferred WB workbook cleanup failed.');
                        });
                    packageAborted = true;
                    break;
                }
                if (writer) {
                    try {
                        await writer.abort();
                    }
                    catch (cleanupError) {
                        downloadError = new ToolExecutionError('ARTIFACT_CLEANUP_FAILED', 'The partial review workbook could not be removed safely.', 'storage', false, { cause: new AggregateError([error, cleanupError], 'Download and artifact cleanup both failed') });
                        packageAborted = true;
                        break;
                    }
                }
                // The same completed workbook cannot shrink on another download attempt.
                if (error instanceof ToolExecutionError && error.code === 'ARTIFACT_TOO_LARGE')
                    break;
                if (abortsSellerPackage(error)) {
                    packageAborted = true;
                    break;
                }
            }
        }
        if (artifact) {
            recordExport({ ...result, status: 'complete', artifact });
        }
        else {
            recordExport({
                ...result,
                status: 'failed',
                error: sellerError(downloadError, 'ARTIFACT_STORAGE_FAILED', 'The review workbook could not be stored locally.', 'storage', true),
            }, { systemic: fieldOf(downloadError, 'code') !== 'ARTIFACT_TOO_LARGE' });
        }
    }
    const succeeded = exports.filter((item) => item.status === 'complete').length;
    return {
        ok: succeeded > 0,
        status: succeeded === exports.length ? 'complete' : succeeded > 0 ? 'partial' : 'failed',
        jobType: 'seller_reviews',
        jobId: job.jobId,
        ...(job.org ? { org: job.org } : {}),
        ...(stopReason ? { stopReason } : {}),
        exports,
    };
};
