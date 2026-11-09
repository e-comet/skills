import { parseAnalyticsReports } from '../domain/policies/analytics.policy.mjs';
import { parsePromotionPeriods } from '../domain/policies/package.policy.mjs';
import { parseOzonPromotionPeriod } from '../domain/policies/promotion.policy.mjs';
import { canonicalSearchPositionsRequest, sameSearchPositionsRequest } from '../domain/policies/search-positions.policy.mjs';
import { ToolExecutionError } from '../../shared/coded-error.mjs';
import { validTimeout } from '../../shared/timeouts.mjs';
import { hasExactOwnKeys, isRecord } from '../../shared/values.mjs';
import { MAX_BROWSER_JOB_TEXT_LENGTH } from '../../transport/mcp/limits.mjs';
// Parse boundary: the signed job, read field by field.
const validJobTimeout = (job) => job.timeout === undefined || validTimeout(job.timeout);
// Each broken limit names its closed rule (DESCRIPTOR_RULES in transport/failures); the message stays in the log only.
const brokenRule = (rule, message) => Object.assign(new Error(message), { rule });
// Signed items their parser refused; the parser's message names what it refused.
const brokenItems = (error) => brokenRule('ozon_items', error instanceof Error ? error.message : String(error));
// Parse boundary: whatever a check threw; only a broken rule carries its name.
const invalidDescriptor = (cause) => {
    const error = new ToolExecutionError('BROWSER_JOB_DESCRIPTOR_INVALID', 
    // The same job is signed the same way, so another authorization fails the same way.
    'The signed browser job descriptor is invalid; this is an e-Comet defect. Offer to report it; do not request another authorization for the same job.', 'authorization', false, { cause: cause instanceof Error ? cause : new Error(String(cause)) });
    if (isRecord(cause) && typeof cause.rule === 'string')
        error.details = { rule: cause.rule };
    return error;
};
const boundedText = (value) => typeof value === 'string' && value.length >= 1 && value.length <= MAX_BROWSER_JOB_TEXT_LENGTH;
// A buyer, filters or seller job is checked by its own context's rules, which `foreignJobs` brings: an Ozon job checks a
// foreign signed job by its own type's limits before it refuses that type, so the refusal stays the job-type mismatch.
// Without `foreignJobs` only the Ozon job types pass.
// Parse boundary: the signed grant, read field by field.
export const validateAuthorizedJobLimits = (authorization, foreignJobs = undefined) => {
    if (foreignJobs?.validate(authorization))
        return;
    try {
        const grant = isRecord(authorization) ? authorization : {};
        const { job } = grant;
        if (!isRecord(job) || !boundedText(job.jobId))
            throw brokenRule('descriptor', 'Browser job descriptor is invalid');
        if (!validJobTimeout(job))
            throw brokenRule('timeout', 'Browser job timeout is invalid');
        if (grant.jobType === 'ozon_seller_promotion_report') {
            if (!hasExactOwnKeys(job, ['jobId', 'type', 'dateFrom', 'dateTo']) || job.type !== 'ozon-seller-promotion-report') {
                throw brokenRule('ozon_descriptor', 'Invalid Ozon promotion descriptor');
            }
            try {
                parseOzonPromotionPeriod(job.dateFrom, job.dateTo);
            }
            catch (error) {
                throw brokenItems(error);
            }
            return;
        }
        if (grant.jobType === 'ozon_seller_promotion_reports') {
            if (!hasExactOwnKeys(job, ['jobId', 'type', 'periods']) || job.type !== 'ozon-seller-promotion-reports') {
                throw brokenRule('ozon_descriptor', 'Invalid Ozon promotion package descriptor');
            }
            try {
                parsePromotionPeriods(job.periods);
            }
            catch (error) {
                throw brokenItems(error);
            }
            return;
        }
        if (grant.jobType === 'ozon_seller_analytics_report') {
            if (!hasExactOwnKeys(job, ['jobId', 'type', 'reports']) || job.type !== 'ozon-seller-analytics-report') {
                throw brokenRule('ozon_descriptor', 'Invalid Ozon analytics descriptor');
            }
            try {
                parseAnalyticsReports(job.reports, grant.issuedAt);
            }
            catch (error) {
                throw brokenItems(error);
            }
            return;
        }
        if (grant.jobType === 'ozon_search_positions') {
            if (!hasExactOwnKeys(job, ['jobId', 'type', 'queries', 'skus', 'region', 'platform']) || job.type !== 'ozon-search-positions') {
                throw brokenRule('ozon_descriptor', 'Invalid Ozon search positions descriptor');
            }
            // The signer materializes defaults and trims, so a signed descriptor is already canonical. A signer trimming
            // other whitespace than ECMAScript fails closed here: accepted residual, see
            // docs/architecture/residuals/ozon.md.
            const { queries, skus, region, platform } = job;
            if (!sameSearchPositionsRequest(canonicalSearchPositionsRequest({ queries, skus, region, platform }), job)) {
                throw brokenRule('ozon_canonical', 'Ozon search positions descriptor is not canonical');
            }
            return;
        }
        throw brokenRule('job_type', `Unsupported browser_job type: ${grant.jobType}`);
    }
    catch (error) {
        if (error instanceof ToolExecutionError)
            throw error;
        throw invalidDescriptor(error);
    }
};
