import { validateAuthorizedJobLimits } from './job-limits.mjs';
import { ozonDescriptorRejected } from '../domain/converters/errors.converter.mjs';
import { ozonPackageDeadline, ozonPackageStopReason } from '../domain/converters/package-result.converter.mjs';
import { canonicalSearchPositionsRequest, isValidOzonSearchPositionsDetails, sameSearchPositionsRequest, } from '../domain/policies/search-positions.policy.mjs';
import { ToolExecutionError } from '../../shared/coded-error.mjs';
import { countRunProgress } from '../../shared/run-progress.mjs';
import { isRecord } from '../../shared/values.mjs';
import { OZON_SEARCH_POSITIONS_TERMINAL_CODE_STAGES } from '../../transport/extension/wire.mjs';
import { browserJobRejectionDetails } from '../../transport/failures/rejection.mjs';
import { bridgeCodeDetails, descriptorRuleDetails } from '../../transport/failures/vocabulary.mjs';
const JOB_TYPE = 'ozon_search_positions';
const POSITIONS_STOP_REASONS = {
    OZON_SEARCH_POSITIONS_CAPABILITY_UNAVAILABLE: 'capability_unavailable',
    OZON_REGION_UNAVAILABLE: 'region_unavailable',
    OZON_SKU_LIMIT_EXCEEDED: 'sku_limit_exceeded',
};
// Parse boundary: a code from any failure.
const stopReason = (code) => typeof code === 'string' && Object.hasOwn(POSITIONS_STOP_REASONS, code) ? POSITIONS_STOP_REASONS[code] : ozonPackageStopReason(code);
// The extension stops after three of these in a row and skips the rest as cancelled; the breaker is named here.
// Mirrors the extension's classification: accepted residual, see docs/architecture/residuals/ozon.md.
const SYSTEMIC_CODES = new Set(['PREFLIGHT_FAILED', 'POLL_FAILED', 'POLL_EXHAUSTED', 'OPERATION_DEADLINE_EXCEEDED']);
const interrupted = (message) => ({
    code: 'OZON_EXECUTION_INTERRUPTED',
    stage: 'execution',
    retryable: false,
    message,
});
// Parse boundary: a failure this process built or the extension sent, read field by field.
export const safeOzonSearchPositionsError = (error) => {
    const fields = isRecord(error) ? error : {};
    // The broker reports a positions protocol violation as ARTIFACT_REJECTED; this tool has no artifacts.
    if (fields.code === 'ARTIFACT_REJECTED') {
        return interrupted('The Ozon search positions results from the extension could not be accepted safely. ' +
            'This is an internal e-Comet failure, not an Ozon Seller login or route problem.');
    }
    const { code, message } = fields;
    const stage = typeof code === 'string' && Object.hasOwn(OZON_SEARCH_POSITIONS_TERMINAL_CODE_STAGES, code)
        ? OZON_SEARCH_POSITIONS_TERMINAL_CODE_STAGES[code]
        : undefined;
    if (typeof code !== 'string' ||
        stage === undefined ||
        fields.stage !== stage ||
        fields.retryable !== false ||
        typeof message !== 'string' ||
        message.length < 1 ||
        message.length > 500) {
        return interrupted('The Ozon search positions operation stopped; its failure could not be classified.');
    }
    const details = browserJobRejectionDetails(error) ??
        bridgeCodeDetails(error) ??
        descriptorRuleDetails(error) ??
        (isValidOzonSearchPositionsDetails(code, fields.details) ? fields.details : undefined);
    return { code, stage, retryable: false, message, ...(details ? { details } : {}) };
};
// An invalid SKU also reads as not_found because Ozon answers it identically: accepted residual, see
// docs/architecture/residuals/ozon.md.
// Parse boundary: a cell as the extension sent it, checked against the signed SKUs.
const cellValue = (cell) => !isRecord(cell)
    ? undefined
    : Object.hasOwn(cell, 'position')
        ? cell.position
        : cell.found === false
            ? 'not_found'
            : cell.returned === false
                ? 'not_returned'
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
    return positionsResult(request, request.queries.map((query, itemIndex) => ({ itemIndex, query, status: 'skipped' })), { code: safe.code, error: safe });
};
export const executeOzonSearchPositionsJob = async ({ authorization, request, requestOzonReportPackage, now = Date.now, foreignJobs = undefined, }) => {
    let signed;
    try {
        validateAuthorizedJobLimits(authorization, foreignJobs);
        const grant = isRecord(authorization) ? authorization : {};
        if (grant.jobType !== JOB_TYPE)
            throw new Error('Wrong Ozon search positions job type');
        signed = canonicalSearchPositionsRequest(request);
        if (!sameSearchPositionsRequest(signed, grant.job))
            throw new Error('Signed Ozon search positions request does not match');
    }
    catch (error) {
        throw (ozonDescriptorRejected(error) ??
            new ToolExecutionError('OZON_AUTHORIZATION_REJECTED', 'The signed Ozon search positions authorization does not match this request.', 'authorization', false, { cause: error }));
    }
    const rows = new Array(signed.queries.length);
    let systemicStreak = 0;
    let stop;
    try {
        await requestOzonReportPackage({ family: 'positions', items: signed.queries, deadlineAt: ozonPackageDeadline(authorization, now()) }, {
            // The broker has already checked each result against the signed queries and SKUs.
            onItemResult: countRunProgress(signed.queries.length, async (itemIndex, result) => {
                const query = signed.queries[itemIndex];
                const { ok, status, checkedAt, positions, error: failure } = isRecord(result) ? result : {};
                if (ok) {
                    if (typeof status !== 'string' || typeof checkedAt !== 'number' || !Array.isArray(positions)) {
                        throw new TypeError('The Ozon search positions result was not checked by the broker.');
                    }
                    systemicStreak = 0;
                    rows[itemIndex] = {
                        itemIndex,
                        query,
                        status,
                        checkedAt: new Date(checkedAt).toISOString(),
                        positions: positions.map(cellValue),
                    };
                    return;
                }
                const error = safeOzonSearchPositionsError(failure);
                if (status === 'skipped') {
                    // The remainder repeats the code of the query that stopped the package; that query explains it best.
                    const previous = rows[itemIndex - 1];
                    // Three failed queries precede a breaker's skip.
                    if (systemicStreak >= 3)
                        stop ??= { code: 'SYSTEMIC_FAILURE_BREAKER', error: previous?.error };
                    else if (previous?.status === 'failed' && previous.error?.code === error.code)
                        stop ??= { code: error.code, error: previous.error };
                    else
                        stop ??= { code: error.code, error };
                    rows[itemIndex] = { itemIndex, query, status: 'skipped' };
                    return;
                }
                systemicStreak = SYSTEMIC_CODES.has(error.code) ? systemicStreak + 1 : 0;
                rows[itemIndex] = { itemIndex, query, status: 'failed', error };
            }),
        });
    }
    catch (error) {
        // The broker ended the package; the query in flight may already have reached Ozon but has no result
        // (accepted residual, see docs/architecture/residuals/ozon.md).
        const safe = safeOzonSearchPositionsError(error);
        stop ??= { code: safe.code, error: safe };
    }
    for (let itemIndex = 0; itemIndex < rows.length; itemIndex += 1) {
        rows[itemIndex] ??= { itemIndex, query: signed.queries[itemIndex], status: 'skipped' };
    }
    // Only a broken lease can settle before every query has a result.
    stop ??= { code: 'OZON_EXECUTION_INTERRUPTED', error: safeOzonSearchPositionsError(undefined) };
    // Every query has its row by now.
    return positionsResult(signed, rows.filter((row) => row !== undefined), stop);
};
