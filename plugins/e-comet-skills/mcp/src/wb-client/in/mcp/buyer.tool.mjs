import { missingHandoff } from '../../../handoff/call-result.mjs';
import { invalidArgumentsMessage, validateArguments } from '../../../mcp-protocol/registry/validate.mjs';
import { textResult, toolFailure } from '../../../mcp-protocol/results/serialize.mjs';
import { ToolExecutionError } from '../../../shared/coded-error.mjs';
import { fieldOf, isRecord, isUnknownArray } from '../../../shared/values.mjs';
import { EXTENSION_UPDATE_URL } from '../../../transport/extension/wire.mjs';
import { browserJobRejectionDetails } from '../../../transport/failures/rejection.mjs';
import { failureDetails } from '../../../transport/failures/vocabulary.mjs';
import { validateAuthorizedJobLimits } from '../../application/job-limits.mjs';
import { executeAuthorizedBrowserJob } from '../../application/run-buyer-job.mjs';
import { contract as check } from '../../contract/check.contract.mjs';
import { contract as filters } from '../../contract/filters.contract.mjs';
import { contract as productCard } from '../../contract/product-card.contract.mjs';
import { contract as recommendations } from '../../contract/recommendations.contract.mjs';
import { contract as search } from '../../contract/search.contract.mjs';
import { DEFAULT_RETURNED_PRODUCTS } from '../../domain/constants/limits.const.mjs';
// The five signed buyer tools: each runs one signed job type; search and recommendations cap their projection by their
// own argument.
export const BUYER_TOOLS = [
    { contract: productCard, jobType: 'product_card' },
    { contract: search, jobType: 'search_by_query', productLimit: 'productLimitPerQuery' },
    { contract: check, jobType: 'check_by_query' },
    { contract: filters, jobType: 'filters_by_query' },
    { contract: recommendations, jobType: 'recommendations_by_product', productLimit: 'productLimitPerSource' },
];
// The authorization lease is built by this process; a wrong shape is an e-Comet defect, not the seller's.
const leaseInvalid = () => new ToolExecutionError('BROWSER_JOB_LEASE_INVALID', 'The local MCP received an invalid browser job authorization lease; this is an e-Comet defect. Offer to report it; do not repeat browser_job.', 'local', false);
// The e-Comet signer issues filters_by_query, so an extension refusing that job type (invalid_job/job_type) predates it. Without
// this an outdated extension reads as our defect. Older WB jobs are known to every supported extension. The refusal details are
// not passed on: DIAGNOSTICS.md reads invalid_job as our defect, which would contradict the update advice.
const outdatedExtensionForJobType = (toolName, error) => {
    const rejection = browserJobRejectionDetails(error)?.browserJobRejection;
    if (toolName !== 'wb_filters_by_query' || rejection?.reason !== 'invalid_job' || rejection.diagnostic !== 'job_type')
        return error;
    return new ToolExecutionError('EXTENSION_UPDATE_REQUIRED', `The connected e-Comet extension does not support ${toolName}. Update the e-Comet extension at ${EXTENSION_UPDATE_URL}, then request a new authorization and retry.`, 'extension', false, { cause: error });
};
// Scope revocation occurs before the release route's acknowledgement can suspend, so the tool can safely deliver a
// terminal result without letting an extension round trip delay it.
const releaseAuthorizationInBackground = (lease, context) => {
    if (!lease)
        return;
    // Parse boundary: whatever the release threw.
    const reportFailure = (releaseError) => {
        let message;
        try {
            const text = fieldOf(releaseError, 'message');
            message = typeof text === 'string' ? text : String(releaseError);
        }
        catch {
            message = 'unknown release failure';
        }
        console.error(`[McpDispatcher] Failed to release browser-job authorization ${context}:`, message);
    };
    try {
        Promise.resolve(lease.release()).catch(reportFailure);
    }
    catch (releaseError) {
        reportFailure(releaseError);
    }
};
const isNumberList = (value) => isUnknownArray(value) && value.every((item) => typeof item === 'number');
/**
 * One signed buyer tool: authorize the trigger URL, refuse a foreign job type and a broken descriptor before a result file
 * exists, run the job through the WB fetch bound to its lease, and answer the result with its file.
 */
