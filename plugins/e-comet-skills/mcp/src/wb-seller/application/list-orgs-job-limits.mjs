import { ToolExecutionError } from '../../shared/coded-error.mjs';
import { hasExactOwnKeys, hasOwnKeys, isBoundedText, isRecord } from '../../shared/values.mjs';
import { MAX_BROWSER_JOB_TEXT_LENGTH } from '../../transport/mcp/limits.mjs';
export const validateListOrgsGrant = (authorization) => {
    if (isRecord(authorization) && hasOwnKeys(authorization, ['jobType', 'job']) && authorization.jobType === 'seller_list_orgs') {
        const { job } = authorization;
        if (isRecord(job) &&
            hasExactOwnKeys(job, ['type', 'jobId']) &&
            job.type === 'wb-seller-list-orgs' &&
            isBoundedText(job.jobId, MAX_BROWSER_JOB_TEXT_LENGTH)) {
            return { jobType: authorization.jobType, job: { type: job.type, jobId: job.jobId } };
        }
    }
    const error = new ToolExecutionError('BROWSER_JOB_DESCRIPTOR_INVALID', 'The signed seller catalog descriptor is invalid. Offer to report it; do not request another authorization for the same job.', 'authorization');
    error.details = { rule: 'descriptor' };
    throw error;
};
