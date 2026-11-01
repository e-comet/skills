import { validateAuthorizedJobLimits } from './browser-job.mjs';
import { isValidOzonSearchPositionsDetails } from './extension-protocol.mjs';
import { OZON_SEARCH_POSITIONS_TERMINAL_CODE_STAGES } from './extension-vocabulary.mjs';
import { ozonPackageDeadline, ozonPackageStopReason } from './ozon-report-package-result.mjs';
import { canonicalSearchPositionsRequest, sameSearchPositionsRequest } from './ozon-search-positions-domain.mjs';
import { countRunProgress } from './run-registry.mjs';
import { bridgeCodeDetails, browserJobRejectionDetails, descriptorRuleDetails, ozonDescriptorRejected, ToolExecutionError } from './tool-errors.mjs';

const JOB_TYPE = 'ozon_search_positions';
const POSITIONS_STOP_REASONS = Object.freeze({
    OZON_SEARCH_POSITIONS_CAPABILITY_UNAVAILABLE: 'capability_unavailable',
    OZON_REGION_UNAVAILABLE: 'region_unavailable',
    OZON_SKU_LIMIT_EXCEEDED: 'sku_limit_exceeded',
});
const stopReason = (code) => Object.hasOwn(POSITIONS_STOP_REASONS, code) ? POSITIONS_STOP_REASONS[code] : ozonPackageStopReason(code);
// The extension stops after three of these in a row and skips the rest as cancelled; the breaker is named here.
// Mirrors the extension's classification: accepted residual, see docs/local-agent-architecture.md#accepted-residuals.
const SYSTEMIC_CODES = new Set(['PREFLIGHT_FAILED', 'POLL_FAILED', 'POLL_EXHAUSTED', 'OPERATION_DEADLINE_EXCEEDED']);

const interrupted = (message) => ({ code: 'OZON_EXECUTION_INTERRUPTED', stage: 'execution', retryable: false, message });

export const safeOzonSearchPositionsError = (error) => {
    // The broker reports a positions protocol violation as ARTIFACT_REJECTED; this tool has no artifacts.
    if (error?.code === 'ARTIFACT_REJECTED') {
        return interrupted('The Ozon search positions results from the extension could not be accepted safely. ' +
            'This is an internal e-Comet failure, not an Ozon Seller login or route problem.');
    }
    const stage = Object.hasOwn(OZON_SEARCH_POSITIONS_TERMINAL_CODE_STAGES, error?.code) ? OZON_SEARCH_POSITIONS_TERMINAL_CODE_STAGES[error.code] : undefined;
    if (stage === undefined || error.stage !== stage || error.retryable !== false ||
        typeof error.message !== 'string' || error.message.length < 1 || error.message.length > 500) {
        return interrupted('The Ozon search positions operation stopped; its failure could not be classified.');
    }
    const details = browserJobRejectionDetails(error) ?? bridgeCodeDetails(error) ?? descriptorRuleDetails(error) ??
        (isValidOzonSearchPositionsDetails(error.code, error.details) ? error.details : undefined);
    return { code: error.code, stage, retryable: false, message: error.message, ...(details ? { details } : {}) };
};

// An invalid SKU also reads as not_found because Ozon answers it identically: accepted residual, see
// docs/local-agent-architecture.md#accepted-residuals.
const cellValue = (cell) =>
    Object.hasOwn(cell, 'position') ? cell.position
        : cell.found === false ? 'not_found'
            : cell.returned === false ? 'not_returned'
                : cell.label;

const positionsResult = ({ region, platform, skus }, rows, stop) => {
    const answered = rows.filter(({ status }) => status === 'complete' || status === 'empty').length;
    const stopped = rows.some(({ status }) => status === 'skipped');
    return {
        ok: answered > 0,
        status: answered === rows.length ? 'complete' : answered > 0 ? 'partial' : 'failed',
        jobType: JOB_TYPE,
        marketplace: 'ozon',
        region,
        platform,
        skus,
        queries: rows,
        stopReason: stopped ? stopReason(stop.code) : null,
        ...(stopped ? { error: stop.error } : {}),
    };
};

// A call refused before the package started: nothing reached Ozon, so every query is skipped.
export const rejectedOzonSearchPositions = (request, error) => {
    const safe = safeOzonSearchPositionsError(error);
    return positionsResult(request, request.queries.map((query, itemIndex) => ({ itemIndex, query, status: 'skipped' })),
        { code: safe.code, error: safe });
};

export const executeOzonSearchPositionsJob = async ({ authorization, request, requestOzonReportPackage, now = Date.now }) => {
    let signed;
    try {
        validateAuthorizedJobLimits(authorization);
        if (authorization.jobType !== JOB_TYPE) throw new Error('Wrong Ozon search positions job type');
        signed = canonicalSearchPositionsRequest(request);
        if (!sameSearchPositionsRequest(signed, authorization.job)) throw new Error('Signed Ozon search positions request does not match');
        if (typeof requestOzonReportPackage !== 'function') throw new Error('Ozon search positions execution dependencies are unavailable');
    } catch (error) {
        throw ozonDescriptorRejected(error) ?? new ToolExecutionError('OZON_AUTHORIZATION_REJECTED',
            'The signed Ozon search positions authorization does not match this request.', 'authorization', false, { cause: error });
    }
    const rows = new Array(signed.queries.length);
    let systemicStreak = 0;
    let stop;
    try {
        await requestOzonReportPackage(
            { family: 'positions', items: signed.queries, deadlineAt: ozonPackageDeadline(authorization, now()) },
            {
                // The broker has already checked each result against the signed queries and SKUs.
                onItemResult: countRunProgress(signed.queries.length, async (itemIndex, result) => {
                    const query = signed.queries[itemIndex];
                    if (result.ok) {
                        systemicStreak = 0;
                        rows[itemIndex] = { itemIndex, query, status: result.status,
                            checkedAt: new Date(result.checkedAt).toISOString(), positions: result.positions.map(cellValue) };
                        return;
                    }
                    const error = safeOzonSearchPositionsError(result.error);
                    if (result.status === 'skipped') {
                        // The remainder repeats the code of the query that stopped the package; that query explains it best.
                        const previous = rows[itemIndex - 1];
                        if (systemicStreak >= 3) stop ??= { code: 'SYSTEMIC_FAILURE_BREAKER', error: previous.error };
                        else if (previous?.status === 'failed' && previous.error.code === error.code) stop ??= { code: error.code, error: previous.error };
                        else stop ??= { code: error.code, error };
                        rows[itemIndex] = { itemIndex, query, status: 'skipped' };
                        return;
                    }
                    systemicStreak = SYSTEMIC_CODES.has(error.code) ? systemicStreak + 1 : 0;
                    rows[itemIndex] = { itemIndex, query, status: 'failed', error };
                }),
            }
        );
    } catch (error) {
        // The broker ended the package; the query in flight may already have reached Ozon but has no result
        // (accepted residual, see docs/local-agent-architecture.md#accepted-residuals).
        const safe = safeOzonSearchPositionsError(error);
        stop ??= { code: safe.code, error: safe };
    }
    for (let itemIndex = 0; itemIndex < rows.length; itemIndex += 1) {
        rows[itemIndex] ??= { itemIndex, query: signed.queries[itemIndex], status: 'skipped' };
    }
    // Only a broken lease can settle before every query has a result.
    stop ??= { code: 'OZON_EXECUTION_INTERRUPTED', error: safeOzonSearchPositionsError(undefined) };
    return positionsResult(signed, rows, stop);
};