export const createBuyerTool = ({ contract, jobType: expectedJobType, productLimit = undefined }, { answer, authorization, wbFetch, results, withDownloadedUpdate, log }) => {
    const toolName = contract.name;
    // The one closed `details` a WB tool failure carries.
    const errorDetails = (error) => {
        const details = results.creationEvidence(error) ?? browserJobRejectionDetails(error) ?? failureDetails(error);
        return details ? { details } : {};
    };
    return {
        needsBridge: true,
        // Parse boundary: the call's arguments, checked against the contract first; the contract's types narrow them.
        run: async (id, args = {}) => {
            const triggerUrl = fieldOf(args, 'triggerUrl');
            const productLimitPerScope = (productLimit ? fieldOf(args, productLimit) : undefined) ?? DEFAULT_RETURNED_PRODUCTS;
            const productNmIds = fieldOf(args, 'productNmIds');
            const validation = validateArguments(contract.inputSchema, args);
            if (!validation.ok || typeof productLimitPerScope !== 'number' || !(productNmIds === undefined || isNumberList(productNmIds))) {
                await answer(id, textResult(toolFailure(new ToolExecutionError('INVALID_TOOL_ARGUMENTS', invalidArgumentsMessage(toolName, validation), 'arguments', false)), true));
                return;
            }
            if (typeof triggerUrl !== 'string' || !triggerUrl) {
                await answer(id, textResult(toolFailure(missingHandoff()), true));
                return;
            }
            let writer;
            let authorizationLease;
            const releaseAuthorization = (context) => {
                if (!authorizationLease)
                    return;
                const currentLease = authorizationLease;
                authorizationLease = undefined;
                releaseAuthorizationInBackground(currentLease, context);
            };
            try {
                authorizationLease = await authorization.authorize(triggerUrl);
                const grant = authorizationLease?.authorization;
                if (!authorizationLease ||
                    // A lease bound to no scope cannot fetch: that is our defect, not a marketplace failure.
                    typeof authorizationLease.id !== 'string' ||
                    typeof authorizationLease.scopeId !== 'string' ||
                    !isRecord(grant) ||
                    typeof grant.authorizationId !== 'string' ||
                    typeof grant.jobType !== 'string' ||
                    !grant.job ||
                    typeof grant.job !== 'object') {
                    throw leaseInvalid();
                }
                if (grant.jobType !== expectedJobType) {
                    throw new ToolExecutionError('BROWSER_JOB_TYPE_MISMATCH', `Signed ${grant.jobType} job cannot be executed as ${toolName}.`, 'authorization', false);
                }
                // Fail descriptor validation before creating an empty result file; the executor repeats this for direct callers.
                const { job } = validateAuthorizedJobLimits(grant);
                writer = await results.create(job.jobId);
                const lease = authorizationLease;
                const result = await executeAuthorizedBrowserJob({
                    authorization: grant,
                    requestWbFetch: (url, timeoutMs) => wbFetch.fetch(url, { timeoutMs, lease }),
                    writer,
                    productLimitPerScope,
                    productNmIds,
                });
                releaseAuthorization('after job completion');
                const writeErrors = await writer.close();
                await answer(id, textResult({
                    ...result,
                    ...(writer.published !== false ? { resultPath: writer.resultPath } : {}),
                    ...(writeErrors.length > 0 ? { storageWarnings: writeErrors.map((error) => error.message) } : {}),
                }, !result.ok));
            }
            catch (caught) {
                releaseAuthorization('after job failure');
                const error = await withDownloadedUpdate(outdatedExtensionForJobType(toolName, caught));
                let partialResult = {};
                if (writer) {
                    const writeErrors = await writer.close().catch(() => []);
                    partialResult = {
                        ...(writer.published !== false && writer.persistedBytes > 0 ? { resultPath: writer.resultPath } : {}),
                        ...(writeErrors.length > 0 ? { storageWarnings: writeErrors.map((writeError) => writeError.message) } : {}),
                    };
                }
                if (error instanceof ToolExecutionError &&
                    error.code === 'BROWSER_JOB_DESCRIPTOR_INVALID' &&
                    error.cause instanceof Error) {
                    log('rejected signed browser job descriptor:', error.cause.message);
                }
                await answer(id, textResult({
                    ...toolFailure(error, {
                        code: 'BROWSER_JOB_EXECUTION_FAILED',
                        message: 'The authorized Wildberries job could not be completed.',
                        stage: 'execution',
                        retryable: false,
                    }),
                    // Public-only evidence: shared toolFailure is a strict serializer and
                    // must not gain these extra keys.
                    ...errorDetails(error),
                    ...partialResult,
                }, true));
            }
            finally {
                try {
                    await writer?.release?.();
                }
                catch {
                    log('result ownership cleanup failed after browser job response; result remains protected');
                }
            }
        },
    };
};
