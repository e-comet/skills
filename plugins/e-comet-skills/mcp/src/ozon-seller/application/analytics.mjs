import { validateAuthorizedJobLimits } from './job-limits.mjs';
import { executeOzonReportPackage } from './package.mjs';
import { ozonDescriptorRejected } from '../domain/converters/errors.converter.mjs';
import { ozonPackageDeadline } from '../domain/converters/package-result.converter.mjs';
import { ozonAnalyticsArtifactName, parseAnalyticsReports } from '../domain/policies/analytics.policy.mjs';
import { ToolExecutionError } from '../../shared/coded-error.mjs';
import { StorageUnavailableError } from '../../shared/storage-unavailable.mjs';
import { isRecord } from '../../shared/values.mjs';
import { OZON_ANALYTICS_TERMINAL_CODE_STAGES, isOzonAnalyticsTerminalDetails, isOzonExecutionInterruptionDetails, } from '../../transport/extension/wire.mjs';
import { browserJobRejectionDetails } from '../../transport/failures/rejection.mjs';
import { artifactRejectedDetails, bridgeCodeDetails, descriptorRuleDetails } from '../../transport/failures/vocabulary.mjs';
const authorizationRejected = (cause) => new ToolExecutionError('OZON_AUTHORIZATION_REJECTED', 'The signed Ozon analytics authorization does not match this request.', 'authorization', false, { cause });
// Parse boundary: a failure this process built or the extension sent, read field by field.
export const safeOzonAnalyticsToolError = (error) => {
    if (error instanceof StorageUnavailableError) {
        return { code: error.code, message: error.message, stage: error.stage, retryable: false };
    }
    const { code, message, details, stage: errorStage, retryable } = isRecord(error) ? error : {};
    const stage = typeof code === 'string' ? OZON_ANALYTICS_TERMINAL_CODE_STAGES[code] : undefined;
    if (
    // Local ToolExecutionError always owns an initially undefined details field.
    // Absence of evidence must not erase an otherwise known local failure.
    (details !== undefined &&
        !isOzonAnalyticsTerminalDetails(code, details) &&
        !isOzonExecutionInterruptionDetails(code, details) &&
        !browserJobRejectionDetails(error) &&
        !bridgeCodeDetails(error) &&
        !artifactRejectedDetails(error) &&
        !descriptorRuleDetails(error)) ||
        typeof code !== 'string' ||
        stage === undefined ||
        errorStage !== stage ||
        retryable !== false ||
        typeof message !== 'string' ||
        message.length < 1 ||
        message.length > 500) {
        throw new TypeError('Invalid Ozon analytics terminal error.');
    }
    return {
        code,
        message,
        stage,
        retryable: false,
        ...(isRecord(details) && isOzonAnalyticsTerminalDetails(code, details)
            ? { details: { marketplaceErrorCode: details.marketplaceErrorCode } }
            : {}),
        ...(isRecord(details) && isOzonExecutionInterruptionDetails(code, details)
            ? { details: { phase: details.phase, createOutcome: details.createOutcome } }
            : {}),
        ...(browserJobRejectionDetails(error) ? { details: browserJobRejectionDetails(error) } : {}),
        ...(bridgeCodeDetails(error) ? { details: bridgeCodeDetails(error) } : {}),
        ...(artifactRejectedDetails(error) ? { details: artifactRejectedDetails(error) } : {}),
        ...(descriptorRuleDetails(error) ? { details: descriptorRuleDetails(error) } : {}),
    };
};
export const executeOzonAnalyticsJob = async ({ authorization, reports, requestOzonReportPackage, createArtifactWriter, jobBudget = { bytes: 0 }, now = Date.now, foreignJobs = undefined, }) => {
    const grant = isRecord(authorization) ? authorization : {};
    try {
        validateAuthorizedJobLimits(authorization, foreignJobs);
        if (grant.jobType !== 'ozon_seller_analytics_report')
            throw new Error('Wrong Ozon analytics job type');
        const requested = parseAnalyticsReports(reports, grant.issuedAt);
        const signed = parseAnalyticsReports(isRecord(grant.job) ? grant.job.reports : undefined, grant.issuedAt);
        // Both parsers rebuild fields in canonical order; item order remains signed execution priority.
        if (JSON.stringify(requested) !== JSON.stringify(signed))
            throw new Error('Signed Ozon analytics reports do not match');
    }
    catch (error) {
        throw ozonDescriptorRejected(error) ?? authorizationRejected(error);
    }
    return executeOzonReportPackage({
        family: 'analytics',
        jobType: 'ozon_seller_analytics_report',
        // Parsed above: every report is an exact item object.
        items: Array.isArray(reports) ? reports.filter(isRecord) : [],
        packageDeadline: ozonPackageDeadline(authorization, now()),
        requestOzonReportPackage,
        createArtifactWriter,
        jobBudget,
        artifactName: ({ dateFrom, dateTo, breakdown }) => ozonAnalyticsArtifactName(dateFrom, dateTo, breakdown, grant.issuedAt),
        normalizeError: safeOzonAnalyticsToolError,
    });
};
