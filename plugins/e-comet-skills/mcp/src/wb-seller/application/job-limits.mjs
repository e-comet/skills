import { ToolExecutionError } from '../../shared/coded-error.mjs';
import { validTimeout } from '../../shared/timeouts.mjs';
import { fieldOf, hasOnlyOwnKeys, isBoundedText, isPositiveSafeInteger, isRecord, isUnknownArray } from '../../shared/values.mjs';
import { MAX_BROWSER_JOB_TEXT_LENGTH } from '../../transport/mcp/limits.mjs';
import { MAX_SELLER_REVIEW_EXPORTS, MAX_SELLER_REVIEW_PHYSICAL_REPORTS } from '../domain/constants/limits.const.mjs';
// Parse boundary: a signed descriptor as the extension attested it; the checks below read it field by field.
const validJobTimeout = (timeout) => timeout === undefined || validTimeout(timeout);
// Each broken limit names its closed rule (DESCRIPTOR_RULES in transport/failures); the message stays in the log only.
const brokenRule = (rule, message) => Object.assign(new Error(message), { rule });
const invalidDescriptor = (cause) => {
    const error = new ToolExecutionError('BROWSER_JOB_DESCRIPTOR_INVALID', 
    // The same job is signed the same way, so another authorization fails the same way.
    'The signed browser job descriptor is invalid; this is an e-Comet defect. Offer to report it; do not request another authorization for the same job.', 'authorization', false, { cause: cause instanceof Error ? cause : new Error(String(cause)) });
    const rule = fieldOf(cause, 'rule');
    if (typeof rule === 'string')
        error.details = { rule };
    return error;
};
const boundedText = (value) => isBoundedText(value, MAX_BROWSER_JOB_TEXT_LENGTH);
const validIsoDate = (value) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
        return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const validSellerOrg = (org) => {
    if (org === undefined)
        return true;
    if (!isRecord(org))
        return false;
    const keys = Object.keys(org);
    const [key] = keys;
    return keys.length === 1 && (key === 'id' || key === 'name') && boundedText(org[key]);
};
const validSellerRatings = (ratings) => ratings === undefined ||
    (isUnknownArray(ratings) &&
        ratings.length >= 1 &&
        ratings.length <= 5 &&
        ratings.every((rating) => isPositiveSafeInteger(rating) && rating <= 5) &&
        new Set(ratings).size === ratings.length);
const validSellerExport = (item) => isRecord(item) &&
    hasOnlyOwnKeys(item, ['product_id', 'dateFrom', 'dateTo', 'isAnswered', 'ratings', 'content']) &&
    (item.product_id === undefined || isPositiveSafeInteger(item.product_id)) &&
    (item.isAnswered === undefined || typeof item.isAnswered === 'boolean') &&
    validSellerRatings(item.ratings) &&
    (item.content === undefined || item.content === 'media') &&
    ((item.dateFrom === undefined && item.dateTo === undefined) ||
        (validIsoDate(item.dateFrom) && validIsoDate(item.dateTo) && item.dateFrom <= item.dateTo));
const sellerExportIdentity = (sellerExport) => JSON.stringify({
    product_id: sellerExport.product_id ?? null,
    dateFrom: sellerExport.dateFrom ?? null,
    dateTo: sellerExport.dateTo ?? null,
    isAnswered: sellerExport.isAnswered ?? null,
    ratings: sellerExport.ratings === undefined ? null : [...sellerExport.ratings].sort((left, right) => left - right),
    content: sellerExport.content ?? null,
});
// The limits of a signed seller_reviews descriptor, answered as the checked grant; any other job type is not this context's.
// Parse boundary: the grant as the extension sent it.
export const validateAuthorizedJobLimits = (authorization) => {
    try {
        const job = fieldOf(authorization, 'job');
        const jobId = fieldOf(job, 'jobId');
        if (!isRecord(job) || !boundedText(jobId))
            throw brokenRule('descriptor', 'Browser job descriptor is invalid');
        const { timeout, org, exports } = job;
        if (!validJobTimeout(timeout))
            throw brokenRule('timeout', 'Browser job timeout is invalid');
        const jobType = fieldOf(authorization, 'jobType');
        if (jobType === 'seller_reviews') {
            if (!(job.type === 'wb-seller-reviews' &&
                validSellerOrg(org) &&
                isUnknownArray(exports) &&
                exports.length >= 1 &&
                exports.length <= MAX_SELLER_REVIEW_EXPORTS &&
                exports.every(validSellerExport) &&
                new Set(exports.map(sellerExportIdentity)).size === exports.length &&
                exports.reduce((total, item) => total + (item.isAnswered === undefined ? 2 : 1), 0) <= MAX_SELLER_REVIEW_PHYSICAL_REPORTS)) {
                throw brokenRule('seller_exports', `Browser seller-review job requires at most ${MAX_SELLER_REVIEW_EXPORTS} exports and ${MAX_SELLER_REVIEW_PHYSICAL_REPORTS} physical reports`);
            }
            return { jobType, job: { jobId, timeout, org, exports } };
        }
        throw brokenRule('job_type', `Unsupported browser_job type: ${jobType}`);
    }
    catch (error) {
        if (error instanceof ToolExecutionError)
            throw error;
        throw invalidDescriptor(error);
    }
};
