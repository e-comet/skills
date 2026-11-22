import { setTimeout as wait } from 'node:timers/promises';
import { isRequestNotSent, ToolExecutionError } from '../../shared/coded-error.mjs';
import { MIN_REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_GRACE_MS, REQUEST_TIMEOUT_MS } from '../../shared/timeouts.mjs';
import { COMPARISON_FAILURE_CODE, SELLER_SCOPE_DURATION_MS, } from '../../transport/extension/wire.mjs';
import { artifactFailureDetails, COMPARISON_FAILURE_MESSAGES, comparisonRelayFailureMessage, failureDetails, LOCAL_STORAGE_MESSAGES, } from '../../transport/failures/vocabulary.mjs';
import { MAX_SELLER_REVIEW_POLLS_PER_REPORT, MIN_SELLER_OPERATION_AGENT_INTERVAL_MS, SELLER_DOWNLOAD_TIMEOUT_MS, } from '../domain/constants/limits.const.mjs';
import { comparisonPeriodWindow, resolveComparisonPeriod, sameComparisonDates, } from '../domain/policies/comparison-period.policy.mjs';
const storageMessages = LOCAL_STORAGE_MESSAGES;
const POLL_INTERVAL_MS = 3000;
const READ_RESERVE_MS = MIN_SELLER_OPERATION_AGENT_INTERVAL_MS + MIN_REQUEST_TIMEOUT_MS + REQUEST_TIMEOUT_GRACE_MS;
const ORDER_READ_RESERVE_MS = 2 * READ_RESERVE_MS;
const MIN_ORDER_WINDOW_MS = MIN_REQUEST_TIMEOUT_MS + REQUEST_TIMEOUT_GRACE_MS + ORDER_READ_RESERVE_MS;
const LOCAL_FAILURE_MESSAGES = {
    BROWSER_JOB_REAUTHORIZATION_REQUIRED: 'The signed authorization ended before the comparison job finished.',
    EXTENSION_DISCONNECTED: 'The browser connection closed before this comparison stage finished.',
    BRIDGE_FRAME_TOO_LARGE: 'The local e-Comet bridge refused a comparison request.',
    SELLER_JOB_DEADLINE_EXCEEDED: 'The comparison job ran out of signed time.',
    REPORT_TIMEOUT: 'The comparison file was not ready within the job’s polling budget.',
    OPERATION_CANCELLED: 'The comparison job was cancelled.',
    SELLER_STREAM_INVALID: 'The received stream did not match the authorized comparison operation.',
    SELLER_OPERATION_NOT_ALLOWED: 'The local tool could not use this seller authorization for the operation.',
    SELLER_OPERATION_TIMEOUT_INVALID: 'The comparison operation had an invalid request timeout.',
    SELLER_OPERATION_TIMEOUT: 'The comparison operation did not answer before its timeout.',
    SELLER_OPERATION_CAPACITY_EXCEEDED: 'The local process has too many pending seller operations.',
};
const failure = (stage, reason) => ({
    code: COMPARISON_FAILURE_CODE,
    stage,
    reason,
});
const normalizeName = (name) => name.trim().normalize('NFC').toLocaleLowerCase('und');
const matchesOrganization = (selector, org) => selector === undefined ||
    ('id' in selector ? selector.id === org.id : org.name !== undefined && normalizeName(selector.name) === normalizeName(org.name));
