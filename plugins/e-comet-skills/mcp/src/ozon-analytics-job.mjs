import { validateAuthorizedJobLimits } from './browser-job.mjs';
import { SELLER_AUTHORIZATION_SCOPE_MAX_MS } from './config.mjs';
import { ozonAnalyticsArtifactName, parseAnalyticsReports } from './ozon-analytics-domain.mjs';
import { executeOzonReportPackage } from './ozon-report-package-job.mjs';
import { StorageUnavailableError } from './storage-layout.mjs';
import { ToolExecutionError } from './tool-errors.mjs';
import { OZON_ANALYTICS_TERMINAL_CODE_STAGES, isOzonAnalyticsTerminalDetails, isOzonExecutionInterruptionDetails } from './extension-vocabulary.mjs';

const SIGNED_EXPIRY_SAFETY_RESERVE_MS = 1000;

const authorizationRejected = (cause) =>
    new ToolExecutionError(
        'OZON_AUTHORIZATION_REJECTED',
        'The signed Ozon analytics authorization does not match this request.',
        'authorization',
        false,
        { cause }
    );

export const safeOzonAnalyticsToolError = (error) => {
    if (error instanceof StorageUnavailableError) {
        return { code: error.code, message: error.message, stage: error.stage, retryable: false };
    }
    const stage = OZON_ANALYTICS_TERMINAL_CODE_STAGES[error?.code];
    if (
        // Local ToolExecutionError always owns an initially undefined details field.
        // Absence of evidence must not erase an otherwise known local failure.
        (error?.details !== undefined && !isOzonAnalyticsTerminalDetails(error?.code, error.details) &&
            !isOzonExecutionInterruptionDetails(error?.code, error.details)) ||
        stage === undefined ||
        error?.stage !== stage ||
        error?.retryable !== false ||
        typeof error?.message !== 'string' ||
        error.message.length < 1 ||
        error.message.length > 500
    ) {
        throw new TypeError('Invalid Ozon analytics terminal error.');
    }
    return { code: error.code, message: error.message, stage, retryable: false,
        ...(isOzonAnalyticsTerminalDetails(error.code, error.details) ? { details: { marketplaceErrorCode: error.details.marketplaceErrorCode } } : {}),
        ...(isOzonExecutionInterruptionDetails(error.code, error.details)
            ? { details: { phase: error.details.phase, createOutcome: error.details.createOutcome } } : {}) };
};

export const executeOzonAnalyticsJob = async ({
    authorization,
    reports,
    requestOzonReportPackage,
    createArtifactWriter,
    artifactJobId = authorization?.job?.jobId,
    now = Date.now,
}) => {
    try {
        validateAuthorizedJobLimits(authorization);
        if (authorization.jobType !== 'ozon_seller_analytics_report') throw new Error('Wrong Ozon analytics job type');
        const requested = parseAnalyticsReports(reports, authorization.issuedAt);
        const signed = parseAnalyticsReports(authorization.job?.reports, authorization.issuedAt);
        // Both parsers rebuild fields in canonical order; item order remains signed execution priority.
        if (JSON.stringify(requested) !== JSON.stringify(signed)) throw new Error('Signed Ozon analytics reports do not match');
        if (typeof requestOzonReportPackage !== 'function' || typeof createArtifactWriter !== 'function') {
            throw new Error('Ozon analytics execution dependencies are unavailable');
        }
    } catch (error) {
        throw authorizationRejected(error);
    }
    const startedAt = now();
    const signedDeadline =
        typeof authorization?.expiresAt === 'number' && Number.isFinite(authorization.expiresAt)
            ? Math.floor(authorization.expiresAt * 1000 - SIGNED_EXPIRY_SAFETY_RESERVE_MS)
            : Infinity;
    const packageDeadline = Math.min(startedAt + SELLER_AUTHORIZATION_SCOPE_MAX_MS, signedDeadline);
    return executeOzonReportPackage({
        family: 'analytics',
        jobType: 'ozon_seller_analytics_report',
        items: reports,
        artifactJobId,
        packageDeadline,
        requestOzonReportPackage,
        createArtifactWriter,
        artifactName: ({ dateFrom, dateTo, breakdown }) =>
            ozonAnalyticsArtifactName(dateFrom, dateTo, breakdown, authorization.issuedAt),
        normalizeError: safeOzonAnalyticsToolError,
        now,
    });
};
