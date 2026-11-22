import { ToolExecutionError } from '../../shared/coded-error.mjs';
import { hasExactOwnKeys, hasOnlyOwnKeys, hasOwnKeys, isBoundedText, isRecord } from '../../shared/values.mjs';
import { parseComparisonArticles, parseComparisonPeriod } from '../../transport/extension/wire.mjs';
import { MAX_BROWSER_JOB_TEXT_LENGTH } from '../../transport/mcp/limits.mjs';
const comparisonJobKeys = ['type', 'jobId', 'nmIds'];
const boundedText = (value) => isBoundedText(value, MAX_BROWSER_JOB_TEXT_LENGTH);
const parseOrgSelector = (value) => {
    if (!isRecord(value))
        return;
    if (hasExactOwnKeys(value, ['id']) && boundedText(value.id))
        return { id: value.id };
    if (hasExactOwnKeys(value, ['name']) && boundedText(value.name))
        return { name: value.name };
};
const parseDescriptor = (value) => {
    if (!isRecord(value) ||
        !hasOwnKeys(value, comparisonJobKeys) ||
        !hasOnlyOwnKeys(value, [...comparisonJobKeys, 'org', 'period', 'allowNewComparison', 'sizeDetails']))
        return;
    const { type, jobId } = value;
    if (type !== 'wb-seller-card-comparison' || !boundedText(jobId))
        return;
    const org = parseOrgSelector(value.org);
    const nmIds = parseComparisonArticles(value.nmIds);
    const period = Object.hasOwn(value, 'period') ? parseComparisonPeriod(value.period) : 'month';
    const sizeDetails = Object.hasOwn(value, 'sizeDetails') ? value.sizeDetails : false;
    const allowNewComparison = Object.hasOwn(value, 'allowNewComparison') ? value.allowNewComparison : undefined;
    if ((Object.hasOwn(value, 'org') && !org) ||
        !nmIds ||
        !period ||
        typeof sizeDetails !== 'boolean' ||
        (allowNewComparison !== undefined && typeof allowNewComparison !== 'boolean')) {
        return;
    }
    return { type, jobId, ...(org ? { org } : {}), nmIds, period, sizeDetails, allowNewComparison: allowNewComparison ?? false };
};
/** The comparison grant the extension attested on the lease. */
export const validateCardComparisonGrant = (authorization) => {
    if (isRecord(authorization) && hasOwnKeys(authorization, ['jobType', 'job']) && authorization.jobType === 'seller_card_comparison') {
        const job = parseDescriptor(authorization.job);
        if (job)
            return { jobType: authorization.jobType, job };
    }
    const error = new ToolExecutionError('BROWSER_JOB_DESCRIPTOR_INVALID', 'The signed browser job descriptor is invalid; this is an e-Comet defect. Offer to report it; do not request another authorization for the same job.', 'authorization');
    error.details = { rule: 'descriptor' };
    throw error;
};