const matchesArticles = (job, nmIds) => nmIds?.length === job.nmIds.length && job.nmIds.every((article, index) => article === nmIds[index]);
const matchesComparison = (job, result) => {
    const { org, nmIds, periodBasis, source, createOutcome } = result;
    const expected = resolveComparisonPeriod(job.period, periodBasis);
    return (matchesOrganization(job.org, org) &&
        matchesArticles(job, nmIds) &&
        'dates' in expected &&
        sameComparisonDates(expected.dates, result) &&
        (job.allowNewComparison || createOutcome === 'not_sent') &&
        (source === 'created' ? createOutcome === 'confirmed' : createOutcome !== 'confirmed'));
};
const failureMessage = ({ code, reason, details, periodBasis, dates, createOutcome }) => {
    if (reason === 'period_out_of_range' && periodBasis) {
        const { dateFrom, dateTo } = comparisonPeriodWindow(periodBasis.localToday);
        return COMPARISON_FAILURE_MESSAGES[reason] + ' Choose dates from ' + dateFrom + ' through ' + dateTo + ' inclusive.';
    }
    if (reason === 'access_unknown' && periodBasis) {
        if (!dates)
            return 'The extension could not confirm calendar access for the selected company. Check which periods WB Seller offers before choosing the dates.';
        if (createOutcome === 'confirmed')
            return 'Wildberries confirmed the new comparison. The selected dates could not be opened.';
    }
    if (reason)
        return COMPARISON_FAILURE_MESSAGES[reason];
    return comparisonRelayFailureMessage(code, details?.reason) ?? 'The seller comparison could not complete this stage.';
};
const alternateCompanyText = ({ stage, reason, createOutcome, orderOutcome }) => (stage === 'compare' || stage === 'create_xlsx') &&
    reason === 'access_denied' &&
    createOutcome === 'not_sent' &&
    orderOutcome === 'not_sent'
    ? ' Offer another company from the current seller catalog. Wait for the seller’s explicit choice before requesting a fresh signed export.'
    : '';
