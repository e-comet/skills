import { missingHandoff } from '../../../handoff/call-result.mjs';
import { invalidArgumentsMessage, validateArguments } from '../../../mcp-protocol/registry/validate.mjs';
import { textResult, toolFailure } from '../../../mcp-protocol/results/serialize.mjs';
import { ToolExecutionError } from '../../../shared/coded-error.mjs';
import { MIN_REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_GRACE_MS, REQUEST_TIMEOUT_MS } from '../../../shared/timeouts.mjs';
import { fieldOf, isOneOf, isRecord } from '../../../shared/values.mjs';
import { COMPARISON_FAILURE_CODE } from '../../../transport/extension/wire.mjs';
import { browserJobRejectionDetails } from '../../../transport/failures/rejection.mjs';
import { failureDetails, sellerCatalogFailureMessage } from '../../../transport/failures/vocabulary.mjs';
import { validateListOrgsGrant } from '../../application/list-orgs-job-limits.mjs';
import { contract, SELLER_LIST_ORGS_FAILURE_REASONS } from '../../contract/list-orgs.contract.mjs';
import { unconfirmedSellerRelease, withSellerJobLease } from './signed-seller-job.mjs';
export const projectListOrgsReceipt = (result, defaults) => {
    const value = fieldOf(result, 'structuredContent');
    if (!isRecord(value) || value.stage !== 'list_orgs' || value.ok !== false)
        return defaults;
    const code = fieldOf(value.releaseError, 'code');
    return {
        ...defaults,
        outcome: value.status === 'partial' ? 'partial' : 'failed',
        retryDisposition: 'forbidden',
        ...(defaults.code === undefined && typeof code === 'string' ? { code } : {}),
    };
};
export const createListOrgsTool = ({ answer, authorization, sellerOperations, withDownloadedUpdate, }) => ({
    needsBridge: true,
    run: async (id, args = {}) => {
        const validation = validateArguments(contract.inputSchema, args);
        if (!validation.ok) {
            const error = new ToolExecutionError('INVALID_TOOL_ARGUMENTS', invalidArgumentsMessage(contract.name, validation), 'arguments');
            return answer(id, textResult(toolFailure(error), true));
        }
        const triggerUrl = fieldOf(args, 'triggerUrl');
        if (typeof triggerUrl !== 'string' || !triggerUrl)
            return answer(id, textResult(toolFailure(missingHandoff()), true));
        const { result, failure, releaseError } = await withSellerJobLease(authorization, triggerUrl, 'seller_list_orgs', validateListOrgsGrant, async (_job, expiresAt, lease) => {
            const stage = 'list_orgs';
            try {
                const timeout = Math.min(REQUEST_TIMEOUT_MS, expiresAt * 1000 - Date.now() - REQUEST_TIMEOUT_GRACE_MS);
                if (timeout < MIN_REQUEST_TIMEOUT_MS) {
                    return { code: 'BROWSER_JOB_EXPIRED', stage };
                }
                return ((await sellerOperations.listOrgs(timeout, lease)) ?? {
                    code: COMPARISON_FAILURE_CODE,
                    stage,
                    reason: 'response_invalid',
                });
            }
            catch (error) {
                const code = error instanceof ToolExecutionError ? error.code : 'UNEXPECTED_LOCAL_ERROR';
                const details = failureDetails(error);
                return { code, stage, ...(details ? { details } : {}) };
            }
        }, (_authorized, cause) => unconfirmedSellerRelease('the read-only authorization', cause));
        if (result && 'organizations' in result) {
            const delivered = releaseError
                ? { ...result, ok: false, status: 'partial', releaseError }
                : { ...result, ok: true, status: 'complete' };
            return answer(id, textResult(delivered, !delivered.ok));
        }
        if (result) {
            const { stage, code, details } = result;
            const reason = isOneOf(SELLER_LIST_ORGS_FAILURE_REASONS, result.reason) ? result.reason : undefined;
            const message = sellerCatalogFailureMessage(code, details?.reason ?? reason);
            return answer(id, textResult({
                ok: false,
                status: 'failed',
                stage,
                code,
                message,
                retryable: false,
                ...(reason ? { reason } : {}),
                ...(details ? { details } : {}),
                ...(releaseError ? { releaseError } : {}),
            }, true));
        }
        const error = await withDownloadedUpdate(failure);
        const details = browserJobRejectionDetails(error) ?? failureDetails(error);
        return answer(id, textResult({ ...toolFailure(error), ...(details ? { details } : {}), ...(releaseError ? { releaseError } : {}) }, true));
    },
});