const thrownFailure = (stage, error) => {
    const code = error instanceof ToolExecutionError && Object.hasOwn(LOCAL_FAILURE_MESSAGES, error.code) ? error.code : 'UNEXPECTED_LOCAL_ERROR';
    const artifact = stage === 'download_xlsx' ? artifactFailureDetails(error) : undefined;
    const details = failureDetails(error);
    if (artifact) {
        const message = artifact.systemCode !== undefined
            ? artifact.systemCode === 'ENOSPC' || artifact.systemCode === 'EDQUOT'
                ? 'Local output storage ran out of space or quota. Free space to recover the saved file.'
                : artifact.systemCode === 'EBUSY'
                    ? 'Local output storage was busy when the workbook arrived.'
                    : storageMessages[artifact.systemCode]
            : artifact.class === 'limit'
                ? 'The comparison archive or workbook exceeded the local file limit.'
                : 'The comparison download did not pass local integrity or workbook validation. Offer to report it to e-Comet.';
        const code = artifact.systemCode !== undefined ? 'LOCAL_STORAGE_FAILED' : 'ARTIFACT_REJECTED';
        return { code, stage, message, details: artifact };
    }
    const message = code === 'BRIDGE_FRAME_TOO_LARGE' && error instanceof ToolExecutionError && isRequestNotSent(error)
        ? error.message
        : (LOCAL_FAILURE_MESSAGES[code] ?? 'The comparison job could not complete this stage.');
    return { code, stage, message, ...(details ? { details } : {}) };
};
const recoveryText = (state) => {
    if (state.artifact)
        return ' Recover delivery from the existing local workbook.';
    if (state.orderOutcome === 'confirmed' || state.orderOutcome === 'unknown') {
        return (' Look in “Загрузки” (Downloads) in the selected Wildberries seller company for the same Excel file. ' +
            'If the file is still being prepared or several files match, check the dates and articles in the workbook when it is available.');
    }
    if (state.source || state.createOutcome === 'confirmed' || state.createOutcome === 'unknown')
        return ' Check the selected Wildberries seller company’s comparison history for the same article set.';
    return '';
};
// One ordered comparison export using the attested lease throughout.
export const exportCardComparison = async ({ job, expiresAt, requestOperation, createArchiveWriter, signal, now = Date.now, delay = wait, }) => {
    const deadline = Math.min(expiresAt * 1000, now() + SELLER_SCOPE_DURATION_MS);
    let stage = 'compare';
    const progress = {
        ...(job.org === undefined ? {} : { org: job.org }),
        nmIds: job.nmIds,
        period: job.period,
        sizeDetails: job.sizeDetails,
        createOutcome: 'not_sent',
        orderOutcome: 'not_sent',
    };
    let lastSentAt;
    let writer;
    const writerController = new AbortController();
    const writerSignal = signal ? AbortSignal.any([signal, writerController.signal]) : writerController.signal;
    const stop = (error, message = failureMessage(error)) => ({
        ...progress,
        ok: false,
        status: progress.artifact
            ? 'complete'
            : progress.source || progress.createOutcome === 'confirmed'
                ? 'partial'
                : 'failed',
        code: error.code,
        stage: error.stage,
        ...(error.reason ? { reason: error.reason } : {}),
        ...(error.comparisonLimits ? { comparisonLimits: error.comparisonLimits } : {}),
        ...(error.details ? { details: error.details } : {}),
        retryable: false,
        message: message + recoveryText(progress) + alternateCompanyText(error),
    });
    const readStage = async (target, handlers) => {
        stage = target;
        const assertActive = () => {
            if (signal?.aborted)
                throw new ToolExecutionError('OPERATION_CANCELLED', 'The comparison job was cancelled.', 'execution');
        };
        assertActive();
        if (lastSentAt !== undefined) {
            const elapsed = Math.max(0, now() - lastSentAt);
            const interval = target === 'poll_xlsx' ? POLL_INTERVAL_MS : MIN_SELLER_OPERATION_AGENT_INTERVAL_MS;
            const delayMs = Math.min(interval - elapsed, deadline - now() - REQUEST_TIMEOUT_GRACE_MS);
            if (delayMs > 0)
                await delay(delayMs);
        }
        assertActive();
        // Keep room for the first read after ordering, and for a download after a poll. A short signed grant
        // receives a smaller request timeout and never starts work outside the extension's valid time bounds.
        const reserved = target === 'create_xlsx' ? ORDER_READ_RESERVE_MS : target === 'poll_xlsx' ? READ_RESERVE_MS : 0;
        const remaining = deadline - now();
        const canSpendComparison = target === 'compare' && job.allowNewComparison;
        // Compare and the minimum interval before the order run concurrently. Keep room for the order's own admission window.
        const comparisonWindow = remaining - MIN_ORDER_WINDOW_MS;
        const timeout = Math.min(target === 'download_xlsx' ? SELLER_DOWNLOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS, Math.floor(remaining - REQUEST_TIMEOUT_GRACE_MS - reserved), canSpendComparison ? Math.floor(comparisonWindow) : Infinity);
        if (timeout < MIN_REQUEST_TIMEOUT_MS || (canSpendComparison && comparisonWindow < MIN_SELLER_OPERATION_AGENT_INTERVAL_MS))
            throw new ToolExecutionError('SELLER_JOB_DEADLINE_EXCEEDED', 'The comparison job ran out of signed time.', 'execution');
        lastSentAt = now();
        const writing = target === 'create_xlsx' ? 'orderOutcome' : canSpendComparison ? 'createOutcome' : undefined;
        if (writing)
            progress[writing] = 'unknown';
        let response;
        try {
            response = await requestOperation({ kind: 'card_comparison', stage: target }, handlers, timeout);
        }
        catch (error) {
            if (writing && isRequestNotSent(error))
                progress[writing] = 'not_sent';
            throw error;
        }
        const invalid = failure(target, 'response_invalid');
        if (!response || response.stage !== target)
            return invalid;
        if ('code' in response) {
            const { createOutcome, orderOutcome, org, periodBasis, dates, nmIds } = response;
            const expectedCreate = progress.createOutcome;
            const expectedOrder = progress.orderOutcome;
            const confirmedOrg = target !== 'compare' && progress.org && 'id' in progress.org ? progress.org : undefined;
            // Only the worker can confirm the one order admitted in this lease, even if its create reply was lost.
            const confirmedOrder = (target === 'poll_xlsx' || target === 'download_xlsx') &&
                createOutcome !== undefined &&
                expectedOrder === 'unknown' &&
                orderOutcome === 'confirmed';
            if ((createOutcome !== undefined && target !== 'compare' && createOutcome !== expectedCreate) ||
                (createOutcome !== undefined && !job.allowNewComparison && createOutcome !== 'not_sent') ||
                (org !== undefined && !matchesOrganization(job.org, org)) ||
                (org !== undefined && confirmedOrg !== undefined && org.id !== confirmedOrg.id) ||
                (orderOutcome !== undefined && target !== 'create_xlsx' && orderOutcome !== expectedOrder && !confirmedOrder))
                return invalid;
            if (target === 'compare') {
                if (periodBasis) {
                    const expected = resolveComparisonPeriod(job.period, periodBasis);
                    if (!org || !matchesArticles(job, nmIds))
                        return invalid;
                    if (dates) {
                        if (!('dates' in expected) || !sameComparisonDates(expected.dates, dates))
                            return invalid;
                        Object.assign(progress, dates);
                    }
                    else {
                        if (!('reason' in expected) || expected.reason !== response.reason)
                            return invalid;
                        if (response.reason === 'period_out_of_range')
                            progress.periodWindow = comparisonPeriodWindow(periodBasis.localToday);
                    }
                }
                if (createOutcome !== undefined)
                    progress.createOutcome = createOutcome;
                if (org)
                    progress.org = org;
            }
            if (orderOutcome !== undefined && (target === 'create_xlsx' || confirmedOrder))
                progress.orderOutcome = orderOutcome;
        }
        return response;
    };
    try {
        const compared = await readStage('compare');
        if ('code' in compared)
            return stop(compared);
        if (compared.stage !== 'compare' || !matchesComparison(job, compared))
            return stop(failure('compare', 'response_invalid'));
        const { org, dateFrom, dateTo, source, createOutcome } = compared;
        Object.assign(progress, { org, dateFrom, dateTo, source, createOutcome });
        let ordered;
        try {
            ordered = await readStage('create_xlsx');
        }
        catch (error) {
            // Local correlation expired after a possible send. The worker alone can find the UUID it pinned.
            if (!(error instanceof ToolExecutionError && error.code === 'SELLER_OPERATION_TIMEOUT') || isRequestNotSent(error))
                throw error;
            ordered = { ...failure('create_xlsx', 'outcome_unknown'), orderOutcome: 'unknown' };
        }
        if ('code' in ordered) {
            if (ordered.orderOutcome !== 'unknown' ||
                ordered.reason === 'rate_limited' ||
                (ordered.reason === undefined && ordered.code !== 'WB_FETCH_TIMEOUT'))
                return stop(ordered);
        }
        else {
            if (ordered.stage !== 'create_xlsx')
                return stop(failure('create_xlsx', 'response_invalid'));
            progress.exportId = ordered.exportId;
            progress.orderOutcome = ordered.orderOutcome;
        }
        for (let polls = 0; polls < MAX_SELLER_REVIEW_POLLS_PER_REPORT; polls += 1) {
            const polled = await readStage('poll_xlsx');
            if ('code' in polled)
                return stop(polled);
            if (polled.stage !== 'poll_xlsx' ||
                (progress.exportId !== undefined && progress.exportId !== polled.exportId) ||
                (polled.report?.startDate !== undefined && polled.report.startDate !== progress.dateFrom) ||
                (polled.report?.endDate !== undefined && polled.report.endDate !== progress.dateTo))
                return stop(failure('poll_xlsx', 'response_invalid'));
            progress.exportId = polled.exportId;
            progress.fileStatus = polled.fileStatus;
            if (polled.report)
                progress.report = polled.report;
            if (polled.fileStatus === 'SUCCESS')
                break;
            if (polled.fileStatus === 'FAILED')
                return stop(failure('poll_xlsx', 'report_failed'));
        }
        if (progress.fileStatus !== 'SUCCESS')
            throw new ToolExecutionError('REPORT_TIMEOUT', 'The comparison file was not ready within the job’s polling budget.', 'execution');
        const downloaded = await readStage('download_xlsx', {
            async onStart() {
                writer = await createArchiveWriter({
                    fileName: 'wb-card-comparison-' + compared.dateFrom + '_' + compared.dateTo + '-' + job.nmIds.join('-') + '.xlsx',
                    signal: writerSignal,
                });
            },
            async onChunk(index, data) {
                writerSignal.throwIfAborted();
                await writer?.appendChunk(index, data);
            },
            async onEnd(completion) {
                writerSignal.throwIfAborted();
                const artifact = await writer?.complete(completion);
                if (artifact)
                    progress.artifact = artifact;
            },
        });
        if ('code' in downloaded)
            return stop(downloaded);
        if (downloaded.stage !== 'download_xlsx' || !progress.artifact)
            return stop(failure('download_xlsx', 'response_invalid'));
        return { ...progress, ok: true, status: 'complete', stage: 'download_xlsx' };
    }
    catch (error) {
        const { message, ...failure } = thrownFailure(stage, error);
        return stop(failure, message);
    }
    finally {
        // End the private writer lifetime to release its listener on the composed shutdown signal.
        writerController.abort();
        if (!progress.artifact) {
            // The writer fences publication on abort and owns its temporary file. Cleanup can wait on slow disk I/O.
            writer?.abort().catch(() => console.error('ARTIFACT_CLEANUP_FAILED: Deferred comparison workbook cleanup failed.'));
        }
    }
};
